import { afterEach, describe, expect, it, vi } from "vitest";
import type { HttpClient, HttpRequest } from "@porter/shared";
import { PorterError } from "@porter/shared";
import { FakeSquare, SQUARE_TEST_TOKEN } from "@porter/adapter-square-appointments/testing";
import { runSquareSmoke } from "./square-smoke.js";

const SANDBOX = "https://connect.squareupsandbox.com";
const isCreate = (request: HttpRequest) => request.method === "POST" && request.url === `${SANDBOX}/v2/bookings`;
const run = (http: HttpClient, operationTimeoutMs?: number) => runSquareSmoke({ accessToken: SQUARE_TEST_TOKEN, http, operationTimeoutMs });

afterEach(() => vi.unstubAllGlobals());

describe("Square sandbox smoke harness", () => {
  it.each([
    "https://connect.squareup.com",
    "https://connect.squareup.com/",
    "https://CONNECT.SQUAREUP.COM",
    "http://connect.squareupsandbox.com",
    "https://connect.squareupsandbox.com.evil.example",
    "https://connect.squareupsandbox.com@evil.example",
    "https://user:password@connect.squareupsandbox.com",
    "https://connect.squareupsandbox.com:444",
    "https://connect.squareupsandbox.com/v2",
    "https://connect.squareupsandbox.com?access_token=secret",
    "https://connect.squareupsandbox.com#fragment",
    "",
  ])("rejects an unsafe destination before any HTTP call: %s", async (baseUrl) => {
    const send = vi.fn();
    await expect(runSquareSmoke({ accessToken: SQUARE_TEST_TOKEN, baseUrl, http: { send } })).rejects.toThrow("production and custom URLs are disabled");
    expect(send).not.toHaveBeenCalled();
  });

  it.each([SANDBOX, `${SANDBOX}/`])("uses an identical create payload and cleans up at %s", async (baseUrl) => {
    const fake = new FakeSquare();
    const report = await runSquareSmoke({ accessToken: SQUARE_TEST_TOKEN, baseUrl, http: fake });
    expect(report.outcome).toBe("passed");
    expect(report.uncertainCreate).toBe(false);
    expect(report.unresolvedBookingRefs).toEqual([]);
    const creates = fake.requests.filter((request) => request.method === "POST" && request.path === "/v2/bookings");
    expect(creates).toHaveLength(2);
    expect(creates[0]!.body).toEqual(creates[1]!.body);
    expect(creates[0]!.body).toMatchObject({
      idempotency_key: report.runId,
      booking: { customer_note: "Porter sandbox smoke test; synthetic customer; safe to delete." },
    });
    expect([...fake.customers.values()]).toMatchObject([{ phone_number: "+14155550100", email_address: `${report.runId}@example.com` }]);
    expect(fake.bookings.size).toBe(1);
    expect([...fake.bookings.values()].every((booking) => booking.status === "CANCELLED_BY_CUSTOMER")).toBe(true);
    expect(report.checks).toContainEqual({ status: "pass", label: "Reschedule" });
    expect(JSON.stringify(report)).not.toContain(SQUARE_TEST_TOKEN);
    expect(JSON.stringify(report)).not.toContain("example.com");
  });

  it("blocks a replay whose resolved customer changes before sending another create", async () => {
    const fake = new FakeSquare();
    let customerLookups = 0;
    const http: HttpClient = { async send(request) {
      if (request.url.endsWith("/customers/search") && ++customerLookups === 2) {
        return { status: 200, headers: {}, body: { customers: [{ id: "CHANGED_CUSTOMER", phone_number: "+14155550100" }] } };
      }
      return fake.send(request);
    } };
    const report = await run(http);
    expect(report.outcome).toBe("failed");
    expect(report.checks).toContainEqual({ status: "fail", label: "Idempotent replay", detail: "The rebuilt Square booking payload changed; replay was not sent." });
    expect(report.checks.some((entry) => entry.status === "pass" && entry.label === "Idempotent replay")).toBe(false);
    expect(fake.requests.filter((request) => request.method === "POST" && request.path === "/v2/bookings")).toHaveLength(1);
    expect(fake.bookings.size).toBe(1);
    expect([...fake.bookings.values()][0]!.status).toBe("CANCELLED_BY_CUSTOMER");
    expect(report.uncertainCreate).toBe(false);
    expect(report.unresolvedBookingRefs).toEqual([]);
    expect(JSON.stringify(report)).not.toContain("CHANGED_CUSTOMER");
  });

  it("disables redirects in the real transport without printing upstream errors", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ errors: [{ code: "UNAUTHORIZED", detail: "private raw error" }] }), { status: 401 }));
    vi.stubGlobal("fetch", fetchImpl);
    const report = await runSquareSmoke({ accessToken: "secret-token" });
    expect(fetchImpl).toHaveBeenCalledWith(`${SANDBOX}/v2/locations`, expect.objectContaining({ redirect: "error" }));
    expect(report.outcome).toBe("failed");
    expect(JSON.stringify(report)).not.toMatch(/secret-token|private raw error/);
    expect(report.checks).toContainEqual({ status: "fail", label: "Catalog discovery", detail: "PROVIDER_UNAVAILABLE" });
  });

  it("does not book after the availability recheck fails", async () => {
    const fake = new FakeSquare();
    const http: HttpClient = { async send(request) {
      if (request.url.endsWith("/availability/search")) {
        const body = request.body as { query: { filter: { start_at_range: { start_at: string; end_at: string } } } };
        const range = body.query.filter.start_at_range;
        if (Date.parse(range.end_at) - Date.parse(range.start_at) <= 86_400_000) return { status: 200, headers: {}, body: { availabilities: [] } };
      }
      return fake.send(request);
    } };
    const report = await run(http);
    expect(report.outcome).toBe("failed");
    expect(report.checks).toContainEqual(expect.objectContaining({ status: "fail", label: "Slot recheck" }));
    expect(fake.customers.size).toBe(0);
    expect(fake.bookings.size).toBe(0);
  });

  it("cleans up with a fresh signal after rescheduling times out", async () => {
    const fake = new FakeSquare();
    let expiredSignal: AbortSignal | undefined;
    let cleanupSignal: AbortSignal | undefined;
    const http: HttpClient = { async send(request) {
      if (request.method === "PUT" && request.url.includes("/v2/bookings/")) {
        expiredSignal = request.signal;
        await new Promise<void>((_resolve, reject) => request.signal!.addEventListener("abort", () => reject(new PorterError("ADAPTER_DOWN", "sensitive cause", { details: { token: SQUARE_TEST_TOKEN } })), { once: true }));
      }
      if (request.url.endsWith("/cancel")) cleanupSignal = request.signal;
      return fake.send(request);
    } };
    const report = await run(http, 50);
    expect(report.outcome).toBe("failed");
    expect(expiredSignal?.aborted).toBe(true);
    expect(cleanupSignal).toBeDefined();
    expect(cleanupSignal).not.toBe(expiredSignal);
    expect(cleanupSignal?.aborted).toBe(false);
    expect(report.unresolvedBookingRefs).toEqual([]);
    expect([...fake.bookings.values()][0]!.status).toBe("CANCELLED_BY_CUSTOMER");
    expect(JSON.stringify(report)).not.toMatch(/sensitive cause|sandbox-token/);
  });

  it("tries to clean up every replay-created booking even when one cancellation fails", async () => {
    const fake = new FakeSquare();
    let creates = 0;
    const cancelKeys: string[] = [];
    const http: HttpClient = { async send(request) {
      if (isCreate(request) && ++creates === 2) {
        const original = [...fake.bookings.values()][0]!;
        const duplicate = { ...original, id: "SQBK_DUPLICATE" };
        fake.bookings.set(duplicate.id, duplicate);
        return { status: 200, headers: {}, body: { booking: duplicate } };
      }
      if (request.url.endsWith("/cancel")) {
        cancelKeys.push((request.body as { idempotency_key: string }).idempotency_key);
        if (cancelKeys.length === 1) throw new Error("private connection details");
      }
      return fake.send(request);
    } };
    const report = await run(http);
    expect(report.outcome).toBe("failed");
    expect(report.checks).toContainEqual(expect.objectContaining({ status: "fail", label: "Idempotent replay" }));
    expect(cancelKeys).toHaveLength(2);
    expect(new Set(cancelKeys).size).toBe(2);
    expect(report.unresolvedBookingRefs).toEqual([[...fake.bookings.keys()][0]!]);
    expect(fake.bookings.get("SQBK_DUPLICATE")!.status).toBe("CANCELLED_BY_CUSTOMER");
    expect(JSON.stringify(report)).not.toContain("private connection details");
  });

  it("detects incorrect created-booking times and still cancels the observed booking", async () => {
    const fake = new FakeSquare();
    const http: HttpClient = { async send(request) {
      const response = await fake.send(request);
      if (!isCreate(request)) return response;
      const booking = [...fake.bookings.values()][0]!;
      return { ...response, body: { booking: { ...booking, start_at: new Date(Date.parse(booking.start_at!) + 60_000).toISOString() } } };
    } };
    const report = await run(http);
    expect(report.outcome).toBe("failed");
    expect(report.checks).toContainEqual(expect.objectContaining({ status: "fail", label: "Created booking details" }));
    expect(report.unresolvedBookingRefs).toEqual([]);
    expect([...fake.bookings.values()][0]!.status).toBe("CANCELLED_BY_CUSTOMER");
  });

  it("reports an uncertain create when the response is lost instead of claiming cleanup", async () => {
    const fake = new FakeSquare();
    const http: HttpClient = { async send(request) {
      const response = await fake.send(request);
      if (isCreate(request)) throw new Error("lost response with private token");
      return response;
    } };
    const report = await run(http);
    expect(report.outcome).toBe("failed");
    expect(report.uncertainCreate).toBe(true);
    expect(report.unresolvedBookingRefs).toEqual([]);
    expect(report.checks).toContainEqual(expect.objectContaining({ status: "fail", label: "Uncertain create outcome" }));
    expect([...fake.bookings.values()][0]!.status).toBe("ACCEPTED");
    expect(report.checks.some((entry) => entry.label === "Cancel test booking")).toBe(false);
    expect(JSON.stringify(report)).not.toContain("lost response");
  });

  it("reports incomplete when rescheduling cannot be exercised, while cancelling the booking", async () => {
    const fake = new FakeSquare();
    const http: HttpClient = { async send(request) {
      if (fake.bookings.size > 0 && request.url.endsWith("/availability/search")) return { status: 200, headers: {}, body: { availabilities: [] } };
      return fake.send(request);
    } };
    const report = await run(http);
    expect(report.outcome).toBe("incomplete");
    expect(report.checks).toContainEqual({ status: "skip", label: "Reschedule", detail: "No later slot returned." });
    expect(report.unresolvedBookingRefs).toEqual([]);
    expect([...fake.bookings.values()][0]!.status).toBe("CANCELLED_BY_CUSTOMER");
  });
});
