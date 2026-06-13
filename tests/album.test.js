const assert = require("node:assert/strict");
const test = require("node:test");

const albumModelPath = require.resolve("../models/Albums");
const albumCatalogModelPath = require.resolve("../models/AlbumCatalog");
const albumCatalogHelperPath = require.resolve("../routes/utils/albumCatalog");
const clerkPath = require.resolve("@clerk/express");
const albumRoutePath = require.resolve("../routes/album");

let authUserId = null;
let createdAlbum = null;
let catalogAlbum = null;
let catalogAlbums = [];
let getOrCreateError = null;
let catalogFindError = null;
const createCalls = [];
const catalogFindCalls = [];
const getOrCreateCalls = [];

// Loads the album router with mocked database/auth/catalog dependencies.
function loadAlbumRouter() {
  delete require.cache[albumRoutePath];

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
    },
  };

  require.cache[albumCatalogModelPath] = {
    id: albumCatalogModelPath,
    filename: albumCatalogModelPath,
    loaded: true,
    exports: {
      find: (query) => {
        catalogFindCalls.push(query);
        return {
          sort: async (sort) => {
            if (catalogFindError) {
              throw catalogFindError;
            }

            catalogFindCalls.push({ sort });
            return catalogAlbums;
          },
        };
      },
    },
  };

  require.cache[albumCatalogHelperPath] = {
    id: albumCatalogHelperPath,
    filename: albumCatalogHelperPath,
    loaded: true,
    exports: {
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

  require.cache[clerkPath] = {
    id: clerkPath,
    filename: clerkPath,
    loaded: true,
    exports: {
      getAuth: () => ({ userId: authUserId }),
    },
  };

  return require("../routes/album");
}

async function callRoute(method, path, { body = {}, params = {} } = {}) {
  const router = loadAlbumRouter();
  const route = router.stack.find(
    (layer) => layer.route?.path === path && layer.route.methods[method],
  );

  assert.ok(route, `${method.toUpperCase()} ${path} should be registered`);

  const req = { body, params };
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
  catalogFindError = null;
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
  createCalls.length = 0;
  catalogFindCalls.length = 0;
  getOrCreateCalls.length = 0;
});

test("GET /albums/catalog returns all catalog albums in frontend shape", async () => {
  const response = await callRoute("get", "/catalog");

  assert.equal(response.status, 200);
  assert.deepEqual(catalogFindCalls, [{}, { sort: { artist: 1, title: 1 } }]);
  assert.deepEqual(response.body.map((album) => album.id), [
    "spotify_album_123",
    "spotify_album_456",
  ]);
  assert.equal(response.body[0].title, "Kind of Blue");
  assert.deepEqual(response.body[0].tracks, catalogAlbum.tracks);
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
});

test("GET /albums/album/:id returns 500 when catalog lookup fails", async () => {
  getOrCreateError = new Error("spotify unavailable");

  const response = await callRoute("get", "/album/:id", {
    params: { id: "spotify_album_123" },
  });

  assert.equal(response.status, 500);
  assert.deepEqual(response.body, { error: "Failed to fetch album details" });
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
