import { PorterError, money } from "@porter/shared";
import type { Booking, ServiceCategory, Slot } from "@porter/core";
import type { GraphQLError, JobberRequestStatus } from "./api.js";

export interface ServiceOffering {
  readonly key: string;
  readonly name: string;
  readonly category: ServiceCategory;
  readonly durationMinutes: number;
  readonly priceMinor?: number;
  readonly priceRangeMinor?: readonly [number, number];
  readonly quoteRequired?: boolean;
}

/**
 * Jobber request status -> Porter booking status.
 *
 * `requires_scheduling` is the state a fresh request lands in: the business
 * has it but has not committed to a time. That is Porter's `pending`, and
 * mapping it to `confirmed` would tell the user something untrue.
 */
export function mapRequestStatus(status: JobberRequestStatus | undefined): Booking["status"] {
  switch (status) {
    case "scheduled":
    case "converted":
      return "confirmed";
    case "completed":
      return "completed";
    case "archived":
      return "cancelled";
    case "requires_scheduling":
    default:
      return "pending";
  }
}

export interface WindowOptions {
  readonly offering: ServiceOffering;
  readonly windows: readonly (readonly [number, number])[];
  readonly from: Date;
  readonly to: Date;
  readonly now: Date;
  readonly limit: number;
  readonly horizonEnd: Date;
  readonly providerId: string;
  readonly serviceId: string;
  readonly isTaken: (startsAt: Date) => boolean;
}

/**
 * Generate requestable arrival windows.
 *
 * These are not confirmed slots. Jobber has no open-slot API, so what Porter
 * can honestly offer is "windows this business accepts requests for". The
 * booking that results is `pending` until the business schedules it.
 *
 * Weekends are excluded and same-day requests are not offered, which matches
 * how home-service businesses actually take work.
 */
export function windowsFor(options: WindowOptions): Slot[] {
  const { offering, windows, from, to, now, limit, horizonEnd, providerId, serviceId, isTaken } = options;
  const out: Slot[] = [];

  // Nothing same-day: a trade needs lead time to route a van.
  const earliest = Math.max(from.getTime(), now.getTime() + 24 * 60 * 60_000);
  const latest = Math.min(to.getTime(), horizonEnd.getTime());
  if (earliest > latest) return out;

  const cursor = new Date(earliest);
  cursor.setUTCHours(0, 0, 0, 0);

  for (let day = 0; day < 60 && out.length < limit; day++) {
    const base = new Date(cursor.getTime() + day * 86_400_000);
    if (base.getTime() > latest) break;
    const weekday = base.getUTCDay();
    if (weekday === 0 || weekday === 6) continue;

    for (const [startHour, endHour] of windows) {
      if (out.length >= limit) break;
      const startsAt = new Date(base.getTime() + startHour * 60 * 60_000);
      if (startsAt.getTime() < earliest || startsAt.getTime() > latest) continue;
      if (isTaken(startsAt)) continue;

      out.push({
        providerId,
        locationId: providerId,
        serviceId,
        startsAt,
        // The window is the commitment, not the duration of the work.
        endsAt: new Date(base.getTime() + endHour * 60 * 60_000),
        fetchedAt: now,
        providerSlotRef: `window:${startHour}-${endHour}`,
        ...(offering.priceMinor !== undefined ? { price: money(offering.priceMinor) } : {}),
      });
    }
  }
  return out;
}

/**
 * Jobber errors -> Porter's closed taxonomy.
 *
 * GraphQL returns 200 with an `errors` array, so the status code alone says
 * little. Jobber's own message text is never passed on: it is provider
 * controlled and therefore untrusted.
 */
export function mapJobberError(status: number, errors: readonly GraphQLError[] | undefined, adapterId: string): PorterError {
  const code = errors?.[0]?.extensions?.code ?? "";
  const message = errors?.[0]?.message ?? "";
  const details = { adapter: adapterId };

  if (code === "THROTTLED" || status === 429 || /throttle/i.test(message)) {
    return new PorterError("RATE_LIMITED", "That business's system is busy. Try again shortly.", {
      retryAfterSeconds: 10,
      details,
    });
  }
  if (code === "UNAUTHENTICATED" || status === 401 || status === 403) {
    return new PorterError("PROVIDER_UNAVAILABLE", "We have lost access to that business's system. It needs reconnecting.", { details });
  }
  if (code === "NOT_FOUND" || /not found|could not find/i.test(message)) {
    return new PorterError("NOT_FOUND", "We could not find that at this business.", { details });
  }
  if (code === "BAD_USER_INPUT" || code === "GRAPHQL_VALIDATION_FAILED" || status === 400) {
    return new PorterError("INVALID_REQUEST", "That request was not valid for this business.", { details });
  }

  return new PorterError("ADAPTER_DOWN", "That business's system is not responding right now. Try again in a moment.", { details });
}
