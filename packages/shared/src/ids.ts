import { randomUUID, randomBytes } from "node:crypto";

/** Nominal typing, so a BookingId can never be passed where a UserId belongs. */
declare const brand: unique symbol;
export type Branded<T, B extends string> = T & { readonly [brand]: B };

export type UserId = Branded<string, "UserId">;
export type ProviderId = Branded<string, "ProviderId">;
export type LocationId = Branded<string, "LocationId">;
export type ServiceId = Branded<string, "ServiceId">;
export type BookingId = Branded<string, "BookingId">;
export type QuoteId = Branded<string, "QuoteId">;
export type PaymentId = Branded<string, "PaymentId">;
export type AdapterId = Branded<string, "AdapterId">;

export const asUserId = (v: string): UserId => v as UserId;
export const asProviderId = (v: string): ProviderId => v as ProviderId;
export const asLocationId = (v: string): LocationId => v as LocationId;
export const asServiceId = (v: string): ServiceId => v as ServiceId;
export const asBookingId = (v: string): BookingId => v as BookingId;
export const asQuoteId = (v: string): QuoteId => v as QuoteId;
export const asPaymentId = (v: string): PaymentId => v as PaymentId;
export const asAdapterId = (v: string): AdapterId => v as AdapterId;

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "")}`;
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}
