const assert = require("node:assert/strict");
const test = require("node:test");

const albumCatalogModelPath = require.resolve("../models/AlbumCatalog");
const albumGenreEnrichmentPath = require.resolve("../routes/utils/albumGenreEnrichment");
const albumCatalogHelperPath = require.resolve("../routes/utils/albumCatalog");
const boardModelPath = require.resolve("../models/Board");
const boardItemModelPath = require.resolve("../models/BoardItem");
const boardRoutePath = require.resolve("../routes/boards");
const clerkPath = require.resolve("@clerk/express");
const likeModelPath = require.resolve("../models/Like");
const likeRoutePath = require.resolve("../routes/likes");
const notificationModelPath = require.resolve("../models/Notification");
const rateLimitPath = require.resolve("../routes/utils/rateLimit");
const reviewModelPath = require.resolve("../models/Reviews");
const reviewRoutePath = require.resolve("../routes/reviews");
const searchRoutePath = require.resolve("../routes/search");
const spotifyUtilPath = require.resolve("../routes/utils/spotify");
const userProfileModelPath = require.resolve("../models/UserProfile");
const albumModelPath = require.resolve("../models/Albums");

function clearModule(modulePath) {
  delete require.cache[modulePath];
}

function createResponse() {
  return {
    headers: {},
    statusCode: 200,
    body: null,
    set(name, value) {
      this.headers[name] = value;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this.body = data;
      return this;
    },
  };
}

async function callRoute(router, method, path, req = {}) {
  const route = router.stack.find(
    (layer) => layer.route?.path === path && layer.route.methods[method],
  );

  assert.ok(route, `${method.toUpperCase()} ${path} should be registered`);

  const res = createResponse();

  for (const handler of route.route.stack.map((layer) => layer.handle)) {
    let nextWasCalled = false;
    await handler(req, res, () => {
      nextWasCalled = true;
    });

    if (!nextWasCalled) {
      break;
    }
  }

  return {
    status: res.statusCode,
    headers: res.headers,
    body: res.body,
  };
}

function passRateLimit(req, res, next) {
  next();
}

function blockRateLimit(req, res) {
  res
    .status(429)
    .json({ error: "Too many requests. Please try again soon.", code: "RATE_LIMITED", retryAfterSeconds: 60 });
}

function setRateLimitMock(overrides = {}) {
  const baseMock = {
    albumSaveRateLimit: passRateLimit,
    consumeSpotifyRateLimit: async () => {},
    getAuthenticatedUserRateLimitKey: (req) => `user:${req.userId || "test"}`,
    getUserOrIpRateLimitKey: () => "ip:test",
    isRateLimitError: (error) => error?.code === "RATE_LIMITED",
    likeMutationRateLimit: passRateLimit,
    reviewCreateRateLimit: passRateLimit,
    reviewMutationRateLimit: passRateLimit,
    searchRateLimit: passRateLimit,
    sendRateLimitError: (res, error) => {
      res.set("Retry-After", String(error.retryAfterSeconds || 1));
      return res
        .status(429)
        .json({ error: error.message, code: "RATE_LIMITED", retryAfterSeconds: error.retryAfterSeconds || 1 });
    },
  };

  require.cache[rateLimitPath] = {
    id: rateLimitPath,
    filename: rateLimitPath,
    loaded: true,
    exports: {
      ...baseMock,
      ...overrides,
    },
  };
}

function mockClerk(userId = "user_clerk_123") {
  require.cache[clerkPath] = {
    id: clerkPath,
    filename: clerkPath,
    loaded: true,
    exports: {
      getAuth: () => ({ userId }),
      clerkClient: {
        users: {
          getUserList: async () => ({ data: [] }),
        },
      },
    },
  };
}

test.afterEach(() => {
  [
    albumCatalogModelPath,
    albumGenreEnrichmentPath,
    albumCatalogHelperPath,
    albumModelPath,
    boardModelPath,
    boardItemModelPath,
    boardRoutePath,
    clerkPath,
    likeModelPath,
    likeRoutePath,
    notificationModelPath,
    rateLimitPath,
    reviewModelPath,
    reviewRoutePath,
    searchRoutePath,
    spotifyUtilPath,
    userProfileModelPath,
  ].forEach(clearModule);
});

test("consumeRateLimit allows requests until the configured bucket is exhausted", async () => {
  clearModule(rateLimitPath);
  const {
    consumeRateLimit,
    createRateLimiter,
  } = require("../routes/utils/rateLimit");
  const limiter = createRateLimiter({
    keyPrefix: `test:allow-deny:${Date.now()}`,
    points: 2,
    duration: 60,
  });

  await consumeRateLimit(limiter, "client-a", "Slow down.");
  await consumeRateLimit(limiter, "client-a", "Slow down.");

  await assert.rejects(
    () => consumeRateLimit(limiter, "client-a", "Slow down."),
    (error) => error.code === "RATE_LIMITED" && error.retryAfterSeconds >= 1,
  );
});

test("rate limit middleware returns 429 payload and Retry-After header", async () => {
  clearModule(rateLimitPath);
  const {
    createRateLimitMiddleware,
    createRateLimiter,
  } = require("../routes/utils/rateLimit");
  const limiter = createRateLimiter({
    keyPrefix: `test:middleware:${Date.now()}`,
    points: 1,
    duration: 60,
  });
  const middleware = createRateLimitMiddleware(limiter, {
    keyGenerator: () => "client-a",
    message: "Too much, too fast.",
  });
  const firstResponse = createResponse();
  const secondResponse = createResponse();
  let nextCalls = 0;

  await middleware({ headers: {}, ip: "127.0.0.1" }, firstResponse, () => {
    nextCalls += 1;
  });
  await middleware({ headers: {}, ip: "127.0.0.1" }, secondResponse, () => {
    nextCalls += 1;
  });

  assert.equal(nextCalls, 1);
  assert.equal(secondResponse.statusCode, 429);
  assert.equal(secondResponse.body.code, "RATE_LIMITED");
  assert.ok(Number(secondResponse.headers["Retry-After"]) >= 1);
});

test("rate limit keys prefer authenticated users and fall back to IP addresses", () => {
  clearModule(rateLimitPath);
  const {
    getAuthenticatedUserRateLimitKey,
    getIpRateLimitKey,
    getUserOrIpRateLimitKey,
  } = require("../routes/utils/rateLimit");

  assert.equal(getAuthenticatedUserRateLimitKey({ userId: "user_123", headers: {} }), "user:user_123");
  assert.equal(getUserOrIpRateLimitKey({ userId: "user_456", headers: {} }), "user:user_456");
  assert.equal(getIpRateLimitKey({ ip: "203.0.113.10", headers: {} }), "ip:203.0.113.10");
});

test("memory limiter tracks each key independently", async () => {
  clearModule(rateLimitPath);
  const {
    consumeRateLimit,
    createRateLimiter,
  } = require("../routes/utils/rateLimit");
  const limiter = createRateLimiter({
    keyPrefix: `test:independent-keys:${Date.now()}`,
    points: 1,
    duration: 60,
  });

  await consumeRateLimit(limiter, "client-a", "Slow down.");
  await consumeRateLimit(limiter, "client-b", "Slow down.");

  await assert.rejects(
    () => consumeRateLimit(limiter, "client-a", "Slow down."),
    (error) => error.code === "RATE_LIMITED",
  );
});

test("Spotify fallback limiter blocks remote search before Spotify is called", async () => {
  let tokenCalls = 0;
  let fetchCalls = 0;

  setRateLimitMock({
    consumeSpotifyRateLimit: async () => {
      const error = new Error("Too many Spotify-backed requests. Please try again soon.");
      error.code = "RATE_LIMITED";
      error.retryAfterSeconds = 60;
      throw error;
    },
  });

  require.cache[albumCatalogModelPath] = {
    id: albumCatalogModelPath,
    filename: albumCatalogModelPath,
    loaded: true,
    exports: {
      countDocuments: async () => 0,
      find: () => ({
        sort() {
          return this;
        },
        skip() {
          return this;
        },
        limit: async () => [],
      }),
    },
  };
  require.cache[albumCatalogHelperPath] = {
    id: albumCatalogHelperPath,
    filename: albumCatalogHelperPath,
    loaded: true,
    exports: {
      normalizeSpotifyAlbumSummary: (album) => album,
      toSearchResult: (album) => album,
      upsertAlbumCatalog: async (album) => album,
    },
  };
  require.cache[spotifyUtilPath] = {
    id: spotifyUtilPath,
    filename: spotifyUtilPath,
    loaded: true,
    exports: {
      getSpotifyAccessToken: async () => {
        tokenCalls += 1;
        return "spotify_token";
      },
    },
  };

  const originalFetch = global.fetch;
    global.fetch = async () => {
    fetchCalls += 1;
    return { ok: true, json: async () => ({ albums: { items: [] } }) };
  };

  try {
    const router = require("../routes/search");
    const response = await callRoute(router, "get", "/search", {
      headers: {},
      ip: "203.0.113.10",
      query: { q: "kind" },
    });

    assert.equal(response.status, 429);
    assert.equal(response.body.code, "RATE_LIMITED");
    assert.equal(tokenCalls, 0);
    assert.equal(fetchCalls, 0);
  } finally {
    global.fetch = originalFetch;
  }
});

test("local-filled search does not consume the Spotify fallback bucket", async () => {
  let spotifyLimitCalls = 0;
  const localAlbums = Array.from({ length: 24 }, (_, index) => ({
    id: `local_${index}`,
    spotifyId: `local_${index}`,
    title: `Local ${index}`,
  }));

  setRateLimitMock({
    consumeSpotifyRateLimit: async () => {
      spotifyLimitCalls += 1;
      throw new Error("Spotify limiter should not be called");
    },
  });

  require.cache[albumCatalogModelPath] = {
    id: albumCatalogModelPath,
    filename: albumCatalogModelPath,
    loaded: true,
    exports: {
      find: () => ({
        sort() {
          return this;
        },
        limit: async (limit) => localAlbums.slice(0, limit),
      }),
    },
  };
  require.cache[albumCatalogHelperPath] = {
    id: albumCatalogHelperPath,
    filename: albumCatalogHelperPath,
    loaded: true,
    exports: {
      normalizeSpotifyAlbumSummary: (album) => album,
      toSearchResult: (album) => ({ id: album.spotifyId, title: album.title }),
      upsertAlbumCatalog: async (album) => album,
    },
  };
  require.cache[spotifyUtilPath] = {
    id: spotifyUtilPath,
    filename: spotifyUtilPath,
    loaded: true,
    exports: {
      getSpotifyAccessToken: async () => "spotify_token",
    },
  };

  const router = require("../routes/search");
  const response = await callRoute(router, "get", "/search", {
    headers: {},
    ip: "203.0.113.10",
    query: { q: "local" },
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.length, 24);
  assert.equal(spotifyLimitCalls, 0);
});

test("cached album catalog hits do not consume the Spotify fallback bucket", async () => {
  let spotifyLimitCalls = 0;

  setRateLimitMock({
    consumeSpotifyRateLimit: async () => {
      spotifyLimitCalls += 1;
      throw new Error("Spotify limiter should not be called");
    },
  });

  require.cache[albumCatalogModelPath] = {
    id: albumCatalogModelPath,
    filename: albumCatalogModelPath,
    loaded: true,
    exports: {
      findOne: async () => ({
        spotifyId: "spotify_album_123",
        title: "Kind of Blue",
        detailMetadataVersion: 2,
        tracks: [{ spotifyId: "track_1" }],
      }),
    },
  };
  require.cache[spotifyUtilPath] = {
    id: spotifyUtilPath,
    filename: spotifyUtilPath,
    loaded: true,
    exports: {
      getSpotifyAccessToken: async () => {
        throw new Error("Spotify token should not be fetched for cached album details");
      },
    },
  };
  require.cache[albumGenreEnrichmentPath] = {
    id: albumGenreEnrichmentPath,
    filename: albumGenreEnrichmentPath,
    loaded: true,
    exports: {
      scheduleAlbumGenreEnrichment: () => true,
    },
  };

  const { getOrCreateAlbumCatalog } = require("../routes/utils/albumCatalog");
  const album = await getOrCreateAlbumCatalog("spotify_album_123", {
    rateLimitKey: "user:user_clerk_123",
  });

  assert.equal(album.spotifyId, "spotify_album_123");
  assert.equal(spotifyLimitCalls, 0);
});

test("review create limiter blocks before Review.create runs", async () => {
  let createCalls = 0;

  mockClerk();
  setRateLimitMock({ reviewCreateRateLimit: blockRateLimit });
  require.cache[reviewModelPath] = {
    id: reviewModelPath,
    filename: reviewModelPath,
    loaded: true,
    exports: {
      create: async () => {
        createCalls += 1;
        return {};
      },
      find: () => ({ sort: async () => [] }),
      findOneAndUpdate: async () => null,
      aggregate: async () => [],
    },
  };
  require.cache[likeModelPath] = {
    id: likeModelPath,
    filename: likeModelPath,
    loaded: true,
    exports: { find: async () => [] },
  };
  require.cache[userProfileModelPath] = {
    id: userProfileModelPath,
    filename: userProfileModelPath,
    loaded: true,
    exports: { findOne: async () => null },
  };
  require.cache[albumCatalogModelPath] = {
    id: albumCatalogModelPath,
    filename: albumCatalogModelPath,
    loaded: true,
    exports: { find: () => ({ sort: () => ({ limit: async () => [] }) }) },
  };
  require.cache[albumCatalogHelperPath] = {
    id: albumCatalogHelperPath,
    filename: albumCatalogHelperPath,
    loaded: true,
    exports: { normalizeCatalogAlbum: (album) => album },
  };

  const router = require("../routes/reviews");
  const response = await callRoute(router, "post", "/review", {
    body: { reviewText: "Great", rating: 5 },
    headers: {},
  });

  assert.equal(response.status, 429);
  assert.equal(createCalls, 0);
});

test("like mutation limiter blocks before Like.updateOne runs", async () => {
  let updateCalls = 0;

  mockClerk();
  setRateLimitMock({ likeMutationRateLimit: blockRateLimit });
  require.cache[likeModelPath] = {
    id: likeModelPath,
    filename: likeModelPath,
    loaded: true,
    exports: {
      updateOne: async () => {
        updateCalls += 1;
      },
      countDocuments: async () => 0,
      deleteOne: async () => {},
      exists: async () => null,
    },
  };
  require.cache[reviewModelPath] = {
    id: reviewModelPath,
    filename: reviewModelPath,
    loaded: true,
    exports: { findById: async () => null },
  };
  require.cache[notificationModelPath] = {
    id: notificationModelPath,
    filename: notificationModelPath,
    loaded: true,
    exports: { updateOne: async () => {} },
  };

  const router = require("../routes/likes");
  const response = await callRoute(router, "put", "/album/:spotifyId", {
    body: { liked: true },
    headers: {},
    params: { spotifyId: "spotify_album_123" },
  });

  assert.equal(response.status, 429);
  assert.equal(updateCalls, 0);
});

test("board album save limiter blocks before catalog lookup runs", async () => {
  let catalogCalls = 0;

  mockClerk();
  setRateLimitMock({ albumSaveRateLimit: blockRateLimit });
  require.cache[albumModelPath] = {
    id: albumModelPath,
    filename: albumModelPath,
    loaded: true,
    exports: {
      find: async () => [],
      findOneAndDelete: async () => null,
      findOneAndUpdate: async () => null,
    },
  };
  require.cache[boardModelPath] = {
    id: boardModelPath,
    filename: boardModelPath,
    loaded: true,
    exports: {
      create: async () => ({ _id: "board_1", userId: "user_clerk_123", title: "Saved albums" }),
      find: () => ({ sort: async () => [] }),
      findOne: async () => ({ _id: "board_1", userId: "user_clerk_123", isDefault: true }),
    },
  };
  require.cache[boardItemModelPath] = {
    id: boardItemModelPath,
    filename: boardItemModelPath,
    loaded: true,
    exports: {
      bulkWrite: async () => {},
      countDocuments: async () => 0,
      deleteMany: async () => {},
      find: () => ({
        populate() {
          return this;
        },
        sort() {
          return this;
        },
        limit: async () => [],
      }),
      findOneAndDelete: async () => null,
      findOneAndUpdate: () => ({
        populate: async () => null,
      }),
    },
  };
  require.cache[albumCatalogHelperPath] = {
    id: albumCatalogHelperPath,
    filename: albumCatalogHelperPath,
    loaded: true,
    exports: {
      getOrCreateAlbumCatalog: async () => {
        catalogCalls += 1;
        return {};
      },
      normalizeCatalogAlbum: (album) => album,
    },
  };

  const router = require("../routes/boards");
  const response = await callRoute(router, "post", "/:boardId/albums", {
    body: { spotifyId: "spotify_album_123" },
    headers: {},
    params: { boardId: "default" },
  });

  assert.equal(response.status, 429);
  assert.equal(catalogCalls, 0);
});
