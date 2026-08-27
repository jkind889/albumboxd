const mongoose = require("mongoose");
const AlbumCatalog = require("../../models/AlbumCatalog");
const AlbumSubmission = require("../../models/AlbumSubmission");
const {
  createCatalogAlbum,
  normalizeCatalogAlbum,
} = require("./albumCatalog");
const {
  findDuplicateSignals,
  serializeSubmission,
} = require("./submissions");
const {
  ApprovalUnavailableError,
  ModerationConflictError,
  isTransactionUnavailable,
} = require("./moderation");

const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Keep the resolver lazy so direct-cover and linked-album approvals do not load
// or call the provider, and callers can inject a deterministic resolver in tests.
function defaultCoverResolver() {
  // eslint-disable-next-line global-require, import/no-dynamic-require
  const resolver = require("../../lib/coverArtArchive");
  if (typeof resolver === "function") return resolver;
  return resolver.resolveCoverArt || resolver.resolveCoverArtArchive || resolver.resolve || null;
}

function plain(value) {
  return typeof value?.toObject === "function" ? value.toObject() : value;
}

function withSession(query, session) {
  if (session && query && typeof query.session === "function") return query.session(session);
  return query;
}

async function readQuery(query, session) {
  const result = withSession(query, session);
  return result && typeof result.exec === "function" ? result.exec() : result;
}

function duplicatePayload(submission) {
  const source = plain(submission);
  return {
    proposedMetadata: source.proposedMetadata,
    supportingSources: source.supportingSources || [],
    externalReferences: source.externalReferences || [],
  };
}

function referenceKey(reference) {
  const provider = String(reference?.provider || "").trim().toLowerCase();
  const entityType = String(reference?.entityType || "").trim().toLowerCase();
  let externalId = String(reference?.externalId || "").trim();
  if (provider === "musicbrainz" && ["release-group", "release"].includes(entityType) && MBID.test(externalId)) {
    externalId = externalId.toLowerCase();
  }
  return `${provider}|${entityType}|${externalId}`;
}

function appendReference(references, reference) {
  const key = referenceKey(reference);
  if (!references.some((candidate) => referenceKey(candidate) === key)) references.push(reference);
}

function normalizeResolutionReference(reference) {
  if (!reference || typeof reference !== "object") return null;
  const provider = String(reference.provider || "").trim().toLowerCase();
  const entityType = String(reference.entityType || "").trim().toLowerCase();
  const externalId = String(reference.externalId || "").trim();
  if (!provider || !entityType || !externalId) return null;
  return {
    provider,
    entityType,
    externalId,
    url: String(reference.url || "").trim(),
  };
}

function resolutionReferences(resolution) {
  const references = [
    resolution?.externalReferences,
    resolution?.derivedReferences,
    resolution?.references,
    resolution?.externalReference,
  ].flatMap((value) => (Array.isArray(value) ? value : value ? [value] : []));
  const derived = [];
  const provenance = resolution?.provenance && typeof resolution.provenance === "object"
    ? resolution.provenance
    : {};
  const releaseGroupMbid = resolution?.releaseGroupMbid || resolution?.sourceReleaseGroupMbid || provenance.releaseGroupMbid;
  const releaseMbid = resolution?.releaseMbid || resolution?.sourceReleaseMbid || provenance.releaseMbid;
  if (MBID.test(String(releaseGroupMbid || ""))) {
    derived.push({
      provider: "musicbrainz",
      entityType: "release-group",
      externalId: String(releaseGroupMbid).toLowerCase(),
      url: `https://musicbrainz.org/release-group/${String(releaseGroupMbid).toLowerCase()}`,
    });
  }
  if (MBID.test(String(releaseMbid || ""))) {
    derived.push({
      provider: "musicbrainz",
      entityType: "release",
      externalId: String(releaseMbid).toLowerCase(),
      url: `https://musicbrainz.org/release/${String(releaseMbid).toLowerCase()}`,
    });
  }
  return [...references, ...derived]
    .map(normalizeResolutionReference)
    .filter(Boolean);
}

function resolvedCoverUrl(resolution) {
  if (!resolution || typeof resolution !== "object") return "";
  if (resolution.status && resolution.status !== "resolved" && resolution.status !== "success") return "";
  if (resolution.resolved === false) return "";
  return String(
    resolution.cover
      || resolution.coverUrl
      || resolution.canonicalCoverUrl
      || resolution.canonicalUrl
      || resolution.url
      || resolution.imageUrl
      || "",
  ).trim();
}

function buildCoverProvenance({ source, submission, actorUserId, approvedAt, resolution, sourceUrl = "" }) {
  const provenance = {
    source,
    submissionId: submission.submissionId,
    revision: submission.currentRevision,
    approvedByUserId: actorUserId,
    approvedAt,
  };
  if (sourceUrl) {
    provenance.url = sourceUrl;
    provenance.sourceUrl = sourceUrl;
    provenance.coverSourceUrl = sourceUrl;
  }
  if (resolution && typeof resolution === "object") {
    const details = resolution.provenance && typeof resolution.provenance === "object"
      ? { ...resolution.provenance, ...resolution }
      : resolution;
    ["method", "resolutionMethod", "releaseGroupMbid", "releaseMbid", "imageId", "size", "canonicalUrl", "verifiedAt"]
      .forEach((key) => {
        if (details[key] !== undefined && details[key] !== null && details[key] !== "") {
          provenance[key] = details[key];
        }
      });
    if (details.source) provenance.provider = details.source;
  }
  return provenance;
}

function buildCatalogInput(submission, actorUserId, approvedAt, coverResolution = null) {
  const source = plain(submission);
  const metadata = source.proposedMetadata || {};
  const references = (source.externalReferences || []).map((reference) => ({
    provider: reference.provider,
    entityType: reference.entityType,
    externalId: reference.externalId,
    url: reference.url || "",
  }));
  if (metadata.barcode) {
    appendReference(references, {
      provider: "barcode",
      entityType: "release",
      externalId: metadata.barcode,
      url: "",
    });
  }
  if (metadata.catalogNumber) {
    appendReference(references, {
      provider: "catalog_number",
      entityType: "release",
      externalId: metadata.catalogNumber,
      url: "",
    });
  }

  resolutionReferences(coverResolution).forEach((reference) => appendReference(references, reference));

  const fields = [
    "title",
    "artistDisplayName",
    "artistCredits",
    "releaseType",
    "releaseDate",
    "releaseDatePrecision",
    "releaseYear",
    "tracks",
    "label",
    "externalReferences",
  ];
  const provenance = {};
  fields.forEach((field) => {
    provenance[field] = {
      source: "community",
      submissionId: source.submissionId,
      revision: source.currentRevision,
      approvedByUserId: actorUserId,
      approvedAt,
    };
  });

  const manualCover = String(metadata.coverSourceUrl || "").trim();
  const cover = manualCover || resolvedCoverUrl(coverResolution);
  if (cover) {
    provenance.cover = buildCoverProvenance({
      source: manualCover ? "community" : "cover-art-archive",
      submission: source,
      actorUserId,
      approvedAt,
      resolution: manualCover ? null : coverResolution,
      sourceUrl: manualCover,
    });
  }

  return {
    title: metadata.title,
    artistDisplayName: metadata.artistDisplayName,
    artistCredits: metadata.artistCredits,
    releaseType: metadata.releaseType,
    releaseDate: metadata.releaseDate,
    releaseDatePrecision: metadata.releaseDatePrecision,
    releaseYear: metadata.releaseYear,
    tracks: metadata.tracks || [],
    label: metadata.label || "",
    cover,
    externalReferences: references,
    fieldProvenance: provenance,
    catalogSource: "community",
  };
}

async function findCatalogByPublicId(albumId, session) {
  return readQuery(AlbumCatalog.findOne({ albumId }), session);
}

async function findCatalogByInternalId(id, session) {
  if (!id) return null;
  return readQuery(AlbumCatalog.findOne({ _id: id }), session);
}

async function candidateAlbumIds(duplicate, session) {
  const ids = [...new Set((duplicate.duplicateSignals || [])
    .filter((signal) => signal.targetType === "catalog" && signal.albumCatalogId)
    .map((signal) => String(signal.albumCatalogId)))];
  if (!ids.length) return [];
  const rows = await readQuery(AlbumCatalog.find({ _id: { $in: ids } }), session);
  return (Array.isArray(rows) ? rows : []).map((row) => plain(row)?.albumId).filter(Boolean);
}

function coverResolverInput(submission) {
  const source = plain(submission) || {};
  const metadata = source.proposedMetadata || {};
  return {
    title: metadata.title || "",
    artistDisplayName: metadata.artistDisplayName || "",
    artistCredits: metadata.artistCredits || [],
    releaseDate: metadata.releaseDate || "",
    releaseYear: metadata.releaseYear,
    barcode: metadata.barcode || "",
    externalReferences: source.externalReferences || [],
    supportingSources: source.supportingSources || [],
  };
}

async function resolveSuggestedCover(submission, coverResolver) {
  const metadata = plain(submission)?.proposedMetadata || {};
  // A moderator-approved direct URL is the highest-precedence source and is
  // intentionally never fetched or otherwise validated by this service.
  if (String(metadata.coverSourceUrl || "").trim()) return null;
  if (typeof coverResolver !== "function") return null;
  try {
    const resolution = await coverResolver(coverResolverInput(submission), { profile: "approval" });
    return resolution && typeof resolution === "object" ? resolution : null;
  } catch {
    // Artwork is best effort. A provider outage must never prevent approval.
    return null;
  }
}

function mergeReferences(submission, resolution) {
  const source = plain(submission);
  const references = [...(source.externalReferences || [])].map((reference) => ({ ...reference }));
  resolutionReferences(resolution).forEach((reference) => appendReference(references, reference));
  return references;
}

function approvalResult(result) {
  return {
    suggestion: serializeSubmission(result.submission, { detail: true }),
    album: normalizeCatalogAlbum(result.album),
    albumUrl: `/album/${plain(result.album).albumId}`,
    idempotent: result.idempotent,
  };
}

async function approveAlbumSubmission({
  submissionId,
  actorUserId,
  albumId = "",
  confirmPossibleDuplicate = false,
  reason = "",
  coverResolver,
}) {
  if (typeof mongoose.startSession !== "function") throw new ApprovalUnavailableError();

  // Avoid a provider call and a transaction for idempotent retries. This also
  // ensures an already-published album cannot be changed by a stale suggestion.
  const preliminarySubmission = await readQuery(AlbumSubmission.findOne({ submissionId }));
  if (!preliminarySubmission) {
    throw new ModerationConflictError("Suggestion not found", "SUGGESTION_NOT_FOUND");
  }
  const preliminary = plain(preliminarySubmission);
  if (preliminary.status === "approved") {
    const approvedAlbum = await findCatalogByInternalId(preliminary.approvedAlbumCatalogId);
    if (!approvedAlbum) throw new ModerationConflictError("Approved suggestion has no usable catalog album", "APPROVAL_INCONSISTENT");
    if (albumId && plain(approvedAlbum).albumId !== albumId) {
      throw new ModerationConflictError("Suggestion was already approved for another album", "APPROVAL_CONFLICT");
    }
    return approvalResult({
      submission: { ...preliminary, approvedAlbumCatalogId: approvedAlbum },
      album: approvedAlbum,
      idempotent: true,
    });
  }
  if (preliminary.status !== "pending") {
    throw new ModerationConflictError("Only pending suggestions can be approved", "INVALID_SUBMISSION_STATE");
  }

  // Resolve before opening Mongo's transaction. The transaction re-reads the
  // submission and rejects this result if the revision changed meanwhile.
  const preliminaryRevision = preliminary.currentRevision;
  const preliminaryUpdatedAt = preliminary.updatedAt ? new Date(preliminary.updatedAt).getTime() : null;
  let coverResolution = null;
  if (!albumId) {
    const metadata = preliminary.proposedMetadata || {};
    if (!String(metadata.coverSourceUrl || "").trim()) {
      const resolver = coverResolver === undefined ? defaultCoverResolver() : coverResolver;
      coverResolution = await resolveSuggestedCover(preliminary, resolver);
    }
  }

  let session;
  let result = null;
  try {
    session = await mongoose.startSession();
    if (typeof session.withTransaction !== "function") throw new ApprovalUnavailableError();
    await session.withTransaction(async () => {
      result = null;
      const submission = await readQuery(AlbumSubmission.findOne({ submissionId }), session);
      if (!submission) {
        throw new ModerationConflictError("Suggestion not found", "SUGGESTION_NOT_FOUND");
      }

      const current = plain(submission);
      if (current.status === "approved") {
        const approvedAlbum = await findCatalogByInternalId(current.approvedAlbumCatalogId, session);
        if (!approvedAlbum) throw new ModerationConflictError("Approved suggestion has no usable catalog album", "APPROVAL_INCONSISTENT");
        if (albumId && plain(approvedAlbum).albumId !== albumId) {
          throw new ModerationConflictError("Suggestion was already approved for another album", "APPROVAL_CONFLICT");
        }
        result = {
          submission: { ...current, approvedAlbumCatalogId: approvedAlbum },
          album: approvedAlbum,
          idempotent: true,
        };
        return;
      }
      if (current.status !== "pending") {
        throw new ModerationConflictError("Only pending suggestions can be approved", "INVALID_SUBMISSION_STATE");
      }
      if (current.currentRevision !== preliminaryRevision
        || (preliminaryUpdatedAt !== null && current.updatedAt && new Date(current.updatedAt).getTime() !== preliminaryUpdatedAt)) {
        throw new ModerationConflictError("Suggestion changed while artwork was being resolved", "STATE_CONFLICT");
      }

      const resolvedReferences = resolutionReferences(coverResolution);
      const duplicateSource = resolvedReferences.length
        ? { ...current, externalReferences: mergeReferences(current, coverResolution) }
        : current;

      const duplicate = await findDuplicateSignals(duplicatePayload(duplicateSource), {
        excludeSubmissionId: current._id,
        session,
      });
      const exactCatalogSignals = (duplicate.duplicateSignals || []).filter((signal) => (
        signal.targetType === "catalog"
        && ["external_reference", "barcode", "catalog_number"].includes(signal.matchType)
      ));
      if (!albumId && exactCatalogSignals.length) {
        throw new ModerationConflictError(
          "An exact catalog match requires an explicit albumId",
          "EXACT_CATALOG_MATCH",
          await candidateAlbumIds(duplicate, session),
        );
      }
      if (!albumId && duplicate.duplicateSignals?.length && !confirmPossibleDuplicate) {
        throw new ModerationConflictError(
          "Possible duplicates require explicit confirmation before creating a new album",
          "POSSIBLE_DUPLICATE_CONFIRMATION_REQUIRED",
          await candidateAlbumIds(duplicate, session),
        );
      }

      const approvedAt = new Date();
      let album;
      if (albumId) {
        album = await findCatalogByPublicId(albumId, session);
        if (!album) throw new ModerationConflictError("Catalog album not found", "CATALOG_ALBUM_NOT_FOUND");
      } else {
        album = await createCatalogAlbum(buildCatalogInput(current, actorUserId, approvedAt, coverResolution), { session });
      }

      const updated = await AlbumSubmission.findOneAndUpdate(
        { _id: current._id, submissionId, status: "pending", currentRevision: current.currentRevision },
        {
          $set: {
            status: "approved",
            approvedAlbumCatalogId: album._id,
            duplicateOfSubmissionId: null,
          },
          $push: {
            moderationHistory: {
              actorUserId,
              action: "approved",
              reason,
              createdAt: approvedAt,
            },
          },
        },
        { returnDocument: "after", runValidators: true, session },
      );
      if (!updated) throw new ModerationConflictError("Suggestion changed while it was being approved", "STATE_CONFLICT");
      result = {
        submission: { ...plain(updated), approvedAlbumCatalogId: album },
        album,
        idempotent: false,
      };
    });
    if (!result) throw new ModerationConflictError("Approval did not produce a result", "APPROVAL_CONFLICT");
    return approvalResult(result);
  } catch (error) {
    if (error instanceof ApprovalUnavailableError) throw error;
    if (isTransactionUnavailable(error)) throw new ApprovalUnavailableError();
    if (error?.code === 11000) {
      throw new ModerationConflictError("Approval collided with an existing catalog reference; choose an explicit albumId", "EXACT_CATALOG_MATCH");
    }
    throw error;
  } finally {
    if (session && typeof session.endSession === "function") await session.endSession();
  }
}

module.exports = {
  approveAlbumSubmission,
  buildCatalogInput,
  resolveSuggestedCover,
};
