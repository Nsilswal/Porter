import {
  bigserial,
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { AuditRecord, BookingStatus, IdempotencyOperation, IdempotencyState, PaymentRecord } from "@porter/core";
import type { BusinessStatus, ConnectionStatus, SquareEnvironment } from "./pilot-types.js";

/**
 * Postgres schema (Railway Postgres, via Drizzle).
 *
 * Persistent booking data and the security metadata needed to protect it.
 *
 *  - `auditLog` stores an argument HASH and a list of disclosed field NAMES.
 *    Actor identifiers remain pseudonymous data subject to retention policy.
 *
 *  - `idempotencyKeys.responseCipher` is encrypted under a per-user key held
 *    in `userKeys`. Deleting that key renders every stored response
 *    inaccessible, which is the "delete or render inaccessible" wording of
 *    4.3(f) without having to rewrite history.
 */

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

/** Per-user data encryption keys. Destroying a row is the delete mechanism. */
export const userKeys = pgTable("user_keys", {
  userId: text("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  key: text("key").notNull(), // AES-256-GCM envelope, wrapped by the deployment encryption key
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Adapter credentials, encrypted at rest, decrypted only into AdapterContext. */
export const linkedAccounts = pgTable(
  "linked_accounts",
  {
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    adapterId: text("adapter_id").notNull(),
    credentialCipher: text("credential_cipher").notNull(),
    scopes: jsonb("scopes").$type<string[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => ({ pk: primaryKey({ columns: [t.userId, t.adapterId] }) }),
);

export const bookings = pgTable(
  "bookings",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    adapterId: text("adapter_id").notNull(),
    providerBookingRef: text("provider_booking_ref").notNull(),
    status: text("status").$type<BookingStatus>().notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    providerId: text("provider_id").notNull(),
    locationId: text("location_id").notNull(),
    serviceId: text("service_id").notNull(),
    // Already sanitised display copy, cached so list_my_bookings stays cheap.
    providerName: text("provider_name").notNull(),
    serviceName: text("service_name").notNull(),
    priceMinor: integer("price_minor"),
    currency: text("currency"),
    depositMinor: integer("deposit_minor"),
    /** Collected so far, in minor units. Drives what pay_or_deposit charges. */
    paidMinor: integer("paid_minor").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byUser: index("bookings_user_starts_idx").on(t.userId, t.startsAt),
    byRef: uniqueIndex("bookings_adapter_ref_idx").on(t.adapterId, t.providerBookingRef),
    byOwnerId: uniqueIndex("bookings_user_id_idx").on(t.userId, t.id),
  }),
);

export const payments = pgTable(
  "payments",
  {
    id: text("id").primaryKey(),
    bookingId: text("booking_id").notNull(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    amountMinor: integer("amount_minor").notNull(),
    currency: text("currency").notNull(),
    kind: text("kind").$type<PaymentRecord["kind"]>().notNull(),
    status: text("status").$type<PaymentRecord["status"]>().notNull(),
    gatewayId: text("gateway_id").notNull(),
    /** The gateway's own id, e.g. a Stripe PaymentIntent. Not card data. */
    gatewayPaymentRef: text("gateway_payment_ref").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byBooking: index("payments_booking_idx").on(t.userId, t.bookingId),
    bookingOwner: foreignKey({ columns: [t.userId, t.bookingId], foreignColumns: [bookings.userId, bookings.id] }).onDelete("cascade"),
  }),
);

/**
 * The user's saved payment details.
 *
 * References only. Porter never stores a card number, and never enters one:
 * the user saves a method with the gateway directly and Porter keeps the
 * opaque ids. Deleted with the user under Connector Terms 4.3(f).
 */
export const paymentProfiles = pgTable("payment_profiles", {
  userId: text("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  customerRef: text("customer_ref").notNull(),
  paymentMethodRef: text("payment_method_ref").notNull(),
  /** Display only, e.g. "Visa ending 4242". */
  label: text("label").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Where each business's money goes, once it is onboarded to Connect. */
export const payoutAccounts = pgTable(
  "payout_accounts",
  {
    adapterId: text("adapter_id").notNull(),
    providerId: text("provider_id").notNull(),
    accountRef: text("account_ref").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.adapterId, t.providerId] }) }),
);

export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    userId: text("user_id").notNull(),
    tool: text("tool").notNull(),
    key: text("key").notNull(),
    /** Hash only. The request payload itself is never stored. */
    argsHash: text("args_hash").notNull(),
    state: text("state").$type<IdempotencyState>().notNull(),
    responseCipher: text("response_cipher"),
    operation: jsonb("operation").$type<IdempotencyOperation>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.tool, t.key] }),
    byExpiry: index("idempotency_expires_idx").on(t.expiresAt),
  }),
);

/** Spent confirmation tokens. A row means "already used". */
export const confirmationTokens = pgTable(
  "confirmation_tokens",
  {
    jti: text("jti").primaryKey(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => ({ byExpiry: index("confirmation_expires_idx").on(t.expiresAt) }),
);

/**
 * Append-only audit log. Contains pseudonymous identifiers, never customer field values.
 */
export const auditLog = pgTable(
  "audit_log",
  {
    seq: bigserial("seq", { mode: "number" }).primaryKey(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    actorId: text("actor_id").notNull(),
    tool: text("tool").notNull(),
    action: text("action").notNull(),
    adapterId: text("adapter_id"),
    providerId: text("provider_id"),
    argsHash: text("args_hash").notNull(),
    idempotencyKey: text("idempotency_key"),
    confirmationJti: text("confirmation_jti"),
    outcome: text("outcome").$type<AuditRecord["outcome"]>().notNull(),
    errorCode: text("error_code"),
    latencyMs: integer("latency_ms").notNull(),
    /** Customer field NAMES disclosed downstream. Never values. */
    disclosedFields: jsonb("disclosed_fields").$type<AuditRecord["disclosedFields"]>().notNull().default([]),
    immutable: boolean("immutable").notNull().default(true),
  },
  (t) => ({ byActor: index("audit_actor_at_idx").on(t.actorId, t.at) }),
);

export const providersCache = pgTable(
  "providers_cache",
  {
    adapterId: text("adapter_id").notNull(),
    providerId: text("provider_id").notNull(),
    payload: jsonb("payload").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.adapterId, t.providerId] }) }),
);

/** Contains an encrypted canary so a wrong deployment key fails at startup. */
export const storeMetadata = pgTable("store_metadata", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

/** Durable ownership of a booking mutation; uncertain writes retain the guard. */
export const bookingMutations = pgTable(
  "booking_mutations",
  {
    userId: text("user_id").notNull(),
    bookingId: text("booking_id").notNull(),
    tool: text("tool").notNull(),
    key: text("key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.bookingId] }),
    bookingOwner: foreignKey({ columns: [t.userId, t.bookingId], foreignColumns: [bookings.userId, bookings.id] }).onDelete("cascade"),
  }),
);

/** Email identities share the existing customer/booking user namespace. */
export const emailIdentities = pgTable("email_identities", {
  userId: text("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ byEmail: uniqueIndex("email_identities_email_idx").on(t.email) }));

export const emailLoginTokens = pgTable("email_login_tokens", {
  tokenHash: text("token_hash").primaryKey(),
  browserNonceHash: text("browser_nonce_hash").notNull(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ byExpiry: index("email_login_tokens_expiry_idx").on(t.expiresAt) }));

export const pilotSessions = pgTable("pilot_sessions", {
  sessionHash: text("session_hash").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ byUser: uniqueIndex("pilot_sessions_user_hash_idx").on(t.userId, t.sessionHash), byExpiry: index("pilot_sessions_expiry_idx").on(t.expiresAt) }));

export const connectorCredentials = pgTable("connector_credentials", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  label: text("label").notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ byToken: uniqueIndex("connector_credentials_token_idx").on(t.tokenHash), byUser: index("connector_credentials_user_idx").on(t.userId) }));

export const pilotBusinesses = pgTable("pilot_businesses", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  websiteUrl: text("website_url").notNull(),
  name: text("name").notNull(),
  status: text("status").$type<BusinessStatus>().notNull().default("draft"),
  selectedLocationId: text("selected_location_id"),
  profile: jsonb("profile").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ byOwner: uniqueIndex("pilot_businesses_owner_id_idx").on(t.ownerId, t.id) }));

export const squareOAuthStates = pgTable("square_oauth_states", {
  stateHash: text("state_hash").primaryKey(),
  userId: text("user_id").notNull(),
  sessionHash: text("session_hash").notNull(),
  businessId: text("business_id").notNull(),
  environment: text("environment").$type<SquareEnvironment>().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  connectionVersion: integer("connection_version"),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  owner: foreignKey({ columns: [t.userId, t.businessId], foreignColumns: [pilotBusinesses.ownerId, pilotBusinesses.id] }).onDelete("cascade"),
  session: foreignKey({ columns: [t.userId, t.sessionHash], foreignColumns: [pilotSessions.userId, pilotSessions.sessionHash] }).onDelete("cascade"),
  byExpiry: index("square_oauth_states_expiry_idx").on(t.expiresAt),
}));

export const merchantConnections = pgTable("merchant_connections", {
  businessId: text("business_id").notNull().references(() => pilotBusinesses.id, { onDelete: "cascade" }),
  environment: text("environment").$type<SquareEnvironment>().notNull(),
  merchantId: text("merchant_id").notNull(),
  status: text("status").$type<ConnectionStatus>().notNull().default("connected"),
  version: integer("version").notNull().default(1),
  credentialCipher: text("credential_cipher"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  scopes: jsonb("scopes").$type<string[]>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  refreshedAt: timestamp("refreshed_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ pk: primaryKey({ columns: [t.businessId, t.environment] }), byMerchant: uniqueIndex("merchant_connections_environment_merchant_idx").on(t.environment, t.merchantId) }));

/** Hashed limiter namespaces only; no raw email/IP/user-agent values. */
export const pilotRateLimits = pgTable("pilot_rate_limits", {
  keyHash: text("key_hash").notNull(),
  windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
  count: integer("count").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (t) => ({ pk: primaryKey({ columns: [t.keyHash, t.windowStart] }), byExpiry: index("pilot_rate_limits_expiry_idx").on(t.expiresAt) }));

/** Public website snapshots are browser-bound until a verified owner claims them. */
export const importDrafts = pgTable("import_drafts", {
  tokenHash: text("token_hash").primaryKey(),
  browserNonceHash: text("browser_nonce_hash").notNull(),
  sourceUrl: text("source_url").notNull(),
  preview: jsonb("preview").$type<Record<string, unknown>>().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  claimedOwnerId: text("claimed_owner_id"),
  claimedBusinessId: text("claimed_business_id"),
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  owner: foreignKey({ columns: [t.claimedOwnerId, t.claimedBusinessId], foreignColumns: [pilotBusinesses.ownerId, pilotBusinesses.id] }).onDelete("cascade"),
  byExpiry: index("import_drafts_expiry_idx").on(t.expiresAt),
}));
