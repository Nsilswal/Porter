import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { BookingEngine, MemoryPayoutDirectory, RateLimiter, RecordingPaymentGateway, createSigner, type Actor, type PaymentGateway, type Store } from "@porter/core";
import { createStripeGateway } from "@porter/payments-stripe";
import { createFetchHttpClient } from "@porter/shared";
import { createMemoryStore, createPostgresStore } from "@porter/db";
import { buildAdapters } from "./adapters.js";
import { createLogger, systemClock, type Logger } from "@porter/shared";
import { AuthServer, SCOPES, type AuthContext } from "./auth.js";
import { buildMcpServer, createTransport } from "./server.js";
import { loadConfig, validateStorageConfig, type PorterConfig } from "./config.js";
import { connectorDocs } from "./docs.js";
import { createPilotRuntime } from "./pilot/runtime.js";
import type { PilotWeb } from "./pilot/web.js";

export interface PorterApp {
  readonly server: Server;
  readonly engine: BookingEngine;
  readonly payments: PaymentGateway;
  readonly payouts: MemoryPayoutDirectory;
  readonly auth: AuthServer;
  readonly store: Store;
  readonly config: PorterConfig;
  readonly pilot: PilotWeb | undefined;
  listen(port?: number): Promise<number>;
  close(): Promise<void>;
}

/**
 * The HTTP surface.
 *
 *   POST /mcp                                     the MCP endpoint
 *   GET  /.well-known/oauth-protected-resource    RFC 9728
 *   GET  /.well-known/oauth-authorization-server  RFC 8414
 *   POST /oauth/register                          dynamic client registration
 *   GET  /oauth/authorize                         consent, issues a code
 *   POST /oauth/token                             PKCE exchange and refresh
 *   GET  /healthz                                 liveness, for Railway
 *
 * An unauthenticated call to /mcp returns 401 with a WWW-Authenticate header
 * pointing at the protected-resource metadata. That challenge is what lets an
 * MCP client discover how to authenticate without being told out of band.
 */
export async function createApp(overrides: Partial<PorterConfig> = {}): Promise<PorterApp> {
  const config = loadConfig(process.env, overrides);
  validateStorageConfig(config);
  const log: Logger = createLogger({ level: config.logLevel, base: { app: "porter-mcp" } });

  const { adapters, credentials } = buildAdapters(config, log);
  const payments = buildPaymentGateway(config, log);
  const payouts = new MemoryPayoutDirectory();
  const signer = createSigner(config.signingSecret);
  const persistent = config.storage === "postgres"
    ? await createPostgresStore({
      connectionString: config.databaseUrl!,
      encryptionKey: Buffer.from(config.encryptionKey!, "hex"),
    })
    : undefined;
  const store = persistent ?? createMemoryStore();
  let pilot: PilotWeb | undefined;
  try {
    if (config.pilot) pilot = await createPilotRuntime(config.pilot, config.databaseUrl!, config.encryptionKey!);
  } catch (error) {
    await persistent?.close();
    throw error;
  }

  const engine = new BookingEngine({
    adapters,
    credentials,
    store,
    clock: systemClock,
    log,
    signer,
    // Two independent buckets. The per-adapter one protects Porter's standing
    // with each platform: exceeding a published quota risks API access for
    // every Porter user, not just the one making the requests.
    limiter: new RateLimiter(systemClock, {
      perUser: config.rateLimitPerUser,
      perAdapter: {
        // Jobber throttles on a points budget, so Porter stays well under it.
        jobber: { capacity: 40, refillPerSecond: 3 },
      },
      defaultAdapter: config.rateLimitPerAdapter,
    }),
    payments,
    payouts,
  });

  const auth = new AuthServer({
    issuer: config.issuer,
    resource: `${config.issuer}/mcp`,
    apiKeys: config.apiKeys,
    oauthEnabled: config.devOAuthEnabled,
  });

  const sessions = new Set<() => Promise<void>>();
  let closing: Promise<void> | undefined;
  const server = createServer((req, res) => {
    if (closing) return sendJson(res, 503, { error: "shutting_down" });
    handle(req, res, { engine, auth, log, config, sessions, pilot, ready: async () => { await persistent?.health(); await pilot?.options.store.health(); } }).catch(() => {
      // Driver/provider exceptions can contain query parameters or credentials.
      log.error("request_failed");
      if (!res.headersSent) sendJson(res, 500, { error: "internal_error" });
      else res.end();
    });
  });

  return {
    server,
    engine,
    payments,
    payouts,
    auth,
    store,
    config,
    pilot,
    listen(port = config.port) {
      return new Promise<number>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, () => {
          server.off("error", reject);
          const address = server.address();
          const actual = typeof address === "object" && address ? address.port : port;
          log.info("listening", { port: actual, issuer: config.issuer });
          resolve(actual);
        });
      });
    },
    close() {
      closing ??= (async () => {
        const drained = new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") reject(error);
            else resolve();
          });
        });
        // SSE clients keep requests open indefinitely. Close their transports
        // and bound draining of incomplete requests before closing the DB pool.
        const deadline = setTimeout(() => server.closeAllConnections(), 5_000);
        deadline.unref();
        try {
          await Promise.allSettled([...sessions].map((close) => close()));
          server.closeIdleConnections();
          await drained;
        } finally {
          clearTimeout(deadline);
          const results = await Promise.allSettled([pilot?.options.store.close(), persistent?.close()]);
          const failure = results.find((result) => result.status === "rejected");
          if (failure?.status === "rejected") throw failure.reason;
        }
      })();
      return closing;
    },
  };
}

interface Deps {
  engine: BookingEngine;
  auth: AuthServer;
  log: Logger;
  config: PorterConfig;
  pilot: PilotWeb | undefined;
  ready(): Promise<void>;
  sessions: Set<() => Promise<void>>;
}

async function handle(req: IncomingMessage, res: ServerResponse, deps: Deps): Promise<void> {
  const url = new URL(req.url ?? "/", deps.config.issuer);
  const path = url.pathname;
  if (deps.pilot && await deps.pilot.handle(req, res, url)) return;

  if (path === "/healthz") return sendJson(res, 200, { ok: true });
  if (path === "/readyz") {
    try {
      await deps.ready();
      return sendJson(res, 200, { ok: true, storage: deps.config.storage, mode: deps.config.pilot ? `pilot-${deps.config.pilot.environment}` : deps.config.demoMode ? "demo" : "provider" });
    } catch {
      return sendJson(res, 503, { ok: false });
    }
  }

  // Required by the Muse submission form (documentationUrl), and served from
  // the app so it cannot drift from the deployed endpoint or demo credentials.
  if (path === "/docs") {
    const body = connectorDocs(deps.config);
    res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
    return void res.end(body);
  }

  // The local OAuth flow has no user sign-in: its porter_user parameter is
  // supplied by the caller. Never expose it on a production deployment.
  if (!deps.config.devOAuthEnabled && (path.startsWith("/oauth/") || path === "/.well-known/oauth-authorization-server")) {
    return sendJson(res, 404, { error: "not_found" });
  }

  if (path === "/.well-known/oauth-protected-resource") {
    const metadata = deps.auth.protectedResourceMetadata();
    if (deps.pilot) metadata.scopes_supported = ["bookings:read", "bookings:write"];
    return sendJson(res, 200, metadata);
  }
  if (path === "/.well-known/oauth-authorization-server") {
    return sendJson(res, 200, deps.auth.authorizationServerMetadata());
  }

  if (path === "/oauth/register" && req.method === "POST") {
    try {
      const body = await readJson(req);
      return sendJson(res, 201, deps.auth.registerClient(body as Record<string, unknown>));
    } catch (error) {
      return sendJson(res, 400, { error: "invalid_client_metadata", error_description: String((error as Error).message) });
    }
  }

  if (path === "/oauth/authorize" && req.method === "GET") {
    const q = url.searchParams;
    const redirectUri = q.get("redirect_uri") ?? "";
    try {
      // In local development the user id is supplied directly. A real
      // deployment authenticates the person here and uses their real id.
      // Porter never sees or stores a Muse credential.
      const userId = q.get("porter_user") ?? "user_demo";
      const code = deps.auth.issueCode({
        clientId: q.get("client_id") ?? "",
        redirectUri,
        codeChallenge: q.get("code_challenge") ?? "",
        codeChallengeMethod: q.get("code_challenge_method") ?? "",
        scope: q.get("scope") ?? SCOPES.join(" "),
        userId,
      });
      const target = new URL(redirectUri);
      target.searchParams.set("code", code);
      const state = q.get("state");
      if (state) target.searchParams.set("state", state);
      res.writeHead(302, { Location: target.toString() });
      return void res.end();
    } catch (error) {
      return sendJson(res, 400, { error: "invalid_request", error_description: String((error as Error).message) });
    }
  }

  if (path === "/oauth/token" && req.method === "POST") {
    try {
      const form = await readForm(req);
      const grant = form.get("grant_type");
      if (grant === "authorization_code") {
        return sendJson(res, 200, deps.auth.exchangeCode({
          code: form.get("code") ?? "",
          codeVerifier: form.get("code_verifier") ?? "",
          clientId: form.get("client_id") ?? "",
          redirectUri: form.get("redirect_uri") ?? "",
        }));
      }
      if (grant === "refresh_token") {
        return sendJson(res, 200, deps.auth.refreshToken({
          refreshToken: form.get("refresh_token") ?? "",
          clientId: form.get("client_id") ?? "",
        }));
      }
      return sendJson(res, 400, { error: "unsupported_grant_type" });
    } catch (error) {
      return sendJson(res, 400, { error: String((error as Error).message) });
    }
  }

  // The user's own audit trail. Meta tells Muse users they can see a
  // complete record of what their agent did, and Porter can back that — from
  // hashes and outcomes alone, because the log holds no personal data.
  if (path === "/v1/audit" && req.method === "GET") {
    const ctx = await authenticate(req, deps);
    if (!ctx) {
      res.writeHead(401, { "WWW-Authenticate": deps.auth.challengeHeader(), "Content-Type": "application/json" });
      return void res.end(JSON.stringify({ error: "unauthorized" }));
    }
    const limit = Number(url.searchParams.get("limit") ?? 100);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      return sendJson(res, 400, { error: "invalid_limit" });
    }
    return sendJson(res, 200, await deps.engine.getAuditTrail({ id: ctx.userId }, limit));
  }

  if (path === "/mcp") {
    const ctx = await authenticate(req, deps);
    if (!ctx) {
      res.writeHead(401, { "WWW-Authenticate": deps.auth.challengeHeader(), "Content-Type": "application/json" });
      return void res.end(JSON.stringify({ error: "unauthorized" }));
    }

    const actor: Actor = { id: ctx.userId };
    const mcp = buildMcpServer(deps.engine, actor, deps.log.child({ actor: ctx.userId, auth: ctx.method }), { pilot: Boolean(deps.pilot), scopes: ctx.scopes });
    const transport = createTransport();

    let closed: Promise<void> | undefined;
    const close = (): Promise<void> => {
      closed ??= Promise.resolve()
        .then(() => Promise.allSettled([transport.close(), mcp.close()]))
        .then(() => {
          res.end();
          deps.sessions.delete(close);
        });
      return closed;
    };
    deps.sessions.add(close);
    res.on("close", () => { void close(); });

    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      await close();
      throw error;
    }
    return;
  }

  sendJson(res, 404, { error: "not_found" });
}

async function authenticate(req: IncomingMessage, deps: Deps): Promise<AuthContext | null> {
  if (!deps.pilot) return deps.auth.authenticate(req.headers.authorization, req.headers["x-api-key"]);
  const authorization = req.headers.authorization;
  const apiKey = req.headers["x-api-key"];
  if (Array.isArray(apiKey)) return null;
  const bearer = authorization ? /^Bearer (porter_[A-Za-z0-9_-]{43})$/i.exec(authorization)?.[1] : undefined;
  if (authorization && !bearer) return null;
  if (bearer && apiKey && bearer !== apiKey) return null;
  const userId = await deps.pilot.options.accounts.authenticateConnector(bearer ?? apiKey ?? "");
  return userId ? { userId, scopes: ["bookings:read", "bookings:write"], method: "api_key" } : null;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
  res.end(payload);
}

async function readBody(req: IncomingMessage, limitBytes = 1_000_000): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > limitBytes) throw new Error("payload_too_large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const raw = await readBody(req);
  return raw ? JSON.parse(raw) : {};
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const raw = await readBody(req);
  const type = req.headers["content-type"] ?? "";
  if (type.includes("application/json")) {
    const obj = raw ? (JSON.parse(raw) as Record<string, string>) : {};
    return new URLSearchParams(Object.entries(obj));
  }
  return new URLSearchParams(raw);
}

/**
 * Choose a payment gateway.
 *
 * Stripe only when a key is configured, and it will not start with live keys
 * unless someone has explicitly said so. Milestone 4 is test mode: the plan
 * commits to sandbox and test credentials only.
 */
function buildPaymentGateway(config: PorterConfig, log: Logger): PaymentGateway {
  if (!config.stripeSecretKey) return new RecordingPaymentGateway();

  const gateway = createStripeGateway({
    http: createFetchHttpClient(),
    secretKey: config.stripeSecretKey,
    applicationFeeBps: config.stripeApplicationFeeBps,
  });

  if (!gateway.isTestMode && !config.allowLiveStripe) {
    throw new Error(
      "Refusing to start with a live Stripe key. Set PORTER_ALLOW_LIVE_STRIPE=true only when you intend to move real money.",
    );
  }
  log.warn("stripe_gateway_enabled", { testMode: gateway.isTestMode, feeBps: config.stripeApplicationFeeBps });
  return gateway;
}
