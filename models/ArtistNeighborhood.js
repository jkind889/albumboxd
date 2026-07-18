const mongoose = require("mongoose");

const neighborSchema = new mongoose.Schema(
  {
    musicBrainzId: {
      type: String,
      required: true,
    },
    name: {
      type: String,
      default: "",
    },
    comment: {
      type: String,
      default: "",
    },
    artistType: {
      type: String,
      default: "",
    },
    gender: {
      type: String,
      default: "",
    },
    rawScore: {
      type: Number,
      min: 0,
      default: 0,
    },
    rank: {
      type: Number,
      min: 1,
      required: true,
    },
    weight: {
      type: Number,
      min: 0,
      max: 1,
      default: 0,
    },
  },
  { _id: false },
);

const artistNeighborhoodSchema = new mongoose.Schema(
  {
    seedMusicBrainzId: {
      type: String,
      required: true,
    },
    source: {
      type: String,
      enum: ["listenbrainz"],
      default: "listenbrainz",
    },
    algorithm: {
      type: String,
      required: true,
    },
    normalizationVersion: {
      type: Number,
      default: 1,
    },
    neighbors: {
      type: [neighborSchema],
      default: [],
    },
    fetchedAt: {
      type: Date,
      required: true,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
    lastRefreshFailureAt: {
      type: Date,
      default: null,
    },
    lastRefreshError: {
      type: String,
      default: "",
    },
  },
  { timestamps: true },
);

artistNeighborhoodSchema.index(
  { seedMusicBrainzId: 1, source: 1, algorithm: 1 },
  { unique: true },
);
// This is intentionally not a TTL index: expired snapshots remain available as
// stale fallbacks when ListenBrainz is temporarily unavailable.
artistNeighborhoodSchema.index({ expiresAt: 1 });

module.exports = mongoose.model("ArtistNeighborhood", artistNeighborhoodSchema);
