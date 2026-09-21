import { createHmac, timingSafeEqual } from "node:crypto";
import { PorterError, type Clock } from "@porter/shared";

/**
 * Signed opaque tokens.
 *
 * Slot ids and confirmation tokens are both signed payloads rather than
 * database rows, so the agent cannot forge or mutate one. A slot id carries
 * enough state to re-check the slot at booking time; a confirmation token
 * binds the exact terms that were quoted.
 */
export interface Signer {
  sign(payload: Record<string, unknown>): string;
  verify<T extends Record<string, unknown>>(token: string): T;
}

export function createSigner(secret: string): Signer {
  if (secret.length < 32) {
    throw new Error("Token signing secret must be at least 32 characters.");
  }

  const mac = (body: string): string =>
    createHmac("sha256", secret).update(body).digest("base64url");

  return {
    sign(payload) {
      const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
      return `${body}.${mac(body)}`;
    },
    verify(token) {
      const dot = token.lastIndexOf(".");
      if (dot <= 0) {
        throw new PorterError("INVALID_REQUEST", "That reference is not valid. Search again to get a fresh one.");
      }
      const body = token.slice(0, dot);
      const sig = token.slice(dot + 1);
      const expected = mac(body);
      const a = Buffer.from(sig);
      const b = Buffer.from(expected);
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        throw new PorterError("INVALID_REQUEST", "That reference is not valid. Search again to get a fresh one.");
      }
      try {
        return JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
      } catch {
        throw new PorterError("INVALID_REQUEST", "That reference is not valid. Search again to get a fresh one.");
      }
    },
  };
}

/** What a slot id decodes to. `f` is fetchedAt, used for the staleness check. */
export interface SlotTokenPayload extends Record<string, unknown> {
  readonly v: 1;
  readonly a: string; // adapterId
  readonly p: string; // providerId
  readonly l: string; // locationId
  readonly s: string; // serviceId
  readonly t: number; // startsAt epoch ms
  readonly e: number; // endsAt epoch ms
  readonly f: number; // fetchedAt epoch ms
  readonly r?: string; // provider slot ref
  readonly c?: number; // price minor units
  readonly u?: string; // currency
}

export interface ConfirmationTokenPayload extends Record<string, unknown> {
  readonly v: 1;
  readonly act: "book" | "reschedule" | "cancel" | "pay";
  readonly uid: string; // user id
  readonly jti: string; // single-use id
  readonly exp: number; // epoch ms
  /** Hash of the exact terms shown. The commit step re-derives and compares. */
  readonly terms: string;
  /** Action-specific payload needed to execute the commit. */
  readonly data: Record<string, unknown>;
}

export function decodeSlotToken(signer: Signer, token: string): SlotTokenPayload {
  const payload = signer.verify<SlotTokenPayload>(token);
  if (payload.v !== 1 || typeof payload.a !== "string") {
    throw new PorterError("INVALID_REQUEST", "That appointment time is not valid. Search again to get a fresh one.");
  }
  return payload;
}

export function decodeConfirmationToken(
  signer: Signer,
  token: string,
  clock: Clock,
): ConfirmationTokenPayload {
  const payload = signer.verify<ConfirmationTokenPayload>(token);
  if (payload.v !== 1 || typeof payload.act !== "string") {
    throw new PorterError("INVALID_REQUEST", "That confirmation is not valid. Ask for a fresh summary.");
  }
  if (payload.exp <= clock.nowMs()) {
    throw new PorterError(
      "CONFIRMATION_EXPIRED",
      "That confirmation has expired. Ask for a fresh summary and confirm again.",
    );
  }
  return payload;
}
