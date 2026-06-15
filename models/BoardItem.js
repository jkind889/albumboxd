const mongoose = require("mongoose");

const boardItemSchema = new mongoose.Schema({
  userId: {
    type: String,
    required: true,
  },
  boardId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Board",
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

boardItemSchema.index({ boardId: 1, spotifyId: 1 }, { unique: true });
boardItemSchema.index({ userId: 1, savedAt: -1 });
boardItemSchema.index({ boardId: 1, savedAt: -1 });
boardItemSchema.index({ spotifyId: 1, userId: 1 });

const BoardItem = mongoose.model("BoardItem", boardItemSchema);

module.exports = BoardItem;
