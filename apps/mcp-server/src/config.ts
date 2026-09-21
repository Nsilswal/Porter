import { randomBytes } from "node:crypto";

export interface PorterConfig {
  readonly port: number;
  readonly issuer: string;
  readonly signingSecret: string;
  readonly apiKeys: Record<string, string>;
  readonly logLevel: "debug" | "info" | "warn" | "error";
  readonly demoMode: boolean;
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
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): PorterConfig {
  const port = Number(env.PORT ?? 8080);
  const issuer = (env.PORTER_ISSUER ?? `http://localhost:${port}`).replace(/\/$/, "");

  // A generated secret is fine for local development, but it would silently
  // invalidate every slot id and confirmation token on restart in production.
  let signingSecret = env.PORTER_SIGNING_SECRET ?? "";
  if (!signingSecret) {
    if (env.NODE_ENV === "production") {
      throw new Error("PORTER_SIGNING_SECRET must be set in production.");
    }
    signingSecret = randomBytes(32).toString("hex");
  }

  const apiKeys: Record<string, string> = {};
  for (const pair of (env.PORTER_API_KEYS ?? "").split(",")) {
    const [key, userId] = pair.split(":");
    if (key && userId) apiKeys[key.trim()] = userId.trim();
  }

  return {
    port,
    issuer,
    signingSecret,
    apiKeys,
    logLevel: (env.LOG_LEVEL as PorterConfig["logLevel"]) ?? "info",
    demoMode: env.PORTER_DEMO_MODE !== "false",
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
  };
}
