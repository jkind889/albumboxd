const express = require("express");
const { clerkClient, getAuth } = require("@clerk/express");
const UserProfile = require("../models/UserProfile");
const Follow = require("../models/Follow");
const Review = require("../models/Reviews");
const Board = require("../models/Board");
const BoardItem = require("../models/BoardItem");
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
const BOARD_PREVIEW_LIMIT = 4;
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

function getProfileAlbum(profileAlbum) {
  if (!profileAlbum) {
    return null;
  }

  const catalogAlbum = profileAlbum.albumCatalogId;

  if (catalogAlbum && typeof catalogAlbum === "object" && catalogAlbum.spotifyId) {
    return catalogAlbum;
  }

  return {
    spotifyId: profileAlbum.spotifyId,
    title: "Unknown Album",
    artist: "Unknown Artist",
  };
}

function formatPinnedReview(review) {
  if (!review || typeof review !== "object") {
    return null;
  }

  const source = toPlainDocument(review);

  if (!source.spotifyId) {
    return null;
  }

  return {
    _id: source._id,
    userId: source.userId,
    spotifyId: source.spotifyId,
    title: source.title,
    artist: source.artist,
    cover: source.cover || "",
    reviewText: source.reviewText || "",
    rating: source.rating,
    date: source.date,
  };
}

async function formatPinnedBoard(board) {
  if (!board || typeof board !== "object") {
    return null;
  }

  const source = toPlainDocument(board);

  if (!source._id) {
    return null;
  }

  const [items, count] = await Promise.all([
    BoardItem.find({ boardId: source._id })
      .populate("albumCatalogId")
      .sort({ savedAt: -1 })
      .limit(BOARD_PREVIEW_LIMIT),
    BoardItem.countDocuments({ boardId: source._id }),
  ]);

  return {
    _id: source._id,
    userId: source.userId,
    title: source.title,
    isDefault: Boolean(source.isDefault),
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
    itemCount: count,
    previewAlbums: items.map(formatSavedAlbum),
  };
}

async function formatBoardDetail(board) {
  const source = toPlainDocument(board);
  const items = await BoardItem.find({ boardId: source._id })
    .populate("albumCatalogId")
    .sort({ savedAt: -1 });
  const summary = await formatPinnedBoard(board);

  return {
    ...summary,
    albums: items.map(formatSavedAlbum),
  };
}

async function getDefaultBoardItems(userId, { limit } = {}) {
  const defaultBoard = await Board.findOne({ userId, isDefault: true });

  if (!defaultBoard) {
    return [];
  }

  const source = toPlainDocument(defaultBoard);
  const query = BoardItem.find({ boardId: source._id })
    .populate("albumCatalogId")
    .sort({ savedAt: -1 });

  return typeof limit === "number" ? query.limit(limit) : query;
}

async function formatProfile(profile) {
  const source = typeof profile.toObject === "function" ? profile.toObject() : profile;
  const authorsByUserId = await getAuthorsByUserId([source.userId]);
  const author = authorsByUserId.get(source.userId) || getAuthorFromUser(source.userId);
  const favoriteAlbums = [...(source.favoriteAlbums || [])]
    .sort((first, second) => first.rank - second.rank)
    .map((favoriteAlbum) => normalizeCatalogAlbum(getCatalogAlbum(favoriteAlbum)));
  const listeningNextAlbum = source.listeningNextAlbum
    ? normalizeCatalogAlbum(getProfileAlbum(source.listeningNextAlbum))
    : null;

  return {
    userId: source.userId,
    username: author.username,
    imageUrl: author.imageUrl,
    bio: source.bio || "",
    spotifyProfileUrl: source.spotifyProfileUrl || "",
    favoriteAlbums,
    listeningNextAlbum,
    pinnedReview: formatPinnedReview(source.pinnedReviewId),
    pinnedBoard: await formatPinnedBoard(source.pinnedBoardId),
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
  const formattedProfile = await formatProfile(profile);
  const socialStats = await getSocialStats(formattedProfile.userId, viewerId);

  return {
    ...formattedProfile,
    ...socialStats,
  };
}

async function getOrCreateProfile(userId) {
  const existingProfile = await UserProfile.findOne({ userId })
    .populate("favoriteAlbums.albumCatalogId")
    .populate("listeningNextAlbum.albumCatalogId")
    .populate("pinnedReviewId")
    .populate("pinnedBoardId");

  if (existingProfile) {
    return existingProfile;
  }

  return UserProfile.create({
    userId,
    bio: "",
    spotifyProfileUrl: "",
    favoriteAlbums: [],
    listeningNextAlbum: null,
    pinnedReviewId: null,
    pinnedBoardId: null,
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
      ? getDefaultBoardItems(userId, { limit: DEFAULT_ACTIVITY_LIMIT })
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

function getProfileUserFromAuthor(author) {
  return {
    userId: author.userId,
    username: author.username,
    imageUrl: author.imageUrl,
  };
}

async function getSocialUsers(rows, key) {
  const userIds = [...new Set(
    rows
      .map((follow) => toPlainDocument(follow)[key])
      .filter(Boolean),
  )];
  const authorsByUserId = await getAuthorsByUserId(userIds);

  return userIds.map((userId) => getProfileUserFromAuthor(
    authorsByUserId.get(userId) || getAuthorFromUser(userId),
  ));
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

router.get("/me/social", ensureAuthenticated, async(req, res) => {
  try {
    const [followerRows, followingRows] = await Promise.all([
      Follow.find({ followingId: req.userId }),
      Follow.find({ followerId: req.userId }),
    ]);
    const [followers, following] = await Promise.all([
      getSocialUsers(followerRows, "followerId"),
      getSocialUsers(followingRows, "followingId"),
    ]);

    res.json({
      userId: req.userId,
      followers,
      following,
      followerCount: followers.length,
      followingCount: following.length,
    });
  } catch (error) {
    console.log(error);
    res.status(500).json({ error: "Failed to fetch network" });
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
    const listeningNextAlbumId = typeof req.body.listeningNextAlbumId === "string"
      ? req.body.listeningNextAlbumId.trim()
      : "";
    const pinnedReviewId = typeof req.body.pinnedReviewId === "string"
      ? req.body.pinnedReviewId.trim()
      : "";
    const pinnedBoardId = typeof req.body.pinnedBoardId === "string"
      ? req.body.pinnedBoardId.trim()
      : "";

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
    const listeningNextCatalogAlbum = listeningNextAlbumId
      ? await getOrCreateAlbumCatalog(listeningNextAlbumId)
      : null;
    const [pinnedReview, pinnedBoard] = await Promise.all([
      pinnedReviewId ? Review.findOne({ _id: pinnedReviewId, userId: req.userId }) : Promise.resolve(null),
      pinnedBoardId ? Board.findOne({ _id: pinnedBoardId, userId: req.userId }) : Promise.resolve(null),
    ]);

    if (pinnedReviewId && !pinnedReview) {
      return res.status(400).json({ error: "Pinned review must belong to your profile" });
    }

    if (pinnedBoardId && !pinnedBoard) {
      return res.status(400).json({ error: "Pinned board must belong to your profile" });
    }

    const profile = await UserProfile.findOneAndUpdate(
      { userId: req.userId },
      {
        $set: {
          userId: req.userId,
          bio,
          spotifyProfileUrl,
          favoriteAlbums,
          listeningNextAlbum: listeningNextCatalogAlbum
            ? {
              spotifyId: listeningNextAlbumId,
              albumCatalogId: listeningNextCatalogAlbum._id,
            }
            : null,
          pinnedReviewId: pinnedReviewId || null,
          pinnedBoardId: pinnedBoardId || null,
        },
      },
      {
        new: true,
        upsert: true,
        setDefaultsOnInsert: true,
      },
    )
      .populate("favoriteAlbums.albumCatalogId")
      .populate("listeningNextAlbum.albumCatalogId")
      .populate("pinnedReviewId")
      .populate("pinnedBoardId");

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

router.get("/:userId/boards/:boardId", async(req, res) => {
  try {
    const targetUserId = String(req.params.userId || "").trim();
    const boardId = String(req.params.boardId || "").trim();

    if (!targetUserId || !boardId) {
      return res.status(400).json({ error: "User id and board id are required" });
    }

    if (!(await isFollowableUser(targetUserId))) {
      return res.status(404).json({ error: "User not found" });
    }

    const board = await Board.findOne({ _id: boardId, userId: targetUserId });

    if (!board) {
      return res.status(404).json({ error: "Board not found" });
    }

    res.json(await formatBoardDetail(board));
  } catch (error) {
    console.log(error);
    res.status(500).json({ error: "Failed to fetch board" });
  }
});

router.get("/:userId/network", async(req, res) => {
  try {
    const targetUserId = String(req.params.userId || "").trim();

    if (!targetUserId) {
      return res.status(400).json({ error: "User id is required" });
    }

    if (!(await isFollowableUser(targetUserId))) {
      return res.status(404).json({ error: "User not found" });
    }

    const [followerRows, followingRows] = await Promise.all([
      Follow.find({ followingId: targetUserId }),
      Follow.find({ followerId: targetUserId }),
    ]);

    const [followers, following] = await Promise.all([
      getSocialUsers(followerRows, "followerId"),
      getSocialUsers(followingRows, "followingId"),
    ]);

    res.json({
      userId: targetUserId,
      followers,
      following,
      followerCount: followers.length,
      followingCount: following.length,
    });
  } catch (error) {
    console.log(error);
    res.status(500).json({ error: "Failed to fetch network" });
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

    const savedAlbums = await getDefaultBoardItems(targetUserId);

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
