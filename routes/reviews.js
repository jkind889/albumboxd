const express = require("express");
const Review = require("../models/Reviews");
const AlbumCatalog = require("../models/AlbumCatalog");
const Like = require("../models/Like");
const { clerkClient, getAuth } = require("@clerk/express");
const { normalizeCatalogAlbum } = require("./utils/albumCatalog");

const router = express.Router();
const DEFAULT_AUTHOR_USERNAME = "albumboxd user";
const MIN_POPULAR_LIMIT = 5;
const MAX_POPULAR_LIMIT = 10;
const DEFAULT_POPULAR_LIMIT = 5;
const MAX_LIST_LIMIT = 12;
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

function getListLimit(value, defaultLimit = DEFAULT_POPULAR_LIMIT) {
    const parsedLimit = Number.parseInt(value, 10);

    if (Number.isNaN(parsedLimit)) {
        return defaultLimit;
    }

    return Math.min(Math.max(parsedLimit, 1), MAX_LIST_LIMIT);
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

function toAlbumPreviewFromReview(review) {
    return {
        spotifyId: review.spotifyId,
        title: review.title,
        artist: review.artist,
        cover: review.cover,
        latestReviewDate: review.date,
    };
}

async function getRecentlyReviewedAlbums(limit) {
    const reviews = await Review.find({}).sort({ date: -1 });
    const seenSpotifyIds = new Set();
    const albums = [];

    for (const review of reviews) {
        if (!review.spotifyId || seenSpotifyIds.has(review.spotifyId)) {
            continue;
        }

        seenSpotifyIds.add(review.spotifyId);
        albums.push(toAlbumPreviewFromReview(toPlainReview(review)));

        if (albums.length >= limit) {
            break;
        }
    }

    return albums;
}

async function getPopularReviews(limit) {
    const reviews = await addLikesToReviews(await Review.find({}).sort({ date: -1 }));
    const popularReviews = reviews
        .sort((first, second) => (
            (Number(second.likeCount) || 0) - (Number(first.likeCount) || 0)
            || (Number(second.rating) || 0) - (Number(first.rating) || 0)
            || new Date(second.date || 0).getTime() - new Date(first.date || 0).getTime()
        ))
        .slice(0, limit);

    return addAuthorsToReviews(popularReviews);
}

function toPlainReview(review) {
    return typeof review?.toObject === "function" ? review.toObject() : review;
}

function getViewerId(req) {
    try {
        return getAuth(req).userId || "";
    } catch {
        return "";
    }
}

function getReviewId(review) {
    return String(review._id || review.id || "");
}

async function getLikeStatsByReviewId(reviews, viewerId) {
    const reviewIds = [...new Set(reviews.map(getReviewId).filter(Boolean))];
    const statsByReviewId = new Map();

    for (const reviewId of reviewIds) {
        statsByReviewId.set(reviewId, {
            likeCount: 0,
            likedByViewer: false,
        });
    }

    if (reviewIds.length === 0) {
        return statsByReviewId;
    }

    const likes = await Like.find({
        targetType: "review",
        reviewId: { $in: reviewIds },
    });

    for (const like of likes.map(toPlainReview)) {
        const reviewId = String(like.reviewId || "");
        const stats = statsByReviewId.get(reviewId);

        if (!stats) {
            continue;
        }

        stats.likeCount += 1;

        if (viewerId && like.userId === viewerId) {
            stats.likedByViewer = true;
        }
    }

    return statsByReviewId;
}

async function addLikesToReviews(reviews, viewerId = "") {
    const plainReviews = reviews.map(toPlainReview);
    const statsByReviewId = await getLikeStatsByReviewId(plainReviews, viewerId);

    return plainReviews.map((review) => {
        const stats = statsByReviewId.get(getReviewId(review)) || {
            likeCount: 0,
            likedByViewer: false,
        };

        return {
            ...review,
            likeCount: stats.likeCount,
            likedByViewer: stats.likedByViewer,
        };
    });
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

async function addAuthorsToReviews(reviews, viewerId = "") {
    const reviewsWithLikes = await addLikesToReviews(reviews, viewerId);
    const authorsByUserId = await getAuthorsByUserId(reviewsWithLikes.map((review) => review.userId));

    return reviewsWithLikes.map((review) => ({
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

function getReviewUpdatePayload(body) {
    const reviewText = String(body?.reviewText || "").trim();
    const rating = Number(body?.rating);

    if (!reviewText) {
        return { error: "Review text is required" };
    }

    if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
        return { error: "Rating must be between 1 and 5" };
    }

    return {
        update: {
            reviewText,
            rating,
        },
    };
}

router.post("/review", ensureAuthenticated, async(req, res) =>
    {
        const userId = req.userId;


        try {
            const review = await Review.create(
                { ...req.body, userId }
            );
            const [reviewWithAuthor] = await addAuthorsToReviews([review], userId);
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
            const reviews = await Review.find({ userId }).sort({ date: -1 });
            res.json(await addAuthorsToReviews(reviews, userId));
        } catch (error) {
            console.log(error);
            res.status(500).json({ error: "Failed to fetch reviews" });
        }
    });

router.get("/review/user/:userId", async(req, res) => {
    try {
        const targetUserId = String(req.params.userId || "").trim();
        const viewerId = getViewerId(req);

        if (!targetUserId) {
            return res.status(400).json({ error: "User id is required" });
        }

        const reviews = await Review.find({ userId: targetUserId }).sort({ date: -1 });
        res.json(await addAuthorsToReviews(reviews, viewerId));
    } catch (error) {
        console.log(error);
        res.status(500).json({ error: "Failed to fetch reviews" });
    }
});

router.patch("/review/user/:id", ensureAuthenticated, async(req, res) => {
    try {
        const parsedUpdate = getReviewUpdatePayload(req.body);

        if (parsedUpdate.error) {
            return res.status(400).json({ error: parsedUpdate.error });
        }

        const review = await Review.findOneAndUpdate(
            { _id: req.params.id, userId: req.userId },
            { $set: parsedUpdate.update },
            { new: true, runValidators: true }
        );

        if (!review) {
            return res.status(404).json({ error: "Review not found" });
        }

        const [reviewWithAuthor] = await addAuthorsToReviews([review], req.userId);
        res.json(reviewWithAuthor);
    } catch (error) {
        console.log(error);
        res.status(500).json({ error: "Failed to update review" });
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
        const viewerId = getViewerId(req);
        const reviews = await Review.find({ spotifyId: req.params.albumId }).sort({ date: -1 });
        res.json(await addAuthorsToReviews(reviews, viewerId));
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

router.get("/recent-albums", async(req, res) => {
    try {
        const limit = getListLimit(req.query.limit, 6);
        const albums = await getRecentlyReviewedAlbums(limit);

        res.json(albums);
    } catch (error) {
        console.log(error);
        res.status(500).json({ error: "Failed to fetch recent albums" });
    }
});

router.get("/popular-reviews", async(req, res) => {
    try {
        const limit = getListLimit(req.query.limit, 4);
        const reviews = await getPopularReviews(limit);

        res.json(reviews);
    } catch (error) {
        console.log(error);
        res.status(500).json({ error: "Failed to fetch popular reviews" });
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
