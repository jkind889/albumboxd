const mongoose = require("mongoose");

// Represents one user's saved album by referencing the shared Spotify catalog record.
const albumSchema = new mongoose.Schema({
  userId: {
    type: String,
    required: true,
  },
  albumCatalogId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "AlbumCatalog",
    required: true,
  },
  spotifyId: {
    type: String,
    required: true,
  },
  savedAt: {
    type: Date,
    default: Date.now,
  },
});

albumSchema.index({ spotifyId: 1, userId: 1 }, { unique: true });


const Album = mongoose.model("Album", albumSchema);

module.exports = Album;
