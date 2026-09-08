const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");
const {
  DEFAULT_REVIEW_PAGE_SIZE,
  MAX_REVIEW_PAGE_SIZE,
  ReviewFeedValidationError,
  buildPopularReviewPagePipeline,
  decodeCursor,
  nextCursorFor,
  parseReviewFeedQuery,
  recentCursorFilter,
} = require("../routes/utils/reviewPagination");

test("review feeds validate sorts, clamp page size, and keep cursor data opaque", () => {
  const id = new mongoose.Types.ObjectId();
  const scope = "album:4b2a1e56-24d1-49df-9550-c17054ca9e91";
  const cursor = nextCursorFor({ _id: id, date: new Date("2026-09-03T00:00:00Z"), likeCount: 7 }, {
    sort: "popular",
    scope,
    asOf: new Date("2026-09-04T00:00:00Z"),
  });
  assert.equal(cursor.includes(String(id)), false);
  const parsed = parseReviewFeedQuery({ sort: "popular", limit: "999", cursor }, scope);
  assert.equal(parsed.limit, MAX_REVIEW_PAGE_SIZE);
  assert.equal(String(parsed.cursor.id), String(id));
  assert.equal(parsed.cursor.likeCount, 7);
  assert.equal(parseReviewFeedQuery({}, scope).limit, DEFAULT_REVIEW_PAGE_SIZE);
  assert.throws(() => parseReviewFeedQuery({ sort: "rating" }, scope), (error) => error instanceof ReviewFeedValidationError && error.code === "INVALID_REVIEW_SORT");
  assert.throws(() => decodeCursor("not-a-cursor", { sort: "popular", scope }), (error) => error.code === "INVALID_REVIEW_CURSOR");
  assert.throws(() => parseReviewFeedQuery({ sort: "popular", cursor }, "album:other"), (error) => error.code === "INVALID_REVIEW_CURSOR");
});

test("recent and popular pages use deterministic, bounded continuation filters", () => {
  const id = new mongoose.Types.ObjectId();
  const date = new Date("2026-09-03T00:00:00Z");
  assert.deepEqual(recentCursorFilter({ id, date }), {
    $or: [{ date: { $lt: date } }, { date, _id: { $lt: id } }],
  });

  const pipeline = buildPopularReviewPagePipeline({ userId: "user" }, {
    cursor: { id, date, likeCount: 4 },
    limit: 20,
    asOf: new Date("2026-09-04T00:00:00Z"),
  });
  assert.deepEqual(pipeline.find((stage) => stage.$sort), { $sort: { likeCount: -1, date: -1, _id: -1 } });
  assert.deepEqual(pipeline.find((stage) => stage.$limit), { $limit: 21 });
  assert.deepEqual(pipeline.find((stage) => stage.$match?.$or)?.$match, {
    $or: [
      { likeCount: { $lt: 4 } },
      { likeCount: 4, date: { $lt: date } },
      { likeCount: 4, date, _id: { $lt: id } },
    ],
  });
});

