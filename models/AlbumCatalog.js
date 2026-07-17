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

const AlbumCatalog = mongoose.model("AlbumCatalog", albumCatalogSchema);

module.exports = AlbumCatalog;
