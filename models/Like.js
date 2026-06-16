const mongoose = require("mongoose");

const likeSchema = new mongoose.Schema(
  {
    userId: {
      type: String,
      required: true,
    },
    targetType: {
      type: String,
      enum: ["album", "review"],
      required: true,
    },
    spotifyId: {
      type: String,
      required: true,
    },
    reviewId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Review",
    },
  },
  { timestamps: true },
);

likeSchema.index(
  { userId: 1, targetType: 1, spotifyId: 1 },
  { unique: true, partialFilterExpression: { targetType: "album" } },
);
likeSchema.index(
  { userId: 1, targetType: 1, reviewId: 1 },
  { unique: true, partialFilterExpression: { targetType: "review" } },
);
likeSchema.index({ targetType: 1, spotifyId: 1 });
likeSchema.index({ targetType: 1, reviewId: 1 });

const Like = mongoose.model("Like", likeSchema);

module.exports = Like;
