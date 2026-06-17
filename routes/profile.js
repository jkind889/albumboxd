const express = require("express");
const { clerkClient, getAuth } = require("@clerk/express");
const UserProfile = require("../models/UserProfile");
const Follow = require("../models/Follow");
const Review = require("../models/Reviews");
const AlbumCatalog = require("../models/AlbumCatalog");
const Board = require("../models/Board");
const BoardItem = require("../models/BoardItem");
const Like = require("../models/Like");
const Notification = require("../models/Notification");
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
const PRIVATE_PROFILE_ERROR = {
  error: "Profile is private",
  isPrivate: true,
};

function ensureAuthenticated(req, res, next) {
  const { userId } = getAuth(req);

  if (!userId) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  req.userId = userId;
  next();
}

function getViewerId(req) {
  try {
    return getAuth(req).userId || "";
  } catch {
    return "";
  }
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

async function getUserBoards(userId) {
  const boards = await Board.find({ userId }).sort({ isDefault: -1, updatedAt: -1 });

  return Promise.all(boards.map(formatPinnedBoard));
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
    isPrivate: Boolean(source.isPrivate),
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
    isPrivate: false,
    favoriteAlbums: [],
    listeningNextAlbum: null,
    pinnedReviewId: null,
    pinnedBoardId: null,
  });
}

async function getProfileAccess(targetUserId, viewerId = "") {
  if (!(await isFollowableUser(targetUserId))) {
    return { status: 404, error: { error: "User not found" } };
  }

  const profile = await UserProfile.findOne({ userId: targetUserId });
  const isOwner = Boolean(viewerId && viewerId === targetUserId);

  if (profile?.isPrivate && !isOwner) {
    return { status: 403, error: PRIVATE_PROFILE_ERROR, profile };
  }

  return { status: 200, profile };
}

async function formatPrivateProfile(profile, viewerId) {
  const source = toPlainDocument(profile);
  const authorsByUserId = await getAuthorsByUserId([source.userId]);
  const author = authorsByUserId.get(source.userId) || getAuthorFromUser(source.userId);
  const socialStats = await getSocialStats(source.userId, viewerId);

  return {
    userId: source.userId,
    username: author.username,
    imageUrl: author.imageUrl,
    isPrivate: true,
    ...socialStats,
  };
}

async function isFollowableUser(userId) {
  if (await Review.exists({ userId })) {
    return true;
  }

  return Boolean(await UserProfile.exists({ userId }));
}

async function createFollowNotification({ actorUserId, recipientUserId }) {
  if (!recipientUserId || recipientUserId === actorUserId) {
    return;
  }

  await Notification.updateOne(
    {
      recipientUserId,
      actorUserId,
      type: "follow",
    },
    {
      $setOnInsert: {
        recipientUserId,
        actorUserId,
        type: "follow",
      },
    },
    { upsert: true },
  );
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

function getActivityTimestamp(activity) {
  const timestamp = new Date(activity.createdAt).getTime();

  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function sortAndLimitActivity(activities) {
  return activities
    .sort((first, second) => getActivityTimestamp(second) - getActivityTimestamp(first))
    .slice(0, DEFAULT_ACTIVITY_LIMIT);
}

function formatLikedAlbumActivity(like, actor, catalogAlbum) {
  const source = toPlainDocument(like);
  const normalizedAlbum = catalogAlbum ? normalizeCatalogAlbum(catalogAlbum) : null;

  return {
    id: String(source._id || `liked-album-${source.spotifyId}`),
    type: "liked_album",
    actor,
    userId: source.userId,
    createdAt: source.createdAt,
    album: {
      spotifyId: source.spotifyId,
      title: normalizedAlbum?.title || "Unknown Album",
      artist: normalizedAlbum?.artist || "Artist unknown",
      cover: normalizedAlbum?.cover || "",
    },
  };
}

function formatLikedReviewActivity(like, review, actor, reviewAuthor) {
  const source = toPlainDocument(like);
  const plainReview = toPlainDocument(review);

  return {
    id: String(source._id || `liked-review-${plainReview._id}`),
    type: "liked_review",
    actor,
    userId: source.userId,
    createdAt: source.createdAt,
    reviewId: String(plainReview._id),
    reviewAuthor,
    album: {
      spotifyId: plainReview.spotifyId,
      title: plainReview.title,
      artist: plainReview.artist,
      cover: plainReview.cover || "",
    },
    rating: plainReview.rating,
    reviewText: plainReview.reviewText,
  };
}

function formatFollowActivity(follow, actor, targetUser) {
  const source = toPlainDocument(follow);

  return {
    id: String(source._id || `follow-${source.followingId}`),
    type: "follow",
    actor,
    userId: source.followerId,
    createdAt: source.createdAt,
    targetUser,
  };
}

async function getPrivateInteractionActivity(userId, actor) {
  const [likes, follows] = await Promise.all([
    Like.find({ userId }),
    Follow.find({ followerId: userId }),
  ]);
  const plainLikes = likes.map(toPlainDocument);
  const reviewLikeIds = [...new Set(
    plainLikes
      .filter((like) => like.targetType === "review" && like.reviewId)
      .map((like) => String(like.reviewId)),
  )];
  const albumLikeIds = [...new Set(
    plainLikes
      .filter((like) => like.targetType === "album" && like.spotifyId)
      .map((like) => like.spotifyId),
  )];
  const followedUserIds = [...new Set(
    follows
      .map((follow) => toPlainDocument(follow).followingId)
      .filter(Boolean),
  )];
  const [likedReviews, likedAlbums, followedUsersById] = await Promise.all([
    reviewLikeIds.length > 0 ? Review.find({ _id: { $in: reviewLikeIds } }) : Promise.resolve([]),
    albumLikeIds.length > 0 ? AlbumCatalog.find({ spotifyId: { $in: albumLikeIds } }) : Promise.resolve([]),
    getAuthorsByUserId(followedUserIds),
  ]);
  const reviewsById = new Map(likedReviews.map((review) => [getDocumentId(review), toPlainDocument(review)]));
  const albumBySpotifyId = new Map(
    likedAlbums.map((album) => {
      const source = toPlainDocument(album);
      return [source.spotifyId, source];
    }),
  );
  const reviewAuthorsByUserId = await getAuthorsByUserId(
    likedReviews.map((review) => toPlainDocument(review).userId),
  );
  const likeActivities = plainLikes
    .map((like) => {
      if (like.targetType === "album" && like.spotifyId) {
        return formatLikedAlbumActivity(like, actor, albumBySpotifyId.get(like.spotifyId));
      }

      if (like.targetType === "review" && like.reviewId) {
        const review = reviewsById.get(String(like.reviewId));

        if (!review) {
          return null;
        }

        return formatLikedReviewActivity(
          like,
          review,
          actor,
          reviewAuthorsByUserId.get(review.userId) || getAuthorFromUser(review.userId),
        );
      }

      return null;
    })
    .filter(Boolean);
  const followActivities = follows.map((follow) => {
    const source = toPlainDocument(follow);
    return formatFollowActivity(
      source,
      actor,
      getProfileUserFromAuthor(followedUsersById.get(source.followingId) || getAuthorFromUser(source.followingId)),
    );
  });

  return [...likeActivities, ...followActivities];
}

async function getUserActivity(userId, { includeSavedAlbums, includePrivateInteractions = false, viewerId = "" }) {
  const authorsByUserId = await getAuthorsByUserId([userId]);
  const actor = authorsByUserId.get(userId) || getAuthorFromUser(userId);
  const [reviews, savedAlbums, privateInteractions] = await Promise.all([
    Review.find({ userId }).sort({ date: -1 }).limit(DEFAULT_ACTIVITY_LIMIT),
    includeSavedAlbums
      ? getDefaultBoardItems(userId, { limit: DEFAULT_ACTIVITY_LIMIT })
      : Promise.resolve([]),
    includePrivateInteractions
      ? getPrivateInteractionActivity(userId, actor)
      : Promise.resolve([]),
  ]);

  const plainReviews = reviews.map(toPlainDocument);
  const likeStatsByReviewId = await getLikeStatsByReviewId(plainReviews, viewerId);

  return sortAndLimitActivity([
    ...plainReviews.map((review) => formatReviewActivity(
      review,
      actor,
      likeStatsByReviewId.get(getDocumentId(review)),
    )),
    ...savedAlbums.map((savedAlbum) => formatSavedAlbumActivity(savedAlbum, actor)),
    ...privateInteractions,
  ]);
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
    res.json(await getUserActivity(req.userId, {
      includeSavedAlbums: true,
      includePrivateInteractions: true,
      viewerId: req.userId,
    }));
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
        returnDocument: "after",
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

router.patch("/me", ensureAuthenticated, async(req, res) => {
  try {
    if (typeof req.body.isPrivate !== "boolean") {
      return res.status(400).json({ error: "isPrivate must be true or false" });
    }

    const profile = await UserProfile.findOneAndUpdate(
      { userId: req.userId },
      {
        $set: {
          userId: req.userId,
          isPrivate: req.body.isPrivate,
        },
      },
      {
        returnDocument: "after",
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
      await createFollowNotification({
        actorUserId: req.userId,
        recipientUserId: targetUserId,
      });
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
    const viewerId = getViewerId(req);

    if (!targetUserId || !boardId) {
      return res.status(400).json({ error: "User id and board id are required" });
    }

    const access = await getProfileAccess(targetUserId, viewerId);

    if (access.status !== 200) {
      return res.status(access.status).json(access.error);
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

router.get("/:userId/boards", async(req, res) => {
  try {
    const targetUserId = String(req.params.userId || "").trim();
    const viewerId = getViewerId(req);

    if (!targetUserId) {
      return res.status(400).json({ error: "User id is required" });
    }

    const access = await getProfileAccess(targetUserId, viewerId);

    if (access.status !== 200) {
      return res.status(access.status).json(access.error);
    }

    res.json(await getUserBoards(targetUserId));
  } catch (error) {
    console.log(error);
    res.status(500).json({ error: "Failed to fetch boards" });
  }
});

router.get("/:userId/network", async(req, res) => {
  try {
    const targetUserId = String(req.params.userId || "").trim();
    const viewerId = getViewerId(req);

    if (!targetUserId) {
      return res.status(400).json({ error: "User id is required" });
    }

    const access = await getProfileAccess(targetUserId, viewerId);

    if (access.status !== 200) {
      return res.status(access.status).json(access.error);
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
    const viewerId = getViewerId(req);

    if (!targetUserId) {
      return res.status(400).json({ error: "User id is required" });
    }

    const access = await getProfileAccess(targetUserId, viewerId);

    if (access.status !== 200) {
      return res.status(access.status).json(access.error);
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
    const viewerId = getViewerId(req);

    if (!targetUserId) {
      return res.status(400).json({ error: "User id is required" });
    }

    const access = await getProfileAccess(targetUserId, viewerId);

    if (access.status !== 200) {
      return res.status(access.status).json(access.error);
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
    const viewerId = getViewerId(req);

    if (!targetUserId) {
      return res.status(400).json({ error: "User id is required" });
    }

    if (!(await isFollowableUser(targetUserId))) {
      return res.status(404).json({ error: "User not found" });
    }

    const profile = await getOrCreateProfile(targetUserId);

    if (profile.isPrivate && viewerId !== targetUserId) {
      return res.json(await formatPrivateProfile(profile, viewerId));
    }

    res.json(await formatProfileWithSocial(profile, viewerId));
  } catch (error) {
    console.log(error);
    res.status(500).json({ error: "Failed to fetch profile" });
  }
});

module.exports = router;
