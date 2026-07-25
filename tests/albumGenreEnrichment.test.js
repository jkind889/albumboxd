const assert = require("node:assert/strict");
const test = require("node:test");

const albumCatalogModelPath = require.resolve("../models/AlbumCatalog");
const musicBrainzHelperPath = require.resolve("../routes/utils/musicBrainz");
const albumGenreEnrichmentPath = require.resolve("../routes/utils/albumGenreEnrichment");

const SPOTIFY_ALBUM_ID = "0ETFjACtuP2ADo6LFhL6HN";
const SECOND_SPOTIFY_ALBUM_ID = "1weenld61qoidwYuZ1GESA";
const RELEASE_ID = "4f7f6e3e-3f3f-4ad1-9f53-bf27ea9aa0ca";
const SECOND_RELEASE_ID = "6cddf44d-88a4-44df-985a-84fbfcdd6258";
const RELEASE_GROUP_ID = "1ee8e0e9-f4d1-3048-9e99-2fbef6a21e27";
const SECOND_RELEASE_GROUP_ID = "6b3a75d0-7c57-39c1-8f4b-c5c63e55c9f3";
const NOW = new Date("2026-07-24T12:00:00.000Z");

class MockMusicBrainzRequestError extends Error {
  constructor(status, retryAfter = "") {
    super(`MusicBrainz request failed with status ${status}`);
    this.name = "MusicBrainzRequestError";
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

let storedAlbum = null;
let fetchMusicBrainzJsonImpl = async () => null;
const findOneCalls = [];
const findOneAndUpdateCalls = [];
const providerCalls = [];

function applyUpdate(source, update) {
  const result = { ...(source || {}), ...(update.$set || {}) };

  for (const field of Object.keys(update.$unset || {})) {
    delete result[field];
  }

  return result;
}

function loadAlbumGenreEnrichment() {
  delete require.cache[albumGenreEnrichmentPath];

  require.cache[albumCatalogModelPath] = {
    id: albumCatalogModelPath,
    filename: albumCatalogModelPath,
    loaded: true,
    exports: {
      findOne: async (query) => {
        findOneCalls.push(query);
        return storedAlbum;
      },
      findOneAndUpdate: async (query, update, options) => {
        findOneAndUpdateCalls.push({ query, update, options });
        storedAlbum = applyUpdate(storedAlbum, update);
        return storedAlbum;
      },
    },
  };

  require.cache[musicBrainzHelperPath] = {
    id: musicBrainzHelperPath,
    filename: musicBrainzHelperPath,
    loaded: true,
    exports: {
      MUSICBRAINZ_API_BASE_URL: "https://musicbrainz.org/ws/2",
      MusicBrainzRequestError: MockMusicBrainzRequestError,
      fetchMusicBrainzJson: async (url, options) => {
        providerCalls.push({ url, options });
        return fetchMusicBrainzJsonImpl(url, options);
      },
    },
  };

  return require("../routes/utils/albumGenreEnrichment");
}

test.beforeEach(() => {
  storedAlbum = null;
  fetchMusicBrainzJsonImpl = async () => null;
  findOneCalls.length = 0;
  findOneAndUpdateCalls.length = 0;
  providerCalls.length = 0;
});

test("album URL lookup uses canonical Spotify identity and MusicBrainz relation includes", () => {
  const {
    buildAlbumUrlLookupUrl,
    buildSpotifyAlbumUrl,
  } = loadAlbumGenreEnrichment();
  const spotifyUrl = buildSpotifyAlbumUrl(SPOTIFY_ALBUM_ID);
  const lookupUrl = new URL(buildAlbumUrlLookupUrl(spotifyUrl));

  assert.equal(spotifyUrl, `https://open.spotify.com/album/${SPOTIFY_ALBUM_ID}`);
  assert.equal(lookupUrl.pathname, "/ws/2/url");
  assert.equal(lookupUrl.searchParams.get("resource"), spotifyUrl);
  assert.equal(
    lookupUrl.searchParams.get("inc"),
    "release-rels+release-group-rels",
  );
  assert.equal(lookupUrl.searchParams.get("fmt"), "json");
  assert.throws(
    () => buildSpotifyAlbumUrl("not-a-spotify-id"),
    /22 alphanumeric characters/,
  );
});

test("album URL candidates ignore ended relations and retain direct release groups", () => {
  const { extractAlbumUrlCandidates } = loadAlbumGenreEnrichment();
  const candidates = extractAlbumUrlCandidates({
    relations: [
      {
        "target-type": "release",
        ended: true,
        release: { id: SECOND_RELEASE_ID },
      },
      {
        "target-type": "release",
        release: {
          id: RELEASE_ID,
          "release-group": { id: RELEASE_GROUP_ID },
        },
      },
      {
        "target-type": "release",
        release: { id: SECOND_RELEASE_ID },
      },
      {
        "target-type": "release_group",
        release_group: { id: RELEASE_GROUP_ID },
      },
      {
        "target-type": "artist",
        artist: { id: RELEASE_GROUP_ID },
      },
    ],
  });

  assert.deepEqual(candidates, {
    releaseIds: [RELEASE_ID, SECOND_RELEASE_ID].sort(),
    releaseIdsNeedingLookup: [SECOND_RELEASE_ID],
    releaseGroupIds: [RELEASE_GROUP_ID],
  });
});

test("release relationships collapse to one canonical release group", async () => {
  fetchMusicBrainzJsonImpl = async (url) => {
    const requestUrl = new URL(url);

    if (requestUrl.pathname === "/ws/2/url") {
      return {
        relations: [
          {
            "target-type": "release",
            release: { id: RELEASE_ID },
          },
          {
            "target-type": "release",
            release: {
              id: SECOND_RELEASE_ID,
              "release-group": { id: RELEASE_GROUP_ID },
            },
          },
        ],
      };
    }

    return {
      id: RELEASE_ID,
      "release-group": { id: RELEASE_GROUP_ID },
    };
  };
  const { resolveAlbumMusicBrainzMapping } = loadAlbumGenreEnrichment();
  const mapping = await resolveAlbumMusicBrainzMapping(SPOTIFY_ALBUM_ID);

  assert.equal(mapping.status, "resolved");
  assert.equal(mapping.releaseGroupId, RELEASE_GROUP_ID);
  assert.deepEqual(mapping.releaseIds, [RELEASE_ID, SECOND_RELEASE_ID].sort());
  assert.equal(providerCalls.length, 2);
  assert.equal(
    new URL(providerCalls[1].url).pathname,
    `/ws/2/release/${RELEASE_ID}`,
  );
});

test("separate Spotify editions can share one release group without sharing Spotify ids", async () => {
  fetchMusicBrainzJsonImpl = async () => ({
    relations: [
      {
        "target-type": "release_group",
        release_group: { id: RELEASE_GROUP_ID },
      },
    ],
  });
  const { resolveAlbumMusicBrainzMapping } = loadAlbumGenreEnrichment();
  const standard = await resolveAlbumMusicBrainzMapping(SPOTIFY_ALBUM_ID);
  const deluxe = await resolveAlbumMusicBrainzMapping(SECOND_SPOTIFY_ALBUM_ID);

  assert.notEqual(standard.spotifyUrl, deluxe.spotifyUrl);
  assert.equal(standard.releaseGroupId, RELEASE_GROUP_ID);
  assert.equal(deluxe.releaseGroupId, RELEASE_GROUP_ID);
});

test("strict mapping returns not_found or ambiguous instead of guessing", async () => {
  const { resolveAlbumMusicBrainzMapping } = loadAlbumGenreEnrichment();

  fetchMusicBrainzJsonImpl = async () => null;
  const missing = await resolveAlbumMusicBrainzMapping(SPOTIFY_ALBUM_ID);

  assert.equal(missing.status, "not_found");

  fetchMusicBrainzJsonImpl = async () => ({
    relations: [
      {
        "target-type": "release_group",
        release_group: { id: RELEASE_GROUP_ID },
      },
      {
        "target-type": "release_group",
        release_group: { id: SECOND_RELEASE_GROUP_ID },
      },
    ],
  });
  const ambiguous = await resolveAlbumMusicBrainzMapping(SPOTIFY_ALBUM_ID);

  assert.equal(ambiguous.status, "ambiguous");
  assert.deepEqual(
    ambiguous.releaseGroupIds,
    [RELEASE_GROUP_ID, SECOND_RELEASE_GROUP_ID].sort(),
  );
});

test("mapping fails when any active release cannot be collapsed to a release group", async () => {
  fetchMusicBrainzJsonImpl = async (url) => {
    const requestUrl = new URL(url);

    if (requestUrl.pathname === "/ws/2/url") {
      return {
        relations: [
          {
            "target-type": "release_group",
            release_group: { id: RELEASE_GROUP_ID },
          },
          {
            "target-type": "release",
            release: { id: RELEASE_ID },
          },
        ],
      };
    }

    return null;
  };
  const { resolveAlbumMusicBrainzMapping } = loadAlbumGenreEnrichment();

  await assert.rejects(
    resolveAlbumMusicBrainzMapping(SPOTIFY_ALBUM_ID),
    (error) => (
      error.name === "MusicBrainzMappingResolutionError"
      && error.releaseIds.includes(RELEASE_ID)
    ),
  );
});

test("unresolved release failures persist mapping candidates and diagnostic details", async () => {
  storedAlbum = {
    spotifyId: SPOTIFY_ALBUM_ID,
    musicBrainzMappingStatus: "pending",
    genreEnrichmentStatus: "pending",
  };
  fetchMusicBrainzJsonImpl = async (url) => {
    const requestUrl = new URL(url);

    if (requestUrl.pathname === "/ws/2/url") {
      return {
        relations: [
          {
            "target-type": "release_group",
            release_group: { id: RELEASE_GROUP_ID },
          },
          {
            "target-type": "release",
            release: { id: RELEASE_ID },
          },
        ],
      };
    }

    return null;
  };
  const { enrichAlbumGenres } = loadAlbumGenreEnrichment();
  const result = await enrichAlbumGenres(SPOTIFY_ALBUM_ID, { now: NOW });

  assert.equal(result.status, "failed");
  assert.equal(result.stage, "mapping");
  assert.equal(storedAlbum.musicBrainzMappingStatus, "failed");
  assert.deepEqual(storedAlbum.musicBrainzReleaseIds, [RELEASE_ID]);
  assert.deepEqual(storedAlbum.musicBrainzReleaseGroupCandidates, [
    RELEASE_GROUP_ID,
  ]);
  assert.match(
    storedAlbum.lastMusicBrainzMappingError,
    new RegExp(`${RELEASE_ID}.*${RELEASE_GROUP_ID}`),
  );
});

test("genre rankings combine case-insensitive names and keep five positive scores", () => {
  const { normalizeGenreRankings } = loadAlbumGenreEnrichment();
  const rankings = normalizeGenreRankings([
    { name: "Rock", count: 3 },
    { name: " rock ", count: 2 },
    { name: "Art Rock", count: 7 },
    { name: "Alternative Rock", count: 7 },
    { name: "Experimental Rock", count: 4 },
    { name: "Post-Rock", count: 3 },
    { name: "Indie Rock", count: 2 },
    { name: "Noise", count: 0 },
    { name: "Invalid", count: -2 },
  ]);

  assert.deepEqual(rankings, [
    { name: "alternative rock", score: 7 },
    { name: "art rock", score: 7 },
    { name: "rock", score: 5 },
    { name: "experimental rock", score: 4 },
    { name: "post-rock", score: 3 },
  ]);
});

test("genre lookup requests MusicBrainz genres without unrestricted tags", async () => {
  fetchMusicBrainzJsonImpl = async () => ({
    genres: [
      { name: "Modal Jazz", count: 9 },
      { name: "Jazz", count: 5 },
    ],
  });
  const { fetchReleaseGroupGenreRankings } = loadAlbumGenreEnrichment();
  const rankings = await fetchReleaseGroupGenreRankings(RELEASE_GROUP_ID);
  const lookupUrl = new URL(providerCalls[0].url);

  assert.equal(
    lookupUrl.pathname,
    `/ws/2/release-group/${RELEASE_GROUP_ID}`,
  );
  assert.equal(lookupUrl.searchParams.get("inc"), "genres");
  assert.equal(lookupUrl.searchParams.get("fmt"), "json");
  assert.deepEqual(rankings, [
    { name: "modal jazz", score: 9 },
    { name: "jazz", score: 5 },
  ]);
});

test("fresh mappings and failure cooldowns suppress provider retries until due", () => {
  const { isAlbumGenreEnrichmentDue } = loadAlbumGenreEnrichment();

  assert.equal(isAlbumGenreEnrichmentDue({
    musicBrainzMappingStatus: "resolved",
    musicBrainzReleaseGroupId: RELEASE_GROUP_ID,
    genreEnrichmentStatus: "resolved",
    genresSyncedAt: new Date("2026-07-01T12:00:00.000Z"),
  }, { now: NOW }), false);
  assert.equal(isAlbumGenreEnrichmentDue({
    musicBrainzMappingStatus: "resolved",
    musicBrainzReleaseGroupId: RELEASE_GROUP_ID,
    genreEnrichmentStatus: "resolved",
    genresSyncedAt: new Date("2026-06-01T12:00:00.000Z"),
  }, { now: NOW }), true);
  assert.equal(isAlbumGenreEnrichmentDue({
    musicBrainzMappingStatus: "not_found",
    lastMusicBrainzMappingAttemptAt: new Date("2026-07-24T06:00:00.000Z"),
  }, { now: NOW }), false);
  assert.equal(isAlbumGenreEnrichmentDue({
    musicBrainzMappingStatus: "ambiguous",
    lastMusicBrainzMappingAttemptAt: new Date("2026-07-01T12:00:00.000Z"),
  }, { now: NOW }), false);
  assert.equal(isAlbumGenreEnrichmentDue({
    musicBrainzMappingStatus: "failed",
    lastMusicBrainzMappingFailureAt: new Date("2026-07-24T11:50:00.000Z"),
  }, { now: NOW }), false);
  assert.equal(isAlbumGenreEnrichmentDue({
    musicBrainzMappingStatus: "not_found",
    lastMusicBrainzMappingAttemptAt: NOW,
  }, { force: true, now: NOW }), true);
});

test("enrichment persists a release-group mapping and backward-compatible genres", async () => {
  storedAlbum = {
    spotifyId: SPOTIFY_ALBUM_ID,
    musicBrainzMappingStatus: "pending",
    genreEnrichmentStatus: "pending",
  };
  fetchMusicBrainzJsonImpl = async (url) => {
    const requestUrl = new URL(url);

    if (requestUrl.pathname === "/ws/2/url") {
      return {
        relations: [
          {
            "target-type": "release_group",
            release_group: { id: RELEASE_GROUP_ID },
          },
        ],
      };
    }

    return {
      genres: [
        { name: "Modal Jazz", count: 9 },
        { name: "Jazz", count: 5 },
      ],
    };
  };
  const { enrichAlbumGenres } = loadAlbumGenreEnrichment();
  const result = await enrichAlbumGenres(SPOTIFY_ALBUM_ID, { now: NOW });

  assert.equal(result.status, "resolved");
  assert.equal(storedAlbum.musicBrainzMappingStatus, "resolved");
  assert.equal(storedAlbum.musicBrainzReleaseGroupId, RELEASE_GROUP_ID);
  assert.deepEqual(storedAlbum.genres, ["modal jazz", "jazz"]);
  assert.deepEqual(storedAlbum.genreRankings, [
    { name: "modal jazz", score: 9 },
    { name: "jazz", score: 5 },
  ]);
  assert.equal(storedAlbum.genreSource, "musicbrainz_release_group");
  assert.equal(storedAlbum.genreEnrichmentStatus, "resolved");
  assert.equal(findOneAndUpdateCalls.length, 2);
});

test("successful MusicBrainz responses without genres persist an empty result", async () => {
  storedAlbum = {
    spotifyId: SPOTIFY_ALBUM_ID,
    musicBrainzMappingStatus: "resolved",
    musicBrainzReleaseGroupId: RELEASE_GROUP_ID,
    genreEnrichmentStatus: "pending",
    genres: ["legacy spotify genre"],
  };
  fetchMusicBrainzJsonImpl = async () => ({ genres: [] });
  const { enrichAlbumGenres } = loadAlbumGenreEnrichment();
  const result = await enrichAlbumGenres(SPOTIFY_ALBUM_ID, { now: NOW });

  assert.equal(result.status, "empty");
  assert.equal(storedAlbum.genreEnrichmentStatus, "empty");
  assert.deepEqual(storedAlbum.genres, []);
  assert.deepEqual(storedAlbum.genreRankings, []);
});

test("forced remapping clears stale MusicBrainz genres when the URL is no longer mapped", async () => {
  storedAlbum = {
    spotifyId: SPOTIFY_ALBUM_ID,
    musicBrainzMappingStatus: "resolved",
    musicBrainzReleaseGroupId: RELEASE_GROUP_ID,
    genreEnrichmentStatus: "resolved",
    genres: ["jazz"],
    genreRankings: [{ name: "jazz", score: 5 }],
    genreSource: "musicbrainz_release_group",
    genresSyncedAt: new Date("2026-07-01T12:00:00.000Z"),
  };
  fetchMusicBrainzJsonImpl = async () => null;
  const { enrichAlbumGenres } = loadAlbumGenreEnrichment();
  const result = await enrichAlbumGenres(SPOTIFY_ALBUM_ID, {
    force: true,
    now: NOW,
  });

  assert.equal(result.status, "not_found");
  assert.equal(storedAlbum.musicBrainzMappingStatus, "not_found");
  assert.equal(storedAlbum.musicBrainzReleaseGroupId, undefined);
  assert.deepEqual(storedAlbum.genres, []);
  assert.deepEqual(storedAlbum.genreRankings, []);
  assert.equal(storedAlbum.genreSource, "");
  assert.equal(storedAlbum.genreEnrichmentStatus, "pending");
});

test("provider failures are persisted without erasing stale genre rankings", async () => {
  storedAlbum = {
    spotifyId: SPOTIFY_ALBUM_ID,
    musicBrainzMappingStatus: "resolved",
    musicBrainzReleaseGroupId: RELEASE_GROUP_ID,
    genreEnrichmentStatus: "resolved",
    genres: ["jazz"],
    genreRankings: [{ name: "jazz", score: 5 }],
    genresSyncedAt: new Date("2026-06-01T12:00:00.000Z"),
  };
  fetchMusicBrainzJsonImpl = async () => {
    const error = new Error("MusicBrainz unavailable");
    error.name = "MusicBrainzRequestError";
    throw error;
  };
  const { enrichAlbumGenres } = loadAlbumGenreEnrichment();
  const result = await enrichAlbumGenres(SPOTIFY_ALBUM_ID, { now: NOW });

  assert.equal(result.status, "failed");
  assert.equal(result.stage, "genres");
  assert.equal(storedAlbum.genreEnrichmentStatus, "resolved");
  assert.deepEqual(storedAlbum.genres, ["jazz"]);
  assert.deepEqual(storedAlbum.genreRankings, [{ name: "jazz", score: 5 }]);
  assert.match(
    storedAlbum.lastGenreEnrichmentError,
    /MusicBrainzRequestError: MusicBrainz unavailable/,
  );
});

test("a missing release-group endpoint fails without replacing stale genres with empty", async () => {
  storedAlbum = {
    spotifyId: SPOTIFY_ALBUM_ID,
    musicBrainzMappingStatus: "resolved",
    musicBrainzReleaseGroupId: RELEASE_GROUP_ID,
    genreEnrichmentStatus: "resolved",
    genres: ["jazz"],
    genreRankings: [{ name: "jazz", score: 5 }],
    genreSource: "musicbrainz_release_group",
    genresSyncedAt: new Date("2026-06-01T12:00:00.000Z"),
  };
  fetchMusicBrainzJsonImpl = async () => null;
  const { enrichAlbumGenres } = loadAlbumGenreEnrichment();
  const result = await enrichAlbumGenres(SPOTIFY_ALBUM_ID, { now: NOW });

  assert.equal(result.status, "failed");
  assert.equal(result.stage, "genres");
  assert.equal(storedAlbum.genreEnrichmentStatus, "resolved");
  assert.deepEqual(storedAlbum.genres, ["jazz"]);
  assert.deepEqual(storedAlbum.genreRankings, [{ name: "jazz", score: 5 }]);
  assert.match(storedAlbum.lastGenreEnrichmentError, /status 404.*status=404/);
});

test("forced remapping clears old release-group genres before fetching the new group", async () => {
  storedAlbum = {
    spotifyId: SPOTIFY_ALBUM_ID,
    musicBrainzMappingStatus: "resolved",
    musicBrainzReleaseGroupId: RELEASE_GROUP_ID,
    genreEnrichmentStatus: "resolved",
    genres: ["jazz"],
    genreRankings: [{ name: "jazz", score: 5 }],
    genreSource: "musicbrainz_release_group",
    genresSyncedAt: new Date("2026-07-01T12:00:00.000Z"),
  };
  fetchMusicBrainzJsonImpl = async (url) => {
    const requestUrl = new URL(url);

    if (requestUrl.pathname === "/ws/2/url") {
      return {
        relations: [
          {
            "target-type": "release_group",
            release_group: { id: SECOND_RELEASE_GROUP_ID },
          },
        ],
      };
    }

    throw new Error("new release group genres unavailable");
  };
  const { enrichAlbumGenres } = loadAlbumGenreEnrichment();
  const result = await enrichAlbumGenres(SPOTIFY_ALBUM_ID, {
    force: true,
    now: NOW,
  });

  assert.equal(result.status, "failed");
  assert.equal(result.stage, "genres");
  assert.equal(storedAlbum.musicBrainzReleaseGroupId, SECOND_RELEASE_GROUP_ID);
  assert.equal(storedAlbum.genreEnrichmentStatus, "failed");
  assert.deepEqual(storedAlbum.genres, []);
  assert.deepEqual(storedAlbum.genreRankings, []);
  assert.equal(storedAlbum.genreSource, "");
});

test("the lazy queue is non-blocking and deduplicates one Spotify album", async () => {
  storedAlbum = {
    spotifyId: SPOTIFY_ALBUM_ID,
    musicBrainzMappingStatus: "pending",
    genreEnrichmentStatus: "pending",
  };
  let releaseProvider;
  const providerResponse = new Promise((resolve) => {
    releaseProvider = resolve;
  });
  fetchMusicBrainzJsonImpl = async (url) => {
    const requestUrl = new URL(url);

    if (requestUrl.pathname === "/ws/2/url") {
      return providerResponse;
    }

    return { genres: [{ name: "Jazz", count: 4 }] };
  };
  const {
    scheduleAlbumGenreEnrichment,
    waitForAlbumGenreQueueIdle,
  } = loadAlbumGenreEnrichment();

  assert.equal(scheduleAlbumGenreEnrichment(storedAlbum), true);
  assert.equal(scheduleAlbumGenreEnrichment(storedAlbum), false);
  assert.equal(providerCalls.length, 0);

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(providerCalls.length, 1);
  releaseProvider({
    relations: [
      {
        "target-type": "release_group",
        release_group: { id: RELEASE_GROUP_ID },
      },
    ],
  });
  await waitForAlbumGenreQueueIdle();

  assert.equal(storedAlbum.genreEnrichmentStatus, "resolved");
  assert.deepEqual(storedAlbum.genres, ["jazz"]);
  assert.deepEqual(findOneCalls, [{ spotifyId: SPOTIFY_ALBUM_ID }]);
});

test("lazy enrichment can be disabled while the operator backfill runs", () => {
  const {
    isLazyAlbumGenreEnrichmentEnabled,
    scheduleAlbumGenreEnrichment,
  } = loadAlbumGenreEnrichment();
  const album = {
    spotifyId: SPOTIFY_ALBUM_ID,
    musicBrainzMappingStatus: "pending",
  };

  assert.equal(
    isLazyAlbumGenreEnrichmentEnabled({ ALBUM_GENRE_LAZY_ENRICHMENT: "false" }),
    false,
  );
  assert.equal(scheduleAlbumGenreEnrichment(album, {
    env: { ALBUM_GENRE_LAZY_ENRICHMENT: "false" },
  }), false);
});
