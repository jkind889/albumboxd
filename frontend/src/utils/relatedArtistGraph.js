const DESKTOP_LAYOUT = {
  centerX: 520,
  centerY: 380,
  radiusX: 420,
  radiusY: 320,
  nodeWidth: 190,
  nodeHeight: 112,
};

const COMPACT_LAYOUT = {
  centerX: 170,
  seedY: 30,
  leftX: 0,
  rightX: 180,
  firstRowY: 170,
  rowGap: 130,
  nodeWidth: 160,
};

function clampWeight(value) {
  const weight = Number(value);

  if (!Number.isFinite(weight)) {
    return 0;
  }

  return Math.min(Math.max(weight, 0), 1);
}

function getRank(value) {
  const rank = Number(value);
  return Number.isFinite(rank) && rank > 0 ? rank : Number.MAX_SAFE_INTEGER;
}

function getSpotifyMappings(neighbor) {
  return (Array.isArray(neighbor?.spotifyArtists) ? neighbor.spotifyArtists : [])
    .filter((artist) => String(artist?.spotifyId || "").trim())
    .toSorted((left, right) => String(left.spotifyId).localeCompare(String(right.spotifyId)));
}

function getNodeHandles(angle) {
  const horizontal = Math.abs(Math.cos(angle)) >= Math.abs(Math.sin(angle));

  if (horizontal) {
    return Math.cos(angle) >= 0
      ? { sourceHandle: "source-right", targetHandle: "target-left" }
      : { sourceHandle: "source-left", targetHandle: "target-right" };
  }

  return Math.sin(angle) >= 0
    ? { sourceHandle: "source-bottom", targetHandle: "target-top" }
    : { sourceHandle: "source-top", targetHandle: "target-bottom" };
}

function dedupeNeighbors(neighbors) {
  const neighborsByMusicBrainzId = new Map();

  for (const neighbor of Array.isArray(neighbors) ? neighbors : []) {
    const musicBrainzId = String(neighbor?.musicBrainzId || "").trim();

    if (!musicBrainzId) {
      continue;
    }

    const existingNeighbor = neighborsByMusicBrainzId.get(musicBrainzId);

    if (
      !existingNeighbor
      || getRank(neighbor.rank) < getRank(existingNeighbor.rank)
      || (
        getRank(neighbor.rank) === getRank(existingNeighbor.rank)
        && clampWeight(neighbor.weight) > clampWeight(existingNeighbor.weight)
      )
    ) {
      neighborsByMusicBrainzId.set(musicBrainzId, neighbor);
    }
  }

  return [...neighborsByMusicBrainzId.values()].sort((left, right) => {
    const rankDifference = getRank(left.rank) - getRank(right.rank);

    if (rankDifference !== 0) {
      return rankDifference;
    }

    return String(left.musicBrainzId).localeCompare(String(right.musicBrainzId));
  });
}

function getSeedNodeId(seed) {
  const spotifyId = String(seed?.spotifyId || "").trim();
  const musicBrainzId = String(seed?.musicBrainzId || "").trim();

  return spotifyId
    ? `artist:spotify:${spotifyId}`
    : `artist:mbid:${musicBrainzId || "seed"}`;
}

function getNeighborNodeId(neighbor, usedSpotifyIds) {
  const mappings = getSpotifyMappings(neighbor);
  const availableMapping = mappings.find((mapping) => !usedSpotifyIds.has(mapping.spotifyId));

  if (availableMapping) {
    usedSpotifyIds.add(availableMapping.spotifyId);
    return {
      nodeId: `artist:spotify:${availableMapping.spotifyId}`,
      spotifyArtist: availableMapping,
    };
  }

  return {
    nodeId: `artist:mbid:${neighbor.musicBrainzId}`,
    spotifyArtist: null,
  };
}

function getNeighborPosition(index, neighborCount, compact) {
  if (compact) {
    return {
      x: index % 2 === 0 ? COMPACT_LAYOUT.leftX : COMPACT_LAYOUT.rightX,
      y: COMPACT_LAYOUT.firstRowY + (Math.floor(index / 2) * COMPACT_LAYOUT.rowGap),
    };
  }

  const angle = (-Math.PI / 2) + ((Math.PI * 2 * index) / Math.max(neighborCount, 1));

  return {
    x: DESKTOP_LAYOUT.centerX
      + (Math.cos(angle) * DESKTOP_LAYOUT.radiusX)
      - (DESKTOP_LAYOUT.nodeWidth / 2),
    y: DESKTOP_LAYOUT.centerY
      + (Math.sin(angle) * DESKTOP_LAYOUT.radiusY)
      - (DESKTOP_LAYOUT.nodeHeight / 2),
  };
}

export function buildRelatedArtistGraph(payload, { compact = false } = {}) {
  const seed = payload?.seed || {};
  const seedId = getSeedNodeId(seed);
  const neighbors = dedupeNeighbors(payload?.neighbors);
  const seedSpotifyId = String(seed.spotifyId || "").trim();
  const usedSpotifyIds = new Set(seedSpotifyId ? [seedSpotifyId] : []);
  const seedPosition = compact
    ? {
        x: COMPACT_LAYOUT.centerX - (COMPACT_LAYOUT.nodeWidth / 2),
        y: COMPACT_LAYOUT.seedY,
      }
    : {
        x: DESKTOP_LAYOUT.centerX - (DESKTOP_LAYOUT.nodeWidth / 2),
        y: DESKTOP_LAYOUT.centerY - (DESKTOP_LAYOUT.nodeHeight / 2),
      };
  const nodes = [{
    id: seedId,
    type: "relatedArtistNode",
    position: seedPosition,
    data: {
      kind: "seed",
      label: String(seed.name || "Unknown artist"),
      musicBrainzId: String(seed.musicBrainzId || ""),
      spotifyId: seedSpotifyId,
      spotifyUrl: String(seed.spotifyUrl || ""),
      rank: null,
      weight: 1,
    },
  }];
  const edges = [];

  neighbors.forEach((neighbor, index) => {
    const { nodeId, spotifyArtist } = getNeighborNodeId(neighbor, usedSpotifyIds);
    const weight = clampWeight(neighbor.weight);
    const angle = compact
      ? (index % 2 === 0 ? Math.PI : 0)
      : (-Math.PI / 2) + ((Math.PI * 2 * index) / Math.max(neighbors.length, 1));
    const handles = getNodeHandles(angle);

    nodes.push({
      id: nodeId,
      type: "relatedArtistNode",
      position: getNeighborPosition(index, neighbors.length, compact),
      data: {
        kind: "neighbor",
        label: String(neighbor.name || "Unknown artist"),
        comment: String(neighbor.comment || ""),
        musicBrainzId: String(neighbor.musicBrainzId),
        spotifyId: String(spotifyArtist?.spotifyId || ""),
        spotifyUrl: String(spotifyArtist?.spotifyUrl || ""),
        rank: getRank(neighbor.rank) === Number.MAX_SAFE_INTEGER ? index + 1 : getRank(neighbor.rank),
        weight,
      },
    });

    edges.push({
      id: `related:${seedId}:${nodeId}`,
      source: seedId,
      target: nodeId,
      sourceHandle: handles.sourceHandle,
      targetHandle: handles.targetHandle,
      type: "straight",
      className: "explore-related-edge",
      style: {
        stroke: "#b391d1",
        strokeWidth: 1 + (2.75 * weight),
        opacity: 0.25 + (0.65 * weight),
      },
    });
  });

  return { nodes, edges };
}
