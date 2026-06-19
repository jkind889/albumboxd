const AlbumCatalog = require("../../models/AlbumCatalog");
const { getSpotifyAccessToken } = require("./spotify");
const { consumeSpotifyRateLimit } = require("./rateLimit");

// Converts raw Spotify album payloads into the fields AlbumBoxd stores in Mongo.
function normalizeSpotifyAlbum(data) {
  return {
    spotifyId: data.id,
    title: data.name,
    artist: data.artists?.[0]?.name || "Unknown Artist",
    artists: data.artists?.map((artist) => artist.name) || [],
    year: data.release_date?.slice(0, 4) || "unknown",
    releaseDate: data.release_date || "",
    genres: data.genres || [],
    imgs: data.images || [],
    cover: data.images?.[0]?.url || null,
    totalTracks: data.total_tracks || 0,
    tracks: data.tracks?.items?.map((track) => ({
      spotifyId: track.id || "",
      trackNumber: track.track_number || 0,
      discNumber: track.disc_number || 1,
      title: track.name || "",
      durationMs: track.duration_ms || 0,
      spotifyUrl: track.external_urls?.spotify || "",
    })) || [],
    label: data.label || "",
    albumType: data.album_type || "album",
    spotifyUrl: data.external_urls?.spotify || "",
  };
}

// Converts catalog documents into the album shape the frontend already expects.
function normalizeCatalogAlbum(album) {
  const source = typeof album.toObject === "function" ? album.toObject() : album;

  return {
    id: source.spotifyId,
    spotifyId: source.spotifyId,
    title: source.title,
    artist: source.artist,
    artists: source.artists || [],
    year: source.year || "unknown",
    releaseDate: source.releaseDate || "",
    genres: source.genres || [],
    imgs: source.imgs || [],
    cover: source.cover || source.imgs?.[0]?.url || null,
    totalTracks: source.totalTracks || 0,
    tracks: source.tracks || [],
    label: source.label || "",
    albumType: source.albumType || "album",
    spotifyUrl: source.spotifyUrl || "",
  };
}

// Search dropdown/results only need a smaller album summary.
function toSearchResult(album) {
  const normalized = normalizeCatalogAlbum(album);

  return {
    id: normalized.spotifyId,
    title: normalized.title,
    artist: normalized.artist,
    year: normalized.year,
    cover: normalized.cover,
  };
}

// Creates or refreshes a cached album while keeping spotifyId unique.
async function upsertAlbumCatalog(albumData) {
  return AlbumCatalog.findOneAndUpdate(
    { spotifyId: albumData.spotifyId },
    { $set: albumData },
    { returnDocument: "after", upsert: true, setDefaultsOnInsert: true },
  );
}

async function fetchSpotifyAlbum(spotifyId, options = {}) {
  if (options.rateLimitKey) {
    await consumeSpotifyRateLimit(options.rateLimitKey);
  }

  const token = await getSpotifyAccessToken();

  const response = await fetch(`https://api.spotify.com/v1/albums/${spotifyId}`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Spotify album fetch failed with status ${response.status}`);
  }

  return response.json();
}

// Reads from the catalog first and falls back to Spotify on cache miss.
async function getOrCreateAlbumCatalog(spotifyId, options = {}) {
  const cachedAlbum = await AlbumCatalog.findOne({ spotifyId });

  if (cachedAlbum && cachedAlbum.tracks?.length) {
    return cachedAlbum;
  }

  const spotifyAlbum = await fetchSpotifyAlbum(spotifyId, options);
  return upsertAlbumCatalog(normalizeSpotifyAlbum(spotifyAlbum));
}

// Album detail reads can degrade to cached metadata when Spotify enrichment fails.
async function getAlbumCatalogDetails(spotifyId, options = {}) {
  const cachedAlbum = await AlbumCatalog.findOne({ spotifyId });

  if (cachedAlbum?.tracks?.length) {
    return {
      album: cachedAlbum,
      isPartial: false,
    };
  }

  try {
    const spotifyAlbum = await fetchSpotifyAlbum(spotifyId, options);
    const album = await upsertAlbumCatalog(normalizeSpotifyAlbum(spotifyAlbum));

    return {
      album,
      isPartial: false,
    };
  } catch (error) {
    if (!cachedAlbum) {
      throw error;
    }

    return {
      album: cachedAlbum,
      isPartial: true,
      enrichmentError: error,
    };
  }
}

module.exports = {
  fetchSpotifyAlbum,
  getAlbumCatalogDetails,
  getOrCreateAlbumCatalog,
  normalizeCatalogAlbum,
  normalizeSpotifyAlbum,
  toSearchResult,
  upsertAlbumCatalog,
};
