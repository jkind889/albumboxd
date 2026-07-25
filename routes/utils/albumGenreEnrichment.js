const AlbumCatalog = require("../../models/AlbumCatalog");
const {
  MUSICBRAINZ_API_BASE_URL,
  MusicBrainzRequestError,
  fetchMusicBrainzJson,
} = require("./musicBrainz");

const SPOTIFY_ALBUM_ID_PATTERN = /^[A-Za-z0-9]{22}$/;
const MUSICBRAINZ_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOT_FOUND_MAPPING_TTL_MS = 24 * 60 * 60 * 1000;
const AMBIGUOUS_MAPPING_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const GENRE_REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const ENRICHMENT_FAILURE_COOLDOWN_MS = 15 * 60 * 1000;
const MAX_GENRE_RANKINGS = 5;
const MAX_PENDING_ALBUM_ENRICHMENTS = 100;
const GENRE_SOURCE = "musicbrainz_release_group";

const inFlightAlbumEnrichments = new Map();
const queuedAlbumIds = new Set();
const albumEnrichmentQueue = [];
const queueIdleWaiters = [];
let isQueueProcessing = false;

function buildSpotifyAlbumUrl(spotifyId) {
  const normalizedSpotifyId = String(spotifyId || "").trim();

  if (!normalizedSpotifyId) {
    throw new TypeError("Spotify album id is required");
  }

  if (!SPOTIFY_ALBUM_ID_PATTERN.test(normalizedSpotifyId)) {
    throw new TypeError("Spotify album id must be 22 alphanumeric characters");
  }

  return `https://open.spotify.com/album/${normalizedSpotifyId}`;
}

function buildAlbumUrlLookupUrl(spotifyUrl) {
  const url = new URL(`${MUSICBRAINZ_API_BASE_URL}/url`);

  url.searchParams.set("resource", spotifyUrl);
  url.searchParams.set("inc", "release-rels+release-group-rels");
  url.searchParams.set("fmt", "json");

  return url.toString();
}

function buildReleaseLookupUrl(musicBrainzReleaseId) {
  const normalizedId = normalizeMusicBrainzId(
    musicBrainzReleaseId,
    "MusicBrainz release id",
  );
  const url = new URL(`${MUSICBRAINZ_API_BASE_URL}/release/${normalizedId}`);

  url.searchParams.set("inc", "release-groups");
  url.searchParams.set("fmt", "json");

  return url.toString();
}

function buildReleaseGroupGenreUrl(musicBrainzReleaseGroupId) {
  const normalizedId = normalizeMusicBrainzId(
    musicBrainzReleaseGroupId,
    "MusicBrainz release group id",
  );
  const url = new URL(`${MUSICBRAINZ_API_BASE_URL}/release-group/${normalizedId}`);

  url.searchParams.set("inc", "genres");
  url.searchParams.set("fmt", "json");

  return url.toString();
}

function normalizeMusicBrainzId(value, label) {
  const normalizedId = String(value || "").trim().toLowerCase();

  if (!MUSICBRAINZ_ID_PATTERN.test(normalizedId)) {
    throw new TypeError(`${label} must be a valid MBID`);
  }

  return normalizedId;
}

function getReleaseGroupFromRelation(relation) {
  return relation?.["release-group"]
    || relation?.release_group
    || relation?.releaseGroup
    || relation?.release?.["release-group"]
    || relation?.release?.release_group
    || relation?.release?.releaseGroup
    || null;
}

function extractAlbumUrlCandidates(payload) {
  const releaseIds = new Set();
  const releaseIdsNeedingLookup = new Set();
  const releaseGroupIds = new Set();

  for (const relation of Array.isArray(payload?.relations) ? payload.relations : []) {
    if (relation?.ended === true) {
      continue;
    }

    const targetType = String(
      relation?.["target-type"] || relation?.target_type || "",
    ).trim().toLowerCase().replace(/_/g, "-");
    const releaseGroup = getReleaseGroupFromRelation(relation);
    const releaseGroupId = String(releaseGroup?.id || "").trim().toLowerCase();

    if (releaseGroupId && MUSICBRAINZ_ID_PATTERN.test(releaseGroupId)) {
      releaseGroupIds.add(releaseGroupId);
    }

    if (targetType === "release-group") {
      continue;
    }

    if (targetType !== "release") {
      continue;
    }

    const releaseId = String(relation?.release?.id || "").trim().toLowerCase();

    if (!MUSICBRAINZ_ID_PATTERN.test(releaseId)) {
      continue;
    }

    releaseIds.add(releaseId);

    if (!releaseGroupId) {
      releaseIdsNeedingLookup.add(releaseId);
    }
  }

  return {
    releaseIds: [...releaseIds].sort(),
    releaseIdsNeedingLookup: [...releaseIdsNeedingLookup].sort(),
    releaseGroupIds: [...releaseGroupIds].sort(),
  };
}

function getReleaseGroupIdFromRelease(payload) {
  const releaseGroupId = String(
    payload?.["release-group"]?.id
      || payload?.release_group?.id
      || payload?.releaseGroup?.id
      || "",
  ).trim().toLowerCase();

  return MUSICBRAINZ_ID_PATTERN.test(releaseGroupId) ? releaseGroupId : null;
}

async function resolveAlbumMusicBrainzMapping(spotifyId, options = {}) {
  const spotifyUrl = buildSpotifyAlbumUrl(spotifyId);
  const urlPayload = await fetchMusicBrainzJson(
    buildAlbumUrlLookupUrl(spotifyUrl),
    options,
  );

  if (!urlPayload) {
    return {
      status: "not_found",
      spotifyUrl,
      releaseIds: [],
      releaseGroupIds: [],
    };
  }

  const candidates = extractAlbumUrlCandidates(urlPayload);
  const releaseGroupIds = new Set(candidates.releaseGroupIds);

  for (const releaseId of candidates.releaseIdsNeedingLookup) {
    let releasePayload;

    try {
      releasePayload = await fetchMusicBrainzJson(
        buildReleaseLookupUrl(releaseId),
        options,
      );
    } catch (error) {
      error.releaseIds = candidates.releaseIds;
      error.releaseGroupIds = [...releaseGroupIds].sort();
      throw error;
    }

    const releaseGroupId = getReleaseGroupIdFromRelease(releasePayload);

    if (!releaseGroupId) {
      const error = new Error(
        `MusicBrainz release ${releaseId} did not resolve to a release group`,
      );
      error.name = "MusicBrainzMappingResolutionError";
      error.releaseIds = candidates.releaseIds;
      error.releaseGroupIds = [...releaseGroupIds].sort();
      throw error;
    }

    releaseGroupIds.add(releaseGroupId);
  }

  const normalizedReleaseGroupIds = [...releaseGroupIds].sort();

  if (normalizedReleaseGroupIds.length === 0) {
    return {
      status: "not_found",
      spotifyUrl,
      releaseIds: candidates.releaseIds,
      releaseGroupIds: [],
    };
  }

  if (normalizedReleaseGroupIds.length > 1) {
    return {
      status: "ambiguous",
      spotifyUrl,
      releaseIds: candidates.releaseIds,
      releaseGroupIds: normalizedReleaseGroupIds,
    };
  }

  return {
    status: "resolved",
    spotifyUrl,
    releaseIds: candidates.releaseIds,
    releaseGroupId: normalizedReleaseGroupIds[0],
    releaseGroupIds: normalizedReleaseGroupIds,
  };
}

function normalizeGenreRankings(genres, limit = MAX_GENRE_RANKINGS) {
  const scoresByName = new Map();

  for (const genre of Array.isArray(genres) ? genres : []) {
    const name = String(genre?.name || "").trim().toLowerCase();
    const score = Number(genre?.count);

    if (!name || !Number.isFinite(score) || score <= 0) {
      continue;
    }

    scoresByName.set(name, (scoresByName.get(name) || 0) + score);
  }

  return [...scoresByName.entries()]
    .map(([name, score]) => ({ name, score }))
    .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name))
    .slice(0, Math.max(0, limit));
}

async function fetchReleaseGroupGenreRankings(releaseGroupId, options = {}) {
  const payload = await fetchMusicBrainzJson(
    buildReleaseGroupGenreUrl(releaseGroupId),
    options,
  );

  if (!payload) {
    throw new MusicBrainzRequestError(404);
  }

  return normalizeGenreRankings(payload?.genres);
}

function getTimestamp(value) {
  if (!value) {
    return null;
  }

  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function isWithinWindow(value, now, durationMs) {
  const timestamp = getTimestamp(value);

  return timestamp !== null
    && now.getTime() - timestamp >= 0
    && now.getTime() - timestamp < durationMs;
}

function isAlbumGenreEnrichmentDue(album, options = {}) {
  if (!album) {
    return false;
  }

  if (options.force) {
    return true;
  }

  const now = options.now instanceof Date ? options.now : new Date();
  const mappingStatus = album.musicBrainzMappingStatus || "pending";

  if (
    isWithinWindow(
      album.lastMusicBrainzMappingFailureAt,
      now,
      ENRICHMENT_FAILURE_COOLDOWN_MS,
    )
    || isWithinWindow(
      album.lastGenreEnrichmentFailureAt,
      now,
      ENRICHMENT_FAILURE_COOLDOWN_MS,
    )
  ) {
    return false;
  }

  if (
    mappingStatus === "not_found"
    && isWithinWindow(
      album.lastMusicBrainzMappingAttemptAt,
      now,
      NOT_FOUND_MAPPING_TTL_MS,
    )
  ) {
    return false;
  }

  if (
    mappingStatus === "ambiguous"
    && isWithinWindow(
      album.lastMusicBrainzMappingAttemptAt,
      now,
      AMBIGUOUS_MAPPING_TTL_MS,
    )
  ) {
    return false;
  }

  if (mappingStatus !== "resolved" || !album.musicBrainzReleaseGroupId) {
    return true;
  }

  return !(
    ["resolved", "empty"].includes(album.genreEnrichmentStatus)
    && isWithinWindow(album.genresSyncedAt, now, GENRE_REFRESH_TTL_MS)
  );
}

function getErrorDetails(error) {
  const name = String(error?.name || "Error").trim();
  const message = String(error?.message || "").trim();
  const metadata = [];

  if (Number.isFinite(Number(error?.status))) {
    metadata.push(`status=${Number(error.status)}`);
  }

  if (error?.retryAfter) {
    metadata.push(`retryAfter=${String(error.retryAfter).trim()}`);
  }

  if (Number.isFinite(Number(error?.timeoutMs))) {
    metadata.push(`timeoutMs=${Number(error.timeoutMs)}`);
  }

  if (Array.isArray(error?.releaseIds) && error.releaseIds.length > 0) {
    metadata.push(`releaseIds=${error.releaseIds.join(",")}`);
  }

  if (
    Array.isArray(error?.releaseGroupIds)
    && error.releaseGroupIds.length > 0
  ) {
    metadata.push(`releaseGroupIds=${error.releaseGroupIds.join(",")}`);
  }

  const description = message && message !== name ? `${name}: ${message}` : name;
  const suffix = metadata.length > 0 ? ` (${metadata.join(", ")})` : "";

  return `${description}${suffix}`.slice(0, 1000);
}

async function saveMappingFailure(album, now, error) {
  const keepResolvedMapping = album?.musicBrainzMappingStatus === "resolved"
    && album?.musicBrainzReleaseGroupId;
  const failureFields = {
    musicBrainzMappingStatus: keepResolvedMapping ? "resolved" : "failed",
    lastMusicBrainzMappingAttemptAt: now,
    lastMusicBrainzMappingFailureAt: now,
    lastMusicBrainzMappingError: getErrorDetails(error),
  };

  if (Array.isArray(error?.releaseIds)) {
    failureFields.musicBrainzReleaseIds = error.releaseIds;
  }

  if (Array.isArray(error?.releaseGroupIds)) {
    failureFields.musicBrainzReleaseGroupCandidates = error.releaseGroupIds;
  }

  return AlbumCatalog.findOneAndUpdate(
    { spotifyId: album.spotifyId },
    {
      $set: failureFields,
    },
    { returnDocument: "after" },
  );
}

async function saveMappingResult(album, mapping, now) {
  const invalidatesExistingGenreData = album.genreSource === GENRE_SOURCE
    && (
      mapping.status !== "resolved"
      || album.musicBrainzReleaseGroupId !== mapping.releaseGroupId
    );
  const sharedFields = {
    musicBrainzReleaseIds: mapping.releaseIds,
    musicBrainzReleaseGroupCandidates: mapping.status === "ambiguous"
      ? mapping.releaseGroupIds
      : [],
    musicBrainzMappingStatus: mapping.status,
    musicBrainzMappingSource: "spotify-url",
    lastMusicBrainzMappingAttemptAt: now,
  };
  const update = {
    $set: sharedFields,
    $unset: {
      lastMusicBrainzMappingFailureAt: "",
      lastMusicBrainzMappingError: "",
    },
  };

  if (mapping.status === "resolved") {
    Object.assign(update.$set, {
      musicBrainzReleaseGroupId: mapping.releaseGroupId,
      musicBrainzMappedAt: now,
    });
  } else {
    Object.assign(update.$unset, {
      musicBrainzReleaseGroupId: "",
      musicBrainzMappedAt: "",
    });
  }

  if (invalidatesExistingGenreData) {
    Object.assign(update.$set, {
      genres: [],
      genreRankings: [],
      genreSource: "",
      genreEnrichmentStatus: "pending",
      genresSyncedAt: null,
    });
    Object.assign(update.$unset, {
      lastGenreEnrichmentFailureAt: "",
      lastGenreEnrichmentError: "",
    });
  }

  return AlbumCatalog.findOneAndUpdate(
    { spotifyId: album.spotifyId },
    update,
    { returnDocument: "after" },
  );
}

async function saveGenreFailure(album, now, error) {
  const hasStaleGenreData = ["resolved", "empty"].includes(
    album?.genreEnrichmentStatus,
  );

  return AlbumCatalog.findOneAndUpdate(
    { spotifyId: album.spotifyId },
    {
      $set: {
        genreEnrichmentStatus: hasStaleGenreData
          ? album.genreEnrichmentStatus
          : "failed",
        lastGenreEnrichmentAttemptAt: now,
        lastGenreEnrichmentFailureAt: now,
        lastGenreEnrichmentError: getErrorDetails(error),
      },
    },
    { returnDocument: "after" },
  );
}

async function saveGenreRankings(album, rankings, now) {
  return AlbumCatalog.findOneAndUpdate(
    { spotifyId: album.spotifyId },
    {
      $set: {
        genres: rankings.map((genre) => genre.name),
        genreRankings: rankings,
        genreSource: GENRE_SOURCE,
        genreEnrichmentStatus: rankings.length > 0 ? "resolved" : "empty",
        genresSyncedAt: now,
        lastGenreEnrichmentAttemptAt: now,
      },
      $unset: {
        lastGenreEnrichmentFailureAt: "",
        lastGenreEnrichmentError: "",
      },
    },
    { returnDocument: "after" },
  );
}

async function performAlbumGenreEnrichment(spotifyId, options = {}) {
  let album = await AlbumCatalog.findOne({ spotifyId });

  if (!album) {
    return { status: "missing", album: null };
  }

  if (!isAlbumGenreEnrichmentDue(album, options)) {
    return { status: "skipped", album };
  }

  const now = options.now instanceof Date ? options.now : new Date();
  let releaseGroupId = album.musicBrainzReleaseGroupId;

  if (
    options.force
    || album.musicBrainzMappingStatus !== "resolved"
    || !releaseGroupId
  ) {
    let mapping;

    try {
      mapping = await resolveAlbumMusicBrainzMapping(spotifyId, options);
    } catch (error) {
      album = await saveMappingFailure(album, now, error);
      return { status: "failed", stage: "mapping", album, error };
    }

    album = await saveMappingResult(album, mapping, now);

    if (mapping.status !== "resolved") {
      return { status: mapping.status, album };
    }

    releaseGroupId = mapping.releaseGroupId;
  }

  let rankings;

  try {
    rankings = await fetchReleaseGroupGenreRankings(releaseGroupId, options);
  } catch (error) {
    album = await saveGenreFailure(album, now, error);
    return { status: "failed", stage: "genres", album, error };
  }

  album = await saveGenreRankings(album, rankings, now);

  return {
    status: rankings.length > 0 ? "resolved" : "empty",
    album,
  };
}

function enrichAlbumGenres(spotifyId, options = {}) {
  const normalizedSpotifyId = String(spotifyId || "").trim();
  const existingEnrichment = inFlightAlbumEnrichments.get(normalizedSpotifyId);

  if (existingEnrichment) {
    return existingEnrichment;
  }

  const enrichment = performAlbumGenreEnrichment(normalizedSpotifyId, options);
  inFlightAlbumEnrichments.set(normalizedSpotifyId, enrichment);

  return enrichment.finally(() => {
    if (inFlightAlbumEnrichments.get(normalizedSpotifyId) === enrichment) {
      inFlightAlbumEnrichments.delete(normalizedSpotifyId);
    }
  });
}

function isLazyAlbumGenreEnrichmentEnabled(env = process.env) {
  const configuredValue = String(
    env.ALBUM_GENRE_LAZY_ENRICHMENT ?? "true",
  ).trim().toLowerCase();

  return !["0", "false", "no", "off"].includes(configuredValue);
}

function resolveQueueIdleWaiters() {
  if (
    isQueueProcessing
    || albumEnrichmentQueue.length > 0
    || inFlightAlbumEnrichments.size > 0
  ) {
    return;
  }

  while (queueIdleWaiters.length > 0) {
    queueIdleWaiters.shift()();
  }
}

async function processAlbumEnrichmentQueue() {
  if (isQueueProcessing) {
    return;
  }

  isQueueProcessing = true;

  try {
    while (albumEnrichmentQueue.length > 0) {
      const job = albumEnrichmentQueue.shift();

      try {
        const result = await enrichAlbumGenres(job.spotifyId, job.options);

        if (result.status === "failed") {
          console.warn(
            `MusicBrainz album genre enrichment failed for ${job.spotifyId}:`,
            result.error?.message || result.stage,
          );
        }
      } catch (error) {
        console.warn(
          `MusicBrainz album genre enrichment crashed for ${job.spotifyId}:`,
          error.message,
        );
      } finally {
        queuedAlbumIds.delete(job.spotifyId);
      }
    }
  } finally {
    isQueueProcessing = false;
    resolveQueueIdleWaiters();
  }
}

function scheduleAlbumGenreEnrichment(album, options = {}) {
  const spotifyId = String(album?.spotifyId || album || "").trim();

  if (
    !spotifyId
    || !isLazyAlbumGenreEnrichmentEnabled(options.env)
    || queuedAlbumIds.has(spotifyId)
    || inFlightAlbumEnrichments.has(spotifyId)
    || (typeof album === "object" && !isAlbumGenreEnrichmentDue(album, options))
  ) {
    return false;
  }

  if (
    albumEnrichmentQueue.length + inFlightAlbumEnrichments.size
    >= MAX_PENDING_ALBUM_ENRICHMENTS
  ) {
    return false;
  }

  queuedAlbumIds.add(spotifyId);
  albumEnrichmentQueue.push({ spotifyId, options });
  setImmediate(processAlbumEnrichmentQueue);

  return true;
}

function waitForAlbumGenreQueueIdle() {
  if (
    !isQueueProcessing
    && albumEnrichmentQueue.length === 0
    && inFlightAlbumEnrichments.size === 0
  ) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    queueIdleWaiters.push(resolve);
  });
}

module.exports = {
  AMBIGUOUS_MAPPING_TTL_MS,
  ENRICHMENT_FAILURE_COOLDOWN_MS,
  GENRE_REFRESH_TTL_MS,
  GENRE_SOURCE,
  MAX_GENRE_RANKINGS,
  MAX_PENDING_ALBUM_ENRICHMENTS,
  NOT_FOUND_MAPPING_TTL_MS,
  buildAlbumUrlLookupUrl,
  buildReleaseGroupGenreUrl,
  buildReleaseLookupUrl,
  buildSpotifyAlbumUrl,
  enrichAlbumGenres,
  extractAlbumUrlCandidates,
  fetchReleaseGroupGenreRankings,
  getReleaseGroupIdFromRelease,
  isAlbumGenreEnrichmentDue,
  isLazyAlbumGenreEnrichmentEnabled,
  normalizeGenreRankings,
  resolveAlbumMusicBrainzMapping,
  scheduleAlbumGenreEnrichment,
  waitForAlbumGenreQueueIdle,
};
