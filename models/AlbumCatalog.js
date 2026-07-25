const mongoose = require("mongoose");

const artistReferenceSchema = new mongoose.Schema(
  {
    spotifyId: {
      type: String,
      default: "",
    },
    name: {
      type: String,
      required: true,
    },
    spotifyUrl: {
      type: String,
      default: "",
    },
  },
  { _id: false },
);

const genreRankingSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
    },
    score: {
      type: Number,
      required: true,
      min: 1,
    },
  },
  { _id: false },
);

// Stores Spotify album data once so routes can read from Mongo before calling Spotify again.
const albumCatalogSchema = new mongoose.Schema(
  {
    spotifyId: {
      type: String,
      required: true,
      unique: true,
    },
    title: {
      type: String,
      required: true,
    },
    artist: {
      type: String,
      required: true,
    },
    artists: {
      type: [String],
      default: [],
    },
    artistRefs: {
      type: [artistReferenceSchema],
      default: [],
    },
    year: {
      type: String,
      default: "unknown",
    },
    releaseDate: {
      type: String,
      default: "",
    },
    genres: {
      type: [String],
      default: [],
    },
    genreRankings: {
      type: [genreRankingSchema],
      default: [],
    },
    genreSource: {
      type: String,
      default: "",
    },
    genreEnrichmentStatus: {
      type: String,
      enum: ["pending", "resolved", "empty", "failed"],
      default: "pending",
    },
    genresSyncedAt: {
      type: Date,
      default: null,
    },
    lastGenreEnrichmentAttemptAt: {
      type: Date,
      default: null,
    },
    lastGenreEnrichmentFailureAt: {
      type: Date,
      default: null,
    },
    lastGenreEnrichmentError: {
      type: String,
      default: "",
    },
    musicBrainzReleaseIds: {
      type: [String],
      default: [],
    },
    musicBrainzReleaseGroupId: {
      type: String,
      default: undefined,
    },
    musicBrainzReleaseGroupCandidates: {
      type: [String],
      default: [],
    },
    musicBrainzMappingStatus: {
      type: String,
      enum: ["pending", "resolved", "not_found", "ambiguous", "failed"],
      default: "pending",
    },
    musicBrainzMappingSource: {
      type: String,
      default: "",
    },
    musicBrainzMappedAt: {
      type: Date,
      default: null,
    },
    lastMusicBrainzMappingAttemptAt: {
      type: Date,
      default: null,
    },
    lastMusicBrainzMappingFailureAt: {
      type: Date,
      default: null,
    },
    lastMusicBrainzMappingError: {
      type: String,
      default: "",
    },
    imgs: {
      type: [mongoose.Schema.Types.Mixed],
      default: [],
    },
    cover: {
      type: String,
      default: null,
    },
    totalTracks: {
      type: Number,
      default: 0,
    },
    detailMetadataVersion: {
      type: Number,
      default: 0,
    },
    tracks: {
      type: [
        {
          spotifyId: {
            type: String,
            default: "",
          },
          trackNumber: {
            type: Number,
            default: 0,
          },
          discNumber: {
            type: Number,
            default: 1,
          },
          title: {
            type: String,
            default: "",
          },
          durationMs: {
            type: Number,
            default: 0,
          },
          spotifyUrl: {
            type: String,
            default: "",
          },
          artistRefs: {
            type: [artistReferenceSchema],
            default: [],
          },
        },
      ],
      default: [],
    },
    label: {
      type: String,
      default: "",
    },
    albumType: {
      type: String,
      default: "album",
    },
    spotifyUrl: {
      type: String,
      default: "",
    },
  },
  { timestamps: true },
);

albumCatalogSchema.index({ title: "text", artist: "text", artists: "text" });
albumCatalogSchema.index({ artist: 1, title: 1 });
albumCatalogSchema.index({ "artistRefs.spotifyId": 1 });
albumCatalogSchema.index({ "tracks.artistRefs.spotifyId": 1 });
albumCatalogSchema.index({ musicBrainzReleaseGroupId: 1 }, { sparse: true });
albumCatalogSchema.index({
  musicBrainzMappingStatus: 1,
  genreEnrichmentStatus: 1,
  genresSyncedAt: 1,
});

const AlbumCatalog = mongoose.model("AlbumCatalog", albumCatalogSchema);

module.exports = AlbumCatalog;
