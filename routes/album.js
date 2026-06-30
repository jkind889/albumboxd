const express = require("express");
const Album = require("../models/Albums");
const AlbumCatalog = require("../models/AlbumCatalog");
const Follow = require("../models/Follow");
const Like = require("../models/Like");
const Review = require("../models/Reviews");
const { clerkClient, getAuth } = require("@clerk/express");
const {
    getAlbumCatalogDetails,
    getOrCreateAlbumCatalog,
    normalizeCatalogAlbum,
} = require("./utils/albumCatalog");
const {
    albumSaveRateLimit,
    getAuthenticatedUserRateLimitKey,
    getUserOrIpRateLimitKey,
    isRateLimitError,
    sendRateLimitError,
} = require("./utils/rateLimit");
const router = express.Router();
const CATALOG_PAGE_LIMIT = 24;
const MAX_CATALOG_PAGE_LIMIT = 24;
const DEFAULT_SOCIAL_USERNAME = "albumboxd user";
const RATING_DISTRIBUTION_BUCKETS = [1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5];

function ensureAuthenticated(req, res, next) {
    const { userId } = getAuth(req);

    if (!userId) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    req.userId = userId;
    next();
}

function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getPositiveInteger(value, fallback) {
    const parsedValue = Number.parseInt(value, 10);

    if (Number.isNaN(parsedValue) || parsedValue < 1) {
        return fallback;
    }

    return parsedValue;
}

function getCatalogLimit(value) {
    return Math.min(getPositiveInteger(value, CATALOG_PAGE_LIMIT), MAX_CATALOG_PAGE_LIMIT);
}

function getViewerId(req) {
    try {
        return getAuth(req).userId || "";
    } catch {
        return "";
    }
}

function toPlainDocument(document) {
    return typeof document?.toObject === "function" ? document.toObject() : document;
}

function getSocialUserFromClerk(userId, user) {
    return {
        userId,
        username: user?.username || DEFAULT_SOCIAL_USERNAME,
        imageUrl: user?.imageUrl || "",
    };
}

async function getSocialUsersById(userIds) {
    const socialUsersById = new Map();
    const uniqueUserIds = [...new Set(userIds.filter(Boolean))];

    for (const userId of uniqueUserIds) {
        socialUsersById.set(userId, getSocialUserFromClerk(userId));
    }

    if (uniqueUserIds.length === 0) {
        return socialUsersById;
    }

    try {
        const userList = await clerkClient.users.getUserList({ userId: uniqueUserIds });
        const users = Array.isArray(userList) ? userList : userList.data || [];

        for (const user of users) {
            socialUsersById.set(user.id, getSocialUserFromClerk(user.id, user));
        }
    } catch {
        // Social context should still render with fallback names if Clerk is unavailable.
    }

    return socialUsersById;
}

function getUniqueUserIds(documents) {
    return [...new Set(documents.map(toPlainDocument).map((document) => document.userId).filter(Boolean))];
}

function getEmptyRatingDistribution() {
    return RATING_DISTRIBUTION_BUCKETS.map((rating) => ({
        rating,
        count: 0,
    }));
}

async function getAlbumRatingSummary(spotifyId) {
    const distributionRows = await Review.aggregate([
        { $match: { spotifyId } },
        {
            $group: {
                _id: "$rating",
                count: { $sum: 1 },
            },
        },
        {
            $project: {
                _id: 0,
                rating: "$_id",
                count: 1,
            },
        },
        { $sort: { rating: 1 } },
    ]);
    const distributionCounts = new Map(
        distributionRows.map((row) => [Number(row.rating), Number(row.count) || 0]),
    );
    const ratingDistribution = getEmptyRatingDistribution().map((bucket) => ({
        ...bucket,
        count: distributionCounts.get(bucket.rating) || 0,
    }));
    const reviewCount = ratingDistribution.reduce((total, bucket) => total + bucket.count, 0);
    const ratingTotal = ratingDistribution.reduce((total, bucket) => total + (bucket.rating * bucket.count), 0);

    return {
        reviewCount,
        averageRating: reviewCount ? Math.round((ratingTotal / reviewCount) * 10) / 10 : null,
        ratingDistribution,
    };
}

async function getFollowedAlbumSocialContext(spotifyId, viewerId) {
    if (!viewerId) {
        return {
            followedReviewers: [],
            followedAlbumLikers: [],
        };
    }

    const followingRows = await Follow.find({ followerId: viewerId });
    const followedUserIds = [
        ...new Set(
            followingRows
                .map(toPlainDocument)
                .map((follow) => follow.followingId)
                .filter((followingId) => followingId && followingId !== viewerId),
        ),
    ];

    if (followedUserIds.length === 0) {
        return {
            followedReviewers: [],
            followedAlbumLikers: [],
        };
    }

    const [followedReviews, followedAlbumLikes] = await Promise.all([
        Review.find({ spotifyId, userId: { $in: followedUserIds } }),
        Like.find({ targetType: "album", spotifyId, userId: { $in: followedUserIds } }),
    ]);
    const followedReviewerIds = getUniqueUserIds(followedReviews);
    const followedAlbumLikerIds = getUniqueUserIds(followedAlbumLikes);
    const socialUsersById = await getSocialUsersById([...followedReviewerIds, ...followedAlbumLikerIds]);

    return {
        followedReviewers: followedReviewerIds.map((userId) => socialUsersById.get(userId) || getSocialUserFromClerk(userId)),
        followedAlbumLikers: followedAlbumLikerIds.map((userId) => socialUsersById.get(userId) || getSocialUserFromClerk(userId)),
    };
}

function buildCatalogQuery(query) {
    const trimmedQuery = query?.trim();

    if (!trimmedQuery) {
        return {};
    }

    const escapedQuery = escapeRegex(trimmedQuery);

    return {
        $or: [
            { title: { $regex: escapedQuery, $options: "i" } },
            { artist: { $regex: escapedQuery, $options: "i" } },
            { artists: { $regex: escapedQuery, $options: "i" } },
            { year: { $regex: escapedQuery, $options: "i" } },
            { label: { $regex: escapedQuery, $options: "i" } },
            { albumType: { $regex: escapedQuery, $options: "i" } },
        ],
    };
}

router.get("/catalog", async (req, res) => {
    try {
        const page = getPositiveInteger(req.query.page, 1);
        const limit = getCatalogLimit(req.query.limit);
        const skip = (page - 1) * limit;
        const catalogQuery = buildCatalogQuery(req.query.q);
        const [total, albums] = await Promise.all([
            AlbumCatalog.countDocuments(catalogQuery),
            AlbumCatalog.find(catalogQuery)
                .sort({ artist: 1, title: 1 })
                .skip(skip)
                .limit(limit),
        ]);

        res.json({
            results: albums.map(normalizeCatalogAlbum),
            page,
            limit,
            total,
            hasPreviousPage: page > 1,
            hasNextPage: skip + albums.length < total,
        });
    } catch (error) {
        res.status(500).json({ error: "Failed to fetch album catalog" });
    }
});

router.get("/album/:id/social", async(req, res) => {
    try {
        const spotifyId = String(req.params.id || "").trim();

        if (!spotifyId) {
            return res.status(400).json({ error: "Spotify id is required" });
        }

        const viewerId = getViewerId(req);
        const [savedCount, ratingSummary, followedSocialContext] = await Promise.all([
            Album.countDocuments({ spotifyId }),
            getAlbumRatingSummary(spotifyId),
            getFollowedAlbumSocialContext(spotifyId, viewerId),
        ]);

        res.json({
            spotifyId,
            savedCount,
            ...ratingSummary,
            ...followedSocialContext,
        });
    } catch (error) {
        console.log(error);
        res.status(500).json({ error: "Failed to fetch album social context" });
    }
});

// Album detail pages use the catalog cache before making any Spotify request.
router.get("/album/:id", async(req, res) =>
{
    try {
        const { album, isPartial, enrichmentError } = await getAlbumCatalogDetails(req.params.id, {
            rateLimitKey: getUserOrIpRateLimitKey(req),
        });

        if (enrichmentError) {
            console.warn(`Spotify enrichment failed for album ${req.params.id}:`, enrichmentError.message);
        }

        res.json({
            ...normalizeCatalogAlbum(album),
            isPartial,
        });
    } catch (error) {
        if (isRateLimitError(error)) {
            return sendRateLimitError(res, error);
        }

        res.status(500).json({ error: "Failed to fetch album details" });
    }
});

// User saves only store a reference to the shared catalog album.
router.post("/album", ensureAuthenticated, albumSaveRateLimit, async(req, res) =>
{
    try {
        const { spotifyId } = req.body;

        if (!spotifyId) {
            return res.status(400).json({ error: "spotifyId is required" });
        }

        const catalogAlbum = await getOrCreateAlbumCatalog(spotifyId, {
            rateLimitKey: getAuthenticatedUserRateLimitKey(req),
        });
        const savedAlbum = await Album.create({
            albumCatalogId: catalogAlbum._id,
            spotifyId,
            userId: req.userId,
        });

        res.status(201).json({
            ...normalizeCatalogAlbum(catalogAlbum),
            _id: savedAlbum._id,
            albumCatalogId: savedAlbum.albumCatalogId,
            userId: savedAlbum.userId,
            savedAt: savedAlbum.savedAt,
        });
    } catch (error) {
        if (error.code === 11000) {
            return res.status(409).json({ error: "Album already exists in your collection" });
        }

        console.log(error);
        if (isRateLimitError(error)) {
            return sendRateLimitError(res, error);
        }

        res.status(500).json({ error: "Failed to create album" });
    }
});




module.exports = router
