const assert = require("node:assert/strict");
const test = require("node:test");

const graphModule = import("../frontend/src/utils/relatedArtistGraph.js");
const artistReferencesModule = import("../frontend/src/utils/artistReferences.js");

const SEED_SPOTIFY_ID = "1234567890123456789012";
const NEIGHBOR_SPOTIFY_ID = "abcdefghijklmnopqrstuv";
const ALBUM_SPOTIFY_ID = "albumalbumalbumalbumal";

function makeMappedNeighbor(overrides = {}) {
  return {
    musicBrainzId: "00000000-0000-0000-0000-000000000002",
    name: "Mapped Artist",
    rank: 1,
    weight: 0.9,
    spotifyArtists: [{ spotifyId: NEIGHBOR_SPOTIFY_ID, name: "Mapped Artist" }],
    ...overrides,
  };
}

function makePayload(neighbors) {
  return {
    seed: {
      spotifyId: SEED_SPOTIFY_ID,
      spotifyUrl: `https://open.spotify.com/artist/${SEED_SPOTIFY_ID}`,
      musicBrainzId: "00000000-0000-0000-0000-000000000001",
      name: "Seed Artist",
    },
    neighbors,
  };
}

test("related artist graph uses stable Spotify and MBID identities", async () => {
  const { buildRelatedArtistGraph } = await graphModule;
  const graph = buildRelatedArtistGraph(makePayload([
    {
      musicBrainzId: "00000000-0000-0000-0000-000000000002",
      name: "Mapped Artist",
      rank: 1,
      weight: 0.9,
      spotifyArtists: [{ spotifyId: NEIGHBOR_SPOTIFY_ID, name: "Mapped Artist" }],
    },
    {
      musicBrainzId: "00000000-0000-0000-0000-000000000003",
      name: "MBID Artist",
      rank: 2,
      weight: 0.4,
      spotifyArtists: [],
    },
  ]));

  assert.deepEqual(graph.nodes.map((node) => node.id), [
    `artist:spotify:${SEED_SPOTIFY_ID}`,
    `artist:spotify:${NEIGHBOR_SPOTIFY_ID}`,
    "artist:mbid:00000000-0000-0000-0000-000000000003",
  ]);
  assert.equal(graph.edges.length, 2);
  assert.equal(graph.edges[0].source, `artist:spotify:${SEED_SPOTIFY_ID}`);
  assert.equal(graph.edges[0].target, `artist:spotify:${NEIGHBOR_SPOTIFY_ID}`);
});

test("related artist graph clamps edge strength and remains deterministic", async () => {
  const { buildRelatedArtistGraph } = await graphModule;
  const payload = makePayload([
    {
      musicBrainzId: "00000000-0000-0000-0000-000000000003",
      name: "Third",
      rank: 3,
      weight: -3,
    },
    {
      musicBrainzId: "00000000-0000-0000-0000-000000000002",
      name: "First",
      rank: 1,
      weight: 8,
    },
  ]);
  const firstGraph = buildRelatedArtistGraph(payload, { compact: true });
  const secondGraph = buildRelatedArtistGraph(payload, { compact: true });

  assert.deepEqual(firstGraph, secondGraph);
  assert.equal(firstGraph.nodes[1].data.label, "First");
  assert.equal(firstGraph.nodes[1].data.weight, 1);
  assert.equal(firstGraph.edges[0].style.strokeWidth, 3.75);
  assert.equal(firstGraph.nodes[2].data.weight, 0);
  assert.equal(firstGraph.edges[1].style.opacity, 0.25);

  for (const node of firstGraph.nodes) {
    assert.equal(Number.isFinite(node.position.x), true);
    assert.equal(Number.isFinite(node.position.y), true);
  }
});

test("desktop radial layout keeps neighboring artist cards from overlapping", async () => {
  const { buildRelatedArtistGraph } = await graphModule;
  const neighbors = Array.from({ length: 12 }, (_, index) => ({
    musicBrainzId: `20000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    name: `Neighbor ${index + 1}`,
    rank: index + 1,
    weight: 1 - (index * 0.05),
  }));
  const graph = buildRelatedArtistGraph(makePayload(neighbors));
  const neighborNodes = graph.nodes.slice(1);

  for (let leftIndex = 0; leftIndex < neighborNodes.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < neighborNodes.length; rightIndex += 1) {
      const left = neighborNodes[leftIndex];
      const right = neighborNodes[rightIndex];
      const overlapsHorizontally = Math.abs(left.position.x - right.position.x) < 190;
      const overlapsVertically = Math.abs(left.position.y - right.position.y) < 112;

      assert.equal(
        overlapsHorizontally && overlapsVertically,
        false,
        `${left.data.label} overlaps ${right.data.label}`,
      );
    }
  }
});

test("duplicate MBIDs keep the best-ranked neighbor", async () => {
  const { buildRelatedArtistGraph } = await graphModule;
  const musicBrainzId = "00000000-0000-0000-0000-000000000002";
  const graph = buildRelatedArtistGraph(makePayload([
    { musicBrainzId, name: "Later", rank: 7, weight: 0.7 },
    { musicBrainzId, name: "Best", rank: 2, weight: 0.5 },
  ]));

  assert.equal(graph.nodes.length, 2);
  assert.equal(graph.edges.length, 1);
  assert.equal(graph.nodes[1].data.label, "Best");
  assert.equal(graph.nodes[1].data.rank, 2);
});

test("a repeated Spotify mapping falls back to the neighbor MBID", async () => {
  const { buildRelatedArtistGraph, getRenderedMappedNeighbors } = await graphModule;
  const payload = makePayload([
    {
      musicBrainzId: "00000000-0000-0000-0000-000000000002",
      name: "First mapping",
      rank: 1,
      spotifyArtists: [{ spotifyId: NEIGHBOR_SPOTIFY_ID }],
    },
    {
      musicBrainzId: "00000000-0000-0000-0000-000000000003",
      name: "Conflicting mapping",
      rank: 2,
      spotifyArtists: [{ spotifyId: NEIGHBOR_SPOTIFY_ID }],
    },
  ]);
  const graph = buildRelatedArtistGraph(payload);
  const renderedMappedNeighbors = getRenderedMappedNeighbors(payload);

  assert.equal(graph.nodes[1].id, `artist:spotify:${NEIGHBOR_SPOTIFY_ID}`);
  assert.equal(graph.nodes[2].id, "artist:mbid:00000000-0000-0000-0000-000000000003");
  assert.equal(graph.nodes[2].data.spotifyId, "");
  assert.deepEqual(renderedMappedNeighbors, [{
    nodeId: `artist:spotify:${NEIGHBOR_SPOTIFY_ID}`,
    spotifyId: NEIGHBOR_SPOTIFY_ID,
    spotifyUrl: "",
    musicBrainzId: "00000000-0000-0000-0000-000000000002",
    name: "First mapping",
    rank: 1,
  }]);
});

test("desktop collaboration albums use stable nodes and exactly two credit edges", async () => {
  const { buildRelatedArtistGraph } = await graphModule;
  const graph = buildRelatedArtistGraph(makePayload([makeMappedNeighbor()]), {
    selectedSpotifyArtistId: NEIGHBOR_SPOTIFY_ID,
    collaborationAlbums: [{
      spotifyId: ALBUM_SPOTIFY_ID,
      title: "Shared Record",
      year: "2024",
      evidenceTypes: ["album_credit", "same_track"],
      sharedTracks: [{
        spotifyId: "tracktracktracktracktr",
        title: "Together",
        discNumber: 1,
        trackNumber: 2,
      }],
    }],
  });
  const albumNodeId = `album:spotify:${ALBUM_SPOTIFY_ID}`;
  const albumNode = graph.nodes.find((node) => node.id === albumNodeId);
  const creditEdges = graph.edges.filter((edge) => edge.data?.kind === "collaborationCredit");

  assert.equal(albumNode.type, "collaborationAlbumNode");
  assert.equal(albumNode.data.title, "Shared Record");
  assert.deepEqual(albumNode.data.evidenceTypes, ["album_credit", "same_track"]);
  assert.equal(creditEdges.length, 2);
  assert.deepEqual(creditEdges.map((edge) => edge.id), [
    `collaboration:seed:artist:spotify:${SEED_SPOTIFY_ID}:${albumNodeId}`,
    `collaboration:collaborator:artist:spotify:${NEIGHBOR_SPOTIFY_ID}:${albumNodeId}`,
  ]);
  assert.deepEqual(new Set(creditEdges.map((edge) => edge.source)), new Set([
    `artist:spotify:${SEED_SPOTIFY_ID}`,
    `artist:spotify:${NEIGHBOR_SPOTIFY_ID}`,
  ]));
  assert.equal(creditEdges.every((edge) => edge.target === albumNodeId), true);
  assert.equal(graph.nodes.find((node) => node.data.spotifyId === NEIGHBOR_SPOTIFY_ID).data.selected, true);
});

test("collaboration albums dedupe evidence and tracks before deterministic layout", async () => {
  const { buildRelatedArtistGraph } = await graphModule;
  const payload = makePayload([makeMappedNeighbor()]);
  const collaborationAlbums = [
    {
      spotifyId: ALBUM_SPOTIFY_ID,
      title: "Shared Record",
      evidenceTypes: ["album_credit"],
      sharedTracks: [{ spotifyId: "tracktracktracktracktr", title: "Together", trackNumber: 2 }],
    },
    {
      spotifyId: ALBUM_SPOTIFY_ID,
      title: "Duplicate Record",
      evidenceTypes: ["same_track", "album_credit"],
      sharedTracks: [
        { spotifyId: "tracktracktracktracktr", title: "Together", trackNumber: 2 },
        { spotifyId: "othertrackothertrackot", title: "Encore", trackNumber: 4 },
      ],
    },
  ];
  const options = {
    selectedSpotifyArtistId: NEIGHBOR_SPOTIFY_ID,
    collaborationAlbums,
  };
  const firstGraph = buildRelatedArtistGraph(payload, options);
  const secondGraph = buildRelatedArtistGraph(payload, options);
  const albumNodes = firstGraph.nodes.filter((node) => node.data.kind === "collaborationAlbum");

  assert.deepEqual(firstGraph, secondGraph);
  assert.equal(albumNodes.length, 1);
  assert.equal(albumNodes[0].data.title, "Shared Record");
  assert.deepEqual(albumNodes[0].data.evidenceTypes, ["album_credit", "same_track"]);
  assert.deepEqual(albumNodes[0].data.sharedTracks.map((track) => track.title), ["Together", "Encore"]);
  assert.equal(
    firstGraph.edges.filter((edge) => edge.data?.kind === "collaborationCredit").length,
    2,
  );
});

test("desktop collaboration fan is capped at three albums", async () => {
  const { buildRelatedArtistGraph } = await graphModule;
  const collaborationAlbums = Array.from({ length: 4 }, (_, index) => ({
    spotifyId: `albumalbumalbumalbum${String(index + 1).padStart(2, "0")}`,
    title: `Album ${index + 1}`,
    evidenceTypes: ["album_credit"],
  }));
  const graph = buildRelatedArtistGraph(makePayload([makeMappedNeighbor()]), {
    selectedSpotifyArtistId: NEIGHBOR_SPOTIFY_ID,
    collaborationAlbums,
  });

  assert.deepEqual(
    graph.nodes
      .filter((node) => node.data.kind === "collaborationAlbum")
      .map((node) => node.id),
    collaborationAlbums.slice(0, 3).map((album) => `album:spotify:${album.spotifyId}`),
  );
  assert.equal(
    graph.edges.filter((edge) => edge.data?.kind === "collaborationCredit").length,
    6,
  );
});

test("compact graph highlights selection without rendering album nodes or credit edges", async () => {
  const { buildRelatedArtistGraph } = await graphModule;
  const graph = buildRelatedArtistGraph(makePayload([makeMappedNeighbor()]), {
    compact: true,
    selectedSpotifyArtistId: NEIGHBOR_SPOTIFY_ID,
    collaborationAlbums: [{
      spotifyId: ALBUM_SPOTIFY_ID,
      title: "Shared Record",
      evidenceTypes: ["album_credit"],
    }],
  });

  assert.equal(graph.nodes.some((node) => node.data.kind === "collaborationAlbum"), false);
  assert.equal(graph.edges.some((edge) => edge.data?.kind === "collaborationCredit"), false);
  assert.equal(graph.nodes.find((node) => node.data.spotifyId === NEIGHBOR_SPOTIFY_ID).data.selected, true);
});

test("artist candidates dedupe album results and rank exact name matches first", async () => {
  const { getArtistCandidates } = await artistReferencesModule;
  const candidates = getArtistCandidates([
    {
      artist: "Guest Artist",
      cover: "first.jpg",
      artistRefs: [
        { spotifyId: "guestguestguestguestgu", name: "Guest Artist" },
        { spotifyId: SEED_SPOTIFY_ID, name: "Seed Artist" },
      ],
    },
    {
      artist: "Seed Artist",
      cover: "second.jpg",
      artistRefs: [{ spotifyId: SEED_SPOTIFY_ID, name: "Seed Artist" }],
    },
  ], "Seed Artist");

  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].spotifyId, SEED_SPOTIFY_ID);
  assert.equal(candidates[0].albumCount, 2);
  assert.equal(candidates[0].cover, "first.jpg");
});
