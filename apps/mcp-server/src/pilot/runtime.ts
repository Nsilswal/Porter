import { createCustomerOAuthStore, createPilotStore, type CustomerOAuthStore } from "@porter/db";
import { SquareOAuthClient } from "@porter/adapter-square-appointments";
import type { PilotConfig } from "./config.js";
import { PilotAccounts } from "./accounts.js";
import { MerchantConnections } from "./connections.js";
import { createFileMailer, createResendMailer } from "./mail.js";
import { PilotWeb } from "./web.js";
import { CustomerOAuth } from "./customer-oauth.js";

export async function createPilotRuntime(config: PilotConfig, databaseUrl: string, encryptionKey: string): Promise<PilotWeb> {
  const store = await createPilotStore({ connectionString: databaseUrl, encryptionKey: Buffer.from(encryptionKey, "hex"), maxConnections: 5 });
  let oauthStore: CustomerOAuthStore | undefined;
  try {
    const oauth = new SquareOAuthClient({
      environment: config.environment, applicationId: config.applicationId,
      applicationSecret: config.applicationSecret, redirectUri: `${config.origin}/square/callback`,
    });
    const mailer = config.email.mode === "file"
      ? createFileMailer(config.email.directory)
      : createResendMailer(config.email.apiKey, config.email.from);
    const accounts = new PilotAccounts(store, mailer, config.origin);
    const connections = new MerchantConnections({ store, oauth, environment: config.environment });
    oauthStore = await createCustomerOAuthStore({ connectionString: databaseUrl, encryptionKey: Buffer.from(encryptionKey, "hex"), maxConnections: 3 });
    const customerOAuth = new CustomerOAuth({ store: oauthStore, pilotStore: store, origin: config.origin, sandbox: config.environment === "sandbox" });
    return new PilotWeb({ config, store, accounts, connections, oauth: customerOAuth, oauthStore });
  } catch (error) {
    await Promise.allSettled([store.close(), oauthStore?.close()]);
    throw error;
  }
}
