const mongoose = require("mongoose");

const boardItemSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  boardId: { type: mongoose.Schema.Types.ObjectId, ref: "Board", required: true },
  albumCatalogId: { type: mongoose.Schema.Types.ObjectId, ref: "AlbumCatalog", required: true },
  savedAt: { type: Date, default: Date.now },
});

boardItemSchema.index({ boardId: 1, albumCatalogId: 1 }, { unique: true });
boardItemSchema.index({ userId: 1, savedAt: -1 });
boardItemSchema.index({ boardId: 1, savedAt: -1 });
boardItemSchema.index({ albumCatalogId: 1, userId: 1 });

module.exports = mongoose.model("BoardItem", boardItemSchema);
