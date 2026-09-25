import { resolve } from "node:path";
import type { SquareEnvironment } from "@porter/db";

export interface PilotConfig {
  readonly origin: string;
  readonly environment: SquareEnvironment;
  readonly applicationId: string;
  readonly applicationSecret: string;
  readonly email: { readonly mode: "file"; readonly directory: string } | { readonly mode: "resend"; readonly apiKey: string; readonly from: string };
  readonly invitedEmails: readonly string[];
  readonly operatorEmails: readonly string[];
  /** Local integration testing only; never part of the customer setup journey. */
  readonly internalApiKeys?: boolean;
  readonly museConnectorUrl?: string;
}

/** Pilot startup is explicit and independent of the temporary global Square token. */
export function loadPilotConfig(env: NodeJS.ProcessEnv, issuer: string): PilotConfig | undefined {
  if (env.PORTER_PILOT_ENABLED !== "true") return undefined;
  const environment = env.PORTER_SQUARE_ENVIRONMENT ?? "sandbox";
  if (environment !== "sandbox" && environment !== "production") throw new Error("PORTER_SQUARE_ENVIRONMENT must be sandbox or production");
  const url = new URL(issuer);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.origin !== issuer || url.username || url.password || url.search || url.hash ||
    (url.protocol !== "https:" && !(environment === "sandbox" && loopback && url.protocol === "http:"))) {
    throw new Error("The pilot issuer must be an HTTPS origin, or loopback HTTP for sandbox development");
  }
  const applicationId = env.PORTER_SQUARE_APPLICATION_ID ?? "";
  const applicationSecret = env.PORTER_SQUARE_APPLICATION_SECRET ?? "";
  if (!applicationId || !applicationSecret) throw new Error("Square application ID and secret are required for merchant authorization");
  const internalApiKeys = env.PORTER_INTERNAL_API_KEYS === "true";
  if (internalApiKeys && (env.NODE_ENV === "production" || !loopback || environment !== "sandbox")) throw new Error("Internal API keys are restricted to local sandbox testing");
  const museConnectorUrl = env.PORTER_MUSE_CONNECTOR_URL;
  if (museConnectorUrl) {
    const connectorUrl = new URL(museConnectorUrl);
    if (connectorUrl.origin !== "https://muse.ai" || connectorUrl.username || connectorUrl.password || connectorUrl.hash) throw new Error("Use the approved Muse connector's HTTPS URL");
  }
  const emailMode = env.PORTER_EMAIL_MODE ?? "file";
  let email: PilotConfig["email"];
  if (emailMode === "file") {
    if (env.NODE_ENV === "production" || !loopback || environment !== "sandbox") {
      throw new Error("File email delivery is available only for a local sandbox pilot");
    }
    email = { mode: "file", directory: resolve(env.PORTER_EMAIL_OUTBOX ?? ".porter/mail") };
  } else if (emailMode === "resend" && env.PORTER_RESEND_API_KEY && env.PORTER_EMAIL_FROM) {
    email = { mode: "resend", apiKey: env.PORTER_RESEND_API_KEY, from: env.PORTER_EMAIL_FROM };
  } else {
    throw new Error("Configure sign-in email delivery with PORTER_EMAIL_MODE, PORTER_RESEND_API_KEY and PORTER_EMAIL_FROM");
  }
  return {
    origin: issuer, environment, applicationId, applicationSecret, email, internalApiKeys,
    ...(museConnectorUrl ? { museConnectorUrl } : {}),
    invitedEmails: emailList(env.PORTER_PILOT_INVITED_EMAILS),
    operatorEmails: emailList(env.PORTER_OPERATOR_EMAILS),
  };
}

function emailList(value: string | undefined): string[] {
  const emails = (value ?? "").split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  if (emails.some((email) => email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
    throw new Error("Pilot email allowlists must contain valid comma-separated email addresses");
  }
  return [...new Set(emails)];
}
