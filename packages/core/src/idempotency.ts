import { PorterError, stableHash, type Clock } from "@porter/shared";
import { decryptWithKey, encryptWithKey } from "./crypto.js";
import type { IdempotencyStore, KeyStore } from "./ports.js";

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60_000; // 30 days

export interface IdempotencyOptions {
  readonly ttlMs?: number;
}

/**
 * Idempotency for every write call.
 *
 * Three cases, and the middle one is the one that catches real bugs:
 *
 *   same key, same payload  -> replay the stored response, call nothing
 *   same key, different payload -> hard error, because the caller has reused a
 *                                  key for a different action
 *   key already in flight   -> tell the agent to retry shortly
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
   * `key` may be undefined for read-only tools, in which case `fn` runs
   * directly with no bookkeeping.
   */
  async run<T>(
    userId: string,
    tool: string,
    key: string | undefined,
    args: unknown,
    fn: () => Promise<T>,
  ): Promise<T> {
    if (key === undefined || key.trim().length === 0) return fn();

    const argsHash = stableHash(args);
    const now = this.#clock.now();

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
        throw new PorterError(
          "IDEMPOTENCY_IN_FLIGHT",
          "That request is still being processed. Try again in a few seconds.",
          { retryAfterSeconds: 3, details: { tool } },
        );
      }
      if (existing.responseCipher) {
        const dek = await this.#keys.getOrCreate(userId);
        return JSON.parse(decryptWithKey(dek, existing.responseCipher)) as T;
      }
      // Completed with no stored body should not happen; fall through and rerun.
    }

    try {
      const result = await fn();
      const dek = await this.#keys.getOrCreate(userId);
      await this.#store.complete(userId, tool, key, encryptWithKey(dek, JSON.stringify(result)));
      return result;
    } catch (error) {
      // A failed call must not burn the key. The agent should be able to retry
      // the same request with the same key after a transient failure.
      await this.#store.release(userId, tool, key);
      throw error;
    }
  }
}
