# Rescened repository guidance

## Project shape

- The product and npm packages are named **Rescened**. The checkout or remote may still use the legacy name `albumboxd`; do not rename paths, remotes, packages, or product copy unless the task explicitly requires it.
- The repository root is a CommonJS Node.js/Express/Mongoose API. `frontend/` is a separate React/Vite ES-module package.
- Treat the root and `frontend/` as separate npm projects with separate lockfiles. Run commands from the correct package and preserve both lockfiles when dependencies change.
- Root `.env` values are server-side; `frontend/.env` is separate and may contain only browser-safe `VITE_*` values. Never expose `MONGO_URI`, `CLERK_SECRET_KEY`, moderator IDs, or other server secrets through Vite configuration or client code.

## Catalog and identity invariants

- `AlbumCatalog` is the authoritative public catalog. Search, album detail, reviews, likes, profiles, activity, and boards use local catalog records.
- Public albums use immutable Rescened UUID-v4 `albumId` values. MongoDB `_id` values are internal relation and pagination keys; never expose them as public resource identifiers.
- Keep public IDs distinct by domain: use `albumId`, `trackId`, and `submissionId` as defined by their models. Never place an upstream provider ID in `albumId`.
- External search results are discovery candidates, not catalog albums. They must remain visibly distinct and cannot be saved, reviewed, liked, or opened as `/album/:albumId`. Only approved community publication or the catalog importer may create a public album.
- Preserve provider-neutral catalog behavior. Spotify API credentials, Spotify catalog identity, and Spotify metadata dependencies must not return. User profile links to Spotify are the narrow allowed exception. `npm run check:catalog-contract` helps detect known regressions but is not exhaustive; review new paths and extend the guard when its scan roots or rules do not cover them.
- Preserve field provenance and ownership. Automated imports must not overwrite manual or community-owned fields, clear an existing cover with a blank value, or delete albums merely because they are absent from a later dataset.
- Album-bearing social responses should resolve current display metadata from `AlbumCatalog` instead of adding new denormalized album snapshots.
- A user's saved shelf is the deduplicated union of albums across every board they own. Removing one board membership must not make an album appear unsaved while another owned board still contains it.

## API, authorization, and moderation

- Clerk authentication and server-side authorization are the security boundary. A protected frontend route is never sufficient authorization for an API mutation.
- Contributor mutations require `COMMUNITY_SUBMISSIONS_ENABLED=true`. Moderator commands require `COMMUNITY_MODERATION_ENABLED=true`, Clerk authentication, and membership in `MODERATOR_USER_IDS`. Preserve the existing read behavior when a mutation flag is disabled.
- Normalize and validate request bodies before writes, reject unknown or client-owned workflow fields, and apply the relevant rate limit before persistence.
- Preserve stable HTTP status/error-code contracts and `Retry-After` behavior when changing endpoints or frontend error handling.
- Submission revisions and moderation history are append-only. Keep status transitions server-authored and conditional; stale or concurrent commands must return conflicts rather than silently overwrite state.
- Pending, needs-changes, rejected, duplicate, and withdrawn submissions are not public catalog records. Approval is transactional and idempotent: catalog publication, submission transition, and audit history succeed or fail together.
- Catalog import and moderation approval require a transaction-capable replica set or sharded MongoDB deployment. Do not add unsafe create-then-update fallbacks for standalone MongoDB.

## External providers and tests

- Isolate provider integrations behind explicit adapters. Put new user-facing provider paths behind disabled-by-default feature flags; operator-only fetch/import CLIs remain explicitly invoked commands. Normalize provider responses before they reach routes or UI, and preserve the local-catalog path when an upstream service times out, rate-limits, returns malformed data, or is unavailable.
- Use identifying user agents, bounded timeouts/retries, `Retry-After`, request gating, and caching in accordance with the existing provider modules. Do not introduce automatic retry loops in the UI.
- Normal tests must not contact live providers. Use checked-in fixtures for provider behavior; run live-provider tests only when the user explicitly requests them.
- Preserve source licensing and provenance. MusicBrainz/ListenBrainz core data and Cover Art Archive images have different rights boundaries; linked artwork is not implicitly licensed for copying or rehosting.

## Data-changing operator work

- Catalog imports, cover backfills, and legacy migrations are dry-run-first workflows. Inspect the selected environment and generated reports before any apply step.
- A catalog import applies the exact reviewed, checksummed dataset; a legacy migration applies the exact sealed plan. Cover backfill applies only after review of its dry-run report, then intentionally re-resolves candidates under guarded writes. Every apply requires explicit user authorization for the named target. Never infer production-write permission from a request to inspect, plan, validate, or dry-run.
- Retain checksums and reports. Distinguish a rolled-back transaction from a committed database change whose report finalization or later verification failed.
- Keep database backups, restored legacy data, credentials, and `.env` contents out of the repository. Never extract a sensitive legacy archive into the working tree or rewrite shared Git history as an incidental cleanup.

## Verification

- Run checks proportional to the changed surface and report skipped or unavailable checks explicitly.
- Backend or shared JavaScript changes: `npm test`.
- MongoDB transaction, concurrency, import, approval, backfill, or migration changes: `npm run test:integration` in addition to focused tests.
- Catalog identity, provider, importer, search, or album-bearing surface changes: `npm run check:catalog-contract`.
- Frontend changes: `npm --prefix frontend run lint` and `npm --prefix frontend run build`.
- A full release/readiness gate is: `npm test`, `npm run test:integration`, `npm run check:catalog-contract`, `npm --prefix frontend run lint`, and `npm --prefix frontend run build`.
- Do not treat a dated checked-in report, old test count, or successful server startup as proof of the current database state. When running locally, `/health` must report `status: "ok"`, not `degraded`.

## Documentation

- Update the relevant maintained guide when behavior, configuration, data contracts, operator steps, or rollout expectations change. Do not duplicate an entire runbook in a second document.

## Code Review Rules

- Flag public Mongo IDs, provider results masquerading as catalog albums, authorization enforced only in the UI, non-transactional publication fallbacks, live-network unit tests, or data applies that bypass reviewable artifacts. Safe paths are public Rescened IDs, a distinct external-candidate shape, server-side checks, transaction-or-503 behavior, captured fixtures, and an exact reviewed dry-run artifact.
