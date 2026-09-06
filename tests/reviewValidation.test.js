const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");

const Review = require("../models/Reviews");

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
});

test("reviews reject text longer than 300 characters", () => {
  const overLimit = reviewWithText("a".repeat(301));
  const validation = overLimit.validateSync();

  assert.ok(validation?.errors.reviewText);
  assert.equal(validation.errors.reviewText.kind, "maxlength");
  assert.equal(validation.errors.reviewText.properties.maxlength, 300);
});
