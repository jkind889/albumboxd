# Phase 2.5 Catalog Importer Retrospective

Status: Phase 2.5 implemented and verified; recurring synchronization, HTTP import endpoints, and public dataset-download endpoints remain deferred

Phase 2.5 created the catalog-data foundation that the Phase 3 contributor and moderator interfaces could safely build on. Before those interfaces existed, Rescened needed a useful album catalog that did not depend on Spotify and that could be reproduced, inspected, validated, and rolled out without bypassing database safeguards.

The result is a provider-neutral, offline pipeline that can assemble a ranked 500-album seed from ListenBrainz and MusicBrainz, prove that the generated file satisfies a strict versioned contract, and insert or refresh only accepted rows in `AlbumCatalog` inside one MongoDB transaction.

## What was delivered

- A ranking fetcher that combines ListenBrainz all-time, yearly, and monthly release-group statistics.
- MusicBrainz hydration for canonical titles, artist credits, release types, partial dates, and representative releases.
- A Draft-07 JSON Schema, semantic validator, two-album sample, and checked-in 500-album seed.
- A dry-run-first importer with quarantine, conflict detection, refresh preservation, optimistic concurrency, and transactions.
- Fetch, validation, import, quarantine, and checksum artifacts suitable for review and deployment evidence.
- Captured provider fixtures, a provider-neutral catalog guard, transactional integration tests, and an opt-in live-provider test.
- Documentation for commands, mapping rules, licensing, refresh behavior, failure semantics, and rollout.

### Phase 2.5 at a glance

| Area | Implemented result |
| --- | --- |
| Source | Sitewide ListenBrainz release-group rankings, hydrated through MusicBrainz core metadata. |
| Selection | 500 releases: 300 all-time, 150 yearly, and 50 monthly, with no more than five selected releases per primary artist. |
| Contract | Schema version `1.0.0`, `additionalProperties: false` at every object level, plus semantic validation. |
| Persistence | Insert or refresh `AlbumCatalog` by MusicBrainz release-group identity while preserving local and community-owned work. |
| Safety | Dry-run by default, quarantine before writes, one MongoDB transaction, atomic artifact publication, and deterministic exit codes. |
| Boundary | Catalog records only—no submissions, reviews, likes, boards, moderation activity, notifications, feed activity, or UI. |

## Purpose and scope

Phase 2 established provider-neutral catalog and moderation APIs, but the catalog still needed real records for search, detail, and social workflows. Phase 2.5 filled that gap without coupling catalog population to the optional public suggestion feed or to the Phase 3 interface.

The core implementation landed in commit `556aee1`, comprising 27 files and 27,588 insertions. Later handoff work tracked import reports alongside the Phase 3 UI. This retrospective describes the completed Phase 2.5 capability as it exists at handoff while keeping its boundaries distinct from Phase 3.

### Deliberate non-goals

- No HTTP fetch or import endpoint and no public download endpoint. Datasets are ordinary repository artifacts.
- No recurring synchronization, scheduled job, or deletion of catalog albums absent from a later seed.
- No reviews, likes, boards, profiles, submissions, moderation history, notifications, or approved-feed activity.
- No Phase 3 contributor or moderator interface and no optional public approved-suggestion feed.
- No tracks, labels, Spotify references, MusicBrainz tags, genres, ratings, annotations, or downloaded artwork in schema version 1.
- Cover Art Archive images are linked by URL rather than copied into the repository.

## Architecture and end-to-end flow

The pipeline has two operational stages separated by a strict JSON contract:

1. **Fetch and hydrate.** Read up to 1,000 sitewide release groups from each configured ListenBrainz range.
2. **Consolidate candidates.** Normalize MBIDs, deduplicate release groups, and retain every range, rank, and listen-count signal.
3. **Hydrate metadata.** Request MusicBrainz release-group details with artist credits, using pacing, cache, timeout, and retry controls.
4. **Normalize and select.** Map credits, release types, partial dates, and optional Cover Art Archive identity. Enforce quotas and the artist cap, backfilling from lower-ranked candidates when a record is rejected.
5. **Publish artifacts.** Atomically write the dataset, SHA-256 checksum, and fetch report only after the 500-album target is filled.
6. **Validate and preflight.** Reject fatal envelopes, quarantine bad rows or database conflicts, construct the final merged documents, and validate those documents again.
7. **Apply transactionally.** Insert or refresh accepted rows in one MongoDB transaction. Quarantined rows never become model writes.

The implementation is primarily organized around:

- [`lib/catalogImport/listenBrainz.js`](../lib/catalogImport/listenBrainz.js) for ranking collection, hydration, mapping, caching, retries, selection, and atomic artifact publication.
- [`lib/catalogImport/dataset.js`](../lib/catalogImport/dataset.js) for schema and semantic dataset validation.
- [`lib/catalogImport/persistence.js`](../lib/catalogImport/persistence.js) for CLI argument handling, database preflight, merge rules, conflict detection, and transactional persistence.
- [`scripts/fetchListenBrainzCatalog.js`](../scripts/fetchListenBrainzCatalog.js), [`scripts/validateCatalogDataset.js`](../scripts/validateCatalogDataset.js), and [`scripts/importCatalogDataset.js`](../scripts/importCatalogDataset.js) for the command-line interfaces.
- [`models/AlbumCatalog.js`](../models/AlbumCatalog.js) for the persisted catalog contract.

## Data acquisition and normalization

### ListenBrainz selection

The fetcher reads sitewide release-group statistics rather than individual listening histories. Each range supplies both a candidate pool and a required contribution to the final dataset.

| Range | Final quota | Candidate ceiling | Selection role |
| --- | ---: | ---: | --- |
| `all_time` | 300 | 1,000 | Stable long-horizon popularity |
| `year` | 150 | 1,000 | Recent annual listening |
| `month` | 50 | 1,000 | Short-horizon momentum |

The final composition must be exact. The five-release limit is applied globally per primary credited artist, not independently within each range.

If a candidate is malformed, duplicates an earlier MBID, fails MusicBrainz hydration, violates the dataset contract, or exceeds the artist cap, the fetcher continues lower in the ranking until the affected quota is filled. A strict row-validation gate runs before the candidate consumes a quota slot.

When one release group appears in multiple rankings, its MBID is deduplicated but every distinct selection observation is preserved. This allows the final row to retain multiple `range`, `rank`, and `listenCount` signals without creating duplicate albums.

### MusicBrainz hydration and field mapping

Each selected release group is hydrated through MusicBrainz with `inc=artist-credits`.

| Field | Normalization rule |
| --- | --- |
| Artist display | Compose credited names using MusicBrainz join phrases and preserve individual artist-credit MBIDs. |
| Release type | Apply secondary-type precedence: soundtrack → mixtape/street → live → remix → compilation. Otherwise map Album, EP, and Single directly; all remaining values become `other`. |
| Release date | Accept only `YYYY`, `YYYY-MM`, or `YYYY-MM-DD`. Unknown dates remain empty with `releaseYear: null`; missing components are never invented. |
| Cover | Construct a 500-pixel Cover Art Archive URL only when both a valid representative-release MBID and image ID are available. |
| Ranking signals | Retain every observed ListenBrainz range, rank, and listen count for the release group. |

The importer deliberately ignores MusicBrainz tags, genres, annotations, and ratings. It also excludes Spotify identities and references from the catalog import path.

### Provider etiquette, retries, and resumability

- **User agent:** MusicBrainz receives a meaningful Rescened user agent.
- **Rate gate:** MusicBrainz requests are serialized approximately 1.1 seconds apart, staying within the provider's one-request-per-second policy.
- **Caching:** Successful MusicBrainz responses are cached so interrupted fetches can resume without repeating completed hydration requests.
- **Cache validation:** Cached timestamps must be valid strict ISO timestamps before a response is reused.
- **Timeouts and retries:** Requests use bounded timeouts and no more than three retry attempts.
- **Backoff:** Transient failures use exponential fallback, while `Retry-After` delta-seconds and HTTP dates are honored in full.
- **Bundle publication:** Dataset, checksum, and fetch report are staged together. If final publication fails, the previous bundle is restored and partial new artifacts are removed.

## Dataset contract and validation

The checked-in [Draft-07 JSON Schema](../data/catalog-import/catalog-import.schema.json) is the trust boundary between remote source data and the database. Dataset version `1.0.0` uses `additionalProperties: false` throughout and places bounds on MBIDs, URLs, strings, arrays, counts, ranks, enums, and dates.

The [two-album sample](../data/catalog-import/catalog-import.sample.json) demonstrates the accepted shape using official CC0 core metadata. The [dated seed](../data/catalog-import/seeds/listenbrainz-2026-08-14.json) is the full 500-album rollout artifact.

### Envelope and album responsibilities

| Contract layer | Required information |
| --- | --- |
| Envelope | `schemaVersion`, `datasetId`, `generatedAt`, target count, selected ranges, quotas, candidate limits, source timestamps, licenses, and `albums`. |
| Album identity | MusicBrainz release-group MBID plus an optional representative-release MBID; no local UUID or `catalogSource`. |
| Selection | `selectedRange` and one or more ListenBrainz signals containing `range`, `rank`, and `listenCount`. |
| Normalized metadata | Title, `artistDisplayName`, `artistCredits`, Rescened `releaseType`, strict date tuple, and optional Cover Art Archive identity. |
| Source lineage | ListenBrainz and MusicBrainz fetch timestamps; envelope licenses later generate importer-owned provenance. |

Version 1 deliberately excludes tracks and labels. New imported albums receive empty defaults for those fields. Adding source-supplied tracks or labels requires a schema-version change.

The file is also prohibited from supplying local persistence policy. The importer generates:

- UUID v4 `albumId` values.
- `catalogSource: "import"`.
- Provider-neutral `externalReferences`.
- Field-level provenance.

### Schema and semantic validation

JSON Schema validation is followed by semantic checks that JSON Schema alone cannot safely express. These include:

- Agreement between `releaseDate`, `releaseDatePrecision`, and `releaseYear`.
- Exact selection-range composition against the declared quotas.
- Valid range/rank relationships and one selected-range signal per album.
- Cross-row release-group uniqueness.
- Global primary-artist cap enforcement.
- Coherent representative-release and Cover Art Archive identities.
- Strict URL and MBID normalization.

Only otherwise valid rows consume range quota slots during validation. Invalid or duplicate rows therefore do not prevent a later valid row from satisfying the declared mix.

### Fatal errors versus row quarantine

Fatal conditions stop the entire run with zero writes:

- Malformed JSON.
- A dataset larger than 25 MiB.
- An invalid envelope.
- An unsupported schema version.
- Impossible quota metadata or a mismatch between the target and album count.
- Zero valid albums after validation.

Row-level conditions are quarantined and excluded while the rest of the dataset can continue:

- Invalid album rows or unknown fields.
- Duplicate source identities.
- Range overflow or ranking errors.
- Artist-cap violations.
- Failed or semantically invalid hydration results during fetch.
- Inconsistent date or Cover Art Archive references.
- Existing manual or community catalog conflicts.
- Final merged documents that fail semantic or Mongoose validation.

Each quarantine entry records the row index, source release-group MBID when available, a stable error code, JSON pointer, message, and detailed issues. Quarantined rows are never passed to a model write.

## Import and persistence semantics

### Dry-run by default

The importer connects to the configured database so it can classify new rows, refresh candidates, unchanged rows, and conflicts, but it does not mutate anything unless `--apply` is explicit.

| Mode | Database effect | Primary use |
| --- | --- | --- |
| Default or `--dry-run` | No writes | Inspect inserts, refreshes, unchanged rows, conflicts, and quarantine output. |
| `--apply` | One transactional batch | Persist the exact accepted plan after the environment and report paths are confirmed. |

Unknown, repeated, aliased, or conflicting command-line arguments fail immediately. Input, import-report, and quarantine-report paths are checked so one artifact cannot overwrite the input dataset or another report.

### Matching and insertion

Albums are matched by a MusicBrainz `release-group` external reference. Incoming MBIDs are normalized and database lookup is case-insensitive, preventing an uppercase community or manual reference from evading conflict detection.

For a new accepted album, the importer:

- Generates a UUID v4 `albumId`.
- Sets `catalogSource` to `import`.
- Creates MusicBrainz release-group and optional representative-release references.
- Generates importer-owned field provenance from the source-license envelope.
- Initializes tracks and label to empty defaults.
- Runs semantic and Mongoose validation before constructing the write.

### Refresh behavior

Existing imported albums can be refreshed from a later compatible dataset without replacing Rescened-owned identity or community work.

| Existing data | Refresh behavior |
| --- | --- |
| `albumId` | Always preserved. |
| Tracks and label | Always preserved because schema version 1 does not source them. |
| Non-MusicBrainz references | Preserved. |
| Manual or community-owned fields | Preserved according to `fieldProvenance`; coupled date fields are preserved as a coherent tuple. |
| Cover | Keep the existing cover when incoming artwork is absent. Refresh importer-owned Cover Art Archive artwork when a replacement exists. |
| Representative release | Preserve the supporting release reference when the retained cover depends on it. |
| Albums missing from a later seed | Never deleted. |

Fields owned by manual or community provenance are protected from importer refresh. The final merged document is rechecked for coherent dates and references, then passed through Mongoose validation.

### Conflict detection

Preflight catches conflicts before writes are constructed, including:

- Duplicate release-group identities in the input dataset.
- Duplicate representative releases assigned to more than one input album.
- Representative-release references already owned by another catalog record.
- Manual or community catalog rows with the same MusicBrainz release-group identity.
- Uppercase or otherwise differently cased versions of an existing MBID.
- Final merged documents that fail semantic or Mongoose validation.

Manual and community catalog collisions are reported and left unchanged. They are never silently converted into imported rows.

### Transaction and concurrency boundary

All accepted inserts and refreshes execute as one ordered bulk operation inside one MongoDB transaction. A persistence error rolls the accepted batch back; quarantined rows remain untouched.

Refresh filters include the previously observed `updatedAt` value. If another process or user changes an imported record after preflight, optimistic concurrency prevents the stale refresh from overwriting that edit and the transaction is rolled back.

Apply mode therefore requires a transaction-capable MongoDB deployment: MongoDB Atlas, a replica set, or a sharded cluster. A standalone MongoDB server cannot execute the transactional write path.

## Reporting and failure meaning

Reports are part of the operational contract rather than incidental logs. Fetch, validation, import, and quarantine artifacts are written atomically. Import reports distinguish `inserted`, `refreshed`, `unchanged`, `quarantined`, and `conflicted` records so a dry-run plan can be compared with an apply result.

### Exit codes

| Code | Meaning | Database state |
| ---: | --- | --- |
| `0` | Clean completed run | Dry-run wrote nothing; apply committed all accepted operations. |
| `2` | Completed with quarantine or conflict entries | Only accepted operations committed when apply was requested. |
| `1` | Fatal validation, failed or rolled-back transaction, or exceptional committed-state artifact failure | Inspect the report status; a committed-state report failure is explicitly distinguished from a rollback. |

Report destinations are preflighted and both report files are staged before apply can mutate MongoDB. If database work fails, the error retains the known plan and quarantine state and MongoDB rolls the transaction back.

If the database commits but an exceptional filesystem error prevents final report publication, the CLI reports that the database committed instead of falsely describing the run as rolled back. This distinction avoids an unsafe blind retry.

## Delivered repository artifacts

| Artifact | Purpose |
| --- | --- |
| [Dataset schema](../data/catalog-import/catalog-import.schema.json) | Draft-07 contract for dataset version `1.0.0`. |
| [Two-album sample](../data/catalog-import/catalog-import.sample.json) | Small valid dataset demonstrating the accepted shape. |
| [Dated 500-album seed](../data/catalog-import/seeds/listenbrainz-2026-08-14.json) | Full catalog seed used for rollout. |
| [Seed SHA-256](../data/catalog-import/seeds/listenbrainz-2026-08-14.json.sha256) | Exact-file integrity check. |
| [Fetch report](../data/catalog-import/seeds/listenbrainz-2026-08-14.json.fetch-report.json) | Ranking, hydration, rejection, cache, and selection counts. |
| [Validation report](../data/catalog-import/seeds/listenbrainz-2026-08-14.validation-report.json) | Strict validation result for the seed. |
| [Import report](../data/catalog-import/seeds/listenbrainz-2026-08-14.import-report.json) | Insert, refresh, unchanged, quarantine, and conflict classifications. |
| [Quarantine report](../data/catalog-import/seeds/listenbrainz-2026-08-14.quarantine-report.json) | Row-level exclusion evidence. |
| [Captured provider fixtures](../tests/fixtures/catalogImport/) | Official ListenBrainz and MusicBrainz response examples; no artwork files. |
| [Catalog import guide](./CATALOG_IMPORT.md) | Command, mapping, licensing, refresh, and rollout reference. |

The schema, sample, and generated seed are checked-in repository artifacts. They can be viewed or downloaded from the repository, but Phase 2.5 did not introduce a public application endpoint for downloading them.

## Generated seed results

### Validated seed profile

| Metric | Observed result |
| --- | --- |
| Final albums | 500 valid; 0 quarantined |
| Range composition | 300 `all_time`; 150 `year`; 50 `month` |
| Identity | 500 unique release-group MBIDs |
| Artist diversity | 281 primary artists; maximum five releases per artist |
| Artwork | 499 Cover Art Archive references; one album without artwork |
| Release types | 441 album; 26 single; 15 soundtrack; 9 EP; 6 mixtape; 2 remix; 1 compilation |
| Date precision | 492 day; 5 month; 3 year |
| SHA-256 | `06185487d1e6e7180d0973fde018a91e9f67105e297c3a8b517e7e298635fc21` |

### Fetch funnel

| Stage | Count | Interpretation |
| --- | ---: | --- |
| Ranking rows fetched | 3,000 | 1,000 from each selected range |
| Valid ranking rows | 2,899 | 101 invalid MBID rows rejected |
| Unique candidate MBIDs | 1,444 | 1,455 duplicate observations consolidated as signals |
| Hydrated candidates | 548 | Enough valid metadata to fill quotas after artist caps |
| Rejected candidates | 149 | 101 invalid MBIDs plus 48 artist-cap rejections |
| Selected albums | 500 | Exact target; final dataset validation had zero row rejections |

These figures come from the checked-in seed and its validation and fetch reports.

### Tracked apply evidence

The checked-in full-seed apply report records:

- 498 inserted albums.
- 2 refreshed albums.
- 0 unchanged albums.
- 0 quarantined albums.
- 0 conflicts.

The report does not identify the target database environment. It is evidence that an apply completed successfully, but it is not proof that the database currently configured by `MONGO_URI` contains those rows. A fresh dry-run remains necessary before another apply.

## Verification coverage

### Automated behavior covered

- **Selection:** Cross-range deduplication, repeated signal preservation, lower-ranked quota backfill, exact composition, and the global primary-artist cap.
- **Mapping:** Artist-credit join phrases, release-type precedence, partial and leap-year dates, Cover Art Archive URL construction, and strict unknown-field rejection.
- **Networking:** Rate gating, timeouts, bounded retries, full `Retry-After` handling, cache and resume behavior, and atomic artifact rollback.
- **Validation:** Fatal envelopes, mixed valid and invalid datasets, semantic mismatches, exact range quotas, and proof that malformed rows never reach model writes.
- **Persistence:** Inserts, refreshes, idempotent reruns, UUID preservation, manual and community protection, reference uniqueness, optimistic concurrency, and transaction rollback.
- **Provider fixtures:** Captured official ListenBrainz and MusicBrainz responses exercise the production mapping path without default network access.

### Verification snapshot at Phase 2.5 completion

| Check | Result |
| --- | --- |
| Normal test suite | 93 total; 83 passed; 10 expected skips; 0 failures |
| Replica-set integrations | 9 of 9 passed for transactional and rollback behavior |
| Provider-neutral guard | Passed; no Spotify dependency returned to catalog or importer paths |
| Full seed validation | 500 valid; 0 quarantined |
| Live provider test | Available only when `RUN_LIVE_CATALOG_FETCH=true`; skipped by default |

The subsequent Phase 3 commit added one frontend test, so the repository then reported 94 total tests and 84 passing. That additional test belongs to Phase 3 rather than the Phase 2.5 importer scope.

Relevant test files include:

- [`tests/listenBrainzCatalog.test.js`](../tests/listenBrainzCatalog.test.js)
- [`tests/catalogDataset.test.js`](../tests/catalogDataset.test.js)
- [`tests/catalogImport.test.js`](../tests/catalogImport.test.js)
- [`tests/catalogImport.integration.test.js`](../tests/catalogImport.integration.test.js)
- [`tests/catalogProviderFixtures.test.js`](../tests/catalogProviderFixtures.test.js)
- [`tests/listenBrainzCatalog.live.test.js`](../tests/listenBrainzCatalog.live.test.js)

## Operating the pipeline

### Fetch a new seed

The default blend is 300 all-time, 150 yearly, and 50 monthly releases with a maximum of five selected releases per primary artist.

```sh
npm run catalog:fetch -- --output data/catalog-import/seeds/listenbrainz-YYYY-MM-DD.json
```

The fetcher writes the dataset, its `.sha256` sidecar, and its `.fetch-report.json` sidecar. It publishes the bundle only after all 500 valid albums are available.

### Validate without MongoDB

```sh
npm run catalog:validate -- --input data/catalog-import/seeds/listenbrainz-YYYY-MM-DD.json
```

Validation requires no database connection. It checks the envelope, every album row, semantic relationships, declared range composition, and cross-row rules.

### Run a database-aware dry-run

```sh
MONGO_URI='mongodb://...' npm run catalog:import -- \
  --input data/catalog-import/seeds/listenbrainz-YYYY-MM-DD.json \
  --dry-run
```

Omitting both mode flags also selects dry-run behavior. Review the import and quarantine reports before applying.

### Apply accepted rows

```sh
MONGO_URI='mongodb://...' npm run catalog:import -- \
  --input data/catalog-import/seeds/listenbrainz-YYYY-MM-DD.json \
  --apply
```

`--apply` must be explicit. Apply mode requires transaction support.

### Run verification commands

```sh
npm test
npm run test:integration
npm run check:catalog-contract
```

The live-provider smoke test is opt-in and intentionally retains production request pacing:

```sh
RUN_LIVE_CATALOG_FETCH=true npm run test:catalog-live
```

Normal tests use the captured CC0 provider fixtures and do not contact ListenBrainz or MusicBrainz.

### Sample versus full seed

Use [`data/catalog-import/catalog-import.sample.json`](../data/catalog-import/catalog-import.sample.json) for a small two-album validation or development import. Use the dated seed for a full catalog rollout.

Re-running an identical dataset is idempotent. Matching imported records are classified as unchanged unless importer-owned source metadata has changed.

## Safe rollout sequence

1. **Confirm the environment.** Verify that `MONGO_URI` points to the intended transaction-capable database and take an appropriate backup or snapshot.
2. **Verify the artifact.** Check the seed against its committed SHA-256 sidecar and use the identical file throughout the rollout.
3. **Validate offline.** Run `catalog:validate` and resolve any fatal error before opening a database connection.
4. **Dry-run against the database.** Review inserted, refreshed, unchanged, conflicted, and quarantined counts and inspect every quarantine entry.
5. **Apply explicitly.** Use `--apply` only when the environment and preflight plan match expectations.
6. **Smoke-test.** Exercise catalog search and detail plus the Phase 3 submission, approval, profile, notification, and board workflows against the populated catalog.
7. **Retain evidence.** Keep the exact seed, checksum, import report, quarantine report, and target-environment record together.

No automatic recurring synchronization was introduced. A later synchronization service would require its own lifecycle, scheduling, deletion, conflict, freshness, and operational policies.

## Licensing and provenance

The dataset envelope records source-license information used to generate field provenance:

- ListenBrainz listening data is recorded as CC0 1.0.
- MusicBrainz core metadata is recorded as CC0 1.0.
- MusicBrainz tags, genres, annotations, and ratings are not imported.
- Cover Art Archive images are linked, not redistributed by the seed.
- Cover copyrights vary by image. Linking a Cover Art Archive URL does not clear copyright or reuse restrictions.

Both the release-group and representative-release identities are retained when available so imported fields and artwork can be traced to their upstream sources.

## What Phase 3 inherited

Phase 3 could assume that album search and selection had a provider-neutral catalog behind them. It added authenticated contributor and moderator interfaces—submission forms, moderation queues, notifications, profile history, and board workflows—without making the UI responsible for sourcing or normalizing catalog metadata.

The importer still creates catalog albums only. It never synthesizes reviews, likes, boards, submissions, approvals, moderation events, notifications, or public-feed activity.

For the UI and API boundaries that followed, see:

- [Phase 2 community album submissions](./PHASE_2_SUBMISSIONS.md)
- [Phase 3 community submission UI](./PHASE_3_UI.md)

## Known handoff caveats

- **Database provenance:** The tracked full-seed apply report omits the target environment. Confirm `MONGO_URI` and run a fresh dry-run before any repeat apply.
- **Malformed sample sidecar:** `data/catalog-import/catalog-import.sample.quarantine-report.json` begins with an accidentally pasted shell command and is not valid JSON in its current form. The sample dataset itself is valid.
- **Artwork rights:** ListenBrainz and MusicBrainz core data are recorded as CC0, but Cover Art Archive rights vary by image.
- **No automatic freshness:** The checked-in seed is a point-in-time artifact. Phase 2.5 does not keep it synchronized automatically.

Before the next full catalog apply:

- Repair or remove the malformed sample quarantine sidecar so every checked-in example report is parseable.
- Confirm the target database, transaction support, indexes, and current `AlbumCatalog` contents.
- Run validation and dry-run against the exact checksummed seed intended for that environment.
- Review conflicts and quarantine, then run catalog, search, detail, and Phase 3 social smoke tests after apply.
- Record the deployment environment with the retained reports so later maintainers know where the seed landed.

## Source basis

This retrospective was reconstructed from commit `556aee1`, the current importer implementation, [the catalog import guide](./CATALOG_IMPORT.md), checked-in catalog artifacts, package scripts, automated tests, and `PC_HANDOFF.md`.

The preceding Phase 2 moderation backend is represented by commit `b3c27d8`; the subsequent Phase 3 UI is represented by commit `dc66e27`.

Phase 2.5 did not add another user-facing feature. It made the upcoming features credible by giving Rescened a reproducible real-data catalog, a strict trust boundary, and an import path that protects both database integrity and future community-owned edits.
