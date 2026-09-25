import { PorterError, stableHash, type Clock } from "@porter/shared";
import { decryptWithKey, encryptWithKey } from "./crypto.js";
import type { IdempotencyOperation, IdempotencyStore, KeyStore } from "./ports.js";

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60_000; // 30 days

export interface IdempotencyOptions {
  readonly ttlMs?: number;
}

export interface WriteAttempt {
  /** Must succeed durably before sending the first external write. */
  beforeWrite(operation: IdempotencyOperation): Promise<void>;
  /** Store a definitive failure returned by the provider, without resending it on replay. */
  finishWithError(error: PorterError): Promise<never>;
}

type StoredOutcome<T> =
  | { readonly version: 1; readonly kind: "result"; readonly value: T }
  | { readonly version: 1; readonly kind: "error"; readonly error: ReturnType<PorterError["toPublic"]> };

/**
 * Idempotency for every write call.
 *
 *   same key, same payload  -> replay the stored response, call nothing
 *   same key, different payload -> hard error, because the caller has reused a
 *                                  key for a different action
 *   key already in flight   -> tell the agent to retry shortly
 *   write possibly sent     -> require reconciliation, never send it again
 *
 * The payload itself is never stored; only its hash. The response is stored
 * encrypted under a per-user key (see crypto.ts), so a deletion request
 * renders it inaccessible without having to rewrite history.
 */
export class Idempotency {
  readonly #store: IdempotencyStore;
  readonly #keys: KeyStore;
  readonly #clock: Clock;
  readonly #ttlMs: number;

  constructor(store: IdempotencyStore, keys: KeyStore, clock: Clock, options: IdempotencyOptions = {}) {
    this.#store = store;
    this.#keys = keys;
    this.#clock = clock;
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  }

  /**
   * Run `fn` at most once for a given (user, tool, key).
   *
   * A durable marker precedes external writes. Expiry is retention metadata,
   * never permission to repeat a mutation whose outcome is unknown.
   */
  async run<T>(
    userId: string,
    tool: string,
    key: string | undefined,
    args: unknown,
    fn: (attempt: WriteAttempt) => Promise<T>,
    /** Release dependent guards only while this reservation still owns its identity. */
    onSafeRelease?: () => Promise<void>,
  ): Promise<T> {
    if (key === undefined || key.trim().length === 0) {
      throw new PorterError("INVALID_REQUEST", "A request id is required before making a change.");
    }

    const argsHash = stableHash(args);
    const now = this.#clock.now();
    const releaseGuard = async (): Promise<void> => {
      try {
        await onSafeRelease?.();
      } catch (error) {
        // Lost cleanup acknowledgment must not permit a new reservation to
        // reuse the same identity before an old cleanup can delete its guard.
        throw uncertainOutcome(tool, error);
      }
    };

    const existing = await this.#store.reserve({
      userId,
      tool,
      key,
      argsHash,
      state: "in_flight",
      createdAt: now,
      expiresAt: new Date(now.getTime() + this.#ttlMs),
    });

    if (existing) {
      if (existing.argsHash !== argsHash) {
        throw new PorterError(
          "IDEMPOTENCY_CONFLICT",
          "That request id was already used for a different request. Use a new one.",
          { details: { tool } },
        );
      }
      if (existing.state === "in_flight") {
        if (existing.expiresAt.getTime() <= this.#clock.nowMs()) throw uncertainOutcome(tool);
        throw new PorterError(
          "IDEMPOTENCY_IN_FLIGHT",
          "That request is still being processed. Try again in a few seconds.",
          { retryAfterSeconds: 3, details: { tool } },
        );
      }
      if (existing.state === "uncertain") throw uncertainOutcome(tool);
      if (existing.responseCipher) {
        const dek = await this.#keys.getOrCreate(userId);
        const outcome = JSON.parse(decryptWithKey(dek, existing.responseCipher)) as StoredOutcome<T>;
        if (outcome.version !== 1) throw uncertainOutcome(tool);
        if (outcome.kind !== "result" && outcome.kind !== "error") throw uncertainOutcome(tool);
        // A crash after completing the result may leave its guard behind.
        await releaseGuard();
        if (outcome.kind === "error") {
          throw new PorterError(outcome.error.code, outcome.error.message, outcome.error);
        }
        return outcome.value;
      }
      // Missing durable result data is corruption, never permission to write again.
      throw uncertainOutcome(tool);
    }

    let writeAttempted = false;
    let finalizedError: PorterError | undefined;
    const complete = async (outcome: StoredOutcome<T>): Promise<void> => {
      const dek = await this.#keys.getOrCreate(userId);
      await this.#store.complete(userId, tool, key, encryptWithKey(dek, JSON.stringify(outcome)));
    };
    try {
      const result = await fn({
        beforeWrite: async (operation) => {
          // Set this before awaiting: a lost DB acknowledgment can mean that
          // the marker was committed. A failed marker must fail closed.
          writeAttempted = true;
          await this.#store.markUncertain(userId, tool, key, operation);
        },
        finishWithError: async (error) => {
          await complete({ version: 1, kind: "error", error: error.toPublic() });
          finalizedError = error;
          throw error;
        },
      });
      await complete({ version: 1, kind: "result", value: result });
      await releaseGuard();
      return result;
    } catch (error) {
      if (finalizedError && error === finalizedError) {
        await releaseGuard();
        throw error;
      }
      // Only validation/read failures are safe to retry automatically. A
      // timeout or local storage failure after a write may hide a success.
      // Generic adapter error codes do not prove that nothing was applied:
      // adapters may have already made several downstream calls. Only a
      // verified terminal response may opt into finishWithError above.
      if (writeAttempted) throw uncertainOutcome(tool, error);
      // Release while this reservation still blocks another use of its key.
      await releaseGuard();
      await this.#store.release(userId, tool, key);
      throw error;
    }
  }
}

function uncertainOutcome(tool: string, cause?: unknown): PorterError {
  const awaitingAuthentication = PorterError.is(cause) && cause.code === "PAYMENT_REQUIRED" && cause.details.reason === "authentication_required";
  return new PorterError(
    "IDEMPOTENCY_UNCERTAIN",
    awaitingAuthentication
      ? "The bank needs the cardholder to approve this payment. Do not submit another payment. Check its status after approval."
      : "The result of this request needs to be checked. Do not submit it with a new request id. Check your bookings or contact support before trying again.",
    {
      details: {
        tool,
        ...(awaitingAuthentication ? { reason: "authentication_required", ...(typeof cause.details.approval_url === "string" ? { approval_url: cause.details.approval_url } : {}) } : {}),
      },
      ...(cause === undefined ? {} : { cause }),
    },
  );
}
