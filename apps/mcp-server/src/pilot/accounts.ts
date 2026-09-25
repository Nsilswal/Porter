import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { PilotSession, PilotStore } from "@porter/db";
import type { SignInMailer } from "./mail.js";
import { opaqueToken, PilotHttpError, tokenHash, validToken } from "./security.js";

const LINK_LIFETIME = 15 * 60_000;
export const SESSION_LIFETIME = 14 * 24 * 60 * 60_000;
const emailSchema = z.string().trim().email().max(254).transform((value) => value.toLowerCase());

export class PilotAccounts {
  constructor(
    readonly store: PilotStore,
    readonly mailer: SignInMailer,
    readonly origin: string,
    readonly now: () => Date = () => new Date(),
  ) {}

  async requestLink(emailInput: string, browserNonce: string): Promise<void> {
    const parsed = emailSchema.safeParse(emailInput);
    if (!parsed.success || !validToken(browserNonce)) {
      throw new PilotHttpError(400, "invalid_email", "Enter a valid email address.");
    }
    const now = this.now();
    for (const [key, limit] of [["signin:global", 100], [`signin:browser:${browserNonce}`, 6], [`signin:email:${parsed.data}`, 5]] as const) {
      if (!await this.store.rateLimits.take({ keyHash: tokenHash(key), limit, windowMs: LINK_LIFETIME, now })) {
        throw new PilotHttpError(429, "rate_limited", "Please wait before requesting another sign-in link.");
      }
    }
    const identity = await this.store.identities.getOrCreate(parsed.data);
    const token = opaqueToken();
    await this.store.loginTokens.issue({
      userId: identity.userId, tokenHash: tokenHash(token), browserNonceHash: tokenHash(browserNonce),
      expiresAt: new Date(now.getTime() + LINK_LIFETIME),
    });
    // A fragment is never sent to the web server, proxy or referrer. The local
    // verification page copies it to a same-origin POST after a person clicks.
    const url = new URL("/signin/verify", this.origin);
    url.hash = token;
    try {
      await this.mailer.send({ to: identity.email, url: url.href });
    } catch {
      throw new PilotHttpError(503, "email_unavailable", "We could not send your sign-in link. Try again shortly.");
    }
  }

  async verifyLink(token: string, browserNonce: string): Promise<string> {
    if (!validToken(token) || !validToken(browserNonce)) throw invalidLink();
    const sessionToken = opaqueToken();
    const now = this.now();
    const result = await this.store.loginTokens.consume({
      tokenHash: tokenHash(token), browserNonceHash: tokenHash(browserNonce), sessionHash: tokenHash(sessionToken),
      sessionExpiresAt: new Date(now.getTime() + SESSION_LIFETIME), now,
    });
    if (!result) throw invalidLink();
    return sessionToken;
  }

  async session(token: string | null): Promise<PilotSession | null> {
    return validToken(token) ? this.store.sessions.lookup(tokenHash(token), this.now()) : null;
  }

  async issueConnector(session: PilotSession, label: string): Promise<{ id: string; key: string }> {
    if (!await this.store.sessions.lookup(session.sessionHash, this.now())) throw new PilotHttpError(401, "signin_required", "Sign in to continue.");
    if (label.length > 80 || !label.trim()) throw new PilotHttpError(400, "invalid_label", "Give this connection a short name.");
    const now = this.now();
    if (!await this.store.rateLimits.take({ keyHash: tokenHash(`connector:${session.userId}`), limit: 10, windowMs: 60 * 60_000, now })) {
      throw new PilotHttpError(429, "rate_limited", "Please wait before creating another connection.");
    }
    const key = `porter_${opaqueToken()}`;
    const credential = await this.store.connectors.issue({ id: randomUUID(), userId: session.userId, tokenHash: tokenHash(key), label: label.trim() });
    return { id: credential.id, key };
  }

  async authenticateConnector(key: string): Promise<string | null> {
    if (!/^porter_[A-Za-z0-9_-]{43}$/.test(key)) return null;
    return (await this.store.connectors.lookup(tokenHash(key)))?.userId ?? null;
  }
}

function invalidLink(): PilotHttpError {
  return new PilotHttpError(400, "invalid_link", "Open this link in the browser where you requested it. If it expired or was already used, request a new link.");
}
