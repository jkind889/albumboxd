const crypto = require("crypto");
const mongoose = require("mongoose");
const Like = require("../../models/Like");

const DEFAULT_REVIEW_PAGE_SIZE = 20;
const MAX_REVIEW_PAGE_SIZE = 50;
const CURSOR_VERSION = 1;
const VALID_SORTS = new Set(["recent", "popular"]);

class ReviewFeedValidationError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "ReviewFeedValidationError";
    this.status = 400;
    this.code = code;
  }
}

function cursorKey() {
  // CLERK_SECRET_KEY is already required for the API. Deployments can set a
  // dedicated REVIEW_CURSOR_SECRET to rotate cursor tokens independently.
  const secret = process.env.REVIEW_CURSOR_SECRET || process.env.CLERK_SECRET_KEY || "rescened-review-cursor-development-secret";
  return crypto.createHash("sha256").update(secret).digest();
}

function encodeCursor(payload) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", cursorKey(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify({ v: CURSOR_VERSION, ...payload }), "utf8"), cipher.final()]);
  return [iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
}

function decodeCursor(cursor, expected) {
  const parts = String(cursor || "").split(".");
  if (parts.length !== 3 || parts.some((part) => !part)) {
    throw new ReviewFeedValidationError("Review cursor is invalid", "INVALID_REVIEW_CURSOR");
  }

  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", cursorKey(), Buffer.from(parts[0], "base64url"));
    decipher.setAuthTag(Buffer.from(parts[1], "base64url"));
    const payload = JSON.parse(Buffer.concat([decipher.update(Buffer.from(parts[2], "base64url")), decipher.final()]).toString("utf8"));
    if (
      payload?.v !== CURSOR_VERSION
      || payload.sort !== expected.sort
      || payload.scope !== expected.scope
      || !mongoose.isValidObjectId(payload.id)
      || !Number.isFinite(new Date(payload.date).getTime())
      || (payload.sort === "popular" && (!Number.isFinite(payload.likeCount) || !Number.isFinite(new Date(payload.asOf).getTime())))
    ) {
      throw new Error("cursor shape");
    }
    return { ...payload, id: new mongoose.Types.ObjectId(payload.id), date: new Date(payload.date), asOf: payload.asOf ? new Date(payload.asOf) : null };
  } catch (error) {
    if (error instanceof ReviewFeedValidationError) throw error;
    throw new ReviewFeedValidationError("Review cursor is invalid", "INVALID_REVIEW_CURSOR");
  }
}

function parseLimit(value) {
  if (value === undefined || value === "") return DEFAULT_REVIEW_PAGE_SIZE;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_REVIEW_PAGE_SIZE;
  return Math.min(MAX_REVIEW_PAGE_SIZE, parsed);
}

function parseReviewFeedQuery(query, scope) {
  const sort = String(query?.sort || "recent").trim().toLowerCase();
  if (!VALID_SORTS.has(sort)) {
    throw new ReviewFeedValidationError("Review sort must be recent or popular", "INVALID_REVIEW_SORT");
  }
  const limit = parseLimit(query?.limit);
  const cursor = query?.cursor ? decodeCursor(query.cursor, { sort, scope }) : null;
  return { sort, limit, cursor, scope, asOf: cursor?.asOf || new Date() };
}

function recentCursorFilter(cursor) {
  if (!cursor) return {};
  return {
    $or: [
      { date: { $lt: cursor.date } },
      { date: cursor.date, _id: { $lt: cursor.id } },
    ],
  };
}

function popularCursorFilter(cursor) {
  if (!cursor) return null;
  return {
    $or: [
      { likeCount: { $lt: cursor.likeCount } },
      { likeCount: cursor.likeCount, date: { $lt: cursor.date } },
      { likeCount: cursor.likeCount, date: cursor.date, _id: { $lt: cursor.id } },
    ],
  };
}

function buildPopularReviewPagePipeline(match, { cursor, limit, asOf }) {
  const pipeline = [
    { $match: match },
    {
      $lookup: {
        from: Like.collection.name,
        let: { currentReviewId: "$_id" },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ["$targetType", "review"] },
                  { $eq: ["$reviewId", "$$currentReviewId"] },
                  { $lte: ["$createdAt", asOf] },
                ],
              },
            },
          },
          { $count: "count" },
        ],
        as: "reviewLikeStats",
      },
    },
    { $set: { likeCount: { $ifNull: [{ $arrayElemAt: ["$reviewLikeStats.count", 0] }, 0] } } },
  ];
  const after = popularCursorFilter(cursor);
  if (after) pipeline.push({ $match: after });
  pipeline.push(
    { $sort: { likeCount: -1, date: -1, _id: -1 } },
    { $limit: limit + 1 },
    { $project: { reviewLikeStats: 0 } },
  );
  return pipeline;
}

function nextCursorFor(review, { sort, scope, asOf }) {
  if (!review) return null;
  return encodeCursor({
    sort,
    scope,
    asOf: sort === "popular" ? new Date(asOf).toISOString() : undefined,
    likeCount: sort === "popular" ? Number(review.likeCount) || 0 : undefined,
    date: new Date(review.date).toISOString(),
    id: String(review._id),
  });
}

module.exports = {
  DEFAULT_REVIEW_PAGE_SIZE,
  MAX_REVIEW_PAGE_SIZE,
  ReviewFeedValidationError,
  buildPopularReviewPagePipeline,
  decodeCursor,
  encodeCursor,
  nextCursorFor,
  parseReviewFeedQuery,
  recentCursorFilter,
};

