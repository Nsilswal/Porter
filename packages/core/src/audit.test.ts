import { describe, expect, it } from "vitest";
import { assertNoPersonalData } from "./audit.js";
import { TEST_CUSTOMER, createHarness, firstBookableSlot } from "./testing.js";
import type { ConfirmationEnvelope } from "./confirmation.js";
import type { AuditRecord } from "./ports.js";

const base: AuditRecord = {
  at: new Date(),
  actorId: "user_abc",
  tool: "create_booking",
  action: "commit",
  adapterId: "mock",
  providerId: "mock:shear-genius",
  argsHash: "a".repeat(64),
  idempotencyKey: "k1",
  confirmationJti: "cnf_1",
  outcome: "ok",
  errorCode: null,
  latencyMs: 12,
  disclosedFields: ["givenName", "phone"],
};

describe("audit log", () => {
  it("accepts a well-formed row", () => {
    expect(() => assertNoPersonalData(base)).not.toThrow();
  });

  it("rejects an email address in any string field", () => {
    expect(() => assertNoPersonalData({ ...base, actorId: "sam@example.com" })).toThrow(/personal data/);
  });

  it("rejects a phone number", () => {
    expect(() => assertNoPersonalData({ ...base, idempotencyKey: "+1 555 123 4567" })).toThrow(/personal data/);
  });

  it("rejects a payload smuggled in where the hash belongs", () => {
    expect(() => assertNoPersonalData({ ...base, argsHash: JSON.stringify({ email: "a@b.com" }) })).toThrow(/sha256/);
  });
});

describe("audit log contents after a real booking", () => {
  it("records the write without storing any personal data", async () => {
    const h = createHarness();
    const { slot } = await firstBookableSlot(h);
    const env = (await h.engine.createBooking(h.actor, { slot_id: slot.slot_id, customer_details: TEST_CUSTOMER, idempotency_key: "b1" }, h.signal)) as ConfirmationEnvelope;
    await h.engine.createBooking(h.actor, { slot_id: slot.slot_id, customer_details: TEST_CUSTOMER, idempotency_key: "b1", confirmation_token: env.confirmationToken }, h.signal);

    const commit = h.store.auditRows.find((r) => r.tool === "create_booking" && r.action === "commit");
    expect(commit).toBeDefined();
    expect(commit!.outcome).toBe("ok");
    expect(commit!.confirmationJti).toBeTruthy();
    // Field NAMES are recorded so a Meta audit can see what was disclosed.
    expect(commit!.disclosedFields).toContain("givenName");
    expect(commit!.disclosedFields).toContain("phone");

    // Nothing anywhere in the log resembles the customer's actual details.
    const serialised = JSON.stringify(h.store.auditRows);
    expect(serialised).not.toContain(TEST_CUSTOMER.email);
    expect(serialised).not.toContain(TEST_CUSTOMER.phone);
    expect(serialised).not.toContain(TEST_CUSTOMER.givenName);
    expect(serialised).not.toContain(TEST_CUSTOMER.addressLine1);
  });
});
