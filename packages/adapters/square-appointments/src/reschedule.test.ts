import { describe, expect, it } from "vitest";
import { makeContext, type RescheduleRequest } from "@porter/adapter-contract";
import type { SquareBooking } from "./api.js";
import { createSquareAdapter } from "./index.js";
import { FakeSquare, SQUARE_TEST_TOKEN } from "./testing/fake-square.js";
import profileFixture from "./fixtures/business-booking-profile.json" with { type: "json" };
import permissionErrorFixture from "./fixtures/booking-segments-permission-error.json" with { type: "json" };

const locationId = "L7GK3M2QWERTY";
const providerId = `square:${locationId}`;
const serviceId = `${providerId}:VAR_CUT_45`;
const bookingRef = "SQBK_EXISTING";
const startsAt = new Date("2026-10-03T16:00:00.000Z");
const context = () => makeContext({ credentials: { accessToken: SQUARE_TEST_TOKEN } });
const segment = {
  duration_minutes: 45,
  service_variation_id: "VAR_CUT_45",
  service_variation_version: 1,
  team_member_id: "TM_ALEX",
};

function moveRequest(overrides: Partial<RescheduleRequest> = {}): RescheduleRequest {
  return {
    bookingRef, providerId, serviceId, startsAt,
    endsAt: new Date(startsAt.getTime() + 45 * 60_000),
    providerSlotRef: "TM_ALEX",
    idempotencyKey: "move-time-only",
    ...overrides,
  };
}

function build(readback: Partial<SquareBooking> = {}, sellerWritesSupported = false) {
  const fake = new FakeSquare();
  const original = {
    id: bookingRef,
    version: 0,
    status: "ACCEPTED" as const,
    start_at: "2026-10-02T16:00:00.000Z",
    location_id: locationId,
    appointment_segments: [segment],
  };
  fake.bookings.set(bookingRef, structuredClone(original));
  const adapter = createSquareAdapter({ http: { send: async (request) => {
    const result = await fake.send(request);
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path === `/v2/bookings/${bookingRef}`) {
      return { ...result, body: { booking: { ...original, ...readback } } };
    }
    if (path.endsWith("/business-booking-profile")) {
      return { ...result, body: { business_booking_profile: {
        ...profileFixture.business_booking_profile,
        support_seller_level_writes: sellerWritesSupported,
      } } };
    }
    return result;
  } } });
  return { adapter, fake, original };
}

describe("Square buyer rescheduling", () => {
  it("updates only start_at and version while preserving the booked segment", async () => {
    const { adapter, fake, original } = build();
    const moved = await adapter.rescheduleBooking(moveRequest(), context());
    const updates = fake.requests.filter((request) => request.method === "PUT");
    expect(updates).toHaveLength(1);
    expect(updates[0]?.body).toEqual({
      idempotency_key: "move-time-only",
      booking: { version: 0, start_at: startsAt.toISOString() },
    });
    expect(moved.startsAt).toEqual(startsAt);
    expect(moved.endsAt.getTime() - moved.startsAt.getTime()).toBe(45 * 60_000);
    expect(fake.bookings.get(bookingRef)?.appointment_segments).toEqual(original.appointment_segments);
  });

  it("keeps the original staff member when the caller does not request a change", async () => {
    const { adapter, fake } = build();
    const { providerSlotRef: _staff, ...request } = moveRequest();
    await adapter.rescheduleBooking(request, context());
    expect(fake.bookings.get(bookingRef)?.appointment_segments?.[0]?.team_member_id).toBe("TM_ALEX");
    expect(fake.requests.find((entry) => entry.method === "PUT")?.body).not.toHaveProperty("booking.appointment_segments");
  });

  it.each([
    { name: "staff", overrides: { providerSlotRef: "TM_JO" } },
    { name: "duration", overrides: { endsAt: new Date(startsAt.getTime() + 30 * 60_000) } },
    { name: "service", overrides: { serviceId: `${providerId}:VAR_WORKS`, endsAt: new Date(startsAt.getTime() + 90 * 60_000) } },
  ])("rejects a $name change before sending PUT", async ({ overrides }) => {
    const { adapter, fake, original } = build();
    await expect(adapter.rescheduleBooking(moveRequest(overrides), context())).rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" });
    expect(fake.requests.some((request) => request.method === "PUT")).toBe(false);
    expect(fake.bookings.get(bookingRef)).toEqual(original);
  });

  it.each([
    { name: "multiple segments", segments: [segment, segment] },
    { name: "no segments", segments: [] },
    { name: "unknown staff", segments: [{ ...segment, team_member_id: "" }] },
    { name: "unknown duration", segments: [{ service_variation_id: segment.service_variation_id, team_member_id: segment.team_member_id }] },
  ])("rejects $name before sending PUT", async ({ segments }) => {
    const { adapter, fake } = build({ appointment_segments: segments });
    await expect(adapter.rescheduleBooking(moveRequest(), context())).rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" });
    expect(fake.requests.some((request) => request.method === "PUT")).toBe(false);
  });

  it("does not infer token permissions from the seller's subscription capability", async () => {
    const { adapter, fake } = build({}, true);
    await expect(adapter.rescheduleBooking(moveRequest({ providerSlotRef: "TM_JO" }), context())).rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" });
    expect(fake.requests.some((request) => request.method === "PUT")).toBe(false);
  });

  it("fails closed without an optimistic concurrency version", async () => {
    const { adapter, fake } = build({ version: undefined });
    await expect(adapter.rescheduleBooking(moveRequest(), context())).rejects.toMatchObject({ code: "ADAPTER_DOWN" });
    expect(fake.requests.some((request) => request.method === "PUT")).toBe(false);
  });

  it("reproduces the sandbox permission error even for unchanged segments", async () => {
    const { fake, original } = build();
    const result = await fake.send({
      method: "PUT",
      url: `https://connect.squareupsandbox.com/v2/bookings/${bookingRef}`,
      headers: { authorization: `Bearer ${SQUARE_TEST_TOKEN}`, "square-version": "2025-01-23" },
      body: { booking: { version: 0, start_at: startsAt.toISOString(), appointment_segments: [segment] } },
    });
    expect(result.status).toBe(403);
    expect(result.body).toEqual(permissionErrorFixture);
    expect(fake.bookings.get(bookingRef)).toEqual(original);
  });
});
