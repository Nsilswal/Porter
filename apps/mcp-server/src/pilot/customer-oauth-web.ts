import type { IncomingMessage, ServerResponse } from "node:http";
import { CustomerOAuthError, type CustomerConsentView } from "./customer-oauth.js";
import type { PilotWeb } from "./web.js";
import { redirect } from "./web.js";
import { escapeHtml as h, PilotHttpError, readPilotBody, readPilotForm, readTokenCookie, requireSameOrigin, setTokenCookie } from "./security.js";
import { notice } from "./views.js";

export const CUSTOMER_OAUTH_COOKIE = "porter_oauth_request";
const PROTOCOL_PATHS = ["/oauth/register", "/oauth/token", "/oauth/revoke", "/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"];

/** Protocol POSTs use their OAuth proofs, not browser session cookies or CSRF exemptions. */
export async function routeCustomerOAuth(web: PilotWeb, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const path = url.pathname;
  const protocol = PROTOCOL_PATHS.includes(path);
  const browser = path === "/oauth/authorize" || path === "/oauth/consent";
  if (!protocol && !browser) return false;
  const oauth = web.options.oauth;
  if (!oauth) return false;
  if (protocol) {
    // These endpoints never use cookies and never allow credentialed CORS.
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return true; }
  }
  try {
    if (req.method === "GET" && path.startsWith("/.well-known/oauth-protected-resource")) {
      json(res, 200, oauth.protectedResourceMetadata());
    } else if (req.method === "GET" && path === "/.well-known/oauth-authorization-server") {
      json(res, 200, oauth.authorizationServerMetadata());
    } else if (req.method === "POST" && path === "/oauth/register") {
      if (req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json") throw new CustomerOAuthError(415, "invalid_client_metadata", "Send a JSON client registration.");
      let data: unknown;
      try { data = JSON.parse(await readPilotBody(req)); } catch (error) {
        if (error instanceof PilotHttpError) throw error;
        throw new CustomerOAuthError(400, "invalid_client_metadata", "Send a valid JSON client registration.");
      }
      json(res, 201, await oauth.register(data));
    } else if (req.method === "POST" && (path === "/oauth/token" || path === "/oauth/revoke")) {
      // Registered public clients authenticate with the code+PKCE or token;
      // reject an unsupported client-auth header rather than silently ignoring it.
      if (req.headers.authorization) throw new CustomerOAuthError(400, "invalid_client", "This endpoint supports registered public clients without a client secret.");
      const form = await readPilotForm(req);
      if (path === "/oauth/token") json(res, 200, await oauth.token(form));
      else { await oauth.revoke(form); json(res, 200, {}); }
    } else if (req.method === "GET" && path === "/oauth/authorize") {
      const request = await oauth.startAuthorization(url.searchParams, web.browserNonce(req, res));
      setTokenCookie(res, CUSTOMER_OAUTH_COOKIE, request.requestToken, Math.max(0, Math.floor((request.expiresAt.getTime() - Date.now()) / 1000)), web.options.config.origin.startsWith("https:"));
      redirect(res, await web.session(req) ? "/oauth/consent" : "/signin");
    } else if (req.method === "GET" && path === "/oauth/consent") {
      if (!await web.session(req)) { redirect(res, "/signin"); return true; }
      const request = await oauth.authorization(readTokenCookie(req, CUSTOMER_OAUTH_COOKIE) ?? "", readTokenCookie(req, "porter_browser") ?? "");
      if (!request) throw new CustomerOAuthError(400, "invalid_request", "This connection request expired. Start connecting again from Muse.");
      web.html(res, 200, "Authorize your connection", consentPage(request), true);
    } else if (req.method === "POST" && path === "/oauth/consent") {
      requireSameOrigin(req, web.options.config.origin);
      const session = await web.requireSession(req);
      const form = await readPilotForm(req);
      const decision = form.get("decision");
      if (decision !== "approve" && decision !== "deny") throw new CustomerOAuthError(400, "invalid_request", "Choose whether to authorize this application.");
      // Bind the POST to what this tab displayed. A later authorization in a
      // different tab can replace the resume cookie, but cannot replace consent.
      const requestToken = form.get("request") ?? "";
      const result = await oauth.decide(session, requestToken, readTokenCookie(req, "porter_browser") ?? "", decision === "approve");
      if (readTokenCookie(req, CUSTOMER_OAUTH_COOKIE) === requestToken) setTokenCookie(res, CUSTOMER_OAUTH_COOKIE, "", 0, web.options.config.origin.startsWith("https:"));
      web.html(res, 200, "Return to your application", `<section class="narrow card stack"><h1>${decision === "approve" ? "Your connection is ready." : "Access was not granted."}</h1><p>Return to the application where you started.</p><a class="button" data-oauth-redirect href="${h(result.redirectUrl)}">Continue</a></section>`, true);
    } else {
      json(res, 405, { error: "invalid_request", error_description: "Use the supported method for this endpoint." });
    }
  } catch (error) {
    const status = error instanceof CustomerOAuthError ? error.status : error instanceof PilotHttpError ? error.status : 503;
    const code = error instanceof CustomerOAuthError ? error.error : status >= 500 ? "server_error" : "invalid_request";
    const message = error instanceof CustomerOAuthError ? error.error_description : error instanceof PilotHttpError ? error.message : "The connection could not be completed. Try again shortly.";
    if (protocol) json(res, status, { error: code, error_description: message });
    else web.html(res, status, "Connection needs another try", notice("This connection needs another try.", message, "/connect", "Your connections"));
  }
  return true;
}

function consentPage(request: CustomerConsentView): string {
  const fields = `<input type="hidden" name="request" value="${h(request.requestToken)}">`;
  return `<section class="narrow"><span class="eyebrow">CONNECT YOUR PORTER ACCOUNT</span><h1>Authorize ${h(request.clientName)}?</h1><div class="card stack"><p>This application is requesting access to your Porter account. Continue only if you started this connection.</p><p class="hint break">Application callback: <strong>${h(request.redirectOrigin)}</strong></p><p class="hint">Application names are supplied during registration. Check the callback address matches the application you intended to connect.</p><ul>${request.scopes.includes("bookings:read") ? '<li>Find participating salons and available times, and view your Porter appointments.</li>' : ""}${request.scopes.includes("bookings:write") ? '<li>Request bookings, reschedules and cancellations. Each appointment change still requires your confirmation.</li>' : ""}</ul><p>No access to merchant Square credentials, payment cards or another customer’s appointments.</p><form method="post" action="/oauth/consent">${fields}<input type="hidden" name="decision" value="approve"><button class="button">Authorize connection</button></form><form method="post" action="/oauth/consent">${fields}<input type="hidden" name="decision" value="deny"><button class="text-button">Cancel</button></form><p class="hint">You can disconnect this application from your Porter account at any time.</p></div></section>`;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const content = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(content), "Cache-Control": "no-store", Pragma: "no-cache" });
  res.end(content);
}
