const express = require("express");
const Review = require("../models/Reviews");
const AlbumCatalog = require("../models/AlbumCatalog");
const { clerkClient, getAuth } = require("@clerk/express");
const { normalizeCatalogAlbum } = require("./utils/albumCatalog");

const router = express.Router();
const DEFAULT_AUTHOR_USERNAME = "albumboxd user";
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

function buildPopularAlbumsPipeline({ limit, timeWindow }) {
    const startDate = getPopularDateFilter(timeWindow);
    const matchStage = startDate ? [{ $match: { date: { $gte: startDate } } }] : [];

    return [
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
    ];
}

async function getPopularAlbums({ limit, timeWindow }) {
    return Review.aggregate(buildPopularAlbumsPipeline({ limit, timeWindow }));
}

function toPlainReview(review) {
    return typeof review?.toObject === "function" ? review.toObject() : review;
}

function getAuthorFromUser(userId, user) {
    return {
        userId,
        username: user?.username || DEFAULT_AUTHOR_USERNAME,
        imageUrl: user?.imageUrl || "",
    };
}

async function getAuthorsByUserId(userIds) {
    const authorsByUserId = new Map();
    const uniqueUserIds = [...new Set(userIds.filter(Boolean))];

    for (const userId of uniqueUserIds) {
        authorsByUserId.set(userId, getAuthorFromUser(userId));
    }

    if (uniqueUserIds.length === 0) {
        return authorsByUserId;
    }

    try {
        const userList = await clerkClient.users.getUserList({ userId: uniqueUserIds });
        const users = Array.isArray(userList) ? userList : userList.data || [];

        for (const user of users) {
            authorsByUserId.set(user.id, getAuthorFromUser(user.id, user));
        }
    } catch {
        // Author metadata should never block review rendering.
    }

    return authorsByUserId;
}

async function addAuthorsToReviews(reviews) {
    const plainReviews = reviews.map(toPlainReview);
    const authorsByUserId = await getAuthorsByUserId(plainReviews.map((review) => review.userId));

    return plainReviews.map((review) => ({
        ...review,
        author: authorsByUserId.get(review.userId) || getAuthorFromUser(review.userId),
    }));
}

function addUniqueAlbums(target, albums, seenSpotifyIds) {
    for (const album of albums) {
        if (!album.spotifyId || !album.cover || seenSpotifyIds.has(album.spotifyId)) {
            continue;
        }

        seenSpotifyIds.add(album.spotifyId);
        target.push(album);
    }
}

function toFeaturedCatalogAlbum(album) {
    const normalizedAlbum = normalizeCatalogAlbum(album);

    return {
        spotifyId: normalizedAlbum.spotifyId,
        title: normalizedAlbum.title,
        artist: normalizedAlbum.artist,
        cover: normalizedAlbum.cover,
        year: normalizedAlbum.year,
    };
}

async function getCatalogFeaturedAlbums(limit, excludedSpotifyIds) {
    if (limit <= 0) {
        return [];
    }

    const catalogAlbums = await AlbumCatalog.find({
        spotifyId: { $nin: [...excludedSpotifyIds] },
        $or: [
            { cover: { $nin: [null, ""] } },
            { "imgs.0": { $exists: true } },
        ],
    })
        .sort({ updatedAt: -1, createdAt: -1 })
        .limit(limit);

    return catalogAlbums.map(toFeaturedCatalogAlbum);
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
            const [reviewWithAuthor] = await addAuthorsToReviews([review]);
            res.status(201).json(reviewWithAuthor);
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
        res.json(await addAuthorsToReviews(reviews));
    } catch (error) {
        console.log(error);
        res.status(500).json({ error: "Failed to fetch review" });
    }
});

router.get("/popular", async(req, res) => {
    try {
        const limit = getPopularLimit(req.query.limit);
        const popularAlbums = await getPopularAlbums({ limit, timeWindow: req.query.window });

        res.json(popularAlbums);
    } catch (error) {
        console.log(error);
        res.status(500).json({ error: "Failed to fetch reviews" });
    }
});

router.get("/featured", async(req, res) => {
    try {
        const limit = getPopularLimit(req.query.limit);
        const featuredAlbums = [];
        const seenSpotifyIds = new Set();
        // tries popular albums from last 30 days
        addUniqueAlbums(
            featuredAlbums,
            await getPopularAlbums({ limit, timeWindow: "30d" }),
            seenSpotifyIds,
        );
        // tries all time next
        if (featuredAlbums.length < limit) {
            addUniqueAlbums(
                featuredAlbums,
                await getPopularAlbums({ limit, timeWindow: "all" }),
                seenSpotifyIds,
            );
        }
        // then tries recent album catalog items
        if (featuredAlbums.length < limit) {
            addUniqueAlbums(
                featuredAlbums,
                await getCatalogFeaturedAlbums(limit - featuredAlbums.length, seenSpotifyIds),
                seenSpotifyIds,
            );
        }

        res.json(featuredAlbums.slice(0, limit));
    } catch (error) {
        console.log(error);
        res.status(500).json({ error: "Failed to fetch featured albums" });
    }
});



module.exports = router;
