const mongoose = require("mongoose");

const reviewSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  albumCatalogId: { type: mongoose.Schema.Types.ObjectId, ref: "AlbumCatalog", required: true },
  reviewText: { type: String, required: true, trim: true },
  rating: {
    type: Number,
    required: true,
    min: 1,
    max: 5,
    validate: { validator: (value) => Number.isInteger(value * 2), message: "Rating must be a whole or half number" },
  },
  date: { type: Date, default: Date.now },
  // Internal serialization token for review deletion, likes, and pinning.
  // This is intentionally excluded from every public representation.
  interactionRevision: { type: Number, default: 0, select: false },
});

reviewSchema.index({ albumCatalogId: 1, date: -1 });
reviewSchema.index({ userId: 1, date: -1 });
reviewSchema.index({ date: -1, _id: -1 });

module.exports = mongoose.model("Review", reviewSchema);
