import { describe, expect, it } from "vitest";
import type { SquareBooking } from "./api.js";
import { mapBooking, mapCancellationPolicy } from "./map.js";
import recorded from "./fixtures/sandbox-buyer-lifecycle-recorded.json" with { type: "json" };

const profile = recorded.profile.response.business_booking_profile;

function mapRecorded(booking: SquareBooking) {
  const policy = mapCancellationPolicy(profile, new Date(booking.start_at!));
  // The actual reply's segment duration must take precedence over a fallback.
  return mapBooking("square", booking, 60, policy, undefined);
}

describe("recorded Square buyer sandbox replies", () => {
  it.each([
    ["created", "confirmed"],
    ["cancelled", "cancelled"],
  ] as const)("maps the recorded %s status without inventing a cancellation policy", (stage, expectedStatus) => {
    const wire = recorded[stage].response.booking as SquareBooking;
    const booking = mapRecorded(wire);
    expect(booking.status).toBe(expectedStatus);
    expect(booking.providerBookingRef).toBe("BOOKING_RECORDED_1");
    expect(booking.providerId).toBe("square:LOCATION_RECORDED_1");
    expect(booking.startsAt).toEqual(new Date(wire.start_at!));
    expect(booking.endsAt.getTime() - booking.startsAt.getTime()).toBe(30 * 60_000);
    expect(booking.createdAt).toEqual(new Date("2026-09-25T03:24:28Z"));
    expect(booking.cancellationPolicy.known).toBe(false);
  });

  it("maps the time-only update reply while retaining the original appointment segment", () => {
    const before = recorded.created.response.booking;
    const after = recorded.rescheduled.response.booking;
    expect(recorded.rescheduled.request.booking).toEqual({ version: 0, start_at: "2026-09-25T14:30:00.000Z" });
    expect(after.appointment_segments).toEqual(before.appointment_segments);
    expect(after.version).toBe(1);

    const original = mapRecorded(before as SquareBooking);
    const moved = mapRecorded(after as SquareBooking);
    expect(moved.status).toBe("confirmed");
    expect(moved.startsAt).toEqual(new Date("2026-09-25T14:30:00Z"));
    expect(moved.endsAt).toEqual(new Date("2026-09-25T15:00:00Z"));
    expect(moved.serviceId).toBe(original.serviceId);
    expect(moved.providerBookingRef).toBe(original.providerBookingRef);
    expect(moved.updatedAt).toEqual(new Date("2026-09-25T03:24:32Z"));
  });

  it("keeps omitted fee and deadline fields unknown despite a currency and CUSTOM_POLICY value", () => {
    const settings = profile.business_appointment_settings;
    expect(settings.cancellation_fee_money).toEqual({ currency: "USD" });
    expect(settings).not.toHaveProperty("cancellation_window_seconds");
    expect(settings).not.toHaveProperty("cancellation_policy_text");
    expect(mapCancellationPolicy(profile, new Date(recorded.created.response.booking.start_at))).toEqual({
      known: false, freeUntil: null, feeAmount: null, text: null,
    });
  });
});
