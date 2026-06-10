const assert = require("node:assert/strict");
const test = require("node:test");

const albumCatalogModelPath = require.resolve("../models/AlbumCatalog");
const albumCatalogHelperPath = require.resolve("../routes/utils/albumCatalog");
const spotifyUtilPath = require.resolve("../routes/utils/spotify");
const searchRoutePath = require.resolve("../routes/search");

let localAlbums = [];
let spotifyAlbums = [];
const findCalls = [];
const upsertCalls = [];

// Loads the search router with mocked catalog, Spotify token, and helper calls.
function loadSearchRouter() {
  delete require.cache[searchRoutePath];

  require.cache[albumCatalogModelPath] = {
    id: albumCatalogModelPath,
    filename: albumCatalogModelPath,
    loaded: true,
    exports: {
      find: (query) => {
        findCalls.push(query);
        return {
          limit: async (limit) => {
            findCalls.push({ limit });
            return localAlbums;
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
      normalizeSpotifyAlbum: (album) => ({
        spotifyId: album.id,
        title: album.name,
        artist: album.artists?.[0]?.name || "Unknown Artist",
        artists: album.artists?.map((artist) => artist.name) || [],
        year: album.release_date?.slice(0, 4) || "unknown",
        cover: album.images?.[0]?.url || null,
      }),
      toSearchResult: (album) => ({
        id: album.spotifyId,
        title: album.title,
        artist: album.artist,
        year: album.year,
        cover: album.cover,
      }),
      upsertAlbumCatalog: async (album) => {
        upsertCalls.push(album);
        return album;
      },
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

  return require("../routes/search");
}

async function searchAlbums(query) {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      albums: {
        items: spotifyAlbums,
      },
    }),
  });

  try {
    const router = loadSearchRouter();
    const route = router.stack.find(
      (layer) => layer.route?.path === "/search" && layer.route.methods.get,
    );

    assert.ok(route, "GET /search should be registered");

    const req = { query: { q: query } };
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

    await route.route.stack[0].handle(req, res);

    return {
      status: res.statusCode,
      body: res.body,
    };
  } finally {
    global.fetch = originalFetch;
  }
}

test.beforeEach(() => {
  localAlbums = [];
  spotifyAlbums = [];
  findCalls.length = 0;
  upsertCalls.length = 0;
});

test("GET /search returns local catalog matches and upserted Spotify results", async () => {
  localAlbums = [
    {
      spotifyId: "local_album_123",
      title: "Kind of Blue",
      artist: "Miles Davis",
      year: "1959",
      cover: "https://example.com/local.jpg",
    },
  ];
  spotifyAlbums = [
    {
      id: "spotify_album_456",
      name: "Kind of Blue Legacy Edition",
      artists: [{ name: "Miles Davis" }],
      release_date: "2008-01-01",
      images: [{ url: "https://example.com/spotify.jpg" }],
    },
  ];

  const response = await searchAlbums("kind");

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, [
    {
      id: "local_album_123",
      title: "Kind of Blue",
      artist: "Miles Davis",
      year: "1959",
      cover: "https://example.com/local.jpg",
    },
    {
      id: "spotify_album_456",
      title: "Kind of Blue Legacy Edition",
      artist: "Miles Davis",
      year: "2008",
      cover: "https://example.com/spotify.jpg",
    },
  ]);
  assert.equal(upsertCalls.length, 1);
  assert.equal(upsertCalls[0].spotifyId, "spotify_album_456");
});

test("GET /search removes Spotify duplicates already returned from the local catalog", async () => {
  localAlbums = [
    {
      spotifyId: "spotify_album_123",
      title: "Kind of Blue",
      artist: "Miles Davis",
      year: "1959",
      cover: "https://example.com/local.jpg",
    },
  ];
  spotifyAlbums = [
    {
      id: "spotify_album_123",
      name: "Kind of Blue",
      artists: [{ name: "Miles Davis" }],
      release_date: "1959-08-17",
      images: [{ url: "https://example.com/spotify.jpg" }],
    },
  ];

  const response = await searchAlbums("kind");

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, [
    {
      id: "spotify_album_123",
      title: "Kind of Blue",
      artist: "Miles Davis",
      year: "1959",
      cover: "https://example.com/local.jpg",
    },
  ]);
  assert.equal(upsertCalls.length, 1);
});

test("GET /search returns an empty array for a blank query", async () => {
  const response = await searchAlbums(" ");

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, []);
  assert.equal(findCalls.length, 0);
  assert.equal(upsertCalls.length, 0);
});
