# Phase 2 Community Album Submissions

Status: Phase 2 backend implemented; approved feed and UI are deferred

This document is the source of truth for the Phase 2 contributor and moderator APIs, stored submission data, validation rules, privacy boundary, duplicate signals, approval publication, and deferred follow-up work.

## Current scope

Phase 2a lets an authenticated Clerk user:

- Submit a proposed album with evidence.
- List their submission history.
- Read one of their submissions.
- Revise a submission after a moderator requests changes.
- Withdraw an active submission.

An allowlisted moderator can read a contributor submission through the same detail endpoint, or use the dedicated moderator queue/detail and command routes.

Submissions are private workflow records. Creating or revising one never creates an `AlbumCatalog` record and therefore cannot make pending metadata appear in public search, album routes, feeds, statistics, reviews, saves, likes, profiles, boards, or notifications.

The implementation is centered on:

- `models/AlbumSubmission.js` for the aggregate, embedded revisions, and audit events.
- `routes/suggestions.js` for the contributor API.
- `routes/utils/submissions.js` for normalization, validation, fingerprints, duplicate candidates, pagination cursors, serialization, and configuration parsing.
- `routes/moderation.js` for moderator authorization, queue/detail reads, and explicit state commands.
- `routes/utils/approval.js` for transactional, idempotent catalog linking/creation.
- `routes/utils/rateLimit.js` for contributor mutation limits.

### Phase 2 status

| Capability | Status |
| --- | --- |
| Submission aggregate, validation, revisions, and audit events | Implemented |
| Contributor create, history, detail, revise, and withdraw API | Implemented |
| Submission feature flag and contributor mutation limits | Implemented |
| Advisory catalog and active-submission duplicate signals | Implemented |
| Moderator queue, detail, authorization boundary, and commands | Implemented |
| Idempotent approval and immediate `AlbumCatalog` publication | Implemented |
| Optional public approved-submission feed | Deferred |
| Contributor and moderator UI | Phase 3 |

## Configuration

The existing API requirements still apply:

- `MONGO_URI`
- `CLERK_SECRET_KEY`
- `CLERK_PUBLISHABLE_KEY` or `VITE_CLERK_PUBLISHABLE_KEY`

Phase 2 adds three optional variables:

| Variable | Behavior |
| --- | --- |
| `COMMUNITY_SUBMISSIONS_ENABLED` | Submission mutations are enabled only when this value is `true`, ignoring case and surrounding whitespace. It is disabled when missing or set to any other value. Read endpoints remain available. |
| `MODERATOR_USER_IDS` | Comma-separated Clerk user IDs allowed to read any submission detail and use moderator routes. This is a server-only allowlist. |
| `COMMUNITY_MODERATION_ENABLED` | Moderator commands are enabled only when this value is `true`. Moderator reads remain available while commands are disabled. |

Example local values:

```dotenv
COMMUNITY_SUBMISSIONS_ENABLED=true
MODERATOR_USER_IDS=user_abc123,user_def456
COMMUNITY_MODERATION_ENABLED=true
```

The rate limiters use process memory, matching the rest of the current API. Each API instance therefore maintains its own counters. Each moderator receives 120 commands per 10 minutes; contributor creation remains 6 per 10 minutes and contributor revision/withdrawal remains 20 per 10 minutes. Shared storage is required before horizontally scaling the API. Except for `/health`, requests also pass through the global limit of 300 requests per IP per five minutes. `TRUST_PROXY_HOPS` controls Express proxy handling and therefore affects IP-based keys. Unexpected limiter failures log and fail open rather than taking down the API.

## Public identity and privacy

Every submission receives an immutable UUID v4 exposed as `submissionId`. MongoDB `_id` values remain internal.

Public contributor responses never expose:

- The submission document `_id`.
- Internal `AlbumCatalog` ObjectIds.
- Internal candidate-submission ObjectIds.
- Raw duplicate-signal keys or another contributor's proposal.

Responses reduce internal matching data to `hasPossibleDuplicate` and, when an album reference is populated, a public `candidateAlbumId` or `approvedAlbumId`.

All endpoints require Clerk authentication. A detail request made by an authenticated user who is neither the owner nor allowlisted returns `404`, not `403`, so the API does not reveal whether another user's private submission exists.

## Submission aggregate

`AlbumSubmission` stores the current proposal and its complete history in one document.

| Field | Purpose |
| --- | --- |
| `submissionId` | Immutable public UUID v4. |
| `submittedByUserId` | Clerk user ID taken from server authentication, never from the request body. |
| `proposedMetadata` | Current normalized album proposal. |
| `supportingSources` | One to ten HTTPS evidence links. |
| `externalReferences` | Up to twenty structured non-Spotify provider references. |
| `normalizedFingerprint` | SHA-256 review signal derived from title, artists, release type, and year. |
| `candidateAlbumCatalogId` | Optional internal reference to a possible existing catalog match. |
| `candidateSubmissionIds` | Up to ten internal references to possible active-submission matches. |
| `duplicateSignals` | Internal match type, target type, match key, and target reference; at most twenty signals are retained by the API. |
| `status` | Current workflow state. |
| `approvedAlbumCatalogId` | Catalog album created or explicitly linked by approval; required whenever status is `approved`. |
| `duplicateOfSubmissionId` | Approved submission selected by a moderator duplicate decision; required whenever status is `duplicate`. |
| `currentRevision` | Starts at `1` and increments after each accepted revision. |
| `revisions` | Append-only complete proposal snapshots, including the duplicate state at submission time. |
| `moderationHistory` | Append-only actor, action, reason, and timestamp events. |
| `createdAt`, `updatedAt` | Mongoose timestamps. |

Embedded schemas use strict mode. Unknown database fields throw instead of being silently stored.

Revisions and moderation history are append-only application-service invariants. Contributor and moderator routes use `$push`, while Mongoose query middleware rejects replacement/removal updates and non-append `$push` options. Direct database writers must preserve the same rule.

### Indexes

The model defines indexes for:

- Unique `submissionId` lookup.
- Contributor history ordered by `createdAt` and `_id` descending.
- Moderator queue ordering by status and update time.
- Fingerprint and status lookup.
- Exact external-reference lookup.
- Barcode lookup.
- Catalog-number lookup.

Indexes follow the repository's current Mongoose auto-index behavior. A production index-build runbook remains deployment work.

## Workflow states

The schema supports:

- `pending`
- `needs_changes`
- `approved`
- `rejected`
- `duplicate`
- `withdrawn`

Contributor and moderator APIs implement the transitions below. Moderator commands are limited to pending submissions; needs-changes submissions return to pending only through contributor revision.

```mermaid
stateDiagram-v2
    [*] --> pending: contributor creates
    pending --> withdrawn: contributor withdraws
    needs_changes --> pending: contributor revises
    needs_changes --> withdrawn: contributor withdraws
    pending --> needs_changes: moderator requests changes
    pending --> approved: moderator approves
    pending --> rejected: moderator rejects
    pending --> duplicate: moderator marks duplicate
```

Contributor commands use conditional atomic updates:

- Revision requires ownership, status `needs_changes`, and the previously read `currentRevision`. A concurrent change returns `409 REVISION_CONFLICT`.
- Withdrawal requires ownership and status `pending` or `needs_changes`. A concurrent change returns `409 STATE_CONFLICT`.
- No API accepts an arbitrary status value, reviewer identity, moderation note, audit event, or revision number.
- No deletion endpoint exists. Closed submissions remain available for audit and future duplicate detection.

Moderator commands use `MODERATOR_USER_IDS`, return `401` to anonymous callers and `403 MODERATOR_REQUIRED` to authenticated non-moderators, and are disabled with `503 MODERATION_DISABLED` unless `COMMUNITY_MODERATION_ENABLED=true`. Reads remain available while that flag is off.

The model recognizes these moderation-history actions so later moderator services can use the same aggregate:

- `submitted`
- `revised`
- `withdrawn`
- `request_changes`
- `approved`
- `rejected`
- `marked_duplicate`

## Request contract

Create and revise accept the same body shape. Only these three root properties are allowed:

```json
{
  "proposedMetadata": {
    "title": "Kind of Blue",
    "artistDisplayName": "Miles Davis",
    "artistCredits": [
      {
        "name": "Miles Davis",
        "role": "main"
      }
    ],
    "releaseType": "album",
    "releaseDate": "1959-08-17",
    "releaseDatePrecision": "day",
    "releaseYear": 1959,
    "label": "Columbia",
    "country": "US",
    "catalogNumber": "CL 1355",
    "barcode": "012345678905",
    "tracks": [
      {
        "discNumber": 1,
        "trackNumber": 1,
        "title": "So What",
        "durationMs": 562000,
        "artistDisplayName": "Miles Davis"
      }
    ],
    "coverSourceUrl": "https://example.com/kind-of-blue-cover.jpg"
  },
  "supportingSources": [
    {
      "type": "musicbrainz",
      "url": "https://musicbrainz.org/release-group/example",
      "description": "Structured release-group evidence"
    }
  ],
  "externalReferences": [
    {
      "provider": "musicbrainz",
      "entityType": "release-group",
      "externalId": "example",
      "url": "https://musicbrainz.org/release-group/example"
    }
  ]
}
```

### Album metadata

| Property | Rules |
| --- | --- |
| `title` | Required, trimmed, maximum 200 characters. |
| `artistCredits` | Required array containing 1–20 objects. Each credit requires `name` up to 200 characters; `role` is optional, defaults to `main`, and is limited to 80 characters. |
| `artistDisplayName` | Optional, maximum 300 characters. When omitted, credit names are joined with ` & `. |
| `releaseType` | Required: `album`, `ep`, `single`, `mixtape`, `soundtrack`, `compilation`, `live`, `remix`, or `other`. |
| `releaseDate` | Optional only when `releaseYear` is supplied. Accepted forms are `YYYY`, `YYYY-MM`, and `YYYY-MM-DD`; invalid calendar dates are rejected. |
| `releaseDatePrecision` | Optional; if supplied it must match the date. The normalized value is always `year`, `month`, or `day`. |
| `releaseYear` | Optional when a date is supplied; otherwise required as an integer from 1–9999. It must match the date when both are present. |
| `label` | Optional, maximum 200 characters. |
| `country` | Optional, maximum 100 characters. |
| `catalogNumber` | Optional, maximum 100 characters. |
| `barcode` | Optional. Spaces and hyphens are removed, then 8–14 digits are required. |
| `tracks` | Optional array with at most 200 entries. |
| `coverSourceUrl` | Optional HTTPS direct cover-image URL, maximum 2048 characters. A moderator reviews the URL; when the suggestion is approved into a new album, this URL is published as its cover without a server-side fetch. |

Each track accepts only `discNumber`, `trackNumber`, `title`, `durationMs`, and `artistDisplayName`:

- Disc and track numbers default to `1` and the array position, respectively, and must be integers from 1–999.
- Title is required and limited to 200 characters.
- Duration defaults to `0` and must be a non-negative integer no greater than 86,400,000 milliseconds.
- Track artist display name is optional and limited to 300 characters.

### Supporting sources

One to ten source objects are required. Each accepts only:

- `type`: `musicbrainz`, `official_artist`, `official_label`, `distributor`, `store`, `spotify`, or `other`.
- `url`: required HTTPS URL, maximum 2048 characters.
- `description`: optional, maximum 200 characters.

Spotify URLs are evidence only. They are allowed as a `spotify` supporting source but cannot be stored as an external reference and never trigger a Spotify API request.

### External references

Zero to twenty references may be supplied. Each accepts only:

- `provider`: required, lowercased, maximum 50 characters.
- `entityType`: required, lowercased, maximum 50 characters.
- `externalId`: required, maximum 200 characters.
- `url`: optional HTTPS URL, maximum 2048 characters.

Duplicate `(provider, entityType, externalId)` entries in one request are rejected. Provider `spotify` is rejected here and must be represented as supporting evidence.

Unknown fields at any accepted request level return a validation error. The API never spreads `req.body` into a database write.

## Duplicate signals

Duplicate detection is advisory. A match never rejects, merges, approves, or publishes a submission.

The API checks:

- Exact `(provider, entityType, externalId)` references against `AlbumCatalog` and active submissions.
- Exact barcode and catalog-number representations where available.
- A normalized fingerprint against active submissions and bounded same-type/year catalog candidates.

Fingerprint construction:

1. Normalize title and artist names with Unicode NFKD.
2. Remove combining marks.
3. Lowercase, replace non-alphanumeric runs with spaces, and collapse whitespace.
4. Sort normalized artist names.
5. Combine normalized title, artists, release type, and release year.
6. Hash the result with SHA-256.

The normalized text fingerprint is a moderator-review signal, not a uniqueness rule. Distinct releases can legitimately share similar metadata.

## Contributor API

All routes are mounted below `/suggestions` and require Clerk authentication.

### `POST /suggestions`

Creates a submission.

- Requires `COMMUNITY_SUBMISSIONS_ENABLED=true`.
- Limited to 6 creations per authenticated user per 10 minutes.
- Normalizes and validates the body before any database write.
- Records duplicate candidates without blocking creation.
- Creates status `pending`, revision `1`, one full revision snapshot, and a `submitted` audit event.
- Returns `201` with the detailed submission representation.

### `GET /suggestions/mine`

Returns the current user's history, newest first.

Query parameters:

- `limit`: defaults to 20 and is capped at 50.
- `cursor`: opaque base64url cursor returned by the previous page.

The cursor contains ordering values for `createdAt` and internal `_id`, but the encoded value is opaque to API consumers. It cannot cross the ownership filter.

Response:

```json
{
  "suggestions": [],
  "nextCursor": null
}
```

List entries omit revision and moderation-history arrays. A malformed cursor returns `400 INVALID_CURSOR`.

The list query does not populate candidate or approved catalog references. It reliably exposes `hasPossibleDuplicate`, while public candidate or approved album UUIDs are available from the populated detail response.

### `GET /suggestions/:submissionId`

Returns detailed contributor-visible history.

- Available to the owner or a Clerk user listed in `MODERATOR_USER_IDS`.
- Returns `404` for a missing submission or an authenticated caller without access.
- Includes revision snapshots and moderation history.
- Populates catalog candidates only to expose public album UUIDs.

### `POST /suggestions/:submissionId/revise`

Appends a full revision and resubmits the proposal.

- Requires `COMMUNITY_SUBMISSIONS_ENABLED=true`.
- Shares a limit of 20 revisions or withdrawals per authenticated user per 10 minutes.
- Requires ownership and current status `needs_changes`.
- Revalidates the complete request, recalculates duplicate signals, increments `currentRevision`, appends a `revised` event, and returns status to `pending`.
- Uses the previously read revision number in the update filter to prevent concurrent overwrites.

### `POST /suggestions/:submissionId/withdraw`

Closes an active owned proposal.

- Requires `COMMUNITY_SUBMISSIONS_ENABLED=true`.
- Shares the 20-per-10-minute mutation limit.
- Accepts only `pending` or `needs_changes`.
- Atomically changes status to `withdrawn` and appends a `withdrawn` event.
- A terminal or concurrently changed submission returns `409`.

There is no `DELETE` endpoint, arbitrary status endpoint, or public approved feed.

## Moderator API

Moderator routes are mounted below `/moderation/album-suggestions` and require Clerk authentication plus membership in `MODERATOR_USER_IDS`. Mongo `_id` values never appear in these responses.

### `GET /moderation/album-suggestions`

Returns the queue oldest-first by `updatedAt` and `_id`.

- `status` is an optional comma-separated subset of `pending`, `needs_changes`, `approved`, `rejected`, `duplicate`, and `withdrawn`; it defaults to `pending`.
- `hasPossibleDuplicate` and `submittedByUserId` are optional filters.
- `limit` defaults to 20 and is capped at 50.
- `cursor` is an opaque `{updatedAt, _id}` cursor; malformed filters or cursors return `400`.
- The response is `{ suggestions, nextCursor }`. Queue entries contain proposal metadata, submitter, status, revision, timestamps, evidence counts/types, and `hasPossibleDuplicate`, but not revision or audit arrays.

### `GET /moderation/album-suggestions/:submissionId`

Returns full proposal history, evidence, revisions, moderation history, and sanitized duplicate candidates. Candidate albums use public `albumId` values. Candidate submissions use public `submissionId` values and limited core metadata; raw match keys and Mongo IDs are omitted.

### Moderator commands

All command bodies are strict and reject unknown fields, client-supplied reviewer identity, status, audit data, and revision values.

| Endpoint | Body | Transition |
| --- | --- | --- |
| `POST /:submissionId/request-changes` | `{ reason }` | `pending → needs_changes` |
| `POST /:submissionId/reject` | `{ reason }` | `pending → rejected` |
| `POST /:submissionId/mark-duplicate` | `{ duplicateOfSubmissionId, reason }` | `pending → duplicate` |
| `POST /:submissionId/approve` | `{ albumId?, confirmPossibleDuplicate?, reason? }` | `pending → approved` |

Reasons are required, trimmed, and limited to 1,000 characters for change requests, rejections, and duplicate decisions. Approval reason is optional with the same limit. Duplicate targets must be another approved submission with a usable catalog album. Existing catalog matches are handled by explicit `albumId` selection rather than `mark-duplicate`.

All successful commands append one moderation-history event and return `{ suggestion }`; approval additionally returns `{ album, albumUrl }`. Concurrent or stale commands return `409 STATE_CONFLICT`.

## Approval publication

Approval runs through one transactional, idempotent service. It rechecks duplicate candidates inside the transaction, never auto-links a candidate, and requires `confirmPossibleDuplicate=true` before creating a new album when only advisory matches exist. Exact catalog-reference matches require an explicit `albumId`.

When creating an album, the service copies normalized title, artist credits, release fields, tracks, label, and external references; adds normalized barcode/catalog-number references; sets `catalogSource: "community"`; generates local album/track UUIDs; and applies cover precedence of moderator-reviewed `coverSourceUrl`, then a best-effort deterministic Cover Art Archive lookup, then an empty `cover`. The lookup runs before the transaction and is accepted only when the pending submission revision is unchanged when re-read. It never fetches a submitted URL, fuzzy-matches metadata, or blocks approval when the provider is unavailable or artwork is unresolved. Supporting evidence and country remain private to the submission record.

When Cover Art Archive resolves artwork, the service stores its canonical `front-500` URL and records cover provenance (provider, resolution method, source MusicBrainz identifiers, image details, submission, revision, moderator, and approval time). Any exact MusicBrainz references derived by the lookup are added to the newly created catalog record. Explicit `albumId` approvals only link the selected album and never apply the suggestion's cover or identity references to it. Retrying an approved suggestion returns the existing catalog album without repeating artwork lookup or appending another audit event.

Each copied catalog field receives field-level provenance containing `source: "community"`, the public submission ID, revision, approving Clerk user ID, and approval timestamp. Linking an existing catalog album does not overwrite that album.

Catalog creation/linking, the submission status transition, and the approval audit event run in one Mongo transaction. Unsupported standalone Mongo returns `503 APPROVAL_UNAVAILABLE`; it never performs an unsafe create-then-update sequence. Retrying an already approved submission returns the same catalog album without creating another row or audit event.

## Response representation

List and detail responses use these public fields when available:

```text
submissionId
submittedByUserId
status
proposedMetadata
supportingSources
externalReferences
currentRevision
hasPossibleDuplicate
candidateAlbumId       optional public album UUID
approvedAlbumId        optional public album UUID
duplicateAlbumId       optional public album UUID for a duplicate decision
createdAt
updatedAt
```

Detail responses additionally contain:

```text
revisions[]
moderationHistory[]
```

Internal candidate submission IDs and duplicate-signal records are intentionally omitted.

## Error contract

| Status | Code or shape | Meaning |
| --- | --- | --- |
| `400` | `INVALID_SUBMISSION` | Request shape, field value, date, count, URL, or Mongoose validation failed. Normalizer errors also include `details`. |
| `400` | `INVALID_CURSOR` | Pagination cursor could not be decoded or validated. |
| `401` | `{ "error": "Unauthorized", "code": "UNAUTHORIZED" }` on moderator routes; contributor routes preserve the existing shape | Clerk did not provide a user ID. |
| `403` | `MODERATOR_REQUIRED` | Authenticated caller is not in the moderator allowlist. |
| `404` | `SUGGESTION_NOT_FOUND` | Submission is absent or private to another user. |
| `409` | `INVALID_SUBMISSION_STATE` | Revision, withdrawal, or moderation command is not allowed from the current state. |
| `409` | `REVISION_CONFLICT` or `STATE_CONFLICT` | A concurrent mutation invalidated the conditional update. |
| `409` | `EXACT_CATALOG_MATCH`, `POSSIBLE_DUPLICATE_CONFIRMATION_REQUIRED`, or `INVALID_DUPLICATE_TARGET` | Moderator must resolve an exact match, confirm an advisory duplicate, or select a valid approved duplicate target. |
| `429` | `RATE_LIMITED` | Per-user mutation bucket was exhausted. Includes `retryAfterSeconds` and a `Retry-After` header. |
| `503` | `SUBMISSIONS_DISABLED` | Contributor mutations are disabled by feature flag. |
| `503` | `MODERATION_DISABLED` or `APPROVAL_UNAVAILABLE` | Moderator commands are disabled or Mongo transactions are unavailable. |
| `500` | Endpoint-specific `error` message | Unexpected server or database failure. |

## Tests and verification

Run the backend tests:

```sh
npm test
```

Run the replica-set-backed approval tests in an environment that permits local Mongo processes:

```sh
npm run test:integration
```

The normal `npm test` run keeps these integration cases skipped unless `RUN_MONGO_INTEGRATION=true` is supplied.

Run the provider-neutral catalog guard:

```sh
npm run check:catalog-contract
```

`tests/submissions.test.js` and `tests/moderation.test.js` cover:

- Metadata, date, barcode, URL, source, and fingerprint normalization.
- Unknown-field, insecure-URL, and Spotify-reference rejection.
- Schema UUID, index, approval-reference, and duplicate-reference invariants.
- Opaque cursor round trips and invalid cursors.
- Initial revision and audit creation.
- Advisory duplicate candidates.
- Contributor pagination.
- Disabled mutations and anonymous authentication failures.
- Rate limiting before database writes.
- Owner privacy and moderator allowlist reads.
- Revision, withdrawal, and terminal-state behavior.
- Public serialization without internal identifiers.
- Moderator authentication, allowlist privacy, queue filters/cursors, command transitions, reasons, duplicate targets, feature flags, approval mapping, idempotent retries, and transaction-unavailable handling.

The optional integration suite uses a MongoMemoryReplSet for real transaction, index, rollback, and concurrency behavior.

### Known implementation constraints

- Append-only revisions and audit history are enforced by route/service behavior plus Mongoose query middleware; direct database access should still be restricted.
- The API normalizer caps external references at twenty, and duplicate discovery caps retained signals at twenty; direct database writers must preserve those bounds because the top-level arrays do not repeat both limits at the schema layer.
- Pagination cursors are opaque base64url JSON but are not signed. Tampering can only move the caller's pagination position because every query independently enforces `submittedByUserId`.
- Submission and moderator route tests use mocked persistence for fast contract coverage. `npm run test:integration` runs the replica-set-backed transaction, rollback, provenance, and concurrency checks; the normal `npm test` run skips them unless `RUN_MONGO_INTEGRATION=true` is supplied.
- Public-exclusion behavior follows structurally from never writing a pending submission into `AlbumCatalog`; the integration suite verifies that pending metadata has no catalog row before approval.

## Phase 2 exit gate

Phase 2 backend is complete when the moderator route tests and transaction-backed approval tests pass, and pending, needs-changes, rejected, duplicate, and withdrawn submissions remain absent from public catalog and social queries. Build indexes using the repository's normal Mongoose auto-index behavior; production index rollout remains Phase 4 deployment work.

### Explicitly later

- Optional `GET /suggestions/approved` public feed.
- Contributor and moderator frontend flows, which are Phase 3.
- MusicBrainz-assisted prefill and bulk import work.
- Metadata correction proposals, merges, editions, and contributor reputation.
