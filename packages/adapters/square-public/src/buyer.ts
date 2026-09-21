import { createHash } from "node:crypto";
import type { SquareWidget, SquareWidgetBusiness, SquareWidgetService, SquareWidgetVariation } from "./widget.js";

/**
 * Square's public booking widget talks to this host, not to Connect.
 *
 * The calls were read off the booking page's own script and then exercised
 * against a real salon: availability, a hold, a buyer, a reservation, and a
 * cancel. There is no merchant token. A card, a deposit, or a no-show hold
 * still has to happen in the browser, because those need a payment nonce
 * this API does not mint.
 */
export const BUYER_API = "https://app.squareup.com/appointments/api";

export interface BuyerAvailabilitySlot {
  readonly start: number;
  readonly end: number;
  readonly available?: boolean;
  readonly staff_id?: string;
  readonly segments?: readonly { readonly employee_token?: string | null }[];
}

export interface BuyerReservedTime {
  readonly id: string;
  readonly date_start?: string;
  readonly date_end?: string;
  /** Passed back unchanged on the reservation. Square echoes the draft order it just created. */
  readonly order?: { readonly id?: string } & Record<string, unknown>;
}

/**
 * `POST /buyer/current_buyer/{unitToken}` answers with the token at the top
 * level, and has also been seen wrapping it in `current_buyer`. Accept both:
 * this is an undocumented endpoint, and a shape change here would otherwise
 * fail every booking at the first write.
 */
export interface BuyerContact {
  readonly contact_token?: string | null;
  readonly current_buyer?: { readonly contact_token?: string | null } | null;
}

export function contactTokenFrom(response: BuyerContact | undefined): string | undefined {
  return response?.contact_token ?? response?.current_buyer?.contact_token ?? undefined;
}

export interface BuyerReservation {
  readonly id: string;
  readonly status?: string;
  readonly date_start?: string;
  readonly date_end?: string;
  readonly is_cancelled?: boolean;
}

/** The location id in the page URL. Availability filters on this, not the widget's internal id. */
export function locationTokenFromUrl(url: string): string | null {
  const match = /\/location\/([^/?#]+)/.exec(url);
  return match?.[1] ?? null;
}

/**
 * True when confirming would require a card nonce we cannot produce.
 *
 * Checked on a live account: with deposits, prepayment, card-on-file and
 * no-show protection all off, `POST /buyer/reservations` confirms immediately.
 * Any one of those on means the page collects a card, and Porter hands the
 * person the link instead of submitting a half booking.
 */
export function cardRequired(business: SquareWidgetBusiness | undefined): boolean {
  if (!business) return true;
  if (business.deposits_enabled) return true;
  if (business.require_cof_when_booking) return true;
  if (business.no_show_protection_enabled) return true;
  const prepay = business.buyer_prepayment_mode;
  if (prepay && prepay !== "off") return true;
  return false;
}

/** Square's page generates a 14-character id and sends it as the reservation id. */
export function reservationIdFor(idempotencyKey: string): string {
  const digest = createHash("sha256").update(idempotencyKey).digest();
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 14; i++) out += alphabet[digest[i]! % 36];
  return out;
}

export function employeeTokensFor(
  widget: SquareWidget,
  variation: SquareWidgetVariation | SquareWidgetService,
  preferred?: string,
): string[] {
  if (preferred) return [preferred];
  const staffById = new Map((widget.staff ?? []).map((s) => [s.id, s.employee_token]));
  const ids = variation.staff_ids ?? [];
  const tokens = ids.map((id) => staffById.get(id)).filter((t): t is string => Boolean(t));
  return [...new Set(tokens)];
}

export function availabilityBody(input: {
  locationId: string;
  variationId: string;
  staffTokens: readonly string[];
  from: Date;
  to: Date;
}): unknown {
  return {
    search_availability_request: {
      query: {
        filter: {
          start_at_range: { start_at: input.from.toISOString(), end_at: input.to.toISOString() },
          location_id: input.locationId,
          segment_filters: [
            {
              service_variation_id: input.variationId,
              team_member_id_filter: { any: [...input.staffTokens] },
            },
          ],
        },
      },
    },
  };
}

export function segmentBody(input: {
  service: SquareWidgetService;
  variation: SquareWidgetVariation;
  employeeToken: string;
  lineItemUid: string;
}): Record<string, unknown> {
  const intermission = input.variation.intermissions?.[0];
  return {
    line_item_uid: input.lineItemUid,
    employee_token: input.employeeToken,
    ordinal: 0,
    resource_token: null,
    service_time_seconds: input.variation.service_time ?? input.service.time ?? 0,
    processing_time_seconds: null,
    transition_time: input.variation.transition_time ?? input.service.transition_time ?? 0,
    intermission_start_offset_seconds: intermission?.start_offset ? intermission.start_offset / 1000 : null,
    intermission_end_offset_seconds: intermission?.end_offset ? intermission.end_offset / 1000 : null,
    item_name: input.service.name ?? "Service",
    item_token: input.variation.item_token ?? input.service.item_token ?? input.service.id,
    item_version: input.variation.item_version ?? input.service.item_version ?? 0,
    item_variation_name: input.variation.name ?? input.service.name ?? "Service",
    item_variation_token: input.variation.item_variation_token ?? input.variation.id,
    item_variation_version: input.variation.item_variation_version ?? input.service.item_variation_version ?? 0,
    any_available_team_member: false,
  };
}

export function mapBuyerStatus(status: string | undefined, cancelled: boolean | undefined): "pending" | "confirmed" | "cancelled" | "no_show" {
  if (cancelled) return "cancelled";
  switch (status) {
    case "accepted":
      return "confirmed";
    case "pending":
      return "pending";
    case "cancelled_by_buyer":
    case "canceled_by_buyer":
    case "cancelled_by_seller":
    case "canceled_by_seller":
      return "cancelled";
    case "no_show":
      return "no_show";
    default:
      return "pending";
  }
}
