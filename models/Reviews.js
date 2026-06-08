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

const Review = mongoose.model("Review", reviewSchema);

module.exports = Review;