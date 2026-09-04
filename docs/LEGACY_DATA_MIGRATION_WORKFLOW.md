# Legacy MongoDB to generation-2 migration workflow

See the [central error and status code reference](./ERROR_CODES.md) for migration, reconciliation, provider, validation, and process-exit meanings.

Status: planning draft. The transferred legacy archive was verified read-only on August 23, 2026; it has not been restored.

## Objective

Preserve useful generation-1 catalog and social data while converting it to the current provider-neutral generation-2 schema. The migration must be inspectable, restartable, and reversible. It must not mutate the only copy of the legacy database, point current application code at generation-1 collections, or silently discard records that cannot be mapped.

The schema boundary is:

- Generation 1 reference: commit `34bfe4bce00fb64ea8a3f7c1532cd6eb807fb542`, immediately before `e52ca9b` removed the Spotify-shaped schema.
- Generation 2 reference for this draft: commit `af096f29f2e536d83ffce94b712a35c4a2c18621` on `community-driven`.

The original roadmap intentionally treated generation-1 data as disposable. This workflow deliberately reopens that decision and therefore needs a new, dedicated migration path. The existing catalog importer only handles the versioned ListenBrainz/MusicBrainz album dataset; it does not migrate reviews, boards, likes, follows, notifications, profiles, or legacy saves.

## Recommended shape of the migration

Use a blue/green database workflow:

```text
immutable transfer
    -> isolated generation-1 restore
    -> read-only inventory
    -> generation-2 candidate database
    -> album identity crosswalk
    -> whitelisted transformations
    -> reconciliation and application smoke tests
    -> connection-string cutover
```

Do not migrate in place. Several generation-1 indexes are incompatible with generation 2. For example, the old non-sparse unique `albumcatalogs.spotifyId` index would allow only one transformed document after `spotifyId` is removed. The old BoardItem and album-like indexes have the same class of problem. A separate candidate database also makes rollback a connection-string switch instead of a reverse data migration.

## Decisions to confirm after the data arrives

The initial inventory should answer these questions before migration code is allowed to write:

1. What arrived: a `mongodump` archive/directory, Extended JSON exports, a raw MongoDB/WiredTiger data directory, or access to a live source database?
2. What MongoDB server and database-tools versions created or last opened it?
3. What is the source database name, and was application write traffic stopped before the final copy?
4. Does a generation-2 database already exist on the PC or in Atlas, and does it contain the 500-album seed, demo data, submissions, or real activity?
5. Are the old Clerk user IDs still valid in the same Clerk instance? MongoDB contains Clerk IDs but no local user/email table. If the Clerk instance changed, a separate Clerk identity crosswalk is required before social data can be usable.
6. Are quarantined records acceptable at cutover, or must every record be manually repaired first?

Recommended defaults:

- Treat the transferred data as immutable and calculate a SHA-256 before restoring it.
- Restore into a source namespace such as `rescened_gen1_source_<run-id>` and use a read-only database account for analysis.
- Build a new candidate namespace such as `rescened_gen2_candidate_<run-id>`.
- Bootstrap or clone the generation-2 catalog before overlaying legacy data, so exact MusicBrainz matches can reuse the canonical seeded album.
- Attempt to rebuild all 2,518 legacy catalog rows, prioritizing the 44 albums referenced by user/social data. A row enters the active generation-2 catalog only after its identity and required display fields have been independently rehydrated or reviewed; the rest remain explicitly quarantined rather than being silently discarded or populated from stale provider data.
- Treat all legacy Spotify-derived fields, including tracklists, as migration evidence rather than target metadata. Keep provider IDs only in a protected, time-limited crosswalk where they are required to connect legacy social records or discover an independently verifiable identity. Never restore Spotify IDs, URLs, cover art, title/artist/date/label values, or tracks as canonical fields by default.
- Rebuild accepted albums from the existing generation-2 catalog, MusicBrainz core data, and other explicitly licensed or community-reviewed sources. Record field-level provenance and source-license class in the plan.
- Preserve the original dump, prior generation-2 database, candidate snapshot, plans, crosswalk, and reports through the observation/retention window.

## Existing historical archive clue

Git history contains `cb625b7:rescened-backup-2026-08-13.archive.gz` as a 387,362-byte blob with SHA-256 `598901cc8801b8f2b0f8634da44148b83154fbaf41d371a12bbbfa71ed286c39`. It appears to be a valid `mongodump` gzip archive made with MongoDB Database Tools `100.16.1`. The same sensitive archive is also tracked in the current tree at `docs/rescened-backup-2026-08-13.archive.gz` as of commit `7d27c45`; `.gitignore` cannot protect an already-tracked blob. Treat it as sensitive user/social data and do not extract it into the repository.

The transferred file at `docs/rescened-backup-2026-08-13.archive.gz` is an exact byte-for-byte copy of that Git blob. Read-only verification completed successfully:

- compressed size: 387,362 bytes;
- compressed SHA-256: `598901cc8801b8f2b0f8634da44148b83154fbaf41d371a12bbbfa71ed286c39`;
- uncompressed size: 2,607,137 bytes;
- uncompressed SHA-256: `494c2891dc2c1259eaad1c1b8527d206a29de8e1726f1d15385cc65b2eaec8ab`;
- valid gzip header, footer CRC32, and uncompressed-size footer;
- valid Mongo archive format `0.1`, sourced from MongoDB `8.0.29` with Database Tools `100.16.1`;
- all 12 namespaces, 2,647 BSON documents, metadata JSON records, namespace EOF markers, and per-namespace CRC64 checksums parsed and matched;
- no extraction, database connection, or restore was performed.

Move the retained working copy to a protected location outside the repository. Removing the tracked copy and purging shared history require a separate coordinated security decision; do not rewrite history as an incidental migration step.

A read-only inspection of that historical snapshot produced this provisional inventory:

| Collection | Documents |
| --- | ---: |
| `albumcatalogs` | 2,518 |
| `albums` | 18 |
| `boarditems` | 18 |
| `boards` | 10 |
| `reviews` | 31 |
| `likes` | 30 |
| `notifications` | 2 |
| `userprofiles` | 11 |
| `follows` | 3 |
| `artistcatalogs` | 3 |
| `artistneighborhoods` | 3 |

Only 44 of the 2,518 cached catalog albums are referenced by social data in that snapshot. All 44 resolve and have usable title, artist, year, and cover metadata. All 18 legacy `albums` saves are already represented by the 18 default-board items. No dangling Board/Catalog references, ownership mismatches, duplicate board memberships, invalid reviews, bad profile references, invalid follows, or save inconsistencies were found.

Those 44 legacy display records are structurally usable, but their Spotify-derived values are not approved target metadata under this workflow. Across the full cache, 271 rows have a resolved, syntactically valid MusicBrainz release-group MBID and at least one valid exact release MBID. They collapse to 247 logical release groups: 33 already overlap the 500-album seed and 214 need fresh hydration or creation. Five additional failed rows retain six syntactically valid release MBIDs and are retry/revalidation candidates, not confirmed matches. Of the 44 socially referenced rows, 19 are strictly hydratable and collapse to 17 logical groups: one seed reuse plus 16 fresh hydrations. Identity recovery for the remaining 25 social rows is a cutover-priority work queue.

Three pre-existing issues require explicit migration dispositions:

- two of six review likes point to two Review IDs absent from the archive;
- one review-like notification points to one of those same absent reviews;
- five socially referenced catalogs touch three duplicate MusicBrainz release-group clusters; two active clusters contain four rows and require two merge/conflict decisions.

Across the complete provider cache there are 19 duplicate release-group clusters covering 43 catalog rows. Only one socially referenced album exactly overlaps the checked-in 500-album seed by release-group ID; eight additional unique title/artist/year matches are advisory candidates, not safe automatic merges. Three profiles lack the later `isPrivate` field and two lack several optional profile fields; current defaults can repair those shapes without losing album or pinned references.

The real snapshot data is under `test.*`; `albumboxdd` contains only an empty `albums` collection. Any isolated restore must explicitly remap `test.*` to the chosen generation-1 source namespace. There is no fatal migration blocker in the verified data, but the orphan and MusicBrainz collision decisions must be resolved in the checksummed plan before apply.

These figures are planning evidence, not permission to copy provider metadata. The migration will attempt the complete catalog, but conversion yield and quarantine counts must be reported separately. Preservation of user-facing relationships remains the first acceptance priority.

Because the archive remains reachable in Git history, repository-history cleanup is a separate privacy/security follow-up. First determine repository visibility and who has had access; if the data should not remain available, plan a coordinated history purge and remote cleanup. That operation is intentionally outside this database migration and must not be performed casually because it rewrites shared Git history.

## Phase 1: intake and immutable restore

1. Put the transfer outside the repository and do not rename, edit, or open the only copy in place.
2. Record absolute path, byte size, SHA-256, transfer date, source database name, export command/version if known, application commit if known, and whether writes were frozen.
3. Make a second working copy before attempting recovery or restore.
4. Select the restore route based on format:
   - `mongodump` archive/directory: restore into an isolated database name with compatible MongoDB Database Tools.
   - Extended JSON: verify that ObjectIds and Dates retained Extended JSON types; ordinary JSON may have lost relationship types.
   - Raw WiredTiger files: copy them again, start a compatible MongoDB version against the working copy only, then produce a normal `mongodump`. Never let a newer server upgrade the sole copy.
5. Compare archive collection counts with the restored source and save the restore report.
6. Never start the current Rescened API against the restored source database.

The current PC check found Node `24.19.0` but no MongoDB server, `mongosh`, or Docker. MongoDB Database Tools `100.18.0` were installed from [MongoDB's official Windows x64 portable package](https://fastdl.mongodb.org/tools/db/mongodb-database-tools-windows-x86_64-100.18.0.zip) on August 23, 2026; the downloaded package SHA-256 is `feb29eed9788b1da2fb6f7ae63909ac790a6fe3a363947e68590f048bed08edb`, and both `mongorestore` and `mongodump` were version-verified. The tools are under `C:\Users\jedim\AppData\Local\MongoDB\DatabaseTools\100.18.0\mongodb-database-tools-windows-x86_64-100.18.0\bin` and that directory was added to the user PATH for new terminals. MongoDB documents Tools `100.18.0` as compatible with server `8.0`, which produced this archive. Before restore, provision either a transaction-capable isolated local replica set or an isolated Atlas deployment. The repository handoff recommends Node 22 LTS for the application verification path.

## Phase 2: read-only source and target inventory

Create a machine-readable inventory report rather than relying on a few sampled documents. Include:

- database/collection names, document counts, byte sizes, index definitions, and MongoDB version;
- field-presence/type frequencies for every collection;
- duplicate keys under both old and new uniqueness rules;
- invalid/missing user IDs, ratings, dates, titles, artists, album keys, and relationship IDs;
- orphaned catalog, board, review, pinned-review, and pinned-board references;
- users represented in `albums`, `boarditems`, reviews, profiles, likes, follows, and notifications;
- MusicBrainz mapping status and valid release-group/release IDs;
- per-field source classification (`spotify-legacy`, `musicbrainz-core`, `cover-art-archive`, `community`, or `unknown`) and whether the field is eligible for active target use;
- whether the current generation-2 target contains the checked-in 500-album catalog, demo records, community albums, or submissions.

Expect mixed historical shapes. Earlier generation-1 documents were not necessarily backfilled when models changed:

- old `albums` rows can contain embedded `title`, `artist`, and `cover` without `albumCatalogId` or `savedAt`;
- the oldest `albums` and reviews can lack `userId`;
- later `albums` rows reference `albumcatalogs` and may omit the embedded metadata;
- generation-1 board routes lazily copied `albums` into the default board, so `albums` and `boarditems` are partially overlapping sources, not two independent save counts.

No writes occur in this phase. Its exit artifact is a signed-off inventory plus a decision to clone an existing generation-2 target or bootstrap a fresh candidate.

## Phase 3: establish the candidate baseline

1. If a real generation-2 database already contains submissions or social activity, snapshot it and clone it into the candidate.
2. Otherwise initialize an empty candidate using the current models and indexes.
3. If the 500-album seed belongs in the target, validate it, dry-run it, then apply it to the candidate before planning legacy matches. Do not treat the checked-in apply report as proof of any database's contents; that report does not identify its target environment.
4. Record a fingerprint of the candidate baseline: collection counts, catalog external-reference keys, database name, schema commit, and snapshot/checksum identifiers.
5. Refuse to continue if source and target connection/database namespaces are equal.

This baseline is never the live database. A failed or partial candidate can be discarded and rebuilt from the immutable inputs.

## Phase 4: build a durable album identity crosswalk

Generation-1 social records use a mixture of catalog ObjectIds and Spotify IDs. Build one normalized legacy album identity set from the union of:

- `albumcatalogs` documents;
- embedded snapshots in legacy `albums`;
- embedded snapshots in reviews;
- album keys referenced by board items, likes, notifications, and profiles.

Legacy Spotify metadata may identify which source records belong together, but it is not a target-field source. Never call Spotify to refresh it. Match or recover each legacy identity in this order:

1. Exact, valid MusicBrainz release-group reference already present in the legacy row.
2. Exact, unique, valid MusicBrainz release reference already present in the legacy row.
3. Exact MusicBrainz URL relationship found by treating the legacy provider ID as an opaque, migration-only lookup key. Fetch the resulting album metadata from MusicBrainz, not Spotify.
4. A unique existing generation-2/community album supported by an independent identifier or reviewed evidence.
5. Search-only candidate discovery using legacy title/artist/year clues, followed by independent MusicBrainz or moderator verification. These clues may propose a match but may never populate a target field or authorize an automatic fuzzy match.
6. Quarantine unresolved, conflicting, and ambiguous identities for a reviewed manual override; never guess in apply mode.

For a legacy row that exactly matches an existing candidate album, retain the candidate `_id`, public `albumId`, canonical metadata, `catalogSource`, and provenance. Do not fill empty target fields from the legacy Spotify snapshot. For a newly verified row, fetch a fresh source record, generate its UUID-v4 exactly once during planning, and use `catalogSource: "import"` with `fieldProvenance._migration.importKind: "legacy-migration"` so automated MusicBrainz refreshes can recognize the data without treating it as moderator-authored.

The plan must report the whole 2,518-row funnel: immediate exact matches, identities recovered through independent relationships, manually verified rows, unresolved rows, conflicts, and accepted target creations. Report the same funnel separately for the 44 socially referenced albums.

Persist an immutable crosswalk with at least:

```text
legacy catalog ObjectId(s)
legacy provider key (protected artifact only)
target AlbumCatalog ObjectId
target public albumId
action: reused | created | quarantined
match method and confidence
source metadata choice
source/license class for every target field
plan/run ID and checksums
```

The plan owns all generated IDs. Re-running apply must never generate a different album or track ID.

## Phase 5: catalog transformation rules

Write a new document from a field whitelist; do not update or spread a legacy document into the target.

| Generation-1 data | Generation-2 result |
| --- | --- |
| `spotifyId` and Spotify URLs | Protected, time-limited crosswalk/archive only; never active target data |
| Spotify-derived `title`, `artist`, artist arrays, `albumType`, release dates/year, and label | Search/reconciliation evidence only. Populate the corresponding target fields from a fresh MusicBrainz core record, an existing generation-2/community record, or a reviewed independently licensed source. |
| Spotify-derived cover/images | Do not copy. Resolve cover art independently under the selected image source's current terms and record its provenance. |
| Spotify-derived tracks | Do not copy into the active target by default. Rebuild from an exact independently sourced release or a documented canonical-release choice, then assign stable provider-neutral planned `trackId` values. |
| resolved MusicBrainz release-group/release IDs | Validate against MusicBrainz and write deduplicated normalized `externalReferences`; do not copy failed/candidate IDs as authoritative references |
| genres, extra images, provider mapping/enrichment state and errors | Retained only in the immutable archive or a non-active migration summary |
| source timestamps | Preserve `createdAt` when meaningful; record migration time and source in provenance |

Do not fabricate `AlbumSubmission` records or moderation history for migrated albums.

### Spotify-source boundary and tracklists

Retaining a normalized Spotify tracklist is not considered harmless. Spotify's current Developer Terms define metadata as Spotify Content, restrict building or indefinitely retaining databases of that content, and require older displayed data to be refreshed or deleted. Spotify's design rules also require Spotify attribution and links when Spotify metadata is displayed. Removing IDs and URLs or replacing them with local UUIDs does not change the origin of the titles, sequence, artists, or durations. This workflow is a conservative engineering policy, not legal advice; obtain qualified review before making an exception.

There is also a data-quality problem: tracklists are edition-specific. Deluxe, regional, reissue, and bonus-track variants can share a release group, and duplicate legacy rows can disagree. An unreviewed merge could attach the wrong tracklist to the generation-2 album and the current importer would then preserve that existing tracklist.

The archive contains 606 structurally valid tracks across 65 album rows; 388 of those tracks occur on 38 of the 44 socially referenced rows. Structural validity does not establish reuse permission or the correct edition. Exactly one duplicate release-group cluster has two different non-empty lists (6 tracks versus 12), and it affects social data, so it must be resolved against a specific independently sourced release.

The default is therefore:

1. retain legacy tracks only inside the restricted source backup during the migration and rollback window;
2. resolve a specific MusicBrainz release, or use a documented canonical-release mapping when the product intentionally wants a representative edition;
3. fetch the tracklist from that independent source and generate stable local `trackId` values in the checksummed plan;
4. quarantine edition conflicts instead of merging them automatically; and
5. expire migration-only Spotify crosswalks and working extracts under an approved retention schedule after rollback is no longer needed.

If qualified policy/legal review explicitly approves a temporary carry-over exception, it must be a separately enabled, reported policy: exact one-to-one release matches only; no conflicted release groups; target/community data wins; all Spotify IDs, URLs, preview links, and artist IDs are stripped; local track IDs are generated once; and every retained field is marked `legacy-spotify` and `provisional` in provenance. That exception is not enabled by this plan.

Policy/source references reviewed for this decision on August 23, 2026:

- [Spotify Developer Terms](https://developer.spotify.com/terms), especially the definition and storage rules for Spotify Content;
- [Spotify Developer Policy](https://developer.spotify.com/policy) and [Design & Branding Guidelines](https://developer.spotify.com/documentation/design);
- [MusicBrainz data licensing](https://musicbrainz.org/doc/About/Data_License), under which core database data is CC0; and
- [MusicBrainz canonical data](https://musicbrainz.org/doc/Canonical_MusicBrainz_data), including the CC0 canonical release mapping for representative tracklists.

## Phase 6: social transformation

Preserve existing `_id` values for reviews, boards, and other social documents where possible because profiles, likes, and notifications reference them. Catalog IDs are always resolved through the crosswalk because several legacy albums can converge on one existing generation-2 album.

| Legacy collection | Target treatment |
| --- | --- |
| `albumcatalogs` | Reuse or create whitelisted generation-2 catalog documents through the crosswalk. |
| `albums` | No direct target collection. Union each valid user save into that user's default `boards`/`boarditems` membership. Derive a missing `savedAt` from the ObjectId timestamp when possible and report the derivation. |
| `boards` | Copy/merge, enforce ownership and at most one default board per user. |
| `boarditems` | Remap `albumCatalogId`, remove legacy provider fields, verify the board belongs to `userId`, and collapse duplicate `(boardId, albumCatalogId)` memberships. |
| `reviews` | Resolve the legacy album key to required `albumCatalogId`; preserve `_id`, `userId`, text, rating, and date; remove denormalized album snapshots. Quarantine userless, invalid, or unresolved rows. |
| `likes` | Album likes resolve to `albumCatalogId`; review likes retain a valid `reviewId`; remove the legacy album key and enforce exactly one applicable target. Collapse duplicates under current unique tuples. |
| `notifications` | Preserve actor, recipient, type, review reference, read state, and timestamps; remove the legacy album key. A review-like notification must reference a migrated review. |
| `userprofiles` | Remap favorites and listening-next albums, remove embedded legacy keys, normalize unique ranks `0..4`, and verify pinned Review/Board ownership. Clear only an invalid optional pin and report it; do not discard an otherwise valid profile. |
| `follows` | Copy/merge valid unique follower/following pairs; report self-follows and missing IDs. |
| `artistcatalogs`, `artistneighborhoods` | Archive only. There is no generation-2 target model. |
| `albumsubmissions` | Preserve only from an existing generation-2 baseline; there is no legacy source mapping. |

When multiple legacy saves collapse to one target membership, retain the earliest valid `savedAt` as the original save time and count the collapsed inputs in reconciliation.

Apply in dependency order:

1. catalog albums;
2. boards and follows;
3. reviews;
4. board items plus the legacy `albums` union;
5. likes and notifications;
6. user profiles.

## Phase 7: plan, validate, and apply safely

The migration implementation should have distinct inventory, plan, validate, apply, and verify modes. Dry-run is the default. Use the native MongoDB driver to read raw legacy documents; current Mongoose models must not be used as the legacy parser because they no longer declare old fields.

Before apply:

- bind the plan to source archive SHA-256, source inventory hash, target baseline fingerprint, schema commit, tool commit, and target database name;
- save the album crosswalk, transformed counts, planned writes, deduplication decisions, manual overrides, and quarantine/conflict report;
- validate every transformed document against the current model contract;
- write reports to a local ignored directory, never Git, and keep credentials out of arguments and report files;
- require explicit `--apply`, exact target confirmation, and the expected plan checksum.

For unknown data size, use bounded, idempotent bulk writes with a migration run ledger. A single all-data transaction is acceptable only if inventory proves the workload is small enough. The candidate approach supplies the global rollback boundary: a partial candidate is never cut over.

Create current indexes intentionally after deduplication and before acceptance. Do not copy generation-1 index definitions. Re-running the same validated plan against the same candidate must produce zero logical changes.

## Phase 8: reconciliation and acceptance gates

Every source row must end in exactly one reported bucket: migrated, merged/deduplicated, intentionally archived, manually repaired, or quarantined. Straight document-count equality is not expected because albums merge and the two legacy save sources are unioned.

Cutover requires all of the following:

- unique valid generation-2 `albumId` values and unique external-reference tuples;
- zero obsolete provider identity fields in active generation-2 collections;
- zero dangling AlbumCatalog, Review, Board, pinned Review, or pinned Board references;
- every BoardItem `userId` matches its Board owner;
- no more than one default board per user;
- exactly one target on each Like according to `targetType`;
- valid review ratings and non-empty review text;
- profile favorites are unique, ranked, and limited to five;
- source-to-target reconciliation for distinct users, reviews, follows, profiles, unread notifications, and per-user saved-album unions;
- per-album review/rating/like/save aggregates reconcile through the crosswalk;
- every quarantine/conflict has an explicit disposition approved before cutover;
- a second dry-run is idempotent and produces the same mapping/checksums;
- current indexes build successfully.

Run the repository verification suite against the candidate configuration:

```powershell
npm test

$env:RUN_MONGO_INTEGRATION = "true"
node --test tests/moderation.integration.test.js tests/catalogImport.integration.test.js
Remove-Item Env:RUN_MONGO_INTEGRATION

npm run check:catalog-contract
npm --prefix frontend run lint
npm --prefix frontend run build
```

The static catalog-contract check scans source code, not stored BSON. The migration verifier must additionally scan the candidate database for forbidden legacy fields and invalid relationships.

Start the API against the candidate and require `/health` to return JSON status `ok` rather than merely HTTP 200. Smoke-test catalog/search/detail, representative reviews, likes, every board shape, profiles with favorites/listening-next/pins, follows, and notifications. Include examples of an album reused from the seed, an unmatched legacy album, a deduplicated save, and a repaired historical row.

## Phase 9: cutover and rollback

1. Stop all application writes for the final source/target snapshots. The current feature flags do not freeze reviews, likes, boards, profiles, or follows, so stopping or maintenance-routing the API is the reliable freeze.
2. Rebuild or apply the final candidate from the immutable final snapshot and approved plan.
3. Complete reconciliation, indexes, tests, and smoke checks.
4. Snapshot the candidate and the previous generation-2 target.
5. Change only the API's `MONGO_URI` to the candidate, restart, and repeat health/smoke checks before reopening writes.
6. Keep submissions and moderation disabled during the observation window if practical.

Before reopening writes, rollback is: restore the previous API `MONGO_URI`, restart, and verify. Never run generation-2 code against the legacy restore. After writes reopen, a database rollback is not lossless unless post-cutover writes are replayed, so keep the observation window short or capture a change stream/write log for a later production migration.

## Implemented migration slices

The first implementation follows this planning review through a thin CLI and independently testable modules:

```text
scripts/migrateLegacyDatabase.js
lib/legacyMigration/runtime.js
lib/legacyMigration/artifacts.js
lib/legacyMigration/inventory.js
lib/legacyMigration/catalogCrosswalk.js
lib/legacyMigration/musicBrainz.js
lib/legacyMigration/transform.js
lib/legacyMigration/plan.js
lib/legacyMigration/apply.js
lib/legacyMigration/validate.js
lib/legacyMigration/verify.js
tests/legacyMigration.test.js
tests/legacyMigration.integration.test.js
```

The routine operator workflow is intentionally condensed to two commands. The first command composes inventory, dry-run planning, artifact sealing, and validation. The second composes checksum-bound transactional apply and candidate verification. The original five phase-specific modes remain available through `npm run db:migrate:legacy` for inspection and recovery. The integration command is cross-platform through `scripts/runIntegrationTests.js`.

Store sensitive local output under the ignored path `.migration/legacy-gen1/<run-id>/`. Use session-only `LEGACY_MONGO_URI` and `MIGRATION_TARGET_MONGO_URI`; never place credentials in CLI arguments, Git, or reports.

Routine command contract:

```text
npm run db:migrate:legacy:plan -- --run-dir <run-dir> [--overrides <file>]
npm run db:migrate:legacy:execute -- --run-dir <run-dir> --plan-sha256 <plan-sha256> --confirm-target <database>
```

`db:migrate:legacy:plan` performs `inventory -> dry-run -> validate`. Review
`plan-report.json` and `quarantine.json`, then copy `planSha256` into the
execute command. `db:migrate:legacy:execute` performs `apply -> verify` and
stops immediately if either phase fails.

The plan command recomputes the live source/candidate inventory and refuses a
stale `inventory.json`. Execute requires the connected database name, operator
confirmation, sealed plan target, and target baseline fingerprint to agree
before it creates indexes, a ledger, or application documents. Each execution
attempt writes immutable reports under `execution/<attempt-id>/`; rerunning the
same checksum is safe after a committed verification/reporting failure and
revalidates completed and pending batch state before continuing.

Advanced/recovery command contract:

```text
npm run db:migrate:legacy -- --inventory --run-dir <run-dir>
npm run db:migrate:legacy -- --dry-run --run-dir <run-dir> [--overrides <file>]
npm run db:migrate:legacy -- --validate --run-dir <run-dir>
npm run db:migrate:legacy -- --apply --run-dir <run-dir> --plan-sha256 <plan-sha256> --confirm-target <database>
npm run db:migrate:legacy -- --verify --run-dir <run-dir> --plan-sha256 <plan-sha256>
```

The plan checksum is the canonical hash embedded in `plan.json` (the
`plan-report.json` also records the separate on-disk file digest). Execute,
apply, and verify require the embedded checksum, not the file digest.

Mirror the existing catalog import exit semantics: `0` clean, `2` completed with quarantine/conflicts, and `1` fatal or rolled back.

## Next action

The transfer, byte-integrity check, structural archive inventory, Database Tools installation, and migration implementation are complete. The next operational dependency is an isolated MongoDB `8.0`-compatible deployment. Once its exact source namespace and access controls are set, run a no-write `mongorestore --dryRun` against it, then restore only the archive's `test.*` namespaces into the chosen `rescened_gen1_source_<run-id>` namespace. Do not run either command against a live or existing generation-2 database. After restore counts reconcile, use `db:migrate:legacy:plan`, review its sealed report, and use `db:migrate:legacy:execute` only after the social/manual dispositions are approved.
