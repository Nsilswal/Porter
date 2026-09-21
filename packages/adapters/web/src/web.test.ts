import { describe, expect, it } from "vitest";
import { makeContext } from "@porter/adapter-contract";
import { PorterError, sanitize } from "@porter/shared";
import { createWebAdapter, type WebSource } from "./index.js";
import { detectBlock, parseBusiness, parseIsoDuration, parsePriceMinor } from "./index.js";
import {
  BOT_BLOCK,
  CAPTCHA_WALL,
  FakeSite,
  HOSTILE_PAGE,
  LOGIN_WALL,
  PLUMBER_NO_STRUCTURED_DATA,
  SALON_WITH_JSONLD,
} from "./testing/fake-site.js";

const SALON = "https://bramble.example/";
const PLUMBER = "https://halloway.example/";
const BLOCKED = "https://blocked.example/";

const sources: WebSource[] = [
  { key: "bramble", url: SALON, categories: ["beauty.haircut"], postalCode: "94610" },
  { key: "halloway", url: PLUMBER, categories: ["home.plumbing.leak"], postalCode: "94607" },
];

function build(pages: Record<string, { status?: number; html: string }>, extra: WebSource[] = []) {
  const http = new FakeSite({ pages });
  return { http, adapter: createWebAdapter({ http, sources: [...sources, ...extra] }) };
}

describe("parsing", () => {
  it("reads a business and its services from JSON-LD", () => {
    const parsed = parseBusiness(SALON_WITH_JSONLD, SALON)!;
    expect(parsed.source).toBe("json-ld");
    expect(String(parsed.name)).toBe("Bramble & Bloom");
    expect(String(parsed.city)).toBe("Oakland");
    expect(parsed.services).toHaveLength(3);

    const cut = parsed.services[0]!;
    expect(String(cut.name)).toBe("Haircut");
    expect(cut.durationMinutes).toBe(45);
    expect(cut.priceMinor).toBe(7000);

    // 2h30m, so the duration parser has to handle hours plus minutes.
    expect(parsed.services[1]!.durationMinutes).toBe(150);
    expect(parsed.services[1]!.priceMinor).toBe(16550);

    // No price on the page means unknown, never free.
    expect(parsed.services[2]!.priceMinor).toBeNull();
  });

  it("falls back to the title and reports the weaker source", () => {
    const parsed = parseBusiness(PLUMBER_NO_STRUCTURED_DATA, PLUMBER)!;
    expect(parsed.source).toBe("dom");
    expect(String(parsed.name)).toBe("Halloway Plumbing");
    expect(parsed.services).toHaveLength(0);
    expect(parsed.bookingUrl).toBe("https://halloway.example/request");
  });

  it("parses ISO durations and prices, and refuses nonsense", () => {
    expect(parseIsoDuration("PT45M")).toBe(45);
    expect(parseIsoDuration("PT1H30M")).toBe(90);
    expect(parseIsoDuration("P1DT2H")).toBe(1560);
    expect(parseIsoDuration("banana")).toBeNull();
    expect(parseIsoDuration(undefined)).toBeNull();

    expect(parsePriceMinor("70.00")).toBe(7000);
    expect(parsePriceMinor("$1,250.50")).toBe(125050);
    expect(parsePriceMinor("free")).toBeNull();
    expect(parsePriceMinor(undefined)).toBeNull();
    expect(parsePriceMinor(-5)).toBeNull();
  });
});

describe("blocked pages", () => {
  it("recognises a wall before treating the page as data", () => {
    expect(detectBlock(200, CAPTCHA_WALL)).toBe("captcha");
    expect(detectBlock(403, BOT_BLOCK)).toBe("bot_check");
    expect(detectBlock(200, LOGIN_WALL)).toBe("login_required");
    expect(detectBlock(429, "")).toBe("rate_limited");
    expect(detectBlock(200, SALON_WITH_JSONLD)).toBeNull();
  });

  it("hands a CAPTCHA to the person with a link, and never tries to solve it", async () => {
    const { adapter } = build(
      { [BLOCKED]: { html: CAPTCHA_WALL } },
      [{ key: "blocked", url: BLOCKED, categories: ["beauty.haircut"] }],
    );
    try {
      await adapter.createBooking(
        { providerId: "web:blocked", locationId: "web:blocked", serviceId: "web:blocked:0", startsAt: new Date(), endsAt: new Date(), customer: {}, idempotencyKey: "k" },
        makeContext(),
      );
      expect.unreachable();
    } catch (error) {
      const e = error as PorterError;
      expect(e.code).toBe("HUMAN_ACTION_REQUIRED");
      expect(e.details.reason).toBe("captcha");
      expect(e.details.url).toBe(BLOCKED);
      // Worded for the person, not the developer.
      expect(e.message).toMatch(/open the link/i);
    }
  });

  it("asks the person to slow down rather than retrying into a ban", async () => {
    const { adapter } = build(
      { [BLOCKED]: { status: 429, html: "" } },
      [{ key: "blocked", url: BLOCKED, categories: ["beauty.haircut"] }],
    );
    await expect(
      adapter.searchProviders({ categories: ["beauty.haircut"], limit: 5 }, makeContext()),
    ).resolves.toEqual([]); // a blocked source is skipped, not fatal to the search
  });
});

describe("search", () => {
  it("returns businesses with the services listed on their page", async () => {
    const { adapter } = build({ [SALON]: { html: SALON_WITH_JSONLD }, [PLUMBER]: { html: PLUMBER_NO_STRUCTURED_DATA } });
    const results = await adapter.searchProviders({ categories: ["beauty.haircut"], limit: 5 }, makeContext());
    expect(results).toHaveLength(1);
    expect(String(results[0]!.provider.name)).toBe("Bramble & Bloom");
    expect(results[0]!.services.map((s) => String(s.name))).toContain("Haircut");
  });

  it("offers one honest placeholder when a page lists no services", async () => {
    const { adapter } = build({ [SALON]: { html: SALON_WITH_JSONLD }, [PLUMBER]: { html: PLUMBER_NO_STRUCTURED_DATA } });
    const results = await adapter.searchProviders({ categories: ["home.plumbing.leak"], limit: 5 }, makeContext());
    const service = results[0]!.services[0]!;
    // A menu is not invented; the one entry says what it is.
    expect(results[0]!.services).toHaveLength(1);
    expect(service.quoteRequired).toBe(true);
    expect(String(service.name)).toMatch(/own site/i);
  });

  it("caches, so a search does not hammer a small business's site", async () => {
    const { http, adapter } = build({ [SALON]: { html: SALON_WITH_JSONLD }, [PLUMBER]: { html: PLUMBER_NO_STRUCTURED_DATA } });
    const ctx = makeContext();
    await adapter.searchProviders({ categories: ["beauty.haircut"], limit: 5 }, ctx);
    await adapter.searchProviders({ categories: ["beauty.haircut"], limit: 5 }, ctx);
    expect(http.requests.filter((u) => u === SALON)).toHaveLength(1);
  });

  it("identifies itself honestly", async () => {
    const http = new FakeSite({ pages: { [SALON]: { html: SALON_WITH_JSONLD } } });
    const adapter = createWebAdapter({ http, sources: [sources[0]!] });
    await adapter.searchProviders({ categories: ["beauty.haircut"], limit: 1 }, makeContext());
    expect(http.requests).toContain(SALON);
  });
});

describe("writes are handed to the person", () => {
  it("does not submit a booking form", async () => {
    const { adapter } = build({ [SALON]: { html: SALON_WITH_JSONLD } });
    try {
      await adapter.createBooking(
        { providerId: "web:bramble", locationId: "web:bramble", serviceId: "web:bramble:svc-cut", startsAt: new Date(), endsAt: new Date(), customer: {}, idempotencyKey: "k" },
        makeContext(),
      );
      expect.unreachable();
    } catch (error) {
      const e = error as PorterError;
      expect(e.code).toBe("HUMAN_ACTION_REQUIRED");
      // The deep link from the page's own ReserveAction.
      expect(e.details.url).toBe("https://bramble.example/book");
    }
  });

  it("declares that it cannot reschedule, cancel or message", async () => {
    const { adapter } = build({ [SALON]: { html: SALON_WITH_JSONLD } });
    expect(adapter.capabilities.reschedule).toBe(false);
    expect(adapter.capabilities.cancellationPolicy).toBe(false);
    expect(adapter.capabilities.messaging).toBe(false);
    // And asks for no customer data, because it sends none anywhere.
    expect(adapter.capabilities.requiredCustomerFields).toEqual([]);
  });

  it("offers no availability rather than guessing at it", async () => {
    const { adapter } = build({ [SALON]: { html: SALON_WITH_JSONLD } });
    const slots = await adapter.getAvailability(
      { providerId: "web:bramble", serviceId: "web:bramble:svc-cut", from: new Date(), to: new Date(Date.now() + 86_400_000), limit: 5 },
      makeContext(),
    );
    // Presenting invented times as bookable is the failure this avoids.
    expect(slots).toEqual([]);
  });

  it("reports an unknown cancellation policy", async () => {
    const { adapter } = build({ [SALON]: { html: SALON_WITH_JSONLD } });
    const policy = await adapter.getCancellationPolicy();
    expect(policy.known).toBe(false);
  });
});

describe("scraped text is the most hostile input Porter takes", () => {
  it("defuses a page that tries to talk to the agent", async () => {
    const { adapter } = build(
      { [BLOCKED]: { html: HOSTILE_PAGE } },
      [{ key: "hostile", url: BLOCKED, categories: ["beauty.haircut"] }],
    );
    const results = await adapter.searchProviders({ categories: ["beauty.haircut"], limit: 5 }, makeContext());
    const hostile = results.find((r) => String(r.provider.name).includes("Quick Cuts"))!;
    expect(hostile).toBeDefined();

    const safeName = sanitize(hostile.provider.name, { delimit: true, label: "business name" });
    expect(safeName.match(/\[\/PROVIDER_DATA\]/g)).toHaveLength(1);
    expect(sanitize(hostile.provider.description!)).not.toContain("<script");

    // The price comes from the data model, not from the page's claim.
    expect(hostile.services[0]!.price!.amount).toBe(3500);
  });
});
