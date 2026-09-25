import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Store, StoredBooking } from "@porter/core";
import { createMemoryStore } from "./memory.js";
import { migratePostgres } from "./migrations.js";
import { createPostgresStore, type PostgresStore } from "./postgres.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const encryptionKey = randomBytes(32);
const schemaName = `porter_provenance_${randomUUID().replaceAll("-", "")}`;
let scopedUrl: string;
let admin: Pool | undefined;

beforeAll(async () => {
  if (!databaseUrl) return;
  admin = new Pool({ connectionString: databaseUrl, max: 2 });
  await admin.query(`CREATE SCHEMA ${schemaName}`);
  const url = new URL(databaseUrl);
  url.searchParams.set("options", `-csearch_path=${schemaName}`);
  scopedUrl = url.toString();
  await migratePostgres(scopedUrl);
});

afterAll(async () => {
  if (!admin) return;
  try {
    await admin.query(`DROP SCHEMA ${schemaName} CASCADE`);
  } finally {
    await admin.end();
  }
});

function booking(): StoredBooking {
  return {
    id: randomUUID(), userId: randomUUID(), adapterId: "pilot-square", providerBookingRef: randomUUID(),
    providerId: `pilot-square:${randomUUID()}`, locationId: "location", serviceId: "haircut",
    providerName: "Example Salon", serviceName: "Haircut", status: "confirmed",
    startsAt: new Date("2027-01-05T14:00:00Z"), endsAt: new Date("2027-01-05T14:30:00Z"),
    priceMinor: 6500, currency: "USD", depositMinor: null, paidMinor: 0,
    createdAt: new Date("2026-09-24T12:00:00Z"), updatedAt: new Date("2026-09-24T12:00:00Z"),
  };
}

for (const mode of ["memory", "postgres"] as const) {
  describe.runIf(mode === "memory" || Boolean(databaseUrl))(`${mode} immutable booking provenance`, () => {
    let store: Store;
    let competingStore: Store;

    beforeEach(async () => {
      if (mode === "memory") {
        store = createMemoryStore();
        competingStore = store;
      } else {
        [store, competingStore] = await Promise.all([
          createPostgresStore({ connectionString: scopedUrl, encryptionKey }),
          createPostgresStore({ connectionString: scopedUrl, encryptionKey }),
        ]);
      }
    });

    afterEach(async () => {
      if (mode === "postgres") {
        await Promise.all([store, competingStore].map((item) => (item as PostgresStore | undefined)?.close()));
      }
    });

    it.each(["userId", "adapterId", "providerBookingRef", "providerId", "locationId", "serviceId"] as const)(
      "rejects a changed %s and preserves the complete original booking",
      async (field) => {
        const original = booking();
        await store.bookings.put(original);
        await expect(competingStore.bookings.put({ ...original, [field]: `different-${randomUUID()}`, status: "cancelled" }))
          .rejects.toThrow("A booking's owner and provider identity cannot change");
        await expect(store.bookings.get(original.userId, original.id)).resolves.toEqual(original);
      },
    );

    it("allows time, status and price changes while preserving original creation time and routing", async () => {
      const original = booking();
      await store.bookings.put(original);
      const updated: StoredBooking = {
        ...original,
        startsAt: new Date("2027-01-06T15:00:00Z"), endsAt: new Date("2027-01-06T15:30:00Z"),
        status: "cancelled", priceMinor: 7000, updatedAt: new Date("2026-09-25T12:00:00Z"),
      };
      await competingStore.bookings.put({ ...updated, createdAt: new Date("2026-09-25T12:00:00Z") });
      await expect(store.bookings.get(original.userId, original.id)).resolves.toEqual(updated);
    });

    it("rejects rerouting during a competing valid update", async () => {
      const original = booking();
      await store.bookings.put(original);
      const updated: StoredBooking = { ...original, status: "cancelled", updatedAt: new Date("2026-09-25T12:00:00Z") };
      const results = await Promise.allSettled([
        store.bookings.put(updated),
        competingStore.bookings.put({ ...original, providerId: `pilot-square:${randomUUID()}`, locationId: "other-location" }),
      ]);
      expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
      await expect(store.bookings.get(original.userId, original.id)).resolves.toEqual(updated);
    });
  });
}
