const express = require("express");
const AlbumCatalog = require("../models/AlbumCatalog");
const ArtistCatalog = require("../models/ArtistCatalog");
const { getArtistCollaborations } = require("./utils/artistCollaborations");
const {
  ListenBrainzBackoffError,
  ListenBrainzBusyError,
  getOrCreateArtistNeighborhood,
} = require("./utils/listenBrainz");
const { getOrResolveArtist } = require("./utils/musicBrainz");
const { relatedArtistRateLimit } = require("./utils/rateLimit");

const router = express.Router();
const SPOTIFY_ARTIST_ID_PATTERN = /^[A-Za-z0-9]{22}$/;
const DEFAULT_SIMILAR_ARTIST_LIMIT = 12;
const MAX_SIMILAR_ARTIST_LIMIT = 50;
const DEFAULT_COLLABORATION_ALBUM_LIMIT = 3;
const MAX_COLLABORATION_ALBUM_LIMIT = 6;

function getAlbumArtistReference(album, spotifyArtistId) {
  const source = typeof album?.toObject === "function" ? album.toObject() : album;
  const artistReferences = [
    ...(source?.artistRefs || []),
    ...(source?.tracks || []).flatMap((track) => track.artistRefs || []),
  ];

  return artistReferences.find((artist) => artist.spotifyId === spotifyArtistId) || null;
}

function parseSimilarArtistLimit(value) {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_SIMILAR_ARTIST_LIMIT;
  }

  if (!/^\d+$/.test(String(value))) {
    return null;
  }

  const parsedLimit = Number.parseInt(value, 10);
  return parsedLimit >= 1 && parsedLimit <= MAX_SIMILAR_ARTIST_LIMIT
    ? parsedLimit
    : null;
}

function parseCollaborationAlbumLimit(value) {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_COLLABORATION_ALBUM_LIMIT;
  }

  if (!/^\d+$/.test(String(value))) {
    return null;
  }

  const parsedLimit = Number.parseInt(value, 10);
  return parsedLimit >= 1 && parsedLimit <= MAX_COLLABORATION_ALBUM_LIMIT
    ? parsedLimit
    : null;
}

function isValidSpotifyArtistId(spotifyArtistId) {
  return SPOTIFY_ARTIST_ID_PATTERN.test(spotifyArtistId);
}

async function findIndexedArtistReference(spotifyArtistId) {
  const catalogAlbum = await AlbumCatalog.findOne({
    $or: [
      { "artistRefs.spotifyId": spotifyArtistId },
      { "tracks.artistRefs.spotifyId": spotifyArtistId },
    ],
  });

  return getAlbumArtistReference(catalogAlbum, spotifyArtistId);
}

function normalizeSpotifyMapping(artist) {
  const source = typeof artist?.toObject === "function" ? artist.toObject() : artist;

  return {
    spotifyId: source.spotifyId,
    name: source.name || source.musicBrainzName || "",
    spotifyUrl: source.spotifyUrl || "",
  };
}

async function hydrateSpotifyMappings(neighbors) {
  const musicBrainzIds = neighbors.map((neighbor) => neighbor.musicBrainzId);

  if (musicBrainzIds.length === 0) {
    return neighbors.map((neighbor) => ({ ...neighbor, spotifyArtists: [] }));
  }

  const mappedArtists = await ArtistCatalog.find({
    musicBrainzId: { $in: musicBrainzIds },
    mappingStatus: "resolved",
  });
  const mappingsByMusicBrainzId = new Map();

  for (const artist of mappedArtists) {
    const musicBrainzId = String(artist.musicBrainzId || "");
    const existingMappings = mappingsByMusicBrainzId.get(musicBrainzId) || [];

    existingMappings.push(normalizeSpotifyMapping(artist));
    mappingsByMusicBrainzId.set(musicBrainzId, existingMappings);
  }

  for (const mappings of mappingsByMusicBrainzId.values()) {
    mappings.sort((left, right) => left.spotifyId.localeCompare(right.spotifyId));
  }

  return neighbors.map((neighbor) => ({
    ...neighbor,
    spotifyArtists: mappingsByMusicBrainzId.get(neighbor.musicBrainzId) || [],
  }));
}

router.get(
  "/artists/:seedSpotifyId/collaborations/:collaboratorSpotifyId",
  async (req, res) => {
    const seedSpotifyId = String(req.params.seedSpotifyId || "").trim();
    const collaboratorSpotifyId = String(
      req.params.collaboratorSpotifyId || "",
    ).trim();
    const limit = parseCollaborationAlbumLimit(req.query.limit);

    if (!isValidSpotifyArtistId(seedSpotifyId)) {
      return res.status(400).json({
        error: "A valid seed Spotify artist id is required",
      });
    }

    if (!isValidSpotifyArtistId(collaboratorSpotifyId)) {
      return res.status(400).json({
        error: "A valid collaborator Spotify artist id is required",
      });
    }

    if (seedSpotifyId === collaboratorSpotifyId) {
      return res.status(400).json({
        error: "Seed and collaborator Spotify artist ids must be different",
      });
    }

    if (limit === null) {
      return res.status(400).json({
        error: `limit must be an integer between 1 and ${MAX_COLLABORATION_ALBUM_LIMIT}`,
      });
    }

    let seedArtistReference;

    try {
      seedArtistReference = await findIndexedArtistReference(seedSpotifyId);
    } catch (error) {
      console.error(
        `Artist catalog lookup failed for ${seedSpotifyId}:`,
        error.message,
      );
      return res.status(503).json({
        error: "Artist catalog is temporarily unavailable",
      });
    }

    if (!seedArtistReference) {
      return res.status(404).json({
        error: "Artist has not been indexed in the album catalog yet",
      });
    }

    try {
      const result = await getArtistCollaborations({
        seedSpotifyId,
        collaboratorSpotifyId,
        limit,
      });

      return res.json(result);
    } catch (error) {
      console.error(
        `Collaboration catalog lookup failed for ${seedSpotifyId} and ${collaboratorSpotifyId}:`,
        error.message,
      );
      return res.status(503).json({
        error: "Artist catalog is temporarily unavailable",
      });
    }
  },
);

router.get("/artists/:spotifyArtistId", async (req, res) => {
  const spotifyArtistId = String(req.params.spotifyArtistId || "").trim();

  if (!isValidSpotifyArtistId(spotifyArtistId)) {
    return res.status(400).json({ error: "A valid Spotify artist id is required" });
  }

  let artistReference;

  try {
    artistReference = await findIndexedArtistReference(spotifyArtistId);
  } catch (error) {
    console.error(`Artist catalog lookup failed for ${spotifyArtistId}:`, error.message);
    return res.status(503).json({
      error: "Artist catalog is temporarily unavailable",
    });
  }

  if (!artistReference) {
    return res.status(404).json({
      error: "Artist has not been indexed in the album catalog yet",
    });
  }

  try {
    const result = await getOrResolveArtist({
      spotifyId: spotifyArtistId,
      name: artistReference.name,
    });

    return res.json(result);
  } catch (error) {
    console.error(`MusicBrainz resolution failed for artist ${spotifyArtistId}:`, error.message);
    return res.status(502).json({
      error: "Unable to resolve artist metadata right now",
    });
  }
});

router.get("/artists/:spotifyArtistId/similar", relatedArtistRateLimit, async (req, res) => {
  const spotifyArtistId = String(req.params.spotifyArtistId || "").trim();
  const limit = parseSimilarArtistLimit(req.query.limit);

  if (!isValidSpotifyArtistId(spotifyArtistId)) {
    return res.status(400).json({ error: "A valid Spotify artist id is required" });
  }

  if (limit === null) {
    return res.status(400).json({
      error: `limit must be an integer between 1 and ${MAX_SIMILAR_ARTIST_LIMIT}`,
    });
  }

  let artistReference;

  try {
    artistReference = await findIndexedArtistReference(spotifyArtistId);
  } catch (error) {
    console.error(`Artist catalog lookup failed for ${spotifyArtistId}:`, error.message);
    return res.status(503).json({
      error: "Artist catalog is temporarily unavailable",
    });
  }

  if (!artistReference) {
    return res.status(404).json({
      error: "Artist has not been indexed in the album catalog yet",
    });
  }

  let identityResult;

  try {
    identityResult = await getOrResolveArtist({
      spotifyId: spotifyArtistId,
      name: artistReference.name,
    });
  } catch (error) {
    console.error(`MusicBrainz resolution failed for artist ${spotifyArtistId}:`, error.message);
    return res.status(502).json({
      error: "Unable to resolve artist metadata right now",
    });
  }

  const seedArtist = identityResult.artist;

  if (seedArtist?.mappingStatus !== "resolved" || !seedArtist.musicBrainzId) {
    return res.status(422).json({
      error: "No MusicBrainz mapping is available for this artist yet",
      code: "ARTIST_MBID_UNAVAILABLE",
    });
  }

  let neighborhoodResult;

  try {
    neighborhoodResult = await getOrCreateArtistNeighborhood(
      seedArtist.musicBrainzId,
    );
  } catch (error) {
    console.error(`Related artist lookup failed for ${spotifyArtistId}:`, error.message);

    if (
      error instanceof ListenBrainzBackoffError
      || error instanceof ListenBrainzBusyError
    ) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((error.retryAfterMs || 5000) / 1000),
      );

      res.set("Retry-After", String(retryAfterSeconds));
      return res.status(503).json({
        error: "Related artist lookups are temporarily busy",
        retryAfterSeconds,
      });
    }

    return res.status(502).json({
      error: "Unable to load related artists right now",
    });
  }

  const neighborhood = neighborhoodResult.neighborhood;

  if (!Array.isArray(neighborhood?.neighbors)) {
    console.error(`Related artist cache returned invalid neighbors for ${spotifyArtistId}`);
    return res.status(500).json({
      error: "Related artist data is invalid",
    });
  }

  const limitedNeighbors = neighborhood.neighbors.slice(0, limit);
  let neighbors = limitedNeighbors.map((neighbor) => ({
    ...neighbor,
    spotifyArtists: [],
  }));
  let spotifyMappingStatus = "complete";

  try {
    neighbors = await hydrateSpotifyMappings(limitedNeighbors);
  } catch (error) {
    spotifyMappingStatus = "unavailable";
    console.error(`Spotify artist hydration failed for ${spotifyArtistId}:`, error.message);
  }

  return res.json({
    seed: {
      spotifyId: seedArtist.spotifyId,
      spotifyUrl: seedArtist.spotifyUrl,
      musicBrainzId: seedArtist.musicBrainzId,
      name: seedArtist.name || seedArtist.musicBrainzName || artistReference.name,
    },
    neighbors,
    source: neighborhood.source,
    algorithm: neighborhood.algorithm,
    cacheStatus: neighborhoodResult.cacheStatus,
    identityCacheStatus: identityResult.cacheStatus,
    spotifyMappingStatus,
    fetchedAt: neighborhood.fetchedAt,
    expiresAt: neighborhood.expiresAt,
  });
});

module.exports = router;
module.exports.getAlbumArtistReference = getAlbumArtistReference;
module.exports.hydrateSpotifyMappings = hydrateSpotifyMappings;
module.exports.parseCollaborationAlbumLimit = parseCollaborationAlbumLimit;
module.exports.parseSimilarArtistLimit = parseSimilarArtistLimit;
