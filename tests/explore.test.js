const assert = require("node:assert/strict");
const test = require("node:test");

const albumCatalogModelPath = require.resolve("../models/AlbumCatalog");
const artistCatalogModelPath = require.resolve("../models/ArtistCatalog");
const listenBrainzHelperPath = require.resolve("../routes/utils/listenBrainz");
const musicBrainzHelperPath = require.resolve("../routes/utils/musicBrainz");
const artistCollaborationsHelperPath = require.resolve(
  "../routes/utils/artistCollaborations",
);
const exploreRoutePath = require.resolve("../routes/explore");

const PRIMARY_SPOTIFY_ID = "1111111111111111111111";
const FEATURED_SPOTIFY_ID = "2222222222222222222222";
const UNKNOWN_SPOTIFY_ID = "3333333333333333333333";
const LOCAL_NEIGHBOR_SPOTIFY_ID = "4444444444444444444444";
const SECOND_LOCAL_NEIGHBOR_SPOTIFY_ID = "5555555555555555555555";
const SEED_MBID = "a74b1b7f-71a5-4011-9441-d0b5e4122711";
const FIRST_NEIGHBOR_MBID = "10adbe5e-a2c0-4bf3-8249-2b4cbf6e6ca8";
const SECOND_NEIGHBOR_MBID = "87c5dedd-371d-4a53-9f7f-80522fb7f3cb";
const THIRD_NEIGHBOR_MBID = "cb67438a-7f50-4f2b-a6f1-2bb2729fd538";
const FETCHED_AT = new Date("2026-07-18T12:00:00.000Z");
const EXPIRES_AT = new Date("2026-07-25T12:00:00.000Z");

let catalogAlbum = null;
let albumFindError = null;
let catalogAlbums = [];
let albumFindManyError = null;
let resolverResult = null;
let resolverError = null;
let neighborhoodResult = null;
let neighborhoodError = null;
let artistCatalogRows = [];
let artistCatalogError = null;
const albumFindCalls = [];
const albumFindManyCalls = [];
const artistFindCalls = [];
const resolverCalls = [];
const neighborhoodCalls = [];

class MockListenBrainzBackoffError extends Error {}
class MockListenBrainzBusyError extends Error {}

function loadExploreRouter() {
  delete require.cache[exploreRoutePath];
  delete require.cache[artistCollaborationsHelperPath];

  require.cache[albumCatalogModelPath] = {
    id: albumCatalogModelPath,
    filename: albumCatalogModelPath,
    loaded: true,
    exports: {
      findOne: async (query) => {
        albumFindCalls.push(query);

        if (albumFindError) {
          throw albumFindError;
        }

        return catalogAlbum;
      },
      find: (query) => {
        albumFindManyCalls.push(query);

        return {
          async lean() {
            if (albumFindManyError) {
              throw albumFindManyError;
            }

            return catalogAlbums;
          },
        };
      },
    },
  };
  require.cache[artistCatalogModelPath] = {
    id: artistCatalogModelPath,
    filename: artistCatalogModelPath,
    loaded: true,
    exports: {
      find: async (query) => {
        artistFindCalls.push(query);

        if (artistCatalogError) {
          throw artistCatalogError;
        }

        return artistCatalogRows;
      },
    },
  };
  require.cache[listenBrainzHelperPath] = {
    id: listenBrainzHelperPath,
    filename: listenBrainzHelperPath,
    loaded: true,
    exports: {
      ListenBrainzBackoffError: MockListenBrainzBackoffError,
      ListenBrainzBusyError: MockListenBrainzBusyError,
      getOrCreateArtistNeighborhood: async (musicBrainzId) => {
        neighborhoodCalls.push(musicBrainzId);

        if (neighborhoodError) {
          throw neighborhoodError;
        }

        return neighborhoodResult;
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

async function callExploreRoute(
  routePath,
  spotifyArtistId,
  query = {},
  routeParams = {},
) {
  const router = loadExploreRouter();
  const route = router.stack.find((layer) => layer.route?.path === routePath);
  const req = {
    params: { spotifyArtistId, ...routeParams },
    query,
  };
  const res = {
    statusCode: 200,
    body: null,
    headers: {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this.body = data;
      return this;
    },
    set(name, value) {
      this.headers[name] = value;
      return this;
    },
  };

  async function runLayer(index) {
    const layer = route.route.stack[index];

    if (!layer) {
      return;
    }

    let downstream;
    const next = (error) => {
      if (error) {
        throw error;
      }

      downstream = runLayer(index + 1);
      return downstream;
    };

    await layer.handle(req, res, next);

    if (downstream) {
      await downstream;
    }
  }

  await runLayer(0);
  return res;
}

function callArtistRoute(spotifyArtistId) {
  return callExploreRoute("/artists/:spotifyArtistId", spotifyArtistId);
}

function callSimilarArtistsRoute(spotifyArtistId, query) {
  return callExploreRoute(
    "/artists/:spotifyArtistId/similar",
    spotifyArtistId,
    query,
  );
}

function callCollaborationsRoute(
  seedSpotifyId,
  collaboratorSpotifyId,
  query,
) {
  return callExploreRoute(
    "/artists/:seedSpotifyId/collaborations/:collaboratorSpotifyId",
    seedSpotifyId,
    query,
    { seedSpotifyId, collaboratorSpotifyId },
  );
}

function indexedAlbum() {
  return {
    artistRefs: [{ spotifyId: PRIMARY_SPOTIFY_ID, name: "Primary Artist" }],
    tracks: [
      {
        artistRefs: [
          { spotifyId: PRIMARY_SPOTIFY_ID, name: "Primary Artist" },
          { spotifyId: FEATURED_SPOTIFY_ID, name: "Featured Artist" },
        ],
      },
    ],
  };
}

function resolvedIdentity(overrides = {}) {
  return {
    artist: {
      spotifyId: PRIMARY_SPOTIFY_ID,
      spotifyUrl: `https://open.spotify.com/artist/${PRIMARY_SPOTIFY_ID}`,
      musicBrainzId: SEED_MBID,
      name: "Primary Artist",
      mappingStatus: "resolved",
      ...overrides,
    },
    cacheStatus: "hit",
  };
}

function relatedNeighborhood() {
  return {
    neighborhood: {
      seedMusicBrainzId: SEED_MBID,
      source: "listenbrainz",
      algorithm: "test-algorithm",
      neighbors: [
        {
          musicBrainzId: FIRST_NEIGHBOR_MBID,
          name: "Massive Attack",
          comment: "",
          artistType: "Group",
          gender: "",
          rawScore: 100,
          rank: 1,
          weight: 1,
        },
        {
          musicBrainzId: SECOND_NEIGHBOR_MBID,
          name: "Bjork",
          comment: "",
          artistType: "Person",
          gender: "Female",
          rawScore: 80,
          rank: 2,
          weight: 0.8,
        },
        {
          musicBrainzId: THIRD_NEIGHBOR_MBID,
          name: "Air",
          comment: "French band",
          artistType: "Group",
          gender: "",
          rawScore: 60,
          rank: 3,
          weight: 0.6,
        },
      ],
      fetchedAt: FETCHED_AT,
      expiresAt: EXPIRES_AT,
    },
    cacheStatus: "miss",
  };
}

test.beforeEach(() => {
  catalogAlbum = null;
  albumFindError = null;
  catalogAlbums = [];
  albumFindManyError = null;
  resolverResult = null;
  resolverError = null;
  neighborhoodResult = null;
  neighborhoodError = null;
  artistCatalogRows = [];
  artistCatalogError = null;
  albumFindCalls.length = 0;
  albumFindManyCalls.length = 0;
  artistFindCalls.length = 0;
  resolverCalls.length = 0;
  neighborhoodCalls.length = 0;
});

test("GET /explore/artists/:spotifyArtistId resolves an indexed track artist", async () => {
  catalogAlbum = indexedAlbum();
  resolverResult = resolvedIdentity({
    spotifyId: FEATURED_SPOTIFY_ID,
    name: "Featured Artist",
  });

  const response = await callArtistRoute(FEATURED_SPOTIFY_ID);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, resolverResult);
  assert.deepEqual(resolverCalls, [{
    spotifyId: FEATURED_SPOTIFY_ID,
    name: "Featured Artist",
  }]);
  assert.deepEqual(albumFindCalls[0], {
    $or: [
      { "artistRefs.spotifyId": FEATURED_SPOTIFY_ID },
      { "tracks.artistRefs.spotifyId": FEATURED_SPOTIFY_ID },
    ],
  });
});

test("GET /explore/artists/:spotifyArtistId rejects an invalid Spotify artist id", async () => {
  const response = await callArtistRoute("not-a-spotify-id");

  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.body, {
    error: "A valid Spotify artist id is required",
  });
  assert.equal(albumFindCalls.length, 0);
  assert.equal(resolverCalls.length, 0);
});

test("GET /explore/artists/:spotifyArtistId rejects artists outside the local catalog", async () => {
  const response = await callArtistRoute(UNKNOWN_SPOTIFY_ID);

  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.body, {
    error: "Artist has not been indexed in the album catalog yet",
  });
  assert.equal(resolverCalls.length, 0);
});

test("GET /explore/artists/:spotifyArtistId degrades provider failures to 502", async () => {
  catalogAlbum = indexedAlbum();
  resolverError = new Error("MusicBrainz unavailable");
  const originalConsoleError = console.error;
  console.error = () => {};

  try {
    const response = await callArtistRoute(PRIMARY_SPOTIFY_ID);

    assert.equal(response.statusCode, 502);
    assert.deepEqual(response.body, {
      error: "Unable to resolve artist metadata right now",
    });
  } finally {
    console.error = originalConsoleError;
  }
});

test("GET /explore/artists/:spotifyArtistId/similar returns limited neighbors with bulk local Spotify mappings", async () => {
  catalogAlbum = indexedAlbum();
  resolverResult = resolvedIdentity();
  neighborhoodResult = relatedNeighborhood();
  artistCatalogRows = [
    {
      spotifyId: SECOND_LOCAL_NEIGHBOR_SPOTIFY_ID,
      spotifyUrl: `https://open.spotify.com/artist/${SECOND_LOCAL_NEIGHBOR_SPOTIFY_ID}`,
      musicBrainzId: FIRST_NEIGHBOR_MBID,
      musicBrainzName: "Massive Attack duplicate",
      mappingStatus: "resolved",
    },
    {
      spotifyId: LOCAL_NEIGHBOR_SPOTIFY_ID,
      spotifyUrl: `https://open.spotify.com/artist/${LOCAL_NEIGHBOR_SPOTIFY_ID}`,
      musicBrainzId: FIRST_NEIGHBOR_MBID,
      name: "Massive Attack",
      mappingStatus: "resolved",
    },
    {
      spotifyId: "6666666666666666666666",
      musicBrainzId: THIRD_NEIGHBOR_MBID,
      name: "Air",
      mappingStatus: "resolved",
    },
  ];

  const response = await callSimilarArtistsRoute(PRIMARY_SPOTIFY_ID, { limit: "2" });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(resolverCalls, [{
    spotifyId: PRIMARY_SPOTIFY_ID,
    name: "Primary Artist",
  }]);
  assert.deepEqual(neighborhoodCalls, [SEED_MBID]);
  assert.deepEqual(artistFindCalls, [{
    musicBrainzId: { $in: [FIRST_NEIGHBOR_MBID, SECOND_NEIGHBOR_MBID] },
    mappingStatus: "resolved",
  }]);
  assert.deepEqual(response.body, {
    seed: {
      spotifyId: PRIMARY_SPOTIFY_ID,
      spotifyUrl: `https://open.spotify.com/artist/${PRIMARY_SPOTIFY_ID}`,
      musicBrainzId: SEED_MBID,
      name: "Primary Artist",
    },
    neighbors: [
      {
        musicBrainzId: FIRST_NEIGHBOR_MBID,
        name: "Massive Attack",
        comment: "",
        artistType: "Group",
        gender: "",
        rawScore: 100,
        rank: 1,
        weight: 1,
        spotifyArtists: [
          {
            spotifyId: LOCAL_NEIGHBOR_SPOTIFY_ID,
            name: "Massive Attack",
            spotifyUrl: `https://open.spotify.com/artist/${LOCAL_NEIGHBOR_SPOTIFY_ID}`,
          },
          {
            spotifyId: SECOND_LOCAL_NEIGHBOR_SPOTIFY_ID,
            name: "Massive Attack duplicate",
            spotifyUrl: `https://open.spotify.com/artist/${SECOND_LOCAL_NEIGHBOR_SPOTIFY_ID}`,
          },
        ],
      },
      {
        musicBrainzId: SECOND_NEIGHBOR_MBID,
        name: "Bjork",
        comment: "",
        artistType: "Person",
        gender: "Female",
        rawScore: 80,
        rank: 2,
        weight: 0.8,
        spotifyArtists: [],
      },
    ],
    source: "listenbrainz",
    algorithm: "test-algorithm",
    cacheStatus: "miss",
    identityCacheStatus: "hit",
    spotifyMappingStatus: "complete",
    fetchedAt: FETCHED_AT,
    expiresAt: EXPIRES_AT,
  });
});

test("GET /explore/artists/:spotifyArtistId/similar validates artist ids and limits before database work", async (t) => {
  await t.test("invalid artist id", async () => {
    const response = await callSimilarArtistsRoute("invalid", { limit: "12" });

    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.body, {
      error: "A valid Spotify artist id is required",
    });
  });

  for (const limit of ["0", "51", "1.5", "many"]) {
    await t.test(`invalid limit ${limit}`, async () => {
      const response = await callSimilarArtistsRoute(PRIMARY_SPOTIFY_ID, { limit });

      assert.equal(response.statusCode, 400);
      assert.deepEqual(response.body, {
        error: "limit must be an integer between 1 and 50",
      });
    });
  }

  assert.equal(albumFindCalls.length, 0);
  assert.equal(resolverCalls.length, 0);
  assert.equal(neighborhoodCalls.length, 0);
  assert.equal(artistFindCalls.length, 0);
});

test("GET /explore/artists/:spotifyArtistId/similar rejects artists outside the local catalog", async () => {
  const response = await callSimilarArtistsRoute(UNKNOWN_SPOTIFY_ID);

  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.body, {
    error: "Artist has not been indexed in the album catalog yet",
  });
  assert.equal(resolverCalls.length, 0);
  assert.equal(neighborhoodCalls.length, 0);
});

test("GET /explore/artists/:spotifyArtistId/similar returns 422 when no MBID mapping exists", async () => {
  catalogAlbum = indexedAlbum();
  resolverResult = {
    artist: {
      spotifyId: PRIMARY_SPOTIFY_ID,
      name: "Primary Artist",
      musicBrainzId: null,
      mappingStatus: "not_found",
    },
    cacheStatus: "hit",
  };

  const response = await callSimilarArtistsRoute(PRIMARY_SPOTIFY_ID);

  assert.equal(response.statusCode, 422);
  assert.deepEqual(response.body, {
    error: "No MusicBrainz mapping is available for this artist yet",
    code: "ARTIST_MBID_UNAVAILABLE",
  });
  assert.equal(neighborhoodCalls.length, 0);
  assert.equal(artistFindCalls.length, 0);
});

test("GET /explore/artists/:spotifyArtistId/similar applies the default limit after loading the snapshot", async () => {
  catalogAlbum = indexedAlbum();
  resolverResult = resolvedIdentity();
  const neighbors = Array.from({ length: 13 }, (_, index) => ({
    musicBrainzId: `00000000-0000-0000-0000-${String(index + 1).padStart(12, "0")}`,
    name: `Neighbor ${index + 1}`,
    comment: "",
    artistType: "Group",
    gender: "",
    rawScore: 100 - index,
    rank: index + 1,
    weight: (100 - index) / 100,
  }));
  neighborhoodResult = relatedNeighborhood();
  neighborhoodResult.neighborhood.neighbors = neighbors;

  const response = await callSimilarArtistsRoute(PRIMARY_SPOTIFY_ID);

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.neighbors.length, 12);
  assert.equal(artistFindCalls[0].musicBrainzId.$in.length, 12);
  assert.equal(response.body.neighbors[11].rank, 12);
});

test("GET /explore/artists/:spotifyArtistId/similar returns an empty neighborhood without a Spotify query", async () => {
  catalogAlbum = indexedAlbum();
  resolverResult = resolvedIdentity();
  neighborhoodResult = relatedNeighborhood();
  neighborhoodResult.neighborhood.neighbors = [];

  const response = await callSimilarArtistsRoute(PRIMARY_SPOTIFY_ID);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body.neighbors, []);
  assert.equal(response.body.spotifyMappingStatus, "complete");
  assert.equal(artistFindCalls.length, 0);
});

test("GET /explore/artists/:spotifyArtistId/similar keeps MBID neighbors when Spotify hydration fails", async () => {
  catalogAlbum = indexedAlbum();
  resolverResult = resolvedIdentity();
  neighborhoodResult = relatedNeighborhood();
  artistCatalogError = new Error("Artist catalog unavailable");
  const originalConsoleError = console.error;
  console.error = () => {};

  try {
    const response = await callSimilarArtistsRoute(PRIMARY_SPOTIFY_ID, { limit: "1" });

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.spotifyMappingStatus, "unavailable");
    assert.deepEqual(response.body.neighbors[0].spotifyArtists, []);
    assert.equal(response.body.neighbors[0].musicBrainzId, FIRST_NEIGHBOR_MBID);
  } finally {
    console.error = originalConsoleError;
  }
});

test("GET /explore/artists/:spotifyArtistId/similar reports local catalog outages as 503", async () => {
  albumFindError = new Error("Mongo unavailable");
  const originalConsoleError = console.error;
  console.error = () => {};

  try {
    const response = await callSimilarArtistsRoute(PRIMARY_SPOTIFY_ID);

    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.body, {
      error: "Artist catalog is temporarily unavailable",
    });
    assert.equal(resolverCalls.length, 0);
  } finally {
    console.error = originalConsoleError;
  }
});

test("GET /explore/artists/:spotifyArtistId/similar exposes provider backoff as a retryable 503", async () => {
  catalogAlbum = indexedAlbum();
  resolverResult = resolvedIdentity();
  neighborhoodError = new MockListenBrainzBackoffError("Recent cold failure");
  neighborhoodError.retryAfterMs = 12000;
  const originalConsoleError = console.error;
  console.error = () => {};

  try {
    const response = await callSimilarArtistsRoute(PRIMARY_SPOTIFY_ID);

    assert.equal(response.statusCode, 503);
    assert.equal(response.headers["Retry-After"], "12");
    assert.deepEqual(response.body, {
      error: "Related artist lookups are temporarily busy",
      retryAfterSeconds: 12,
    });
  } finally {
    console.error = originalConsoleError;
  }
});

test("GET /explore/artists/:spotifyArtistId/similar degrades neighborhood provider failures to 502", async () => {
  catalogAlbum = indexedAlbum();
  resolverResult = resolvedIdentity();
  neighborhoodError = new Error("ListenBrainz unavailable");
  const originalConsoleError = console.error;
  console.error = () => {};

  try {
    const response = await callSimilarArtistsRoute(PRIMARY_SPOTIFY_ID);

    assert.equal(response.statusCode, 502);
    assert.deepEqual(response.body, {
      error: "Unable to load related artists right now",
    });
    assert.equal(artistFindCalls.length, 0);
  } finally {
    console.error = originalConsoleError;
  }
});

test("GET collaboration albums returns normalized local evidence without provider calls", async () => {
  catalogAlbum = indexedAlbum();
  catalogAlbums = [{
    spotifyId: "aaaaaaaaaaaaaaaaaaaaaa",
    title: "Shared Record",
    artist: "Primary Artist & Featured Artist",
    artists: ["Primary Artist", "Featured Artist"],
    artistRefs: [
      { spotifyId: PRIMARY_SPOTIFY_ID, name: "Primary Artist" },
      { spotifyId: FEATURED_SPOTIFY_ID, name: "Featured Artist" },
    ],
    year: "2025",
    releaseDate: "2025-04-02",
    cover: "https://images.example/shared-record.jpg",
    albumType: "album",
    spotifyUrl: "https://open.spotify.com/album/aaaaaaaaaaaaaaaaaaaaaa",
    detailMetadataVersion: 2,
    tracks: [{
      spotifyId: "bbbbbbbbbbbbbbbbbbbbbb",
      title: "Shared Song",
      trackNumber: 2,
      discNumber: 1,
      spotifyUrl: "https://open.spotify.com/track/bbbbbbbbbbbbbbbbbbbbbb",
      artistRefs: [
        { spotifyId: PRIMARY_SPOTIFY_ID, name: "Primary Artist" },
        { spotifyId: FEATURED_SPOTIFY_ID, name: "Featured Artist" },
      ],
    }],
  }];

  const response = await callCollaborationsRoute(
    PRIMARY_SPOTIFY_ID,
    FEATURED_SPOTIFY_ID,
  );

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, {
    seed: { spotifyId: PRIMARY_SPOTIFY_ID },
    collaborator: { spotifyId: FEATURED_SPOTIFY_ID },
    albums: [{
      spotifyId: "aaaaaaaaaaaaaaaaaaaaaa",
      title: "Shared Record",
      artist: "Primary Artist & Featured Artist",
      artists: ["Primary Artist", "Featured Artist"],
      cover: "https://images.example/shared-record.jpg",
      year: "2025",
      releaseDate: "2025-04-02",
      albumType: "album",
      spotifyUrl: "https://open.spotify.com/album/aaaaaaaaaaaaaaaaaaaaaa",
      evidenceTypes: ["album_credit", "same_track"],
      sharedTracks: [{
        spotifyId: "bbbbbbbbbbbbbbbbbbbbbb",
        title: "Shared Song",
        trackNumber: 2,
        discNumber: 1,
        spotifyUrl: "https://open.spotify.com/track/bbbbbbbbbbbbbbbbbbbbbb",
      }],
    }],
    total: 1,
    hasMore: false,
    coverage: {
      status: "partial",
      sources: ["album_catalog"],
      externalLookupAttempted: false,
    },
  });
  assert.deepEqual(albumFindManyCalls, [{
    $or: [
      {
        "artistRefs.spotifyId": {
          $all: [PRIMARY_SPOTIFY_ID, FEATURED_SPOTIFY_ID],
        },
      },
      {
        detailMetadataVersion: { $gte: 2 },
        tracks: {
          $elemMatch: {
            "artistRefs.spotifyId": {
              $all: [PRIMARY_SPOTIFY_ID, FEATURED_SPOTIFY_ID],
            },
          },
        },
      },
    ],
  }]);
  assert.equal(resolverCalls.length, 0);
  assert.equal(neighborhoodCalls.length, 0);
  assert.equal(artistFindCalls.length, 0);
});

test("GET collaboration albums validates ids, distinct artists, and limits before catalog work", async (t) => {
  const cases = [
    {
      name: "invalid seed id",
      seedSpotifyId: "invalid",
      collaboratorSpotifyId: FEATURED_SPOTIFY_ID,
      query: undefined,
      error: "A valid seed Spotify artist id is required",
    },
    {
      name: "invalid collaborator id",
      seedSpotifyId: PRIMARY_SPOTIFY_ID,
      collaboratorSpotifyId: "invalid",
      query: undefined,
      error: "A valid collaborator Spotify artist id is required",
    },
    {
      name: "identical ids",
      seedSpotifyId: PRIMARY_SPOTIFY_ID,
      collaboratorSpotifyId: PRIMARY_SPOTIFY_ID,
      query: undefined,
      error: "Seed and collaborator Spotify artist ids must be different",
    },
    ...["0", "7", "1.5", "many"].map((limit) => ({
      name: `invalid limit ${limit}`,
      seedSpotifyId: PRIMARY_SPOTIFY_ID,
      collaboratorSpotifyId: FEATURED_SPOTIFY_ID,
      query: { limit },
      error: "limit must be an integer between 1 and 6",
    })),
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const response = await callCollaborationsRoute(
        testCase.seedSpotifyId,
        testCase.collaboratorSpotifyId,
        testCase.query,
      );

      assert.equal(response.statusCode, 400);
      assert.deepEqual(response.body, { error: testCase.error });
    });
  }

  assert.equal(albumFindCalls.length, 0);
  assert.equal(albumFindManyCalls.length, 0);
  assert.equal(resolverCalls.length, 0);
  assert.equal(neighborhoodCalls.length, 0);
});

test("GET collaboration albums returns 404 when the seed is not locally indexed", async () => {
  const response = await callCollaborationsRoute(
    UNKNOWN_SPOTIFY_ID,
    FEATURED_SPOTIFY_ID,
  );

  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.body, {
    error: "Artist has not been indexed in the album catalog yet",
  });
  assert.equal(albumFindCalls.length, 1);
  assert.equal(albumFindManyCalls.length, 0);
  assert.equal(resolverCalls.length, 0);
  assert.equal(neighborhoodCalls.length, 0);
});

test("GET collaboration albums returns an honest partial empty response", async () => {
  catalogAlbum = indexedAlbum();

  const response = await callCollaborationsRoute(
    PRIMARY_SPOTIFY_ID,
    FEATURED_SPOTIFY_ID,
    { limit: "6" },
  );

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, {
    seed: { spotifyId: PRIMARY_SPOTIFY_ID },
    collaborator: { spotifyId: FEATURED_SPOTIFY_ID },
    albums: [],
    total: 0,
    hasMore: false,
    coverage: {
      status: "partial",
      sources: ["album_catalog"],
      externalLookupAttempted: false,
    },
  });
});

test("GET collaboration albums translates candidate catalog failures to 503", async () => {
  catalogAlbum = indexedAlbum();
  albumFindManyError = new Error("Mongo unavailable");
  const originalConsoleError = console.error;
  console.error = () => {};

  try {
    const response = await callCollaborationsRoute(
      PRIMARY_SPOTIFY_ID,
      FEATURED_SPOTIFY_ID,
    );

    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.body, {
      error: "Artist catalog is temporarily unavailable",
    });
    assert.equal(resolverCalls.length, 0);
    assert.equal(neighborhoodCalls.length, 0);
    assert.equal(artistFindCalls.length, 0);
  } finally {
    console.error = originalConsoleError;
  }
});

test("GET collaboration albums translates seed catalog failures to 503", async () => {
  albumFindError = new Error("Mongo unavailable");
  const originalConsoleError = console.error;
  console.error = () => {};

  try {
    const response = await callCollaborationsRoute(
      PRIMARY_SPOTIFY_ID,
      FEATURED_SPOTIFY_ID,
    );

    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.body, {
      error: "Artist catalog is temporarily unavailable",
    });
    assert.equal(albumFindManyCalls.length, 0);
    assert.equal(resolverCalls.length, 0);
    assert.equal(neighborhoodCalls.length, 0);
    assert.equal(artistFindCalls.length, 0);
  } finally {
    console.error = originalConsoleError;
  }
});
