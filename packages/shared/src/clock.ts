export interface Clock {
  now(): Date;
  nowMs(): number;
}

export const systemClock: Clock = {
  now: () => new Date(),
  nowMs: () => Date.now(),
};

/** Test clock. Time only moves when a test moves it. */
export class FixedClock implements Clock {
  #ms: number;
  constructor(start: Date | number = 0) {
    this.#ms = typeof start === "number" ? start : start.getTime();
  }
  now(): Date {
    return new Date(this.#ms);
  }
  nowMs(): number {
    return this.#ms;
  }
  advance(ms: number): void {
    this.#ms += ms;
  }
  set(value: Date | number): void {
    this.#ms = typeof value === "number" ? value : value.getTime();
  }
}

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
