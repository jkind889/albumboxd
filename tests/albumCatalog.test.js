const assert = require("node:assert/strict");
const test = require("node:test");

const albumCatalogModelPath = require.resolve("../models/AlbumCatalog");
const spotifyUtilPath = require.resolve("../routes/utils/spotify");
const albumCatalogHelperPath = require.resolve("../routes/utils/albumCatalog");

let cachedAlbum = null;
let updatedAlbum = null;
let spotifyAlbum = null;
const findOneCalls = [];
const findOneAndUpdateCalls = [];

function loadAlbumCatalogHelper() {
  delete require.cache[albumCatalogHelperPath];

  require.cache[albumCatalogModelPath] = {
    id: albumCatalogModelPath,
    filename: albumCatalogModelPath,
    loaded: true,
    exports: {
      findOne: async (query) => {
        findOneCalls.push(query);
        return cachedAlbum;
      },
      findOneAndUpdate: async (query, update, options) => {
        findOneAndUpdateCalls.push({ query, update, options });
        updatedAlbum = update.$set;
        return updatedAlbum;
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

  return require("../routes/utils/albumCatalog");
}

test.beforeEach(() => {
  cachedAlbum = null;
  updatedAlbum = null;
  spotifyAlbum = {
    id: "spotify_album_123",
    name: "Kind of Blue",
    artists: [{ name: "Miles Davis" }],
    release_date: "1959-08-17",
    genres: ["jazz"],
    images: [{ url: "https://example.com/kind-of-blue.jpg" }],
    total_tracks: 2,
    label: "Columbia",
    album_type: "album",
    external_urls: {
      spotify: "https://open.spotify.com/album/spotify_album_123",
    },
    tracks: {
      items: [
        {
          id: "track_1",
          track_number: 1,
          disc_number: 1,
          name: "So What",
          duration_ms: 545000,
          external_urls: {
            spotify: "https://open.spotify.com/track/track_1",
          },
        },
        {
          id: "track_2",
          track_number: 2,
          disc_number: 1,
          name: "Freddie Freeloader",
          duration_ms: 589000,
          external_urls: {
            spotify: "https://open.spotify.com/track/track_2",
          },
        },
      ],
    },
  };
  findOneCalls.length = 0;
  findOneAndUpdateCalls.length = 0;
});

test("normalizeSpotifyAlbum stores track metadata from Spotify album payloads", () => {
  const { normalizeSpotifyAlbum } = loadAlbumCatalogHelper();

  const normalized = normalizeSpotifyAlbum(spotifyAlbum);

  assert.deepEqual(normalized.tracks, [
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
  ]);
});

test("normalizeCatalogAlbum returns catalog tracks to the frontend", () => {
  const { normalizeCatalogAlbum } = loadAlbumCatalogHelper();

  const normalized = normalizeCatalogAlbum({
    spotifyId: "spotify_album_123",
    title: "Kind of Blue",
    artist: "Miles Davis",
    tracks: [
      {
        spotifyId: "track_1",
        trackNumber: 1,
        discNumber: 1,
        title: "So What",
        durationMs: 545000,
        spotifyUrl: "https://open.spotify.com/track/track_1",
      },
    ],
  });

  assert.deepEqual(normalized.tracks, [
    {
      spotifyId: "track_1",
      trackNumber: 1,
      discNumber: 1,
      title: "So What",
      durationMs: 545000,
      spotifyUrl: "https://open.spotify.com/track/track_1",
    },
  ]);
});

test("getOrCreateAlbumCatalog refreshes cached albums that do not have tracks", async () => {
  cachedAlbum = {
    spotifyId: "spotify_album_123",
    title: "Kind of Blue",
    artist: "Miles Davis",
    tracks: [],
  };

  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    assert.equal(url, "https://api.spotify.com/v1/albums/spotify_album_123");
    assert.deepEqual(options.headers, {
      Authorization: "Bearer spotify_token",
    });

    return {
      ok: true,
      json: async () => spotifyAlbum,
    };
  };

  try {
    const { getOrCreateAlbumCatalog } = loadAlbumCatalogHelper();
    const album = await getOrCreateAlbumCatalog("spotify_album_123");

    assert.equal(album.spotifyId, "spotify_album_123");
    assert.equal(album.tracks.length, 2);
    assert.deepEqual(findOneCalls, [{ spotifyId: "spotify_album_123" }]);
    assert.equal(findOneAndUpdateCalls.length, 1);
    assert.deepEqual(findOneAndUpdateCalls[0].query, {
      spotifyId: "spotify_album_123",
    });
    assert.equal(findOneAndUpdateCalls[0].options.upsert, true);
  } finally {
    global.fetch = originalFetch;
  }
});

test("getOrCreateAlbumCatalog returns cached albums that already have tracks", async () => {
  cachedAlbum = {
    spotifyId: "spotify_album_123",
    title: "Kind of Blue",
    artist: "Miles Davis",
    tracks: [{ spotifyId: "track_1", title: "So What" }],
  };

  const originalFetch = global.fetch;
  global.fetch = async () => {
    throw new Error("Spotify should not be called for complete cached albums");
  };

  try {
    const { getOrCreateAlbumCatalog } = loadAlbumCatalogHelper();
    const album = await getOrCreateAlbumCatalog("spotify_album_123");

    assert.equal(album, cachedAlbum);
    assert.deepEqual(findOneCalls, [{ spotifyId: "spotify_album_123" }]);
    assert.equal(findOneAndUpdateCalls.length, 0);
  } finally {
    global.fetch = originalFetch;
  }
});

test("getAlbumCatalogDetails returns a complete cached album without calling Spotify", async () => {
  cachedAlbum = {
    spotifyId: "spotify_album_123",
    title: "Kind of Blue",
    artist: "Miles Davis",
    tracks: [{ spotifyId: "track_1", title: "So What" }],
  };
  const originalFetch = global.fetch;
  global.fetch = async () => {
    throw new Error("Spotify should not be called for complete cached albums");
  };

  try {
    const { getAlbumCatalogDetails } = loadAlbumCatalogHelper();
    const result = await getAlbumCatalogDetails("spotify_album_123");

    assert.equal(result.album, cachedAlbum);
    assert.equal(result.isPartial, false);
    assert.equal(findOneAndUpdateCalls.length, 0);
  } finally {
    global.fetch = originalFetch;
  }
});

test("getAlbumCatalogDetails enriches an incomplete cached album", async () => {
  cachedAlbum = {
    spotifyId: "spotify_album_123",
    title: "Kind of Blue",
    artist: "Miles Davis",
    tracks: [],
  };
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => spotifyAlbum,
  });

  try {
    const { getAlbumCatalogDetails } = loadAlbumCatalogHelper();
    const result = await getAlbumCatalogDetails("spotify_album_123");

    assert.equal(result.isPartial, false);
    assert.equal(result.album.tracks.length, 2);
    assert.equal(findOneAndUpdateCalls.length, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

test("getAlbumCatalogDetails returns cached metadata when enrichment fails", async () => {
  cachedAlbum = {
    spotifyId: "spotify_album_123",
    title: "Kind of Blue",
    artist: "Miles Davis",
    tracks: [],
  };
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 502 });

  try {
    const { getAlbumCatalogDetails } = loadAlbumCatalogHelper();
    const result = await getAlbumCatalogDetails("spotify_album_123");

    assert.equal(result.album, cachedAlbum);
    assert.equal(result.isPartial, true);
    assert.match(result.enrichmentError.message, /status 502/);
    assert.equal(findOneAndUpdateCalls.length, 0);
  } finally {
    global.fetch = originalFetch;
  }
});

test("getAlbumCatalogDetails throws when no cache exists and Spotify fails", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 502 });

  try {
    const { getAlbumCatalogDetails } = loadAlbumCatalogHelper();

    await assert.rejects(
      getAlbumCatalogDetails("spotify_album_123"),
      /status 502/,
    );
    assert.equal(findOneAndUpdateCalls.length, 0);
  } finally {
    global.fetch = originalFetch;
  }
});
