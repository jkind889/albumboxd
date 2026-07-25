const assert = require("node:assert/strict");
const test = require("node:test");

const artistNeighborhoodModelPath = require.resolve("../models/ArtistNeighborhood");
const listenBrainzHelperPath = require.resolve("../routes/utils/listenBrainz");

const SEED_MBID = "8f6bd1e4-fbe1-4f50-aa9b-94c450ec0f11";
const MASSIVE_ATTACK_MBID = "10adbe5e-a2c0-4bf3-8249-2b4cbf6e6ca8";
const RADIOHEAD_MBID = "a74b1b7f-71a5-4011-9441-d0b5e4122711";
const NOW = new Date("2026-07-18T12:00:00.000Z");
const ALGORITHM = "test-similar-artists-algorithm";
const SIMILAR_ARTISTS_PAYLOAD = [
  {
    artist_mbid: MASSIVE_ATTACK_MBID,
    name: "Massive Attack",
    comment: "Bristol group",
    type: "Group",
    gender: null,
    score: 100,
    reference_mbid: SEED_MBID,
  },
  {
    artist_mbid: RADIOHEAD_MBID,
    name: "Radiohead",
    comment: "",
    type: "Group",
    gender: null,
    score: 80,
    reference_mbid: SEED_MBID,
  },
];

let cachedNeighborhood = null;
let savedNeighborhood = null;
const findOneCalls = [];
const findOneAndUpdateCalls = [];

function applyUpdate(source, update) {
  const result = { ...(source || {}), ...(update.$set || {}) };

  for (const field of Object.keys(update.$unset || {})) {
    delete result[field];
  }

  return result;
}

function loadListenBrainzHelper() {
  delete require.cache[listenBrainzHelperPath];

  require.cache[artistNeighborhoodModelPath] = {
    id: artistNeighborhoodModelPath,
    filename: artistNeighborhoodModelPath,
    loaded: true,
    exports: {
      findOne: async (query) => {
        findOneCalls.push(query);
        return cachedNeighborhood;
      },
      findOneAndUpdate: async (query, update, options) => {
        findOneAndUpdateCalls.push({ query, update, options });
        savedNeighborhood = applyUpdate(cachedNeighborhood, update);
        return savedNeighborhood;
      },
    },
  };

  return require("../routes/utils/listenBrainz");
}

function jsonResponse(body, overrides = {}) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => "" },
    json: async () => body,
    text: async () => JSON.stringify(body),
    ...overrides,
  };
}

function cachedSnapshot(overrides = {}) {
  return {
    seedMusicBrainzId: SEED_MBID,
    source: "listenbrainz",
    algorithm: ALGORITHM,
    normalizationVersion: 1,
    neighbors: [],
    fetchedAt: new Date("2026-07-17T12:00:00.000Z"),
    expiresAt: new Date("2026-07-24T12:00:00.000Z"),
    ...overrides,
  };
}

test.beforeEach(() => {
  cachedNeighborhood = null;
  savedNeighborhood = null;
  findOneCalls.length = 0;
  findOneAndUpdateCalls.length = 0;
});

test("ListenBrainz builds the official similar-artists request and normalizes results", async () => {
  const {
    buildSimilarArtistsUrl,
    fetchSimilarArtists,
  } = loadListenBrainzHelper();
  const requestUrl = new URL(buildSimilarArtistsUrl(SEED_MBID, { algorithm: ALGORITHM }));
  let providerRequest = null;

  assert.equal(requestUrl.origin, "https://labs.api.listenbrainz.org");
  assert.equal(requestUrl.pathname, "/similar-artists/json");
  assert.equal(requestUrl.searchParams.get("artist_mbids"), SEED_MBID);
  assert.equal(requestUrl.searchParams.get("algorithm"), ALGORITHM);

  const neighbors = await fetchSimilarArtists(SEED_MBID, {
    algorithm: ALGORITHM,
    maxAttempts: 1,
    env: { MUSICBRAINZ_CONTACT: "dev@example.com" },
    fetchImpl: async (url, options) => {
      providerRequest = { url, options };
      return jsonResponse(SIMILAR_ARTISTS_PAYLOAD);
    },
  });

  assert.equal(new URL(providerRequest.url).searchParams.get("artist_mbids"), SEED_MBID);
  assert.deepEqual(providerRequest.options.headers, {
    Accept: "application/json",
    "User-Agent": "Rescened/1.0.0 (dev@example.com)",
  });
  assert.deepEqual(neighbors, [
    {
      musicBrainzId: MASSIVE_ATTACK_MBID,
      name: "Massive Attack",
      comment: "Bristol group",
      artistType: "Group",
      gender: "",
      rawScore: 100,
      rank: 1,
      weight: 1,
    },
    {
      musicBrainzId: RADIOHEAD_MBID,
      name: "Radiohead",
      comment: "",
      artistType: "Group",
      gender: "",
      rawScore: 80,
      rank: 2,
      weight: 0.8,
    },
  ]);
});

test("ListenBrainz normalization filters invalid rows and keeps the strongest duplicate", () => {
  const { normalizeSimilarArtists } = loadListenBrainzHelper();
  const neighbors = normalizeSimilarArtists([
    ...SIMILAR_ARTISTS_PAYLOAD,
    { ...SIMILAR_ARTISTS_PAYLOAD[0], score: 120, name: "Massive Attack canonical" },
    { ...SIMILAR_ARTISTS_PAYLOAD[0], artist_mbid: SEED_MBID, score: 999 },
    { ...SIMILAR_ARTISTS_PAYLOAD[0], reference_mbid: RADIOHEAD_MBID, score: 999 },
    { ...SIMILAR_ARTISTS_PAYLOAD[0], artist_mbid: "invalid", score: 999 },
    { ...SIMILAR_ARTISTS_PAYLOAD[0], artist_mbid: "00000000-0000-0000-0000-000000000001", score: -1 },
    { ...SIMILAR_ARTISTS_PAYLOAD[0], artist_mbid: "00000000-0000-0000-0000-000000000002", score: null },
    { ...SIMILAR_ARTISTS_PAYLOAD[0], artist_mbid: "00000000-0000-0000-0000-000000000003", score: "90" },
  ], SEED_MBID);

  assert.equal(neighbors.length, 2);
  assert.equal(neighbors[0].musicBrainzId, MASSIVE_ATTACK_MBID);
  assert.equal(neighbors[0].name, "Massive Attack canonical");
  assert.equal(neighbors[0].rawScore, 120);
  assert.equal(neighbors[1].rank, 2);
  assert.equal(neighbors[1].weight, 0.666667);
});

test("ListenBrainz rejects malformed MBIDs and invalid success payloads", async () => {
  const {
    ListenBrainzResponseError,
    fetchSimilarArtists,
    getOrCreateArtistNeighborhood,
  } = loadListenBrainzHelper();

  await assert.rejects(
    () => getOrCreateArtistNeighborhood("not-an-mbid"),
    /valid MusicBrainz artist id/,
  );
  assert.equal(findOneCalls.length, 0);
  await assert.rejects(
    () => fetchSimilarArtists(SEED_MBID, {
      algorithm: ALGORITHM,
      maxAttempts: 1,
      fetchImpl: async () => jsonResponse({ neighbors: [] }),
    }),
    ListenBrainzResponseError,
  );
  await assert.rejects(
    () => fetchSimilarArtists(SEED_MBID, {
      algorithm: ALGORITHM,
      maxAttempts: 1,
      fetchImpl: async () => jsonResponse([{
        ...SIMILAR_ARTISTS_PAYLOAD[0],
        score: null,
      }]),
    }),
    ListenBrainzResponseError,
  );
  await assert.rejects(
    () => fetchSimilarArtists(SEED_MBID, {
      algorithm: ALGORITHM,
      maxAttempts: 1,
      fetchImpl: async () => jsonResponse(null, {
        json: async () => {
          throw new SyntaxError("Unexpected token");
        },
      }),
    }),
    ListenBrainzResponseError,
  );
});

test("ListenBrainz does not retry provider 400 responses", async () => {
  const {
    ListenBrainzRequestError,
    fetchSimilarArtists,
  } = loadListenBrainzHelper();
  let requestCount = 0;

  await assert.rejects(
    () => fetchSimilarArtists(SEED_MBID, {
      algorithm: ALGORITHM,
      maxAttempts: 2,
      retryDelayImpl: async () => {
        throw new Error("A 400 response must not retry");
      },
      fetchImpl: async () => {
        requestCount += 1;
        return jsonResponse({}, {
          ok: false,
          status: 400,
          text: async () => "Unsupported algorithm",
        });
      },
    }),
    (error) => error instanceof ListenBrainzRequestError
      && error.status === 400
      && error.responseBody === "Unsupported algorithm",
  );
  assert.equal(requestCount, 1);
});

test("getOrCreateArtistNeighborhood caches successful empty neighborhoods for one week", async () => {
  const {
    NEIGHBORHOOD_TTL_MS,
    getOrCreateArtistNeighborhood,
  } = loadListenBrainzHelper();

  const result = await getOrCreateArtistNeighborhood(SEED_MBID, {
    algorithm: ALGORITHM,
    now: NOW,
    fetchImpl: async () => jsonResponse([]),
  });

  assert.equal(result.cacheStatus, "miss");
  assert.deepEqual(result.neighborhood.neighbors, []);
  assert.equal(
    new Date(result.neighborhood.expiresAt).getTime(),
    NOW.getTime() + NEIGHBORHOOD_TTL_MS,
  );
  assert.equal(findOneAndUpdateCalls[0].options.upsert, true);
  assert.deepEqual(findOneAndUpdateCalls[0].query, {
    seedMusicBrainzId: SEED_MBID,
    source: "listenbrainz",
    algorithm: ALGORITHM,
  });
});

test("getOrCreateArtistNeighborhood serves a fresh cached snapshot without a provider call", async () => {
  cachedNeighborhood = cachedSnapshot();
  const { getOrCreateArtistNeighborhood } = loadListenBrainzHelper();

  const result = await getOrCreateArtistNeighborhood(SEED_MBID, {
    algorithm: ALGORITHM,
    now: NOW,
    fetchImpl: async () => {
      throw new Error("Fresh neighborhood should avoid ListenBrainz");
    },
  });

  assert.equal(result.cacheStatus, "hit");
  assert.deepEqual(result.neighborhood.neighbors, []);
  assert.equal(findOneAndUpdateCalls.length, 0);
});

test("weekly neighborhood freshness expires at the exact boundary", () => {
  const { isFreshNeighborhood } = loadListenBrainzHelper();
  const neighborhood = cachedSnapshot({ expiresAt: NOW });

  assert.equal(isFreshNeighborhood(neighborhood, new Date(NOW.getTime() - 1)), true);
  assert.equal(isFreshNeighborhood(neighborhood, NOW), false);
});

test("an expired neighborhood refreshes the complete provider snapshot", async () => {
  cachedNeighborhood = cachedSnapshot({ expiresAt: new Date("2026-07-18T11:00:00.000Z") });
  const { getOrCreateArtistNeighborhood } = loadListenBrainzHelper();

  const result = await getOrCreateArtistNeighborhood(SEED_MBID, {
    algorithm: ALGORITHM,
    now: NOW,
    fetchImpl: async () => jsonResponse(SIMILAR_ARTISTS_PAYLOAD),
  });

  assert.equal(result.cacheStatus, "refreshed");
  assert.equal(result.neighborhood.neighbors.length, 2);
  assert.equal(findOneAndUpdateCalls[0].update.$set.neighbors.length, 2);
});

test("an expired neighborhood falls back to stale data after transient failure", async () => {
  cachedNeighborhood = cachedSnapshot({
    expiresAt: new Date("2026-07-18T11:00:00.000Z"),
    neighbors: [{
      musicBrainzId: MASSIVE_ATTACK_MBID,
      name: "Massive Attack",
      rawScore: 100,
      rank: 1,
      weight: 1,
    }],
  });
  const { getOrCreateArtistNeighborhood } = loadListenBrainzHelper();

  const result = await getOrCreateArtistNeighborhood(SEED_MBID, {
    algorithm: ALGORITHM,
    now: NOW,
    maxAttempts: 1,
    fetchImpl: async () => jsonResponse({}, { ok: false, status: 503 }),
  });

  assert.equal(result.cacheStatus, "stale");
  assert.equal(result.neighborhood.neighbors[0].musicBrainzId, MASSIVE_ATTACK_MBID);
  assert.equal(
    findOneAndUpdateCalls[0].update.$set.lastRefreshError,
    "ListenBrainzRequestError",
  );
});

test("an expired neighborhood preserves stale data after a provider contract failure", async () => {
  cachedNeighborhood = cachedSnapshot({
    expiresAt: new Date("2026-07-18T11:00:00.000Z"),
    neighbors: [{
      musicBrainzId: MASSIVE_ATTACK_MBID,
      name: "Massive Attack",
      rawScore: 100,
      rank: 1,
      weight: 1,
    }],
  });
  const { getOrCreateArtistNeighborhood } = loadListenBrainzHelper();

  const result = await getOrCreateArtistNeighborhood(SEED_MBID, {
    algorithm: ALGORITHM,
    now: NOW,
    maxAttempts: 1,
    fetchImpl: async () => jsonResponse([{
      ...SIMILAR_ARTISTS_PAYLOAD[0],
      score: null,
    }]),
  });

  assert.equal(result.cacheStatus, "stale");
  assert.equal(result.neighborhood.neighbors[0].musicBrainzId, MASSIVE_ATTACK_MBID);
  assert.equal(
    findOneAndUpdateCalls[0].update.$set.lastRefreshError,
    "ListenBrainzResponseError",
  );
  assert.equal(findOneAndUpdateCalls[0].update.$set.neighbors, undefined);
});

test("an expired neighborhood serves stale data when a configured algorithm is retired", async () => {
  cachedNeighborhood = cachedSnapshot({
    expiresAt: new Date("2026-07-18T11:00:00.000Z"),
    neighbors: [{
      musicBrainzId: RADIOHEAD_MBID,
      name: "Radiohead",
      rawScore: 80,
      rank: 1,
      weight: 1,
    }],
  });
  const { getOrCreateArtistNeighborhood } = loadListenBrainzHelper();

  const result = await getOrCreateArtistNeighborhood(SEED_MBID, {
    algorithm: ALGORITHM,
    now: NOW,
    maxAttempts: 1,
    fetchImpl: async () => jsonResponse({}, { ok: false, status: 400 }),
  });

  assert.equal(result.cacheStatus, "stale");
  assert.equal(result.neighborhood.neighbors[0].musicBrainzId, RADIOHEAD_MBID);
  assert.equal(
    findOneAndUpdateCalls[0].update.$set.lastRefreshError,
    "ListenBrainzRequestError",
  );
});

test("a cold provider failure backs off repeated uncached lookups", async () => {
  const {
    ListenBrainzBackoffError,
    getOrCreateArtistNeighborhood,
  } = loadListenBrainzHelper();
  let providerCalls = 0;

  await assert.rejects(
    () => getOrCreateArtistNeighborhood(SEED_MBID, {
      algorithm: ALGORITHM,
      now: NOW,
      maxAttempts: 1,
      fetchImpl: async () => {
        providerCalls += 1;
        return jsonResponse({}, { ok: false, status: 503 });
      },
    }),
    /status 503/,
  );

  await assert.rejects(
    () => getOrCreateArtistNeighborhood(SEED_MBID, {
      algorithm: ALGORITHM,
      now: new Date(NOW.getTime() + 1000),
      fetchImpl: async () => {
        providerCalls += 1;
        return jsonResponse([]);
      },
    }),
    ListenBrainzBackoffError,
  );
  assert.equal(providerCalls, 1);
});

test("a recent refresh failure backs off without another provider request", async () => {
  cachedNeighborhood = cachedSnapshot({
    expiresAt: new Date("2026-07-17T11:00:00.000Z"),
    lastRefreshFailureAt: new Date("2026-07-18T11:30:00.000Z"),
  });
  const { getOrCreateArtistNeighborhood } = loadListenBrainzHelper();

  const result = await getOrCreateArtistNeighborhood(SEED_MBID, {
    algorithm: ALGORITHM,
    now: NOW,
    fetchImpl: async () => {
      throw new Error("Recent failure should back off");
    },
  });

  assert.equal(result.cacheStatus, "stale");
  assert.equal(findOneAndUpdateCalls.length, 0);
});

test("concurrent neighborhood requests for one seed share provider work", async () => {
  const { getOrCreateArtistNeighborhood } = loadListenBrainzHelper();
  let releaseProvider;
  let requestCount = 0;
  const providerResponse = new Promise((resolve) => {
    releaseProvider = () => resolve(jsonResponse(SIMILAR_ARTISTS_PAYLOAD));
  });
  const options = {
    algorithm: ALGORITHM,
    now: NOW,
    fetchImpl: async () => {
      requestCount += 1;
      return providerResponse;
    },
  };

  const firstRequest = getOrCreateArtistNeighborhood(SEED_MBID, options);
  const secondRequest = getOrCreateArtistNeighborhood(SEED_MBID, options);

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requestCount, 1);
  releaseProvider();

  const [firstResult, secondResult] = await Promise.all([firstRequest, secondRequest]);
  assert.deepEqual(secondResult, firstResult);
  assert.equal(findOneCalls.length, 1);
  assert.equal(findOneAndUpdateCalls.length, 1);
});

test("ListenBrainz provider work is capped across different seeds", async () => {
  const {
    LISTENBRAINZ_MAX_CONCURRENT_REQUESTS,
    fetchSimilarArtists,
  } = loadListenBrainzHelper();
  let activeRequests = 0;
  let maximumActiveRequests = 0;
  const releases = [];
  const fetchImpl = async () => {
    activeRequests += 1;
    maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
    await new Promise((resolve) => releases.push(resolve));
    activeRequests -= 1;
    return jsonResponse([]);
  };
  const options = {
    algorithm: ALGORITHM,
    maxAttempts: 1,
    fetchImpl,
  };
  const requests = [SEED_MBID, MASSIVE_ATTACK_MBID, RADIOHEAD_MBID]
    .map((musicBrainzId) => fetchSimilarArtists(musicBrainzId, options));

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(activeRequests, LISTENBRAINZ_MAX_CONCURRENT_REQUESTS);
  assert.equal(maximumActiveRequests, LISTENBRAINZ_MAX_CONCURRENT_REQUESTS);

  releases.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(activeRequests, LISTENBRAINZ_MAX_CONCURRENT_REQUESTS);
  assert.equal(maximumActiveRequests, LISTENBRAINZ_MAX_CONCURRENT_REQUESTS);

  while (releases.length > 0) {
    releases.shift()();
  }

  await Promise.all(requests);
  assert.equal(activeRequests, 0);
});

test("ListenBrainz rejects excess queued provider work", async () => {
  const {
    ListenBrainzBusyError,
    fetchSimilarArtists,
  } = loadListenBrainzHelper();
  const releases = [];
  const fetchImpl = async () => {
    await new Promise((resolve) => releases.push(resolve));
    return jsonResponse([]);
  };
  const options = {
    algorithm: ALGORITHM,
    maxAttempts: 1,
    fetchImpl,
  };
  const admittedRequests = [
    SEED_MBID,
    MASSIVE_ATTACK_MBID,
    RADIOHEAD_MBID,
    "00000000-0000-0000-0000-000000000004",
  ].map((musicBrainzId) => fetchSimilarArtists(musicBrainzId, options));

  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    () => fetchSimilarArtists(
      "00000000-0000-0000-0000-000000000005",
      options,
    ),
    ListenBrainzBusyError,
  );

  while (releases.length > 0) {
    releases.shift()();
  }

  await new Promise((resolve) => setImmediate(resolve));

  while (releases.length > 0) {
    releases.shift()();
  }

  await Promise.all(admittedRequests);
});
