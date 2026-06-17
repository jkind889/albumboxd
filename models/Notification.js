const mongoose = require("mongoose");

const notificationSchema = new mongoose.Schema(
  {
    recipientUserId: {
      type: String,
      required: true,
    },
    actorUserId: {
      type: String,
      required: true,
    },
    type: {
      type: String,
      enum: ["review_like", "follow"],
      required: true,
    },
    reviewId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Review",
    },
    spotifyId: {
      type: String,
    },
    readAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true },
);

notificationSchema.index({ recipientUserId: 1, readAt: 1, createdAt: -1 });
notificationSchema.index(
  { recipientUserId: 1, actorUserId: 1, reviewId: 1, type: 1 },
  {
    unique: true,
    partialFilterExpression: { type: "review_like" },
  },
);
notificationSchema.index(
  { recipientUserId: 1, actorUserId: 1, type: 1 },
  {
    unique: true,
    partialFilterExpression: { type: "follow" },
  },
);

const Notification = mongoose.model("Notification", notificationSchema);

module.exports = Notification;
