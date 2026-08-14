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

function appendReference(references, reference) {
  const exists = references.some((candidate) => (
    candidate.provider === reference.provider
    && candidate.entityType === reference.entityType
    && candidate.externalId === reference.externalId
  ));
  if (!exists) references.push(reference);
}

function buildCatalogInput(submission, actorUserId, approvedAt) {
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
    cover: "",
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

async function approveAlbumSubmission({
  submissionId,
  actorUserId,
  albumId = "",
  confirmPossibleDuplicate = false,
  reason = "",
}) {
  if (typeof mongoose.startSession !== "function") throw new ApprovalUnavailableError();
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

      const duplicate = await findDuplicateSignals(duplicatePayload(current), {
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
        album = await createCatalogAlbum(buildCatalogInput(current, actorUserId, approvedAt), { session });
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
    return {
      suggestion: serializeSubmission(result.submission, { detail: true }),
      album: normalizeCatalogAlbum(result.album),
      albumUrl: `/album/${plain(result.album).albumId}`,
      idempotent: result.idempotent,
    };
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
};
