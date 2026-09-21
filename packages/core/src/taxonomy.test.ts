import { describe, expect, it } from "vitest";
import { QUOTE_REQUIRED_CATEGORIES, SERVICE_CATEGORIES, isServiceCategory, resolveCategory } from "./taxonomy.js";

describe("taxonomy", () => {
  it("resolves the words people actually use", () => {
    expect(resolveCategory("haircut")).toContain("beauty.haircut");
    expect(resolveCategory("plumber")).toContain("home.plumbing.leak");
    expect(resolveCategory("AC")).toContain("home.hvac.repair");
    expect(resolveCategory("cleaning")).toContain("home.cleaning.standard");
  });

  it("resolves a domain prefix to everything under it", () => {
    const beauty = resolveCategory("beauty");
    expect(beauty.length).toBeGreaterThan(3);
    expect(beauty.every((c) => c.startsWith("beauty."))).toBe(true);
  });

  it("returns nothing rather than guessing for unknown input", () => {
    expect(resolveCategory("time travel")).toEqual([]);
    expect(resolveCategory("")).toEqual([]);
  });

  it("excludes regulated categories from v1", () => {
    // The Muse Connector Policies prohibit practising regulated professions
    // without authorization, and health bookings engage the sensitive-attribute
    // rule. None of these may exist in the taxonomy.
    for (const c of SERVICE_CATEGORIES) {
      expect(c).not.toMatch(/^(health|medical|legal|financial|dental|therapy)\./);
    }
    expect(resolveCategory("doctor")).toEqual([]);
    expect(resolveCategory("lawyer")).toEqual([]);
    expect(resolveCategory("therapist")).toEqual([]);
  });

  it("marks trades that need a quote", () => {
    expect(QUOTE_REQUIRED_CATEGORIES.has("home.plumbing.leak")).toBe(true);
    expect(QUOTE_REQUIRED_CATEGORIES.has("beauty.haircut")).toBe(false);
  });

  it("only accepts categories that exist", () => {
    expect(isServiceCategory("beauty.haircut")).toBe(true);
    expect(isServiceCategory("beauty.teleportation")).toBe(false);
  });
});
