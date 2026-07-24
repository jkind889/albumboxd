const ArtistCatalog = require("../../models/ArtistCatalog");
const packageJson = require("../../package.json");

const MUSICBRAINZ_API_BASE_URL = "https://musicbrainz.org/ws/2";
const DEFAULT_MUSICBRAINZ_CONTACT = "https://github.com/jkind889/rescened";
const NOT_FOUND_MAPPING_TTL_MS = 24 * 60 * 60 * 1000;
const MUSICBRAINZ_REQUEST_INTERVAL_MS = 1100;
const MUSICBRAINZ_REQUEST_TIMEOUT_MS = 8000;
const MUSICBRAINZ_MAX_ATTEMPTS = 2;
const SPOTIFY_ARTIST_ID_PATTERN = /^[A-Za-z0-9]{22}$/;

let requestQueue = Promise.resolve();
let nextRequestAt = 0;
const inFlightArtistResolutions = new Map();

class MusicBrainzRequestError extends Error {
  constructor(status, retryAfter = "") {
    super(`MusicBrainz request failed with status ${status}`);
    this.name = "MusicBrainzRequestError";
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

class AmbiguousMusicBrainzMappingError extends Error {
  constructor(candidates) {
    super("Spotify artist URL maps to multiple active MusicBrainz artists");
    this.name = "AmbiguousMusicBrainzMappingError";
    this.candidates = candidates;
  }
}

class MusicBrainzTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`MusicBrainz request timed out after ${timeoutMs}ms`);
    this.name = "MusicBrainzTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

class MusicBrainzNetworkError extends Error {
  constructor(cause) {
    super("MusicBrainz request failed before receiving a response");
    this.name = "MusicBrainzNetworkError";
    this.cause = cause;
  }
}

function getMusicBrainzUserAgent(env = process.env) {
  const configuredUserAgent = String(env.MUSICBRAINZ_USER_AGENT || "").trim();

  if (configuredUserAgent) {
    return configuredUserAgent;
  }

  const contact = String(
    env.MUSICBRAINZ_CONTACT
      || env.FRONTEND_URL
      || DEFAULT_MUSICBRAINZ_CONTACT,
  ).trim();

  return `Rescened/${packageJson.version} (${contact})`;
}

function buildSpotifyArtistUrl(spotifyId) {
  const normalizedSpotifyId = String(spotifyId || "").trim();

  if (!normalizedSpotifyId) {
    throw new TypeError("Spotify artist id is required");
  }

  if (!SPOTIFY_ARTIST_ID_PATTERN.test(normalizedSpotifyId)) {
    throw new TypeError("Spotify artist id must be 22 alphanumeric characters");
  }

  return `https://open.spotify.com/artist/${normalizedSpotifyId}`;
}

function buildArtistUrlLookupUrl(spotifyUrl) {
  const url = new URL(`${MUSICBRAINZ_API_BASE_URL}/url`);

  url.searchParams.set("resource", spotifyUrl);
  url.searchParams.set("inc", "artist-rels");
  url.searchParams.set("fmt", "json");

  return url.toString();
}

function extractArtistCandidatesFromUrlLookup(payload) {
  const candidatesById = new Map();

  for (const relation of Array.isArray(payload?.relations) ? payload.relations : []) {
    if (
      relation?.["target-type"] !== "artist"
      || relation.ended === true
      || !relation.artist?.id
    ) {
      continue;
    }

    candidatesById.set(relation.artist.id, {
      musicBrainzId: relation.artist.id,
      name: relation.artist.name || "",
      sortName: relation.artist["sort-name"] || "",
      disambiguation: relation.artist.disambiguation || "",
      artistType: relation.artist.type || "",
      country: relation.artist.country || "",
    });
  }

  return [...candidatesById.values()];
}

function extractArtistFromUrlLookup(payload) {
  const candidates = extractArtistCandidatesFromUrlLookup(payload);

  if (candidates.length === 0) {
    return null;
  }

  if (candidates.length > 1) {
    throw new AmbiguousMusicBrainzMappingError(candidates);
  }

  return candidates[0];
}

function delay(durationMs) {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

function scheduleMusicBrainzRequest(request) {
  const scheduledRequest = requestQueue.then(async () => {
    const waitMs = Math.max(0, nextRequestAt - Date.now());

    if (waitMs > 0) {
      await delay(waitMs);
    }

    nextRequestAt = Date.now() + MUSICBRAINZ_REQUEST_INTERVAL_MS;
    return request();
  });

  requestQueue = scheduledRequest.catch(() => undefined);
  return scheduledRequest;
}

function isRetryableMusicBrainzError(error) {
  return error instanceof MusicBrainzTimeoutError
    || error instanceof MusicBrainzNetworkError
    || (
      error instanceof MusicBrainzRequestError
      && (
        [408, 425, 429].includes(error.status)
        || error.status >= 500
      )
    );
}

function parseRetryAfterMs(retryAfter, nowMs = Date.now()) {
  const normalizedRetryAfter = String(retryAfter || "").trim();

  if (!normalizedRetryAfter) {
    return 0;
  }

  const seconds = Number(normalizedRetryAfter);

  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const retryAt = Date.parse(normalizedRetryAfter);
  return Number.isFinite(retryAt) ? Math.max(0, retryAt - nowMs) : 0;
}

async function executeWithTimeout(operation, timeoutMs) {
  const abortController = new AbortController();
  let timedOut = false;
  let timeoutId;

  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      abortController.abort();
      reject(new MusicBrainzTimeoutError(timeoutMs));
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      operation(abortController.signal),
      timeoutPromise,
    ]);
  } catch (error) {
    if (timedOut && !(error instanceof MusicBrainzTimeoutError)) {
      throw new MusicBrainzTimeoutError(timeoutMs);
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchArtistBySpotifyUrl(spotifyUrl, options = {}) {
  const fetchImpl = options.fetchImpl || global.fetch;
  const maxAttempts = Math.max(1, options.maxAttempts || MUSICBRAINZ_MAX_ATTEMPTS);
  const requestTimeoutMs = Math.max(
    1,
    options.requestTimeoutMs || MUSICBRAINZ_REQUEST_TIMEOUT_MS,
  );
  const retryDelayImpl = options.retryDelayImpl || delay;
  const random = options.random || Math.random;

  if (typeof fetchImpl !== "function") {
    throw new TypeError("A fetch implementation is required");
  }

  const executeRequest = () => executeWithTimeout(async (signal) => {
    let response;

    try {
      response = await fetchImpl(buildArtistUrlLookupUrl(spotifyUrl), {
        headers: {
          Accept: "application/json",
          "User-Agent": getMusicBrainzUserAgent(options.env),
        },
        signal,
      });
    } catch (error) {
      if (signal.aborted || error instanceof MusicBrainzTimeoutError) {
        throw error;
      }

      throw new MusicBrainzNetworkError(error);
    }

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      throw new MusicBrainzRequestError(
        response.status,
        response.headers?.get?.("retry-after") || "",
      );
    }

    return extractArtistFromUrlLookup(await response.json());
  }, requestTimeoutMs);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      if (options.skipScheduling) {
        return await executeRequest();
      }

      return await scheduleMusicBrainzRequest(executeRequest);
    } catch (error) {
      if (attempt >= maxAttempts || !isRetryableMusicBrainzError(error)) {
        throw error;
      }

      const exponentialDelayMs = 500 * (2 ** (attempt - 1));
      const jitterMs = Math.floor(random() * 250);
      const retryAfterMs = error instanceof MusicBrainzRequestError
        ? parseRetryAfterMs(error.retryAfter)
        : 0;

      await retryDelayImpl(Math.max(retryAfterMs, exponentialDelayMs + jitterMs));
    }
  }

  return null;
}

function isFreshArtistMapping(artist, now = new Date()) {
  if (artist?.mappingStatus === "resolved") {
    return Boolean(artist.musicBrainzId);
  }

  if (artist?.mappingStatus !== "not_found") {
    return false;
  }

  const lastAttemptAt = new Date(artist.lastResolutionAttemptAt || 0).getTime();

  return Number.isFinite(lastAttemptAt)
    && now.getTime() - lastAttemptAt < NOT_FOUND_MAPPING_TTL_MS;
}

function normalizeArtistCatalog(artist) {
  const source = typeof artist?.toObject === "function" ? artist.toObject() : artist;

  if (!source) {
    return null;
  }

  return {
    spotifyId: source.spotifyId,
    spotifyUrl: source.spotifyUrl,
    name: source.name || source.musicBrainzName || "",
    musicBrainzId: source.musicBrainzId || null,
    musicBrainzName: source.musicBrainzName || "",
    sortName: source.sortName || "",
    disambiguation: source.disambiguation || "",
    artistType: source.artistType || "",
    country: source.country || "",
    mappingStatus: source.mappingStatus || "pending",
    mappingSource: source.mappingSource || "",
    mappingConfidence: source.mappingConfidence || 0,
    musicBrainzSyncedAt: source.musicBrainzSyncedAt || null,
  };
}

async function resolveArtist(input, spotifyId, options) {
  const now = options.now instanceof Date ? options.now : new Date();
  const cachedArtist = await ArtistCatalog.findOne({ spotifyId });

  if (!options.force && isFreshArtistMapping(cachedArtist, now)) {
    return {
      artist: normalizeArtistCatalog(cachedArtist),
      cacheStatus: "hit",
    };
  }

  // MusicBrainz URL resources are exact: Spotify share parameters and trailing
  // slashes return 404, so always resolve with the canonical artist URL.
  const spotifyUrl = buildSpotifyArtistUrl(spotifyId);
  let resolvedArtist;

  try {
    resolvedArtist = await fetchArtistBySpotifyUrl(spotifyUrl, options);
  } catch (error) {
    if (cachedArtist?.mappingStatus !== "resolved" || !isRetryableMusicBrainzError(error)) {
      throw error;
    }

    const staleArtist = await ArtistCatalog.findOneAndUpdate(
      { spotifyId },
      {
        $set: {
          lastResolutionFailureAt: now,
          lastResolutionError: error.name,
        },
      },
      { returnDocument: "after" },
    );

    return {
      artist: normalizeArtistCatalog(staleArtist || cachedArtist),
      cacheStatus: "stale",
    };
  }

  const sharedFields = {
    spotifyId,
    spotifyUrl,
    name: String(input.name || cachedArtist?.name || resolvedArtist?.name || "").trim(),
    lastResolutionAttemptAt: now,
  };
  const mappingFields = resolvedArtist
    ? {
      musicBrainzId: resolvedArtist.musicBrainzId,
      musicBrainzName: resolvedArtist.name,
      sortName: resolvedArtist.sortName,
      disambiguation: resolvedArtist.disambiguation,
      artistType: resolvedArtist.artistType,
      country: resolvedArtist.country,
      mappingStatus: "resolved",
      mappingSource: "spotify-url",
      mappingConfidence: 1,
      musicBrainzSyncedAt: now,
    }
    : {
      mappingStatus: "not_found",
      mappingSource: "spotify-url",
      mappingConfidence: 0,
    };
  const update = {
    $set: { ...sharedFields, ...mappingFields },
    $unset: {
      lastResolutionFailureAt: "",
      lastResolutionError: "",
    },
  };

  if (!resolvedArtist) {
    Object.assign(update.$unset, {
      musicBrainzId: "",
      musicBrainzName: "",
      sortName: "",
      disambiguation: "",
      artistType: "",
      country: "",
      musicBrainzSyncedAt: "",
    });
  }

  const savedArtist = await ArtistCatalog.findOneAndUpdate(
    { spotifyId },
    update,
    { returnDocument: "after", upsert: true, setDefaultsOnInsert: true },
  );

  return {
    artist: normalizeArtistCatalog(savedArtist),
    cacheStatus: cachedArtist ? "refreshed" : "miss",
  };
}

async function getOrResolveArtist(input, options = {}) {
  const spotifyId = String(input?.spotifyId || "").trim();

  // Validate before touching Mongo so malformed public input can never become a
  // persistent negative cache entry.
  buildSpotifyArtistUrl(spotifyId);

  const inFlightResolution = inFlightArtistResolutions.get(spotifyId);

  if (inFlightResolution) {
    return inFlightResolution;
  }

  const resolution = resolveArtist(input, spotifyId, options);
  inFlightArtistResolutions.set(spotifyId, resolution);

  try {
    return await resolution;
  } finally {
    if (inFlightArtistResolutions.get(spotifyId) === resolution) {
      inFlightArtistResolutions.delete(spotifyId);
    }
  }
}

module.exports = {
  AmbiguousMusicBrainzMappingError,
  MUSICBRAINZ_API_BASE_URL,
  MusicBrainzNetworkError,
  MusicBrainzRequestError,
  MusicBrainzTimeoutError,
  buildArtistUrlLookupUrl,
  buildSpotifyArtistUrl,
  extractArtistCandidatesFromUrlLookup,
  extractArtistFromUrlLookup,
  fetchArtistBySpotifyUrl,
  getMusicBrainzUserAgent,
  getOrResolveArtist,
  isFreshArtistMapping,
  isRetryableMusicBrainzError,
  normalizeArtistCatalog,
  parseRetryAfterMs,
  scheduleMusicBrainzRequest,
};
