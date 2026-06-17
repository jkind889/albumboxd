const assert = require("node:assert/strict");
const test = require("node:test");

const reviewModelPath = require.resolve("../models/Reviews");
const likeModelPath = require.resolve("../models/Like");
const albumCatalogModelPath = require.resolve("../models/AlbumCatalog");
const profileModelPath = require.resolve("../models/UserProfile");
const albumCatalogHelperPath = require.resolve("../routes/utils/albumCatalog");
const clerkPath = require.resolve("@clerk/express");
const reviewRoutePath = require.resolve("../routes/reviews");

const findCalls = [];
const sortCalls = [];
const createCalls = [];
const findOneAndUpdateCalls = [];
const aggregateCalls = [];
const catalogFindCalls = [];
const catalogSortCalls = [];
const catalogLimitCalls = [];
const getUserListCalls = [];
const likeFindCalls = [];
const profileFindOneCalls = [];
let foundReviews = [];
let createdReview = null;
let updatedReview = null;
let reviewDocuments = [];
let likeDocuments = [];
let catalogDocuments = [];
let profileDocuments = [];
let clerkUsers = [];
let shouldRejectClerkLookup = false;
let authUserId = "user_clerk_123";

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
  delete require.cache[albumCatalogHelperPath];
  delete require.cache[likeModelPath];
  delete require.cache[profileModelPath];

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
      create: async (review) => {
        createCalls.push(review);
        return createdReview || { _id: "created_review", ...review };
      },
      findOneAndUpdate: async (query, update, options) => {
        findOneAndUpdateCalls.push({ query, update, options });
        return updatedReview;
      },
      aggregate: aggregatePopularReviews,
    },
  };

  require.cache[albumCatalogModelPath] = {
    id: albumCatalogModelPath,
    filename: albumCatalogModelPath,
    loaded: true,
    exports: {
      find: (query) => {
        catalogFindCalls.push(query);
        return {
          sort: (sortOrder) => {
            catalogSortCalls.push(sortOrder);
            return {
              limit: async (limit) => {
                catalogLimitCalls.push(limit);
                return catalogDocuments.slice(0, limit);
              },
            };
          },
        };
      },
    },
  };

  require.cache[likeModelPath] = {
    id: likeModelPath,
    filename: likeModelPath,
    loaded: true,
    exports: {
      find: async (query) => {
        likeFindCalls.push(query);
        const reviewIds = query.reviewId?.$in?.map(String) || [];

        return likeDocuments.filter((like) => (
          like.targetType === query.targetType
          && reviewIds.includes(String(like.reviewId))
        ));
      },
    },
  };

  require.cache[profileModelPath] = {
    id: profileModelPath,
    filename: profileModelPath,
    loaded: true,
    exports: {
      findOne: async (query) => {
        profileFindOneCalls.push(query);
        return profileDocuments.find((profile) => profile.userId === query.userId) || null;
      },
    },
  };

  require.cache[albumCatalogHelperPath] = {
    id: albumCatalogHelperPath,
    filename: albumCatalogHelperPath,
    loaded: true,
    exports: {
      normalizeCatalogAlbum: (album) => ({
        spotifyId: album.spotifyId,
        title: album.title,
        artist: album.artist,
        year: album.year || "unknown",
        cover: album.cover || album.imgs?.[0]?.url || null,
      }),
    },
  };

  require.cache[clerkPath] = {
    id: clerkPath,
    filename: clerkPath,
    loaded: true,
    exports: {
      getAuth: () => ({ userId: authUserId }),
      clerkClient: {
        users: {
          getUserList: async (query) => {
            getUserListCalls.push(query);

            if (shouldRejectClerkLookup) {
              throw new Error("Clerk lookup failed");
            }

            return { data: clerkUsers };
          },
        },
      },
    },
  };

  return require("../routes/reviews");
}

async function runRouteHandlers(route, req, res) {
  const handlers = route.route.stack.map((layer) => layer.handle);

  for (const handler of handlers) {
    let nextCalled = false;
    await handler(req, res, () => {
      nextCalled = true;
    });

    if (!nextCalled) {
      break;
    }
  }
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

  await runRouteHandlers(route, req, res);

  return {
    status: res.statusCode,
    body: res.body,
  };
}

async function getUserReviews(userId) {
  const router = loadReviewRouter();
  const route = router.stack.find(
    (layer) => layer.route?.path === "/review/user/:userId" && layer.route.methods.get,
  );

  assert.ok(route, "GET /review/user/:userId should be registered");

  const req = { params: { userId } };
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

  await runRouteHandlers(route, req, res);

  return {
    status: res.statusCode,
    body: res.body,
  };
}

async function postReview(body = {}) {
  const router = loadReviewRouter();
  const route = router.stack.find(
    (layer) => layer.route?.path === "/review" && layer.route.methods.post,
  );

  assert.ok(route, "POST /review should be registered");

  const req = { body };
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

  await runRouteHandlers(route, req, res);

  return {
    status: res.statusCode,
    body: res.body,
  };
}

async function patchReview(reviewId, body = {}) {
  const router = loadReviewRouter();
  const route = router.stack.find(
    (layer) => layer.route?.path === "/review/user/:id" && layer.route.methods.patch,
  );

  assert.ok(route, "PATCH /review/user/:id should be registered");

  const req = { params: { id: reviewId }, body };
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

  await runRouteHandlers(route, req, res);

  return {
    status: res.statusCode,
    body: res.body,
  };
}

async function getReviewRoute(path, query = {}) {
  const router = loadReviewRouter();
  const route = router.stack.find(
    (layer) => layer.route?.path === path && layer.route.methods.get,
  );

  assert.ok(route, `GET ${path} should be registered`);

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

async function getPopularAlbums(query = {}) {
  return getReviewRoute("/popular", query);
}

async function getRecentlyReviewedAlbums(query = {}) {
  return getReviewRoute("/recent-albums", query);
}

async function getPopularReviews(query = {}) {
  return getReviewRoute("/popular-reviews", query);
}

async function getFeaturedAlbums(query = {}) {
  return getReviewRoute("/featured", query);
}

test.beforeEach(() => {
  findCalls.length = 0;
  sortCalls.length = 0;
  createCalls.length = 0;
  findOneAndUpdateCalls.length = 0;
  aggregateCalls.length = 0;
  catalogFindCalls.length = 0;
  catalogSortCalls.length = 0;
  catalogLimitCalls.length = 0;
  getUserListCalls.length = 0;
  likeFindCalls.length = 0;
  profileFindOneCalls.length = 0;
  foundReviews = [];
  createdReview = null;
  updatedReview = null;
  reviewDocuments = [];
  likeDocuments = [];
  catalogDocuments = [];
  profileDocuments = [];
  clerkUsers = [];
  shouldRejectClerkLookup = false;
  authUserId = "user_clerk_123";
});

test("GET /reviews/review/album/:albumId fetches reviews by Spotify album id and adds Clerk authors", async () => {
  foundReviews = [
    {
      _id: "review_123",
      userId: "user_one",
      spotifyId: "spotify_album_123",
      title: "Kind of Blue",
      rating: 5,
      reviewText: "Still blue, still perfect.",
    },
  ];
  clerkUsers = [
    {
      id: "user_one",
      username: "kindofkaren",
      imageUrl: "https://example.com/avatar.jpg",
    },
  ];

  const response = await getAlbumReviews("spotify_album_123");

  assert.equal(response.status, 200);
  assert.deepEqual(findCalls, [{ spotifyId: "spotify_album_123" }]);
  assert.deepEqual(sortCalls, [{ date: -1 }]);
  assert.deepEqual(getUserListCalls, [{ userId: ["user_one"] }]);
  assert.equal(findCalls[0].spotifyId, "spotify_album_123");
  assert.notEqual(findCalls[0].spotifyId, undefined);
  assert.deepEqual(response.body, [
    {
      ...foundReviews[0],
      likeCount: 0,
      likedByViewer: false,
      author: {
        userId: "user_one",
        username: "kindofkaren",
        imageUrl: "https://example.com/avatar.jpg",
      },
    },
  ]);
});

test("GET /reviews/review/album/:albumId includes review like counts and viewer state", async () => {
  foundReviews = [
    {
      _id: "review_liked",
      userId: "user_one",
      spotifyId: "spotify_album_123",
      title: "Kind of Blue",
      rating: 5,
      reviewText: "Still blue.",
    },
  ];
  likeDocuments = [
    {
      userId: "other_user",
      targetType: "review",
      reviewId: "review_liked",
    },
    {
      userId: "user_clerk_123",
      targetType: "review",
      reviewId: "review_liked",
    },
  ];

  const response = await getAlbumReviews("spotify_album_123");

  assert.equal(response.status, 200);
  assert.equal(response.body[0].likeCount, 2);
  assert.equal(response.body[0].likedByViewer, true);
});

test("GET /reviews/review/album/:albumId defaults viewer like state to false without auth", async () => {
  authUserId = "";
  foundReviews = [
    {
      _id: "review_public",
      userId: "user_one",
      spotifyId: "spotify_album_123",
      title: "Kind of Blue",
      rating: 5,
      reviewText: "Still blue.",
    },
  ];
  likeDocuments = [
    {
      userId: "other_user",
      targetType: "review",
      reviewId: "review_public",
    },
  ];

  const response = await getAlbumReviews("spotify_album_123");

  assert.equal(response.status, 200);
  assert.equal(response.body[0].likeCount, 1);
  assert.equal(response.body[0].likedByViewer, false);
});

test("GET /reviews/review/album/:albumId returns an empty array when no reviews exist", async () => {
  const response = await getAlbumReviews("spotify_album_without_reviews");

  assert.equal(response.status, 200);
  assert.deepEqual(findCalls, [{ spotifyId: "spotify_album_without_reviews" }]);
  assert.deepEqual(sortCalls, [{ date: -1 }]);
  assert.deepEqual(getUserListCalls, []);
  assert.deepEqual(response.body, []);
});

test("GET /reviews/review/album/:albumId falls back to albumboxd user without email or full name", async () => {
  foundReviews = [
    {
      _id: "review_without_username",
      userId: "user_without_username",
      spotifyId: "spotify_album_123",
      title: "Kind of Blue",
      rating: 4,
      reviewText: "Good, but not email good.",
    },
  ];
  clerkUsers = [
    {
      id: "user_without_username",
      username: null,
      firstName: "Not",
      lastName: "Used",
      emailAddresses: [{ emailAddress: "never@example.com" }],
      imageUrl: "",
    },
  ];

  const response = await getAlbumReviews("spotify_album_123");

  assert.equal(response.status, 200);
  assert.equal(response.body[0].author.username, "albumboxd user");
  assert.equal(response.body[0].author.imageUrl, "");
});

test("GET /reviews/review/album/:albumId falls back when Clerk lookup fails", async () => {
  foundReviews = [
    {
      _id: "review_lookup_failure",
      userId: "user_lookup_failure",
      spotifyId: "spotify_album_123",
      title: "Kind of Blue",
      rating: 4,
      reviewText: "Still renders.",
    },
  ];
  shouldRejectClerkLookup = true;

  const response = await getAlbumReviews("spotify_album_123");

  assert.equal(response.status, 200);
  assert.deepEqual(response.body[0].author, {
    userId: "user_lookup_failure",
    username: "albumboxd user",
    imageUrl: "",
  });
});

test("GET /reviews/review/user/:userId fetches public profile reviews", async () => {
  foundReviews = [
    {
      _id: "review_public_profile",
      userId: "profile_user_123",
      spotifyId: "spotify_album_123",
      title: "Kind of Blue",
      rating: 5,
      reviewText: "Public profile review.",
    },
  ];
  clerkUsers = [
    {
      id: "profile_user_123",
      username: "publiclistener",
      imageUrl: "https://example.com/public-listener.jpg",
    },
  ];

  const response = await getUserReviews("profile_user_123");

  assert.equal(response.status, 200);
  assert.deepEqual(findCalls, [{ userId: "profile_user_123" }]);
  assert.deepEqual(sortCalls, [{ date: -1 }]);
  assert.deepEqual(getUserListCalls, [{ userId: ["profile_user_123"] }]);
  assert.deepEqual(response.body, [
    {
      ...foundReviews[0],
      likeCount: 0,
      likedByViewer: false,
      author: {
        userId: "profile_user_123",
        username: "publiclistener",
        imageUrl: "https://example.com/public-listener.jpg",
      },
    },
  ]);
});

test("GET /reviews/review/user/:userId returns 403 for a private profile viewed by another user", async () => {
  profileDocuments = [
    {
      userId: "profile_user_123",
      isPrivate: true,
    },
  ];
  foundReviews = [
    {
      _id: "review_private_profile",
      userId: "profile_user_123",
      spotifyId: "spotify_album_123",
      title: "Kind of Blue",
      rating: 5,
      reviewText: "Hidden profile review.",
    },
  ];

  const response = await getUserReviews("profile_user_123");

  assert.equal(response.status, 403);
  assert.deepEqual(response.body, {
    error: "Profile is private",
    isPrivate: true,
  });
  assert.deepEqual(profileFindOneCalls, [{ userId: "profile_user_123" }]);
  assert.equal(findCalls.length, 0);
});

test("GET /reviews/review/user/:userId allows the owner to fetch their private profile reviews", async () => {
  authUserId = "profile_user_123";
  profileDocuments = [
    {
      userId: "profile_user_123",
      isPrivate: true,
    },
  ];
  foundReviews = [
    {
      _id: "review_private_profile",
      userId: "profile_user_123",
      spotifyId: "spotify_album_123",
      title: "Kind of Blue",
      rating: 5,
      reviewText: "Owner can see this.",
    },
  ];

  const response = await getUserReviews("profile_user_123");

  assert.equal(response.status, 200);
  assert.deepEqual(findCalls, [{ userId: "profile_user_123" }]);
  assert.deepEqual(response.body[0].author, {
    userId: "profile_user_123",
    username: "albumboxd user",
    imageUrl: "",
  });
});

test("POST /reviews/review creates a review and returns the Clerk author", async () => {
  clerkUsers = [
    {
      id: "user_clerk_123",
      username: "loggedinlistener",
      imageUrl: "https://example.com/current-user.jpg",
    },
  ];

  const response = await postReview({
    spotifyId: "spotify_album_123",
    title: "Kind of Blue",
    artist: "Miles Davis",
    rating: 5,
    reviewText: "A forever record.",
  });

  assert.equal(response.status, 201);
  assert.equal(createCalls[0].userId, "user_clerk_123");
  assert.deepEqual(getUserListCalls, [{ userId: ["user_clerk_123"] }]);
  assert.deepEqual(response.body.author, {
    userId: "user_clerk_123",
    username: "loggedinlistener",
    imageUrl: "https://example.com/current-user.jpg",
  });
});

test("PATCH /reviews/review/user/:id updates an owned review and returns the Clerk author", async () => {
  clerkUsers = [
    {
      id: "user_clerk_123",
      username: "loggedinlistener",
      imageUrl: "https://example.com/current-user.jpg",
    },
  ];
  updatedReview = {
    _id: "review_123",
    userId: "user_clerk_123",
    spotifyId: "spotify_album_123",
    title: "Kind of Blue",
    artist: "Miles Davis",
    cover: "https://example.com/kind-of-blue.jpg",
    rating: 4,
    reviewText: "Still brilliant after another listen.",
    date: new Date("2026-06-01T12:00:00.000Z"),
  };

  const response = await patchReview("review_123", {
    rating: 4,
    reviewText: "  Still brilliant after another listen.  ",
    title: "Client should not change this",
    date: Date.now(),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(findOneAndUpdateCalls[0], {
    query: { _id: "review_123", userId: "user_clerk_123" },
    update: {
      $set: {
        rating: 4,
        reviewText: "Still brilliant after another listen.",
      },
    },
    options: { returnDocument: "after", runValidators: true },
  });
  assert.deepEqual(getUserListCalls, [{ userId: ["user_clerk_123"] }]);
  assert.equal(response.body.title, "Kind of Blue");
  assert.equal(response.body.date, updatedReview.date);
  assert.deepEqual(response.body.author, {
    userId: "user_clerk_123",
    username: "loggedinlistener",
    imageUrl: "https://example.com/current-user.jpg",
  });
});

test("PATCH /reviews/review/user/:id rejects an invalid rating", async () => {
  const response = await patchReview("review_123", {
    rating: 6,
    reviewText: "Too high.",
  });

  assert.equal(response.status, 400);
  assert.deepEqual(response.body, { error: "Rating must be between 1 and 5" });
  assert.equal(findOneAndUpdateCalls.length, 0);
});

test("PATCH /reviews/review/user/:id rejects empty review text", async () => {
  const response = await patchReview("review_123", {
    rating: 4,
    reviewText: "   ",
  });

  assert.equal(response.status, 400);
  assert.deepEqual(response.body, { error: "Review text is required" });
  assert.equal(findOneAndUpdateCalls.length, 0);
});

test("PATCH /reviews/review/user/:id returns 404 when the owner review is not found", async () => {
  const response = await patchReview("review_123", {
    rating: 4,
    reviewText: "Could belong to someone else.",
  });

  assert.equal(response.status, 404);
  assert.deepEqual(findOneAndUpdateCalls[0].query, {
    _id: "review_123",
    userId: "user_clerk_123",
  });
  assert.deepEqual(response.body, { error: "Review not found" });
});

test("PATCH /reviews/review/user/:id rejects unauthenticated edits", async () => {
  authUserId = "";

  const response = await patchReview("review_123", {
    rating: 4,
    reviewText: "No session.",
  });

  assert.equal(response.status, 401);
  assert.deepEqual(response.body, { error: "Unauthorized" });
  assert.equal(findOneAndUpdateCalls.length, 0);
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

test("GET /reviews/recent-albums returns unique albums from latest reviews", async () => {
  foundReviews = [
    {
      _id: "review_newest",
      spotifyId: "album_recent",
      title: "Fresh Listen",
      artist: "Today Band",
      cover: "https://example.com/recent.jpg",
      date: new Date("2026-06-10T12:00:00.000Z"),
    },
    {
      _id: "review_duplicate",
      spotifyId: "album_recent",
      title: "Fresh Listen",
      artist: "Today Band",
      cover: "https://example.com/recent.jpg",
      date: new Date("2026-06-09T12:00:00.000Z"),
    },
    {
      _id: "review_next",
      spotifyId: "album_next",
      title: "Next Listen",
      artist: "Tomorrow Band",
      cover: "https://example.com/next.jpg",
      date: new Date("2026-06-08T12:00:00.000Z"),
    },
  ];

  const response = await getRecentlyReviewedAlbums({ limit: "5" });

  assert.equal(response.status, 200);
  assert.deepEqual(findCalls, [{}]);
  assert.deepEqual(sortCalls, [{ date: -1 }]);
  assert.deepEqual(response.body.map((album) => album.spotifyId), ["album_recent", "album_next"]);
  assert.equal(response.body[0].latestReviewDate, foundReviews[0].date);
});

test("GET /reviews/popular-reviews returns highest all-time reviews with authors", async () => {
  foundReviews = [
    {
      _id: "review_top",
      userId: "reviewer_one",
      spotifyId: "album_top",
      title: "Five Stars",
      artist: "Peak Artist",
      cover: "https://example.com/top.jpg",
      rating: 5,
      reviewText: "All timer.",
      date: new Date("2026-06-10T12:00:00.000Z"),
    },
    {
      _id: "review_more_liked",
      userId: "reviewer_two",
      spotifyId: "album_liked",
      title: "Four Stars",
      artist: "Loved Artist",
      cover: "https://example.com/liked.jpg",
      rating: 4,
      reviewText: "People love this.",
      date: new Date("2026-06-09T12:00:00.000Z"),
    },
  ];
  likeDocuments = [
    {
      userId: "listener_one",
      targetType: "review",
      reviewId: "review_more_liked",
    },
    {
      userId: "listener_two",
      targetType: "review",
      reviewId: "review_more_liked",
    },
    {
      userId: "listener_three",
      targetType: "review",
      reviewId: "review_top",
    },
  ];
  clerkUsers = [
    {
      id: "reviewer_one",
      username: "peaklistener",
      imageUrl: "https://example.com/reviewer.jpg",
    },
    {
      id: "reviewer_two",
      username: "likedlistener",
      imageUrl: "https://example.com/liked-listener.jpg",
    },
  ];

  const response = await getPopularReviews({ limit: "5" });

  assert.equal(response.status, 200);
  assert.deepEqual(findCalls, [{}]);
  assert.deepEqual(sortCalls, [{ date: -1 }]);
  assert.deepEqual(getUserListCalls, [{ userId: ["reviewer_two", "reviewer_one"] }]);
  assert.equal(response.body[0]._id, "review_more_liked");
  assert.equal(response.body[0].author.username, "likedlistener");
  assert.equal(response.body[0].likeCount, 2);
});

test("GET /reviews/featured fills the homepage strip from review activity and catalog albums", async () => {
  const now = new Date();
  reviewDocuments = [
    {
      spotifyId: "recent_album",
      title: "Fresh Rotation",
      artist: "Now Playing",
      cover: "https://example.com/recent.jpg",
      rating: 5,
      date: now,
    },
    {
      spotifyId: "older_album",
      title: "Deep Cut",
      artist: "Archive Band",
      cover: "https://example.com/older.jpg",
      rating: 5,
      date: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
    },
  ];
  catalogDocuments = [
    {
      spotifyId: "catalog_album",
      title: "Catalog Favorite",
      artist: "Cached Artist",
      cover: "https://example.com/catalog.jpg",
      year: "2024",
    },
  ];

  const response = await getFeaturedAlbums({ limit: "5" });

  assert.equal(response.status, 200);
  assert.deepEqual(response.body.map((album) => album.spotifyId), [
    "recent_album",
    "older_album",
    "catalog_album",
  ]);
  assert.equal(aggregateCalls.length, 2);
  assert.equal(catalogLimitCalls[0], 3);
  assert.deepEqual(catalogFindCalls[0].spotifyId.$nin, ["recent_album", "older_album"]);
});

test("GET /reviews/featured skips duplicate or coverless review albums", async () => {
  reviewDocuments = [
    {
      spotifyId: "coverless_album",
      title: "No Jacket Required",
      artist: "Blank Art",
      rating: 5,
      date: new Date(),
    },
    {
      spotifyId: "covered_album",
      title: "Visible",
      artist: "Cover Artist",
      cover: "https://example.com/covered.jpg",
      rating: 4,
      date: new Date(),
    },
    {
      spotifyId: "covered_album",
      title: "Visible",
      artist: "Cover Artist",
      cover: "https://example.com/covered.jpg",
      rating: 5,
      date: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000),
    },
  ];

  const response = await getFeaturedAlbums({ limit: "5" });

  assert.equal(response.status, 200);
  assert.deepEqual(response.body.map((album) => album.spotifyId), ["covered_album"]);
  assert.equal(response.body[0].cover, "https://example.com/covered.jpg");
});
