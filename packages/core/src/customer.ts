import { PorterError } from "@porter/shared";

/**
 * Downstream data minimisation.
 *
 * Muse Connector Terms section 4.3(e): "You may disclose User Data to another
 * recipient only where necessary to fulfill the User's request. No recipient
 * may receive broader access, purpose, or retention rights than you hold."
 *
 * So there is no blanket customer object handed to adapters. Each adapter
 * declares the fields it actually needs, and core projects the record down to
 * exactly that set before it crosses the boundary. Because the adapter method
 * signatures take the projection type rather than the full record, forwarding
 * an unneeded field is a compile error rather than a policy breach.
 */
export const CUSTOMER_FIELDS = [
  "givenName",
  "familyName",
  "email",
  "phone",
  "addressLine1",
  "addressLine2",
  "city",
  "region",
  "postalCode",
  "notes",
] as const;

export type CustomerField = (typeof CUSTOMER_FIELDS)[number];

export type CustomerDetails = Partial<Record<CustomerField, string>>;

/** What actually crossed the boundary, for the audit row. Field names only. */
export interface DisclosureRecord {
  readonly adapterId: string;
  readonly fields: readonly CustomerField[];
}

export interface ProjectionResult {
  readonly customer: CustomerDetails;
  readonly disclosure: DisclosureRecord;
}

/**
 * Narrow a customer record to the fields one adapter is allowed to receive.
 *
 * Required fields must be present and non-empty, or the call fails before any
 * provider is contacted. Optional fields pass through when present. Everything
 * else is dropped — it never leaves Porter.
 */
export function projectCustomer(
  adapterId: string,
  details: CustomerDetails,
  required: readonly CustomerField[],
  optional: readonly CustomerField[] = [],
): ProjectionResult {
  const allowed = new Set<CustomerField>([...required, ...optional]);
  const out: CustomerDetails = {};
  const disclosed: CustomerField[] = [];

  for (const field of CUSTOMER_FIELDS) {
    if (!allowed.has(field)) continue;
    const value = details[field];
    if (value === undefined) continue;
    const trimmed = value.trim();
    if (trimmed.length === 0) continue;
    out[field] = trimmed;
    disclosed.push(field);
  }

  const missing = required.filter((f) => out[f] === undefined);
  if (missing.length > 0) {
    throw new PorterError("INVALID_REQUEST", `This booking needs ${describeFields(missing)}.`, {
      details: { missingFields: missing },
    });
  }

  return { customer: out, disclosure: { adapterId, fields: disclosed } };
}

const FIELD_LABELS: Record<CustomerField, string> = {
  givenName: "a first name",
  familyName: "a last name",
  email: "an email address",
  phone: "a phone number",
  addressLine1: "a street address",
  addressLine2: "an address line 2",
  city: "a city",
  region: "a state or region",
  postalCode: "a postal code",
  notes: "notes",
};

function describeFields(fields: readonly CustomerField[]): string {
  const labels = fields.map((f) => FIELD_LABELS[f]);
  if (labels.length === 1) return labels[0] as string;
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}
