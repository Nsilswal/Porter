import { createFetchHttpClient, type Logger } from "@porter/shared";
import type { ProviderAdapter } from "@porter/core";
import { createMockAdapter } from "@porter/adapter-mock";
import { createSquareAdapter } from "@porter/adapter-square-appointments";
import { createJobberAdapter } from "@porter/adapter-jobber";
import { createWebAdapter, type WebSource } from "@porter/adapter-web";
import { createSquarePublicAdapter, type SquarePublicSource } from "@porter/adapter-square-public";
import { readFileSync } from "node:fs";
import type { PorterConfig } from "./config.js";

export interface AdapterRegistry {
  readonly adapters: ProviderAdapter[];
  /** Per-adapter credentials, handed to AdapterContext for one call at a time. */
  readonly credentials: Record<string, Record<string, string>>;
}

/**
 * Decide which platforms this instance talks to.
 *
 * The mock adapter is always present in demo mode, because Meta's review runs
 * end-to-end tests and a reviewer must be able to complete a full booking
 * without a real merchant account.
 *
 * Square and Jobber are enabled only when a token is configured, and both
 * default to sandbox hosts. They stay off unless someone deliberately turns
 * them on.
 *
 * Two gates before either may point at a real account:
 *
 *  1. Upstream rights clearance. Connector Terms 4.2 requires Porter to
 *     represent it can sublicense provider data to Meta under 3.1, and
 *     section 8 makes Porter indemnify Meta for it. Square's and Jobber's
 *     developer terms have not been reviewed yet.
 *  2. Fixture re-recording. Both adapters are currently tested against fakes
 *     built from published documentation, not from recorded sandbox traffic.
 *     Jobber's mutation inputs in particular are inferred — see the header of
 *     packages/adapters/jobber/src/api.ts.
 */
export function buildAdapters(config: PorterConfig, log: Logger): AdapterRegistry {
  const adapters: ProviderAdapter[] = [];
  const credentials: Record<string, Record<string, string>> = {};
  const http = createFetchHttpClient();

  if (config.demoMode) {
    adapters.push(
      createMockAdapter({
        latencyMs: config.adapterLatencyMs,
        failureRate: config.adapterFailureRate,
      }),
    );
  }

  if (config.squareAccessToken) {
    adapters.push(createSquareAdapter({ http, baseUrl: config.squareBaseUrl }));
    credentials.square = { accessToken: config.squareAccessToken };
    log.warn("square_adapter_enabled", { baseUrl: config.squareBaseUrl });
  }

  if (config.jobberAccessToken) {
    adapters.push(createJobberAdapter({ http }));
    credentials.jobber = { accessToken: config.jobberAccessToken };
    log.warn("jobber_adapter_enabled", {});
  }

  // Public-page reading, off unless a source list is given. It is deliberately
  // separate from the API adapters: the Muse Connector Policies prohibit
  // "violating robots.txt", so a Muse-facing deployment leaves this unset and
  // the submission stays accurate to what actually ships.
  if (config.webSourcesPath) {
    try {
      const sources = JSON.parse(readFileSync(config.webSourcesPath, "utf8")) as WebSource[];
      if (sources.length > 0) {
        adapters.push(createWebAdapter({ http, sources }));
        log.warn("web_adapter_enabled", { sources: sources.length, note: "read-only; writes escalate to the user" });
      }
    } catch (error) {
      log.error("web_sources_unreadable", { path: config.webSourcesPath, cause: String(error) });
    }
  }

  // Square's public booking pages. Reads what a merchant already publishes,
  // so it covers businesses that have not connected an account. Read-only:
  // booking hands the user a link to the business's own page.
  if (config.squarePublicSourcesPath) {
    try {
      const sources = JSON.parse(readFileSync(config.squarePublicSourcesPath, "utf8")) as SquarePublicSource[];
      if (sources.length > 0) {
        adapters.push(createSquarePublicAdapter({ http, sources }));
        log.warn("square_public_adapter_enabled", { sources: sources.length, note: "read-only; booking escalates to the user" });
      }
    } catch (error) {
      log.error("square_public_sources_unreadable", { path: config.squarePublicSourcesPath, cause: String(error) });
    }
  }

  if (adapters.length === 0) {
    throw new Error("No adapters configured. Enable demo mode or provide provider credentials.");
  }

  return { adapters, credentials };
}
