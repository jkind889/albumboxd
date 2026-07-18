const assert = require("node:assert/strict");
const test = require("node:test");

const graphModule = import("../frontend/src/utils/relatedArtistGraph.js");
const artistReferencesModule = import("../frontend/src/utils/artistReferences.js");

const SEED_SPOTIFY_ID = "1234567890123456789012";
const NEIGHBOR_SPOTIFY_ID = "abcdefghijklmnopqrstuv";

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
  const { buildRelatedArtistGraph } = await graphModule;
  const graph = buildRelatedArtistGraph(makePayload([
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
  ]));

  assert.equal(graph.nodes[1].id, `artist:spotify:${NEIGHBOR_SPOTIFY_ID}`);
  assert.equal(graph.nodes[2].id, "artist:mbid:00000000-0000-0000-0000-000000000003");
  assert.equal(graph.nodes[2].data.spotifyId, "");
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
