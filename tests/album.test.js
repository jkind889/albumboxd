const assert = require("node:assert/strict");
const test = require("node:test");

const albumModelPath = require.resolve("../models/Albums");
const albumCatalogModelPath = require.resolve("../models/AlbumCatalog");
const followModelPath = require.resolve("../models/Follow");
const likeModelPath = require.resolve("../models/Like");
const reviewModelPath = require.resolve("../models/Reviews");
const albumCatalogHelperPath = require.resolve("../routes/utils/albumCatalog");
const clerkPath = require.resolve("@clerk/express");
const albumRoutePath = require.resolve("../routes/album");

let authUserId = null;
let createdAlbum = null;
let catalogAlbum = null;
let catalogAlbums = [];
let getOrCreateError = null;
let detailIsPartial = false;
let detailEnrichmentError = null;
let catalogFindError = null;
let shouldRejectClerkLookup = false;
const createCalls = [];
const albumCountCalls = [];
const catalogFindCalls = [];
const catalogCountCalls = [];
const followFindCalls = [];
const likeFindCalls = [];
const reviewFindCalls = [];
const reviewCountCalls = [];
const getUserListCalls = [];
const getOrCreateCalls = [];
let savedAlbumDocuments = [];
let followDocuments = [];
let likeDocuments = [];
let reviewDocuments = [];
let clerkUsers = [];

// Loads the album router with mocked database/auth/catalog dependencies.
function loadAlbumRouter() {
  delete require.cache[albumRoutePath];
  delete require.cache[followModelPath];
  delete require.cache[likeModelPath];
  delete require.cache[reviewModelPath];

  require.cache[albumModelPath] = {
    id: albumModelPath,
    filename: albumModelPath,
    loaded: true,
    exports: {
      create: async (album) => {
        createCalls.push(album);
        if (createdAlbum instanceof Error) {
          throw createdAlbum;
        }
        return (
          createdAlbum || {
            _id: "saved_album_123",
            savedAt: new Date("2026-06-09T00:00:00.000Z"),
            ...album,
          }
        );
      },
      countDocuments: async (query) => {
        albumCountCalls.push(query);
        return savedAlbumDocuments.filter((album) => album.spotifyId === query.spotifyId).length;
      },
    },
  };

  require.cache[albumCatalogModelPath] = {
    id: albumCatalogModelPath,
    filename: albumCatalogModelPath,
    loaded: true,
    exports: {
      find: (query) => {
        catalogFindCalls.push(query);
        const findState = {
          query,
          sort: null,
          skip: 0,
          limit: catalogAlbums.length,
        };

        return {
          sort(sort) {
            findState.sort = sort;
            catalogFindCalls.push({ sort });
            return this;
          },
          skip(skip) {
            findState.skip = skip;
            catalogFindCalls.push({ skip });
            return this;
          },
          async limit(limit) {
            findState.limit = limit;
            catalogFindCalls.push({ limit });

            if (catalogFindError) {
              throw catalogFindError;
            }

            return catalogAlbums.slice(findState.skip, findState.skip + findState.limit);
          },
        };
      },
      countDocuments: async (query) => {
        catalogCountCalls.push(query);

        if (catalogFindError) {
          throw catalogFindError;
        }

        return catalogAlbums.length;
      },
    },
  };

  require.cache[albumCatalogHelperPath] = {
    id: albumCatalogHelperPath,
    filename: albumCatalogHelperPath,
    loaded: true,
    exports: {
      getAlbumCatalogDetails: async (spotifyId) => {
        getOrCreateCalls.push(spotifyId);
        if (getOrCreateError) {
          throw getOrCreateError;
        }
        return {
          album: catalogAlbum,
          isPartial: detailIsPartial,
          enrichmentError: detailEnrichmentError,
        };
      },
      getOrCreateAlbumCatalog: async (spotifyId) => {
        getOrCreateCalls.push(spotifyId);
        if (getOrCreateError) {
          throw getOrCreateError;
        }
        return catalogAlbum;
      },
      normalizeCatalogAlbum: (album) => ({
        id: album.spotifyId,
        spotifyId: album.spotifyId,
        title: album.title,
        artist: album.artist,
        artists: album.artists || [],
        year: album.year || "unknown",
        releaseDate: album.releaseDate || "",
        genres: album.genres || [],
        imgs: album.imgs || [],
        cover: album.cover || null,
        totalTracks: album.totalTracks || 0,
        tracks: album.tracks || [],
        label: album.label || "",
        albumType: album.albumType || "album",
        spotifyUrl: album.spotifyUrl || "",
      }),
    },
  };

  require.cache[followModelPath] = {
    id: followModelPath,
    filename: followModelPath,
    loaded: true,
    exports: {
      find: async (query) => {
        followFindCalls.push(query);
        return followDocuments.filter((follow) => follow.followerId === query.followerId);
      },
    },
  };

  require.cache[likeModelPath] = {
    id: likeModelPath,
    filename: likeModelPath,
    loaded: true,
    exports: {
      find: async (query) => {
        likeFindCalls.push(query);
        const userIds = query.userId?.$in || [];

        return likeDocuments.filter((like) => (
          like.targetType === query.targetType
          && like.spotifyId === query.spotifyId
          && userIds.includes(like.userId)
        ));
      },
    },
  };

  require.cache[reviewModelPath] = {
    id: reviewModelPath,
    filename: reviewModelPath,
    loaded: true,
    exports: {
      countDocuments: async (query) => {
        reviewCountCalls.push(query);
        return reviewDocuments.filter((review) => review.spotifyId === query.spotifyId).length;
      },
      find: async (query) => {
        reviewFindCalls.push(query);
        const userIds = query.userId?.$in || [];

        return reviewDocuments.filter((review) => (
          review.spotifyId === query.spotifyId
          && userIds.includes(review.userId)
        ));
      },
    },
  };

  require.cache[clerkPath] = {
    id: clerkPath,
    filename: clerkPath,
    loaded: true,
    exports: {
      getAuth: () => ({ userId: authUserId }),
      clerkClient: {
        users: {
          getUserList: async (query) => {
            getUserListCalls.push(query);

            if (shouldRejectClerkLookup) {
              throw new Error("Clerk lookup failed");
            }

            return { data: clerkUsers };
          },
        },
      },
    },
  };

  return require("../routes/album");
}

async function callRoute(method, path, { body = {}, params = {}, query = {} } = {}) {
  const router = loadAlbumRouter();
  const route = router.stack.find(
    (layer) => layer.route?.path === path && layer.route.methods[method],
  );

  assert.ok(route, `${method.toUpperCase()} ${path} should be registered`);

  const req = { body, params, query };
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this.body = data;
      return this;
    },
  };

  const handlers = route.route.stack.map((layer) => layer.handle);

  for (const handler of handlers) {
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
    body: res.body,
  };
}

test.beforeEach(() => {
  authUserId = "user_clerk_123";
  createdAlbum = null;
  getOrCreateError = null;
  detailIsPartial = false;
  detailEnrichmentError = null;
  catalogFindError = null;
  shouldRejectClerkLookup = false;
  catalogAlbum = {
    _id: "catalog_album_123",
    spotifyId: "spotify_album_123",
    title: "Kind of Blue",
    artist: "Miles Davis",
    artists: ["Miles Davis"],
    year: "1959",
    cover: "https://example.com/kind-of-blue.jpg",
    totalTracks: 2,
    tracks: [
      {
        spotifyId: "track_1",
        trackNumber: 1,
        discNumber: 1,
        title: "So What",
        durationMs: 545000,
        spotifyUrl: "https://open.spotify.com/track/track_1",
      },
      {
        spotifyId: "track_2",
        trackNumber: 2,
        discNumber: 1,
        title: "Freddie Freeloader",
        durationMs: 589000,
        spotifyUrl: "https://open.spotify.com/track/track_2",
      },
    ],
  };
  catalogAlbums = [
    catalogAlbum,
    {
      spotifyId: "spotify_album_456",
      title: "Blue Train",
      artist: "John Coltrane",
      artists: ["John Coltrane"],
      year: "1958",
      cover: "https://example.com/blue-train.jpg",
      totalTracks: 5,
      tracks: [],
    },
  ];
  savedAlbumDocuments = [
    { spotifyId: "spotify_album_123", userId: "listener_1" },
    { spotifyId: "spotify_album_123", userId: "listener_2" },
    { spotifyId: "spotify_album_456", userId: "listener_3" },
  ];
  followDocuments = [];
  likeDocuments = [];
  reviewDocuments = [
    {
      _id: "review_1",
      spotifyId: "spotify_album_123",
      userId: "review_author_1",
    },
    {
      _id: "review_2",
      spotifyId: "spotify_album_123",
      userId: "review_author_2",
    },
    {
      _id: "review_3",
      spotifyId: "spotify_album_456",
      userId: "review_author_3",
    },
  ];
  clerkUsers = [];
  createCalls.length = 0;
  albumCountCalls.length = 0;
  catalogFindCalls.length = 0;
  catalogCountCalls.length = 0;
  followFindCalls.length = 0;
  likeFindCalls.length = 0;
  reviewFindCalls.length = 0;
  reviewCountCalls.length = 0;
  getUserListCalls.length = 0;
  getOrCreateCalls.length = 0;
});

test("GET /albums/catalog returns the first paginated catalog page in frontend shape", async () => {
  catalogAlbums = Array.from({ length: 30 }, (_, index) => ({
    spotifyId: `spotify_album_${index + 1}`,
    title: `Album ${index + 1}`,
    artist: "Catalog Artist",
    artists: ["Catalog Artist"],
    year: "2026",
    cover: `https://example.com/album-${index + 1}.jpg`,
    totalTracks: 10,
    tracks: [],
  }));

  const response = await callRoute("get", "/catalog");

  assert.equal(response.status, 200);
  assert.deepEqual(catalogCountCalls, [{}]);
  assert.deepEqual(catalogFindCalls, [
    {},
    { sort: { artist: 1, title: 1 } },
    { skip: 0 },
    { limit: 24 },
  ]);
  assert.equal(response.body.results.length, 24);
  assert.equal(response.body.results[0].id, "spotify_album_1");
  assert.equal(response.body.page, 1);
  assert.equal(response.body.limit, 24);
  assert.equal(response.body.total, 30);
  assert.equal(response.body.hasPreviousPage, false);
  assert.equal(response.body.hasNextPage, true);
});

test("GET /albums/catalog page 2 applies skip and limit", async () => {
  catalogAlbums = Array.from({ length: 30 }, (_, index) => ({
    spotifyId: `spotify_album_${index + 1}`,
    title: `Album ${index + 1}`,
    artist: "Catalog Artist",
    artists: ["Catalog Artist"],
    year: "2026",
    cover: `https://example.com/album-${index + 1}.jpg`,
    totalTracks: 10,
    tracks: [],
  }));

  const response = await callRoute("get", "/catalog", {
    query: { page: "2", limit: "24" },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(catalogFindCalls, [
    {},
    { sort: { artist: 1, title: 1 } },
    { skip: 24 },
    { limit: 24 },
  ]);
  assert.equal(response.body.results.length, 6);
  assert.equal(response.body.results[0].id, "spotify_album_25");
  assert.equal(response.body.page, 2);
  assert.equal(response.body.hasPreviousPage, true);
  assert.equal(response.body.hasNextPage, false);
});

test("GET /albums/catalog filters catalog search in MongoDB", async () => {
  const response = await callRoute("get", "/catalog", {
    query: { q: "blue" },
  });

  const expectedQuery = {
    $or: [
      { title: { $regex: "blue", $options: "i" } },
      { artist: { $regex: "blue", $options: "i" } },
      { artists: { $regex: "blue", $options: "i" } },
      { year: { $regex: "blue", $options: "i" } },
      { label: { $regex: "blue", $options: "i" } },
      { albumType: { $regex: "blue", $options: "i" } },
    ],
  };

  assert.equal(response.status, 200);
  assert.deepEqual(catalogCountCalls, [expectedQuery]);
  assert.deepEqual(catalogFindCalls[0], expectedQuery);
  assert.equal(response.body.results.length, 2);
});

test("GET /albums/catalog safely falls back for invalid pagination params", async () => {
  const response = await callRoute("get", "/catalog", {
    query: { page: "not-a-page", limit: "500" },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(catalogFindCalls, [
    {},
    { sort: { artist: 1, title: 1 } },
    { skip: 0 },
    { limit: 24 },
  ]);
  assert.equal(response.body.page, 1);
  assert.equal(response.body.limit, 24);
});

test("GET /albums/catalog returns 500 when the catalog lookup fails", async () => {
  catalogFindError = new Error("database unavailable");

  const response = await callRoute("get", "/catalog");

  assert.equal(response.status, 500);
  assert.deepEqual(response.body, { error: "Failed to fetch album catalog" });
});

test("GET /albums/album/:id returns a cached or newly cached catalog album", async () => {
  const response = await callRoute("get", "/album/:id", {
    params: { id: "spotify_album_123" },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(getOrCreateCalls, ["spotify_album_123"]);
  assert.equal(response.body.id, "spotify_album_123");
  assert.equal(response.body.title, "Kind of Blue");
  assert.deepEqual(response.body.tracks, catalogAlbum.tracks);
  assert.equal(response.body.isPartial, false);
});

test("GET /albums/album/:id marks cached fallback details as partial", async () => {
  catalogAlbum = { ...catalogAlbum, tracks: [] };
  detailIsPartial = true;
  detailEnrichmentError = new Error("Spotify album fetch failed with status 502");
  const originalWarn = console.warn;
  console.warn = () => {};
  let response;

  try {
    response = await callRoute("get", "/album/:id", {
      params: { id: "spotify_album_123" },
    });
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(response.status, 200);
  assert.equal(response.body.isPartial, true);
  assert.deepEqual(response.body.tracks, []);
});

test("GET /albums/album/:id returns 500 when catalog lookup fails", async () => {
  getOrCreateError = new Error("spotify unavailable");

  const response = await callRoute("get", "/album/:id", {
    params: { id: "spotify_album_123" },
  });

  assert.equal(response.status, 500);
  assert.deepEqual(response.body, { error: "Failed to fetch album details" });
});

test("GET /albums/album/:id/social returns totals for signed-out viewers", async () => {
  authUserId = null;

  const response = await callRoute("get", "/album/:id/social", {
    params: { id: "spotify_album_123" },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    spotifyId: "spotify_album_123",
    savedCount: 2,
    reviewCount: 2,
    followedReviewers: [],
    followedAlbumLikers: [],
  });
  assert.deepEqual(albumCountCalls, [{ spotifyId: "spotify_album_123" }]);
  assert.deepEqual(reviewCountCalls, [{ spotifyId: "spotify_album_123" }]);
  assert.equal(followFindCalls.length, 0);
  assert.equal(reviewFindCalls.length, 0);
  assert.equal(likeFindCalls.length, 0);
  assert.equal(getUserListCalls.length, 0);
});

test("GET /albums/album/:id/social returns followed reviewers and album likers", async () => {
  followDocuments = [
    { followerId: "user_clerk_123", followingId: "review_author_1" },
    { followerId: "user_clerk_123", followingId: "review_author_2" },
    { followerId: "other_user", followingId: "unrelated_user" },
  ];
  reviewDocuments = [
    { _id: "review_1", spotifyId: "spotify_album_123", userId: "review_author_1" },
    { _id: "review_2", spotifyId: "spotify_album_123", userId: "review_author_1" },
    { _id: "review_3", spotifyId: "spotify_album_123", userId: "unfollowed_reviewer" },
    { _id: "review_4", spotifyId: "spotify_album_456", userId: "review_author_2" },
  ];
  likeDocuments = [
    { targetType: "album", spotifyId: "spotify_album_123", userId: "review_author_2" },
    { targetType: "album", spotifyId: "spotify_album_123", userId: "unfollowed_liker" },
    { targetType: "review", spotifyId: "spotify_album_123", userId: "review_author_1" },
    { targetType: "album", spotifyId: "spotify_album_456", userId: "review_author_1" },
  ];
  clerkUsers = [
    { id: "review_author_1", username: "ada", imageUrl: "https://example.com/ada.jpg" },
    { id: "review_author_2", username: "miles", imageUrl: "https://example.com/miles.jpg" },
  ];

  const response = await callRoute("get", "/album/:id/social", {
    params: { id: "spotify_album_123" },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    spotifyId: "spotify_album_123",
    savedCount: 2,
    reviewCount: 3,
    followedReviewers: [
      {
        userId: "review_author_1",
        username: "ada",
        imageUrl: "https://example.com/ada.jpg",
      },
    ],
    followedAlbumLikers: [
      {
        userId: "review_author_2",
        username: "miles",
        imageUrl: "https://example.com/miles.jpg",
      },
    ],
  });
  assert.deepEqual(followFindCalls, [{ followerId: "user_clerk_123" }]);
  assert.deepEqual(reviewFindCalls, [
    {
      spotifyId: "spotify_album_123",
      userId: { $in: ["review_author_1", "review_author_2"] },
    },
  ]);
  assert.deepEqual(likeFindCalls, [
    {
      targetType: "album",
      spotifyId: "spotify_album_123",
      userId: { $in: ["review_author_1", "review_author_2"] },
    },
  ]);
  assert.deepEqual(getUserListCalls, [{ userId: ["review_author_1", "review_author_2"] }]);
});

test("GET /albums/album/:id/social falls back when Clerk lookup fails", async () => {
  shouldRejectClerkLookup = true;
  followDocuments = [
    { followerId: "user_clerk_123", followingId: "review_author_1" },
  ];
  reviewDocuments = [
    { _id: "review_1", spotifyId: "spotify_album_123", userId: "review_author_1" },
  ];
  likeDocuments = [
    { targetType: "album", spotifyId: "spotify_album_123", userId: "review_author_1" },
  ];

  const response = await callRoute("get", "/album/:id/social", {
    params: { id: "spotify_album_123" },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(response.body.followedReviewers, [
    {
      userId: "review_author_1",
      username: "albumboxd user",
      imageUrl: "",
    },
  ]);
  assert.deepEqual(response.body.followedAlbumLikers, [
    {
      userId: "review_author_1",
      username: "albumboxd user",
      imageUrl: "",
    },
  ]);
});

test("GET /albums/album/:id/social returns 400 for a blank spotify id", async () => {
  const response = await callRoute("get", "/album/:id/social", {
    params: { id: "   " },
  });

  assert.equal(response.status, 400);
  assert.deepEqual(response.body, { error: "Spotify id is required" });
  assert.equal(albumCountCalls.length, 0);
  assert.equal(reviewCountCalls.length, 0);
});

test("POST /albums/album saves a catalog reference with the authenticated Clerk user id", async () => {
  const response = await callRoute("post", "/album", {
    body: {
      userId: "frontend_user_should_not_win",
      spotifyId: "spotify_album_123",
      title: "Frontend title should not be saved",
    },
  });

  assert.equal(response.status, 201);
  assert.deepEqual(getOrCreateCalls, ["spotify_album_123"]);
  assert.equal(createCalls.length, 1);
  assert.deepEqual(createCalls[0], {
    albumCatalogId: "catalog_album_123",
    spotifyId: "spotify_album_123",
    userId: "user_clerk_123",
  });
  assert.equal(response.body.userId, "user_clerk_123");
  assert.equal(response.body.spotifyId, "spotify_album_123");
  assert.equal(response.body.title, "Kind of Blue");
});

test("POST /albums/album returns 400 without a spotifyId", async () => {
  const response = await callRoute("post", "/album", {
    body: { title: "Kind of Blue" },
  });

  assert.equal(response.status, 400);
  assert.deepEqual(response.body, { error: "spotifyId is required" });
  assert.equal(createCalls.length, 0);
  assert.equal(getOrCreateCalls.length, 0);
});

test("POST /albums/album returns 401 and does not save when Clerk has no user", async () => {
  authUserId = null;

  const response = await callRoute("post", "/album", {
    body: { spotifyId: "spotify_album_123" },
  });

  assert.equal(response.status, 401);
  assert.deepEqual(response.body, { error: "Unauthorized" });
  assert.equal(createCalls.length, 0);
});

test("POST /albums/album returns 409 when the album already exists", async () => {
  createdAlbum = Object.assign(new Error("duplicate key"), { code: 11000 });

  const response = await callRoute("post", "/album", {
    body: { spotifyId: "spotify_album_123" },
  });

  assert.equal(response.status, 409);
  assert.deepEqual(response.body, {
    error: "Album already exists in your collection",
  });
});

test("POST /albums/album returns 500 when the album cannot be saved", async (t) => {
  t.mock.method(console, "log", () => {});
  createdAlbum = new Error("database unavailable");

  const response = await callRoute("post", "/album", {
    body: { spotifyId: "spotify_album_123" },
  });

  assert.equal(response.status, 500);
  assert.deepEqual(response.body, { error: "Failed to create album" });
});
