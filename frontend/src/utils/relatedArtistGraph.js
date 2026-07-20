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
  rowGap: 150,
  nodeWidth: 160,
};

const COLLABORATION_ALBUM_LAYOUT = {
  nodeWidth: 204,
  nodeHeight: 220,
  radius: 500,
};

const COLLABORATION_ALBUM_LIMIT = 3;
const EVIDENCE_TYPE_ORDER = ["album_credit", "same_track"];

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

function getTrackIdentity(track) {
  const spotifyId = String(track?.spotifyId || "").trim();

  if (spotifyId) {
    return `spotify:${spotifyId}`;
  }

  return [
    String(track?.discNumber || ""),
    String(track?.trackNumber || ""),
    String(track?.title || "").trim().toLowerCase(),
  ].join(":");
}

function normalizeEvidenceTypes(evidenceTypes) {
  const uniqueEvidenceTypes = new Set(
    (Array.isArray(evidenceTypes) ? evidenceTypes : [])
      .map((type) => String(type || "").trim())
      .filter(Boolean),
  );

  return [...uniqueEvidenceTypes].sort((left, right) => {
    const leftIndex = EVIDENCE_TYPE_ORDER.indexOf(left);
    const rightIndex = EVIDENCE_TYPE_ORDER.indexOf(right);

    if (leftIndex === -1 && rightIndex === -1) {
      return left.localeCompare(right);
    }

    if (leftIndex === -1) {
      return 1;
    }

    if (rightIndex === -1) {
      return -1;
    }

    return leftIndex - rightIndex;
  });
}

function dedupeSharedTracks(tracks) {
  const tracksByIdentity = new Map();

  for (const track of Array.isArray(tracks) ? tracks : []) {
    const trackIdentity = getTrackIdentity(track);

    if (!tracksByIdentity.has(trackIdentity)) {
      tracksByIdentity.set(trackIdentity, track);
    }
  }

  return [...tracksByIdentity.values()];
}

function normalizeCollaborationAlbum(album) {
  const spotifyId = String(album?.spotifyId || "").trim();

  if (!spotifyId) {
    return null;
  }

  const releaseDate = String(album?.releaseDate || "");
  return {
    spotifyId,
    title: String(album?.title || "Unknown album"),
    artist: String(album?.artist || ""),
    cover: String(album?.cover || ""),
    year: String(album?.year || releaseDate.slice(0, 4)),
    releaseDate,
    spotifyUrl: String(album?.spotifyUrl || `https://open.spotify.com/album/${spotifyId}`),
    evidenceTypes: normalizeEvidenceTypes(album?.evidenceTypes),
    sharedTracks: dedupeSharedTracks(album?.sharedTracks),
  };
}

function mergeCollaborationAlbums(existingAlbum, incomingAlbum) {
  return {
    ...existingAlbum,
    evidenceTypes: normalizeEvidenceTypes([
      ...existingAlbum.evidenceTypes,
      ...incomingAlbum.evidenceTypes,
    ]),
    sharedTracks: dedupeSharedTracks([
      ...existingAlbum.sharedTracks,
      ...incomingAlbum.sharedTracks,
    ]),
  };
}

function dedupeCollaborationAlbums(albums) {
  const albumsBySpotifyId = new Map();

  for (const album of Array.isArray(albums) ? albums : []) {
    const normalizedAlbum = normalizeCollaborationAlbum(album);

    if (!normalizedAlbum) {
      continue;
    }

    const existingAlbum = albumsBySpotifyId.get(normalizedAlbum.spotifyId);
    albumsBySpotifyId.set(
      normalizedAlbum.spotifyId,
      existingAlbum
        ? mergeCollaborationAlbums(existingAlbum, normalizedAlbum)
        : normalizedAlbum,
    );
  }

  return [...albumsBySpotifyId.values()].slice(0, COLLABORATION_ALBUM_LIMIT);
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

function resolveNeighbors(payload) {
  const seedSpotifyId = String(payload?.seed?.spotifyId || "").trim();
  const usedSpotifyIds = new Set(seedSpotifyId ? [seedSpotifyId] : []);

  return dedupeNeighbors(payload?.neighbors).map((neighbor, index) => {
    const { nodeId, spotifyArtist } = getNeighborNodeId(neighbor, usedSpotifyIds);

    return {
      index,
      neighbor,
      nodeId,
      spotifyArtist,
    };
  });
}

export function getRenderedMappedNeighbors(payload) {
  return resolveNeighbors(payload).flatMap(({ neighbor, nodeId, spotifyArtist, index }) => {
    if (!spotifyArtist?.spotifyId) {
      return [];
    }

    return [{
      nodeId,
      spotifyId: String(spotifyArtist.spotifyId),
      spotifyUrl: String(spotifyArtist.spotifyUrl || ""),
      musicBrainzId: String(neighbor.musicBrainzId || ""),
      name: String(neighbor.name || "Unknown artist"),
      rank: getRank(neighbor.rank) === Number.MAX_SAFE_INTEGER
        ? index + 1
        : getRank(neighbor.rank),
    }];
  });
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

function getAlbumFanOffsets(albumCount) {
  if (albumCount <= 1) {
    return [0];
  }

  if (albumCount === 2) {
    return [-0.38, 0.38];
  }

  return [-0.65, 0, 0.65];
}

function getNodeCenter(node) {
  const isAlbum = node.data.kind === "collaborationAlbum";
  const nodeWidth = isAlbum
    ? COLLABORATION_ALBUM_LAYOUT.nodeWidth
    : DESKTOP_LAYOUT.nodeWidth;
  const nodeHeight = isAlbum
    ? COLLABORATION_ALBUM_LAYOUT.nodeHeight
    : DESKTOP_LAYOUT.nodeHeight;

  return {
    x: node.position.x + (nodeWidth / 2),
    y: node.position.y + (nodeHeight / 2),
  };
}

function addCollaborationAlbums({
  nodes,
  edges,
  seedId,
  selectedArtistNode,
  collaborationAlbums,
}) {
  const albums = dedupeCollaborationAlbums(collaborationAlbums);

  if (!selectedArtistNode || albums.length === 0) {
    return;
  }

  const seedNode = nodes.find((node) => node.id === seedId);

  if (!seedNode) {
    return;
  }

  const seedCenter = getNodeCenter(seedNode);
  const selectedArtistCenter = getNodeCenter(selectedArtistNode);
  const outwardAngle = Math.atan2(
    selectedArtistCenter.y - DESKTOP_LAYOUT.centerY,
    selectedArtistCenter.x - DESKTOP_LAYOUT.centerX,
  );
  const fanOffsets = getAlbumFanOffsets(albums.length);

  albums.forEach((album, index) => {
    const albumNodeId = `album:spotify:${album.spotifyId}`;
    const albumAngle = outwardAngle + fanOffsets[index];
    const albumCenter = {
      x: selectedArtistCenter.x
        + (Math.cos(albumAngle) * COLLABORATION_ALBUM_LAYOUT.radius),
      y: selectedArtistCenter.y
        + (Math.sin(albumAngle) * COLLABORATION_ALBUM_LAYOUT.radius),
    };
    const albumNode = {
      id: albumNodeId,
      type: "collaborationAlbumNode",
      position: {
        x: albumCenter.x - (COLLABORATION_ALBUM_LAYOUT.nodeWidth / 2),
        y: albumCenter.y - (COLLABORATION_ALBUM_LAYOUT.nodeHeight / 2),
      },
      style: {
        width: COLLABORATION_ALBUM_LAYOUT.nodeWidth,
      },
      data: {
        kind: "collaborationAlbum",
        ...album,
      },
      zIndex: 2,
    };
    const seedToAlbumAngle = Math.atan2(
      albumCenter.y - seedCenter.y,
      albumCenter.x - seedCenter.x,
    );
    const collaboratorToAlbumAngle = Math.atan2(
      albumCenter.y - selectedArtistCenter.y,
      albumCenter.x - selectedArtistCenter.x,
    );
    const seedHandles = getNodeHandles(seedToAlbumAngle);
    const collaboratorHandles = getNodeHandles(collaboratorToAlbumAngle);

    nodes.push(albumNode);
    edges.push(
      {
        id: `collaboration:seed:${seedId}:${albumNodeId}`,
        source: seedId,
        target: albumNodeId,
        sourceHandle: seedHandles.sourceHandle,
        targetHandle: seedHandles.targetHandle,
        type: "straight",
        className: "explore-collaboration-edge explore-collaboration-edge-seed",
        style: {
          stroke: "#d6b56f",
          strokeWidth: 1.5,
          strokeDasharray: "6 5",
          opacity: 0.7,
        },
        data: {
          kind: "collaborationCredit",
          role: "seed",
          evidenceTypes: album.evidenceTypes,
        },
        zIndex: 1,
      },
      {
        id: `collaboration:collaborator:${selectedArtistNode.id}:${albumNodeId}`,
        source: selectedArtistNode.id,
        target: albumNodeId,
        sourceHandle: collaboratorHandles.sourceHandle,
        targetHandle: collaboratorHandles.targetHandle,
        type: "straight",
        className: "explore-collaboration-edge explore-collaboration-edge-collaborator",
        style: {
          stroke: "#f3d99a",
          strokeWidth: 2.4,
          opacity: 0.92,
        },
        data: {
          kind: "collaborationCredit",
          role: "collaborator",
          evidenceTypes: album.evidenceTypes,
        },
        zIndex: 1,
      },
    );
  });
}

export function buildRelatedArtistGraph(payload, {
  compact = false,
  selectedSpotifyArtistId = "",
  collaborationAlbums = [],
} = {}) {
  const seed = payload?.seed || {};
  const seedId = getSeedNodeId(seed);
  const resolvedNeighbors = resolveNeighbors(payload);
  const seedSpotifyId = String(seed.spotifyId || "").trim();
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
      selected: false,
    },
  }];
  const edges = [];

  resolvedNeighbors.forEach(({ neighbor, nodeId, spotifyArtist }, index) => {
    const weight = clampWeight(neighbor.weight);
    const angle = compact
      ? (index % 2 === 0 ? Math.PI : 0)
      : (-Math.PI / 2) + ((Math.PI * 2 * index) / Math.max(resolvedNeighbors.length, 1));
    const handles = getNodeHandles(angle);

    nodes.push({
      id: nodeId,
      type: "relatedArtistNode",
      position: getNeighborPosition(index, resolvedNeighbors.length, compact),
      data: {
        kind: "neighbor",
        label: String(neighbor.name || "Unknown artist"),
        comment: String(neighbor.comment || ""),
        musicBrainzId: String(neighbor.musicBrainzId),
        spotifyId: String(spotifyArtist?.spotifyId || ""),
        spotifyUrl: String(spotifyArtist?.spotifyUrl || ""),
        rank: getRank(neighbor.rank) === Number.MAX_SAFE_INTEGER ? index + 1 : getRank(neighbor.rank),
        weight,
        selected: Boolean(
          spotifyArtist?.spotifyId
          && spotifyArtist.spotifyId === selectedSpotifyArtistId,
        ),
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

  if (!compact) {
    const selectedArtistNode = nodes.find((node) => (
      node.data.kind === "neighbor"
      && node.data.spotifyId
      && node.data.spotifyId === selectedSpotifyArtistId
    ));

    addCollaborationAlbums({
      nodes,
      edges,
      seedId,
      selectedArtistNode,
      collaborationAlbums,
    });
  }

  return { nodes, edges };
}
