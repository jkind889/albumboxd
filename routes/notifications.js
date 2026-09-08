const express = require("express");
const { clerkClient, getAuth } = require("@clerk/express");
const Notification = require("../models/Notification");
const Review = require("../models/Reviews");
const AlbumCatalog = require("../models/AlbumCatalog");
const { normalizeCatalogAlbum } = require("./utils/albumCatalog");
const { persistedReviewId } = require("./utils/reviewInteractions");

const router = express.Router();
const NOTIFICATION_ID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function auth(req, res, next) { const { userId } = getAuth(req); if (!userId) return res.status(401).json({ error: "Unauthorized" }); req.userId = userId; next(); }
function plain(value) { return typeof value?.toObject === "function" ? value.toObject() : value; }
function persistedNotificationId(notification) {
  const value = String(notification?.notificationId || "").trim().toLowerCase();
  if (NOTIFICATION_ID_V4.test(value)) return value;
  const error = new Error("Notification is missing a valid public identifier");
  error.status = 500;
  error.code = "NOTIFICATION_ID_INTEGRITY_ERROR";
  throw error;
}
async function authors(ids) {
  const map = new Map([...new Set(ids.filter(Boolean))].map((id) => [id, { userId: id, username: "rescened user", imageUrl: "" }]));
  try { const listed = await clerkClient.users.getUserList({ userId: [...map.keys()] }); const users = Array.isArray(listed) ? listed : listed.data || []; users.forEach((user) => map.set(user.id, { userId: user.id, username: user.username || "rescened user", imageUrl: user.imageUrl || "" })); } catch { /* optional */ }
  return map;
}
router.get("/unread-count", auth, async (req, res) => { try { res.json({ unreadCount: await Notification.countDocuments({ recipientUserId: req.userId, readAt: null }) }); } catch { res.status(500).json({ error: "Failed to fetch notification count" }); } });
router.get("/", auth, async (req, res) => {
  try {
    const rows = await Notification.find({ recipientUserId: req.userId }).sort({ createdAt: -1 }).limit(30);
    const reviews = await Review.find({ _id: { $in: rows.map((row) => row.reviewId).filter(Boolean) } }).populate("albumCatalogId");
    const reviewMap = new Map(reviews.map((review) => [String(review._id), plain(review)]));
    const albumIds = [...new Set(reviews.map((review) => String(plain(review).albumCatalogId?._id || "")).filter(Boolean))];
    const albums = await AlbumCatalog.find({ _id: { $in: albumIds } });
    const albumMap = new Map(albums.map((album) => [String(album._id), normalizeCatalogAlbum(album)]));
    const actorMap = await authors(rows.map((row) => plain(row).actorUserId));
    const unread = rows.filter((row) => !row.readAt).map((row) => row._id);
    if (unread.length) await Notification.updateMany({ _id: { $in: unread }, recipientUserId: req.userId }, { $set: { readAt: new Date() } });
    res.json({ notifications: rows.map((row) => { const source = plain(row); const review = reviewMap.get(String(source.reviewId || "")); const reviewId = review ? persistedReviewId(review) : ""; const album = review ? albumMap.get(String(review.albumCatalogId?._id || review.albumCatalogId || "")) : null; return { notificationId: persistedNotificationId(source), type: source.type, recipientUserId: source.recipientUserId, actorUserId: source.actorUserId, actor: actorMap.get(source.actorUserId), reviewId, albumId: album?.albumId || "", readAt: source.readAt || null, createdAt: source.createdAt, updatedAt: source.updatedAt, review: review ? { reviewId, albumId: album?.albumId || "", album, rating: review.rating } : null }; }) });
  } catch { res.status(500).json({ error: "Failed to fetch notifications" }); }
});
module.exports = router;
