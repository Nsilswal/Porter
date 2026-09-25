import type { ConnectorCredential, MerchantConnection, PilotBusiness } from "@porter/db";
import { escapeHtml as h } from "./security.js";

export interface PageOptions {
  readonly title: string;
  readonly body: string;
  readonly signedIn?: boolean;
  readonly sandbox?: boolean;
}

export function page({ title, body, signedIn, sandbox }: PageOptions): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${h(title)} · Porter</title><link rel="stylesheet" href="/assets/pilot.css"><script src="/assets/pilot.js" defer></script></head><body>
  <header class="topbar"><a href="/" class="wordmark" aria-label="Porter home"><span class="mark" aria-hidden="true">p</span>porter</a><nav aria-label="Main navigation">${sandbox ? '<span class="badge">Sandbox</span>' : ""}${signedIn ? '<a href="/owner">Your business</a><a href="/connect">Connect Muse</a><form action="/signout" method="post"><button class="text-button">Sign out</button></form>' : '<a href="/connect">For customers</a><a href="/signin">Sign in</a>'}</nav></header>
  ${sandbox ? '<div class="environment-banner" role="status">Square sandbox · Test appointments only</div>' : ""}<main id="main">${body}</main><footer>Porter <span aria-hidden="true">·</span> Appointments, wherever customers ask.</footer></body></html>`;
}

export function notice(title: string, detail: string, href = "/owner", action = "Back to your account"): string {
  return `<section class="narrow card"><span class="eyebrow">PORTER</span><h1>${h(title)}</h1><p>${h(detail)}</p><a class="button" href="${h(href)}">${h(action)}</a></section>`;
}

export function signIn(): string {
  return `<section class="narrow"><span class="eyebrow">YOUR PORTER ACCOUNT</span><h1>A link. And you’re in.</h1><p class="lead">Save your business, manage your Square connection, or connect Muse to your appointments.</p><form class="card stack" action="/signin/request" method="post"><label for="email">Email address</label><input id="email" name="email" type="email" autocomplete="email" maxlength="254" required placeholder="you@example.com"><button class="button">Send sign-in link</button><p class="hint">Open the link in this browser. It expires in 15 minutes.</p></form></section>`;
}

export function verifySignIn(): string {
  return `<section class="narrow card"><span class="eyebrow">WELCOME BACK</span><h1>Continue to Porter.</h1><p id="verify-description">Confirm that you want to sign in using this email link.</p><form class="stack" action="/signin/verify" method="post" id="verify-form"><input name="token" id="verify-token" type="hidden"><button class="button" id="verify-button" disabled>Sign in</button></form><noscript><p>Enable JavaScript to open this sign-in link.</p></noscript></section>`;
}

export function squareAuthorization(url: string): string {
  return `<section class="narrow card"><span class="eyebrow">CONTINUE WITH SQUARE</span><h1>Opening Square…</h1><p>Sign in to the Square account that manages this business, then review the permissions.</p><a class="button" data-square-authorize href="${h(url)}">Continue to Square</a><p class="hint">If Square does not open automatically, use the button above.</p></section>`;
}

export function ownerDashboard(businesses: readonly PilotBusiness[]): string {
  return `<section><div class="section-heading"><div><span class="eyebrow">YOUR BUSINESS</span><h1>Make room for new customers.</h1><p class="lead">Your services and calendar stay in Square. Porter brings them to Muse.</p></div><a class="button" href="/">Add your website</a></div>
  ${businesses.length ? `<div class="business-grid">${businesses.map((business) => `<article class="card"><span class="badge">${h(business.status)}</span><h2>${h(business.name)}</h2><p class="muted break">${h(business.websiteUrl)}</p><a class="button secondary" href="/owner/businesses/${encodeURIComponent(business.id)}">Manage business <span aria-hidden="true">→</span></a></article>`).join("")}</div>` : '<div class="empty card"><h2>Start with your salon’s website.</h2><p>Import a preview, review the details, and connect Square when you’re ready.</p><a href="/" class="button">Add your website</a></div>'}</section>`;
}

export function connectionPanel(business: PilotBusiness, connection: MerchantConnection | null): string {
  const route = `/owner/businesses/${encodeURIComponent(business.id)}`;
  const pending = connection?.status === "disconnecting";
  const connected = connection?.status === "connected";
  return `<section class="narrow"><a class="back" href="/owner">← Your businesses</a><span class="eyebrow">SQUARE CONNECTION</span><h1>${h(business.name)}</h1><p class="lead">Connect the Square account that manages appointments for this business.</p><div class="card stack"><div class="section-heading"><h2>Square Appointments</h2><span class="badge">${connected ? "Connected" : pending ? "Disconnecting" : "Needs connection"}</span></div>
  <p>${connected ? "Your Square account is connected. Review its location, services and booking rules before activating." : pending ? "Booking access is paused while the disconnection is checked. If this status persists, Porter support must review it before you reconnect. Your appointments remain in Square." : "You’ll sign in with Square and approve access to your services, availability and Porter bookings."}</p>
  ${connected ? `<p class="hint">Business status: ${h(business.status)}</p><a class="button" href="${route}/review">${business.status === "active" ? "Review services" : "Review and activate"}</a>${business.status === "active" ? `<a href="/s/${encodeURIComponent(business.id)}">Customer setup page</a><form method="post" action="${route}/pause"><button class="text-button">Pause new bookings</button></form><p class="hint">Pausing hides your business from search. Customers can still manage their existing Porter appointments while Square remains connected.</p>` : ""}` : ""}
  ${pending ? '<p class="warning">Disconnection needs review. Reconnecting is paused to protect your Square account.</p>' : `<form action="${route}/square" method="post"><button class="button ${connected ? "secondary" : ""}">${connected ? "Reconnect Square" : "Continue with Square"}</button></form>`}
  ${connected ? `<form action="${route}/disconnect" method="post"><button class="text-button danger">Disconnect Square</button></form>` : ""}
  <p class="hint">Connecting does not publish your business or create an appointment. Existing appointments stay in Square when you disconnect.</p></div></section>`;
}

export function internalCredentialPage(credentials: readonly ConnectorCredential[], endpoint: string, newKey?: string): string {
  const active = credentials.filter((credential) => !credential.revokedAt);
  return `<section class="narrow"><span class="eyebrow">INTERNAL SANDBOX TESTING</span><h1>Local test credentials.</h1><p class="lead">For local integration tests. Customer connections use OAuth from the Muse directory.</p>
  ${newKey ? `<div class="card key-card stack"><h2>Your private API key</h2><p>Copy this now. Porter won’t display it again.</p><label for="connector-key">API key</label><input id="connector-key" type="text" readonly value="${h(newKey)}" autocomplete="off" spellcheck="false"><button class="button" type="button" data-copy="connector-key">Copy key</button><p class="hint" role="status" id="copy-status">Keep this key private. It grants access to your Porter appointments.</p></div>` : ""}
  <div class="card stack"><h2>Call the local MCP endpoint</h2><ol class="instructions"><li>Use an MCP test client.</li><li>Use this server URL: <code class="break">${h(endpoint)}</code></li><li>Send the key in an Authorization: Bearer header.</li><li>Exercise only authorized sandbox appointments.</li></ol><p class="hint">These credentials are available only in local internal test mode.</p><form action="/connect/keys" method="post" class="stack"><label for="key-label">Connection name</label><input id="key-label" name="label" maxlength="80" required value="Local test client"><button class="button">Create a private API key</button></form></div>
  <div class="card"><h2>Your connections</h2>${active.length ? `<ul class="key-list">${active.map((credential) => `<li><div><strong>${h(credential.label)}</strong><p class="hint">Created ${h(credential.createdAt.toISOString().slice(0, 10))}</p></div><form action="/connect/keys/${encodeURIComponent(credential.id)}/revoke" method="post"><button class="text-button danger">Revoke</button></form></li>`).join("")}</ul>` : '<p class="muted">No active connections yet.</p>'}</div></section>`;
}

export const PILOT_SCRIPT = `"use strict";
const squareLink = document.querySelector("[data-square-authorize]");
if (squareLink) {
  const url = new URL(squareLink.href);
  if (["https://connect.squareupsandbox.com", "https://connect.squareup.com"].includes(url.origin) && url.pathname === "/oauth2/authorize") location.assign(url.href);
}
const applicationLink = document.querySelector("[data-oauth-redirect]");
if (applicationLink) {
  const url = new URL(applicationLink.href);
  if (url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) location.assign(url.href);
}
const tokenInput = document.getElementById("verify-token");
if (tokenInput) {
  const token = location.hash.slice(1);
  history.replaceState(null, "", location.pathname);
  if (/^[A-Za-z0-9_-]{43}$/.test(token)) {
    tokenInput.value = token;
    document.getElementById("verify-button").disabled = false;
  } else {
    document.getElementById("verify-description").textContent = "This link is incomplete. Request a new sign-in link.";
  }
}
document.querySelectorAll("[data-copy]").forEach(button => button.addEventListener("click", async () => {
  const input = document.getElementById(button.dataset.copy);
  try {
    await navigator.clipboard.writeText(input.value);
    document.getElementById("copy-status").textContent = "Copied. Keep this local test credential private.";
  } catch {
    input.focus(); input.select();
    document.getElementById("copy-status").textContent = "Select and copy the key above.";
  }
}));
document.querySelectorAll("form").forEach(form => form.addEventListener("submit", () => {
  const button = form.querySelector("button[type=submit],button:not([type])");
  if (button) { button.disabled = true; button.textContent = "Working…"; }
}));`;

export const PILOT_CSS = `
.environment-banner{text-align:center;background:#e9efe5;padding:8px 20px;font-size:13px;color:#245b4c}:root{color-scheme:light;--ink:#173b36;--muted:#66766d;--paper:#f7f6f0;--line:#dbe2d8;--accent:#245b4c;--light:#e9efe5;--white:#fffefa}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:16px;line-height:1.6}a{color:inherit;text-underline-offset:4px}button,input,select,textarea{font:inherit}button,a,input,textarea,select{-webkit-tap-highlight-color:transparent}button{cursor:pointer}button:disabled{opacity:.6;cursor:wait}a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:3px solid #e2a644;outline-offset:4px}.topbar{max-width:1180px;margin:auto;min-height:104px;padding:24px 40px;display:flex;align-items:center;justify-content:space-between;gap:24px}.wordmark{font-size:30px;font-weight:650;letter-spacing:-1px;text-decoration:none;display:flex;align-items:center;gap:10px}.mark{display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;background:var(--ink);color:var(--paper);border-radius:50%;font-family:Georgia,serif;font-size:30px;font-style:italic;padding-bottom:7px}nav{display:flex;gap:24px;align-items:center;font-size:14px}nav a{text-decoration:none}nav form{margin:0}main{max-width:1100px;min-height:calc(100vh - 220px);margin:auto;padding:48px 40px 80px}.narrow{max-width:640px;margin:auto}.eyebrow{display:block;font-size:11px;letter-spacing:2px;font-weight:700;margin:16px 0;color:var(--accent)}h1,h2,h3{line-height:1.13;font-weight:500;letter-spacing:-1.4px;margin:0 0 22px}h1{font-family:Georgia,"Times New Roman",serif;font-size:clamp(38px,5.8vw,62px);font-weight:400}h2{font-size:24px;letter-spacing:-.5px}h3{font-size:18px;letter-spacing:-.2px}p{margin:0 0 20px}.lead{font-size:18px;line-height:1.7;color:var(--muted);max-width:570px;margin-bottom:32px}.card{border:1px solid var(--line);background:var(--white);border-radius:20px;padding:32px;margin-bottom:24px;box-shadow:0 4px 20px #173b3603}.stack{display:flex;flex-direction:column;gap:16px}.stack>*{margin-top:0;margin-bottom:0}.stack label{margin-bottom:-8px}.stack h2{margin-bottom:0}.button{display:inline-flex;justify-content:center;align-items:center;gap:12px;background:var(--accent);color:white;border:1px solid var(--accent);border-radius:10px;padding:13px 22px;font-weight:600;font-size:15px;text-decoration:none;min-height:48px}.button.secondary{background:transparent;color:var(--ink);border-color:var(--line)}.text-button{border:0;background:none;padding:0;color:inherit;font-size:14px;text-decoration:underline;text-underline-offset:4px}.danger{color:#984334}.badge{display:inline-block;border-radius:999px;padding:4px 12px;background:var(--light);color:var(--accent);font-size:12px;letter-spacing:.15px;white-space:nowrap}label{font-size:14px;font-weight:600}input,select,textarea{width:100%;padding:13px 14px;border:1px solid #bbc9bf;background:white;border-radius:8px;color:var(--ink);min-height:48px}textarea{min-height:100px;resize:vertical}input[type=checkbox]{width:18px;min-height:18px;accent-color:var(--accent)}.hint{font-size:13px;color:var(--muted);line-height:1.6}.muted{color:var(--muted)}.break{overflow-wrap:anywhere}.section-heading{display:flex;justify-content:space-between;align-items:flex-start;gap:20px;margin-bottom:24px}.section-heading h2{margin:0}.section-heading .button{white-space:nowrap}.business-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(270px,1fr));gap:24px}.business-grid .badge{margin-bottom:20px}.empty{text-align:center;padding:64px 24px}.back{display:block;margin-bottom:24px;text-decoration:none;font-size:14px}.instructions{padding-left:22px;margin:0;display:flex;flex-direction:column;gap:14px}.instructions code{font-size:13px;background:var(--light);padding:3px 6px}.key-card{background:#edf3e7}.key-list{list-style:none;margin:0;padding:0}.key-list li{display:flex;align-items:center;justify-content:space-between;gap:20px;border-top:1px solid var(--line);padding:18px 0}.key-list p{margin:0}.key-list li:last-child{padding-bottom:0}footer{padding:24px;text-align:center;color:var(--muted);font-size:12px}footer span{padding:0 10px}.steps{display:flex;gap:20px;margin-bottom:40px;font-size:12px;color:var(--muted);flex-wrap:wrap}.steps strong{color:var(--accent)}.check-row{display:flex;align-items:flex-start;gap:12px}.check-row input{flex:none;margin-top:4px}.check-row label{font-weight:400}.service-list{list-style:none;padding:0;margin:0}.service-list li{padding:18px 0;border-bottom:1px solid var(--line)}.service-list li:last-child{border:0}.warning{border-left:3px solid #bf9448;padding:12px 16px;background:#fbf3e2;font-size:14px;border-radius:0 8px 8px 0}.hero{display:grid;grid-template-columns:1.1fr 1fr;gap:64px;align-items:center}.hero h1{font-size:clamp(42px,5.5vw,70px)}.hero-aside{background:#e8eee2;border-radius:28px;padding:36px}.preview-name{font-family:Georgia,serif;font-size:28px;line-height:1.2}.divider{border:0;border-top:1px solid var(--line);margin:24px 0}.small-link{font-size:13px} @media(max-width:700px){.topbar{padding:20px;min-height:88px}nav{gap:14px;font-size:12px}nav .badge{display:none}.wordmark{font-size:26px}.mark{height:30px;width:30px;font-size:26px}main{padding:28px 20px 60px}.card{padding:24px;border-radius:16px}.section-heading{flex-direction:column}.section-heading .button{align-self:flex-start}.hero{grid-template-columns:1fr;gap:32px}.hero-aside{padding:24px}nav{flex-wrap:wrap;justify-content:flex-end}.lead{font-size:16px}h1{letter-spacing:-1px}}
`;
