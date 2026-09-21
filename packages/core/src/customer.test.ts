import { describe, expect, it } from "vitest";
import { PorterError } from "@porter/shared";
import { projectCustomer } from "./customer.js";

/**
 * Terms 4.3(e): no recipient may receive broader access than Porter holds.
 * These tests are the enforcement of that clause, not a nicety.
 */
describe("projectCustomer", () => {
  const full = {
    givenName: "Sam",
    familyName: "Rivera",
    email: "sam@example.com",
    phone: "555-0100",
    addressLine1: "12 Oak St",
    city: "Oakland",
    region: "CA",
    postalCode: "94610",
    notes: "gate code 1234",
  };

  it("forwards only the fields an adapter declared", () => {
    const { customer, disclosure } = projectCustomer("mock", full, ["givenName", "phone"], ["familyName"]);
    expect(Object.keys(customer).sort()).toEqual(["familyName", "givenName", "phone"]);
    expect(customer.email).toBeUndefined();
    expect(customer.addressLine1).toBeUndefined();
    expect(customer.notes).toBeUndefined();
    expect(disclosure.fields.sort()).toEqual(["familyName", "givenName", "phone"]);
    expect(disclosure.adapterId).toBe("mock");
  });

  it("drops empty values rather than forwarding blanks", () => {
    const { customer, disclosure } = projectCustomer("mock", { givenName: "Sam", phone: "555-0100", familyName: "   " }, ["givenName", "phone"], ["familyName"]);
    expect(customer.familyName).toBeUndefined();
    expect(disclosure.fields).not.toContain("familyName");
  });

  it("fails before contacting a provider when a required field is missing", () => {
    try {
      projectCustomer("mock", { givenName: "Sam" }, ["givenName", "phone"], []);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(PorterError.is(error)).toBe(true);
      expect((error as PorterError).code).toBe("INVALID_REQUEST");
      expect((error as PorterError).details.missingFields).toEqual(["phone"]);
      // The message is written to be read aloud to a person.
      expect((error as PorterError).message).toContain("phone number");
    }
  });

  it("never returns a field that is neither required nor optional", () => {
    const { customer } = projectCustomer("mock", full, ["givenName"], []);
    expect(Object.keys(customer)).toEqual(["givenName"]);
  });
});
