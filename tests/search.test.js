const assert = require("node:assert/strict");
const test = require("node:test");

const albumCatalogModelPath = require.resolve("../models/AlbumCatalog");
const albumCatalogHelperPath = require.resolve("../routes/utils/albumCatalog");
const spotifyUtilPath = require.resolve("../routes/utils/spotify");
const searchRoutePath = require.resolve("../routes/search");

let localAlbums = [];
let textLocalAlbums = [];
let regexLocalAlbums = [];
let spotifyAlbums = [];
const findCalls = [];
const upsertCalls = [];
const fetchCalls = [];
const countCalls = [];

function isTextQuery(query) {
  return Boolean(query?.$text);
}

function getMockAlbumsForQuery(query) {
  if (isTextQuery(query)) {
    return textLocalAlbums.length > 0 ? textLocalAlbums : localAlbums;
  }

  return regexLocalAlbums.length > 0 ? regexLocalAlbums : localAlbums;
}

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
        const albums = getMockAlbumsForQuery(query);
        const chain = {
          sort: (sortOrder) => {
            findCalls.push({ sort: sortOrder });
            return chain;
          },
          skip: (skip) => {
            findCalls.push({ skip });
            chain.skipValue = skip;
            return chain;
          },
          limit: async (limit) => {
            findCalls.push({ limit });
            const skip = chain.skipValue || 0;
            return albums.slice(skip, skip + limit);
          },
          skipValue: 0,
        };

        return chain;
      },
      countDocuments: async (query) => {
        countCalls.push(query);

        if (isTextQuery(query)) {
          return textLocalAlbums.length || localAlbums.length;
        }

        return regexLocalAlbums.length || localAlbums.length;
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

async function searchAlbums(query, extraQuery = {}) {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    fetchCalls.push(url);

    return {
      ok: true,
      json: async () => ({
        albums: {
          items: spotifyAlbums,
        },
      }),
    };
  };

  try {
    const router = loadSearchRouter();
    const route = router.stack.find(
      (layer) => layer.route?.path === "/search" && layer.route.methods.get,
    );

    assert.ok(route, "GET /search should be registered");

    const req = { query: { q: query, ...extraQuery } };
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
      body: res.body,
    };
  } finally {
    global.fetch = originalFetch;
  }
}

test.beforeEach(() => {
  localAlbums = [];
  textLocalAlbums = [];
  regexLocalAlbums = [];
  spotifyAlbums = [];
  findCalls.length = 0;
  upsertCalls.length = 0;
  fetchCalls.length = 0;
  countCalls.length = 0;
});

test("GET /search returns local catalog matches and upserted Spotify results", async () => {
  textLocalAlbums = [
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
  assert.equal(fetchCalls.length, 1);
  assert.ok(fetchCalls[0].includes("limit=23"));
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
  textLocalAlbums = [
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

test("GET /search returns local catalog results without calling Spotify when cache fills the page", async () => {
  textLocalAlbums = Array.from({ length: 24 }, (_, index) => ({
    spotifyId: `local_album_${index}`,
    title: `Local Album ${index}`,
    artist: "Catalog Artist",
    year: "2026",
    cover: "https://example.com/local.jpg",
  }));

  const response = await searchAlbums("local");

  assert.equal(response.status, 200);
  assert.equal(response.body.length, 24);
  assert.equal(fetchCalls.length, 0);
  assert.equal(upsertCalls.length, 0);
});

test("GET /search page mode returns catalog pages before calling Spotify", async () => {
  textLocalAlbums = Array.from({ length: 30 }, (_, index) => ({
    spotifyId: `local_album_${index}`,
    title: `Local Album ${index}`,
    artist: "Catalog Artist",
    year: "2026",
    cover: "https://example.com/local.jpg",
  }));
  spotifyAlbums = [
    {
      id: "spotify_album_1",
      name: "Spotify One",
      artists: [{ name: "Remote Artist" }],
      release_date: "2020-01-01",
      images: [{ url: "https://example.com/spotify-1.jpg" }],
    },
  ];

  const firstPage = await searchAlbums("local", { page: "1", limit: "24" });
  const secondPage = await searchAlbums("local", { page: "2", limit: "24" });

  assert.equal(firstPage.status, 200);
  assert.equal(firstPage.body.results.length, 24);
  assert.equal(firstPage.body.results[0].id, "local_album_0");
  assert.equal(firstPage.body.hasNextPage, true);
  assert.equal(fetchCalls.length, 1);
  assert.equal(secondPage.body.results[0].id, "local_album_24");
  assert.equal(secondPage.body.results[5].id, "local_album_29");
  assert.equal(secondPage.body.results[6].id, "spotify_album_1");
  assert.ok(fetchCalls[0].includes("limit=18"));
  assert.ok(fetchCalls[0].includes("offset=0"));
});

test("GET /search page mode offsets Spotify after earlier local results", async () => {
  textLocalAlbums = Array.from({ length: 10 }, (_, index) => ({
    spotifyId: `local_album_${index}`,
    title: `Local Album ${index}`,
    artist: "Catalog Artist",
    year: "2026",
    cover: "https://example.com/local.jpg",
  }));
  spotifyAlbums = [
    {
      id: "spotify_album_14",
      name: "Spotify Offset Album",
      artists: [{ name: "Remote Artist" }],
      release_date: "2020-01-01",
      images: [{ url: "https://example.com/spotify-offset.jpg" }],
    },
  ];

  const response = await searchAlbums("mixed", { page: "2", limit: "24" });

  assert.equal(response.status, 200);
  assert.equal(response.body.results[0].id, "spotify_album_14");
  assert.ok(fetchCalls[0].includes("limit=24"));
  assert.ok(fetchCalls[0].includes("offset=14"));
  assert.deepEqual(countCalls[0], { $text: { $search: "mixed" } });
});

test("GET /search falls back to regex catalog search when text search has no matches", async () => {
  regexLocalAlbums = [
    {
      spotifyId: "regex_album_123",
      title: "Kid A",
      artist: "Radiohead",
      year: "2000",
      cover: "https://example.com/kid-a.jpg",
    },
  ];

  const response = await searchAlbums("kid");

  assert.equal(response.status, 200);
  assert.deepEqual(findCalls[0], { $text: { $search: "kid" } });
  assert.deepEqual(findCalls[3], {
    $or: [
      { title: { $regex: "kid", $options: "i" } },
      { artist: { $regex: "kid", $options: "i" } },
      { artists: { $regex: "kid", $options: "i" } },
    ],
  });
  assert.equal(response.body[0].id, "regex_album_123");
});

test("GET /search returns an empty array for a blank query", async () => {
  const response = await searchAlbums(" ");

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, []);
  assert.equal(findCalls.length, 0);
  assert.equal(upsertCalls.length, 0);
});
