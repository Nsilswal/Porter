import { PorterError, type Clock } from "@porter/shared";

export interface RateLimitRule {
  readonly capacity: number;
  readonly refillPerSecond: number;
}

export interface RateLimiterOptions {
  /** Protects the user, and Porter, from a runaway agent. */
  readonly perUser: RateLimitRule;
  /**
   * Protects Porter's standing with each provider platform. Exceeding a
   * platform quota risks API access for every Porter user, not just one.
   */
  readonly perAdapter: Record<string, RateLimitRule>;
  readonly defaultAdapter: RateLimitRule;
}

interface Bucket {
  tokens: number;
  lastMs: number;
}

/**
 * Two independent token buckets: per user and per adapter. Both must have a
 * token for a call to proceed.
 *
 * In-process for now. The Redis-backed version swaps in behind the same
 * interface when Porter runs more than one instance on Railway.
 */
export class RateLimiter {
  readonly #clock: Clock;
  readonly #options: RateLimiterOptions;
  readonly #users = new Map<string, Bucket>();
  readonly #adapters = new Map<string, Bucket>();

  constructor(clock: Clock, options: RateLimiterOptions) {
    this.#clock = clock;
    this.#options = options;
  }

  /** Throws RATE_LIMITED with a retryAfter the agent can explain to a person. */
  check(userId: string, adapterId?: string): void {
    this.#take(this.#users, userId, this.#options.perUser, "You have made a lot of requests. Wait a moment and try again.");
    if (adapterId) {
      const rule = this.#options.perAdapter[adapterId] ?? this.#options.defaultAdapter;
      this.#take(this.#adapters, adapterId, rule, "That booking system is busy right now. Try again shortly.");
    }
  }

  #take(map: Map<string, Bucket>, id: string, rule: RateLimitRule, message: string): void {
    const now = this.#clock.nowMs();
    let bucket = map.get(id);
    if (!bucket) {
      bucket = { tokens: rule.capacity, lastMs: now };
      map.set(id, bucket);
    }
    const elapsedSec = Math.max(0, (now - bucket.lastMs) / 1000);
    bucket.tokens = Math.min(rule.capacity, bucket.tokens + elapsedSec * rule.refillPerSecond);
    bucket.lastMs = now;

    if (bucket.tokens < 1) {
      const waitSec = Math.ceil((1 - bucket.tokens) / rule.refillPerSecond);
      throw new PorterError("RATE_LIMITED", message, { retryAfterSeconds: Math.max(1, waitSec) });
    }
    bucket.tokens -= 1;
  }
}

export const DEFAULT_RATE_LIMITS: RateLimiterOptions = {
  perUser: { capacity: 30, refillPerSecond: 1 },
  perAdapter: {},
  defaultAdapter: { capacity: 60, refillPerSecond: 5 },
};
