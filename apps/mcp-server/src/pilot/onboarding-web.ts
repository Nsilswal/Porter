import type { IncomingMessage, ServerResponse } from "node:http";
import { sanitize } from "@porter/shared";
import type { PilotWeb } from "./web.js";
import { redirect } from "./web.js";
import { DRAFT_LIFETIME } from "./onboarding.js";
import { catalogReviewDigest } from "./catalog.js";
import { activationComplete, home, importPreview, reviewBusiness, salonShare } from "./onboarding-views.js";
import { PilotHttpError, readPilotForm, readTokenCookie, setTokenCookie } from "./security.js";

export const DRAFT_COOKIE = "porter_draft";

/** Called after method and same-origin POST checks. */
export async function routeOnboarding(web: PilotWeb, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const path = url.pathname;
  const get = req.method === "GET";
  const post = req.method === "POST";
  const { config, store } = web.options;
  if (get && path === "/") {
    web.browserNonce(req, res);
    web.html(res, 200, "Appointments start with a conversation", home(), Boolean(await web.session(req)));
    return true;
  }
  if (post && path === "/onboarding/import") {
    const form = await readPilotForm(req);
    const draft = await web.onboarding.start(form.get("website") ?? "", web.browserNonce(req, res));
    setTokenCookie(res, DRAFT_COOKIE, draft.token, DRAFT_LIFETIME / 1000, config.origin.startsWith("https:"));
    redirect(res, "/onboarding/preview");
    return true;
  }
  if (get && path === "/onboarding/preview") {
    const draftToken = readTokenCookie(req, DRAFT_COOKIE);
    const preview = await web.onboarding.preview(draftToken, readTokenCookie(req, "porter_browser"));
    if (!preview) throw new PilotHttpError(400, "preview_expired", "This preview is no longer available. Return to the home page to import your website.");
    const session = await web.session(req);
    web.html(res, 200, "Your website preview", importPreview(preview, Boolean(session), draftToken!), Boolean(session));
    return true;
  }
  if (post && path === "/onboarding/claim") {
    const session = await web.requireSession(req);
    const form = await readPilotForm(req);
    const draftToken = form.get("draft");
    const business = await web.onboarding.claim(session, draftToken, readTokenCookie(req, "porter_browser"), form.get("name") ?? "");
    if (readTokenCookie(req, DRAFT_COOKIE) === draftToken) setTokenCookie(res, DRAFT_COOKIE, "", 0, config.origin.startsWith("https:"));
    redirect(res, `/owner/businesses/${encodeURIComponent(business.id)}`);
    return true;
  }
  const shareMatch = /^\/s\/([a-f0-9-]{36})$/.exec(path);
  if (get && shareMatch) {
    const business = await store.businesses.getById(shareMatch[1]!);
    const connection = business ? await store.connections.get(business.ownerId, business.id, config.environment) : null;
    if (!business || business.status !== "active" || connection?.status !== "connected") throw new PilotHttpError(404, "salon_unavailable", "This salon is not accepting new Porter appointments. Contact the salon directly for help.");
    web.html(res, 200, business.name, salonShare(business), Boolean(await web.session(req)));
    return true;
  }
  const match = /^\/owner\/businesses\/([a-f0-9-]{36})\/(review|location|activate|pause)$/.exec(path);
  if (!match) return false;
  const session = await web.requireSession(req);
  const business = await store.businesses.get(session.userId, match[1]!);
  if (!business) throw new PilotHttpError(404, "business_not_found", "That business was not found in your account.");
  const identity = await store.identities.get(session.userId);
  const invited = Boolean(identity && config.invitedEmails.includes(identity.email));
  const route = `/owner/businesses/${encodeURIComponent(business.id)}`;
  if (get && match[2] === "review") {
    web.html(res, 200, "Review your Square services", reviewBusiness(business, await web.catalog.review(session, business.id), invited), true);
    return true;
  }
  if (post && match[2] === "location") {
    const form = await readPilotForm(req);
    if (form.get("location_matches") !== "yes") throw new PilotHttpError(400, "location_review_required", "Confirm that this Square location matches your business.");
    const locationId = form.get("location") ?? "";
    const catalog = await web.catalog.review(session, business.id, locationId);
    if (!catalog.locations.find((location) => location.id === locationId)?.supported) throw new PilotHttpError(400, "location_unsupported", "Choose a supported US location configured for online Square Appointments.");
    if (!await store.businesses.update(session.userId, business.id, { selectedLocationId: locationId })) throw changedBusiness();
    redirect(res, `${route}/review`);
    return true;
  }
  if (post && match[2] === "pause") {
    if (!await store.businesses.update(session.userId, business.id, { status: "paused" })) throw changedBusiness();
    redirect(res, route);
    return true;
  }
  if (post && match[2] === "activate") {
    if (!invited) throw new PilotHttpError(403, "pilot_invitation_required", "Your setup is saved. Activation is limited to invited pilot owners.");
    const form = await readPilotForm(req);
    if (form.get("review_version") !== business.updatedAt.toISOString()) throw changedBusiness();
    if (!business.selectedLocationId || form.get("merchant_matches") !== "yes") throw new PilotHttpError(400, "business_review_required", "Review your selected location and confirm it matches your business.");
    const rawName = form.get("name") ?? "";
    const rawDescription = form.get("description") ?? "";
    const name = sanitize(rawName.trim(), { maxLength: 160 });
    if (!name || rawName.length > 160 || rawDescription.length > 1_000) throw new PilotHttpError(400, "profile_invalid", "Use a business name of up to 160 characters and description of up to 1,000.");
    const selection = {
      selectedLocationId: business.selectedLocationId,
      enabledServiceIds: [...form.entries()].filter(([key, value]) => key.startsWith("service_") && value === "yes").map(([key]) => key.slice(8)),
      policyReviewed: form.get("policy_reviewed") === "yes", noPaymentObligations: form.get("no_payment_obligations") === "yes",
    };
    const catalog = await web.catalog.validateActivation(session, business.id, selection);
    if (form.get("catalog_digest") !== catalogReviewDigest(catalog)) {
      throw new PilotHttpError(409, "square_review_changed", "Square's services or booking rules changed after you opened this page. Review the current details before activating.");
    }
    const now = new Date();
    const active = await store.businesses.activate({
      ownerId: session.userId, sessionHash: session.sessionHash, businessId: business.id, environment: config.environment,
      connectionVersion: catalog.connectionVersion, expectedUpdatedAt: business.updatedAt, name, now,
      profile: { ...business.profile, description: sanitize(rawDescription, { maxLength: 1_000 }),
        enabledServiceIds: selection.enabledServiceIds, policyReviewed: true, noPaymentObligations: true,
        reviewedAt: now.toISOString(), review: { merchantId: catalog.merchantId, locationId: business.selectedLocationId,
          policy: catalog.policy, services: catalog.services.filter((service) => selection.enabledServiceIds.includes(service.id)) } },
    });
    if (!active) throw changedBusiness();
    web.html(res, 200, "Your business is active", activationComplete(active, config.origin), true);
    return true;
  }
  return false;
}

function changedBusiness(): PilotHttpError {
  return new PilotHttpError(409, "business_changed", "Your business or Square connection changed during review. Open the current review page before activating.");
}
