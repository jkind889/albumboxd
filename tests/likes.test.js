const assert = require("node:assert/strict");
const test = require("node:test");

const likeModelPath = require.resolve("../models/Like");
const reviewModelPath = require.resolve("../models/Reviews");
const notificationModelPath = require.resolve("../models/Notification");
const clerkPath = require.resolve("@clerk/express");
const likeRoutePath = require.resolve("../routes/likes");

let likeDocuments = [];
let notificationDocuments = [];
let reviewById = new Map();
let authUserId = "user_clerk_123";

function matchesQuery(document, query) {
  return Object.entries(query).every(([key, value]) => String(document[key]) === String(value));
}

function loadLikeRouter() {
  delete require.cache[likeRoutePath];
  delete require.cache[likeModelPath];
  delete require.cache[reviewModelPath];
  delete require.cache[notificationModelPath];

  require.cache[likeModelPath] = {
    id: likeModelPath,
    filename: likeModelPath,
    loaded: true,
    exports: {
      countDocuments: async (query) => likeDocuments.filter((like) => matchesQuery(like, query)).length,
      exists: async (query) => likeDocuments.find((like) => matchesQuery(like, query)) || null,
      updateOne: async (query, update) => {
        const existingLike = likeDocuments.find((like) => matchesQuery(like, query));

        if (!existingLike) {
          likeDocuments.push({ ...update.$setOnInsert });
        }

        return { acknowledged: true };
      },
      deleteOne: async (query) => {
        likeDocuments = likeDocuments.filter((like) => !matchesQuery(like, query));
        return { acknowledged: true };
      },
    },
  };

  require.cache[reviewModelPath] = {
    id: reviewModelPath,
    filename: reviewModelPath,
    loaded: true,
    exports: {
      findById: async (reviewId) => reviewById.get(String(reviewId)) || null,
    },
  };

  require.cache[notificationModelPath] = {
    id: notificationModelPath,
    filename: notificationModelPath,
    loaded: true,
    exports: {
      updateOne: async (query, update) => {
        const existingNotification = notificationDocuments.find((notification) => (
          notification.recipientUserId === query.recipientUserId
          && notification.actorUserId === query.actorUserId
          && notification.type === query.type
          && String(notification.reviewId || "") === String(query.reviewId || "")
        ));

        if (!existingNotification) {
          notificationDocuments.push({ ...update.$setOnInsert });
        }

        return { acknowledged: true };
      },
    },
  };

  require.cache[clerkPath] = {
    id: clerkPath,
    filename: clerkPath,
    loaded: true,
    exports: {
      getAuth: () => ({ userId: authUserId }),
    },
  };

  return require("../routes/likes");
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

async function callRoute(method, path, { params = {}, body = {} } = {}) {
  const router = loadLikeRouter();
  const route = router.stack.find(
    (layer) => layer.route?.path === path && layer.route.methods[method],
  );

  assert.ok(route, `${method.toUpperCase()} ${path} should be registered`);

  const req = { params, body };
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

test.beforeEach(() => {
  likeDocuments = [];
  notificationDocuments = [];
  reviewById = new Map();
  authUserId = "user_clerk_123";
});

test("PUT /likes/album/:spotifyId likes an album idempotently", async () => {
  const firstResponse = await callRoute("put", "/album/:spotifyId", {
    params: { spotifyId: "spotify_album_123" },
    body: { liked: true },
  });
  const secondResponse = await callRoute("put", "/album/:spotifyId", {
    params: { spotifyId: "spotify_album_123" },
    body: { liked: true },
  });

  assert.equal(firstResponse.status, 200);
  assert.equal(secondResponse.status, 200);
  assert.equal(secondResponse.body.likeCount, 1);
  assert.equal(secondResponse.body.likedByViewer, true);
  assert.equal(likeDocuments.length, 1);
  assert.deepEqual(notificationDocuments, []);
});

test("PUT /likes/album/:spotifyId unlikes an album idempotently", async () => {
  likeDocuments = [
    {
      userId: "user_clerk_123",
      targetType: "album",
      spotifyId: "spotify_album_123",
    },
  ];

  const firstResponse = await callRoute("put", "/album/:spotifyId", {
    params: { spotifyId: "spotify_album_123" },
    body: { liked: false },
  });
  const secondResponse = await callRoute("put", "/album/:spotifyId", {
    params: { spotifyId: "spotify_album_123" },
    body: { liked: false },
  });

  assert.equal(firstResponse.status, 200);
  assert.equal(secondResponse.status, 200);
  assert.equal(secondResponse.body.likeCount, 0);
  assert.equal(secondResponse.body.likedByViewer, false);
  assert.equal(likeDocuments.length, 0);
});

test("GET /likes/album/:spotifyId returns count and viewer state", async () => {
  likeDocuments = [
    {
      userId: "user_clerk_123",
      targetType: "album",
      spotifyId: "spotify_album_123",
    },
    {
      userId: "other_user",
      targetType: "album",
      spotifyId: "spotify_album_123",
    },
  ];

  const response = await callRoute("get", "/album/:spotifyId", {
    params: { spotifyId: "spotify_album_123" },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    spotifyId: "spotify_album_123",
    likeCount: 2,
    likedByViewer: true,
  });
});

test("PUT /likes/review/:reviewId likes and unlikes a review idempotently", async () => {
  reviewById.set("review_123", {
    _id: "review_123",
    userId: "review_author_1",
    spotifyId: "spotify_album_123",
  });

  const likeResponse = await callRoute("put", "/review/:reviewId", {
    params: { reviewId: "review_123" },
    body: { liked: true },
  });
  const duplicateLikeResponse = await callRoute("put", "/review/:reviewId", {
    params: { reviewId: "review_123" },
    body: { liked: true },
  });
  const unlikeResponse = await callRoute("put", "/review/:reviewId", {
    params: { reviewId: "review_123" },
    body: { liked: false },
  });

  assert.equal(likeResponse.status, 200);
  assert.equal(likeResponse.body.likeCount, 1);
  assert.equal(likeResponse.body.spotifyId, "spotify_album_123");
  assert.equal(duplicateLikeResponse.body.likeCount, 1);
  assert.equal(unlikeResponse.body.likeCount, 0);
  assert.equal(unlikeResponse.body.likedByViewer, false);
  assert.deepEqual(notificationDocuments, [
    {
      recipientUserId: "review_author_1",
      actorUserId: "user_clerk_123",
      type: "review_like",
      reviewId: "review_123",
      spotifyId: "spotify_album_123",
    },
  ]);
});

test("PUT /likes/review/:reviewId does not notify for self-likes", async () => {
  reviewById.set("review_123", {
    _id: "review_123",
    userId: "user_clerk_123",
    spotifyId: "spotify_album_123",
  });

  const response = await callRoute("put", "/review/:reviewId", {
    params: { reviewId: "review_123" },
    body: { liked: true },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(notificationDocuments, []);
});

test("PUT /likes/review/:reviewId does not notify for unlikes", async () => {
  reviewById.set("review_123", {
    _id: "review_123",
    userId: "review_author_1",
    spotifyId: "spotify_album_123",
  });
  likeDocuments = [
    {
      userId: "user_clerk_123",
      targetType: "review",
      spotifyId: "spotify_album_123",
      reviewId: "review_123",
    },
  ];

  const response = await callRoute("put", "/review/:reviewId", {
    params: { reviewId: "review_123" },
    body: { liked: false },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(notificationDocuments, []);
});

test("PUT /likes/review/:reviewId rejects missing reviews", async () => {
  const response = await callRoute("put", "/review/:reviewId", {
    params: { reviewId: "missing_review" },
    body: { liked: true },
  });

  assert.equal(response.status, 404);
  assert.deepEqual(response.body, { error: "Review not found" });
});
