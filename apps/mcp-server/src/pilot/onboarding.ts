import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { PilotBusiness, PilotSession, PilotStore } from "@porter/db";
import { sanitize } from "@porter/shared";
import { importWebsite, type WebsitePreview } from "./importer.js";
import { opaqueToken, PilotHttpError, tokenHash, validToken } from "./security.js";

export const DRAFT_LIFETIME = 24 * 60 * 60_000;
const previewSchema = z.object({
  submittedUrl: z.string().max(2_048), sourceUrl: z.string().max(2_048), fetchedAt: z.string(),
  name: z.string().optional(), description: z.string().optional(), address: z.string().optional(), phone: z.string().optional(),
  bookingProvider: z.enum(["square", "unknown"]), bookingUrl: z.string().optional(),
  services: z.array(z.object({ name: z.string(), description: z.string().optional(), priceText: z.string().optional(), durationText: z.string().optional(), sourceUrl: z.string() })).max(50),
  warnings: z.array(z.string()),
});

/** Anonymous previews carry no owner privilege. Claiming requires a live session. */
export class PilotOnboarding {
  constructor(
    readonly store: PilotStore,
    readonly importer: (url: string) => Promise<WebsitePreview> = importWebsite,
    readonly now: () => Date = () => new Date(),
  ) {}

  async start(input: string, browserNonce: string): Promise<{ token: string; preview: WebsitePreview }> {
    if (!validToken(browserNonce)) throw expiredDraft();
    const now = this.now();
    for (const [key, limit, windowMs] of [["import:global", 100, 60 * 60_000], [`import:browser:${browserNonce}`, 5, 15 * 60_000]] as const) {
      if (!await this.store.rateLimits.take({ keyHash: tokenHash(key), limit, windowMs, now })) {
        throw new PilotHttpError(429, "import_rate_limited", "Please wait before importing another website.");
      }
    }
    const preview = await this.importer(input.trim());
    if (!preview.submittedUrl) throw new PilotHttpError(400, "invalid_website", "Enter a public website URL, starting with https://.");
    const token = opaqueToken();
    await this.store.imports.put({
      tokenHash: tokenHash(token), browserNonceHash: tokenHash(browserNonce), sourceUrl: preview.submittedUrl,
      preview: { ...preview }, expiresAt: new Date(now.getTime() + DRAFT_LIFETIME),
    });
    return { token, preview };
  }

  async preview(token: string | null, browserNonce: string | null): Promise<WebsitePreview | null> {
    if (!validToken(token) || !validToken(browserNonce)) return null;
    const saved = await this.store.imports.get(tokenHash(token), tokenHash(browserNonce), this.now());
    const parsed = previewSchema.safeParse(saved);
    return parsed.success ? parsed.data : null;
  }

  async claim(session: PilotSession, token: string | null, browserNonce: string | null, name: string): Promise<PilotBusiness> {
    if (!validToken(token) || !validToken(browserNonce)) throw expiredDraft();
    const cleanName = sanitize(name.trim(), { maxLength: 160 });
    if (!cleanName || name.length > 160) throw new PilotHttpError(400, "invalid_business_name", "Enter your business name, up to 160 characters.");
    const business = await this.store.imports.claim({
      tokenHash: tokenHash(token), browserNonceHash: tokenHash(browserNonce), ownerId: session.userId, sessionHash: session.sessionHash,
      businessId: randomUUID(), name: cleanName, now: this.now(),
    });
    if (!business) throw expiredDraft();
    return business;
  }
}

function expiredDraft(): PilotHttpError {
  return new PilotHttpError(400, "draft_unavailable", "This website preview has expired or belongs to a different browser. Import your website again.");
}
