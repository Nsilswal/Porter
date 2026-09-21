/**
 * Porter's closed error taxonomy.
 *
 * Every failure the agent can see is one of these codes. Adapters map provider
 * errors into the set; anything unmapped becomes ADAPTER_DOWN and is logged.
 * Raw provider error text never reaches the agent, because provider text is
 * untrusted input (see ./untrusted.ts).
 */
export const ERROR_CODES = [
  "SLOT_TAKEN",
  "PROVIDER_UNAVAILABLE",
  "QUOTE_REQUIRED",
  "OUT_OF_SERVICE_AREA",
  "PAYMENT_REQUIRED",
  "POLICY_BLOCKED",
  "RATE_LIMITED",
  "ADAPTER_DOWN",
  "NOT_FOUND",
  "INVALID_REQUEST",
  "CONFIRMATION_REQUIRED",
  "CONFIRMATION_EXPIRED",
  "CONFIRMATION_STALE",
  "IDEMPOTENCY_CONFLICT",
  "IDEMPOTENCY_IN_FLIGHT",
  "UNSUPPORTED_CAPABILITY",
  "UNAUTHENTICATED",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface PorterErrorOptions {
  /** Structured, non-sensitive detail the agent may relay to the user. */
  readonly details?: Record<string, unknown>;
  /** Seconds to wait before retrying. Only meaningful for RATE_LIMITED. */
  readonly retryAfterSeconds?: number;
  /** Underlying cause. Logged, never serialised to the agent. */
  readonly cause?: unknown;
}

/**
 * The only error type that crosses the tool boundary.
 *
 * `message` is written to be read aloud by an agent to a person, so it stays
 * plain and short. `cause` is kept for logs and is never serialised.
 */
export class PorterError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown>;
  readonly retryAfterSeconds?: number;

  constructor(code: ErrorCode, message: string, options: PorterErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "PorterError";
    this.code = code;
    this.details = options.details ?? {};
    if (options.retryAfterSeconds !== undefined) {
      this.retryAfterSeconds = options.retryAfterSeconds;
    }
  }

  /** Agent-facing shape. Contains no credentials, no raw provider text. */
  toPublic(): { code: ErrorCode; message: string; details: Record<string, unknown>; retryAfterSeconds?: number } {
    const out: { code: ErrorCode; message: string; details: Record<string, unknown>; retryAfterSeconds?: number } = {
      code: this.code,
      message: this.message,
      details: this.details,
    };
    if (this.retryAfterSeconds !== undefined) out.retryAfterSeconds = this.retryAfterSeconds;
    return out;
  }

  static is(value: unknown): value is PorterError {
    return value instanceof PorterError;
  }
}

/** Wrap an unknown throwable as ADAPTER_DOWN without leaking its text. */
export function asAdapterDown(adapterId: string, cause: unknown): PorterError {
  return new PorterError(
    "ADAPTER_DOWN",
    "That booking system is not responding right now. Try again in a moment.",
    { details: { adapter: adapterId }, cause },
  );
}
