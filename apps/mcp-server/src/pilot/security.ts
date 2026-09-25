import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export class PilotHttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "PilotHttpError";
  }
}

export function opaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

export function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function validToken(token: unknown): token is string {
  return typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token);
}

/** Ambiguous duplicate cookies are rejected, rather than picking one. */
export function readTokenCookie(req: IncomingMessage, name: string): string | null {
  const matches = (req.headers.cookie ?? "").split(";")
    .map((value) => value.trim()).filter((value) => value.startsWith(`${name}=`));
  if (matches.length !== 1) return null;
  const value = matches[0]!.slice(name.length + 1);
  return validToken(value) ? value : null;
}

export function setTokenCookie(res: ServerResponse, name: string, value: string, maxAge: number, secure: boolean): void {
  if (!/^[A-Za-z_]+$/.test(name) || (value && !validToken(value)) || !Number.isSafeInteger(maxAge) || maxAge < 0) {
    throw new Error("Invalid cookie configuration");
  }
  const existing = res.getHeader("set-cookie");
  const cookies = existing === undefined ? [] : Array.isArray(existing) ? existing.map(String) : [String(existing)];
  res.setHeader("Set-Cookie", [...cookies, `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`]);
}

/** Browser POSTs must originate at the configured app, never a forwarded Host. */
export function requireSameOrigin(req: IncomingMessage, origin: string): void {
  if (req.headers.origin !== origin || (req.headers["sec-fetch-site"] && req.headers["sec-fetch-site"] !== "same-origin")) {
    throw new PilotHttpError(403, "invalid_origin", "Open this page in Porter and try again.");
  }
}

export function privateResponse(res: ServerResponse): void {
  res.setHeader("Cache-Control", "no-store");
  // Preserve a real Origin on native form POSTs while never forwarding paths,
  // callback query strings or sign-in fragments as a referrer. no-referrer
  // makes native forms send Origin: null and breaks the strict CSRF check.
  res.setHeader("Referrer-Policy", "strict-origin");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
}

export async function readPilotForm(req: IncomingMessage): Promise<URLSearchParams> {
  const type = req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase();
  if (type !== "application/x-www-form-urlencoded") {
    throw new PilotHttpError(415, "unsupported_content_type", "Submit the form from Porter.");
  }
  const form = new URLSearchParams(await readPilotBody(req));
  for (const key of new Set(form.keys())) {
    if (form.getAll(key).length !== 1) throw new PilotHttpError(400, "duplicate_field", "Submit each form field once.");
  }
  return form;
}

export async function readPilotBody(req: IncomingMessage): Promise<string> {
  const declared = req.headers["content-length"];
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > 16_384)) {
    throw new PilotHttpError(413, "form_too_large", "That form is too large.");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  const timer = setTimeout(() => req.destroy(), 10_000);
  timer.unref();
  try {
    for await (const raw of req) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      size += chunk.length;
      if (size > 16_384) throw new PilotHttpError(413, "form_too_large", "That form is too large.");
      chunks.push(chunk);
    }
  } finally {
    clearTimeout(timer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}
