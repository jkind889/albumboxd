# albumboxd

## MusicBrainz integration

Artist identities are resolved server-side from canonical Spotify artist URLs and cached in MongoDB. MusicBrainz requires an identified `User-Agent`; set one of these optional environment variables to identify your deployment:

- `MUSICBRAINZ_CONTACT`: a monitored email address or project URL. Albumboxd builds the header as `Albumboxd/<version> (<contact>)`.
- `MUSICBRAINZ_USER_AGENT`: a complete custom header, if you need to override the generated value.

When neither is configured, the repository URL is used as the contact. Provider calls are serialized per Node process to respect MusicBrainz's one-request-per-second guidance. Run a single MusicBrainz-calling process until this limiter is moved to shared infrastructure for multi-instance deployments.
