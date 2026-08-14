const express = require("express");
const { clerkClient, getAuth } = require("@clerk/express");
const Review = require("../models/Reviews");
const AlbumCatalog = require("../models/AlbumCatalog");
const Like = require("../models/Like");
const UserProfile = require("../models/UserProfile");
const { findAlbumByPublicId, normalizeCatalogAlbum } = require("./utils/albumCatalog");

const router = express.Router();
const DEFAULT_AUTHOR = "rescened user";
const PRIVATE_PROFILE_ERROR = { error: "Profile is private", isPrivate: true };

function plain(value) { return typeof value?.toObject === "function" ? value.toObject() : value; }
function viewer(req) { try { return getAuth(req).userId || ""; } catch { return ""; } }
function auth(req, res, next) { const userId = viewer(req); if (!userId) return res.status(401).json({ error: "Unauthorized" }); req.userId = userId; next(); }
async function authorMap(ids) {
  const map = new Map([...new Set(ids.filter(Boolean))].map((id) => [id, { userId: id, username: DEFAULT_AUTHOR, imageUrl: "" }]));
  try {
    const listed = await clerkClient.users.getUserList({ userId: [...map.keys()] });
    const users = Array.isArray(listed) ? listed : listed.data || [];
    users.forEach((user) => map.set(user.id, { userId: user.id, username: user.username || DEFAULT_AUTHOR, imageUrl: user.imageUrl || "" }));
  } catch { /* optional */ }
  return map;
}
async function likeStats(reviews, viewerId) {
  const ids = reviews.map((review) => String(review._id)).filter(Boolean);
  const rows = ids.length ? await Like.find({ targetType: "review", reviewId: { $in: ids } }) : [];
  const stats = new Map(ids.map((id) => [id, { likeCount: 0, likedByViewer: false }]));
  rows.forEach((row) => { const item = stats.get(String(row.reviewId)); if (item) { item.likeCount += 1; item.likedByViewer ||= Boolean(viewerId && row.userId === viewerId); } });
  return stats;
}
async function serializeReviews(reviews, viewerId) {
  const sources = reviews.map(plain);
  const albumIds = [...new Set(sources.map((review) => String(review.albumCatalogId?._id || review.albumCatalogId || "")).filter(Boolean))];
  const albums = albumIds.length ? await AlbumCatalog.find({ _id: { $in: albumIds } }) : [];
  const albumMap = new Map(albums.map((album) => [String(album._id), normalizeCatalogAlbum(album)]));
  const authors = await authorMap(sources.map((review) => review.userId));
  const stats = await likeStats(sources, viewerId);
  return sources.map((review) => ({
    _id: review._id,
    userId: review.userId,
    albumId: albumMap.get(String(review.albumCatalogId?._id || review.albumCatalogId))?.albumId || "",
    album: albumMap.get(String(review.albumCatalogId?._id || review.albumCatalogId)) || null,
    title: albumMap.get(String(review.albumCatalogId?._id || review.albumCatalogId))?.title || "",
    artistDisplayName: albumMap.get(String(review.albumCatalogId?._id || review.albumCatalogId))?.artistDisplayName || "",
    cover: albumMap.get(String(review.albumCatalogId?._id || review.albumCatalogId))?.cover || "",
    releaseYear: albumMap.get(String(review.albumCatalogId?._id || review.albumCatalogId))?.releaseYear || null,
    reviewText: review.reviewText,
    rating: review.rating,
    date: review.date,
    author: authors.get(review.userId) || { userId: review.userId, username: DEFAULT_AUTHOR, imageUrl: "" },
    ...(stats.get(String(review._id)) || { likeCount: 0, likedByViewer: false }),
  }));
}
function rating(body) {
  const value = Number(body?.rating);
  if (!Number.isFinite(value) || value < 1 || value > 5 || !Number.isInteger(value * 2)) return null;
  return value;
}
async function access(userId, viewerId) {
  const profile = await UserProfile.findOne({ userId });
  if (profile?.isPrivate && profile.userId !== viewerId) return false;
  return true;
}

router.post("/review", auth, async (req, res) => {
  try {
    const album = await findAlbumByPublicId(req.body.albumId);
    const parsedRating = rating(req.body);
    const reviewText = String(req.body.reviewText || "").trim();
    if (!parsedRating) return res.status(400).json({ error: "Rating must be a whole or half number between 1 and 5" });
    if (!reviewText) return res.status(400).json({ error: "Review text is required" });
    const review = await Review.create({ userId: req.userId, albumCatalogId: album._id, rating: parsedRating, reviewText });
    res.status(201).json((await serializeReviews([review], req.userId))[0]);
  } catch (error) { res.status(error.status || 500).json({ error: error.status ? error.message : "Failed to create review" }); }
});

router.get("/review/user/", auth, async (req, res) => {
  try { res.json(await serializeReviews(await Review.find({ userId: req.userId }).sort({ date: -1 }), req.userId)); }
  catch { res.status(500).json({ error: "Failed to fetch reviews" }); }
});

router.get("/review/user/:userId", async (req, res) => {
  try {
    const target = String(req.params.userId || "").trim();
    if (!(await access(target, viewer(req)))) return res.status(403).json(PRIVATE_PROFILE_ERROR);
    res.json(await serializeReviews(await Review.find({ userId: target }).sort({ date: -1 }), viewer(req)));
  } catch { res.status(500).json({ error: "Failed to fetch reviews" }); }
});

router.patch("/review/user/:id", auth, async (req, res) => {
  try {
    const parsedRating = rating(req.body);
    const reviewText = String(req.body.reviewText || "").trim();
    if (!parsedRating || !reviewText) return res.status(400).json({ error: "Valid rating and review text are required" });
    const review = await Review.findOneAndUpdate({ _id: req.params.id, userId: req.userId }, { $set: { rating: parsedRating, reviewText } }, { returnDocument: "after", runValidators: true });
    if (!review) return res.status(404).json({ error: "Review not found" });
    res.json((await serializeReviews([review], req.userId))[0]);
  } catch { res.status(500).json({ error: "Failed to update review" }); }
});

router.delete("/review/user/:id", auth, async (req, res) => {
  try { await Review.findOneAndDelete({ _id: req.params.id, userId: req.userId }); res.json({ message: "Review deleted" }); }
  catch { res.status(500).json({ error: "Failed to delete review" }); }
});

router.get("/review/album/:albumId", async (req, res) => {
  try {
    const album = await findAlbumByPublicId(req.params.albumId);
    res.json(await serializeReviews(await Review.find({ albumCatalogId: album._id }).sort({ date: -1 }), viewer(req)));
  } catch (error) { res.status(error.status || 500).json({ error: error.status ? error.message : "Failed to fetch reviews" }); }
});

async function albumReviewRows({ since } = {}) {
  const query = since ? { date: { $gte: since } } : {};
  const rows = await Review.find(query).sort({ date: -1 });
  const counts = new Map();
  rows.forEach((row) => { const key = String(row.albumCatalogId); const item = counts.get(key) || { albumCatalogId: row.albumCatalogId, reviewCount: 0, ratingTotal: 0, latestReviewDate: row.date }; item.reviewCount += 1; item.ratingTotal += row.rating; item.latestReviewDate = item.latestReviewDate > row.date ? item.latestReviewDate : row.date; counts.set(key, item); });
  return [...counts.values()].sort((a, b) => (b.reviewCount - a.reviewCount) || (b.ratingTotal / b.reviewCount - a.ratingTotal / a.reviewCount) || (new Date(b.latestReviewDate) - new Date(a.latestReviewDate)));
}
async function featured(limit = 5) {
  const rows = await albumReviewRows();
  const ids = rows.slice(0, limit).map((row) => row.albumCatalogId);
  return (ids.length ? await AlbumCatalog.find({ _id: { $in: ids } }) : []).map(normalizeCatalogAlbum);
}

router.get("/popular", async (req, res) => { try { res.json(await featured(Math.min(Number(req.query.limit) || 5, 10))); } catch { res.status(500).json({ error: "Failed to fetch reviews" }); } });
router.get("/recent-albums", async (req, res) => { try { const rows = await Review.find().sort({ date: -1 }); const ids = [...new Set(rows.map((row) => String(row.albumCatalogId)))].slice(0, 6); res.json((await AlbumCatalog.find({ _id: { $in: ids } })).map(normalizeCatalogAlbum)); } catch { res.status(500).json({ error: "Failed to fetch recent albums" }); } });
router.get("/popular-reviews", async (req, res) => { try { res.json(await serializeReviews(await Review.find().sort({ date: -1 }).limit(4), viewer(req))); } catch { res.status(500).json({ error: "Failed to fetch popular reviews" }); } });
router.get("/featured", async (req, res) => { try { res.json(await featured(Math.min(Number(req.query.limit) || 5, 10))); } catch { res.status(500).json({ error: "Failed to fetch featured albums" }); } });

module.exports = router;
