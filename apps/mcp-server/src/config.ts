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
  };
}
