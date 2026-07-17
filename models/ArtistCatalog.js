const mongoose = require("mongoose");

const ARTIST_MAPPING_STATUSES = ["pending", "resolved", "not_found"];

const artistCatalogSchema = new mongoose.Schema(
  {
    spotifyId: {
      type: String,
      required: true,
      unique: true,
    },
    spotifyUrl: {
      type: String,
      required: true,
    },
    name: {
      type: String,
      default: "",
    },
    musicBrainzId: {
      type: String,
      default: undefined,
    },
    musicBrainzName: {
      type: String,
      default: "",
    },
    sortName: {
      type: String,
      default: "",
    },
    disambiguation: {
      type: String,
      default: "",
    },
    artistType: {
      type: String,
      default: "",
    },
    country: {
      type: String,
      default: "",
    },
    mappingStatus: {
      type: String,
      enum: ARTIST_MAPPING_STATUSES,
      default: "pending",
    },
    mappingSource: {
      type: String,
      default: "",
    },
    mappingConfidence: {
      type: Number,
      min: 0,
      max: 1,
      default: 0,
    },
    lastResolutionAttemptAt: {
      type: Date,
      default: null,
    },
    lastResolutionFailureAt: {
      type: Date,
      default: null,
    },
    lastResolutionError: {
      type: String,
      default: "",
    },
    musicBrainzSyncedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true },
);

artistCatalogSchema.index({ musicBrainzId: 1 }, { sparse: true });
artistCatalogSchema.index({ name: 1 });
artistCatalogSchema.index({ mappingStatus: 1, lastResolutionAttemptAt: 1 });

const ArtistCatalog = mongoose.model("ArtistCatalog", artistCatalogSchema);

module.exports = ArtistCatalog;
module.exports.ARTIST_MAPPING_STATUSES = ARTIST_MAPPING_STATUSES;
