const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const {
  CatalogFetchError,
  createRateGate,
  normalizeMbid,
  normalizeText,
  requestJson,
} = require("../catalogImport/listenBrainz");
const { LegacyMigrationError, canonicalEjson } = require("./runtime");

const MUSICBRAINZ_URL = "https://musicbrainz.org/ws/2";
const DEFAULT_USER_AGENT = "RescenedLegacyMigration/1.0.0 (https://github.com/jkind889/rescened)";
const MAX_TRACKS = 200;

function isoNow(clock = () => new Date()) {
  return clock().toISOString();
}

function endpointKey(url) {
  return crypto.createHash("sha256").update(canonicalEjson({ url }), "utf8").digest("hex");
}

function endpointMbid(url) {
  const match = String(url || "").match(/\/(?:release-group|release)\/([0-9a-f-]{36})(?:[/?]|$)/i);
  return normalizeMbid(match?.[1]);
}

function partialDate(value) {
  const text = normalizeText(value);
  if (/^\d{4}$/.test(text)) return { releaseDate: text, releaseDatePrecision: "year", releaseYear: Number(text) };
  if (/^\d{4}-\d{2}$/.test(text)) return { releaseDate: text, releaseDatePrecision: "month", releaseYear: Number(text.slice(0, 4)) };
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return { releaseDate: text, releaseDatePrecision: "day", releaseYear: Number(text.slice(0, 4)) };
  return { releaseDate: "", releaseDatePrecision: "", releaseYear: null };
}

function mapReleaseType(primaryType, secondaryTypes = []) {
  const secondary = new Set((secondaryTypes || []).map((value) => normalizeText(value).toLowerCase()));
  for (const [source, target] of [["soundtrack", "soundtrack"], ["mixtape/street", "mixtape"], ["mixtape", "mixtape"], ["live", "live"], ["remix", "remix"], ["compilation", "compilation"]]) {
    if (secondary.has(source)) return target;
  }
  const primary = normalizeText(primaryType).toLowerCase();
  return primary === "album" || primary === "ep" || primary === "single" ? primary : "other";
}

function artistCredits(rawCredits = []) {
  const credits = rawCredits.map((credit) => ({
    name: normalizeText(credit?.name || credit?.artist?.name),
    joinPhrase: typeof credit?.joinphrase === "string" ? credit.joinphrase : "",
    artistMbid: normalizeMbid(credit?.artist?.id),
  })).filter((credit) => credit.name);
  if (!credits.length || credits.some((credit) => !credit.artistMbid)) throw new LegacyMigrationError("MusicBrainz response has invalid artist credits", "MUSICBRAINZ_INVALID_ARTIST_CREDIT");
  return {
    credits,
    displayName: credits.map((credit) => `${credit.name}${credit.joinPhrase}`).join(""),
  };
}

function groupMetadata(group, fetchedAt) {
  const mbid = normalizeMbid(group?.id);
  if (!mbid || !normalizeText(group?.title)) throw new LegacyMigrationError("MusicBrainz release-group response is invalid", "MUSICBRAINZ_INVALID_RELEASE_GROUP");
  const artists = artistCredits(group["artist-credit"]);
  const date = partialDate(group["first-release-date"]);
  return {
    title: normalizeText(group.title),
    artistDisplayName: artists.displayName,
    artistCredits: artists.credits.map(({ name, joinPhrase }) => ({ name: `${name}${joinPhrase}`, role: "main" })),
    releaseType: mapReleaseType(group["primary-type"], group["secondary-types"]),
    ...date,
    releaseGroupMbid: mbid,
    fetchedAt,
  };
}

function trackArtistDisplay(track, fallback) {
  const credits = track?.artist_credit || track?.recording?.["artist-credit"];
  if (!Array.isArray(credits) || !credits.length) return fallback;
  return credits.map((credit) => `${normalizeText(credit?.name || credit?.artist?.name)}${credit?.joinphrase || ""}`).join("").trim() || fallback;
}

function releaseTracklist(release, albumArtistDisplayName) {
  const media = Array.isArray(release?.media) ? release.media : [];
  const flat = [];
  const issues = [];
  for (const medium of media) {
    const discNumber = Number(medium?.position);
    if (!Number.isInteger(discNumber) || discNumber < 1) issues.push("INVALID_DISC_POSITION");
    for (const track of Array.isArray(medium?.tracks) ? medium.tracks : []) {
      const trackNumber = Number(track?.position);
      const title = normalizeText(track?.title || track?.recording?.title);
      if (!Number.isInteger(trackNumber) || trackNumber < 1) issues.push("INVALID_TRACK_POSITION");
      if (!title) issues.push("MISSING_TRACK_TITLE");
      const duration = Number(track?.length ?? track?.recording?.length ?? 0);
      if (!Number.isFinite(duration) || duration < 0) issues.push("INVALID_TRACK_DURATION");
      flat.push({
        discNumber,
        trackNumber,
        title,
        durationMs: Math.trunc(duration),
        artistDisplayName: trackArtistDisplay(track, albumArtistDisplayName),
      });
    }
  }
  if (flat.length > MAX_TRACKS) issues.push("TRACKLIST_TOO_LARGE");
  const positions = new Set();
  for (const track of flat) {
    const key = `${track.discNumber}:${track.trackNumber}`;
    if (positions.has(key)) issues.push("DUPLICATE_TRACK_POSITION");
    positions.add(key);
  }
  if (issues.length) return { tracks: [], issues: [...new Set(issues)] };
  return { tracks: flat.sort((left, right) => left.discNumber - right.discNumber || left.trackNumber - right.trackNumber), issues: [] };
}

function releaseMetadata(release, expectedGroupMbid, fetchedAt) {
  const releaseMbid = normalizeMbid(release?.id);
  const groupMbid = normalizeMbid(release?.["release-group"]?.id);
  if (!releaseMbid || !groupMbid || (expectedGroupMbid && groupMbid !== expectedGroupMbid)) throw new LegacyMigrationError("MusicBrainz release does not belong to the expected release group", "MUSICBRAINZ_RELEASE_GROUP_MISMATCH");
  const labels = [...new Set((release["label-info"] || []).map((entry) => normalizeText(entry?.label?.name)).filter((name) => name && name.toLowerCase() !== "[no label]"))];
  return {
    releaseMbid,
    label: labels.length === 1 ? labels[0] : "",
    labelIssue: labels.length > 1 ? "MULTIPLE_LABELS" : "",
    date: partialDate(release.date),
    tracklist: releaseTracklist(release, ""),
    fetchedAt,
  };
}

function createMusicBrainzClient(options = {}) {
  const fetchFn = options.fetchFn || globalThis.fetch;
  const userAgent = normalizeText(options.userAgent || process.env.MUSICBRAINZ_USER_AGENT || DEFAULT_USER_AGENT);
  if (!userAgent || !/[(/@]/.test(userAgent)) throw new TypeError("MusicBrainz user agent must identify the application");
  const cacheDir = options.cacheDir ? path.resolve(options.cacheDir) : null;
  const rateGate = createRateGate({ intervalMs: options.intervalMs ?? 1_100, nowMs: options.nowMs, sleepFn: options.sleepFn });
  const stats = { cacheHits: 0, cacheMisses: 0, networkRequests: 0 };

  async function cacheRead(key) {
    if (!cacheDir) return null;
    try {
      return JSON.parse(await fs.readFile(path.join(cacheDir, `${key}.json`), "utf8"));
    } catch (error) {
      if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
      throw error;
    }
  }

  async function cacheWrite(key, value) {
    if (!cacheDir) return;
    await fs.mkdir(cacheDir, { recursive: true });
    const lockPath = path.join(cacheDir, ".cache.lock");
    try {
      await fs.writeFile(lockPath, `${JSON.stringify({ pid: process.pid, acquiredAt: isoNow(options.clock) })}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    } catch (error) {
      if (error.code === "EEXIST") throw new LegacyMigrationError(`MusicBrainz cache is locked: ${cacheDir}`, "MUSICBRAINZ_CACHE_LOCKED");
      throw error;
    }
    try {
      const target = path.join(cacheDir, `${key}.json`);
      // Another process may have completed this endpoint immediately before
      // this process acquired the lock. Keep the first complete response.
      try { await fs.access(target); return; } catch (error) { if (error.code !== "ENOENT") throw error; }
      const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
      await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      try { await fs.rename(temporary, target); } catch (error) { await fs.unlink(temporary).catch(() => {}); throw error; }
    } finally {
      await fs.unlink(lockPath).catch((error) => { if (error.code !== "ENOENT") throw error; });
    }
  }

  async function requestEndpoint(endpoint, expectedId = "") {
    const key = endpointKey(endpoint);
    const cached = await cacheRead(key);
    if (cached) {
      if (expectedId && cached.requestedMbid && cached.requestedMbid !== expectedId) {
        throw new LegacyMigrationError(`MusicBrainz cached request mismatch for ${expectedId}`, "MUSICBRAINZ_ID_MISMATCH");
      }
      if (expectedId && !cached.requestedMbid && cached.data && normalizeMbid(cached.data.id) !== expectedId) {
        throw new LegacyMigrationError(`MusicBrainz cached response ID mismatch for ${expectedId}`, "MUSICBRAINZ_ID_MISMATCH");
      }
      stats.cacheHits += 1;
      return cached;
    }
    stats.cacheMisses += 1;
    let response;
    try {
      response = await requestJson(endpoint, {
        fetchFn,
        headers: { "User-Agent": userAgent },
        retries: options.retries,
        timeoutMs: options.timeoutMs,
        retryBaseMs: options.retryBaseMs,
        maximumRetryDelayMs: options.maximumRetryDelayMs,
        sleepFn: options.sleepFn,
        nowMs: options.nowMs,
        beforeAttempt: async () => { await rateGate(); stats.networkRequests += 1; },
      });
    } catch (error) {
      if (error instanceof CatalogFetchError && error.status === 404) {
        const miss = { status: 404, data: null, fetchedAt: isoNow(options.clock) };
        await cacheWrite(key, miss);
        return miss;
      }
      throw new LegacyMigrationError(`MusicBrainz request failed for ${endpoint}`, "MUSICBRAINZ_HYDRATION_FAILED", [{ status: error.status, message: error.message }]);
    }
    const resolvedMbid = normalizeMbid(response.data?.id);
    const finalEndpointMbid = endpointMbid(response.response?.url);
    if (expectedId && resolvedMbid !== expectedId && (!finalEndpointMbid || finalEndpointMbid !== resolvedMbid)) {
      throw new LegacyMigrationError(`MusicBrainz response ID mismatch for ${expectedId}`, "MUSICBRAINZ_ID_MISMATCH");
    }
    const entry = { status: response.response?.status || 200, data: response.data, fetchedAt: isoNow(options.clock), requestedMbid: expectedId || null, resolvedMbid: resolvedMbid || null };
    await cacheWrite(key, entry);
    return entry;
  }

  function url(pathname, params) {
    const value = new URL(`${MUSICBRAINZ_URL}/${pathname}`);
    for (const [key, item] of Object.entries(params || {})) value.searchParams.set(key, item);
    value.searchParams.set("fmt", "json");
    return value.toString();
  }

  async function hydrateReleaseGroup(mbid) {
    const expected = normalizeMbid(mbid);
    if (!expected) throw new LegacyMigrationError("Invalid release-group MBID", "MUSICBRAINZ_INVALID_MBID");
    const entry = await requestEndpoint(url(`release-group/${expected}`, { inc: "artist-credits" }), expected);
    if (!entry.data) return { missing: true, releaseGroupMbid: expected };
    return { ...groupMetadata(entry.data, entry.fetchedAt), requestedMbid: expected, resolvedMbid: entry.resolvedMbid || expected, raw: entry.data };
  }

  async function hydrateRelease(mbid, expectedGroupMbid = "") {
    const expected = normalizeMbid(mbid);
    const group = normalizeMbid(expectedGroupMbid);
    if (!expected) throw new LegacyMigrationError("Invalid release identity", "MUSICBRAINZ_INVALID_MBID");
    const entry = await requestEndpoint(url(`release/${expected}`, { inc: "artist-credits+labels+recordings+release-groups+media" }), expected);
    if (!entry.data) return { missing: true, releaseMbid: expected };
    const metadata = releaseMetadata(entry.data, group, entry.fetchedAt);
    metadata.tracklist = releaseTracklist(entry.data, "");
    return { ...metadata, requestedMbid: expected, resolvedMbid: entry.resolvedMbid || metadata.releaseMbid, raw: entry.data };
  }

  async function lookupProviderUrl(providerUrl) {
    // URLSearchParams performs the single required encoding. Pre-encoding here
    // would send `%25` escapes and make MusicBrainz miss the relationship.
    const entry = await requestEndpoint(url("url", { resource: providerUrl, inc: "release-rels+release-group-rels" }));
    if (!entry.data) return { groups: [], releases: [], fetchedAt: entry.fetchedAt };
    const groups = new Set();
    const releases = new Set();
    for (const relation of entry.data.relations || []) {
      const group = normalizeMbid(relation?.["release-group"]?.id);
      const release = normalizeMbid(relation?.release?.id);
      if (group) groups.add(group);
      if (release) releases.add(release);
    }
    return { groups: [...groups], releases: [...releases], fetchedAt: entry.fetchedAt };
  }

  return { hydrateReleaseGroup, hydrateRelease, lookupProviderUrl, stats };
}

module.exports = {
  DEFAULT_USER_AGENT,
  MAX_TRACKS,
  artistCredits,
  createMusicBrainzClient,
  endpointKey,
  groupMetadata,
  mapReleaseType,
  partialDate,
  releaseMetadata,
  releaseTracklist,
};
