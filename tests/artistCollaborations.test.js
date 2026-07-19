const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildCollaborationAlbumQuery,
  createAlbumCatalogCollaborationSource,
  deriveArtistCollaborations,
  getArtistCollaborations,
} = require("../routes/utils/artistCollaborations");

const SEED_SPOTIFY_ID = "1111111111111111111111";
const COLLABORATOR_SPOTIFY_ID = "2222222222222222222222";
const OTHER_SPOTIFY_ID = "3333333333333333333333";

function artistRef(spotifyId, name = spotifyId) {
  return { spotifyId, name };
}

function catalogAlbum(overrides = {}) {
  return {
    spotifyId: "aaaaaaaaaaaaaaaaaaaaaa",
    title: "Test Album",
    artist: "Test Artist",
    artists: ["Test Artist"],
    artistRefs: [],
    year: "2024",
    releaseDate: "2024-01-01",
    imgs: [],
    cover: null,
    detailMetadataVersion: 0,
    tracks: [],
    albumType: "album",
    spotifyUrl: "https://open.spotify.com/album/aaaaaaaaaaaaaaaaaaaaaa",
    ...overrides,
  };
}

function sharedTrack(overrides = {}) {
  return {
    spotifyId: "tttttttttttttttttttttt",
    title: "Together",
    trackNumber: 1,
    discNumber: 1,
    spotifyUrl: "https://open.spotify.com/track/tttttttttttttttttttttt",
    artistRefs: [
      artistRef(SEED_SPOTIFY_ID, "Seed"),
      artistRef(COLLABORATOR_SPOTIFY_ID, "Collaborator"),
    ],
    ...overrides,
  };
}

test("derives direct album and same-track evidence without treating a compilation as collaboration", () => {
  const albums = [
    catalogAlbum({
      spotifyId: "bothbothbothbothbothbo",
      title: "Both Types",
      artistRefs: [
        artistRef(SEED_SPOTIFY_ID),
        artistRef(COLLABORATOR_SPOTIFY_ID),
      ],
      detailMetadataVersion: 2,
      tracks: [sharedTrack()],
    }),
    catalogAlbum({
      spotifyId: "albumalbumalbumalbumal",
      title: "Album Credit",
      artistRefs: [
        artistRef(SEED_SPOTIFY_ID),
        artistRef(COLLABORATOR_SPOTIFY_ID),
      ],
    }),
    catalogAlbum({
      spotifyId: "tracktracktracktracktr",
      title: "Same Track",
      artistRefs: [artistRef(SEED_SPOTIFY_ID)],
      detailMetadataVersion: 2,
      tracks: [sharedTrack()],
    }),
    catalogAlbum({
      spotifyId: "compcompcompcompcompco",
      title: "Separate Compilation Tracks",
      detailMetadataVersion: 2,
      tracks: [
        sharedTrack({
          spotifyId: "seedseedseedseedseedse",
          artistRefs: [artistRef(SEED_SPOTIFY_ID)],
        }),
        sharedTrack({
          spotifyId: "collabcollabcollabcoll",
          artistRefs: [artistRef(COLLABORATOR_SPOTIFY_ID)],
        }),
      ],
    }),
    catalogAlbum({
      spotifyId: "oldoldoldoldoldoldoldo",
      title: "Stale Track Details",
      detailMetadataVersion: 1,
      tracks: [sharedTrack()],
    }),
  ];

  const result = deriveArtistCollaborations(
    albums,
    SEED_SPOTIFY_ID,
    COLLABORATOR_SPOTIFY_ID,
  );

  assert.deepEqual(
    result.map((album) => [album.spotifyId, album.evidenceTypes]),
    [
      ["bothbothbothbothbothbo", ["album_credit", "same_track"]],
      ["albumalbumalbumalbumal", ["album_credit"]],
      ["tracktracktracktracktr", ["same_track"]],
    ],
  );
  assert.deepEqual(result[0].sharedTracks, [{
    spotifyId: "tttttttttttttttttttttt",
    title: "Together",
    trackNumber: 1,
    discNumber: 1,
    spotifyUrl: "https://open.spotify.com/track/tttttttttttttttttttttt",
  }]);
});

test("summary-only album credits normalize local catalog metadata", () => {
  const [result] = deriveArtistCollaborations(
    [catalogAlbum({
      artistRefs: [
        artistRef(SEED_SPOTIFY_ID),
        artistRef(COLLABORATOR_SPOTIFY_ID),
      ],
      title: "Summary Credit",
      artist: "Seed & Collaborator",
      artists: ["Seed", "Collaborator"],
      year: "2022",
      releaseDate: "2022-09",
      imgs: [{ url: "https://images.example/cover.jpg" }],
      cover: null,
      albumType: "single",
      spotifyUrl: "",
    })],
    SEED_SPOTIFY_ID,
    COLLABORATOR_SPOTIFY_ID,
  );

  assert.deepEqual(result, {
    spotifyId: "aaaaaaaaaaaaaaaaaaaaaa",
    title: "Summary Credit",
    artist: "Seed & Collaborator",
    artists: ["Seed", "Collaborator"],
    cover: "https://images.example/cover.jpg",
    year: "2022",
    releaseDate: "2022-09",
    albumType: "single",
    spotifyUrl: "https://open.spotify.com/album/aaaaaaaaaaaaaaaaaaaaaa",
    evidenceTypes: ["album_credit"],
    sharedTracks: [],
  });
});

test("deduplicates albums and tracks before deterministic ordering and pagination", async () => {
  const duplicateSpotifyId = "duplicateduplicatedupl";
  const albums = [
    catalogAlbum({
      spotifyId: "trackonlytrackonlytrac",
      title: "Newest Track Credit",
      releaseDate: "2026-01-01",
      detailMetadataVersion: 2,
      tracks: [sharedTrack()],
    }),
    catalogAlbum({
      spotifyId: "albumnewalbumnewalbumn",
      title: "Zulu Album Credit",
      releaseDate: "2025-05-01",
      artistRefs: [artistRef(SEED_SPOTIFY_ID), artistRef(COLLABORATOR_SPOTIFY_ID)],
    }),
    catalogAlbum({
      spotifyId: "albumoldalbumoldalbumo",
      title: "Alpha Album Credit",
      releaseDate: "2024-05-01",
      artistRefs: [artistRef(SEED_SPOTIFY_ID), artistRef(COLLABORATOR_SPOTIFY_ID)],
    }),
    catalogAlbum({
      spotifyId: duplicateSpotifyId,
      title: "Merged Evidence",
      releaseDate: "2018-01-01",
      artistRefs: [artistRef(SEED_SPOTIFY_ID), artistRef(COLLABORATOR_SPOTIFY_ID)],
    }),
    catalogAlbum({
      spotifyId: duplicateSpotifyId,
      title: "Merged Evidence",
      releaseDate: "2018-01-01",
      detailMetadataVersion: 2,
      tracks: [sharedTrack(), sharedTrack()],
    }),
  ];
  const source = {
    coverageSource: "album_catalog",
    externalLookupAttempted: false,
    async findCandidateAlbums() {
      return albums;
    },
  };

  const result = await getArtistCollaborations({
    seedSpotifyId: SEED_SPOTIFY_ID,
    collaboratorSpotifyId: COLLABORATOR_SPOTIFY_ID,
    limit: 3,
    source,
  });

  assert.deepEqual(result.albums.map((album) => album.spotifyId), [
    duplicateSpotifyId,
    "albumnewalbumnewalbumn",
    "albumoldalbumoldalbumo",
  ]);
  assert.deepEqual(result.albums[0].evidenceTypes, ["album_credit", "same_track"]);
  assert.equal(result.albums[0].sharedTracks.length, 1);
  assert.equal(result.total, 4);
  assert.equal(result.hasMore, true);
  assert.deepEqual(result.coverage, {
    status: "partial",
    sources: ["album_catalog"],
    externalLookupAttempted: false,
  });
});

test("album catalog source issues one local candidate query and uses lean results", async () => {
  const calls = [];
  let leanCalls = 0;
  const AlbumCatalogModel = {
    find(query) {
      calls.push(query);
      return {
        async lean() {
          leanCalls += 1;
          return [];
        },
      };
    },
  };
  const source = createAlbumCatalogCollaborationSource(AlbumCatalogModel);

  const result = await getArtistCollaborations({
    seedSpotifyId: SEED_SPOTIFY_ID,
    collaboratorSpotifyId: COLLABORATOR_SPOTIFY_ID,
    limit: 3,
    source,
  });

  assert.deepEqual(calls, [buildCollaborationAlbumQuery(
    SEED_SPOTIFY_ID,
    COLLABORATOR_SPOTIFY_ID,
  )]);
  assert.equal(leanCalls, 1);
  assert.deepEqual(result, {
    seed: { spotifyId: SEED_SPOTIFY_ID },
    collaborator: { spotifyId: COLLABORATOR_SPOTIFY_ID },
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

test("candidate query requires both artists inside one enriched track", () => {
  assert.deepEqual(
    buildCollaborationAlbumQuery(SEED_SPOTIFY_ID, COLLABORATOR_SPOTIFY_ID),
    {
      $or: [
        {
          "artistRefs.spotifyId": {
            $all: [SEED_SPOTIFY_ID, COLLABORATOR_SPOTIFY_ID],
          },
        },
        {
          detailMetadataVersion: { $gte: 2 },
          tracks: {
            $elemMatch: {
              "artistRefs.spotifyId": {
                $all: [SEED_SPOTIFY_ID, COLLABORATOR_SPOTIFY_ID],
              },
            },
          },
        },
      ],
    },
  );
});

test("catalog failures propagate for the route to translate to 503", async () => {
  const failure = new Error("Mongo unavailable");
  const source = {
    coverageSource: "album_catalog",
    externalLookupAttempted: false,
    async findCandidateAlbums() {
      throw failure;
    },
  };

  await assert.rejects(
    getArtistCollaborations({
      seedSpotifyId: SEED_SPOTIFY_ID,
      collaboratorSpotifyId: OTHER_SPOTIFY_ID,
      limit: 3,
      source,
    }),
    failure,
  );
});
