const mongoose = require("mongoose");

const reviewSchema = new mongoose.Schema({
    userId: {
        type: String,
        required: true,
    },
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
    reviewText: {
        type: String,
        required: true,
    },
    rating: {
        type: Number,
        required: true,
        min: 1,
        max: 5,
    },
    date: {
        type: Date,
        default: Date.now,
    },
});

reviewSchema.index({ spotifyId: 1, date: -1 });
reviewSchema.index({ userId: 1, date: -1 });

const Review = mongoose.model("Review", reviewSchema);

module.exports = Review;
