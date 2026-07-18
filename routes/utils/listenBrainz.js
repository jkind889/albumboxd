const ArtistNeighborhood = require("../../models/ArtistNeighborhood");
const { getMusicBrainzUserAgent } = require("./musicBrainz");

const LISTENBRAINZ_API_BASE_URL = "https://labs.api.listenbrainz.org";
const LISTENBRAINZ_SOURCE = "listenbrainz";
const DEFAULT_SIMILAR_ARTISTS_ALGORITHM = "session_based_days_1825_session_300_contribution_3_threshold_10_limit_100_filter_True_skip_30";
const NEIGHBORHOOD_NORMALIZATION_VERSION = 1;
const NEIGHBORHOOD_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const REFRESH_FAILURE_BACKOFF_MS = 60 * 60 * 1000;
const COLD_FAILURE_BACKOFF_MS = 60 * 1000;
const LISTENBRAINZ_REQUEST_TIMEOUT_MS = 25000;
const LISTENBRAINZ_MAX_ATTEMPTS = 2;
const LISTENBRAINZ_MAX_CONCURRENT_REQUESTS = 2;
const LISTENBRAINZ_MAX_QUEUED_REQUESTS = 2;
const MBID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const inFlightNeighborhoods = new Map();
const coldFailureBackoffs = new Map();
const listenBrainzRequestQueue = [];
let activeListenBrainzRequests = 0;

class ListenBrainzRequestError extends Error {
  constructor(status, responseBody = "", retryAfter = "") {
    super(`ListenBrainz request failed with status ${status}`);
    this.name = "ListenBrainzRequestError";
    this.status = status;
    this.responseBody = responseBody;
    this.retryAfter = retryAfter;
  }
}

class ListenBrainzTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`ListenBrainz request timed out after ${timeoutMs}ms`);
    this.name = "ListenBrainzTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

class ListenBrainzNetworkError extends Error {
  constructor(cause) {
    super("ListenBrainz request failed before receiving a response");
    this.name = "ListenBrainzNetworkError";
    this.cause = cause;
  }
}

class ListenBrainzResponseError extends Error {
  constructor(message) {
    super(message);
    this.name = "ListenBrainzResponseError";
  }
}

class ListenBrainzBusyError extends Error {
  constructor() {
    super("ListenBrainz request capacity is temporarily full");
    this.name = "ListenBrainzBusyError";
  }
}

class ListenBrainzBackoffError extends Error {
  constructor(retryAfterMs) {
    super("ListenBrainz lookup is backing off after a recent failure");
    this.name = "ListenBrainzBackoffError";
    this.retryAfterMs = retryAfterMs;
  }
}

function delay(durationMs) {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

function drainListenBrainzRequestQueue() {
  while (
    activeListenBrainzRequests < LISTENBRAINZ_MAX_CONCURRENT_REQUESTS
    && listenBrainzRequestQueue.length > 0
  ) {
    const queuedRequest = listenBrainzRequestQueue.shift();
    activeListenBrainzRequests += 1;

    Promise.resolve()
      .then(queuedRequest.operation)
      .then(queuedRequest.resolve, queuedRequest.reject)
      .finally(() => {
        activeListenBrainzRequests -= 1;
        drainListenBrainzRequestQueue();
      });
  }
}

function scheduleListenBrainzRequest(operation) {
  if (
    activeListenBrainzRequests >= LISTENBRAINZ_MAX_CONCURRENT_REQUESTS
    && listenBrainzRequestQueue.length >= LISTENBRAINZ_MAX_QUEUED_REQUESTS
  ) {
    return Promise.reject(new ListenBrainzBusyError());
  }

  return new Promise((resolve, reject) => {
    listenBrainzRequestQueue.push({ operation, resolve, reject });
    drainListenBrainzRequestQueue();
  });
}

function normalizeMusicBrainzId(musicBrainzId) {
  const normalizedId = String(musicBrainzId || "").trim().toLowerCase();

  if (!MBID_PATTERN.test(normalizedId)) {
    throw new TypeError("A valid MusicBrainz artist id is required");
  }

  return normalizedId;
}

function getListenBrainzAlgorithm(env = process.env) {
  return String(
    env.LISTENBRAINZ_SIMILAR_ARTISTS_ALGORITHM
      || DEFAULT_SIMILAR_ARTISTS_ALGORITHM,
  ).trim();
}

function getListenBrainzBaseUrl(env = process.env) {
  return String(
    env.LISTENBRAINZ_API_BASE_URL || LISTENBRAINZ_API_BASE_URL,
  ).trim();
}

function buildSimilarArtistsUrl(musicBrainzId, options = {}) {
  const normalizedId = normalizeMusicBrainzId(musicBrainzId);
  const env = options.env || process.env;
  const algorithm = String(options.algorithm || getListenBrainzAlgorithm(env)).trim();

  if (!algorithm) {
    throw new TypeError("A ListenBrainz similar-artists algorithm is required");
  }

  const url = new URL("/similar-artists/json", getListenBrainzBaseUrl(env));
  url.searchParams.set("artist_mbids", normalizedId);
  url.searchParams.set("algorithm", algorithm);
  return url.toString();
}

function normalizeSimilarArtists(payload, seedMusicBrainzId) {
  const normalizedSeedId = normalizeMusicBrainzId(seedMusicBrainzId);

  if (!Array.isArray(payload)) {
    throw new ListenBrainzResponseError("ListenBrainz returned an invalid similar-artists payload");
  }

  const candidatesById = new Map();

  for (const candidate of payload) {
    const candidateId = String(candidate?.artist_mbid || "").trim().toLowerCase();
    const referenceId = String(candidate?.reference_mbid || "").trim().toLowerCase();
    const rawScore = typeof candidate?.score === "number"
      ? candidate.score
      : Number.NaN;

    if (
      !MBID_PATTERN.test(candidateId)
      || candidateId === normalizedSeedId
      || referenceId !== normalizedSeedId
      || !Number.isFinite(rawScore)
      || rawScore < 0
    ) {
      continue;
    }

    const normalizedCandidate = {
      musicBrainzId: candidateId,
      name: String(candidate?.name || "").trim(),
      comment: String(candidate?.comment || "").trim(),
      artistType: String(candidate?.type || "").trim(),
      gender: String(candidate?.gender || "").trim(),
      rawScore,
    };
    const existingCandidate = candidatesById.get(candidateId);

    if (!existingCandidate || normalizedCandidate.rawScore > existingCandidate.rawScore) {
      candidatesById.set(candidateId, normalizedCandidate);
    }
  }

  if (payload.length > 0 && candidatesById.size === 0) {
    throw new ListenBrainzResponseError(
      "ListenBrainz returned a nonempty payload without any valid similar artists",
    );
  }

  const sortedCandidates = [...candidatesById.values()].sort((left, right) => (
    right.rawScore - left.rawScore
      || left.name.localeCompare(right.name)
      || left.musicBrainzId.localeCompare(right.musicBrainzId)
  ));
  const topScore = Math.max(0, sortedCandidates[0]?.rawScore || 0);

  return sortedCandidates.map((candidate, index) => ({
    ...candidate,
    rank: index + 1,
    weight: topScore > 0
      ? Number((candidate.rawScore / topScore).toFixed(6))
      : 0,
  }));
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

function isRetryableListenBrainzError(error) {
  return error instanceof ListenBrainzTimeoutError
    || error instanceof ListenBrainzNetworkError
    || error instanceof ListenBrainzBusyError
    || (
      error instanceof ListenBrainzRequestError
      && (error.status === 408 || error.status === 429 || error.status >= 500)
    );
}

function canServeStaleNeighborhood(error) {
  return isRetryableListenBrainzError(error)
    || error instanceof ListenBrainzRequestError
    || error instanceof ListenBrainzResponseError;
}

async function executeWithTimeout(operation, timeoutMs) {
  const abortController = new AbortController();
  let timedOut = false;
  let timeoutId;

  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      abortController.abort();
      reject(new ListenBrainzTimeoutError(timeoutMs));
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      operation(abortController.signal),
      timeoutPromise,
    ]);
  } catch (error) {
    if (timedOut && !(error instanceof ListenBrainzTimeoutError)) {
      throw new ListenBrainzTimeoutError(timeoutMs);
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchSimilarArtists(musicBrainzId, options = {}) {
  const normalizedId = normalizeMusicBrainzId(musicBrainzId);
  const fetchImpl = options.fetchImpl || global.fetch;
  const maxAttempts = Math.max(1, options.maxAttempts || LISTENBRAINZ_MAX_ATTEMPTS);
  const requestTimeoutMs = Math.max(
    1,
    options.requestTimeoutMs || LISTENBRAINZ_REQUEST_TIMEOUT_MS,
  );
  const retryDelayImpl = options.retryDelayImpl || delay;
  const random = options.random || Math.random;

  if (typeof fetchImpl !== "function") {
    throw new TypeError("A fetch implementation is required");
  }

  const executeRequest = () => executeWithTimeout(async (signal) => {
    let response;

    try {
      response = await fetchImpl(buildSimilarArtistsUrl(normalizedId, options), {
        headers: {
          Accept: "application/json",
          "User-Agent": getMusicBrainzUserAgent(options.env),
        },
        signal,
      });
    } catch (error) {
      if (signal.aborted || error instanceof ListenBrainzTimeoutError) {
        throw error;
      }

      throw new ListenBrainzNetworkError(error);
    }

    if (!response.ok) {
      const responseBody = await response.text().catch(() => "");
      throw new ListenBrainzRequestError(
        response.status,
        responseBody.slice(0, 500),
        response.headers?.get?.("retry-after") || "",
      );
    }

    let payload;

    try {
      payload = await response.json();
    } catch (error) {
      throw new ListenBrainzResponseError(
        `ListenBrainz returned invalid JSON: ${error.message}`,
      );
    }

    return normalizeSimilarArtists(payload, normalizedId);
  }, requestTimeoutMs);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await scheduleListenBrainzRequest(executeRequest);
    } catch (error) {
      if (attempt >= maxAttempts || !isRetryableListenBrainzError(error)) {
        throw error;
      }

      const exponentialDelayMs = 750 * (2 ** (attempt - 1));
      const jitterMs = Math.floor(random() * 250);
      const retryAfterMs = error instanceof ListenBrainzRequestError
        ? parseRetryAfterMs(error.retryAfter)
        : 0;

      await retryDelayImpl(Math.max(retryAfterMs, exponentialDelayMs + jitterMs));
    }
  }

  return [];
}

function normalizeNeighborhood(neighborhood) {
  const source = typeof neighborhood?.toObject === "function"
    ? neighborhood.toObject()
    : neighborhood;

  if (!source) {
    return null;
  }

  return {
    seedMusicBrainzId: source.seedMusicBrainzId,
    source: source.source || LISTENBRAINZ_SOURCE,
    algorithm: source.algorithm,
    normalizationVersion: source.normalizationVersion || 0,
    neighbors: Array.isArray(source.neighbors) ? source.neighbors : [],
    fetchedAt: source.fetchedAt || null,
    expiresAt: source.expiresAt || null,
  };
}

function isFreshNeighborhood(neighborhood, now = new Date()) {
  if (
    !neighborhood
    || Number(neighborhood.normalizationVersion || 0) < NEIGHBORHOOD_NORMALIZATION_VERSION
  ) {
    return false;
  }

  const expiresAt = new Date(neighborhood.expiresAt || 0).getTime();
  return Number.isFinite(expiresAt) && now.getTime() < expiresAt;
}

function hasRecentRefreshFailure(neighborhood, now = new Date()) {
  if (!neighborhood?.lastRefreshFailureAt) {
    return false;
  }

  const failedAt = new Date(neighborhood.lastRefreshFailureAt).getTime();
  return Number.isFinite(failedAt)
    && now.getTime() - failedAt < REFRESH_FAILURE_BACKOFF_MS;
}

function getColdFailureBackoff(inFlightKey, now) {
  const retryAt = coldFailureBackoffs.get(inFlightKey);

  if (!retryAt) {
    return null;
  }

  const retryAfterMs = retryAt - now.getTime();

  if (retryAfterMs <= 0) {
    coldFailureBackoffs.delete(inFlightKey);
    return null;
  }

  return new ListenBrainzBackoffError(retryAfterMs);
}

async function resolveArtistNeighborhood(seedMusicBrainzId, algorithm, options) {
  const now = options.now instanceof Date ? options.now : new Date();
  const inFlightKey = `${seedMusicBrainzId}:${algorithm}`;
  const query = {
    seedMusicBrainzId,
    source: LISTENBRAINZ_SOURCE,
    algorithm,
  };
  const cachedNeighborhood = await ArtistNeighborhood.findOne(query);

  if (!options.force && isFreshNeighborhood(cachedNeighborhood, now)) {
    return {
      neighborhood: normalizeNeighborhood(cachedNeighborhood),
      cacheStatus: "hit",
    };
  }

  if (!options.force && cachedNeighborhood && hasRecentRefreshFailure(cachedNeighborhood, now)) {
    return {
      neighborhood: normalizeNeighborhood(cachedNeighborhood),
      cacheStatus: "stale",
    };
  }

  if (!options.force && !cachedNeighborhood) {
    const backoffError = getColdFailureBackoff(inFlightKey, now);

    if (backoffError) {
      throw backoffError;
    }
  }

  let neighbors;

  try {
    neighbors = await fetchSimilarArtists(seedMusicBrainzId, {
      ...options,
      algorithm,
    });
  } catch (error) {
    if (!cachedNeighborhood) {
      if (canServeStaleNeighborhood(error)) {
        coldFailureBackoffs.set(
          inFlightKey,
          now.getTime() + COLD_FAILURE_BACKOFF_MS,
        );
      }

      throw error;
    }

    if (!canServeStaleNeighborhood(error)) {
      throw error;
    }

    await ArtistNeighborhood.findOneAndUpdate(
      query,
      {
        $set: {
          lastRefreshFailureAt: now,
          lastRefreshError: error.name,
        },
      },
      { returnDocument: "after" },
    ).catch(() => null);

    return {
      neighborhood: normalizeNeighborhood(cachedNeighborhood),
      cacheStatus: "stale",
    };
  }

  coldFailureBackoffs.delete(inFlightKey);

  const expiresAt = new Date(now.getTime() + NEIGHBORHOOD_TTL_MS);
  const savedNeighborhood = await ArtistNeighborhood.findOneAndUpdate(
    query,
    {
      $set: {
        ...query,
        normalizationVersion: NEIGHBORHOOD_NORMALIZATION_VERSION,
        neighbors,
        fetchedAt: now,
        expiresAt,
      },
      $unset: {
        lastRefreshFailureAt: "",
        lastRefreshError: "",
      },
    },
    { returnDocument: "after", upsert: true, setDefaultsOnInsert: true },
  );

  return {
    neighborhood: normalizeNeighborhood(savedNeighborhood),
    cacheStatus: cachedNeighborhood ? "refreshed" : "miss",
  };
}

async function getOrCreateArtistNeighborhood(musicBrainzId, options = {}) {
  const seedMusicBrainzId = normalizeMusicBrainzId(musicBrainzId);
  const algorithm = String(
    options.algorithm || getListenBrainzAlgorithm(options.env),
  ).trim();

  if (!algorithm) {
    throw new TypeError("A ListenBrainz similar-artists algorithm is required");
  }

  const inFlightKey = `${seedMusicBrainzId}:${algorithm}`;
  const inFlightNeighborhood = inFlightNeighborhoods.get(inFlightKey);

  if (inFlightNeighborhood) {
    return inFlightNeighborhood;
  }

  const resolution = resolveArtistNeighborhood(seedMusicBrainzId, algorithm, options);
  inFlightNeighborhoods.set(inFlightKey, resolution);

  try {
    return await resolution;
  } finally {
    if (inFlightNeighborhoods.get(inFlightKey) === resolution) {
      inFlightNeighborhoods.delete(inFlightKey);
    }
  }
}

module.exports = {
  DEFAULT_SIMILAR_ARTISTS_ALGORITHM,
  COLD_FAILURE_BACKOFF_MS,
  LISTENBRAINZ_API_BASE_URL,
  LISTENBRAINZ_MAX_CONCURRENT_REQUESTS,
  LISTENBRAINZ_SOURCE,
  ListenBrainzBackoffError,
  ListenBrainzBusyError,
  ListenBrainzNetworkError,
  ListenBrainzRequestError,
  ListenBrainzResponseError,
  ListenBrainzTimeoutError,
  NEIGHBORHOOD_NORMALIZATION_VERSION,
  NEIGHBORHOOD_TTL_MS,
  buildSimilarArtistsUrl,
  canServeStaleNeighborhood,
  fetchSimilarArtists,
  getListenBrainzAlgorithm,
  getOrCreateArtistNeighborhood,
  hasRecentRefreshFailure,
  isFreshNeighborhood,
  isRetryableListenBrainzError,
  normalizeMusicBrainzId,
  normalizeNeighborhood,
  normalizeSimilarArtists,
};
