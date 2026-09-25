import type { IncomingMessage, ServerResponse } from "node:http";
import type { CustomerOAuthStore, PilotSession, PilotStore } from "@porter/db";
import { SquareOAuthError } from "@porter/adapter-square-appointments";
import type { PilotConfig } from "./config.js";
import { PilotAccounts, SESSION_LIFETIME } from "./accounts.js";
import type { MerchantConnections } from "./connections.js";
import { PilotOnboarding } from "./onboarding.js";
import { OwnerSquareCatalog } from "./catalog.js";
import { DRAFT_COOKIE, routeOnboarding } from "./onboarding-web.js";
import { museConnections } from "./muse-views.js";
import { CustomerOAuthError, type CustomerOAuth } from "./customer-oauth.js";
import { CUSTOMER_OAUTH_COOKIE, routeCustomerOAuth } from "./customer-oauth-web.js";
import { opaqueToken, PilotHttpError, privateResponse, readPilotForm, readTokenCookie, requireSameOrigin, setTokenCookie } from "./security.js";
import { connectionPanel, internalCredentialPage, notice, ownerDashboard, page, PILOT_CSS, PILOT_SCRIPT, signIn, squareAuthorization, verifySignIn } from "./views.js";

const SESSION_COOKIE = "porter_session";
const BROWSER_COOKIE = "porter_browser";

export interface PilotWebOptions {
  readonly config: PilotConfig;
  readonly store: PilotStore;
  readonly accounts: PilotAccounts;
  readonly connections: MerchantConnections;
  readonly onboarding?: PilotOnboarding;
  readonly catalog?: OwnerSquareCatalog;
  readonly oauth?: CustomerOAuth;
  readonly oauthStore?: CustomerOAuthStore;
}

export class PilotWeb {
  readonly onboarding: PilotOnboarding;
  readonly catalog: OwnerSquareCatalog;
  constructor(readonly options: PilotWebOptions) {
    this.onboarding = options.onboarding ?? new PilotOnboarding(options.store);
    this.catalog = options.catalog ?? new OwnerSquareCatalog({ store: options.store, connections: options.connections, environment: options.config.environment });
  }

  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const paths = ["/signin", "/signin/request", "/signin/verify", "/signout", "/owner", "/connect", "/connect/keys", "/square/callback", "/assets/pilot.css", "/assets/pilot.js"];
    if (url.pathname !== "/" && !paths.includes(url.pathname) && !["/owner/businesses/", "/connect/keys/", "/connect/grants/", "/onboarding/", "/s/", "/oauth/", "/.well-known/oauth-"].some((prefix) => url.pathname.startsWith(prefix))) return false;
    privateResponse(res);
    try {
      if (await routeCustomerOAuth(this, req, res, url)) return true;
      await this.#route(req, res, url);
    } catch (error) {
      if (error instanceof PilotHttpError) {
        this.html(res, error.status, error.status === 401 ? "Sign in" : "We couldn’t complete that", notice(
          error.status === 401 ? "Sign in to continue." : "We couldn’t complete that.", error.message,
          error.status === 401 ? "/signin" : "/owner", error.status === 401 ? "Sign in" : "Back to your account",
        ));
      } else if (error instanceof CustomerOAuthError) {
        this.html(res, error.status, "Connection needs another try", notice("This connection needs another try.", error.error_description, "/connect", "Your connections"));
      } else if (error instanceof SquareOAuthError) {
        this.html(res, 400, "Square connection", notice("Reconnect from your account.", error.message));
      } else {
        // Never serialize database/provider errors, URLs, state or credentials.
        this.html(res, 503, "Try again shortly", notice("Something needs another try.", "Porter couldn’t complete that request. Your existing appointments have not been changed."));
      }
    }
    return true;
  }

  html(res: ServerResponse, status: number, title: string, body: string, signedIn = false): void {
    privateResponse(res);
    const html = page({ title, body, signedIn, sandbox: this.options.config.environment === "sandbox" });
    res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Content-Length": Buffer.byteLength(html) });
    res.end(html);
  }

  browserNonce(req: IncomingMessage, res: ServerResponse): string {
    const existing = readTokenCookie(req, BROWSER_COOKIE);
    if (existing) return existing;
    const nonce = opaqueToken();
    setTokenCookie(res, BROWSER_COOKIE, nonce, SESSION_LIFETIME / 1000, this.options.config.origin.startsWith("https:"));
    return nonce;
  }

  async session(req: IncomingMessage): Promise<PilotSession | null> {
    return this.options.accounts.session(readTokenCookie(req, SESSION_COOKIE));
  }

  async requireSession(req: IncomingMessage): Promise<PilotSession> {
    const session = await this.session(req);
    if (!session) throw new PilotHttpError(401, "signin_required", "Sign in to manage your account.");
    return session;
  }

  async #route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const { accounts, store, connections, config } = this.options;
    const path = url.pathname;
    const get = req.method === "GET";
    const post = req.method === "POST";
    if (!get && !post) throw new PilotHttpError(405, "method_not_allowed", "Use the form on this page.");
    if (post) requireSameOrigin(req, config.origin);
    if (await routeOnboarding(this, req, res, url)) return;

    if (get && (path === "/assets/pilot.css" || path === "/assets/pilot.js")) {
      const css = path.endsWith(".css");
      const content = css ? PILOT_CSS : PILOT_SCRIPT;
      res.writeHead(200, { "Content-Type": css ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8" });
      res.end(content);
      return;
    }
    if (get && path === "/signin") {
      this.browserNonce(req, res);
      return this.html(res, 200, "Sign in", signIn());
    }
    if (get && path === "/signin/verify") return this.html(res, 200, "Sign in", verifySignIn());
    if (post && path === "/signin/request") {
      const form = await readPilotForm(req);
      await accounts.requestLink(form.get("email") ?? "", this.browserNonce(req, res));
      return this.html(res, 200, "Check your email", notice("Check your email.", "Open your Porter sign-in link in this browser. It expires in 15 minutes.", "/signin", "Use another email"));
    }
    if (post && path === "/signin/verify") {
      const form = await readPilotForm(req);
      const token = await accounts.verifyLink(form.get("token") ?? "", readTokenCookie(req, BROWSER_COOKIE) ?? "");
      setTokenCookie(res, SESSION_COOKIE, token, SESSION_LIFETIME / 1000, config.origin.startsWith("https:"));
      return redirect(res, readTokenCookie(req, CUSTOMER_OAUTH_COOKIE) ? "/oauth/consent" : readTokenCookie(req, DRAFT_COOKIE) ? "/onboarding/preview" : "/owner");
    }

    const session = await this.requireSession(req);
    if (post && path === "/signout") {
      await store.sessions.revoke(session.userId, session.sessionHash);
      setTokenCookie(res, SESSION_COOKIE, "", 0, config.origin.startsWith("https:"));
      return redirect(res, "/signin");
    }
    if (get && path === "/owner") return this.html(res, 200, "Your business", ownerDashboard(await store.businesses.list(session.userId)), true);
    if (get && path === "/connect") return this.html(res, 200, "Connect Muse", museConnections(await this.options.oauth?.connections(session) ?? [], config.museConnectorUrl), true);
    const grantMatch = /^\/connect\/grants\/([a-f0-9-]{36})\/revoke$/.exec(path);
    if (post && grantMatch && this.options.oauth) {
      await this.options.oauth.revokeConnection(session, grantMatch[1]!);
      return redirect(res, "/connect");
    }
    if (post && path === "/connect/keys") {
      if (!config.internalApiKeys) throw new PilotHttpError(404, "not_found", "Connect Porter through Muse’s connector directory.");
      const form = await readPilotForm(req);
      const credential = await accounts.issueConnector(session, form.get("label") ?? "Local test client");
      return this.html(res, 201, "Your private API key", internalCredentialPage(await store.connectors.list(session.userId), `${config.origin}/mcp`, credential.key), true);
    }
    const revokeMatch = /^\/connect\/keys\/([a-f0-9-]{36})\/revoke$/.exec(path);
    if (post && revokeMatch) {
      if (!await store.connectors.revoke(session.userId, revokeMatch[1]!)) throw new PilotHttpError(404, "connection_not_found", "That connection was not found.");
      return redirect(res, "/connect");
    }
    if (get && path === "/square/callback") {
      if (["state", "code", "error"].some((key) => url.searchParams.getAll(key).length > 1)) {
        throw new PilotHttpError(400, "invalid_callback", "Restart the Square connection from your account.");
      }
      const businessId = await connections.callback(session, {
        state: url.searchParams.get("state") ?? "", code: url.searchParams.get("code") ?? undefined, error: url.searchParams.get("error") ?? undefined,
      });
      return redirect(res, `/owner/businesses/${encodeURIComponent(businessId)}`);
    }
    const businessMatch = /^\/owner\/businesses\/([a-f0-9-]{36})(?:\/(square|disconnect))?$/.exec(path);
    if (businessMatch) {
      const id = businessMatch[1]!;
      const business = await store.businesses.get(session.userId, id);
      if (!business) throw new PilotHttpError(404, "business_not_found", "That business was not found in your account.");
      if (get && !businessMatch[2]) return this.html(res, 200, business.name, connectionPanel(business, await store.connections.get(session.userId, id, config.environment)), true);
      // End the form navigation before leaving this origin. A cross-origin 303
      // is blocked by Chromium's form-action CSP, including later login redirects.
      if (post && businessMatch[2] === "square") return this.html(res, 200, "Continue with Square", squareAuthorization(await connections.start(session, id)), true);
      if (post && businessMatch[2] === "disconnect") {
        await connections.disconnect(session, id);
        return redirect(res, `/owner/businesses/${encodeURIComponent(id)}`);
      }
    }
    throw new PilotHttpError(404, "not_found", "That page was not found.");
  }
}

export function redirect(res: ServerResponse, location: string): void {
  res.writeHead(303, { Location: location });
  res.end();
}
