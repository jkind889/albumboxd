const assert = require("node:assert/strict");
const test = require("node:test");

const artistCatalogModelPath = require.resolve("../models/ArtistCatalog");
const musicBrainzHelperPath = require.resolve("../routes/utils/musicBrainz");

const SPOTIFY_ARTIST_ID = "4Z8W4fKeB5YxbusRsdQVPb";
const MUSICBRAINZ_ARTIST_ID = "a74b1b7f-71a5-4011-9441-d0b5e4122711";
const NOW = new Date("2026-07-17T12:00:00.000Z");
const RADIOHEAD_URL_LOOKUP = {
  id: "6e039c97-4476-4ddc-ab54-d226e8db5fb4",
  resource: `https://open.spotify.com/artist/${SPOTIFY_ARTIST_ID}`,
  relations: [
    {
      "target-type": "artist",
      type: "free streaming",
      ended: false,
      artist: {
        id: MUSICBRAINZ_ARTIST_ID,
        name: "Radiohead",
        "sort-name": "Radiohead",
        disambiguation: "",
        type: "Group",
        country: "GB",
      },
    },
  ],
};

let cachedArtist = null;
let savedArtist = null;
const findOneCalls = [];
const findOneAndUpdateCalls = [];

function applyUpdate(source, update) {
  const result = { ...(source || {}), ...(update.$set || {}) };

  for (const field of Object.keys(update.$unset || {})) {
    delete result[field];
  }

  return result;
}

function loadMusicBrainzHelper() {
  delete require.cache[musicBrainzHelperPath];

  require.cache[artistCatalogModelPath] = {
    id: artistCatalogModelPath,
    filename: artistCatalogModelPath,
    loaded: true,
    exports: {
      findOne: async (query) => {
        findOneCalls.push(query);
        return cachedArtist;
      },
      findOneAndUpdate: async (query, update, options) => {
        findOneAndUpdateCalls.push({ query, update, options });
        savedArtist = applyUpdate(cachedArtist, update);
        return savedArtist;
      },
    },
  };

  return require("../routes/utils/musicBrainz");
}

function jsonResponse(body, overrides = {}) {
  return {
    ok: true,
    status: 200,
    headers: {
      get: () => "",
    },
    json: async () => body,
    ...overrides,
  };
}

test.beforeEach(() => {
  cachedArtist = null;
  savedArtist = null;
  findOneCalls.length = 0;
  findOneAndUpdateCalls.length = 0;
});

test("MusicBrainz artist URL lookup uses the canonical Spotify resource and identified headers", async () => {
  const {
    buildArtistUrlLookupUrl,
    fetchArtistBySpotifyUrl,
    getMusicBrainzUserAgent,
  } = loadMusicBrainzHelper();
  const spotifyUrl = `https://open.spotify.com/artist/${SPOTIFY_ARTIST_ID}`;
  const lookupUrl = new URL(buildArtistUrlLookupUrl(spotifyUrl));
  let request = null;

  assert.equal(lookupUrl.origin, "https://musicbrainz.org");
  assert.equal(lookupUrl.pathname, "/ws/2/url");
  assert.equal(lookupUrl.searchParams.get("resource"), spotifyUrl);
  assert.equal(lookupUrl.searchParams.get("inc"), "artist-rels");
  assert.equal(lookupUrl.searchParams.get("fmt"), "json");
  assert.equal(
    getMusicBrainzUserAgent({ MUSICBRAINZ_CONTACT: "dev@example.com" }),
    "Rescened/1.0.0 (dev@example.com)",
  );

  const artist = await fetchArtistBySpotifyUrl(spotifyUrl, {
    env: { MUSICBRAINZ_CONTACT: "dev@example.com" },
    skipScheduling: true,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return jsonResponse(RADIOHEAD_URL_LOOKUP);
    },
  });

  assert.equal(new URL(request.url).searchParams.get("resource"), spotifyUrl);
  assert.deepEqual(request.options.headers, {
    Accept: "application/json",
    "User-Agent": "Rescened/1.0.0 (dev@example.com)",
  });
  assert.deepEqual(artist, {
    musicBrainzId: MUSICBRAINZ_ARTIST_ID,
    name: "Radiohead",
    sortName: "Radiohead",
    disambiguation: "",
    artistType: "Group",
    country: "GB",
  });
});

test("MusicBrainz lookup ignores ended relations and refuses ambiguous active mappings", () => {
  const {
    AmbiguousMusicBrainzMappingError,
    extractArtistFromUrlLookup,
  } = loadMusicBrainzHelper();
  const withEndedRelation = {
    relations: [
      {
        "target-type": "artist",
        ended: true,
        artist: { id: "ended-artist", name: "Old mapping" },
      },
      ...RADIOHEAD_URL_LOOKUP.relations,
    ],
  };

  assert.equal(
    extractArtistFromUrlLookup(withEndedRelation).musicBrainzId,
    MUSICBRAINZ_ARTIST_ID,
  );
  assert.throws(
    () => extractArtistFromUrlLookup({
      relations: [
        ...RADIOHEAD_URL_LOOKUP.relations,
        {
          "target-type": "artist",
          ended: false,
          artist: { id: "second-active-artist", name: "Another Radiohead" },
        },
      ],
    }),
    AmbiguousMusicBrainzMappingError,
  );
});

test("MusicBrainz lookup treats 404 as unmapped and exposes transient request failures", async () => {
  const {
    MusicBrainzRequestError,
    fetchArtistBySpotifyUrl,
  } = loadMusicBrainzHelper();
  const spotifyUrl = `https://open.spotify.com/artist/${SPOTIFY_ARTIST_ID}`;

  const missingArtist = await fetchArtistBySpotifyUrl(spotifyUrl, {
    skipScheduling: true,
    fetchImpl: async () => jsonResponse({}, { ok: false, status: 404 }),
  });

  assert.equal(missingArtist, null);
  await assert.rejects(
    () => fetchArtistBySpotifyUrl(spotifyUrl, {
      skipScheduling: true,
      maxAttempts: 1,
      fetchImpl: async () => jsonResponse({}, {
        ok: false,
        status: 503,
        headers: { get: () => "2" },
      }),
    }),
    (error) => error instanceof MusicBrainzRequestError
      && error.status === 503
      && error.retryAfter === "2",
  );
});

test("MusicBrainz lookup retries transient failures and honors Retry-After", async () => {
  const { fetchArtistBySpotifyUrl } = loadMusicBrainzHelper();
  const spotifyUrl = `https://open.spotify.com/artist/${SPOTIFY_ARTIST_ID}`;
  const retryDelays = [];
  let requestCount = 0;

  const artist = await fetchArtistBySpotifyUrl(spotifyUrl, {
    skipScheduling: true,
    maxAttempts: 2,
    random: () => 0,
    retryDelayImpl: async (delayMs) => retryDelays.push(delayMs),
    fetchImpl: async () => {
      requestCount += 1;

      if (requestCount === 1) {
        return jsonResponse({}, {
          ok: false,
          status: 503,
          headers: { get: () => "2" },
        });
      }

      return jsonResponse(RADIOHEAD_URL_LOOKUP);
    },
  });

  assert.equal(requestCount, 2);
  assert.deepEqual(retryDelays, [2000]);
  assert.equal(artist.musicBrainzId, MUSICBRAINZ_ARTIST_ID);
});

test("MusicBrainz lookup times out a hung provider request", async () => {
  const {
    MusicBrainzTimeoutError,
    fetchArtistBySpotifyUrl,
  } = loadMusicBrainzHelper();
  const spotifyUrl = `https://open.spotify.com/artist/${SPOTIFY_ARTIST_ID}`;

  await assert.rejects(
    () => fetchArtistBySpotifyUrl(spotifyUrl, {
      skipScheduling: true,
      maxAttempts: 1,
      requestTimeoutMs: 5,
      fetchImpl: async () => new Promise(() => {}),
    }),
    MusicBrainzTimeoutError,
  );
});

test("getOrResolveArtist treats a confirmed MBID as durable without provider revalidation", async () => {
  cachedArtist = {
    spotifyId: SPOTIFY_ARTIST_ID,
    spotifyUrl: `https://open.spotify.com/artist/${SPOTIFY_ARTIST_ID}`,
    name: "Radiohead",
    musicBrainzId: MUSICBRAINZ_ARTIST_ID,
    mappingStatus: "resolved",
    mappingSource: "spotify-url",
    mappingConfidence: 1,
    lastResolutionAttemptAt: new Date("2020-01-01T00:00:00.000Z"),
  };
  const { getOrResolveArtist } = loadMusicBrainzHelper();

  const result = await getOrResolveArtist(
    { spotifyId: SPOTIFY_ARTIST_ID, name: "Radiohead" },
    {
      now: NOW,
      fetchImpl: async () => {
        throw new Error("Fresh cache should avoid MusicBrainz");
      },
    },
  );

  assert.equal(result.cacheStatus, "hit");
  assert.equal(result.artist.musicBrainzId, MUSICBRAINZ_ARTIST_ID);
  assert.deepEqual(findOneCalls, [{ spotifyId: SPOTIFY_ARTIST_ID }]);
  assert.equal(findOneAndUpdateCalls.length, 0);
});

test("getOrResolveArtist honors a fresh negative cache without repeating a 404 lookup", async () => {
  cachedArtist = {
    spotifyId: SPOTIFY_ARTIST_ID,
    spotifyUrl: `https://open.spotify.com/artist/${SPOTIFY_ARTIST_ID}`,
    name: "Radiohead",
    mappingStatus: "not_found",
    mappingSource: "spotify-url",
    mappingConfidence: 0,
    lastResolutionAttemptAt: new Date("2026-07-17T06:00:00.000Z"),
  };
  const { getOrResolveArtist } = loadMusicBrainzHelper();

  const result = await getOrResolveArtist(
    { spotifyId: SPOTIFY_ARTIST_ID, name: "Radiohead" },
    {
      now: NOW,
      fetchImpl: async () => {
        throw new Error("Fresh negative cache should avoid MusicBrainz");
      },
    },
  );

  assert.equal(result.cacheStatus, "hit");
  assert.equal(result.artist.mappingStatus, "not_found");
  assert.equal(result.artist.musicBrainzId, null);
  assert.equal(findOneAndUpdateCalls.length, 0);
});

test("getOrResolveArtist stores an exact URL mapping on a cache miss", async () => {
  const { getOrResolveArtist } = loadMusicBrainzHelper();

  const result = await getOrResolveArtist(
    { spotifyId: SPOTIFY_ARTIST_ID, name: "Radiohead" },
    {
      now: NOW,
      skipScheduling: true,
      fetchImpl: async () => jsonResponse(RADIOHEAD_URL_LOOKUP),
    },
  );

  assert.equal(result.cacheStatus, "miss");
  assert.equal(result.artist.musicBrainzId, MUSICBRAINZ_ARTIST_ID);
  assert.equal(result.artist.mappingStatus, "resolved");
  assert.deepEqual(findOneAndUpdateCalls[0].query, {
    spotifyId: SPOTIFY_ARTIST_ID,
  });
  assert.equal(
    findOneAndUpdateCalls[0].update.$set.spotifyUrl,
    `https://open.spotify.com/artist/${SPOTIFY_ARTIST_ID}`,
  );
  assert.equal(findOneAndUpdateCalls[0].update.$set.mappingConfidence, 1);
  assert.equal(findOneAndUpdateCalls[0].options.upsert, true);
});

test("getOrResolveArtist can force-confirm removal of a stale MBID", async () => {
  cachedArtist = {
    spotifyId: SPOTIFY_ARTIST_ID,
    spotifyUrl: `https://open.spotify.com/artist/${SPOTIFY_ARTIST_ID}`,
    name: "Radiohead",
    musicBrainzId: "stale-mbid",
    musicBrainzName: "Stale Radiohead",
    mappingStatus: "resolved",
    mappingConfidence: 1,
    lastResolutionAttemptAt: new Date("2026-05-01T12:00:00.000Z"),
  };
  const { getOrResolveArtist } = loadMusicBrainzHelper();

  const result = await getOrResolveArtist(
    { spotifyId: SPOTIFY_ARTIST_ID, name: "Radiohead" },
    {
      force: true,
      now: NOW,
      skipScheduling: true,
      fetchImpl: async () => jsonResponse({}, { ok: false, status: 404 }),
    },
  );

  assert.equal(result.cacheStatus, "refreshed");
  assert.equal(result.artist.mappingStatus, "not_found");
  assert.equal(result.artist.musicBrainzId, null);
  assert.ok(findOneAndUpdateCalls[0].update.$unset.musicBrainzId !== undefined);
});

test("getOrResolveArtist serves stale data after a transient refresh failure", async () => {
  cachedArtist = {
    spotifyId: SPOTIFY_ARTIST_ID,
    spotifyUrl: `https://open.spotify.com/artist/${SPOTIFY_ARTIST_ID}`,
    name: "Radiohead",
    musicBrainzId: MUSICBRAINZ_ARTIST_ID,
    mappingStatus: "resolved",
    mappingConfidence: 1,
    lastResolutionAttemptAt: new Date("2026-05-01T12:00:00.000Z"),
  };
  const { getOrResolveArtist } = loadMusicBrainzHelper();

  const result = await getOrResolveArtist(
    { spotifyId: SPOTIFY_ARTIST_ID, name: "Radiohead" },
    {
      force: true,
      now: NOW,
      skipScheduling: true,
      maxAttempts: 1,
      fetchImpl: async () => jsonResponse({}, { ok: false, status: 503 }),
    },
  );

  assert.equal(result.cacheStatus, "stale");
  assert.equal(result.artist.musicBrainzId, MUSICBRAINZ_ARTIST_ID);
  assert.equal(
    findOneAndUpdateCalls[0].update.$set.lastResolutionError,
    "MusicBrainzRequestError",
  );
});

test("getOrResolveArtist deduplicates concurrent requests for one artist", async () => {
  const { getOrResolveArtist } = loadMusicBrainzHelper();
  let releaseProvider;
  let requestCount = 0;
  const providerResponse = new Promise((resolve) => {
    releaseProvider = () => resolve(jsonResponse(RADIOHEAD_URL_LOOKUP));
  });
  const options = {
    now: NOW,
    skipScheduling: true,
    fetchImpl: async () => {
      requestCount += 1;
      return providerResponse;
    },
  };

  const firstRequest = getOrResolveArtist(
    { spotifyId: SPOTIFY_ARTIST_ID, name: "Radiohead" },
    options,
  );
  const secondRequest = getOrResolveArtist(
    { spotifyId: SPOTIFY_ARTIST_ID, name: "Radiohead" },
    options,
  );

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requestCount, 1);
  releaseProvider();

  const [firstResult, secondResult] = await Promise.all([firstRequest, secondRequest]);
  assert.deepEqual(secondResult, firstResult);
  assert.equal(findOneCalls.length, 1);
  assert.equal(findOneAndUpdateCalls.length, 1);
});

test("getOrResolveArtist rejects a blank Spotify id before database or network work", async () => {
  const { getOrResolveArtist } = loadMusicBrainzHelper();

  await assert.rejects(
    () => getOrResolveArtist({ spotifyId: " " }),
    /Spotify artist id is required/,
  );
  assert.equal(findOneCalls.length, 0);
});

test("getOrResolveArtist rejects malformed Spotify ids before database work", async () => {
  const { getOrResolveArtist } = loadMusicBrainzHelper();

  await assert.rejects(
    () => getOrResolveArtist({ spotifyId: "not-a-spotify-id" }),
    /22 alphanumeric characters/,
  );
  assert.equal(findOneCalls.length, 0);
});
