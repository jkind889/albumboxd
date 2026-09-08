const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");

const Review = require("../models/Reviews");

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function reviewWithText(reviewText) {
  return new Review({
    userId: "reviewer",
    albumCatalogId: new mongoose.Types.ObjectId(),
    rating: 4.5,
    reviewText,
  });
}

test("reviews accept ordinary text and text at the 300-character limit", () => {
  const ordinary = reviewWithText("A thoughtful, concise review.");
  const atLimit = reviewWithText("a".repeat(300));

  assert.equal(ordinary.validateSync(), undefined);
  assert.equal(atLimit.validateSync(), undefined);
  assert.equal(atLimit.reviewText.length, 300);
  assert.equal(atLimit.rating, 4.5);
  assert.match(ordinary.reviewId, UUID_V4);
  assert.match(atLimit.reviewId, UUID_V4);
});

test("reviews reject text longer than 300 characters", () => {
  const overLimit = reviewWithText("a".repeat(301));
  const validation = overLimit.validateSync();

  assert.ok(validation?.errors.reviewText);
  assert.equal(validation.errors.reviewText.kind, "maxlength");
  assert.equal(validation.errors.reviewText.properties.maxlength, 300);
});

test("reviews persist an immutable UUID v4 without manufacturing one while hydrating legacy data", () => {
  const review = reviewWithText("An immutable public identifier.");
  const reviewId = review.reviewId;
  assert.match(reviewId, UUID_V4);
  review.$isNew = false;
  review.reviewId = "00000000-0000-4000-8000-000000000001";
  assert.equal(review.reviewId, reviewId);

  const legacy = Review.hydrate({
    _id: new mongoose.Types.ObjectId(),
    userId: "legacy-reviewer",
    albumCatalogId: new mongoose.Types.ObjectId(),
    rating: 4,
    reviewText: "This record needs the review-ID backfill.",
  });
  assert.equal(legacy.reviewId, undefined);
  assert.equal(Object.hasOwn(legacy.toObject(), "reviewId"), false);
});
