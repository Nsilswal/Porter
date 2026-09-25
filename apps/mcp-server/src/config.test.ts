import { describe, expect, it } from "vitest";
import { loadConfig, validateStorageConfig } from "./config.js";
import { AuthServer } from "./auth.js";

describe("storage configuration", () => {
  const signing = "test-signing-key-at-least-32-characters";
  it("keeps an unconfigured demo usable without a database", () => {
    const config = loadConfig({ PORTER_STORAGE: "", DATABASE_URL: "" });
    expect(config.storage).toBe("memory");
    expect(() => validateStorageConfig(config)).not.toThrow();
  });

  it("selects postgres from DATABASE_URL and requires independent durable secrets", () => {
    expect(() => loadConfig({ DATABASE_URL: "postgres://localhost/porter" })).toThrow("PORTER_SIGNING_SECRET");
    const config = loadConfig({ DATABASE_URL: "postgres://localhost/porter", PORTER_SIGNING_SECRET: signing });
    expect(config.storage).toBe("postgres");
    expect(() => validateStorageConfig(config)).toThrow("PORTER_ENCRYPTION_KEY");
    expect(() => validateStorageConfig({ ...config, encryptionKey: "ab".repeat(32) })).not.toThrow();
    expect(() => validateStorageConfig({ ...config, encryptionKey: "z".repeat(64) })).toThrow("PORTER_ENCRYPTION_KEY");
  });

  it("refuses non-demo memory storage instead of silently losing appointments", () => {
    expect(() => validateStorageConfig({ ...loadConfig({}), demoMode: false })).toThrow("PostgreSQL");
  });

  it("requires persistence for providers even when the mock demo is also enabled", () => {
    const config = loadConfig({});
    for (const provider of [
      { squareAccessToken: "square-test" },
      { jobberAccessToken: "jobber-test" },
      { squarePublicSourcesPath: "public-sources.json" },
      { stripeSecretKey: "stripe-test" },
    ]) {
      expect(() => validateStorageConfig({ ...config, ...provider })).toThrow("PostgreSQL");
    }
  });

  it("resolves PostgreSQL overrides before deciding whether to generate a signing secret", () => {
    expect(() => loadConfig({}, { storage: "postgres", databaseUrl: "postgres://localhost/porter" })).toThrow("PORTER_SIGNING_SECRET");
    expect(() => loadConfig({}, { databaseUrl: "postgres://localhost/porter" })).toThrow("PORTER_SIGNING_SECRET");
    const config = loadConfig({ NODE_ENV: "production" }, {
      databaseUrl: "postgres://localhost/porter", signingSecret: signing, encryptionKey: "ab".repeat(32),
    });
    expect(config.storage).toBe("postgres");
    expect(() => validateStorageConfig(config)).not.toThrow();
    expect(() => validateStorageConfig({ ...config, signingSecret: config.encryptionKey! })).toThrow("different values");
  });

  it("rejects misspelled storage modes", () => {
    expect(() => loadConfig({ PORTER_STORAGE: "postgress" })).toThrow("PORTER_STORAGE");
  });
});

describe("API key verification", () => {
  const auth = new AuthServer({ issuer: "http://localhost", resource: "http://localhost/mcp", apiKeys: { secret: "user_test" }, oauthEnabled: false });
  it("does not authenticate inherited object properties", () => {
    for (const key of ["toString", "constructor", "__proto__"]) {
      expect(auth.authenticate(`Bearer ${key}`)).toBeNull();
      expect(auth.authenticate(undefined, key)).toBeNull();
    }
  });
  it("requires one complete bearer value", () => {
    expect(auth.authenticate("Bearer secret trailing")).toBeNull();
    expect(auth.authenticate("Bearer secret")?.userId).toBe("user_test");
    expect(auth.authenticate(undefined, "secret")?.userId).toBe("user_test");
  });
});
