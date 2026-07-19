const AlbumCatalog = require("../../models/AlbumCatalog");
const { ALBUM_DETAIL_METADATA_VERSION } = require("./albumCatalog");

const ALBUM_CATALOG_SOURCE = "album_catalog";

function asPlainObject(value) {
  return typeof value?.toObject === "function" ? value.toObject() : value;
}

function hasArtistReference(artistRefs, spotifyArtistId) {
  return (Array.isArray(artistRefs) ? artistRefs : []).some(
    (artist) => String(artist?.spotifyId || "") === spotifyArtistId,
  );
}

function hasArtistPair(artistRefs, seedSpotifyId, collaboratorSpotifyId) {
  return hasArtistReference(artistRefs, seedSpotifyId)
    && hasArtistReference(artistRefs, collaboratorSpotifyId);
}

function normalizeSharedTrack(track) {
  const source = asPlainObject(track) || {};

  return {
    spotifyId: String(source.spotifyId || ""),
    title: String(source.title || ""),
    trackNumber: Number(source.trackNumber || 0),
    discNumber: Number(source.discNumber || 1),
    spotifyUrl: String(source.spotifyUrl || ""),
  };
}

function sharedTrackIdentity(track) {
  if (track.spotifyId) {
    return `spotify:${track.spotifyId}`;
  }

  return [
    "track",
    track.discNumber,
    track.trackNumber,
    track.title.toLowerCase(),
  ].join(":");
}

function sortSharedTracks(left, right) {
  return left.discNumber - right.discNumber
    || left.trackNumber - right.trackNumber
    || left.title.localeCompare(right.title, "en", { sensitivity: "base" })
    || left.spotifyId.localeCompare(right.spotifyId);
}

function deriveCollaborationAlbum(album, seedSpotifyId, collaboratorSpotifyId) {
  const source = asPlainObject(album) || {};
  const spotifyId = String(source.spotifyId || "").trim();

  if (!spotifyId) {
    return null;
  }

  const hasAlbumCredit = hasArtistPair(
    source.artistRefs,
    seedSpotifyId,
    collaboratorSpotifyId,
  );
  const hasCurrentTrackDetails = Number(source.detailMetadataVersion || 0)
    >= ALBUM_DETAIL_METADATA_VERSION;
  const sharedTracks = hasCurrentTrackDetails
    ? (Array.isArray(source.tracks) ? source.tracks : [])
      .filter((track) => hasArtistPair(
        track?.artistRefs,
        seedSpotifyId,
        collaboratorSpotifyId,
      ))
      .map(normalizeSharedTrack)
    : [];

  if (!hasAlbumCredit && sharedTracks.length === 0) {
    return null;
  }

  const evidenceTypes = [];

  if (hasAlbumCredit) {
    evidenceTypes.push("album_credit");
  }

  if (sharedTracks.length > 0) {
    evidenceTypes.push("same_track");
  }

  return {
    spotifyId,
    title: String(source.title || ""),
    artist: String(source.artist || ""),
    artists: Array.isArray(source.artists) ? source.artists.map(String) : [],
    cover: source.cover || source.imgs?.[0]?.url || null,
    year: String(source.year || "unknown"),
    releaseDate: String(source.releaseDate || ""),
    albumType: String(source.albumType || "album"),
    spotifyUrl: String(
      source.spotifyUrl || `https://open.spotify.com/album/${spotifyId}`,
    ),
    evidenceTypes,
    sharedTracks: sharedTracks.sort(sortSharedTracks),
  };
}

function mergeCollaborationAlbums(existing, incoming) {
  const evidenceTypes = ["album_credit", "same_track"].filter(
    (type) => existing.evidenceTypes.includes(type) || incoming.evidenceTypes.includes(type),
  );
  const sharedTracksByIdentity = new Map();

  for (const track of [...existing.sharedTracks, ...incoming.sharedTracks]) {
    const identity = sharedTrackIdentity(track);

    if (!sharedTracksByIdentity.has(identity)) {
      sharedTracksByIdentity.set(identity, track);
    }
  }

  return {
    ...existing,
    title: existing.title || incoming.title,
    artist: existing.artist || incoming.artist,
    artists: existing.artists.length > 0 ? existing.artists : incoming.artists,
    cover: existing.cover || incoming.cover,
    year: existing.year !== "unknown" ? existing.year : incoming.year,
    releaseDate: existing.releaseDate || incoming.releaseDate,
    albumType: existing.albumType || incoming.albumType,
    spotifyUrl: existing.spotifyUrl || incoming.spotifyUrl,
    evidenceTypes,
    sharedTracks: [...sharedTracksByIdentity.values()].sort(sortSharedTracks),
  };
}

function getEvidenceRank(album) {
  const hasAlbumCredit = album.evidenceTypes.includes("album_credit");
  const hasSameTrack = album.evidenceTypes.includes("same_track");

  if (hasAlbumCredit && hasSameTrack) {
    return 0;
  }

  return hasAlbumCredit ? 1 : 2;
}

function getReleaseParts(album) {
  const releaseDate = String(album.releaseDate || "").trim();
  const match = /^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?/.exec(releaseDate);

  if (match) {
    return [Number(match[1]), Number(match[2] || 0), Number(match[3] || 0)];
  }

  const year = /^(\d{4})$/.exec(String(album.year || "").trim());
  return year ? [Number(year[1]), 0, 0] : [0, 0, 0];
}

function sortCollaborationAlbums(left, right) {
  const evidenceDifference = getEvidenceRank(left) - getEvidenceRank(right);

  if (evidenceDifference !== 0) {
    return evidenceDifference;
  }

  const leftRelease = getReleaseParts(left);
  const rightRelease = getReleaseParts(right);

  for (let index = 0; index < leftRelease.length; index += 1) {
    const releaseDifference = rightRelease[index] - leftRelease[index];

    if (releaseDifference !== 0) {
      return releaseDifference;
    }
  }

  return left.title.localeCompare(right.title, "en", { sensitivity: "base" })
    || left.title.localeCompare(right.title, "en")
    || left.spotifyId.localeCompare(right.spotifyId);
}

function deriveArtistCollaborations(albums, seedSpotifyId, collaboratorSpotifyId) {
  const albumsBySpotifyId = new Map();

  for (const album of Array.isArray(albums) ? albums : []) {
    const normalized = deriveCollaborationAlbum(
      album,
      seedSpotifyId,
      collaboratorSpotifyId,
    );

    if (!normalized) {
      continue;
    }

    const existing = albumsBySpotifyId.get(normalized.spotifyId);
    albumsBySpotifyId.set(
      normalized.spotifyId,
      existing ? mergeCollaborationAlbums(existing, normalized) : normalized,
    );
  }

  return [...albumsBySpotifyId.values()].sort(sortCollaborationAlbums);
}

function buildCollaborationAlbumQuery(seedSpotifyId, collaboratorSpotifyId) {
  const artistIds = [seedSpotifyId, collaboratorSpotifyId];

  return {
    $or: [
      {
        "artistRefs.spotifyId": { $all: artistIds },
      },
      {
        detailMetadataVersion: { $gte: ALBUM_DETAIL_METADATA_VERSION },
        tracks: {
          $elemMatch: {
            "artistRefs.spotifyId": { $all: artistIds },
          },
        },
      },
    ],
  };
}

function createAlbumCatalogCollaborationSource(AlbumCatalogModel = AlbumCatalog) {
  return {
    coverageSource: ALBUM_CATALOG_SOURCE,
    externalLookupAttempted: false,
    async findCandidateAlbums(seedSpotifyId, collaboratorSpotifyId) {
      const query = AlbumCatalogModel.find(
        buildCollaborationAlbumQuery(seedSpotifyId, collaboratorSpotifyId),
      );

      return typeof query?.lean === "function" ? query.lean() : query;
    },
  };
}

const defaultAlbumCatalogSource = createAlbumCatalogCollaborationSource();

async function getArtistCollaborations({
  seedSpotifyId,
  collaboratorSpotifyId,
  limit,
  source = defaultAlbumCatalogSource,
}) {
  const candidates = await source.findCandidateAlbums(
    seedSpotifyId,
    collaboratorSpotifyId,
  );
  const allAlbums = deriveArtistCollaborations(
    candidates,
    seedSpotifyId,
    collaboratorSpotifyId,
  );
  const albums = allAlbums.slice(0, limit);

  return {
    seed: { spotifyId: seedSpotifyId },
    collaborator: { spotifyId: collaboratorSpotifyId },
    albums,
    total: allAlbums.length,
    hasMore: allAlbums.length > albums.length,
    coverage: {
      status: "partial",
      sources: [source.coverageSource || ALBUM_CATALOG_SOURCE],
      externalLookupAttempted: Boolean(source.externalLookupAttempted),
    },
  };
}

module.exports = {
  ALBUM_CATALOG_SOURCE,
  buildCollaborationAlbumQuery,
  createAlbumCatalogCollaborationSource,
  deriveArtistCollaborations,
  deriveCollaborationAlbum,
  getArtistCollaborations,
  sortCollaborationAlbums,
};
