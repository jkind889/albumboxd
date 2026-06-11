const express = require("express");
const Review = require("../models/Reviews");
const { getAuth } = require("@clerk/express");

const router = express.Router();
const MIN_POPULAR_LIMIT = 5;
const MAX_POPULAR_LIMIT = 10;
const DEFAULT_POPULAR_LIMIT = 5;
const POPULAR_WINDOW_DAYS = {
    "7d": 7,
    "30d": 30,
};

function getPopularLimit(value) {
    const parsedLimit = Number.parseInt(value, 10);

    if (Number.isNaN(parsedLimit)) {
        return DEFAULT_POPULAR_LIMIT;
    }

    return Math.min(Math.max(parsedLimit, MIN_POPULAR_LIMIT), MAX_POPULAR_LIMIT);
}

function getPopularDateFilter(timeWindow) {
    if (timeWindow === "all") {
        return null;
    }

    const days = POPULAR_WINDOW_DAYS[timeWindow] || POPULAR_WINDOW_DAYS["30d"];

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    return startDate;
}

function ensureAuthenticated(req, res, next) {
    const { userId } = getAuth(req);

    if (!userId) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    req.userId = userId;
    next();
}

router.post("/review", ensureAuthenticated, async(req, res) =>
    {
        const userId = req.userId;


        try {
            const review = await Review.create(
                { ...req.body, userId }
            );
            res.status(201).json(review);
        } catch (error) {
            console.log(error);
            res.status(500).json({ error: "Failed to create review" });
        }
    });

 router.get("/review/user/", ensureAuthenticated, async(req, res) =>
    {
        const userId = req.userId;

        try {
            const reviews = await Review.find({ userId });
            res.json(reviews);
        } catch (error) {
            console.log(error);
            res.status(500).json({ error: "Failed to fetch reviews" });
        }
    });

router.delete("/review/user/:id", ensureAuthenticated, async(req, res) => {
    try {
        await Review.findOneAndDelete({ _id: req.params.id, userId: req.userId });
        res.json({ message: "Review deleted" });
    } catch (error) {
        console.log(error);
        res.status(500).json({ error: "Failed to delete review" });
    }
});

router.get("/review/album/:albumId", async(req, res) => {
    try {
        const reviews = await Review.find({ spotifyId: req.params.albumId }).sort({ date: -1 });
        res.json(reviews);
    } catch (error) {
        console.log(error);
        res.status(500).json({ error: "Failed to fetch review" });
    }
});

router.get("/popular", async(req, res) => {
    try {
        const limit = getPopularLimit(req.query.limit);
        const startDate = getPopularDateFilter(req.query.window);
        const matchStage = startDate ? [{ $match: { date: { $gte: startDate } } }] : [];
        const popularAlbums = await Review.aggregate([
            ...matchStage,
            {
                $group: {
                    _id: "$spotifyId",
                    spotifyId: { $first: "$spotifyId" },
                    title: { $first: "$title" },
                    artist: { $first: "$artist" },
                    cover: { $first: "$cover" },
                    reviewCount: { $sum: 1 },
                    averageRating: { $avg: "$rating" },
                    latestReviewDate: { $max: "$date" },
                },
            },
            {
                $addFields: {
                    popularityScore: {
                        $divide: [
                            { $add: [{ $multiply: ["$averageRating", "$reviewCount"] }, 10.5] },
                            { $add: ["$reviewCount", 3] },
                        ],
                    },
                },
            },
            {
                $sort: {
                    popularityScore: -1,
                    reviewCount: -1,
                    averageRating: -1,
                    latestReviewDate: -1,
                },
            },
            { $limit: limit },
            {
                $project: {
                    _id: 0,
                    spotifyId: 1,
                    title: 1,
                    artist: 1,
                    cover: 1,
                    reviewCount: 1,
                    averageRating: { $round: ["$averageRating", 2] },
                    popularityScore: { $round: ["$popularityScore", 4] },
                    latestReviewDate: 1,
                },
            },
        ]);

        res.json(popularAlbums);
    } catch (error) {
        console.log(error);
        res.status(500).json({ error: "Failed to fetch reviews" });
    }
});



module.exports = router;
