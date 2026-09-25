import { createPilotStore } from "@porter/db";
import { SquareOAuthClient } from "@porter/adapter-square-appointments";
import type { PilotConfig } from "./config.js";
import { PilotAccounts } from "./accounts.js";
import { MerchantConnections } from "./connections.js";
import { createFileMailer, createResendMailer } from "./mail.js";
import { PilotWeb } from "./web.js";

export async function createPilotRuntime(config: PilotConfig, databaseUrl: string, encryptionKey: string): Promise<PilotWeb> {
  const store = await createPilotStore({ connectionString: databaseUrl, encryptionKey: Buffer.from(encryptionKey, "hex"), maxConnections: 5 });
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
    return new PilotWeb({ config, store, accounts, connections });
  } catch (error) {
    await store.close();
    throw error;
  }
}
