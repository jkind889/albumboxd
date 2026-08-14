const crypto = require("node:crypto");
const mongoose = require("mongoose");

const RELEASE_TYPES = [
  "album",
  "ep",
  "single",
  "mixtape",
  "soundtrack",
  "compilation",
  "live",
  "remix",
  "other",
];
const SUBMISSION_STATUSES = [
  "pending",
  "needs_changes",
  "approved",
  "rejected",
  "duplicate",
  "withdrawn",
];
const MODERATION_ACTIONS = [
  "submitted",
  "revised",
  "withdrawn",
  "request_changes",
  "approved",
  "rejected",
  "marked_duplicate",
];

function isHttpsUrl(value) {
  if (!value) return true;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

const artistCreditSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 200 },
    role: { type: String, default: "main", trim: true, maxlength: 80 },
  },
  { _id: false, strict: "throw" },
);

const proposedTrackSchema = new mongoose.Schema(
  {
    discNumber: { type: Number, required: true, min: 1, max: 999 },
    trackNumber: { type: Number, required: true, min: 1, max: 999 },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    durationMs: { type: Number, default: 0, min: 0, max: 86400000 },
    artistDisplayName: { type: String, default: "", trim: true, maxlength: 300 },
  },
  { _id: false, strict: "throw" },
);

const proposedMetadataSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 200 },
    artistDisplayName: { type: String, required: true, trim: true, maxlength: 300 },
    artistCredits: {
      type: [artistCreditSchema],
      required: true,
      validate: [
        { validator: (value) => value.length >= 1, message: "At least one artist credit is required." },
        { validator: (value) => value.length <= 20, message: "At most twenty artist credits are allowed." },
      ],
    },
    releaseType: { type: String, enum: RELEASE_TYPES, required: true },
    releaseDate: {
      type: String,
      required: true,
      match: /^\d{4}(?:-\d{2})?(?:-\d{2})?$/,
    },
    releaseDatePrecision: { type: String, enum: ["year", "month", "day"], required: true },
    releaseYear: { type: Number, required: true, min: 1, max: 9999 },
    label: { type: String, default: "", trim: true, maxlength: 200 },
    country: { type: String, default: "", trim: true, maxlength: 100 },
    catalogNumber: { type: String, default: "", trim: true, maxlength: 100 },
    barcode: { type: String, default: "", trim: true, match: /^(?:\d{8,14})?$/ },
    tracks: {
      type: [proposedTrackSchema],
      default: [],
      validate: { validator: (value) => value.length <= 200, message: "At most two hundred tracks are allowed." },
    },
    coverSourceUrl: {
      type: String,
      default: "",
      trim: true,
      maxlength: 2048,
      validate: { validator: isHttpsUrl, message: "Cover source URL must use https." },
    },
  },
  { _id: false, strict: "throw" },
);

const supportingSourceSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ["musicbrainz", "official_artist", "official_label", "distributor", "store", "spotify", "other"],
      required: true,
    },
    url: {
      type: String,
      required: true,
      trim: true,
      maxlength: 2048,
      validate: { validator: isHttpsUrl, message: "Supporting source URL must use https." },
    },
    description: { type: String, default: "", trim: true, maxlength: 200 },
  },
  { _id: false, strict: "throw" },
);

const externalReferenceSchema = new mongoose.Schema(
  {
    provider: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      maxlength: 50,
      validate: { validator: (value) => value !== "spotify", message: "Spotify references belong in supporting evidence." },
    },
    entityType: { type: String, required: true, trim: true, lowercase: true, maxlength: 50 },
    externalId: { type: String, required: true, trim: true, maxlength: 200 },
    url: {
      type: String,
      default: "",
      trim: true,
      maxlength: 2048,
      validate: { validator: isHttpsUrl, message: "External reference URL must use https." },
    },
  },
  { _id: false, strict: "throw" },
);

const duplicateSignalSchema = new mongoose.Schema(
  {
    matchType: { type: String, enum: ["external_reference", "barcode", "catalog_number", "fingerprint"], required: true },
    targetType: { type: String, enum: ["catalog", "submission"], required: true },
    key: { type: String, required: true, trim: true, maxlength: 300 },
    albumCatalogId: { type: mongoose.Schema.Types.ObjectId, ref: "AlbumCatalog", default: null },
    submissionId: { type: mongoose.Schema.Types.ObjectId, ref: "AlbumSubmission", default: null },
  },
  { _id: false, strict: "throw" },
);

const revisionSchema = new mongoose.Schema(
  {
    revision: { type: Number, required: true, min: 1 },
    submittedAt: { type: Date, required: true },
    proposedMetadata: { type: proposedMetadataSchema, required: true },
    supportingSources: {
      type: [supportingSourceSchema],
      required: true,
      validate: { validator: (value) => value.length >= 1 && value.length <= 10, message: "One to ten sources are required." },
    },
    externalReferences: { type: [externalReferenceSchema], default: [] },
    normalizedFingerprint: { type: String, required: true, maxlength: 64 },
    candidateAlbumCatalogId: { type: mongoose.Schema.Types.ObjectId, ref: "AlbumCatalog", default: null },
    candidateSubmissionIds: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: "AlbumSubmission" }],
      default: [],
      validate: { validator: (value) => value.length <= 10, message: "At most ten candidate submissions are retained." },
    },
    duplicateSignals: { type: [duplicateSignalSchema], default: [] },
  },
  { _id: false, strict: "throw" },
);

const moderationEventSchema = new mongoose.Schema(
  {
    actorUserId: { type: String, required: true, trim: true, maxlength: 128 },
    action: { type: String, enum: MODERATION_ACTIONS, required: true },
    reason: { type: String, default: "", trim: true, maxlength: 1000 },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false, strict: "throw" },
);

const albumSubmissionSchema = new mongoose.Schema(
  {
    submissionId: {
      type: String,
      required: true,
      unique: true,
      immutable: true,
      lowercase: true,
      default: () => crypto.randomUUID(),
      match: /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    },
    submittedByUserId: { type: String, required: true, trim: true, maxlength: 128 },
    proposedMetadata: { type: proposedMetadataSchema, required: true },
    supportingSources: {
      type: [supportingSourceSchema],
      required: true,
      validate: { validator: (value) => value.length >= 1 && value.length <= 10, message: "One to ten sources are required." },
    },
    externalReferences: { type: [externalReferenceSchema], default: [] },
    candidateAlbumCatalogId: { type: mongoose.Schema.Types.ObjectId, ref: "AlbumCatalog", default: null },
    candidateSubmissionIds: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: "AlbumSubmission" }],
      default: [],
      validate: { validator: (value) => value.length <= 10, message: "At most ten candidate submissions are retained." },
    },
    duplicateSignals: { type: [duplicateSignalSchema], default: [] },
    normalizedFingerprint: { type: String, required: true, maxlength: 64 },
    status: { type: String, enum: SUBMISSION_STATUSES, default: "pending", required: true },
    approvedAlbumCatalogId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AlbumCatalog",
      default: null,
      validate: {
        validator(value) { return this.status !== "approved" || Boolean(value); },
        message: "Approved submissions must reference a catalog album.",
      },
    },
    duplicateOfSubmissionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AlbumSubmission",
      default: null,
      validate: {
        validator(value) { return this.status !== "duplicate" || Boolean(value); },
        message: "Duplicate submissions must reference another submission.",
      },
    },
    currentRevision: { type: Number, required: true, min: 1, default: 1 },
    revisions: { type: [revisionSchema], default: [] },
    moderationHistory: { type: [moderationEventSchema], default: [] },
  },
  { timestamps: true, strict: "throw" },
);

albumSubmissionSchema.pre("validate", function validateSubmissionInvariants() {
  if (this.status === "approved" && !this.approvedAlbumCatalogId) {
    this.invalidate("approvedAlbumCatalogId", "Approved submissions must reference a catalog album.");
  }
  if (this.status === "duplicate" && !this.duplicateOfSubmissionId) {
    this.invalidate("duplicateOfSubmissionId", "Duplicate submissions must reference another submission.");
  }
  if (Array.isArray(this.revisions) && this.revisions.length > 0 && this.currentRevision !== this.revisions.length) {
    this.invalidate("currentRevision", "Current revision must match the number of stored revisions.");
  }
});

function invariantValidationError(path, message) {
  const error = new mongoose.Error.ValidationError();
  error.addError(path, new mongoose.Error.ValidatorError({ path, message }));
  return error;
}

albumSubmissionSchema.pre(["findOneAndUpdate", "updateOne"], function validateSubmissionUpdate() {
  const update = this.getUpdate() || {};
  const set = update.$set || update;
  ["revisions", "moderationHistory"].forEach((field) => {
    if (set[field] !== undefined
      || update.$unset?.[field] !== undefined
      || update.$pull?.[field] !== undefined
      || update.$pullAll?.[field] !== undefined
      || update.$pop?.[field] !== undefined) {
      throw invariantValidationError(field, `${field} are append-only and cannot be replaced or removed.`);
    }
    const push = update.$push?.[field];
    if (push && typeof push === "object" && (push.$position !== undefined || push.$slice !== undefined)) {
      throw invariantValidationError(field, `${field} may only be appended.`);
    }
  });
  const status = set.status;
  if (status === "approved" && !set.approvedAlbumCatalogId) {
    throw invariantValidationError("approvedAlbumCatalogId", "Approved submissions must reference a catalog album.");
  }
  if (status === "duplicate" && !set.duplicateOfSubmissionId) {
    throw invariantValidationError("duplicateOfSubmissionId", "Duplicate submissions must reference another submission.");
  }
  if (status === "approved" && set.duplicateOfSubmissionId && set.duplicateOfSubmissionId !== null) {
    throw invariantValidationError("duplicateOfSubmissionId", "Approved submissions cannot reference a duplicate submission.");
  }
  if (status === "duplicate" && set.approvedAlbumCatalogId && set.approvedAlbumCatalogId !== null) {
    throw invariantValidationError("approvedAlbumCatalogId", "Duplicate submissions cannot reference an approved album.");
  }
});

albumSubmissionSchema.index({ submittedByUserId: 1, createdAt: -1, _id: -1 });
albumSubmissionSchema.index({ status: 1, updatedAt: -1, _id: -1 });
albumSubmissionSchema.index({ normalizedFingerprint: 1, status: 1 });
albumSubmissionSchema.index({ "externalReferences.provider": 1, "externalReferences.entityType": 1, "externalReferences.externalId": 1 });
albumSubmissionSchema.index({ "proposedMetadata.barcode": 1 }, { sparse: true });
albumSubmissionSchema.index({ "proposedMetadata.catalogNumber": 1 }, { sparse: true });

module.exports = mongoose.model("AlbumSubmission", albumSubmissionSchema);
