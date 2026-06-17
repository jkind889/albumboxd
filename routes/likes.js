const express = require("express");
const { getAuth } = require("@clerk/express");
const Like = require("../models/Like");
const Review = require("../models/Reviews");
const Notification = require("../models/Notification");
const { likeMutationRateLimit } = require("./utils/rateLimit");

const router = express.Router();

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

function normalizeLiked(value) {
  return value === true || value === false ? value : null;
}

async function createReviewLikeNotification({ actorUserId, review, reviewId }) {
  const recipientUserId = review.userId;

  if (!recipientUserId || recipientUserId === actorUserId) {
    return;
  }

  await Notification.updateOne(
    {
      recipientUserId,
      actorUserId,
      type: "review_like",
      reviewId,
    },
    {
      $setOnInsert: {
        recipientUserId,
        actorUserId,
        type: "review_like",
        reviewId,
        spotifyId: review.spotifyId,
      },
    },
    { upsert: true },
  );
}

router.get("/album/:spotifyId", async(req, res) => {
  try {
    const spotifyId = String(req.params.spotifyId || "").trim();
    const viewerId = getViewerId(req);

    if (!spotifyId) {
      return res.status(400).json({ error: "Spotify id is required" });
    }
    // counts total documents and then checks if the user liked tHe album
    const [likeCount, viewerLike] = await Promise.all([
      Like.countDocuments({ targetType: "album", spotifyId }),
      viewerId
        ? Like.exists({ targetType: "album", spotifyId, userId: viewerId })
        : Promise.resolve(false),
    ]);

    res.json({
      spotifyId,
      likeCount,
      likedByViewer: Boolean(viewerLike),
    });
  } catch (error) {
    console.log(error);
    res.status(500).json({ error: "Failed to fetch album likes" });
  }
});

router.put("/album/:spotifyId", ensureAuthenticated, likeMutationRateLimit, async(req, res) => {
  try {
    const spotifyId = String(req.params.spotifyId || "").trim();
    const liked = normalizeLiked(req.body.liked);

    if (!spotifyId) {
      return res.status(400).json({ error: "Spotify id is required" });
    }

    if (liked === null) {
      return res.status(400).json({ error: "liked must be true or false" });
    }

    if (liked) {
      await Like.updateOne(
        { userId: req.userId, targetType: "album", spotifyId },
        { $setOnInsert: { userId: req.userId, targetType: "album", spotifyId } },
        { upsert: true },
      );
    } else {
      await Like.deleteOne({ userId: req.userId, targetType: "album", spotifyId });
    }

    const likeCount = await Like.countDocuments({ targetType: "album", spotifyId });

    res.json({
      spotifyId,
      likeCount,
      likedByViewer: liked,
    });
  } catch (error) {
    console.log(error);
    res.status(500).json({ error: "Failed to update album like" });
  }
});

router.put("/review/:reviewId", ensureAuthenticated, likeMutationRateLimit, async(req, res) => {
  try {
    const reviewId = String(req.params.reviewId || "").trim();
    const liked = normalizeLiked(req.body.liked);

    if (!reviewId) {
      return res.status(400).json({ error: "Review id is required" });
    }

    if (liked === null) {
      return res.status(400).json({ error: "liked must be true or false" });
    }

    const review = await Review.findById(reviewId);

    if (!review) {
      return res.status(404).json({ error: "Review not found" });
    }

    if (liked) {
      await Like.updateOne(
        { userId: req.userId, targetType: "review", reviewId },
        {
          $setOnInsert: {
            userId: req.userId,
            targetType: "review",
            spotifyId: review.spotifyId,
            reviewId,
          },
        },
        { upsert: true },
      );
      await createReviewLikeNotification({
        actorUserId: req.userId,
        review,
        reviewId,
      });
    } else {
      await Like.deleteOne({ userId: req.userId, targetType: "review", reviewId });
    }

    const likeCount = await Like.countDocuments({ targetType: "review", reviewId });

    res.json({
      reviewId,
      spotifyId: review.spotifyId,
      likeCount,
      likedByViewer: liked,
    });
  } catch (error) {
    console.log(error);
    res.status(500).json({ error: "Failed to update review like" });
  }
});

module.exports = router;
