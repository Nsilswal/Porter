import { describe, expect, it } from "vitest";
import { loadPilotConfig } from "./config.js";
import { loadConfig, validateStorageConfig } from "../config.js";

const env = { PORTER_PILOT_ENABLED: "true", PORTER_SQUARE_APPLICATION_ID: "sandbox-example", PORTER_SQUARE_APPLICATION_SECRET: "example-secret" };

describe("pilot configuration isolation", () => {
  it("stays disabled unless explicitly enabled", () => {
    expect(loadPilotConfig({}, "http://localhost:8082")).toBeUndefined();
  });
  it("restricts local email files to a loopback sandbox", () => {
    expect(loadPilotConfig(env, "http://localhost:8082")?.email.mode).toBe("file");
    expect(() => loadPilotConfig({ ...env, NODE_ENV: "production" }, "http://localhost:8082")).toThrow("File email");
    expect(() => loadPilotConfig(env, "https://porter.example")).toThrow("File email");
    expect(() => loadPilotConfig({ ...env, PORTER_SQUARE_ENVIRONMENT: "production" }, "https://localhost:8082")).toThrow("File email");
  });
  it("requires a fixed origin and email sender for a public deployment", () => {
    const publicEnv = { ...env, PORTER_EMAIL_MODE: "resend", PORTER_RESEND_API_KEY: "example-email-key", PORTER_EMAIL_FROM: "Porter <signin@example.test>" };
    expect(loadPilotConfig(publicEnv, "https://porter.example")?.email.mode).toBe("resend");
    for (const origin of ["http://porter.example", "https://porter.example/path", "https://user:pass@porter.example", "https://porter.example?redirect=1"]) {
      expect(() => loadPilotConfig(publicEnv, origin)).toThrow();
    }
  });
  it("rejects mixing the pilot with shared keys, demo identities, global provider tokens or memory", () => {
    const pilot = loadPilotConfig(env, "http://localhost:8082");
    const config = loadConfig({}, { pilot, issuer: "http://localhost:8082", databaseUrl: "postgres://localhost/porter", storage: "postgres", encryptionKey: "ab".repeat(32), signingSecret: "signing-secret-long-enough-for-tests", demoMode: false, devOAuthEnabled: false, apiKeys: {} });
    expect(() => validateStorageConfig(config)).not.toThrow();
    for (const override of [{ storage: "memory" as const }, { demoMode: true }, { devOAuthEnabled: true }, { apiKeys: { shared: "demo" } }, { squareAccessToken: "global" }, { stripeSecretKey: "payment" }]) {
      expect(() => validateStorageConfig({ ...config, ...override })).toThrow();
    }
  });
});
