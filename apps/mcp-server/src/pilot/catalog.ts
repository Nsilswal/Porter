import { isPresentAtLocation, mapServiceVariation, type SquareCatalogObject } from "@porter/adapter-square-appointments";
import type { MerchantCredentials, PilotBusiness, PilotSession, PilotStore, SquareEnvironment } from "@porter/db";
import { createFetchHttpClient, sanitize, type HttpClient, type HttpRequest } from "@porter/shared";
import type { MerchantConnections } from "./connections.js";
import { PilotHttpError } from "./security.js";

export interface OwnerCatalogLocation {
  readonly id: string;
  readonly name: string;
  readonly address: string;
  readonly country: string | null;
  readonly currency: string | null;
  readonly timezone: string | null;
  readonly supported: boolean;
  readonly blockingReasons: readonly string[];
}
export interface OwnerCatalogStaff { readonly id: string; readonly name: string }
export interface OwnerCatalogService {
  /** Raw Square variation ID, matching profile.enabledServiceIds. */
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly durationMinutes: number | null;
  readonly priceMinor: number | null;
  readonly currency: string | null;
  readonly staffIds: readonly string[];
  readonly supported: boolean;
  readonly blockingReasons: readonly string[];
}
export interface OwnerCatalogPolicy {
  readonly known: boolean;
  readonly text: string | null;
  readonly cancellationWindowSeconds: number | null;
  readonly cancellationFeeMinor: number | null;
  readonly cancellationFeeCurrency: string | null;
  readonly customerCancellationAllowed: boolean;
  /** Square's booking profile does not expose all deposit/card/prepayment settings. */
  readonly paymentRequirements: "owner_attestation_required";
  readonly requiresAttestation: true;
  readonly blockingReasons: readonly string[];
}
export interface OwnerCatalogReview {
  readonly businessId: string;
  readonly merchantId: string;
  readonly connectionVersion: number;
  readonly fetchedAt: string;
  readonly selectedLocationId: string | null;
  readonly locations: readonly OwnerCatalogLocation[];
  readonly staff: readonly OwnerCatalogStaff[];
  readonly services: readonly OwnerCatalogService[];
  readonly policy: OwnerCatalogPolicy;
  readonly blockingReasons: readonly string[];
}
export interface ActivationSelection {
  readonly selectedLocationId: string;
  readonly enabledServiceIds: readonly string[];
  readonly policyReviewed: boolean;
  readonly noPaymentObligations: boolean;
}
export interface OwnerSquareCatalogOptions {
  readonly store: PilotStore;
  readonly connections: Pick<MerchantConnections, "credentials">;
  readonly environment: SquareEnvironment;
  readonly http?: HttpClient;
  readonly now?: () => Date;
}

type ObjectValue = Record<string, unknown>;
const RAW_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_PAGES = 20;
const MAX_RECORDS = 5_000;
const API_VERSION = "2025-01-23";

/** Fresh Square reads for an authenticated owner's review; never writes business state. */
export class OwnerSquareCatalog {
  readonly #store: PilotStore;
  readonly #connections: Pick<MerchantConnections, "credentials">;
  readonly #environment: SquareEnvironment;
  readonly #http: HttpClient;
  readonly #now: () => Date;
  readonly #baseUrl: string;

  constructor(options: OwnerSquareCatalogOptions) {
    this.#store = options.store;
    this.#connections = options.connections;
    this.#environment = options.environment;
    this.#now = options.now ?? (() => new Date());
    this.#baseUrl = options.environment === "sandbox" ? "https://connect.squareupsandbox.com" : "https://connect.squareup.com";
    this.#http = options.http ?? createFetchHttpClient({ maxRetries: 0, timeoutMs: 12_000,
      fetchImpl: (input, init) => fetch(input, { ...init, redirect: "error" }) });
  }

  async review(session: PilotSession, businessId: string, locationId?: string, signal?: AbortSignal): Promise<OwnerCatalogReview> {
    const business = await this.#authorize(session, businessId);
    const selectedId = locationId ?? business.selectedLocationId;
    if (selectedId && !RAW_ID.test(selectedId)) throw invalidSelection();
    if (business.selectedLocationId && selectedId !== business.selectedLocationId) throw locationChanged();
    const deadline = AbortSignal.timeout(20_000);
    const boundedSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    let credentials: MerchantCredentials;
    try {
      credentials = await this.#connections.credentials(businessId, boundedSignal);
    } catch {
      throw connectionUnavailable();
    }
    if (credentials.businessId !== businessId || credentials.environment !== this.#environment || credentials.status !== "connected" ||
      !credentials.accessToken || credentials.expiresAt <= this.#now()) throw connectionUnavailable();
    const read = (method: HttpRequest["method"], path: string, body?: unknown) => this.#read(credentials, boundedSignal, method, path, body);
    const [locationResponse, profileResponse, locationProfiles] = await Promise.all([
      read("GET", "/v2/locations"),
      read("GET", "/v2/bookings/business-booking-profile"),
      this.#pages(read, "/v2/bookings/location-booking-profiles", "location_booking_profiles"),
    ]);
    const profile = object(profileResponse.business_booking_profile);
    if (!profile || profile.seller_id !== credentials.merchantId) throw catalogUnavailable();
    const locations = array(locationResponse.locations).map((location) => locationView(location, locationProfiles));
    if (new Set(locations.map((entry) => entry.id)).size !== locations.length) throw catalogUnavailable();
    const selectedLocation = selectedId ? locations.find((entry) => entry.id === selectedId) : undefined;
    if (selectedId && !selectedLocation) throw invalidSelection();
    const policy = policyView(profile);
    let staff: OwnerCatalogStaff[] = [];
    let services: OwnerCatalogService[] = [];
    if (selectedLocation) {
      const [team, objects] = await Promise.all([
        this.#pages(read, `/v2/bookings/team-member-booking-profiles?bookable_only=true&location_id=${encodeURIComponent(selectedLocation.id)}`, "team_member_booking_profiles"),
        this.#pages(read, "/v2/catalog/search", "objects", { object_types: ["ITEM", "CATEGORY"], include_related_objects: true }),
      ]);
      staff = team.filter((member) => member.is_bookable === true && typeof member.team_member_id === "string" && RAW_ID.test(member.team_member_id))
        .map((member) => ({ id: member.team_member_id as string, name: display(member.display_name, "Team member", 160) }));
      staff = [...new Map(staff.map((member) => [member.id, member])).values()];
      try { services = serviceViews(objects, selectedLocation.id, staff); } catch { throw catalogUnavailable(); }
    }
    const blockingReasons = [...policy.blockingReasons, ...(selectedLocation?.blockingReasons ?? [])];
    if (selectedLocation && !services.some((service) => service.supported)) blockingReasons.push("Square needs at least one fixed-price USD service with a bookable team member at this location.");
    // Never return an apparently current review after logout, disconnect or a
    // concurrent location selection. The caller must also fence the saved activation.
    const freshBusiness = await this.#authorize(session, businessId);
    const latest = await this.#store.connections.get(session.userId, businessId, this.#environment);
    if (!latest || latest.status !== "connected" || latest.version !== credentials.version || latest.merchantId !== credentials.merchantId || latest.expiresAt <= this.#now()) throw connectionUnavailable();
    if (freshBusiness.selectedLocationId && freshBusiness.selectedLocationId !== selectedId) throw locationChanged();
    return { businessId, merchantId: credentials.merchantId, connectionVersion: credentials.version,
      fetchedAt: this.#now().toISOString(), selectedLocationId: selectedId ?? null, locations, staff, services, policy, blockingReasons };
  }

  async validateActivation(session: PilotSession, businessId: string, selection: ActivationSelection, signal?: AbortSignal): Promise<OwnerCatalogReview> {
    if (!selection || !RAW_ID.test(selection.selectedLocationId) || !Array.isArray(selection.enabledServiceIds) ||
      selection.enabledServiceIds.length < 1 || selection.enabledServiceIds.length > 500 ||
      selection.enabledServiceIds.some((id) => typeof id !== "string" || !RAW_ID.test(id)) ||
      new Set(selection.enabledServiceIds).size !== selection.enabledServiceIds.length) throw invalidSelection();
    const review = await this.review(session, businessId, selection.selectedLocationId, signal);
    if (review.blockingReasons.length) throw new PilotHttpError(409, "square_activation_blocked", review.blockingReasons[0]!);
    const supported = new Set(review.services.filter((service) => service.supported).map((service) => service.id));
    if (selection.enabledServiceIds.some((id) => !supported.has(id))) throw new PilotHttpError(409, "square_service_unavailable", "A selected service is unavailable or unsupported. Review the current Square service list.");
    if (selection.policyReviewed !== true || selection.noPaymentObligations !== true) {
      throw new PilotHttpError(400, "policy_attestation_required", "Review the policy and confirm these services require no deposit, prepayment, card on file, cancellation fee or no-show fee.");
    }
    return review;
  }

  async #authorize(session: PilotSession, businessId: string): Promise<PilotBusiness> {
    const current = await this.#store.sessions.lookup(session.sessionHash, this.#now());
    if (!current || current.userId !== session.userId) throw new PilotHttpError(401, "sign_in_required", "Sign in to Porter to continue.");
    const business = await this.#store.businesses.get(session.userId, businessId);
    if (!business) throw new PilotHttpError(404, "business_not_found", "That business could not be found.");
    return business;
  }

  async #read(credentials: MerchantCredentials, signal: AbortSignal, method: HttpRequest["method"], path: string, body?: unknown): Promise<ObjectValue> {
    if (signal.aborted) throw catalogUnavailable();
    try {
      const response = await this.#http.send({ method, url: `${this.#baseUrl}${path}`, headers: {
        authorization: `Bearer ${credentials.accessToken}`, "square-version": API_VERSION,
      }, ...(body === undefined ? {} : { body }), signal });
      const payload = object(response.body);
      if (response.status < 200 || response.status >= 300 || !payload || signal.aborted ||
        (payload.errors !== undefined && (!Array.isArray(payload.errors) || payload.errors.length > 0))) throw catalogUnavailable();
      return payload;
    } catch {
      // Transport/provider errors can contain Authorization headers or raw HTML.
      throw catalogUnavailable();
    }
  }

  async #pages(read: (method: HttpRequest["method"], path: string, body?: unknown) => Promise<ObjectValue>, path: string, key: string, body?: ObjectValue): Promise<ObjectValue[]> {
    const values: ObjectValue[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const url = new URL(path, this.#baseUrl);
      if (body === undefined) {
        url.searchParams.set("limit", "100");
        if (cursor) url.searchParams.set("cursor", cursor);
      }
      const payload = await read(body ? "POST" : "GET", `${url.pathname}${url.search}`, body ? { ...body, ...(cursor ? { cursor } : {}) } : undefined);
      values.push(...array(payload[key]), ...(body ? array(payload.related_objects) : []));
      if (values.length > MAX_RECORDS) throw catalogUnavailable();
      if (payload.cursor === undefined || payload.cursor === "") return values;
      if (typeof payload.cursor !== "string" || payload.cursor.length > 65_536 || seen.has(payload.cursor)) throw catalogUnavailable();
      cursor = payload.cursor;
      seen.add(cursor);
    }
    throw catalogUnavailable();
  }
}

function object(value: unknown): ObjectValue | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : null;
}
function array(value: unknown): ObjectValue[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_RECORDS || value.some((entry) => !object(entry))) throw catalogUnavailable();
  return value as ObjectValue[];
}
function display(value: unknown, fallback: string, maxLength = 300): string {
  return typeof value === "string" ? sanitize(value, { maxLength }) : fallback;
}
function locationView(location: ObjectValue, bookingProfiles: ObjectValue[]): OwnerCatalogLocation {
  if (typeof location.id !== "string" || !RAW_ID.test(location.id)) throw catalogUnavailable();
  const address = object(location.address) ?? {};
  const country = typeof address.country === "string" ? address.country : null;
  const currency = typeof location.currency === "string" ? location.currency : null;
  const timezone = typeof location.timezone === "string" ? location.timezone : null;
  const blockingReasons: string[] = [];
  if (location.status !== "ACTIVE") blockingReasons.push("This Square location is inactive.");
  if (country !== "US" || currency !== "USD") blockingReasons.push("The pilot supports US locations using USD only.");
  try { if (!timezone) throw new Error(); new Intl.DateTimeFormat("en-US", { timeZone: timezone }); } catch { blockingReasons.push("Set a valid time zone for this location in Square."); }
  if (!bookingProfiles.some((profile) => profile.location_id === location.id && profile.online_booking_enabled === true)) blockingReasons.push("Enable online booking for this location in Square.");
  return { id: location.id, name: display(location.name ?? location.business_name, "Location", 160),
    address: [address.address_line_1, address.address_line_2, address.locality, address.administrative_district_level_1, address.postal_code]
      .filter((value): value is string => typeof value === "string").map((value) => display(value, "", 160)).join(", "),
    country, currency, timezone, supported: blockingReasons.length === 0, blockingReasons };
}
function policyView(profile: ObjectValue): OwnerCatalogPolicy {
  const settings = object(profile.business_appointment_settings);
  const fee = object(settings?.cancellation_fee_money);
  const feeMinor = typeof fee?.amount === "number" && Number.isSafeInteger(fee.amount) && fee.amount >= 0 ? fee.amount : null;
  const window = typeof settings?.cancellation_window_seconds === "number" && Number.isSafeInteger(settings.cancellation_window_seconds) && settings.cancellation_window_seconds >= 0
    ? settings.cancellation_window_seconds : null;
  const text = typeof settings?.cancellation_policy_text === "string" ? display(settings.cancellation_policy_text, "", 65_536) : null;
  const blockingReasons: string[] = [];
  if (profile.booking_enabled !== true || !settings) blockingReasons.push("Enable Square Appointments online booking before activating Porter.");
  if (profile.allow_user_cancel !== true) blockingReasons.push("Enable customer cancellation in Square before activating this pilot.");
  if (settings?.location_types !== undefined && (!Array.isArray(settings.location_types) || !settings.location_types.includes("BUSINESS_LOCATION"))) {
    blockingReasons.push("This pilot supports appointments at the salon or spa. Enable business-location appointments in Square.");
  }
  if (feeMinor !== null && feeMinor > 0) blockingReasons.push("This Square account has a cancellation or no-show fee. Fee-based bookings are outside this pilot.");
  if (fee?.amount !== undefined && feeMinor === null) blockingReasons.push("Square returned an invalid cancellation fee. Review the account's booking settings.");
  if (text && mentionsRequiredPayment(text)) blockingReasons.push("The Square policy describes a payment or card requirement. Resolve that requirement before activating this pilot.");
  return { known: window !== null || feeMinor !== null, text, cancellationWindowSeconds: window, cancellationFeeMinor: feeMinor,
    cancellationFeeCurrency: typeof fee?.currency === "string" ? fee.currency : null,
    customerCancellationAllowed: profile.allow_user_cancel === true, paymentRequirements: "owner_attestation_required",
    requiresAttestation: true, blockingReasons };
}

/** Prose screening catches explicit obligations; owner attestation covers unavailable structured settings. */
function mentionsRequiredPayment(text: string): boolean {
  const obligation = "(?:deposits?|pre-?pay(?:ments?)?|cards?[ -]on[ -]file|credit cards?|cancellation fees?|no[ -]show fees?)";
  const auxiliary = "(?:\\s+(?:is|are|will|would|be))*";
  const action = "(?:required|needed|charged|collected)";
  const value = text
    .replace(new RegExp(`\\bno\\s+${obligation}\\b${auxiliary}\\s+${action}\\b`, "gi"), "")
    .replace(new RegExp(`\\b${obligation}\\b${auxiliary}\\s+(?:not|never)\\s+(?:be\\s+)?${action}\\b`, "gi"), "");
  return new RegExp(`(?:${obligation})[^.!?\\n]{0,80}\\b(?:required|mandatory|charged|collected|non-refundable)\\b|\\b(?:require[ds]?|collect|charge|mandatory)\\b[^.!?\\n]{0,80}(?:${obligation})`, "i").test(value);
}

function serviceViews(objects: ObjectValue[], locationId: string, staff: OwnerCatalogStaff[]): OwnerCatalogService[] {
  const services = new Map<string, OwnerCatalogService>();
  const categories = new Map(objects.filter((entry) => entry.type === "CATEGORY").map((entry) => [entry.id, object(entry.category_data)?.name]));
  for (const rawItem of objects) {
    if (rawItem.type !== "ITEM") continue;
    const data = object(rawItem.item_data);
    if (data?.product_type !== "APPOINTMENTS_SERVICE") continue;
    const item = rawItem as unknown as SquareCatalogObject;
    if (!isPresentAtLocation(item, locationId)) continue;
    for (const rawVariation of array(data.variations)) {
      if (typeof rawVariation.id !== "string" || !RAW_ID.test(rawVariation.id)) throw catalogUnavailable();
      const variation = rawVariation as unknown as SquareCatalogObject;
      if (!isPresentAtLocation(variation, locationId)) continue;
      const variationData = object(rawVariation.item_variation_data);
      let mapped: ReturnType<typeof mapServiceVariation> = null;
      try {
        const category = item.item_data?.categories?.[0]?.id;
        mapped = mapServiceVariation("square", locationId, item, variation, typeof categories.get(category) === "string" ? categories.get(category) as string : undefined);
      } catch { /* A malformed service stays unavailable instead of gaining invented defaults. */ }
      if (mapped && (!Array.isArray(mapped.teamMemberIds) || mapped.teamMemberIds.some((id) => typeof id !== "string" || !RAW_ID.test(id)))) mapped = null;
      // Missing assignment data is not proof that every bookable employee can
      // perform this service. Require an explicit, current staff intersection.
      const matchingStaff = mapped ? staff.filter((member) => mapped.teamMemberIds.includes(member.id)).map((member) => member.id) : [];
      const blockingReasons: string[] = [];
      if (!mapped) blockingReasons.push("This variation is unavailable for booking or has an incomplete duration/version.");
      if (mapped && (mapped.service.quoteRequired || mapped.service.price?.currency !== "USD" || !Number.isSafeInteger(mapped.service.price.amount) || mapped.service.price.amount < 0)) blockingReasons.push("Set a fixed USD price for this service in Square.");
      const noShowFee = object(variationData?.no_show_fee);
      if (variationData?.no_show_fee !== undefined && (!noShowFee || (noShowFee.amount !== undefined &&
        (typeof noShowFee.amount !== "number" || !Number.isSafeInteger(noShowFee.amount) || noShowFee.amount < 0)))) {
        blockingReasons.push("Square returned an invalid no-show fee for this service. Review its payment settings.");
      } else if (typeof noShowFee?.amount === "number" && noShowFee.amount > 0) {
        blockingReasons.push("This service has a no-show fee and cannot be booked through this pilot.");
      }
      if (!matchingStaff.length) blockingReasons.push("Assign a bookable team member at this location.");
      services.set(rawVariation.id, { id: rawVariation.id,
        name: mapped ? display(mapped.service.name, "Service", 200) : display(`${display(data.name, "Service", 160)} — ${display(variationData?.name, "Variation", 160)}`, "Service", 200),
        description: typeof data.description === "string" ? display(data.description, "", 1_000) : null,
        durationMinutes: mapped?.service.durationMinutes ?? null, priceMinor: mapped?.service.price?.amount ?? null,
        currency: mapped?.service.price?.currency ?? null, staffIds: matchingStaff, supported: blockingReasons.length === 0, blockingReasons });
      if (services.size > 500) throw catalogUnavailable();
    }
  }
  return [...services.values()];
}
function catalogUnavailable(): PilotHttpError { return new PilotHttpError(502, "square_catalog_unavailable", "Square's booking details could not be loaded completely. Try again shortly."); }
function connectionUnavailable(): PilotHttpError { return new PilotHttpError(409, "square_connection_unavailable", "Reconnect Square before reviewing or activating this business."); }
function invalidSelection(): PilotHttpError { return new PilotHttpError(400, "square_selection_invalid", "Choose a current Square location and at least one supported service."); }
function locationChanged(): PilotHttpError { return new PilotHttpError(409, "square_location_changed", "This business already uses a different Square location."); }
