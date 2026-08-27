const MBID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

const MUSICBRAINZ_BASE_URL = "https://musicbrainz.org/ws/2";
const COVER_ART_ARCHIVE_BASE_URL = "https://coverartarchive.org";
const DEFAULT_USER_AGENT = "RescenedCoverResolver/1.0.0 (https://github.com/jkind889/rescened)";
const TRANSIENT_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);

const NETWORK_PROFILES = Object.freeze({
  backfill: Object.freeze({
    timeoutMs: 15_000,
    retries: 3,
    retryBaseMs: 500,
    maximumRetryDelayMs: 30_000,
  }),
  approval: Object.freeze({
    timeoutMs: 3_000,
    retries: 0,
    retryBaseMs: 250,
    maximumRetryDelayMs: 3_000,
  }),
});

const UNRESOLVED_REASONS = Object.freeze([
  "no_identity",
  "conflicting_identity",
  "barcode_ambiguity",
  "metadata_mismatch",
  "no_approved_front",
  "no_500px_image",
  "transient_provider_failure",
  "invalid_response",
  "reference_conflict",
  "concurrent_update",
]);

class CoverArtResolverError extends Error {
  constructor(message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "CoverArtResolverError";
    this.code = options.code || "cover_art_resolver_error";
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function normalizeMbid(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return MBID_PATTERN.test(normalized) ? normalized : "";
}

function normalizeText(value) {
  return String(value || "").normalize("NFC").replace(/\s+/gu, " ").trim();
}

/**
 * This is intentionally the same conservative comparison used for duplicate
 * submission fingerprints: punctuation and accents are not identity. It is
 * only used after MusicBrainz has narrowed a barcode to a single group; it is
 * never used as a free-text provider search.
 */
function normalizeIdentityText(value) {
  return normalizeText(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

function normalizeBarcode(value) {
  const barcode = String(value || "").replace(/[\s-]/gu, "");
  return /^\d{8,14}$/u.test(barcode) ? barcode : "";
}

function isoNow(clock) {
  const value = typeof clock === "function" ? clock() : new Date();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError("clock must return a valid date");
  return date.toISOString();
}

function nowMilliseconds(clock) {
  const value = typeof clock === "function" ? clock() : new Date();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError("clock must return a valid date");
  return date.getTime();
}

function parseRetryAfter(value, nowMs) {
  if (value === null || value === undefined || value === "") return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const date = Date.parse(String(value));
  if (Number.isNaN(date)) return null;
  return Math.max(date - nowMs, 0);
}

function isTransientStatus(status) {
  return TRANSIENT_STATUS_CODES.has(Number(status));
}

function canonicalMusicBrainzUrl(entityType, mbid) {
  const normalized = normalizeMbid(mbid);
  if (!normalized || !["release-group", "release"].includes(entityType)) return "";
  return `https://musicbrainz.org/${entityType}/${normalized}`;
}

function musicBrainzUrlIdentity(value, { allowHttp = false } = {}) {
  if (typeof value !== "string" || !value.trim()) return null;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  const allowedProtocol = parsed.protocol === "https:" || (allowHttp && parsed.protocol === "http:");
  if (!allowedProtocol
    || parsed.hostname.toLowerCase() !== "musicbrainz.org"
    || parsed.port
    || parsed.username
    || parsed.password) return null;
  const match = parsed.pathname.match(/^\/(release-group|release)\/([^/]+)\/?$/iu);
  if (!match) return null;
  const entityType = match[1].toLowerCase();
  let decodedId;
  try {
    decodedId = decodeURIComponent(match[2]);
  } catch {
    return { entityType, externalId: "", invalid: true };
  }
  const externalId = normalizeMbid(decodedId);
  if (!externalId) return { entityType, externalId: "", invalid: true };
  return { entityType, externalId, url: canonicalMusicBrainzUrl(entityType, externalId) };
}

function addReferenceIdentity(identity, groups, releases, state) {
  if (!identity || !["release-group", "release"].includes(identity.entityType)) return;
  if (!identity.externalId) {
    state.invalid = true;
    return;
  }
  const target = identity.entityType === "release-group" ? groups : releases;
  target.add(identity.externalId);
}

/**
 * Extract only canonical MusicBrainz identities. Submitted supporting source
 * URLs are parsed as evidence, but are never fetched by this module.
 */
function extractMusicBrainzReferences(input = {}) {
  input = input && typeof input === "object" ? input : {};
  const groups = new Set();
  const releases = new Set();
  const state = { invalid: false };
  const references = Array.isArray(input.externalReferences) ? input.externalReferences : [];
  for (const reference of references) {
    const provider = normalizeText(reference?.provider).toLowerCase();
    const entityType = normalizeText(reference?.entityType).toLowerCase();
    if (provider === "musicbrainz" && ["release-group", "release"].includes(entityType)) {
      addReferenceIdentity({ entityType, externalId: normalizeMbid(reference?.externalId) }, groups, releases, state);
    }
    addReferenceIdentity(musicBrainzUrlIdentity(reference?.url), groups, releases, state);
  }

  const supportingSources = Array.isArray(input.supportingSources) ? input.supportingSources : [];
  for (const source of supportingSources) {
    addReferenceIdentity(musicBrainzUrlIdentity(typeof source === "string" ? source : source?.url), groups, releases, state);
  }
  // A few callers use `references` as a provider-neutral alias while building
  // an approval payload. Accepting it costs nothing and keeps the resolver
  // independent of the submission model's name.
  const aliases = Array.isArray(input.references) ? input.references : [];
  for (const reference of aliases) {
    const provider = normalizeText(reference?.provider).toLowerCase();
    const entityType = normalizeText(reference?.entityType).toLowerCase();
    if (provider === "musicbrainz" && ["release-group", "release"].includes(entityType)) {
      addReferenceIdentity({ entityType, externalId: normalizeMbid(reference?.externalId) }, groups, releases, state);
    }
    addReferenceIdentity(musicBrainzUrlIdentity(reference?.url), groups, releases, state);
  }

  return {
    releaseGroupMbids: [...groups],
    releaseMbids: [...releases],
    invalid: state.invalid,
  };
}

function metadataFor(input = {}) {
  if (!input || typeof input !== "object") return {};
  if (input.proposedMetadata && typeof input.proposedMetadata === "object") return input.proposedMetadata;
  if (input.metadata && typeof input.metadata === "object") return input.metadata;
  return input;
}

function extractBarcodes(input = {}) {
  input = input && typeof input === "object" ? input : {};
  const barcodes = new Set();
  let invalid = false;
  const addBarcode = (value) => {
    const supplied = String(value || "").trim();
    if (!supplied) return;
    const normalized = normalizeBarcode(supplied);
    if (!normalized) invalid = true;
    else barcodes.add(normalized);
  };
  addBarcode(metadataFor(input).barcode);
  for (const collection of [input.externalReferences, input.references]) {
    if (!Array.isArray(collection)) continue;
    for (const reference of collection) {
      const provider = normalizeText(reference?.provider).toLowerCase();
      const entityType = normalizeText(reference?.entityType).toLowerCase();
      if (provider === "barcode" && (!entityType || entityType === "release")) {
        addBarcode(reference?.externalId);
      }
    }
  }
  return { barcodes: [...barcodes], invalid };
}

function primaryArtistName(input = {}) {
  input = input && typeof input === "object" ? input : {};
  const metadata = metadataFor(input);
  if (Array.isArray(metadata.artistCredits)) {
    const primary = metadata.artistCredits.find((credit) => normalizeText(credit?.role || "main").toLowerCase() === "main")
      || metadata.artistCredits[0];
    const name = normalizeText(primary?.name || primary?.artist?.name || primary);
    if (name) return name;
  }
  return normalizeText(metadata.artistDisplayName || metadata.artist || "");
}

function responseStatus(response) {
  const status = Number(response?.status);
  return Number.isInteger(status) && status > 0 ? status : 200;
}

function responseHeader(response, name) {
  if (typeof response?.headers?.get === "function") return response.headers.get(name);
  const headers = response?.headers || {};
  const wanted = String(name).toLowerCase();
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === wanted);
  return key ? headers[key] : null;
}

async function request(url, options = {}) {
  const fetchFn = options.fetchFn || globalThis.fetch;
  if (typeof fetchFn !== "function") throw new TypeError("A fetch implementation is required");
  const method = options.method || "GET";
  const timeoutMs = options.timeoutMs ?? NETWORK_PROFILES.backfill.timeoutMs;
  const retries = options.retries ?? NETWORK_PROFILES.backfill.retries;
  const retryBaseMs = options.retryBaseMs ?? NETWORK_PROFILES.backfill.retryBaseMs;
  const maximumRetryDelayMs = options.maximumRetryDelayMs ?? NETWORK_PROFILES.backfill.maximumRetryDelayMs;
  const sleepFn = options.sleepFn || sleep;
  const clock = options.clock || (() => new Date());
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (typeof options.beforeAttempt === "function") {
      await options.beforeAttempt({ attempt, method, url });
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchFn(url, {
        method,
        headers: {
          Accept: method === "GET" ? "application/json" : "*/*",
          ...(options.headers || {}),
        },
        signal: controller.signal,
      });
      const status = responseStatus(response);
      const successfulStatus = status >= 200 && status < 300;
      const successfulHeadRedirect = method === "HEAD" && status >= 300 && status < 400;
      if (!response?.ok && !successfulStatus && !successfulHeadRedirect) {
        const error = new CoverArtResolverError(`Provider returned HTTP ${status}: ${url}`, {
          code: isTransientStatus(status) ? "transient_provider_failure" : "provider_http_error",
          status,
          retryAfterMs: parseRetryAfter(responseHeader(response, "retry-after"), nowMilliseconds(clock)),
        });
        if (!isTransientStatus(status) || attempt === retries) throw error;
        lastError = error;
        const delayMs = Math.min(error.retryAfterMs ?? retryBaseMs * (2 ** attempt), maximumRetryDelayMs);
        await sleepFn(delayMs);
        continue;
      }
      if (method === "HEAD") return { response, status, attempts: attempt + 1 };
      if (typeof response.json !== "function") {
        throw new CoverArtResolverError(`Provider response was not JSON: ${url}`, { code: "invalid_response", status });
      }
      let data;
      try {
        data = await response.json();
      } catch (cause) {
        throw new CoverArtResolverError(`Provider response was not valid JSON: ${url}`, {
          cause,
          code: "invalid_response",
          status,
        });
      }
      return { data, response, status, attempts: attempt + 1 };
    } catch (error) {
      const normalized = error instanceof CoverArtResolverError
        ? error
        : new CoverArtResolverError(
          controller.signal.aborted ? `Provider request timed out after ${timeoutMs}ms: ${url}` : `Provider request failed: ${url}`,
          { cause: error, code: controller.signal.aborted ? "transient_provider_failure" : "transient_provider_failure" },
        );
      if (normalized.code !== "transient_provider_failure" || attempt === retries) throw normalized;
      lastError = normalized;
      await sleepFn(Math.min(retryBaseMs * (2 ** attempt), maximumRetryDelayMs));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError || new CoverArtResolverError(`Provider request failed: ${url}`, { code: "transient_provider_failure" });
}

function createRateGate(options = {}) {
  const intervalMs = options.intervalMs ?? 1_000;
  const nowMs = options.nowMs || (() => Date.now());
  const sleepFn = options.sleepFn || sleep;
  let lastStartedAt = null;
  let queue = Promise.resolve();
  return function waitForSlot() {
    const turn = queue.then(async () => {
      if (lastStartedAt !== null) {
        const waitMs = intervalMs - (nowMs() - lastStartedAt);
        if (waitMs > 0) await sleepFn(waitMs);
      }
      lastStartedAt = nowMs();
    });
    queue = turn.catch(() => {});
    return turn;
  };
}

let sharedMusicBrainzRateGate;

function getSharedMusicBrainzRateGate() {
  if (!sharedMusicBrainzRateGate) sharedMusicBrainzRateGate = createRateGate({ intervalMs: 1_000 });
  return sharedMusicBrainzRateGate;
}

function mbSearchUrl(barcode, baseUrl) {
  const endpointBase = String(baseUrl || MUSICBRAINZ_BASE_URL).replace(/\/+$/u, "");
  const url = new URL(`${endpointBase}/release`);
  url.searchParams.set("query", `barcode:${barcode}`);
  url.searchParams.set("limit", "100");
  url.searchParams.set("fmt", "json");
  return url.toString();
}

function caaUrl(entityType, mbid, baseUrl) {
  const normalized = normalizeMbid(mbid);
  if (!normalized || !["release-group", "release"].includes(entityType)) return "";
  const endpointBase = String(baseUrl || COVER_ART_ARCHIVE_BASE_URL).replace(/\/+$/u, "");
  return `${endpointBase}/${entityType}/${normalized}`;
}

function caaCoverUrl(releaseMbid) {
  const normalized = normalizeMbid(releaseMbid);
  if (!normalized) return "";
  // Persist one canonical public URL regardless of test/proxy endpoint
  // overrides used for provider calls.
  return `${COVER_ART_ARCHIVE_BASE_URL}/release/${normalized}/front-500`;
}

function normalizeImageId(value) {
  if (Number.isSafeInteger(value) && value >= 1) return value;
  if (typeof value === "string" && /^[1-9]\d*$/u.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function chooseFrontImage(data) {
  if (!data || typeof data !== "object" || !Array.isArray(data.images)) {
    return { kind: "invalid_response" };
  }
  const approvedFronts = data.images.filter((image) => (
    image && image.approved === true
    && (image.front === true || (Array.isArray(image.types) && image.types.some((type) => String(type).toLowerCase() === "front")))
  ));
  if (!approvedFronts.length) return { kind: "no_approved_front" };
  // Older CAA index documents expose the 500px thumbnail only through the
  // deprecated `large` alias. It is the same rendition, so it still satisfies
  // the 500px requirement before we HEAD the canonical /front-500 endpoint.
  const has500pxThumbnail = (image) => Boolean(
    image?.thumbnails?.["500"] || image?.thumbnails?.large,
  );
  const candidate = approvedFronts.find(has500pxThumbnail)
    || approvedFronts[0];
  if (!has500pxThumbnail(candidate)) return { kind: "no_500px_image" };
  // `image` is commonly the large Internet Archive URL while `id` is the
  // stable numeric CAA image identity. Never persist or HEAD the former.
  const imageId = normalizeImageId(candidate.id ?? candidate.image);
  if (imageId === null) return { kind: "invalid_response" };
  return { kind: "ok", imageId };
}

function releaseIdsFromCaaGroup(data) {
  const releases = Array.isArray(data?.releases) ? data.releases : [];
  // The CAA API has returned both `releases[]` and a singular `release` URL
  // over time. Accept both shapes, but only retain valid MusicBrainz IDs.
  const singular = data?.release;
  const values = singular === undefined ? releases : [...releases, singular];
  return values.map((release) => {
    if (typeof release === "string") {
      return normalizeMbid(musicBrainzUrlIdentity(release, { allowHttp: true })?.externalId) || normalizeMbid(release);
    }
    return normalizeMbid(release?.id) || normalizeMbid(musicBrainzUrlIdentity(release?.url, { allowHttp: true })?.externalId);
  }).filter(Boolean);
}

function exactBarcodeCandidate(data, input, barcode) {
  if (!data || typeof data !== "object" || !Array.isArray(data.releases)) return { kind: "invalid_response" };
  if (!data.releases.length) return { kind: "no_identity" };
  const count = Number(data.count);
  if (Number.isFinite(count) && count > data.releases.length) return { kind: "invalid_response" };
  const groups = new Set();
  const rows = [];
  for (const release of data.releases) {
    const releaseMbid = normalizeMbid(release?.id);
    const groupMbid = normalizeMbid(release?.["release-group"]?.id || release?.releaseGroup?.id);
    const title = normalizeText(release?.title);
    const credits = release?.["artist-credit"];
    const primaryArtist = Array.isArray(credits) ? normalizeText(credits[0]?.name || credits[0]?.artist?.name) : "";
    if (!releaseMbid
      || !groupMbid
      || !title
      || !primaryArtist
      || (release?.barcode !== undefined && normalizeBarcode(release.barcode) !== barcode)) {
      return { kind: "invalid_response" };
    }
    groups.add(groupMbid);
    rows.push({ releaseMbid, groupMbid, title, primaryArtist });
  }
  if (groups.size !== 1) return { kind: "barcode_ambiguity", groupMbids: [...groups] };
  const title = normalizeIdentityText(metadataFor(input).title);
  const artist = normalizeIdentityText(primaryArtistName(input));
  if (!title || !artist || rows.some((row) => normalizeIdentityText(row.title) !== title || normalizeIdentityText(row.primaryArtist) !== artist)) {
    return { kind: "metadata_mismatch", groupMbid: [...groups][0] };
  }
  return { kind: "ok", groupMbid: [...groups][0], releaseMbids: rows.map((row) => row.releaseMbid) };
}

function resolvedOutcome({ cover, provenance, derivedReferences }) {
  return {
    status: "resolved",
    resolved: true,
    cover,
    releaseGroupMbid: provenance?.releaseGroupMbid || null,
    releaseMbid: provenance?.releaseMbid || null,
    provenance,
    derivedReferences,
    reason: null,
  };
}

function unresolvedOutcome(reason, details = {}) {
  const normalizedReason = UNRESOLVED_REASONS.includes(reason) ? reason : "invalid_response";
  return {
    status: "unresolved",
    resolved: false,
    cover: "",
    provenance: null,
    derivedReferences: [],
    reason: normalizedReason,
    ...details,
  };
}

function identityReferences(groupMbid, releaseMbid) {
  const refs = [];
  if (groupMbid) refs.push({
    provider: "musicbrainz",
    entityType: "release-group",
    externalId: groupMbid,
    url: canonicalMusicBrainzUrl("release-group", groupMbid),
  });
  if (releaseMbid) refs.push({
    provider: "musicbrainz",
    entityType: "release",
    externalId: releaseMbid,
    url: canonicalMusicBrainzUrl("release", releaseMbid),
  });
  return refs;
}

function extractedIdentityReferences(references) {
  return mergeIdentityReferences(
    ...references.releaseGroupMbids.map((mbid) => identityReferences(mbid, "")),
    ...references.releaseMbids.map((mbid) => identityReferences("", mbid)),
  );
}

function mergeIdentityReferences(...collections) {
  const references = [];
  const seen = new Set();
  for (const collection of collections) {
    for (const reference of Array.isArray(collection) ? collection : []) {
      const key = `${reference.provider}|${reference.entityType}|${String(reference.externalId).toLowerCase()}`;
      if (!seen.has(key)) {
        seen.add(key);
        references.push(reference);
      }
    }
  }
  return references;
}

function providerErrorOutcome(error, derivedReferences = [], identity = {}) {
  if (error instanceof CoverArtResolverError) {
    const reason = error.code === "transient_provider_failure" ? "transient_provider_failure" : "invalid_response";
    return unresolvedOutcome(reason, {
      ...identity,
      derivedReferences,
      details: { status: error.status, message: error.message },
    });
  }
  throw error;
}

function createCoverArtResolver(options = {}) {
  const fetchFn = options.fetchFn || globalThis.fetch;
  const sleepFn = options.sleepFn || sleep;
  const clock = options.clock || (() => new Date());
  const userAgent = normalizeText(options.userAgent || process.env.MUSICBRAINZ_USER_AGENT || DEFAULT_USER_AGENT);
  if (!userAgent || !/[(/@]/u.test(userAgent)) throw new TypeError("MusicBrainz user agent must identify the application");
  const hasInjectedTiming = Boolean(
    options.fetchFn
    || options.sleepFn
    || options.clock
    || options.musicBrainzIntervalMs !== undefined,
  );
  const rateGate = options.rateGate || (hasInjectedTiming
    ? createRateGate({
      intervalMs: options.musicBrainzIntervalMs ?? 1_000,
      nowMs: () => nowMilliseconds(clock),
      sleepFn,
    })
    : getSharedMusicBrainzRateGate());
  const stats = { musicBrainzRequests: 0, coverArtArchiveRequests: 0, retries: 0 };

  function profileFor(requestOptions = {}) {
    const profileName = requestOptions.profile
      || requestOptions.mode
      || requestOptions.purpose
      || options.profile
      || options.mode
      || options.purpose
      || "backfill";
    const profile = NETWORK_PROFILES[profileName] || NETWORK_PROFILES.backfill;
    return {
      ...profile,
      timeoutMs: requestOptions.timeoutMs ?? options.timeoutMs ?? profile.timeoutMs,
      retries: requestOptions.retries ?? options.retries ?? profile.retries,
      retryBaseMs: requestOptions.retryBaseMs ?? options.retryBaseMs ?? profile.retryBaseMs,
      maximumRetryDelayMs: requestOptions.maximumRetryDelayMs ?? options.maximumRetryDelayMs ?? profile.maximumRetryDelayMs,
    };
  }

  async function requestJson(url, requestOptions = {}) {
    const profile = profileFor(requestOptions);
    try {
      return await request(url, {
        ...profile,
        fetchFn,
        sleepFn,
        clock,
        headers: requestOptions.headers,
        beforeAttempt: requestOptions.beforeAttempt,
      });
    } catch (error) {
      if (error.code === "transient_provider_failure") stats.retries += 1;
      throw error;
    }
  }

  async function lookupBarcode(barcode, requestOptions) {
    const url = mbSearchUrl(barcode, options.musicBrainzBaseUrl);
    const result = await requestJson(url, {
      ...requestOptions,
      headers: { "User-Agent": userAgent },
      beforeAttempt: async () => {
        await rateGate();
        stats.musicBrainzRequests += 1;
      },
    });
    return exactBarcodeCandidate(result.data, requestOptions.input, barcode);
  }

  async function inspectCaa(entityType, entityMbid, resolutionMethod, input, requestOptions) {
    const endpoint = caaUrl(entityType, entityMbid, options.coverArtArchiveBaseUrl);
    const requestedGroupMbid = entityType === "release-group" ? normalizeMbid(entityMbid) : normalizeMbid(requestOptions.groupMbid);
    const requestedReleaseMbid = entityType === "release" ? normalizeMbid(entityMbid) : normalizeMbid(requestOptions.releaseMbid);
    const requestedReferences = mergeIdentityReferences(
      requestOptions.derivedReferences,
      identityReferences(requestedGroupMbid, requestedReleaseMbid),
    );
    stats.coverArtArchiveRequests += 1;
    let result;
    try {
      result = await requestJson(endpoint, requestOptions);
    } catch (error) {
      if (error.status === 404) {
        return unresolvedOutcome("no_approved_front", {
          releaseGroupMbid: requestedGroupMbid || null,
          releaseMbid: requestedReleaseMbid || null,
          derivedReferences: requestedReferences,
        });
      }
      return providerErrorOutcome(error, requestedReferences, {
        releaseGroupMbid: requestedGroupMbid || null,
        releaseMbid: requestedReleaseMbid || null,
      });
    }

    // A release endpoint is already anchored to the source release. A group
    // endpoint must name exactly one source release. The submitted release
    // hint is identity evidence, never a substitute for CAA's source release.
    let sourceReleaseMbid = entityType === "release" ? normalizeMbid(entityMbid) : "";
    const groupMbid = requestedGroupMbid;
    const responseReleaseMbids = [...new Set(releaseIdsFromCaaGroup(result.data))];
    if (entityType === "release-group") {
      if (responseReleaseMbids.length !== 1) {
        return unresolvedOutcome("invalid_response", { derivedReferences: requestedReferences });
      }
      sourceReleaseMbid = responseReleaseMbids[0];
    } else if (responseReleaseMbids.length && (responseReleaseMbids.length !== 1 || responseReleaseMbids[0] !== sourceReleaseMbid)) {
      return unresolvedOutcome("invalid_response", { derivedReferences: requestedReferences });
    }
    if (!sourceReleaseMbid) return unresolvedOutcome("invalid_response", { details: "Cover Art Archive group has no release identity" });
    const derivedReferences = mergeIdentityReferences(
      requestedReferences,
      identityReferences(groupMbid, sourceReleaseMbid),
    );
    const identity = {
      releaseGroupMbid: groupMbid || null,
      releaseMbid: sourceReleaseMbid,
      derivedReferences,
    };
    const image = chooseFrontImage(result.data);
    if (image.kind !== "ok") return unresolvedOutcome(image.kind, identity);
    const cover = caaCoverUrl(sourceReleaseMbid, options.coverArtArchiveBaseUrl);
    if (!cover) return unresolvedOutcome("invalid_response", identity);
    let head;
    try {
      head = await request(cover, {
        ...profileFor(requestOptions),
        fetchFn,
        sleepFn,
        clock,
        method: "HEAD",
      });
    } catch (error) {
      if (error.status === 404) return unresolvedOutcome("no_500px_image", identity);
      return providerErrorOutcome(error, derivedReferences, identity);
    }
    if (!(head.status >= 200 && head.status < 400)) return unresolvedOutcome("no_500px_image", identity);
    const contentType = responseHeader(head.response, "content-type");
    if (!contentType || !/^image\//iu.test(String(contentType))) return unresolvedOutcome("invalid_response", identity);
    const verifiedAt = isoNow(clock);
    return resolvedOutcome({
      cover,
      provenance: {
        source: "cover-art-archive",
        resolutionMethod,
        method: resolutionMethod === "release-group-reference"
          ? "release-group"
          : resolutionMethod === "release-reference" ? "release" : resolutionMethod,
        releaseGroupMbid: groupMbid || null,
        releaseMbid: sourceReleaseMbid,
        imageId: image.imageId,
        size: 500,
        canonicalUrl: cover,
        verifiedAt,
      },
      derivedReferences,
    });
  }

  async function resolve(input = {}, requestOptions = {}) {
    input = input && typeof input === "object" ? input : {};
    const references = extractMusicBrainzReferences(input);
    const barcodeIdentities = extractBarcodes(input);
    if (references.invalid || barcodeIdentities.invalid) {
      return unresolvedOutcome("conflicting_identity", { details: "invalid MusicBrainz or barcode identity" });
    }
    if (references.releaseGroupMbids.length > 1
      || (references.releaseGroupMbids.length === 0 && references.releaseMbids.length > 1)) {
      return unresolvedOutcome("conflicting_identity", { details: "multiple MusicBrainz identities" });
    }
    if (barcodeIdentities.barcodes.length > 1) {
      return unresolvedOutcome("conflicting_identity", { details: "multiple barcode identities" });
    }
    const context = { ...requestOptions, input };
    try {
      if (references.releaseGroupMbids.length === 1) {
        return await inspectCaa("release-group", references.releaseGroupMbids[0], "release-group-reference", input, {
          ...context,
          releaseMbid: "",
          derivedReferences: extractedIdentityReferences(references),
        });
      }
      if (references.releaseMbids.length === 1) {
        return await inspectCaa("release", references.releaseMbids[0], "release-reference", input, context);
      }

      const barcode = barcodeIdentities.barcodes[0] || "";
      if (!barcode) return unresolvedOutcome("no_identity", { details: "no exact MusicBrainz identity or barcode" });
      const barcodeResult = await lookupBarcode(barcode, context);
      if (barcodeResult.kind !== "ok") return unresolvedOutcome(barcodeResult.kind, { details: barcodeResult });
      const releaseMbids = [...new Set(barcodeResult.releaseMbids)];
      const barcodeReferences = identityReferences(
        barcodeResult.groupMbid,
        releaseMbids.length === 1 ? releaseMbids[0] : "",
      );
      return await inspectCaa("release-group", barcodeResult.groupMbid, "barcode", input, {
        ...context,
        releaseMbid: "",
        derivedReferences: barcodeReferences,
      });
    } catch (error) {
      if (error instanceof CoverArtResolverError) {
        if (error.code === "transient_provider_failure") return unresolvedOutcome("transient_provider_failure", { details: { status: error.status, message: error.message } });
        if (error.code === "invalid_response") return unresolvedOutcome("invalid_response", { details: error.message });
        return unresolvedOutcome("invalid_response", { details: { status: error.status, message: error.message } });
      }
      throw error;
    }
  }

  return { resolve, lookupBarcode, stats };
}

async function resolveCoverArt(input, options = {}) {
  const resolver = createCoverArtResolver(options);
  return resolver.resolve(input, options);
}

module.exports = {
  COVER_ART_ARCHIVE_BASE_URL,
  DEFAULT_USER_AGENT,
  MUSICBRAINZ_BASE_URL,
  NETWORK_PROFILES,
  TRANSIENT_STATUS_CODES,
  UNRESOLVED_REASONS,
  CoverArtResolverError,
  caaCoverUrl,
  canonicalMusicBrainzUrl,
  createCoverArtResolver,
  createResolver: createCoverArtResolver,
  createRateGate,
  extractMusicBrainzReferences,
  extractBarcodes,
  mbSearchUrl,
  normalizeBarcode,
  normalizeIdentityText,
  normalizeMbid,
  resolveCoverArt,
  resolveCoverArtArchive: resolveCoverArt,
};
