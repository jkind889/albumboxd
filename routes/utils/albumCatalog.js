const AlbumCatalog = require("../../models/AlbumCatalog");
const { getSpotifyAccessToken } = require("./spotify");
const { consumeSpotifyRateLimit } = require("./rateLimit");

const ALBUM_DETAIL_METADATA_VERSION = 2;

function normalizeSpotifyArtistRefs(artists) {
  const normalizedArtists = [];
  const seenArtists = new Set();

  for (const artist of Array.isArray(artists) ? artists : []) {
    const name = String(artist?.name || "").trim();
    const spotifyId = String(artist?.id || "").trim();

    if (!name) {
      continue;
    }

    const identityKey = spotifyId || name.toLowerCase();

    if (seenArtists.has(identityKey)) {
      continue;
    }

    seenArtists.add(identityKey);
    normalizedArtists.push({
      spotifyId,
      name,
      spotifyUrl: artist?.external_urls?.spotify || "",
    });
  }

  return normalizedArtists;
}

// Search results contain summary metadata but not the tracks/detail enrichment.
function normalizeSpotifyAlbumSummary(data) {
  return {
    spotifyId: data.id,
    title: data.name,
    artist: data.artists?.[0]?.name || "Unknown Artist",
    artists: data.artists?.map((artist) => artist.name) || [],
    artistRefs: normalizeSpotifyArtistRefs(data.artists),
    year: data.release_date?.slice(0, 4) || "unknown",
    releaseDate: data.release_date || "",
    imgs: data.images || [],
    cover: data.images?.[0]?.url || null,
    totalTracks: data.total_tracks || 0,
    albumType: data.album_type || "album",
    spotifyUrl: data.external_urls?.spotify || "",
  };
}

// Full album payloads enrich the cached summary when album details are requested.
function normalizeSpotifyAlbum(data) {
  return {
    ...normalizeSpotifyAlbumSummary(data),
    detailMetadataVersion: ALBUM_DETAIL_METADATA_VERSION,
    genres: data.genres || [],
    tracks: data.tracks?.items?.map((track) => ({
      spotifyId: track.id || "",
      trackNumber: track.track_number || 0,
      discNumber: track.disc_number || 1,
      title: track.name || "",
      durationMs: track.duration_ms || 0,
      spotifyUrl: track.external_urls?.spotify || "",
      artistRefs: normalizeSpotifyArtistRefs(track.artists),
    })) || [],
    label: data.label || "",
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
    artistRefs: source.artistRefs || [],
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

function hasCurrentAlbumDetails(album) {
  return Boolean(
    album?.tracks?.length
      && Number(album.detailMetadataVersion || 0) >= ALBUM_DETAIL_METADATA_VERSION,
  );
}

// Search dropdown/results only need a smaller album summary.
function toSearchResult(album) {
  const normalized = normalizeCatalogAlbum(album);

  return {
    id: normalized.spotifyId,
    title: normalized.title,
    artist: normalized.artist,
    artistId: normalized.artistRefs[0]?.spotifyId || "",
    artistRefs: normalized.artistRefs,
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

  if (hasCurrentAlbumDetails(cachedAlbum)) {
    return cachedAlbum;
  }

  const spotifyAlbum = await fetchSpotifyAlbum(spotifyId, options);
  return upsertAlbumCatalog(normalizeSpotifyAlbum(spotifyAlbum));
}

// Album detail reads can degrade to cached metadata when Spotify enrichment fails.
async function getAlbumCatalogDetails(spotifyId, options = {}) {
  const cachedAlbum = await AlbumCatalog.findOne({ spotifyId });

  if (hasCurrentAlbumDetails(cachedAlbum)) {
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
  ALBUM_DETAIL_METADATA_VERSION,
  fetchSpotifyAlbum,
  getAlbumCatalogDetails,
  getOrCreateAlbumCatalog,
  hasCurrentAlbumDetails,
  normalizeCatalogAlbum,
  normalizeSpotifyArtistRefs,
  normalizeSpotifyAlbum,
  normalizeSpotifyAlbumSummary,
  toSearchResult,
  upsertAlbumCatalog,
};
