import { randomBytes } from "node:crypto";
import { loadPilotConfig, type PilotConfig } from "./pilot/config.js";

export interface PorterConfig {
  readonly pilot: PilotConfig | undefined;
  readonly port: number;
  readonly issuer: string;
  readonly signingSecret: string;
  readonly apiKeys: Record<string, string>;
  readonly logLevel: "debug" | "info" | "warn" | "error";
  readonly demoMode: boolean;
  readonly storage: "memory" | "postgres";
  readonly databaseUrl: string | undefined;
  /** Hex-encoded, 32-byte wrapping key. Separate from the signing secret. */
  readonly encryptionKey: string | undefined;
  /** The development-only OAuth flow accepts an unverified user id. */
  readonly devOAuthEnabled: boolean;
  readonly adapterLatencyMs: number;
  readonly adapterFailureRate: number;
  /** Off unless set. See apps/mcp-server/src/adapters.ts for the two gates. */
  readonly squareAccessToken: string | undefined;
  readonly squareBaseUrl: string;
  readonly jobberAccessToken: string | undefined;
  readonly stripeSecretKey: string | undefined;
  readonly stripeApplicationFeeBps: number;
  /** Refuse to start with live Stripe keys unless explicitly allowed. */
  readonly allowLiveStripe: boolean;
  readonly rateLimitPerUser: { capacity: number; refillPerSecond: number };
  readonly rateLimitPerAdapter: { capacity: number; refillPerSecond: number };
  /**
   * Public-page reading. Off unless a source list is configured.
   *
   * Kept separate from the API adapters on purpose: the Muse Connector
   * Policies name "violating robots.txt" as a prohibited practice, so a
   * Muse-facing deployment should leave this unset and the submission should
   * describe whatever actually ships.
   */
  readonly webSourcesPath: string | undefined;
  /** Square public booking pages. Same gate as the web adapter. */
  readonly squarePublicSourcesPath: string | undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<PorterConfig> = {}): PorterConfig {
  const port = Number(env.PORT ?? 8080);
  const issuer = (env.PORTER_ISSUER ?? `http://localhost:${port}`).replace(/\/$/, "");

  const apiKeys: Record<string, string> = {};
  for (const pair of (env.PORTER_API_KEYS ?? "").split(",")) {
    const [key, userId] = pair.split(":");
    if (key && userId) apiKeys[key.trim()] = userId.trim();
  }

  const databaseUrl = Object.hasOwn(overrides, "databaseUrl") ? overrides.databaseUrl : (env.DATABASE_URL || undefined);
  const storage = overrides.storage || env.PORTER_STORAGE || (databaseUrl ? "postgres" : "memory");
  if (storage !== "memory" && storage !== "postgres") {
    throw new Error("PORTER_STORAGE must be memory or postgres.");
  }

  const config: PorterConfig = {
    pilot: loadPilotConfig(env, overrides.issuer ?? issuer),
    port,
    issuer,
    signingSecret: env.PORTER_SIGNING_SECRET ?? "",
    apiKeys,
    logLevel: (env.LOG_LEVEL as PorterConfig["logLevel"]) ?? "info",
    demoMode: env.PORTER_DEMO_MODE !== "false",
    encryptionKey: env.PORTER_ENCRYPTION_KEY || undefined,
    devOAuthEnabled: env.NODE_ENV !== "production" && env.PORTER_PILOT_ENABLED !== "true",
    adapterLatencyMs: Number(env.PORTER_MOCK_LATENCY_MS ?? 0),
    adapterFailureRate: Number(env.PORTER_MOCK_FAILURE_RATE ?? 0),
    squareAccessToken: env.PORTER_SQUARE_ACCESS_TOKEN || undefined,
    // Sandbox by default. Pointing at production is a deliberate act.
    squareBaseUrl: env.PORTER_SQUARE_BASE_URL ?? "https://connect.squareupsandbox.com",
    jobberAccessToken: env.PORTER_JOBBER_ACCESS_TOKEN || undefined,
    stripeSecretKey: env.PORTER_STRIPE_SECRET_KEY || undefined,
    stripeApplicationFeeBps: Number(env.PORTER_STRIPE_FEE_BPS ?? 0),
    allowLiveStripe: env.PORTER_ALLOW_LIVE_STRIPE === "true",
    rateLimitPerUser: {
      capacity: Number(env.PORTER_RATE_USER_BURST ?? 60),
      refillPerSecond: Number(env.PORTER_RATE_USER_PER_SEC ?? 2),
    },
    rateLimitPerAdapter: {
      capacity: Number(env.PORTER_RATE_ADAPTER_BURST ?? 120),
      refillPerSecond: Number(env.PORTER_RATE_ADAPTER_PER_SEC ?? 10),
    },
    webSourcesPath: env.PORTER_WEB_SOURCES || undefined,
    squarePublicSourcesPath: env.PORTER_SQUARE_PUBLIC_SOURCES || undefined,
    ...overrides,
    storage,
    databaseUrl,
  };
  // Decide whether a secret may be generated only after applying overrides.
  // Durable confirmations must never depend on a fresh process-local key.
  if (!config.signingSecret) {
    if (env.NODE_ENV === "production" || config.storage === "postgres") {
      throw new Error("PORTER_SIGNING_SECRET must be set for production or PostgreSQL storage.");
    }
    return { ...config, signingSecret: randomBytes(32).toString("hex") };
  }
  return config;
}

/** Validate the final configuration, including programmatic overrides. */
export function validateStorageConfig(config: PorterConfig): void {
  if (config.pilot) {
    if (config.storage !== "postgres") throw new Error("The salon pilot requires PostgreSQL.");
    if (config.demoMode || config.devOAuthEnabled || Object.keys(config.apiKeys).length || config.squareAccessToken || config.jobberAccessToken || config.stripeSecretKey || config.webSourcesPath || config.squarePublicSourcesPath) {
      throw new Error("Run the salon pilot separately from mock/demo auth, static keys, global provider tokens and payment adapters.");
    }
    if (config.pilot.origin !== config.issuer) throw new Error("The pilot origin must match the configured issuer.");
  }
  if (config.storage === "memory") {
    if (!config.demoMode || config.squareAccessToken || config.jobberAccessToken || config.squarePublicSourcesPath || config.stripeSecretKey) {
      throw new Error("Provider writes require PostgreSQL. Memory storage is only for the mock demo; set DATABASE_URL and PORTER_ENCRYPTION_KEY.");
    }
    return;
  }
  if (!config.databaseUrl) throw new Error("DATABASE_URL is required for PostgreSQL storage.");
  if (!config.encryptionKey || !/^[a-f0-9]{64}$/i.test(config.encryptionKey)) {
    throw new Error("PORTER_ENCRYPTION_KEY must be exactly 32 random bytes encoded as 64 hexadecimal characters.");
  }
  if (config.encryptionKey === config.signingSecret) {
    throw new Error("Use different values for PORTER_ENCRYPTION_KEY and PORTER_SIGNING_SECRET.");
  }
  // A random development signing secret would make durable confirmations
  // unusable after restart, even though their database records survived.
  if (config.signingSecret.length < 32) throw new Error("PORTER_SIGNING_SECRET must contain at least 32 characters.");
}
