const express = require("express");
const { clerkClient, getAuth } = require("@clerk/express");
const UserProfile = require("../models/UserProfile");
const Follow = require("../models/Follow");
const Review = require("../models/Reviews");
const Album = require("../models/Albums");
const Like = require("../models/Like");
const {
  getOrCreateAlbumCatalog,
  normalizeCatalogAlbum,
} = require("./utils/albumCatalog");

const router = express.Router();
const MAX_BIO_LENGTH = 280;
const MAX_FAVORITE_ALBUMS = 5;
const DEFAULT_AUTHOR_USERNAME = "albumboxd user";
const DEFAULT_ACTIVITY_LIMIT = 20;
const SPOTIFY_PROFILE_HOST = "open.spotify.com";
const SPOTIFY_PROFILE_PATH_PREFIX = "/user/";

function ensureAuthenticated(req, res, next) {
  const { userId } = getAuth(req);

  if (!userId) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  req.userId = userId;
  next();
}

function getCatalogAlbum(favoriteAlbum) {
  const catalogAlbum = favoriteAlbum.albumCatalogId;

  if (catalogAlbum && typeof catalogAlbum === "object" && catalogAlbum.spotifyId) {
    return catalogAlbum;
  }

  return {
    spotifyId: favoriteAlbum.spotifyId,
    title: "Unknown Album",
    artist: "Unknown Artist",
  };
}

function formatProfile(profile) {
  const source = typeof profile.toObject === "function" ? profile.toObject() : profile;
  const favoriteAlbums = [...(source.favoriteAlbums || [])]
    .sort((first, second) => first.rank - second.rank)
    .map((favoriteAlbum) => normalizeCatalogAlbum(getCatalogAlbum(favoriteAlbum)));

  return {
    userId: source.userId,
    bio: source.bio || "",
    spotifyProfileUrl: source.spotifyProfileUrl || "",
    favoriteAlbums,
  };
}

function normalizeSpotifyProfileUrl(value) {
  const spotifyProfileUrl = typeof value === "string" ? value.trim() : "";

  if (!spotifyProfileUrl) {
    return "";
  }

  try {
    const url = new URL(spotifyProfileUrl);
    const hasUserPath = url.pathname.startsWith(SPOTIFY_PROFILE_PATH_PREFIX)
      && url.pathname.length > SPOTIFY_PROFILE_PATH_PREFIX.length;

    if (url.protocol === "https:" && url.hostname === SPOTIFY_PROFILE_HOST && hasUserPath) {
      return url.toString();
    }
  } catch {
    return null;
  }

  return null;
}

async function getSocialStats(userId, viewerId) {
  const [followerCount, followingCount, isFollowing] = await Promise.all([
    Follow.countDocuments({ followingId: userId }),
    Follow.countDocuments({ followerId: userId }),
    viewerId && viewerId !== userId
      ? Follow.exists({ followerId: viewerId, followingId: userId })
      : Promise.resolve(false),
  ]);

  return {
    followerCount,
    followingCount,
    isFollowing: Boolean(isFollowing),
    isCurrentUser: Boolean(viewerId && viewerId === userId),
  };
}

async function formatProfileWithSocial(profile, viewerId) {
  const formattedProfile = formatProfile(profile);
  const socialStats = await getSocialStats(formattedProfile.userId, viewerId);

  return {
    ...formattedProfile,
    ...socialStats,
  };
}

async function getOrCreateProfile(userId) {
  const existingProfile = await UserProfile.findOne({ userId })
    .populate("favoriteAlbums.albumCatalogId");

  if (existingProfile) {
    return existingProfile;
  }

  return UserProfile.create({
    userId,
    bio: "",
    spotifyProfileUrl: "",
    favoriteAlbums: [],
  });
}

async function isFollowableUser(userId) {
  return Boolean(await Review.exists({ userId }));
}

function toPlainDocument(document) {
  return typeof document?.toObject === "function" ? document.toObject() : document;
}

function getDocumentId(document) {
  return String(document._id || document.id || "");
}

async function getLikeStatsByReviewId(reviews, viewerId) {
  const reviewIds = [...new Set(reviews.map(getDocumentId).filter(Boolean))];
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

  for (const like of likes.map(toPlainDocument)) {
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
    // Activity should still render when Clerk metadata is unavailable.
  }

  return authorsByUserId;
}

function formatReviewActivity(review, actor, likeStats = {}) {
  const source = toPlainDocument(review);

  return {
    id: String(source._id),
    type: "review",
    actor,
    userId: source.userId,
    createdAt: source.date,
    album: {
      spotifyId: source.spotifyId,
      title: source.title,
      artist: source.artist,
      cover: source.cover || "",
    },
    rating: source.rating,
    reviewText: source.reviewText,
    likeCount: likeStats.likeCount || 0,
    likedByViewer: Boolean(likeStats.likedByViewer),
  };
}

function getSavedAlbumActivityAlbum(savedAlbum) {
  const source = toPlainDocument(savedAlbum);
  const catalogAlbum = source.albumCatalogId;

  if (catalogAlbum && typeof catalogAlbum === "object" && catalogAlbum.spotifyId) {
    return normalizeCatalogAlbum(catalogAlbum);
  }

  return {
    spotifyId: source.spotifyId,
    title: "Unknown Album",
    artist: "Unknown Artist",
    cover: "",
  };
}

function formatSavedAlbum(savedAlbum) {
  const source = toPlainDocument(savedAlbum);
  const catalogAlbum = source.albumCatalogId;

  if (!catalogAlbum || typeof catalogAlbum !== "object" || !catalogAlbum.spotifyId) {
    return source;
  }

  return {
    ...normalizeCatalogAlbum(catalogAlbum),
    _id: source._id,
    albumCatalogId: catalogAlbum._id,
    userId: source.userId,
    savedAt: source.savedAt,
  };
}

function formatSavedAlbumActivity(savedAlbum, actor) {
  const source = toPlainDocument(savedAlbum);
  const album = getSavedAlbumActivityAlbum(source);

  return {
    id: String(source._id || `${source.userId}-${source.spotifyId}`),
    type: "saved_album",
    actor,
    userId: source.userId,
    createdAt: source.savedAt,
    album: {
      spotifyId: album.spotifyId,
      title: album.title,
      artist: album.artist || getCatalogAlbum({ spotifyId: album.spotifyId }).artist,
      cover: album.cover || "",
    },
  };
}

async function getUserActivity(userId, { includeSavedAlbums, viewerId = "" }) {
  const authorsByUserId = await getAuthorsByUserId([userId]);
  const actor = authorsByUserId.get(userId) || getAuthorFromUser(userId);
  const [reviews, savedAlbums] = await Promise.all([
    Review.find({ userId }).sort({ date: -1 }).limit(DEFAULT_ACTIVITY_LIMIT),
    includeSavedAlbums
      ? Album.find({ userId })
        .populate("albumCatalogId")
        .sort({ savedAt: -1 })
        .limit(DEFAULT_ACTIVITY_LIMIT)
      : Promise.resolve([]),
  ]);

  const plainReviews = reviews.map(toPlainDocument);
  const likeStatsByReviewId = await getLikeStatsByReviewId(plainReviews, viewerId);

  return [
    ...plainReviews.map((review) => formatReviewActivity(
      review,
      actor,
      likeStatsByReviewId.get(getDocumentId(review)),
    )),
    ...savedAlbums.map((savedAlbum) => formatSavedAlbumActivity(savedAlbum, actor)),
  ]
    .sort((first, second) => new Date(second.createdAt) - new Date(first.createdAt))
    .slice(0, DEFAULT_ACTIVITY_LIMIT);
}

router.get("/me", ensureAuthenticated, async(req, res) => {
  try {
    const profile = await getOrCreateProfile(req.userId);
    res.json(await formatProfileWithSocial(profile, req.userId));
  } catch (error) {
    console.log(error);
    res.status(500).json({ error: "Failed to fetch profile" });
  }
});

router.get("/me/network", ensureAuthenticated, async(req, res) => {
  try {
    const followingRows = await Follow.find({ followerId: req.userId });
    const followedUserIds = [
      ...new Set(
        followingRows
          .map((follow) => toPlainDocument(follow).followingId)
          .filter((followingId) => followingId && followingId !== req.userId),
      ),
    ];

    if (followedUserIds.length === 0) {
      return res.json([]);
    }

    const reviews = await Review.find({ userId: { $in: followedUserIds } })
      .sort({ date: -1 })
      .limit(DEFAULT_ACTIVITY_LIMIT);
    const authorsByUserId = await getAuthorsByUserId(reviews.map((review) => toPlainDocument(review).userId));
    const plainReviews = reviews.map(toPlainDocument);
    const likeStatsByReviewId = await getLikeStatsByReviewId(plainReviews, req.userId);
    const activities = plainReviews.map((source) => {
      return formatReviewActivity(
        source,
        authorsByUserId.get(source.userId) || getAuthorFromUser(source.userId),
        likeStatsByReviewId.get(getDocumentId(source)),
      );
    });

    res.json(activities);
  } catch (error) {
    console.log(error);
    res.status(500).json({ error: "Failed to fetch network activity" });
  }
});

router.get("/me/activity", ensureAuthenticated, async(req, res) => {
  try {
    res.json(await getUserActivity(req.userId, { includeSavedAlbums: true, viewerId: req.userId }));
  } catch (error) {
    console.log(error);
    res.status(500).json({ error: "Failed to fetch activity" });
  }
});

router.put("/me", ensureAuthenticated, async(req, res) => {
  try {
    const bio = typeof req.body.bio === "string" ? req.body.bio.trim() : "";
    const spotifyProfileUrl = normalizeSpotifyProfileUrl(req.body.spotifyProfileUrl);
    const favoriteAlbumIds = Array.isArray(req.body.favoriteAlbumIds)
      ? req.body.favoriteAlbumIds.map((id) => String(id).trim()).filter(Boolean)
      : [];

    if (bio.length > MAX_BIO_LENGTH) {
      return res.status(400).json({ error: "Bio must be 280 characters or fewer" });
    }

    if (spotifyProfileUrl === null) {
      return res.status(400).json({ error: "Spotify profile must be an https://open.spotify.com/user/... URL" });
    }

    if (favoriteAlbumIds.length > MAX_FAVORITE_ALBUMS) {
      return res.status(400).json({ error: "Choose up to five favorite albums" });
    }

    if (new Set(favoriteAlbumIds).size !== favoriteAlbumIds.length) {
      return res.status(400).json({ error: "Favorite albums must be unique" });
    }

    const favoriteAlbums = await Promise.all(
      favoriteAlbumIds.map(async(spotifyId, index) => {
        const catalogAlbum = await getOrCreateAlbumCatalog(spotifyId);

        return {
          spotifyId,
          albumCatalogId: catalogAlbum._id,
          rank: index,
        };
      }),
    );

    const profile = await UserProfile.findOneAndUpdate(
      { userId: req.userId },
      {
        $set: {
          userId: req.userId,
          bio,
          spotifyProfileUrl,
          favoriteAlbums,
        },
      },
      {
        new: true,
        upsert: true,
        setDefaultsOnInsert: true,
      },
    ).populate("favoriteAlbums.albumCatalogId");

    res.json(await formatProfileWithSocial(profile, req.userId));
  } catch (error) {
    console.log(error);
    res.status(500).json({ error: "Failed to update profile" });
  }
});

router.put("/:userId/follow", ensureAuthenticated, async(req, res) => {
  try {
    const targetUserId = String(req.params.userId || "").trim();

    if (req.body.following !== true && req.body.following !== false) {
      return res.status(400).json({ error: "following must be true or false" });
    }

    if (!targetUserId) {
      return res.status(400).json({ error: "User id is required" });
    }

    if (targetUserId === req.userId) {
      return res.status(400).json({ error: "You cannot follow yourself" });
    }

    if (!(await isFollowableUser(targetUserId))) {
      return res.status(404).json({ error: "User not found" });
    }

    await Promise.all([
      getOrCreateProfile(req.userId),
      getOrCreateProfile(targetUserId),
    ]);

    if (req.body.following) {
      await Follow.updateOne(
        { followerId: req.userId, followingId: targetUserId },
        { $setOnInsert: { followerId: req.userId, followingId: targetUserId } },
        { upsert: true },
      );
    } else {
      await Follow.deleteOne({ followerId: req.userId, followingId: targetUserId });
    }

    res.json({
      targetUserId,
      ...(await getSocialStats(targetUserId, req.userId)),
    });
  } catch (error) {
    console.log(error);
    res.status(500).json({ error: "Failed to update follow status" });
  }
});

router.get("/:userId/activity", async(req, res) => {
  try {
    const targetUserId = String(req.params.userId || "").trim();
    const { userId: viewerId } = getAuth(req);

    if (!targetUserId) {
      return res.status(400).json({ error: "User id is required" });
    }

    if (!(await isFollowableUser(targetUserId))) {
      return res.status(404).json({ error: "User not found" });
    }

    res.json(await getUserActivity(targetUserId, { includeSavedAlbums: true, viewerId }));
  } catch (error) {
    console.log(error);
    res.status(500).json({ error: "Failed to fetch activity" });
  }
});

router.get("/:userId/saved", async(req, res) => {
  try {
    const targetUserId = String(req.params.userId || "").trim();

    if (!targetUserId) {
      return res.status(400).json({ error: "User id is required" });
    }

    if (!(await isFollowableUser(targetUserId))) {
      return res.status(404).json({ error: "User not found" });
    }

    const savedAlbums = await Album.find({ userId: targetUserId })
      .populate("albumCatalogId")
      .sort({ savedAt: -1 });

    res.json(savedAlbums.map(formatSavedAlbum));
  } catch (error) {
    console.log(error);
    res.status(500).json({ error: "Failed to fetch saved albums" });
  }
});

router.get("/:userId", async(req, res) => {
  try {
    const targetUserId = String(req.params.userId || "").trim();
    const { userId: viewerId } = getAuth(req);

    if (!targetUserId) {
      return res.status(400).json({ error: "User id is required" });
    }

    if (!(await isFollowableUser(targetUserId))) {
      return res.status(404).json({ error: "User not found" });
    }

    const profile = await getOrCreateProfile(targetUserId);
    res.json(await formatProfileWithSocial(profile, viewerId));
  } catch (error) {
    console.log(error);
    res.status(500).json({ error: "Failed to fetch profile" });
  }
});

module.exports = router;
