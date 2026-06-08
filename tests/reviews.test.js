const assert = require("node:assert/strict");
const test = require("node:test");

const reviewModelPath = require.resolve("../models/Reviews");
const clerkPath = require.resolve("@clerk/express");
const reviewRoutePath = require.resolve("../routes/reviews");

const findCalls = [];
const sortCalls = [];
let foundReviews = [];

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

test.beforeEach(() => {
  findCalls.length = 0;
  sortCalls.length = 0;
  foundReviews = [];
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
