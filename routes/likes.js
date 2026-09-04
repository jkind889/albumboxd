const express = require("express");
const { getAuth } = require("@clerk/express");
const Like = require("../models/Like");
const { findAlbumByPublicId } = require("./utils/albumCatalog");
const { mutateReviewLike } = require("./utils/reviewInteractions");
const { likeMutationRateLimit } = require("./utils/rateLimit");

const router = express.Router();
function viewer(req) { try { return getAuth(req).userId || ""; } catch { return ""; } }
function auth(req, res, next) { const userId = viewer(req); if (!userId) return res.status(401).json({ error: "Unauthorized" }); req.userId = userId; next(); }
function likedValue(value) { return value === true || value === false ? value : null; }

router.get("/album/:albumId", async (req, res) => {
  try {
    const album = await findAlbumByPublicId(req.params.albumId);
    const userId = viewer(req);
    const [likeCount, liked] = await Promise.all([
      Like.countDocuments({ targetType: "album", albumCatalogId: album._id }),
      userId ? Like.exists({ targetType: "album", albumCatalogId: album._id, userId }) : null,
    ]);
    res.json({ albumId: album.albumId, likeCount, likedByViewer: Boolean(liked) });
  } catch (error) { res.status(error.status || 500).json({ error: error.status ? error.message : "Failed to fetch album likes" }); }
});

router.put("/album/:albumId", auth, likeMutationRateLimit, async (req, res) => {
  try {
    const liked = likedValue(req.body.liked);
    if (liked === null) return res.status(400).json({ error: "liked must be true or false" });
    const album = await findAlbumByPublicId(req.params.albumId);
    if (liked) {
      await Like.updateOne({ userId: req.userId, targetType: "album", albumCatalogId: album._id }, { $setOnInsert: { userId: req.userId, targetType: "album", albumCatalogId: album._id } }, { upsert: true });
    } else {
      await Like.deleteOne({ userId: req.userId, targetType: "album", albumCatalogId: album._id });
    }
    res.json({ albumId: album.albumId, likeCount: await Like.countDocuments({ targetType: "album", albumCatalogId: album._id }), likedByViewer: liked });
  } catch (error) { res.status(error.status || 500).json({ error: error.status ? error.message : "Failed to update album like" }); }
});

router.put("/review/:reviewId", auth, likeMutationRateLimit, async (req, res) => {
  try {
    const reviewId = String(req.params.reviewId || "").trim();
    const liked = likedValue(req.body.liked);
    if (!reviewId) return res.status(400).json({ error: "Review id is required", code: "INVALID_REVIEW_ID" });
    if (liked === null) return res.status(400).json({ error: "liked must be true or false" });
    res.json(await mutateReviewLike(reviewId, req.userId, liked));
  } catch (error) {
    res.status(error.status || 500).json({ error: error.status ? error.message : "Failed to update review like", ...(error.code ? { code: error.code } : {}) });
  }
});

module.exports = router;
