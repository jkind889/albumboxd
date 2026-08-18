# Phase 3 Community Submission UI

Status: Phase 3 contributor and moderator UI implemented and verified; the optional public approved-submission feed remains deferred.

This document records the authenticated contributor and moderator screens that sit on top of the Phase 2 submission API. It describes the visible route and workflow boundary only; the [Phase 2 community album submissions contract](./PHASE_2_SUBMISSIONS.md) remains the source of truth for persistence, validation, authorization, status transitions, duplicate signals, and approval publication.

## Scope and access

The submission screens are signed-in surfaces. The frontend may protect navigation with its authenticated route wrapper, but the server remains the authorization boundary for every request. The UI must not treat a hidden link or route guard as permission to read or mutate a submission.

Contributor detail is owner-scoped by the API. A caller who is neither the owner nor an allowlisted moderator receives the same not-found response as a missing submission. Moderator screens require Clerk authentication and membership in the server-only `MODERATOR_USER_IDS` allowlist. MongoDB identifiers are never a UI-facing identity; use the public `submissionId` and `albumId` values returned by the API.

## Contributor routes and workflows

All contributor routes are below `/suggestions` and use the corresponding Phase 2 endpoints:

| UI route | Visible workflow | API boundary |
| --- | --- | --- |
| `/suggestions` | The contributor's submission history, status, timestamps, revision/duplicate signals where provided, and links to each detail view or the new-submission form. | `GET /suggestions/mine` with its opaque `cursor` and `limit` pagination values. |
| `/suggestions/:submissionId` | One submission's current proposal, evidence, revision history, moderation history, status, and available actions. An active proposal can be withdrawn; a `needs_changes` proposal can be opened in the revision form. | `GET /suggestions/:submissionId`; `POST /suggestions/:submissionId/withdraw` for withdrawal. |
| `/suggestions/new` | Form for a complete proposed album and supporting evidence. Validation and server feedback remain visible to the contributor. | `POST /suggestions`; the server creates a pending submission and returns its detail representation. |
| `/suggestions/:submissionId/revise` | The same complete proposal form, populated for a submission whose status is `needs_changes`. Submitting it shows the proposal as pending again. | `POST /suggestions/:submissionId/revise`; the server appends a revision and recalculates duplicate signals. |

Withdrawal is an action on the list/detail UI, not a separate frontend route. The UI should offer it only for `pending` and `needs_changes`; the server rejects terminal or concurrently changed records. Revision is likewise available only after a moderator requests changes; the server, not the client, enforces that state transition.

The contributor list is a private workflow view. It is not a public catalog or approved-submission feed, and creating or revising a proposal does not publish an album.

## Moderator routes and workflows

Moderator screens are below `/moderation/album-suggestions`:

| UI route | Visible workflow | API boundary |
| --- | --- | --- |
| `/moderation/album-suggestions` | Queue of submissions with status, submitter, evidence summary, revision/timestamps, and possible-duplicate signal. The queue supports status, possible-duplicate, submitter, cursor, and page-size filters. | `GET /moderation/album-suggestions`; status defaults to `pending` and accepts `pending`, `needs_changes`, `approved`, `rejected`, `duplicate`, and `withdrawn`. The API validates all filters and cursors. |
| `/moderation/album-suggestions/:submissionId` | Full proposal and evidence detail, revision and moderation history, sanitized catalog/submission duplicate candidates, and a decision panel. | `GET /moderation/album-suggestions/:submissionId` plus one explicit command endpoint for the selected decision. |

The decision panel presents the server-supported actions for a pending submission:

- Request changes with a required reason: `POST /moderation/album-suggestions/:submissionId/request-changes`.
- Reject with a required reason: `POST /moderation/album-suggestions/:submissionId/reject`.
- Mark duplicate by selecting or entering another approved `submissionId`, with a required reason: `POST /moderation/album-suggestions/:submissionId/mark-duplicate`.
- Approve with an optional existing `albumId`, possible-duplicate confirmation when required, and optional reason: `POST /moderation/album-suggestions/:submissionId/approve`.

The UI should show command validation, conflict, disabled-feature, and approval-unavailable responses as server feedback. A successful approval may return the published catalog album and album URL; the UI may link to that result without treating the submission screen as the public approved feed. The server accepts moderation commands only while the submission is pending and records the authoritative moderation event.

## Visual and API boundaries

The visual surface is a workflow UI: status labels, queue/detail panels, evidence and history sections, duplicate-candidate choices, explicit reason fields, loading/empty/error states, and confirmation feedback for state-changing actions. It should make the current status and the next allowed action clear, while preserving the server response as authoritative after each mutation.

The UI calls the Phase 2 HTTP routes and renders their public representations. It does not write MongoDB records, choose reviewer identity, submit arbitrary statuses or audit events, or infer approval from a local optimistic state. Opaque pagination cursors are passed back to the API unchanged. Candidate matches are advisory until a moderator explicitly chooses a supported command.

## Feature flags and deferred work

- `COMMUNITY_SUBMISSIONS_ENABLED=true` enables contributor create, revise, and withdraw mutations. Contributor reads remain available when the flag is off; the UI should surface the server's disabled response for mutation attempts.
- `COMMUNITY_MODERATION_ENABLED=true` enables moderator commands. Moderator reads remain available when the flag is off; the UI should surface the server's disabled response for command attempts.
- `MODERATOR_USER_IDS` is a server-only Clerk allowlist for moderator reads and commands. It must not be used as a client-side authority source.

The two boolean flags are disabled when absent or set to any value other than `true` (case-insensitive, with surrounding whitespace ignored).

The optional public approved-submission feed (`GET /suggestions/approved`) remains deferred. Phase 3 covers the authenticated contributor and moderator workflows above; it does not add a public feed route.
