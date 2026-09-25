# Persistent store

`createPostgresStore({ connectionString, encryptionKey })` opens an already migrated database. It implements the core store ports, plus `health()` and idempotent `close()`. Close the store during application shutdown.

`encryptionKey` is a 32-byte deployment secret, independent of the confirmation signing secret. Keep it stable and back it up securely. User encryption keys are wrapped with AES-256-GCM and bound to their user IDs. Startup checks an encrypted canary so an incorrect deployment key prevents the server from accepting traffic. There is no automatic key rotation; changing the secret without migrating the wrapped keys loses access to stored encrypted results.

## Migrations

Run the explicit release step with `DATABASE_URL` set:

```sh
pnpm build
node --env-file-if-exists=.env packages/db/dist/migrate.js
```

The application never creates tables on startup. Ordered migration SQL lives in `src/migrations.ts`; `src/schema.ts` supplies the corresponding typed Drizzle mappings. Add a new migration for each future schema change; never edit a migration applied to a shared database. Each migration is checksummed, and the migration runner holds a transaction-level advisory lock across the entire upgrade. Unsupported or edited migration history fails closed. The initial migration expects an empty database/schema. An existing unversioned database needs an explicit reviewed import/baseline procedure.

Do not use `drizzle-kit push` as a deployment step: it bypasses this migration ledger.

## Retry and ownership rules

- Booking IDs are globally unique. Updates cannot transfer a booking to a different owner or provider reference. Payments must refer to a booking owned by the same user.
- Existing booking mutations require a durable guard before reading current booking state. Only one request can own a booking's guard, including across server instances; only that exact user/booking/tool/request identity can release it. Uncertain requests retain their guards, without expiry. A crash can leave a guard pending manual reconciliation. The guard does not hold a database session or transaction open during a provider request.
- Reserving an idempotency key is atomic across server instances. `expiresAt` is retention metadata; no stored key is automatically released by time. A completed key always replays its original result.
- Mark an external operation `uncertain` before sending the write. Its durable identity supports reconciliation; uncertain reservations cannot be released. Complete only after the result is known and stored. Retrying an uncertain request must not issue another unverified provider write.
- Confirmation consumption is atomic. Expired token rows can be removed only after the corresponding signed token is no longer accepted.
- Delete payments before bookings when reporting deletion counts; foreign keys also cascade payment deletion if a booking is removed directly. Deletion of the wrapped user key makes old encrypted results unreadable. Audit records retain pseudonymous actor IDs and need a separately defined retention policy.

## Tests

The storage contract runs against memory on every test run. Set `TEST_DATABASE_URL` to an expendable PostgreSQL database to also run real concurrency, restart, migration, ownership, and encryption checks:

```sh
TEST_DATABASE_URL=postgres://porter:porter@127.0.0.1:55432/porter pnpm exec vitest run packages/db/src/store.test.ts
```

Tests create and delete uniquely named schemas. They require schema-creation privileges and do not mutate application tables in the default schema. Without `TEST_DATABASE_URL`, PostgreSQL cases are explicitly skipped; a passing memory-only run does not verify PostgreSQL.
