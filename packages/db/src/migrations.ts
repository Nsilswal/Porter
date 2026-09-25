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
