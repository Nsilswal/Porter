import { PorterError, stableHash, type Clock, type Logger } from "@porter/shared";
import type { AuditRecord, AuditStore } from "./ports.js";
import type { CustomerField } from "./customer.js";

/**
 * The audit log.
 *
 * It contains no personal data. That is not a style preference — it is how
 * Porter satisfies two Connector Terms clauses that otherwise conflict:
 *
 *   4.3(f) delete User Data when the user revokes or asks
 *   4.3(g) keep records sufficient to demonstrate compliance, and hand them
 *          to Meta on request
 *
 * A log of pseudonymous ids, argument hashes and outcomes survives a deletion
 * request intact, so both duties are met at once.
 *
 * `assertNoPersonalData` runs on every append. It is a guard against a future
 * change quietly widening what gets recorded.
 */

const FORBIDDEN_VALUE = /@|^\+?\d[\d\s().-]{7,}$/;

export class AuditLog {
  readonly #store: AuditStore;
  readonly #clock: Clock;
  readonly #log: Logger;

  constructor(store: AuditStore, clock: Clock, log: Logger) {
    this.#store = store;
    this.#clock = clock;
    this.#log = log;
  }

  async record(input: {
    actorId: string;
    tool: string;
    action: string;
    adapterId?: string | null;
    providerId?: string | null;
    args: unknown;
    idempotencyKey?: string | null;
    confirmationJti?: string | null;
    outcome: "ok" | "error";
    errorCode?: string | null;
    startedAtMs: number;
    disclosedFields?: readonly CustomerField[];
  }): Promise<void> {
    const record: AuditRecord = {
      at: this.#clock.now(),
      actorId: input.actorId,
      tool: input.tool,
      action: input.action,
      adapterId: input.adapterId ?? null,
      providerId: input.providerId ?? null,
      argsHash: stableHash(input.args),
      idempotencyKey: input.idempotencyKey ?? null,
      confirmationJti: input.confirmationJti ?? null,
      outcome: input.outcome,
      errorCode: input.errorCode ?? null,
      latencyMs: Math.max(0, this.#clock.nowMs() - input.startedAtMs),
      disclosedFields: input.disclosedFields ?? [],
    };

    assertNoPersonalData(record);

    try {
      await this.#store.append(record);
    } catch (cause) {
      // An audit write must never take down a user-visible operation, but a
      // silent failure would be worse. Log loudly and continue.
      // Database errors can embed SQL parameters containing private records.
      this.#log.error("audit_append_failed", { tool: input.tool, outcome: input.outcome, code: PorterError.is(cause) ? cause.code : "unknown" });
    }
  }

  list(actorId: string, limit = 100): Promise<AuditRecord[]> {
    return this.#store.list(actorId, limit);
  }
}

/**
 * Reject any audit row carrying something that looks like personal data.
 *
 * Checks the free-form string fields only. `actorId` is a pseudonymous id,
 * `argsHash` is a digest, and `disclosedFields` holds field names, so none of
 * them should ever contain an email address or phone number.
 */
export function assertNoPersonalData(record: AuditRecord): void {
  const suspects: [string, string | null][] = [
    ["actorId", record.actorId],
    ["adapterId", record.adapterId],
    ["providerId", record.providerId],
    ["idempotencyKey", record.idempotencyKey],
    ["confirmationJti", record.confirmationJti],
    ["errorCode", record.errorCode],
  ];
  for (const [field, value] of suspects) {
    if (value && FORBIDDEN_VALUE.test(value)) {
      throw new Error(`Audit record field "${field}" looks like personal data and cannot be stored.`);
    }
  }
  if (!/^[a-f0-9]{64}$/.test(record.argsHash)) {
    throw new Error("Audit record argsHash must be a sha256 digest, not a payload.");
  }
}
