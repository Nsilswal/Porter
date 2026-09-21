/**
 * Validate the submission packet against Muse's own rules.
 *
 * These checks are not invented. They are the client-side validator from
 * Muse's shipped `PlatformSubmissionForm` bundle, re-verified against the live
 * page on 2026-09-21. Running this before pasting means the form should not
 * reject anything.
 *
 *   pnpm submission:validate
 */
import { readFileSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** Required fields, from the validator's constant `C`. */
const REQUIRED = [
  "productName",
  "companyName",
  "website",
  "useCases",
  "payments",
  "contactName",
  "contactEmail",
  "support",
  "privacyUrl",
  "productTerms",
  "connectionType",
  "endpoint",
  "documentationUrl",
  "limits",
] as const;

/** Fields validated as http or https URLs, from the constant `N`. */
const HTTP_URL_FIELDS = ["website", "documentationUrl", "privacyUrl", "productTerms"] as const;

const AUTH_METHODS = ["API keys", "OAuth with PKCE", "Other"];

export interface ValidationIssue {
  readonly field: string;
  readonly message: string;
}

export function validateSubmission(packet: Record<string, unknown>, iconPath: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const fail = (field: string, message: string) => issues.push({ field, message });
  const str = (k: string) => (typeof packet[k] === "string" ? (packet[k] as string) : "");
  /** A field still awaiting a human. Its format is not checked twice. */
  const pending = (k: string) => str(k).includes("REPLACE_ME");

  for (const field of REQUIRED) {
    if (str(field).trim().length === 0) fail(field, "This field is required.");
  }

  // Anything left unfilled is a human's job. Terms 2.1 requires accuracy.
  for (const [key, value] of Object.entries(packet)) {
    if (typeof value === "string" && value.includes("REPLACE_ME")) {
      fail(key, "Still contains a REPLACE_ME placeholder. Fill this in before submitting.");
    }
  }

  // Muse counts code points, not UTF-16 units.
  if ([...str("productName")].length > 80) fail("productName", "Use 80 characters or fewer.");
  if ([...str("companyName")].length > 120) fail("companyName", "Use 120 characters or fewer.");

  if (!pending("contactEmail") && !/^\S+@\S+\.\S+$/.test(str("contactEmail").trim())) {
    fail("contactEmail", "Enter a valid email address.");
  }

  // support accepts an email address OR an http(s) URL.
  const support = str("support").trim();
  if (!pending("support") && support && !/^\S+@\S+\.\S+$/.test(support) && !isUrl(support, ["http:", "https:"])) {
    fail("support", "Enter a valid email address or URL.");
  }

  // The endpoint must be HTTPS. Muse runs in Meta's cloud, so a local server
  // is unreachable regardless.
  const endpoint = str("endpoint").trim();
  if (!pending("endpoint") && endpoint && !isUrl(endpoint, ["https:"])) fail("endpoint", "Enter a valid HTTPS URL.");

  for (const field of HTTP_URL_FIELDS) {
    if (pending(field)) continue;
    const value = str(field).trim();
    if (value && !isUrl(value, ["http:", "https:"])) fail(field, "Enter a valid HTTP or HTTPS URL.");
  }

  const connectionType = str("connectionType");
  if (connectionType !== "API" && connectionType !== "MCP") {
    fail("connectionType", 'Must be "API" (Raw API) or "MCP" (Existing MCP).');
  }
  if (connectionType === "API") {
    const openapi = str("openapi").trim();
    if (openapi && !isUrl(openapi, ["http:", "https:"])) fail("openapi", "Enter a valid HTTP or HTTPS URL.");
  }

  const payments = str("payments");
  if (payments !== "accepts_payments" && payments !== "does_not_accept_payments") {
    fail("payments", 'Must be "accepts_payments" or "does_not_accept_payments".');
  }

  const authMethods = Array.isArray(packet.authMethods) ? (packet.authMethods as string[]) : [];
  for (const method of authMethods) {
    if (!AUTH_METHODS.includes(method)) fail("authMethods", `Unknown auth method "${method}".`);
  }
  if (authMethods.includes("Other") && str("authOther").trim().length === 0) {
    fail("authOther", "Describe the other authentication method.");
  }

  issues.push(...validateIcon(iconPath));

  // All three attestations are mandatory. They are a human's to make, so this
  // only reports when they are still unticked.
  for (const field of ["authorized", "termsAccepted", "distributionUnderstood"] as const) {
    if (packet[field] !== true) fail(field, "Attestation not yet confirmed. A person must tick this on the form.");
  }

  return issues;
}

/**
 * Icon rules, enforced byte-level by Muse in the browser:
 * PNG or SVG, exactly 512x512, 256 KiB or smaller, contents matching extension.
 */
export function validateIcon(iconPath: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  let bytes: Buffer;
  try {
    bytes = readFileSync(iconPath);
  } catch {
    return [{ field: "brandFiles", message: `Icon not found at ${iconPath}` }];
  }

  const size = statSync(iconPath).size;
  if (size === 0) issues.push({ field: "brandFiles", message: "Choose a non-empty PNG or SVG connector icon." });
  if (size > 262144) issues.push({ field: "brandFiles", message: "The connector icon must be 256 KiB or smaller." });

  if (iconPath.endsWith(".png")) {
    const signature = [137, 80, 78, 71, 13, 10, 26, 10];
    const ok = bytes.length >= 24 && signature.every((b, i) => bytes[i] === b);
    if (!ok) {
      issues.push({ field: "brandFiles", message: "Choose a PNG or SVG file whose contents match its extension." });
    } else {
      // Muse reads the IHDR width and height at byte offsets 16 and 20.
      const width = bytes.readUInt32BE(16);
      const height = bytes.readUInt32BE(20);
      if (width !== 512 || height !== 512) {
        issues.push({ field: "brandFiles", message: `PNG icons must be exactly 512x512 pixels (this one is ${width}x${height}).` });
      }
    }
  } else if (iconPath.endsWith(".svg")) {
    const text = bytes.toString("utf8");
    const hasDims = /width=["']512["']/.test(text) && /height=["']512["']/.test(text);
    const hasViewBox = /viewBox=["']0 0 512 512["']/.test(text);
    if (!hasDims && !hasViewBox) {
      issues.push({ field: "brandFiles", message: "SVG icons must use 512x512 dimensions or viewBox." });
    }
  } else {
    issues.push({ field: "brandFiles", message: "Choose a PNG or SVG file." });
  }

  return issues;
}

function isUrl(value: string, protocols: readonly string[]): boolean {
  try {
    return protocols.includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

// ----------------------------------------------------------------- CLI

if (import.meta.url === `file://${process.argv[1]}`) {
  const packetPath = resolve(here, "connector-submission.json");
  const packet = JSON.parse(readFileSync(packetPath, "utf8")) as Record<string, unknown>;
  const iconPath = resolve(here, String(packet.brandFiles ?? "assets/porter-icon-512.png"));

  const issues = validateSubmission(packet, iconPath);
  const blocking = issues.filter((i) => !i.message.startsWith("Attestation") && !i.message.includes("REPLACE_ME"));
  const human = issues.filter((i) => i.message.startsWith("Attestation") || i.message.includes("REPLACE_ME"));

  if (blocking.length === 0) {
    console.log(human.length === 0 ? "Muse form rules: PASS — ready to submit" : "Muse form rules: PASS");
  } else {
    console.log(`Muse form rules: ${blocking.length} problem(s)`);
    for (const i of blocking) console.log(`  [${i.field}] ${i.message}`);
  }

  if (human.length > 0) {
    console.log(`\nStill needs a person (${human.length}):`);
    for (const i of human) console.log(`  [${i.field}] ${i.message}`);
  }

  process.exit(blocking.length === 0 ? 0 : 1);
}
