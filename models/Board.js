const mongoose = require("mongoose");

const boardSchema = new mongoose.Schema(
  {
    userId: {
      type: String,
      required: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: 80,
    },
    isDefault: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true },
);

boardSchema.index({ userId: 1, updatedAt: -1 });
// users limited to only one default board
boardSchema.index(
  { userId: 1, isDefault: 1 },
  { unique: true, partialFilterExpression: { isDefault: true } },
);

const Board = mongoose.model("Board", boardSchema);

module.exports = Board;
