const assert = require("node:assert/strict");
const test = require("node:test");

const albumCatalogModelPath = require.resolve("../models/AlbumCatalog");
const musicBrainzHelperPath = require.resolve("../routes/utils/musicBrainz");
const exploreRoutePath = require.resolve("../routes/explore");

let catalogAlbum = null;
let resolverResult = null;
let resolverError = null;
const albumFindCalls = [];
const resolverCalls = [];

function loadExploreRouter() {
  delete require.cache[exploreRoutePath];

  require.cache[albumCatalogModelPath] = {
    id: albumCatalogModelPath,
    filename: albumCatalogModelPath,
    loaded: true,
    exports: {
      findOne: async (query) => {
        albumFindCalls.push(query);
        return catalogAlbum;
      },
    },
  };
  require.cache[musicBrainzHelperPath] = {
    id: musicBrainzHelperPath,
    filename: musicBrainzHelperPath,
    loaded: true,
    exports: {
      getOrResolveArtist: async (input) => {
        resolverCalls.push(input);

        if (resolverError) {
          throw resolverError;
        }

        return resolverResult;
      },
    },
  };

  return require("../routes/explore");
}

async function callArtistRoute(spotifyArtistId) {
  const router = loadExploreRouter();
  const route = router.stack.find(
    (layer) => layer.route?.path === "/artists/:spotifyArtistId",
  );
  const req = { params: { spotifyArtistId } };
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
  return res;
}

test.beforeEach(() => {
  catalogAlbum = null;
  resolverResult = null;
  resolverError = null;
  albumFindCalls.length = 0;
  resolverCalls.length = 0;
});

test("GET /explore/artists/:spotifyArtistId resolves an indexed track artist", async () => {
  catalogAlbum = {
    artistRefs: [{ spotifyId: "primary_artist", name: "Primary Artist" }],
    tracks: [
      {
        artistRefs: [
          { spotifyId: "primary_artist", name: "Primary Artist" },
          { spotifyId: "featured_artist", name: "Featured Artist" },
        ],
      },
    ],
  };
  resolverResult = {
    artist: {
      spotifyId: "featured_artist",
      musicBrainzId: "featured-mbid",
      name: "Featured Artist",
      mappingStatus: "resolved",
    },
    cacheStatus: "miss",
  };

  const response = await callArtistRoute("featured_artist");

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, resolverResult);
  assert.deepEqual(resolverCalls, [{
    spotifyId: "featured_artist",
    name: "Featured Artist",
  }]);
  assert.deepEqual(albumFindCalls[0], {
    $or: [
      { "artistRefs.spotifyId": "featured_artist" },
      { "tracks.artistRefs.spotifyId": "featured_artist" },
    ],
  });
});

test("GET /explore/artists/:spotifyArtistId rejects artists outside the local catalog", async () => {
  const response = await callArtistRoute("unknown_artist");

  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.body, {
    error: "Artist has not been indexed in the album catalog yet",
  });
  assert.equal(resolverCalls.length, 0);
});

test("GET /explore/artists/:spotifyArtistId degrades provider failures to 502", async () => {
  catalogAlbum = {
    artistRefs: [{ spotifyId: "known_artist", name: "Known Artist" }],
    tracks: [],
  };
  resolverError = new Error("MusicBrainz unavailable");
  const originalConsoleError = console.error;
  console.error = () => {};

  try {
    const response = await callArtistRoute("known_artist");

    assert.equal(response.statusCode, 502);
    assert.deepEqual(response.body, {
      error: "Unable to resolve artist metadata right now",
    });
  } finally {
    console.error = originalConsoleError;
  }
});
