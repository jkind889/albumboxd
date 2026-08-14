const crypto = require("node:crypto");
const mongoose = require("mongoose");
const AlbumCatalog = require("../../models/AlbumCatalog");
const AlbumSubmission = require("../../models/AlbumSubmission");

const RELEASE_TYPES = new Set([
  "album",
  "ep",
  "single",
  "mixtape",
  "soundtrack",
  "compilation",
  "live",
  "remix",
  "other",
]);
const SOURCE_TYPES = new Set([
  "musicbrainz",
  "official_artist",
  "official_label",
  "distributor",
  "store",
  "spotify",
  "other",
]);
const ACTIVE_STATUSES = ["pending", "needs_changes"];
const DEFAULT_PAGE_LIMIT = 20;
const MAX_PAGE_LIMIT = 50;

class SubmissionValidationError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = "SubmissionValidationError";
    this.status = 400;
    this.code = "INVALID_SUBMISSION";
    this.details = details.length ? details : [message];
  }
}

function fail(message) {
  throw new SubmissionValidationError(message);
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date);
}

function assertRecord(value, path) {
  if (!isRecord(value)) fail(`${path} must be an object`);
}

function assertKeys(value, allowed, path) {
  Object.keys(value).forEach((key) => {
    if (!allowed.has(key)) fail(`${path}.${key} is not allowed`);
  });
}

function requiredString(value, path, maxLength) {
  if (typeof value !== "string") fail(`${path} is required`);
  const result = value.trim();
  if (!result) fail(`${path} is required`);
  if (result.length > maxLength) fail(`${path} must be ${maxLength} characters or fewer`);
  return result;
}

function optionalString(value, path, maxLength) {
  if (value === undefined) return "";
  if (typeof value !== "string") fail(`${path} must be a string`);
  const result = value.trim();
  if (result.length > maxLength) fail(`${path} must be ${maxLength} characters or fewer`);
  return result;
}

function httpsUrl(value, path, { required = false } = {}) {
  if (value === undefined && !required) return "";
  if (typeof value !== "string") fail(`${path} must be an https URL`);
  const input = value.trim();
  if (!input && !required) return "";
  try {
    const parsed = new URL(input);
    if (parsed.protocol !== "https:") throw new Error("protocol");
    return parsed.toString();
  } catch {
    fail(`${path} must be an https URL`);
  }
}

function normalizeArtistCredits(value) {
  if (!Array.isArray(value) || value.length < 1) fail("proposedMetadata.artistCredits must contain at least one artist");
  if (value.length > 20) fail("proposedMetadata.artistCredits may contain at most twenty artists");
  return value.map((credit, index) => {
    const path = `proposedMetadata.artistCredits[${index}]`;
    assertRecord(credit, path);
    assertKeys(credit, new Set(["name", "role"]), path);
    return {
      name: requiredString(credit.name, `${path}.name`, 200),
      role: optionalString(credit.role, `${path}.role`, 80) || "main",
    };
  });
}

function normalizeReleaseDate(metadata) {
  const suppliedDate = optionalString(metadata.releaseDate, "proposedMetadata.releaseDate", 10);
  let releaseYear = metadata.releaseYear;
  if (releaseYear !== undefined) {
    if (!Number.isInteger(releaseYear) || releaseYear < 1 || releaseYear > 9999) {
      fail("proposedMetadata.releaseYear must be an integer from 1 to 9999");
    }
  }

  let releaseDate = suppliedDate;
  if (!releaseDate && releaseYear !== undefined) releaseDate = String(releaseYear).padStart(4, "0");
  if (!releaseDate || !/^\d{4}(?:-\d{2})?(?:-\d{2})?$/.test(releaseDate)) {
    fail("proposedMetadata.releaseDate or releaseYear must be a YYYY, YYYY-MM, or YYYY-MM-DD value");
  }
  const precision = releaseDate.length === 4 ? "year" : releaseDate.length === 7 ? "month" : "day";
  const derivedYear = Number(releaseDate.slice(0, 4));
  if (releaseYear !== undefined && releaseYear !== derivedYear) {
    fail("proposedMetadata.releaseYear must match releaseDate");
  }
  if (metadata.releaseDatePrecision !== undefined && metadata.releaseDatePrecision !== precision) {
    fail("proposedMetadata.releaseDatePrecision must match releaseDate");
  }
  if (precision !== "year") {
    const month = Number(releaseDate.slice(5, 7));
    if (month < 1 || month > 12) fail("proposedMetadata.releaseDate has an invalid month");
  }
  if (precision === "day") {
    const day = Number(releaseDate.slice(8, 10));
    if (day < 1 || day > 31) fail("proposedMetadata.releaseDate has an invalid day");
    const parsedDate = new Date(`${releaseDate}T00:00:00.000Z`);
    if (Number.isNaN(parsedDate.getTime())
      || parsedDate.getUTCFullYear() !== derivedYear
      || parsedDate.getUTCMonth() + 1 !== Number(releaseDate.slice(5, 7))
      || parsedDate.getUTCDate() !== day) {
      fail("proposedMetadata.releaseDate has an invalid day");
    }
  }
  return { releaseDate, releaseDatePrecision: precision, releaseYear: derivedYear };
}

function normalizeTracks(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail("proposedMetadata.tracks must be an array");
  if (value.length > 200) fail("proposedMetadata.tracks may contain at most two hundred tracks");
  return value.map((track, index) => {
    const path = `proposedMetadata.tracks[${index}]`;
    assertRecord(track, path);
    assertKeys(track, new Set(["discNumber", "trackNumber", "title", "durationMs", "artistDisplayName"]), path);
    const discNumber = track.discNumber === undefined ? 1 : track.discNumber;
    const trackNumber = track.trackNumber === undefined ? index + 1 : track.trackNumber;
    const durationMs = track.durationMs === undefined ? 0 : track.durationMs;
    if (!Number.isInteger(discNumber) || discNumber < 1 || discNumber > 999) fail(`${path}.discNumber is invalid`);
    if (!Number.isInteger(trackNumber) || trackNumber < 1 || trackNumber > 999) fail(`${path}.trackNumber is invalid`);
    if (!Number.isInteger(durationMs) || durationMs < 0 || durationMs > 86400000) fail(`${path}.durationMs is invalid`);
    return {
      discNumber,
      trackNumber,
      title: requiredString(track.title, `${path}.title`, 200),
      durationMs,
      artistDisplayName: optionalString(track.artistDisplayName, `${path}.artistDisplayName`, 300),
    };
  });
}

function normalizeMetadata(input) {
  assertRecord(input, "proposedMetadata");
  assertKeys(input, new Set([
    "title",
    "artistDisplayName",
    "artistCredits",
    "releaseType",
    "releaseDate",
    "releaseDatePrecision",
    "releaseYear",
    "label",
    "country",
    "catalogNumber",
    "barcode",
    "tracks",
    "coverSourceUrl",
  ]), "proposedMetadata");
  const artistCredits = normalizeArtistCredits(input.artistCredits);
  const artistDisplayName = optionalString(input.artistDisplayName, "proposedMetadata.artistDisplayName", 300)
    || artistCredits.map((credit) => credit.name).join(" & ");
  const releaseDate = normalizeReleaseDate(input);
  const releaseType = requiredString(input.releaseType, "proposedMetadata.releaseType", 30).toLowerCase();
  if (!RELEASE_TYPES.has(releaseType)) fail("proposedMetadata.releaseType is invalid");
  let barcode = optionalString(input.barcode, "proposedMetadata.barcode", 32).replace(/[\s-]/g, "");
  if (barcode && !/^\d{8,14}$/.test(barcode)) fail("proposedMetadata.barcode must contain 8 to 14 digits");
  return {
    title: requiredString(input.title, "proposedMetadata.title", 200),
    artistDisplayName,
    artistCredits,
    releaseType,
    ...releaseDate,
    label: optionalString(input.label, "proposedMetadata.label", 200),
    country: optionalString(input.country, "proposedMetadata.country", 100),
    catalogNumber: optionalString(input.catalogNumber, "proposedMetadata.catalogNumber", 100),
    barcode,
    tracks: normalizeTracks(input.tracks),
    coverSourceUrl: httpsUrl(input.coverSourceUrl, "proposedMetadata.coverSourceUrl"),
  };
}

function normalizeSources(value) {
  if (!Array.isArray(value) || value.length < 1) fail("supportingSources must contain at least one source");
  if (value.length > 10) fail("supportingSources may contain at most ten sources");
  return value.map((source, index) => {
    const path = `supportingSources[${index}]`;
    assertRecord(source, path);
    assertKeys(source, new Set(["type", "url", "description"]), path);
    const type = requiredString(source.type, `${path}.type`, 40).toLowerCase();
    if (!SOURCE_TYPES.has(type)) fail(`${path}.type is invalid`);
    return {
      type,
      url: httpsUrl(source.url, `${path}.url`, { required: true }),
      description: optionalString(source.description, `${path}.description`, 200),
    };
  });
}

function normalizeExternalReferences(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail("externalReferences must be an array");
  if (value.length > 20) fail("externalReferences may contain at most twenty references");
  const seen = new Set();
  return value.map((reference, index) => {
    const path = `externalReferences[${index}]`;
    assertRecord(reference, path);
    assertKeys(reference, new Set(["provider", "entityType", "externalId", "url"]), path);
    const provider = requiredString(reference.provider, `${path}.provider`, 50).toLowerCase();
    if (provider === "spotify") fail("Spotify references must be supplied as supporting evidence");
    const entityType = requiredString(reference.entityType, `${path}.entityType`, 50).toLowerCase();
    const externalId = requiredString(reference.externalId, `${path}.externalId`, 200);
    const key = `${provider}|${entityType}|${externalId}`;
    if (seen.has(key)) fail(`${path} duplicates another external reference`);
    seen.add(key);
    return { provider, entityType, externalId, url: httpsUrl(reference.url, `${path}.url`) };
  });
}

function normalizeSubmissionPayload(body) {
  assertRecord(body, "request body");
  assertKeys(body, new Set(["proposedMetadata", "supportingSources", "externalReferences"]), "request body");
  return {
    proposedMetadata: normalizeMetadata(body.proposedMetadata),
    supportingSources: normalizeSources(body.supportingSources),
    externalReferences: normalizeExternalReferences(body.externalReferences),
  };
}

function canonicalText(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizedFingerprint(metadata) {
  const artists = metadata.artistCredits.map((credit) => canonicalText(credit.name)).sort();
  const value = [canonicalText(metadata.title), artists.join(","), metadata.releaseType, metadata.releaseYear].join("|");
  return crypto.createHash("sha256").update(value).digest("hex");
}

function withSession(query, session) {
  if (session && query && typeof query.session === "function") return query.session(session);
  return query;
}

async function resolveRows(query, limit, session) {
  query = withSession(query, session);
  let result = query;
  if (result && typeof result.limit === "function") result = result.limit(limit);
  if (result && typeof result.exec === "function") result = result.exec();
  return (await result) || [];
}

function externalReferenceConditions(externalReferences) {
  return externalReferences.map((reference) => ({
    externalReferences: {
      $elemMatch: {
        provider: reference.provider,
        entityType: reference.entityType,
        externalId: reference.externalId,
      },
    },
  }));
}

function addSignal(signals, signal) {
  const key = `${signal.targetType}|${signal.matchType}|${signal.key}`;
  if (!signals.some((item) => `${item.targetType}|${item.matchType}|${item.key}` === key)) signals.push(signal);
}

async function findDuplicateSignals(payload, { excludeSubmissionId, session } = {}) {
  const fingerprint = normalizedFingerprint(payload.proposedMetadata);
  const signals = [];
  let candidateAlbumCatalogId = null;
  const candidateSubmissionIds = [];
  const referenceConditions = externalReferenceConditions(payload.externalReferences);
  const catalogConditions = [...referenceConditions];
  if (payload.proposedMetadata.barcode) {
    catalogConditions.push({ externalReferences: { $elemMatch: { provider: "barcode", entityType: "release", externalId: payload.proposedMetadata.barcode } } });
  }
  if (payload.proposedMetadata.catalogNumber) {
    catalogConditions.push({ externalReferences: { $elemMatch: { provider: "catalog_number", entityType: "release", externalId: payload.proposedMetadata.catalogNumber } } });
  }
  if (catalogConditions.length) {
    const catalogRows = await resolveRows(AlbumCatalog.find({ $or: catalogConditions }), 20, session);
    catalogRows.forEach((album) => {
      const references = Array.isArray(album.externalReferences) ? album.externalReferences : [];
      payload.externalReferences.forEach((reference) => {
        const matched = references.some((candidate) => (
          candidate.provider === reference.provider
          && candidate.entityType === reference.entityType
          && candidate.externalId === reference.externalId
        ));
        if (matched) {
          if (!candidateAlbumCatalogId) candidateAlbumCatalogId = album._id;
          addSignal(signals, {
            targetType: "catalog",
            matchType: "external_reference",
            key: `${reference.provider}:${reference.entityType}:${reference.externalId}`,
            albumCatalogId: album._id,
          });
        }
      });
      if (payload.proposedMetadata.barcode && references.some((reference) => (
        reference.provider === "barcode" && reference.entityType === "release" && reference.externalId === payload.proposedMetadata.barcode
      ))) {
        if (!candidateAlbumCatalogId) candidateAlbumCatalogId = album._id;
        addSignal(signals, { targetType: "catalog", matchType: "barcode", key: payload.proposedMetadata.barcode, albumCatalogId: album._id });
      }
      if (payload.proposedMetadata.catalogNumber && references.some((reference) => (
        reference.provider === "catalog_number" && reference.entityType === "release" && reference.externalId === payload.proposedMetadata.catalogNumber
      ))) {
        if (!candidateAlbumCatalogId) candidateAlbumCatalogId = album._id;
        addSignal(signals, { targetType: "catalog", matchType: "catalog_number", key: payload.proposedMetadata.catalogNumber, albumCatalogId: album._id });
      }
    });
  }

  const catalogRows = await resolveRows(
    AlbumCatalog.find({ releaseType: payload.proposedMetadata.releaseType, releaseYear: payload.proposedMetadata.releaseYear }),
    100,
    session,
  );
  catalogRows.forEach((album) => {
    const credits = Array.isArray(album.artistCredits) ? album.artistCredits : [];
    const albumFingerprint = normalizedFingerprint({
      title: album.title,
      artistCredits: credits.length ? credits : [{ name: album.artistDisplayName }],
      releaseType: album.releaseType,
      releaseYear: album.releaseYear,
    });
    if (albumFingerprint === fingerprint) {
      if (!candidateAlbumCatalogId) candidateAlbumCatalogId = album._id;
      addSignal(signals, { targetType: "catalog", matchType: "fingerprint", key: fingerprint, albumCatalogId: album._id });
    }
  });

  const submissionConditions = [
    { normalizedFingerprint: fingerprint },
    ...referenceConditions,
  ];
  if (payload.proposedMetadata.barcode) submissionConditions.push({ "proposedMetadata.barcode": payload.proposedMetadata.barcode });
  if (payload.proposedMetadata.catalogNumber) submissionConditions.push({ "proposedMetadata.catalogNumber": payload.proposedMetadata.catalogNumber });
  const submissionQuery = { status: { $in: ACTIVE_STATUSES }, $or: submissionConditions };
  if (excludeSubmissionId) submissionQuery._id = { $ne: excludeSubmissionId };
  const submissionRows = await resolveRows(AlbumSubmission.find(submissionQuery), 20, session);
  submissionRows.forEach((submission) => {
    if (candidateSubmissionIds.length < 10) candidateSubmissionIds.push(submission._id);
    if (submission.normalizedFingerprint === fingerprint) addSignal(signals, {
      targetType: "submission",
      matchType: "fingerprint",
      key: fingerprint,
      submissionId: submission._id,
    });
    const references = Array.isArray(submission.externalReferences) ? submission.externalReferences : [];
    payload.externalReferences.forEach((reference) => {
      if (references.some((candidate) => (
        candidate.provider === reference.provider
        && candidate.entityType === reference.entityType
        && candidate.externalId === reference.externalId
      ))) addSignal(signals, {
        targetType: "submission",
        matchType: "external_reference",
        key: `${reference.provider}:${reference.entityType}:${reference.externalId}`,
        submissionId: submission._id,
      });
    });
    if (payload.proposedMetadata.barcode && submission.proposedMetadata?.barcode === payload.proposedMetadata.barcode) addSignal(signals, {
      targetType: "submission",
      matchType: "barcode",
      key: payload.proposedMetadata.barcode,
      submissionId: submission._id,
    });
    if (payload.proposedMetadata.catalogNumber && submission.proposedMetadata?.catalogNumber === payload.proposedMetadata.catalogNumber) addSignal(signals, {
      targetType: "submission",
      matchType: "catalog_number",
      key: payload.proposedMetadata.catalogNumber,
      submissionId: submission._id,
    });
  });

  return { fingerprint, candidateAlbumCatalogId, candidateSubmissionIds, duplicateSignals: signals.slice(0, 20) };
}

function snapshotForSubmission(payload, duplicate, submittedAt, revision) {
  return {
    revision,
    submittedAt,
    proposedMetadata: payload.proposedMetadata,
    supportingSources: payload.supportingSources,
    externalReferences: payload.externalReferences,
    normalizedFingerprint: duplicate.fingerprint,
    candidateAlbumCatalogId: duplicate.candidateAlbumCatalogId,
    candidateSubmissionIds: duplicate.candidateSubmissionIds,
    duplicateSignals: duplicate.duplicateSignals,
  };
}

function plain(value) {
  return typeof value?.toObject === "function" ? value.toObject() : value;
}

function publicAlbumId(value) {
  const source = plain(value);
  return source?.albumId || "";
}

function publicSnapshot(value) {
  const source = plain(value);
  const result = {
    revision: source.revision,
    submittedAt: source.submittedAt,
    proposedMetadata: source.proposedMetadata,
    supportingSources: source.supportingSources || [],
    externalReferences: source.externalReferences || [],
    candidateAlbumId: publicAlbumId(source.candidateAlbumCatalogId) || undefined,
  };
  if (!result.candidateAlbumId) delete result.candidateAlbumId;
  return result;
}

function serializeSubmission(value, { detail = false } = {}) {
  const source = plain(value) || {};
  const result = {
    submissionId: source.submissionId,
    submittedByUserId: source.submittedByUserId,
    status: source.status,
    proposedMetadata: source.proposedMetadata,
    supportingSources: source.supportingSources || [],
    externalReferences: source.externalReferences || [],
    currentRevision: source.currentRevision,
    hasPossibleDuplicate: Boolean(
      source.candidateAlbumCatalogId
      || (source.candidateSubmissionIds || []).length
      || (source.duplicateSignals || []).length,
    ),
    candidateAlbumId: publicAlbumId(source.candidateAlbumCatalogId) || undefined,
    approvedAlbumId: publicAlbumId(source.approvedAlbumCatalogId) || undefined,
    duplicateAlbumId: publicAlbumId(source.duplicateOfSubmissionId?.approvedAlbumCatalogId) || undefined,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
  };
  if (detail) {
    result.revisions = (source.revisions || []).map(publicSnapshot);
    result.moderationHistory = (source.moderationHistory || []).map((event) => {
      const item = plain(event);
      return {
        actorUserId: item.actorUserId,
        action: item.action,
        reason: item.reason || "",
        createdAt: item.createdAt,
      };
    });
  }
  Object.keys(result).forEach((key) => {
    if (result[key] === undefined) delete result[key];
  });
  return result;
}

function encodeCursor(createdAt, id) {
  return Buffer.from(JSON.stringify({ createdAt: new Date(createdAt).toISOString(), id: String(id) })).toString("base64url");
}

function decodeCursor(cursor) {
  if (!cursor || typeof cursor !== "string") return null;
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    const createdAt = new Date(decoded.createdAt);
    if (!decoded.id || !mongoose.isValidObjectId(decoded.id) || Number.isNaN(createdAt.getTime())) throw new Error("invalid");
    return { createdAt, id: decoded.id };
  } catch {
    const error = new SubmissionValidationError("cursor is invalid");
    error.code = "INVALID_CURSOR";
    throw error;
  }
}

function getPageLimit(value) {
  const parsed = Number.parseInt(value, 10);
  return Math.min(Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT);
}

function cursorFilter(cursor) {
  if (!cursor) return {};
  return {
    $or: [
      { createdAt: { $lt: cursor.createdAt } },
      { createdAt: cursor.createdAt, _id: { $lt: cursor.id } },
    ],
  };
}

function isSubmissionsEnabled(env = process.env) {
  return String(env.COMMUNITY_SUBMISSIONS_ENABLED || "").trim().toLowerCase() === "true";
}

function getModeratorUserIds(env = process.env) {
  return String(env.MODERATOR_USER_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

function isModerator(userId, env = process.env) {
  return Boolean(userId) && getModeratorUserIds(env).includes(userId);
}

module.exports = {
  ACTIVE_STATUSES,
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  SubmissionValidationError,
  cursorFilter,
  decodeCursor,
  encodeCursor,
  findDuplicateSignals,
  getModeratorUserIds,
  getPageLimit,
  isModerator,
  isSubmissionsEnabled,
  normalizedFingerprint,
  normalizeSubmissionPayload,
  serializeSubmission,
  snapshotForSubmission,
};
