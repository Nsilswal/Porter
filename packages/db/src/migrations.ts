import { createHash } from "node:crypto";
import { Pool, type PoolClient } from "pg";

// Keep applied migrations immutable. The checksum rejects accidental rewrites.
const migrations = [{
  version: 1,
  sql: `
CREATE TABLE users (id text PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz);
CREATE TABLE user_keys (user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, key text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE linked_accounts (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE, adapter_id text NOT NULL,
  credential_cipher text NOT NULL, scopes jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz, PRIMARY KEY (user_id, adapter_id)
);
CREATE TABLE bookings (
  id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  adapter_id text NOT NULL, provider_booking_ref text NOT NULL, status text NOT NULL,
  starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL, provider_id text NOT NULL,
  location_id text NOT NULL, service_id text NOT NULL, provider_name text NOT NULL, service_name text NOT NULL,
  price_minor integer, currency text, deposit_minor integer, paid_minor integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bookings_user_starts_idx ON bookings(user_id, starts_at);
CREATE UNIQUE INDEX bookings_adapter_ref_idx ON bookings(adapter_id, provider_booking_ref);
CREATE UNIQUE INDEX bookings_user_id_idx ON bookings(user_id, id);
CREATE TABLE payments (
  id text PRIMARY KEY, booking_id text NOT NULL, user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_minor integer NOT NULL, currency text NOT NULL, kind text NOT NULL, status text NOT NULL,
  gateway_id text NOT NULL, gateway_payment_ref text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (user_id, booking_id) REFERENCES bookings(user_id, id) ON DELETE CASCADE
);
CREATE INDEX payments_booking_idx ON payments(user_id, booking_id);
CREATE TABLE payment_profiles (
  user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  customer_ref text NOT NULL, payment_method_ref text NOT NULL, label text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE payout_accounts (
  adapter_id text NOT NULL, provider_id text NOT NULL, account_ref text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (adapter_id, provider_id)
);
CREATE TABLE idempotency_keys (
  user_id text NOT NULL, tool text NOT NULL, key text NOT NULL, args_hash text NOT NULL,
  state text NOT NULL CHECK (state IN ('in_flight', 'uncertain', 'completed')),
  response_cipher text, operation jsonb, created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, tool, key),
  CHECK ((state = 'completed' AND response_cipher IS NOT NULL) OR (state <> 'completed' AND response_cipher IS NULL))
);
CREATE INDEX idempotency_expires_idx ON idempotency_keys(expires_at);
CREATE TABLE confirmation_tokens (
  jti text PRIMARY KEY, consumed_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL
);
CREATE INDEX confirmation_expires_idx ON confirmation_tokens(expires_at);
CREATE TABLE audit_log (
  seq bigserial PRIMARY KEY, at timestamptz NOT NULL DEFAULT now(), actor_id text NOT NULL,
  tool text NOT NULL, action text NOT NULL, adapter_id text, provider_id text,
  args_hash text NOT NULL, idempotency_key text, confirmation_jti text, outcome text NOT NULL,
  error_code text, latency_ms integer NOT NULL, disclosed_fields jsonb NOT NULL DEFAULT '[]',
  immutable boolean NOT NULL DEFAULT true
);
CREATE INDEX audit_actor_at_idx ON audit_log(actor_id, at);
CREATE TABLE providers_cache (
  adapter_id text NOT NULL, provider_id text NOT NULL, payload jsonb NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (adapter_id, provider_id)
);
CREATE TABLE store_metadata (key text PRIMARY KEY, value text NOT NULL);
`,
}, {
  version: 2,
  sql: `
CREATE TABLE booking_mutations (
  user_id text NOT NULL, booking_id text NOT NULL, tool text NOT NULL, key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (user_id, booking_id),
  FOREIGN KEY (user_id, booking_id) REFERENCES bookings(user_id, id) ON DELETE CASCADE
);
`,
}, {
  version: 3,
  sql: `
CREATE TABLE email_identities (
  user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, email text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX email_identities_email_idx ON email_identities(email);
CREATE TABLE email_login_tokens (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  browser_nonce_hash text NOT NULL CHECK (browser_nonce_hash ~ '^[0-9a-f]{64}$'),
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at timestamptz NOT NULL,
  consumed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX email_login_tokens_expiry_idx ON email_login_tokens(expires_at);
CREATE TABLE pilot_sessions (
  session_hash text PRIMARY KEY CHECK (session_hash ~ '^[0-9a-f]{64}$'),
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at timestamptz NOT NULL,
  revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX pilot_sessions_user_hash_idx ON pilot_sessions(user_id, session_hash);
CREATE INDEX pilot_sessions_expiry_idx ON pilot_sessions(expires_at);
CREATE TABLE connector_credentials (
  id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'), label text NOT NULL,
  revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX connector_credentials_token_idx ON connector_credentials(token_hash);
CREATE INDEX connector_credentials_user_idx ON connector_credentials(user_id);
CREATE TABLE pilot_businesses (
  id text PRIMARY KEY, owner_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  website_url text NOT NULL, name text NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused')),
  selected_location_id text, profile jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX pilot_businesses_owner_id_idx ON pilot_businesses(owner_id, id);
CREATE TABLE square_oauth_states (
  state_hash text PRIMARY KEY CHECK (state_hash ~ '^[0-9a-f]{64}$'), user_id text NOT NULL,
  session_hash text NOT NULL, business_id text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('sandbox', 'production')),
  expires_at timestamptz NOT NULL, consumed_at timestamptz, connection_version integer CHECK (connection_version > 0), created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (user_id, business_id) REFERENCES pilot_businesses(owner_id, id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, session_hash) REFERENCES pilot_sessions(user_id, session_hash) ON DELETE CASCADE
);
CREATE INDEX square_oauth_states_expiry_idx ON square_oauth_states(expires_at);
CREATE TABLE merchant_connections (
  business_id text NOT NULL REFERENCES pilot_businesses(id) ON DELETE CASCADE,
  environment text NOT NULL CHECK (environment IN ('sandbox', 'production')), merchant_id text NOT NULL,
  status text NOT NULL DEFAULT 'connected' CHECK (status IN ('connected', 'reconnect_required', 'disconnecting', 'disconnected')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0), credential_cipher text,
  expires_at timestamptz NOT NULL, scopes jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), refreshed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, environment),
  CHECK ((status = 'disconnected' AND credential_cipher IS NULL) OR (status <> 'disconnected' AND credential_cipher IS NOT NULL))
);
CREATE UNIQUE INDEX merchant_connections_environment_merchant_idx ON merchant_connections(environment, merchant_id);
CREATE TABLE pilot_rate_limits (
  key_hash text NOT NULL CHECK (key_hash ~ '^[0-9a-f]{64}$'), window_start timestamptz NOT NULL,
  count integer NOT NULL CHECK (count > 0), expires_at timestamptz NOT NULL, PRIMARY KEY (key_hash, window_start)
);
CREATE INDEX pilot_rate_limits_expiry_idx ON pilot_rate_limits(expires_at);
`,
}, {
  version: 4,
  sql: `
CREATE TABLE import_drafts (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  browser_nonce_hash text NOT NULL CHECK (browser_nonce_hash ~ '^[0-9a-f]{64}$'),
  source_url text NOT NULL, preview jsonb NOT NULL CHECK (jsonb_typeof(preview) = 'object'),
  expires_at timestamptz NOT NULL, claimed_owner_id text, claimed_business_id text, claimed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (claimed_owner_id, claimed_business_id) REFERENCES pilot_businesses(owner_id, id) ON DELETE CASCADE,
  CHECK ((claimed_owner_id IS NULL AND claimed_business_id IS NULL AND claimed_at IS NULL)
    OR (claimed_owner_id IS NOT NULL AND claimed_business_id IS NOT NULL AND claimed_at IS NOT NULL))
);
CREATE INDEX import_drafts_expiry_idx ON import_drafts(expires_at);
`,
}, {
  version: 5,
  sql: `
CREATE TABLE customer_oauth_clients (
  id text PRIMARY KEY, name text NOT NULL, redirect_uris jsonb NOT NULL CHECK (jsonb_typeof(redirect_uris) = 'array'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE customer_oauth_requests (
  request_hash text PRIMARY KEY CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  browser_nonce_hash text NOT NULL CHECK (browser_nonce_hash ~ '^[0-9a-f]{64}$'),
  client_id text NOT NULL REFERENCES customer_oauth_clients(id) ON DELETE CASCADE,
  redirect_uri text NOT NULL, resource text NOT NULL,
  scopes jsonb NOT NULL CHECK (jsonb_typeof(scopes) = 'array' AND jsonb_array_length(scopes) > 0),
  code_challenge text NOT NULL CHECK (code_challenge ~ '^[A-Za-z0-9_-]{43}$'), state text,
  expires_at timestamptz NOT NULL, consumed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX customer_oauth_requests_expiry_idx ON customer_oauth_requests(expires_at);
CREATE TABLE customer_oauth_grants (
  id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id text NOT NULL REFERENCES customer_oauth_clients(id) ON DELETE CASCADE, resource text NOT NULL,
  scopes jsonb NOT NULL CHECK (jsonb_typeof(scopes) = 'array' AND jsonb_array_length(scopes) > 0),
  expires_at timestamptz NOT NULL, revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX customer_oauth_grants_user_idx ON customer_oauth_grants(user_id);
CREATE INDEX customer_oauth_grants_expiry_idx ON customer_oauth_grants(expires_at);
CREATE TABLE customer_oauth_codes (
  code_hash text PRIMARY KEY CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  request_hash text NOT NULL REFERENCES customer_oauth_requests(request_hash) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE, session_hash text NOT NULL,
  client_id text NOT NULL REFERENCES customer_oauth_clients(id) ON DELETE CASCADE,
  redirect_uri text NOT NULL, resource text NOT NULL,
  scopes jsonb NOT NULL CHECK (jsonb_typeof(scopes) = 'array' AND jsonb_array_length(scopes) > 0),
  code_challenge text NOT NULL CHECK (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  expires_at timestamptz NOT NULL, consumed_at timestamptz,
  grant_id text REFERENCES customer_oauth_grants(id) ON DELETE CASCADE, created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (user_id, session_hash) REFERENCES pilot_sessions(user_id, session_hash) ON DELETE CASCADE,
  CHECK ((consumed_at IS NULL AND grant_id IS NULL) OR (consumed_at IS NOT NULL AND grant_id IS NOT NULL))
);
CREATE UNIQUE INDEX customer_oauth_codes_request_idx ON customer_oauth_codes(request_hash);
CREATE INDEX customer_oauth_codes_expiry_idx ON customer_oauth_codes(expires_at);
CREATE TABLE customer_oauth_access_tokens (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  grant_id text NOT NULL REFERENCES customer_oauth_grants(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX customer_oauth_access_grant_idx ON customer_oauth_access_tokens(grant_id);
CREATE INDEX customer_oauth_access_expiry_idx ON customer_oauth_access_tokens(expires_at);
CREATE TABLE customer_oauth_refresh_tokens (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  grant_id text NOT NULL REFERENCES customer_oauth_grants(id) ON DELETE CASCADE,
  consumed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX customer_oauth_refresh_grant_idx ON customer_oauth_refresh_tokens(grant_id);
`,
}] as const;

function checksum(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

export async function assertMigrationsApplied(client: Pick<PoolClient, "query">): Promise<void> {
  let rows: { version: number; checksum: string }[];
  try {
    ({ rows } = await client.query<{ version: number; checksum: string }>(
      "SELECT version, checksum FROM porter_migrations ORDER BY version",
    ));
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "42P01") {
      throw new Error("Database migrations have not been applied; run the migration command before starting the server");
    }
    throw error;
  }
  if (rows.length !== migrations.length || migrations.some((migration, i) => rows[i]?.version !== migration.version || rows[i]?.checksum !== checksum(migration.sql))) {
    throw new Error("Database migrations do not match this application; run the matching migration command");
  }
}

/** Explicit release step. Never invoked implicitly by the HTTP server. */
export async function migratePostgres(connectionString: string): Promise<void> {
  const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 10_000 });
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    // Serializes concurrent deploys, including the first migration-table creation.
    await client.query("SELECT pg_advisory_xact_lock(715389251, 1)");
    await client.query(`CREATE TABLE IF NOT EXISTS porter_migrations (
      version integer PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const { rows } = await client.query<{ version: number; checksum: string }>("SELECT version, checksum FROM porter_migrations ORDER BY version");
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index]!;
      const migration = migrations[index];
      if (!migration || row.version !== migration.version || row.checksum !== checksum(migration.sql)) {
        throw new Error("Applied migration history does not match this application");
      }
    }
    for (const migration of migrations.slice(rows.length)) {
      await client.query(migration.sql);
      await client.query("INSERT INTO porter_migrations (version, checksum) VALUES ($1, $2)", [migration.version, checksum(migration.sql)]);
    }
    await client.query("COMMIT");
  } catch (error) {
    if (client) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client?.release();
    await pool.end();
  }
}
