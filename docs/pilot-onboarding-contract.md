# Salon onboarding contract

## Website suggestions

The importer reads one public HTTP(S) HTML document. It checks robots policy, validates every DNS answer and redirect, and pins the selected public address to the actual connection. It sends no credentials or cookies and executes no website scripts. Network deadlines, wire/decompressed size limits, bounded parsing and a 60 KiB preview limit protect anonymous imports.

The robots implementation is a documented conservative subset in `importer.ts`: unsupported/malformed rules and unavailable policies prevent import. A missing robots file permits normal reading. Pages that require JavaScript, exceed complexity limits or cannot be read produce a manual-review warning. This initial importer does not implement rendered crawling; Mildred remains a reference and can return limited static information.

Names, descriptions and website service text remain suggestions with source URLs. They never establish live prices, availability, staff, payment obligations or booking authority. Unsupported sites can retain a draft without becoming bookable.

Migration v4 persists anonymous previews for the configured lifetime. An opaque token and a separate browser nonce identify a draft; only hashes are stored. Claiming binds it to a live owner/session and creates exactly one business transactionally. Another browser or owner cannot claim it. A same-owner retry returns the original business. Expired or claimed drafts are not readable anonymously. Cleanup of expired rows is separate operational work.

## Authoritative Square review

`OwnerSquareCatalog` reads the authorized merchant's locations, business booking profile, online-booking locations, catalog variations and bookable staff. Requests use fixed Square environment endpoints with bounded pagination/deadlines and no redirects. The owner/session and connection generation are rechecked before returning the snapshot.

Owners select one permanent location, matching their website. Services require an available US/USD location, fixed USD prices, a valid duration, explicit assignments to bookable staff, and a supported in-salon booking configuration. Disabled customer cancellation/rescheduling, positive or malformed cancellation/no-show fees, and known unsupported payment requirements prevent activation. Live booking routing must recheck these rules after activation; a snapshot is not perpetual approval.

The booking profile does not expose every card, deposit or prepayment setting. Owners must review actual Square settings and attest that the selected services require none of those obligations. Missing policy fields remain unknown after attestation. Owner descriptions never override Square's prices or terms.

Activation re-reads provider details, then atomically checks the live owner/session, immutable selected location, business revision, and current connected/unexpired grant version. A concurrent pause, edit, refresh or disconnect makes stale activation fail. Account invitation enforcement belongs to the HTTP layer; the database method is a server-only operation.

## Delivery boundaries

These import, review and storage services are foundations for the public onboarding UI. HTTP routes, active merchant routing, synchronization, owner/operator recovery and actual Muse validation have separate review and test gates. No production booking or notification behavior is established by fixture tests.

Migration v4 is additive and leaves v1–v3 unchanged. A source rollback must retain its migration ledger support or restore a reviewed database backup; do not edit previously applied migration SQL.
