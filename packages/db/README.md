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

## Pilot identities and merchant connections

`createPilotStore` uses the same connection options, startup canary, and migration gate as the core store. It always uses PostgreSQL. Its API is separate from the core booking `Store`; merchant tokens are never customer connector credentials.

- Email identities normalize to a unique address and share the core `users` namespace. A verified email link creates a session only when its token hash and browser nonce hash match. Consuming the link and inserting the session occur in one transaction. Tokens, browser nonces, sessions, and personal connector credentials are stored as SHA-256 hashes only. The application generates high-entropy values and delivers the originals.
- Sessions and customer connector credentials support durable revocation. Lookups reject soft-deleted users. OAuth state binds the owner, session, business, Square environment, and connection version; revocation and consumption serialize through a session row lock. Installing merchant credentials also rechecks the live session after the external token exchange.
- Business reads and writes require the owner, except explicitly server-only routing methods. The first selected location cannot be replaced. Each Square environment/merchant pair belongs to exactly one business, including after disconnect, and a business cannot reconnect to a different merchant. Activation eligibility remains an application responsibility.
- Merchant access and refresh tokens use AES-256-GCM with authenticated context containing the business, environment, and merchant. Ordinary connection views exclude tokens and ciphertext. Only explicit server-only credential methods decrypt them. Expired access tokens remain available for refresh; disconnected and reconnect-required grants do not route requests.
- Refresh uses a version compare-and-swap. OAuth callbacks must present the version saved at authorization start. A disconnect first pauses the business, blocks routing and refresh, and durably retains encrypted revocation credentials. Only the first caller receives credentials for the remote revocation attempt. After Square confirms revocation, finishing the disconnect clears ciphertext. An interrupted or uncertain revocation requires operator reconciliation; it never retries automatically. This prevents a delayed duplicate revocation from revoking a newly authorized grant. A new authorization cannot replace a pending revocation.
- Shared fixed-window rate limits persist only namespaced key hashes. The caller must use a distinct namespace for each policy and supply server time. Expired rate windows, login tokens, sessions, and OAuth states are safe to prune once their expiry has passed; automated retention cleanup is not implemented here.
- Anonymous website imports store a public preview of at most 64 KiB with a hashed draft token and browser nonce. The application supplies a 24-hour expiry and the validated submitted website URL. Claiming requires the same browser and a current owner session; a transaction creates one draft business using the stored URL and original preview. Concurrent same-owner retries return that business, while other owners cannot claim it. Anonymous reads hide expired or claimed drafts. Unclaimed expired drafts can be pruned without deleting businesses; claimed records retain retry identity until their business is deleted.

Authorization, secure cookies, email delivery, consent, OAuth protocol validation, and provider revocation belong to the application layer. Do not expose server-only store methods directly as HTTP endpoints. Revoke external grants before soft-deleting an owner so recovery can still resolve the owner and business.

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
TEST_DATABASE_URL=postgres://porter:porter@127.0.0.1:55432/porter pnpm exec vitest run packages/db/src/store.test.ts packages/db/src/pilot.test.ts packages/db/src/import-drafts.test.ts
```

Tests create and delete uniquely named schemas. They require schema-creation privileges and do not mutate application tables in the default schema. Without `TEST_DATABASE_URL`, PostgreSQL cases are explicitly skipped; a passing memory-only run does not verify PostgreSQL.
