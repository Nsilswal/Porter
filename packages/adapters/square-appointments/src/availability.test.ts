import { describe, expect, it } from "vitest";
import { makeContext } from "@porter/adapter-contract";
import type { HttpRequest } from "@porter/shared";
import type { SquareAvailability } from "./api.js";
import { createSquareAdapter } from "./index.js";
import { FakeSquare, SQUARE_TEST_TOKEN } from "./testing/fake-square.js";
import rangeErrorFixture from "./fixtures/availability-range-error.json" with { type: "json" };

const locationId = "L7GK3M2QWERTY";
const providerId = `square:${locationId}`;
const serviceId = `${providerId}:VAR_CUT_45`;
const startsAt = new Date("2026-10-02T16:00:00.000Z");
const hourMs = 60 * 60_000;
const availabilityPath = "/v2/bookings/availability/search";
const context = () => makeContext({ credentials: { accessToken: SQUARE_TEST_TOKEN } });

function availability(offsetMinutes = 0, teamMemberId = "TM_ALEX"): SquareAvailability {
  return {
    start_at: new Date(startsAt.getTime() + offsetMinutes * 60_000).toISOString(),
    location_id: locationId,
    appointment_segments: [{
      service_variation_id: "VAR_CUT_45",
      service_variation_version: 1,
      duration_minutes: 45,
      team_member_id: teamMemberId,
    }],
  };
}

function build(availabilities?: readonly SquareAvailability[]) {
  const fake = new FakeSquare();
  const searches: HttpRequest[] = [];
  const adapter = createSquareAdapter({ http: { send: async (request) => {
    // Let the fake enforce the actual minimum-range error even with custom
    // response ordering or more team members than the catalog fixture has.
    const result = await fake.send(request);
    if (new URL(request.url).pathname !== availabilityPath) return result;
    searches.push(request);
    return result.status === 200 && availabilities
      ? { ...result, body: { availabilities } }
      : result;
  } } });
  return { adapter, fake, searches };
}

function searchRange(request: HttpRequest) {
  return (request.body as { query: { filter: { start_at_range: { start_at: string; end_at: string } } } }).query.filter.start_at_range;
}

describe("Square availability search windows", () => {
  it("reproduces the sandbox's INVALID_TIME_RANGE for a two-minute request", async () => {
    const fake = new FakeSquare();
    const result = await fake.send({
      method: "POST",
      url: `https://connect.squareupsandbox.com${availabilityPath}`,
      headers: { authorization: `Bearer ${SQUARE_TEST_TOKEN}`, "square-version": "2025-01-23" },
      body: { query: { filter: {
        start_at_range: {
          start_at: new Date(startsAt.getTime() - 60_000).toISOString(),
          end_at: new Date(startsAt.getTime() + 60_000).toISOString(),
        },
        location_id: locationId,
        segment_filters: [{ service_variation_id: "VAR_CUT_45" }],
      } } },
    });
    expect(result.status).toBe(400);
    expect(result.body).toEqual(rangeErrorFixture);
    expect(fake.bookings.size).toBe(0);
  });

  it("rechecks a slot with the documented 24-hour upstream minimum", async () => {
    const { adapter, searches } = build();
    const slot = await adapter.checkSlot({ providerId, serviceId, startsAt, providerSlotRef: "TM_ALEX" }, context());
    expect(slot).toMatchObject({ startsAt, providerSlotRef: "TM_ALEX" });
    expect(searches).toHaveLength(1);
    expect(searchRange(searches[0]!)).toEqual({
      start_at: startsAt.toISOString(),
      end_at: new Date(startsAt.getTime() + 24 * hourMs).toISOString(),
    });
  });

  it("keeps a narrow caller window after expanding the provider request", async () => {
    const { adapter, searches } = build();
    const slots = await adapter.getAvailability({
      providerId, serviceId, from: startsAt, to: new Date(startsAt.getTime() + 60_000), limit: 20,
    }, context());
    expect(slots.length).toBeGreaterThan(0);
    expect(slots.every((slot) => slot.startsAt.getTime() === startsAt.getTime())).toBe(true);
    expect(Date.parse(searchRange(searches[0]!).end_at) - Date.parse(searchRange(searches[0]!).start_at)).toBe(24 * hourMs);
  });

  it("filters response times before counting the requested limit", async () => {
    const { adapter } = build([availability(-1), availability(31), availability(0), availability(30)]);
    const slots = await adapter.getAvailability({
      providerId, serviceId, from: startsAt, to: new Date(startsAt.getTime() + 30 * 60_000), limit: 1,
    }, context());
    expect(slots).toHaveLength(1);
    expect(slots[0]?.startsAt).toEqual(startsAt);
  });

  it("retains the inclusive caller window's upper boundary", async () => {
    const { adapter } = build([availability(31), availability(30)]);
    const to = new Date(startsAt.getTime() + 30 * 60_000);
    const slots = await adapter.getAvailability({ providerId, serviceId, from: startsAt, to, limit: 1 }, context());
    expect(slots).toHaveLength(1);
    expect(slots[0]?.startsAt).toEqual(to);
  });

  it("preserves an already valid caller search range", async () => {
    const { adapter, searches } = build();
    const to = new Date(startsAt.getTime() + 48 * hourMs);
    await adapter.getAvailability({ providerId, serviceId, from: startsAt, to, limit: 1 }, context());
    expect(searchRange(searches[0]!)).toEqual({ start_at: startsAt.toISOString(), end_at: to.toISOString() });
  });

  it("finds the chosen team member after more than ten other available people", async () => {
    const others = Array.from({ length: 20 }, (_, index) => availability(0, `TM_OTHER_${index}`));
    const { adapter } = build([...others, availability(30), availability(0)]);
    const slot = await adapter.checkSlot({ providerId, serviceId, startsAt, providerSlotRef: "TM_ALEX" }, context());
    expect(slot).toMatchObject({ startsAt, providerSlotRef: "TM_ALEX" });
  });

  it("does not replace the selected person or time when that exact slot is gone", async () => {
    const { adapter } = build([availability(0, "TM_OTHER"), availability(30, "TM_ALEX")]);
    await expect(adapter.checkSlot({ providerId, serviceId, startsAt, providerSlotRef: "TM_ALEX" }, context())).resolves.toBeNull();
  });

  it("accepts any available person at the exact time when none was selected", async () => {
    const { adapter } = build([availability(30), availability(0, "TM_OTHER")]);
    const slot = await adapter.checkSlot({ providerId, serviceId, startsAt }, context());
    expect(slot).toMatchObject({ startsAt, providerSlotRef: "TM_OTHER" });
  });
});
