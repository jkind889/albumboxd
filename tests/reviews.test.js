const assert = require("node:assert/strict");
const test = require("node:test");

const reviewModelPath = require.resolve("../models/Reviews");
const clerkPath = require.resolve("@clerk/express");
const reviewRoutePath = require.resolve("../routes/reviews");

const findCalls = [];
const sortCalls = [];
const aggregateCalls = [];
let foundReviews = [];
let reviewDocuments = [];

function roundTo(value, decimals) {
  const multiplier = 10 ** decimals;
  return Math.round(value * multiplier) / multiplier;
}

async function aggregatePopularReviews(pipeline) {
  aggregateCalls.push(pipeline);

  const matchStage = pipeline.find((stage) => stage.$match);
  const limitStage = pipeline.find((stage) => stage.$limit);
  const startDate = matchStage?.$match?.date?.$gte;
  const filteredReviews = startDate
    ? reviewDocuments.filter((review) => review.date >= startDate)
    : reviewDocuments;
  const groupedReviews = new Map();

  for (const review of filteredReviews) {
    if (!groupedReviews.has(review.spotifyId)) {
      groupedReviews.set(review.spotifyId, {
        spotifyId: review.spotifyId,
        title: review.title,
        artist: review.artist,
        cover: review.cover,
        reviewCount: 0,
        ratingTotal: 0,
        latestReviewDate: review.date,
      });
    }

    const album = groupedReviews.get(review.spotifyId);
    album.reviewCount += 1;
    album.ratingTotal += review.rating;

    if (review.date > album.latestReviewDate) {
      album.latestReviewDate = review.date;
    }
  }

  return [...groupedReviews.values()]
    .map((album) => {
      const averageRating = album.ratingTotal / album.reviewCount;
      const popularityScore = ((averageRating * album.reviewCount) + (3.5 * 3)) / (album.reviewCount + 3);

      return {
        spotifyId: album.spotifyId,
        title: album.title,
        artist: album.artist,
        cover: album.cover,
        reviewCount: album.reviewCount,
        averageRating: roundTo(averageRating, 2),
        popularityScore: roundTo(popularityScore, 4),
        latestReviewDate: album.latestReviewDate,
      };
    })
    .sort((a, b) => (
      b.popularityScore - a.popularityScore
      || b.reviewCount - a.reviewCount
      || b.averageRating - a.averageRating
      || b.latestReviewDate - a.latestReviewDate
    ))
    .slice(0, limitStage.$limit);
}

function loadReviewRouter() {
  delete require.cache[reviewRoutePath];

  require.cache[reviewModelPath] = {
    id: reviewModelPath,
    filename: reviewModelPath,
    loaded: true,
    exports: {
      find: (query) => {
        findCalls.push(query);
        return {
          sort: async (sortOrder) => {
            sortCalls.push(sortOrder);
            return foundReviews;
          },
        };
      },
      aggregate: aggregatePopularReviews,
    },
  };

  require.cache[clerkPath] = {
    id: clerkPath,
    filename: clerkPath,
    loaded: true,
    exports: {
      getAuth: () => ({ userId: "user_clerk_123" }),
    },
  };

  return require("../routes/reviews");
}

async function getAlbumReviews(albumId) {
  const router = loadReviewRouter();
  const route = router.stack.find(
    (layer) => layer.route?.path === "/review/album/:albumId" && layer.route.methods.get,
  );

  const req = { params: { albumId } };
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this.body = data;
      return this;
    },
  };

  const handler = route.route.stack[0].handle;
  await handler(req, res);

  return {
    status: res.statusCode,
    body: res.body,
  };
}

async function getPopularAlbums(query = {}) {
  const router = loadReviewRouter();
  const route = router.stack.find(
    (layer) => layer.route?.path === "/popular" && layer.route.methods.get,
  );

  assert.ok(route, "GET /popular should be registered");

  const req = { query };
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this.body = data;
      return this;
    },
  };

  const handler = route.route.stack[0].handle;
  await handler(req, res);

  return {
    status: res.statusCode,
    body: res.body,
  };
}

test.beforeEach(() => {
  findCalls.length = 0;
  sortCalls.length = 0;
  aggregateCalls.length = 0;
  foundReviews = [];
  reviewDocuments = [];
});

test("GET /reviews/review/album/:albumId fetches reviews by Spotify album id", async () => {
  foundReviews = [
    {
      _id: "review_123",
      spotifyId: "spotify_album_123",
      title: "Kind of Blue",
      rating: 5,
      reviewText: "Still blue, still perfect.",
    },
  ];

  const response = await getAlbumReviews("spotify_album_123");

  assert.equal(response.status, 200);
  assert.deepEqual(findCalls, [{ spotifyId: "spotify_album_123" }]);
  assert.deepEqual(sortCalls, [{ date: -1 }]);
  assert.equal(findCalls[0].spotifyId, "spotify_album_123");
  assert.notEqual(findCalls[0].spotifyId, undefined);
  assert.deepEqual(response.body, foundReviews);
});

test("GET /reviews/review/album/:albumId returns an empty array when no reviews exist", async () => {
  const response = await getAlbumReviews("spotify_album_without_reviews");

  assert.equal(response.status, 200);
  assert.deepEqual(findCalls, [{ spotifyId: "spotify_album_without_reviews" }]);
  assert.deepEqual(sortCalls, [{ date: -1 }]);
  assert.deepEqual(response.body, []);
});

test("GET /reviews/popular groups album reviews and ranks by balanced score", async () => {
  const now = new Date();
  reviewDocuments = [
    {
      spotifyId: "steady_album",
      title: "Steady Heat",
      artist: "The Regulars",
      cover: "https://example.com/steady.jpg",
      rating: 5,
      date: now,
    },
    {
      spotifyId: "steady_album",
      title: "Steady Heat",
      artist: "The Regulars",
      cover: "https://example.com/steady.jpg",
      rating: 5,
      date: now,
    },
    {
      spotifyId: "single_album",
      title: "One Perfect Take",
      artist: "Solo Act",
      cover: "https://example.com/single.jpg",
      rating: 5,
      date: now,
    },
    {
      spotifyId: "older_album",
      title: "Old News",
      artist: "Yesterday",
      cover: "https://example.com/old.jpg",
      rating: 5,
      date: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000),
    },
  ];

  const response = await getPopularAlbums();

  assert.equal(response.status, 200);
  assert.equal(response.body.length, 2);
  assert.equal(response.body[0].spotifyId, "steady_album");
  assert.equal(response.body[0].reviewCount, 2);
  assert.equal(response.body[0].averageRating, 5);
  assert.equal(response.body[0].popularityScore, 4.1);
  assert.equal(response.body[1].spotifyId, "single_album");
  assert.equal(response.body[1].popularityScore, 3.875);
});

test("GET /reviews/popular applies the default 30 day window", async () => {
  reviewDocuments = [
    {
      spotifyId: "current_album",
      title: "Current",
      artist: "Now",
      rating: 4,
      date: new Date(),
    },
    {
      spotifyId: "stale_album",
      title: "Stale",
      artist: "Then",
      rating: 5,
      date: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000),
    },
  ];

  const response = await getPopularAlbums();
  const matchStage = aggregateCalls[0][0];

  assert.equal(response.status, 200);
  assert.equal(response.body.length, 1);
  assert.equal(response.body[0].spotifyId, "current_album");
  assert.ok(matchStage.$match.date.$gte instanceof Date);
});

test("GET /reviews/popular supports the all time window", async () => {
  reviewDocuments = [
    {
      spotifyId: "older_album",
      title: "Still Here",
      artist: "Archive",
      rating: 5,
      date: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
    },
  ];

  const response = await getPopularAlbums({ window: "all" });

  assert.equal(response.status, 200);
  assert.equal(response.body.length, 1);
  assert.equal(response.body[0].spotifyId, "older_album");
  assert.equal(aggregateCalls[0][0].$group._id, "$spotifyId");
});

test("GET /reviews/popular clamps the limit between five and ten", async () => {
  reviewDocuments = Array.from({ length: 12 }, (_, index) => ({
    spotifyId: `album_${index}`,
    title: `Album ${index}`,
    artist: "Limit Band",
    rating: 4,
    date: new Date(),
  }));

  const lowLimitResponse = await getPopularAlbums({ limit: "2" });
  const lowLimitStage = aggregateCalls.at(-1).find((stage) => stage.$limit);
  const highLimitResponse = await getPopularAlbums({ limit: "20" });
  const highLimitStage = aggregateCalls.at(-1).find((stage) => stage.$limit);

  assert.equal(lowLimitStage.$limit, 5);
  assert.equal(lowLimitResponse.body.length, 5);
  assert.equal(highLimitStage.$limit, 10);
  assert.equal(highLimitResponse.body.length, 10);
});

test("GET /reviews/popular returns an empty array when no reviews are eligible", async () => {
  reviewDocuments = [
    {
      spotifyId: "old_album",
      title: "Out of Window",
      artist: "Archive",
      rating: 5,
      date: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000),
    },
  ];

  const response = await getPopularAlbums({ window: "7d" });

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, []);
});
