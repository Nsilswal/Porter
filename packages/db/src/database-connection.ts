import { timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { assertMigrationsApplied } from "./migrations.js";
import { unwrapKey, wrapKey } from "./encryption.js";
import * as schema from "./schema.js";

export interface DatabaseOptions {
  readonly connectionString: string;
  /** Independent from signing secrets. Persist securely across deploys. */
  readonly encryptionKey: Buffer;
  readonly maxConnections?: number;
}

const canaryContext = "porter:store-encryption:v1";
const canaryPlaintext = Buffer.from("porter deployment encryption key");

/** All database stores share the same migration and deployment-key startup gate. */
export async function openDatabase(options: DatabaseOptions) {
  if (!Buffer.isBuffer(options.encryptionKey) || options.encryptionKey.length !== 32) {
    throw new Error("Database encryption key must be exactly 32 bytes");
  }
  if (options.maxConnections !== undefined && (!Number.isSafeInteger(options.maxConnections) || options.maxConnections < 1)) {
    throw new Error("Database pool size must be a positive integer");
  }
  const masterKey = Buffer.from(options.encryptionKey);
  const pool = new Pool({
    connectionString: options.connectionString,
    max: options.maxConnections ?? 10,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 15_000,
  });
  // pg discards failed idle connections. Let requests/health report availability.
  pool.on("error", () => undefined);
  const db = drizzle(pool, { schema });
  let closing: Promise<void> | undefined;
  async function close(): Promise<void> {
    closing ??= pool.end().finally(() => masterKey.fill(0));
    await closing;
  }
  async function health(): Promise<void> {
    if (closing) throw new Error("Database store is closed");
    await assertMigrationsApplied(pool);
  }
  try {
    await health();
    await db.insert(schema.storeMetadata).values({
      key: "encryption_canary",
      value: wrapKey(canaryPlaintext, masterKey, canaryContext),
    }).onConflictDoNothing();
    const [canary] = await db.select().from(schema.storeMetadata).where(eq(schema.storeMetadata.key, "encryption_canary"));
    if (!canary) throw new Error("Missing database encryption canary");
    const plaintext = unwrapKey(canary.value, masterKey, canaryContext);
    if (plaintext.length !== canaryPlaintext.length || !timingSafeEqual(plaintext, canaryPlaintext)) {
      throw new Error("Database encryption canary is invalid");
    }
  } catch (error) {
    await close();
    throw error;
  }
  return { db, masterKey, health, close };
}
