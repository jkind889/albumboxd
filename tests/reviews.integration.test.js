const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const AlbumCatalog = require("../models/AlbumCatalog");
const Review = require("../models/Reviews");
const Like = require("../models/Like");
const Notification = require("../models/Notification");
const UserProfile = require("../models/UserProfile");
const { createCatalogAlbum } = require("../routes/utils/albumCatalog");
const {
  rankedAlbums,
  recentlyReviewedAlbums,
  featuredAlbums,
  buildPopularReviewsPipeline,
} = require("../routes/utils/reviewFeeds");
const {
  deleteOwnedReview,
  mutateReviewLike,
  assertReviewId,
  runReviewTransaction,
  ReviewTransactionUnavailableError,
  assertPinnedReview,
} = require("../routes/utils/reviewInteractions");

const enabled = String(process.env.RUN_MONGO_INTEGRATION || "").toLowerCase() === "true";
let replSet;

async function createAlbum(title) {
  return createCatalogAlbum({
    albumId: crypto.randomUUID(),
    title,
    artistDisplayName: "Integration Artist",
    artistCredits: [{ name: "Integration Artist", role: "main" }],
    releaseDate: "2026",
    releaseDatePrecision: "year",
    releaseYear: 2026,
    tracks: [],
  });
}

async function createReview(album, userId, rating, date) {
  return Review.create({ userId, albumCatalogId: album._id, rating, reviewText: `${userId} review`, date });
}

test.before(async () => {
  if (!enabled) return;
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replSet.getUri(), { dbName: "rescened_reviews" });
  await Promise.all([
    AlbumCatalog.syncIndexes(),
    Review.syncIndexes(),
    Like.syncIndexes(),
    Notification.syncIndexes(),
    UserProfile.syncIndexes(),
  ]);
});
test.after(async () => {
  if (!enabled) return;
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  await replSet.stop();
});

test("review discovery aggregates use catalog order, windows, deduplication, and like ranking", { skip: !enabled }, async () => {
  const now = new Date("2026-09-03T12:00:00.000Z");
  const [first, second, third, fourth, fifth, missing] = await Promise.all([
    createAlbum("First"),
    createAlbum("Second"),
    createAlbum("Third"),
    createAlbum("Fourth"),
    createAlbum("Fifth"),
    createAlbum("Missing"),
  ]);
  await Promise.all([
    createReview(first, "u1", 5, new Date("2026-09-02T00:00:00Z")),
    createReview(first, "u2", 4, new Date("2026-08-01T00:00:00Z")),
    createReview(second, "u3", 5, new Date("2026-09-01T00:00:00Z")),
    createReview(third, "u5", 4, new Date("2026-08-31T00:00:00Z")),
    createReview(fourth, "u6", 4, new Date("2026-08-30T00:00:00Z")),
    createReview(fifth, "u7", 4, new Date("2026-08-29T00:00:00Z")),
    createReview(missing, "u4", 5, new Date("2026-09-03T00:00:00Z")),
  ]);
  await AlbumCatalog.deleteOne({ _id: missing._id });
  const recent = await recentlyReviewedAlbums(2);
  assert.deepEqual(recent.map((album) => album.title), ["First", "Second"]);
  assert.ok(recent[0].latestReviewDate);

  const popular = await rankedAlbums({ limit: 5, window: "7d", now });
  assert.equal(popular.length, 5);
  assert.equal(popular.some((album) => album.title === "Missing"), false);
  assert.equal(popular[0].reviewCount, 1);
  assert.equal(popular[0].averageRating, 5);
  assert.ok(popular[0].popularityScore > 0);

  const featured = await featuredAlbums(5);
  assert.equal(featured.length, 5);
  assert.equal(featured.some((album) => album.title === "Missing"), false);

  const firstReview = await Review.findOne({ albumCatalogId: first._id }).sort({ date: -1 });
  const secondReview = await Review.findOne({ albumCatalogId: second._id });
  await Like.create([
    { userId: "liker-1", targetType: "review", reviewId: firstReview._id },
    { userId: "liker-2", targetType: "review", reviewId: firstReview._id },
  ]);
  const popularReviews = await Review.aggregate(buildPopularReviewsPipeline(12));
  assert.equal(String(popularReviews[0]._id), String(firstReview._id));
  assert.equal(popularReviews.length, 6);
  assert.equal(popularReviews.some((row) => String(row.albumCatalogId) === String(missing._id)), false);
  assert.ok(popularReviews.some((row) => String(row._id) === String(secondReview._id)));
});

test("review deletion cascades likes, notifications, and every matching pin", { skip: !enabled }, async () => {
  const album = await createAlbum("Cascade");
  const unrelated = await createAlbum("Unrelated");
  const review = await createReview(album, "owner", 4.5, new Date());
  await Like.create([
    { userId: "actor", targetType: "review", reviewId: review._id },
    { userId: "actor", targetType: "album", albumCatalogId: unrelated._id },
  ]);
  await Notification.create({ recipientUserId: "owner", actorUserId: "actor", type: "review_like", reviewId: review._id });
  await UserProfile.create([{ userId: "owner", pinnedReviewId: review._id }, { userId: "other", pinnedReviewId: review._id }]);

  const result = await deleteOwnedReview(review._id, "owner");
  assert.equal(result.deleted, true);
  assert.equal(await Review.exists({ _id: review._id }), null);
  assert.equal(await Like.countDocuments({ targetType: "review", reviewId: review._id }), 0);
  assert.equal(await Notification.countDocuments({ type: "review_like", reviewId: review._id }), 0);
  assert.equal(await UserProfile.countDocuments({ pinnedReviewId: review._id }), 0);
  assert.equal(await Like.countDocuments({ targetType: "album", albumCatalogId: unrelated._id }), 1);
  assert.equal((await deleteOwnedReview(review._id, "owner")).deleted, false);
});

test("review likes and notifications commit together, while unlike preserves notification", { skip: !enabled }, async () => {
  const album = await createAlbum("Likes");
  const review = await createReview(album, "owner", 4, new Date());
  const liked = await mutateReviewLike(review._id, "actor", true);
  assert.equal(liked.likeCount, 1);
  assert.equal(await Notification.countDocuments({ type: "review_like", reviewId: review._id }), 1);
  const unliked = await mutateReviewLike(review._id, "actor", false);
  assert.equal(unliked.likeCount, 0);
  assert.equal(await Notification.countDocuments({ type: "review_like", reviewId: review._id }), 1);
});

test("review creation keys permit one durable review across concurrent retries", { skip: !enabled }, async () => {
  const album = await createAlbum("Idempotent");
  const creationKey = crypto.randomUUID();
  const create = () => Review.create({
    userId: "idempotent-owner",
    albumCatalogId: album._id,
    rating: 4,
    reviewText: "One review despite a retry",
    creationKey,
  });
  const attempts = await Promise.allSettled([create(), create()]);
  assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
  assert.equal(await Review.countDocuments({ userId: "idempotent-owner", creationKey }), 1);
  const stored = await Review.findOne({ userId: "idempotent-owner", creationKey }).select("+creationKey");
  assert.equal(stored.creationKey, creationKey);
});

test("review IDs are validated and unsupported transactions get action-specific errors", { skip: !enabled }, async () => {
  assert.throws(() => assertReviewId("not-an-object-id"), (error) => error.code === "INVALID_REVIEW_ID" && error.status === 400);
  const original = mongoose.startSession;
  mongoose.startSession = async () => ({
    async withTransaction() { const error = new Error("Transaction numbers are only allowed on a replica set member"); error.code = 20; throw error; },
    async endSession() {},
  });
  await assert.rejects(() => runReviewTransaction("deletion", async () => {}), (error) => error instanceof ReviewTransactionUnavailableError && error.code === "REVIEW_DELETION_UNAVAILABLE");
  mongoose.startSession = original;
});

test("concurrent delete and like/pin requests leave no dangling review relationships", { skip: !enabled }, async () => {
  const album = await createAlbum("Concurrent");
  const owner = `concurrent-owner-${Date.now()}`;
  const review = await createReview(album, owner, 4, new Date());
  await UserProfile.create({ userId: owner });
  const pinRequest = runReviewTransaction("pin", async (session) => {
    await assertPinnedReview(review._id, owner, session);
    await UserProfile.updateOne({ userId: owner }, { $set: { pinnedReviewId: review._id } }, { session });
  });
  const [pinResult, deleteResult, likeResult] = await Promise.allSettled([
    pinRequest,
    deleteOwnedReview(review._id, owner),
    mutateReviewLike(review._id, "actor", true),
  ]);
  assert.ok(["fulfilled", "rejected"].includes(pinResult.status));
  assert.equal(deleteResult.status, "fulfilled");
  assert.equal(deleteResult.value.deleted, true);
  assert.ok(likeResult.status === "fulfilled" || (likeResult.reason && likeResult.reason.status === 404));
  assert.equal(await Review.exists({ _id: review._id }), null);
  assert.equal(await Like.countDocuments({ targetType: "review", reviewId: review._id }), 0);
  assert.equal(await UserProfile.countDocuments({ pinnedReviewId: review._id }), 0);
});
