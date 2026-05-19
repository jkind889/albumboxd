const mongoose = require("mongoose");

const albumSchema = new mongoose.Schema({
  spotifyId: {
    type: String,
    required: true,
  },
  title: {
    type: String,
    required: true,
  },
  artist: {
    type: String,
    required: true,
  },
  cover: {
    type: String,
  },
});

const Album = mongoose.model("Album", albumSchema);

module.exports = Album;