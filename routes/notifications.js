const express = require("express");
const { clerkClient, getAuth } = require("@clerk/express");
const Notification = require("../models/Notification");
const Review = require("../models/Reviews");

const router = express.Router();
const DEFAULT_NOTIFICATION_LIMIT = 30;
const DEFAULT_AUTHOR_USERNAME = "rescened user";

function ensureAuthenticated(req, res, next) {
  const { userId } = getAuth(req);

  if (!userId) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  req.userId = userId;
  next();
}

function toPlainDocument(document) {
  return typeof document?.toObject === "function" ? document.toObject() : document;
}

function getDocumentId(document) {
  return String(document._id || document.id || "");
}

function getAuthorFromUser(userId, user) {
  return {
    userId,
    username: user?.username || user?.fullName || user?.primaryEmailAddress?.emailAddress || DEFAULT_AUTHOR_USERNAME,
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
    // Notifications should still render if Clerk profile enrichment is unavailable.
  }

  return authorsByUserId;
}

async function getReviewsById(reviewIds) {
  const uniqueReviewIds = [...new Set(reviewIds.filter(Boolean))];
  const reviewsById = new Map();

  if (uniqueReviewIds.length === 0) {
    return reviewsById;
  }

  const reviews = await Review.find({ _id: { $in: uniqueReviewIds } });

  for (const review of reviews.map(toPlainDocument)) {
    reviewsById.set(getDocumentId(review), review);
  }

  return reviewsById;
}

function formatNotification(notification, actor, review) {
  const source = toPlainDocument(notification);
  const reviewId = source.reviewId ? String(source.reviewId) : "";

  return {
    _id: getDocumentId(source),
    type: source.type,
    recipientUserId: source.recipientUserId,
    actorUserId: source.actorUserId,
    actor,
    reviewId,
    spotifyId: source.spotifyId || review?.spotifyId || "",
    readAt: source.readAt || null,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
    review: review
      ? {
        _id: getDocumentId(review),
        spotifyId: review.spotifyId,
        title: review.title,
        artist: review.artist,
        cover: review.cover || "",
        rating: review.rating,
      }
      : null,
  };
}

router.get("/unread-count", ensureAuthenticated, async(req, res) => {
  try {
    const unreadCount = await Notification.countDocuments({
      recipientUserId: req.userId,
      readAt: null,
    });

    res.json({ unreadCount });
  } catch (error) {
    console.log(error);
    res.status(500).json({ error: "Failed to fetch notification count" });
  }
});

router.get("/", ensureAuthenticated, async(req, res) => {
  try {
    const notifications = await Notification.find({ recipientUserId: req.userId })
      .sort({ createdAt: -1 })
      .limit(DEFAULT_NOTIFICATION_LIMIT);
    const plainNotifications = notifications.map(toPlainDocument);
    const [authorsByUserId, reviewsById] = await Promise.all([
      getAuthorsByUserId(plainNotifications.map((notification) => notification.actorUserId)),
      getReviewsById(plainNotifications.map((notification) => String(notification.reviewId || ""))),
    ]);
    const unreadIds = plainNotifications
      .filter((notification) => !notification.readAt)
      .map(getDocumentId)
      .filter(Boolean);

    if (unreadIds.length > 0) {
      await Notification.updateMany(
        { _id: { $in: unreadIds }, recipientUserId: req.userId, readAt: null },
        { $set: { readAt: new Date() } },
      );
    }

    res.json({
      notifications: plainNotifications.map((notification) => formatNotification(
        notification,
        authorsByUserId.get(notification.actorUserId) || getAuthorFromUser(notification.actorUserId),
        reviewsById.get(String(notification.reviewId || "")),
      )),
    });
  } catch (error) {
    console.log(error);
    res.status(500).json({ error: "Failed to fetch notifications" });
  }
});

module.exports = router;
