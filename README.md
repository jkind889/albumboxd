# albumboxd

## MusicBrainz integration

Artist identities are resolved server-side from canonical Spotify artist URLs and cached in MongoDB. MusicBrainz requires an identified `User-Agent`; set one of these optional environment variables to identify your deployment:

- `MUSICBRAINZ_CONTACT`: a monitored email address or project URL. Albumboxd builds the header as `Albumboxd/<version> (<contact>)`.
- `MUSICBRAINZ_USER_AGENT`: a complete custom header, if you need to override the generated value.

When neither is configured, the repository URL is used as the contact. Provider calls are serialized per Node process to respect MusicBrainz's one-request-per-second guidance. Run a single MusicBrainz-calling process until this limiter is moved to shared infrastructure for multi-instance deployments.

Confirmed Spotify-to-MusicBrainz mappings are treated as durable identities and do not expire automatically. A failed lookup is cached for 24 hours before it can be retried. Pass `force: true` to the server-side resolver only when an explicit repair or revalidation workflow needs to replace an existing mapping.

## ListenBrainz related artists

The Explore API uses the experimental ListenBrainz Labs similar-artists dataset after resolving the seed Spotify artist to a MusicBrainz ID. Complete neighborhoods are cached in MongoDB for seven days and response limits are applied after reading the snapshot. Refresh is lazy: the first lookup after expiry requests a new snapshot. Expired snapshots are retained as stale fallbacks during provider outages or Labs contract changes; the `expiresAt` index is intentionally not a MongoDB TTL index.

Provider work is isolated behind per-seed single-flight deduplication, a process-wide concurrency cap, a short cold-failure backoff, and a route-specific user/IP rate limit. These guards are process-local; move them to shared infrastructure before scaling the API across multiple instances.

Optional environment variables:

- `LISTENBRAINZ_SIMILAR_ARTISTS_ALGORITHM`: overrides the precomputed similar-artists algorithm identifier.
- `LISTENBRAINZ_API_BASE_URL`: overrides the Labs API origin for local or integration testing.

Inspect a locally indexed artist with:

```http
GET /explore/artists/:spotifyArtistId/similar?limit=12
```

The limit must be between 1 and 50. The response includes the seed identity, ranked MusicBrainz neighbors, any already-known Spotify mappings for those neighbors, the provider algorithm, and both identity and neighborhood cache statuses. Neighborhood `cacheStatus` values are `miss` for the first snapshot, `hit` while it is fresh, `refreshed` after the weekly update, and `stale` when an expired snapshot is served during a provider failure. Spotify mapping hydration is optional: if that local enrichment fails, the endpoint still returns MBID neighbors with `spotifyMappingStatus: "unavailable"`.
