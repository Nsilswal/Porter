import { PorterError } from "@porter/shared";

/**
 * Handing control back to the human.
 *
 * A browser-driven adapter will hit things an agent cannot and should not get
 * past: CAPTCHAs, bot checks, login walls, age gates. Porter does not try to
 * solve any of them. It stops and returns a URL for the person to open.
 *
 * This is the same shape as the payment path, where a bank demanding 3-D
 * Secure produces a distinct error with an approval URL rather than a generic
 * failure. In both cases the agent's job is to explain and hand over, not to
 * push through.
 */
export type BlockReason = "captcha" | "bot_check" | "login_required" | "age_gate" | "rate_limited" | "unknown";

const MESSAGES: Record<BlockReason, string> = {
  captcha: "This business's site is asking for a human check. Open the link and complete it, then ask me again.",
  bot_check: "This business's site blocked an automated visit. Open the link and continue there.",
  login_required: "This business's site wants you signed in. Open the link, sign in, then ask me again.",
  age_gate: "This business's site needs you to confirm your age. Open the link to continue.",
  rate_limited: "This business's site is asking us to slow down. Try again in a few minutes.",
  unknown: "We could not complete that on this business's site. Open the link to finish it yourself.",
};

export function humanActionRequired(reason: BlockReason, url: string, detail?: Record<string, unknown>): PorterError {
  return new PorterError("HUMAN_ACTION_REQUIRED", MESSAGES[reason], {
    details: { reason, url, ...detail },
    ...(reason === "rate_limited" ? { retryAfterSeconds: 300 } : {}),
  });
}

const CAPTCHA_MARKERS = [
  /recaptcha/i,
  /hcaptcha/i,
  /cf-turnstile/i,
  /g-recaptcha/i,
  /are you a robot/i,
  /verify you are human/i,
];
const BOT_MARKERS = [/access denied/i, /request blocked/i, /unusual traffic/i, /cf-error-details/i, /perimeterx/i, /datadome/i];
const LOGIN_MARKERS = [/sign in to continue/i, /please log in/i, /<input[^>]+type=["']password["']/i];

/**
 * Detect a wall before trying to parse a page as content.
 *
 * Scraping a block page as though it were real data is how a scraper starts
 * silently returning nonsense, so this runs first and fails loudly.
 */
export function detectBlock(status: number, html: string): BlockReason | null {
  if (status === 429) return "rate_limited";
  if (status === 401) return "login_required";
  if (status === 403) {
    return CAPTCHA_MARKERS.some((m) => m.test(html)) ? "captcha" : "bot_check";
  }
  if (status >= 500) return null;

  if (CAPTCHA_MARKERS.some((m) => m.test(html))) return "captcha";
  if (BOT_MARKERS.some((m) => m.test(html))) return "bot_check";
  if (LOGIN_MARKERS.some((m) => m.test(html))) return "login_required";
  return null;
}
