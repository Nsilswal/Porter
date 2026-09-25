/**
 * Square API wire types.
 *
 * Field names and endpoint paths are taken from Square's published reference,
 * not inferred. The endpoints Porter uses:
 *
 *   GET  /v2/locations
 *   POST /v2/catalog/search                      service variations
 *   GET  /v2/bookings/business-booking-profile   cancellation policy
 *   GET  /v2/bookings/team-member-booking-profiles
 *   POST /v2/bookings/availability/search
 *   POST /v2/bookings                            takes idempotency_key
 *   GET  /v2/bookings/{id}
 *   PUT  /v2/bookings/{id}                       reschedule
 *   POST /v2/bookings/{id}/cancel
 *   POST /v2/customers/search
 *   POST /v2/customers
 *
 * Scopes: APPOINTMENTS_READ / APPOINTMENTS_WRITE at buyer level, plus
 * APPOINTMENTS_ALL_READ / APPOINTMENTS_ALL_WRITE for seller-level calls.
 * Also APPOINTMENTS_BUSINESS_SETTINGS_READ for booking profiles, ITEMS_READ
 * for the catalog, MERCHANT_PROFILE_READ for locations, and CUSTOMERS_READ /
 * CUSTOMERS_WRITE to attach a customer. See docs/square-integration-contract.md
 * for the pilot's buyer-level OAuth contract; token issuance is outside this adapter.
 */

export interface SquareMoney {
  readonly amount?: number; // minor units
  readonly currency?: string;
}

export interface SquareError {
  readonly category: string;
  readonly code: string;
  readonly detail?: string;
  readonly field?: string;
}

export interface SquareLocation {
  readonly id: string;
  readonly name?: string;
  readonly address?: {
    readonly address_line_1?: string;
    readonly address_line_2?: string;
    readonly locality?: string; // city
    readonly administrative_district_level_1?: string; // region
    readonly postal_code?: string;
    readonly country?: string;
  };
  readonly timezone?: string;
  readonly coordinates?: { readonly latitude?: number; readonly longitude?: number };
  readonly business_name?: string;
  readonly description?: string;
  readonly status?: "ACTIVE" | "INACTIVE";
}

export interface SquareCatalogObject {
  readonly type: string;
  readonly id: string;
  readonly version?: number;
  readonly is_deleted?: boolean;
  readonly present_at_all_locations?: boolean;
  readonly present_at_location_ids?: readonly string[];
  readonly absent_at_location_ids?: readonly string[];
  readonly item_data?: {
    readonly name?: string;
    readonly description?: string;
    readonly product_type?: string; // "APPOINTMENTS_SERVICE"
    readonly is_archived?: boolean;
    readonly categories?: readonly { readonly id?: string }[];
    readonly variations?: readonly SquareCatalogObject[];
  };
  readonly item_variation_data?: {
    readonly item_id?: string;
    readonly name?: string;
    readonly price_money?: SquareMoney;
    readonly pricing_type?: "FIXED_PRICING" | "VARIABLE_PRICING";
    readonly service_duration?: number; // milliseconds
    readonly available_for_booking?: boolean;
    readonly team_member_ids?: readonly string[];
    readonly location_overrides?: readonly {
      readonly location_id: string;
      readonly price_money?: SquareMoney;
      readonly pricing_type?: "FIXED_PRICING" | "VARIABLE_PRICING";
    }[];
  };
  readonly category_data?: { readonly name?: string };
}

export interface SquareAvailability {
  readonly start_at: string;
  readonly location_id: string;
  readonly appointment_segments?: readonly {
    readonly duration_minutes?: number;
    readonly service_variation_id?: string;
    readonly service_variation_version?: number;
    readonly team_member_id?: string;
  }[];
}

export type SquareBookingStatus =
  | "PENDING"
  | "CANCELLED_BY_CUSTOMER"
  | "CANCELLED_BY_SELLER"
  | "DECLINED"
  | "ACCEPTED"
  | "NO_SHOW";

export interface SquareBooking {
  readonly id: string;
  readonly version?: number;
  readonly status?: SquareBookingStatus;
  readonly created_at?: string;
  readonly updated_at?: string;
  readonly start_at?: string;
  readonly location_id?: string;
  readonly customer_id?: string;
  readonly customer_note?: string;
  readonly seller_note?: string;
  readonly appointment_segments?: readonly {
    readonly duration_minutes?: number;
    readonly service_variation_id?: string;
    readonly service_variation_version?: number;
    readonly team_member_id?: string;
  }[];
}

export interface SquareBusinessBookingProfile {
  readonly seller_id?: string;
  readonly booking_enabled?: boolean;
  readonly booking_policy?: string;
  readonly support_seller_level_writes?: boolean;
  readonly allow_user_cancel?: boolean;
  readonly business_appointment_settings?: {
    readonly cancellation_window_seconds?: number;
    readonly cancellation_fee_money?: SquareMoney;
    readonly cancellation_policy?: string; // CANCELLATION_TREATED_AS_NO_SHOW | CUSTOM_POLICY
    readonly cancellation_policy_text?: string;
    readonly min_booking_lead_time_seconds?: number;
    readonly max_booking_lead_time_seconds?: number;
    readonly alignment_time?: string;
  };
}

export interface SquareTeamMemberBookingProfile {
  readonly team_member_id: string;
  readonly display_name?: string;
  readonly is_bookable?: boolean;
}

export interface SquareCustomer {
  readonly id: string;
  readonly given_name?: string;
  readonly family_name?: string;
  readonly email_address?: string;
  readonly phone_number?: string;
}

export interface SquareEnvelope {
  readonly errors?: readonly SquareError[];
}

export interface ListLocationsResponse extends SquareEnvelope {
  readonly locations?: readonly SquareLocation[];
}
export interface SearchCatalogResponse extends SquareEnvelope {
  readonly objects?: readonly SquareCatalogObject[];
  readonly related_objects?: readonly SquareCatalogObject[];
  readonly cursor?: string;
}
export interface SearchAvailabilityResponse extends SquareEnvelope {
  readonly availabilities?: readonly SquareAvailability[];
}
export interface BookingResponse extends SquareEnvelope {
  readonly booking?: SquareBooking;
}
export interface ListBookingsResponse extends SquareEnvelope {
  readonly bookings?: readonly SquareBooking[];
  readonly cursor?: string;
}
export interface BusinessBookingProfileResponse extends SquareEnvelope {
  readonly business_booking_profile?: SquareBusinessBookingProfile;
}
export interface TeamMemberBookingProfilesResponse extends SquareEnvelope {
  readonly team_member_booking_profiles?: readonly SquareTeamMemberBookingProfile[];
}
export interface SearchCustomersResponse extends SquareEnvelope {
  readonly customers?: readonly SquareCustomer[];
}
export interface CustomerResponse extends SquareEnvelope {
  readonly customer?: SquareCustomer;
}

/** Square returns ms; Porter's domain uses minutes everywhere. */
export const serviceDurationMinutes = (ms: number | undefined): number =>
  ms && ms > 0 ? Math.round(ms / 60_000) : 60;
