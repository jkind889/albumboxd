const assert = require("node:assert/strict");
const test = require("node:test");

const profileModelPath = require.resolve("../models/UserProfile");
const followModelPath = require.resolve("../models/Follow");
const reviewModelPath = require.resolve("../models/Reviews");
const albumCatalogHelperPath = require.resolve("../routes/utils/albumCatalog");
const clerkPath = require.resolve("@clerk/express");
const profileRoutePath = require.resolve("../routes/profile");

let authUserId = "user_clerk_123";
const profilesByUserId = new Map();
let createdProfile = null;
let updatedProfile = null;
let getOrCreateError = null;
let reviewUserIds = new Set();
let followDocuments = [];
const findOneCalls = [];
const createCalls = [];
const updateCalls = [];
const getOrCreateCalls = [];
const reviewExistsCalls = [];
const followUpdateCalls = [];
const followDeleteCalls = [];

function chainResult(result) {
  return {
    populate(path) {
      this.populatePath = path;
      return Promise.resolve(result);
    },
    then(resolve, reject) {
      return Promise.resolve(result).then(resolve, reject);
    },
  };
}

function normalizeCatalogAlbum(album) {
  return {
    id: album.spotifyId,
    spotifyId: album.spotifyId,
    title: album.title,
    artist: album.artist,
    artists: album.artists || [],
    year: album.year || "unknown",
    releaseDate: album.releaseDate || "",
    genres: album.genres || [],
    imgs: album.imgs || [],
    cover: album.cover || null,
    totalTracks: album.totalTracks || 0,
    tracks: album.tracks || [],
    label: album.label || "",
    albumType: album.albumType || "album",
    spotifyUrl: album.spotifyUrl || "",
  };
}

function loadProfileRouter() {
  delete require.cache[profileRoutePath];

  require.cache[profileModelPath] = {
    id: profileModelPath,
    filename: profileModelPath,
    loaded: true,
    exports: {
      findOne: (query) => {
        findOneCalls.push(query);
        return chainResult(profilesByUserId.get(query.userId) || null);
      },
      create: async (profile) => {
        createCalls.push(profile);
        const nextProfile = createdProfile || profile;
        profilesByUserId.set(profile.userId, nextProfile);
        return nextProfile;
      },
      findOneAndUpdate: (query, update, options) => {
        updateCalls.push({ query, update, options });
        const nextProfile = updatedProfile || {
          userId: query.userId,
          ...update.$set,
        };
        profilesByUserId.set(query.userId, nextProfile);
        return chainResult(nextProfile);
      },
    },
  };

  require.cache[followModelPath] = {
    id: followModelPath,
    filename: followModelPath,
    loaded: true,
    exports: {
      countDocuments: async (query) => followDocuments.filter((follow) => (
        Object.entries(query).every(([key, value]) => follow[key] === value)
      )).length,
      exists: async (query) => followDocuments.find((follow) => (
        Object.entries(query).every(([key, value]) => follow[key] === value)
      )) || null,
      updateOne: async (query, update, options) => {
        followUpdateCalls.push({ query, update, options });
        const exists = followDocuments.some((follow) => (
          follow.followerId === query.followerId && follow.followingId === query.followingId
        ));

        if (!exists) {
          followDocuments.push({ ...update.$setOnInsert });
        }
      },
      deleteOne: async (query) => {
        followDeleteCalls.push(query);
        followDocuments = followDocuments.filter((follow) => !(
          follow.followerId === query.followerId && follow.followingId === query.followingId
        ));
      },
    },
  };

  require.cache[reviewModelPath] = {
    id: reviewModelPath,
    filename: reviewModelPath,
    loaded: true,
    exports: {
      exists: async (query) => {
        reviewExistsCalls.push(query);
        return reviewUserIds.has(query.userId) ? { _id: `review_${query.userId}` } : null;
      },
    },
  };

  require.cache[albumCatalogHelperPath] = {
    id: albumCatalogHelperPath,
    filename: albumCatalogHelperPath,
    loaded: true,
    exports: {
      getOrCreateAlbumCatalog: async (spotifyId) => {
        getOrCreateCalls.push(spotifyId);

        if (getOrCreateError) {
          throw getOrCreateError;
        }

        return {
          _id: `catalog_${spotifyId}`,
          spotifyId,
          title: spotifyId === "album_1" ? "Kind of Blue" : "Blue Train",
          artist: spotifyId === "album_1" ? "Miles Davis" : "John Coltrane",
          artists: [spotifyId === "album_1" ? "Miles Davis" : "John Coltrane"],
          year: spotifyId === "album_1" ? "1959" : "1958",
          cover: `https://example.com/${spotifyId}.jpg`,
        };
      },
      normalizeCatalogAlbum,
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

  return require("../routes/profile");
}

async function callRoute(method, path, { body = {}, params = {} } = {}) {
  const router = loadProfileRouter();
  const route = router.stack.find(
    (layer) => layer.route?.path === path && layer.route.methods[method],
  );

  assert.ok(route, `${method.toUpperCase()} ${path} should be registered`);

  const req = { body, params };
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

  const handlers = route.route.stack.map((layer) => layer.handle);

  for (const handler of handlers) {
    let nextWasCalled = false;
    await handler(req, res, () => {
      nextWasCalled = true;
    });

    if (!nextWasCalled) {
      break;
    }
  }

  return {
    status: res.statusCode,
    body: res.body,
  };
}

test.beforeEach(() => {
  authUserId = "user_clerk_123";
  profilesByUserId.clear();
  createdProfile = null;
  updatedProfile = null;
  getOrCreateError = null;
  reviewUserIds = new Set();
  followDocuments = [];
  findOneCalls.length = 0;
  createCalls.length = 0;
  updateCalls.length = 0;
  getOrCreateCalls.length = 0;
  reviewExistsCalls.length = 0;
  followUpdateCalls.length = 0;
  followDeleteCalls.length = 0;
});

test("GET /profile/me creates and returns an empty current user profile", async () => {
  const response = await callRoute("get", "/me");

  assert.equal(response.status, 200);
  assert.deepEqual(findOneCalls, [{ userId: "user_clerk_123" }]);
  assert.deepEqual(createCalls, [
    {
      userId: "user_clerk_123",
      bio: "",
      favoriteAlbums: [],
    },
  ]);
  assert.deepEqual(response.body, {
    userId: "user_clerk_123",
    bio: "",
    favoriteAlbums: [],
    followerCount: 0,
    followingCount: 0,
    isFollowing: false,
    isCurrentUser: true,
  });
});

test("GET /profile/me returns populated favorite albums in rank order", async () => {
  profilesByUserId.set("user_clerk_123", {
    userId: "user_clerk_123",
    bio: "Jazz forever.",
    favoriteAlbums: [
      {
        spotifyId: "album_2",
        rank: 1,
        albumCatalogId: {
          spotifyId: "album_2",
          title: "Blue Train",
          artist: "John Coltrane",
          artists: ["John Coltrane"],
          year: "1958",
          cover: "https://example.com/album_2.jpg",
        },
      },
      {
        spotifyId: "album_1",
        rank: 0,
        albumCatalogId: {
          spotifyId: "album_1",
          title: "Kind of Blue",
          artist: "Miles Davis",
          artists: ["Miles Davis"],
          year: "1959",
          cover: "https://example.com/album_1.jpg",
        },
      },
    ],
  });

  const response = await callRoute("get", "/me");

  assert.equal(response.status, 200);
  assert.equal(createCalls.length, 0);
  assert.deepEqual(
    response.body.favoriteAlbums.map((album) => album.spotifyId),
    ["album_1", "album_2"],
  );
  assert.equal(response.body.bio, "Jazz forever.");
});

test("PUT /profile/me saves bio and ordered favorite albums", async () => {
  updatedProfile = {
    userId: "user_clerk_123",
    bio: "Five records I keep close.",
    favoriteAlbums: [
      {
        spotifyId: "album_1",
        rank: 0,
        albumCatalogId: {
          spotifyId: "album_1",
          title: "Kind of Blue",
          artist: "Miles Davis",
          artists: ["Miles Davis"],
          year: "1959",
          cover: "https://example.com/album_1.jpg",
        },
      },
      {
        spotifyId: "album_2",
        rank: 1,
        albumCatalogId: {
          spotifyId: "album_2",
          title: "Blue Train",
          artist: "John Coltrane",
          artists: ["John Coltrane"],
          year: "1958",
          cover: "https://example.com/album_2.jpg",
        },
      },
    ],
  };

  const response = await callRoute("put", "/me", {
    body: {
      bio: "  Five records I keep close.  ",
      favoriteAlbumIds: ["album_1", "album_2"],
    },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(getOrCreateCalls, ["album_1", "album_2"]);
  assert.deepEqual(updateCalls[0], {
    query: { userId: "user_clerk_123" },
    update: {
      $set: {
        userId: "user_clerk_123",
        bio: "Five records I keep close.",
        favoriteAlbums: [
          {
            spotifyId: "album_1",
            albumCatalogId: "catalog_album_1",
            rank: 0,
          },
          {
            spotifyId: "album_2",
            albumCatalogId: "catalog_album_2",
            rank: 1,
          },
        ],
      },
    },
    options: {
      new: true,
      upsert: true,
      setDefaultsOnInsert: true,
    },
  });
  assert.deepEqual(
    response.body.favoriteAlbums.map((album) => album.spotifyId),
    ["album_1", "album_2"],
  );
  assert.equal(response.body.followerCount, 0);
  assert.equal(response.body.followingCount, 0);
  assert.equal(response.body.isCurrentUser, true);
});

test("PUT /profile/me rejects more than five favorite albums", async () => {
  const response = await callRoute("put", "/me", {
    body: {
      favoriteAlbumIds: ["1", "2", "3", "4", "5", "6"],
    },
  });

  assert.equal(response.status, 400);
  assert.deepEqual(response.body, { error: "Choose up to five favorite albums" });
  assert.equal(updateCalls.length, 0);
});

test("PUT /profile/me rejects duplicate favorite albums", async () => {
  const response = await callRoute("put", "/me", {
    body: {
      favoriteAlbumIds: ["album_1", "album_1"],
    },
  });

  assert.equal(response.status, 400);
  assert.deepEqual(response.body, { error: "Favorite albums must be unique" });
  assert.equal(updateCalls.length, 0);
});

test("PUT /profile/me rejects bios longer than 280 characters", async () => {
  const response = await callRoute("put", "/me", {
    body: {
      bio: "a".repeat(281),
      favoriteAlbumIds: [],
    },
  });

  assert.equal(response.status, 400);
  assert.deepEqual(response.body, { error: "Bio must be 280 characters or fewer" });
  assert.equal(updateCalls.length, 0);
});

test("GET /profile/me returns 401 when Clerk has no user", async () => {
  authUserId = null;

  const response = await callRoute("get", "/me");

  assert.equal(response.status, 401);
  assert.deepEqual(response.body, { error: "Unauthorized" });
  assert.equal(findOneCalls.length, 0);
});

test("PUT /profile/me returns 500 when catalog lookup fails", async (t) => {
  t.mock.method(console, "log", () => {});
  getOrCreateError = new Error("spotify unavailable");

  const response = await callRoute("put", "/me", {
    body: {
      favoriteAlbumIds: ["album_1"],
    },
  });

  assert.equal(response.status, 500);
  assert.deepEqual(response.body, { error: "Failed to update profile" });
  assert.deepEqual(getOrCreateCalls, ["album_1"]);
  assert.equal(updateCalls.length, 0);
});

test("GET /profile/:userId creates and returns a public profile for a reviewed user", async () => {
  reviewUserIds.add("review_author_1");
  followDocuments = [
    { followerId: "fan_1", followingId: "review_author_1" },
    { followerId: "fan_2", followingId: "review_author_1" },
    { followerId: "review_author_1", followingId: "artist_friend" },
    { followerId: "user_clerk_123", followingId: "review_author_1" },
  ];

  const response = await callRoute("get", "/:userId", {
    params: { userId: "review_author_1" },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(reviewExistsCalls, [{ userId: "review_author_1" }]);
  assert.deepEqual(createCalls, [
    {
      userId: "review_author_1",
      bio: "",
      favoriteAlbums: [],
    },
  ]);
  assert.deepEqual(response.body, {
    userId: "review_author_1",
    bio: "",
    favoriteAlbums: [],
    followerCount: 3,
    followingCount: 1,
    isFollowing: true,
    isCurrentUser: false,
  });
});

test("GET /profile/:userId returns 404 for a user without reviews", async () => {
  const response = await callRoute("get", "/:userId", {
    params: { userId: "random_user" },
  });

  assert.equal(response.status, 404);
  assert.deepEqual(response.body, { error: "User not found" });
  assert.equal(createCalls.length, 0);
});

test("PUT /profile/:userId/follow creates a follow relationship once", async () => {
  reviewUserIds.add("review_author_1");

  const firstResponse = await callRoute("put", "/:userId/follow", {
    params: { userId: "review_author_1" },
    body: { following: true },
  });
  const secondResponse = await callRoute("put", "/:userId/follow", {
    params: { userId: "review_author_1" },
    body: { following: true },
  });

  assert.equal(firstResponse.status, 200);
  assert.equal(secondResponse.status, 200);
  assert.deepEqual(followDocuments, [
    { followerId: "user_clerk_123", followingId: "review_author_1" },
  ]);
  assert.equal(followUpdateCalls.length, 2);
  assert.equal(secondResponse.body.followerCount, 1);
  assert.equal(secondResponse.body.followingCount, 0);
  assert.equal(secondResponse.body.isFollowing, true);
});

test("PUT /profile/:userId/follow removes an existing follow relationship", async () => {
  reviewUserIds.add("review_author_1");
  followDocuments = [
    { followerId: "user_clerk_123", followingId: "review_author_1" },
    { followerId: "other_user", followingId: "review_author_1" },
  ];

  const response = await callRoute("put", "/:userId/follow", {
    params: { userId: "review_author_1" },
    body: { following: false },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(followDeleteCalls, [
    { followerId: "user_clerk_123", followingId: "review_author_1" },
  ]);
  assert.deepEqual(followDocuments, [
    { followerId: "other_user", followingId: "review_author_1" },
  ]);
  assert.equal(response.body.followerCount, 1);
  assert.equal(response.body.isFollowing, false);
});

test("PUT /profile/:userId/follow succeeds when unfollowing without a relationship", async () => {
  reviewUserIds.add("review_author_1");

  const response = await callRoute("put", "/:userId/follow", {
    params: { userId: "review_author_1" },
    body: { following: false },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(followDocuments, []);
  assert.equal(response.body.followerCount, 0);
  assert.equal(response.body.isFollowing, false);
});

test("PUT /profile/:userId/follow blocks self-follow", async () => {
  reviewUserIds.add("user_clerk_123");

  const response = await callRoute("put", "/:userId/follow", {
    params: { userId: "user_clerk_123" },
    body: { following: true },
  });

  assert.equal(response.status, 400);
  assert.deepEqual(response.body, { error: "You cannot follow yourself" });
  assert.equal(followUpdateCalls.length, 0);
});

test("PUT /profile/:userId/follow rejects a user without reviews", async () => {
  const response = await callRoute("put", "/:userId/follow", {
    params: { userId: "random_user" },
    body: { following: true },
  });

  assert.equal(response.status, 404);
  assert.deepEqual(response.body, { error: "User not found" });
  assert.equal(createCalls.length, 0);
  assert.equal(followUpdateCalls.length, 0);
});

test("PUT /profile/:userId/follow rejects non-boolean follow state", async () => {
  reviewUserIds.add("review_author_1");

  const response = await callRoute("put", "/:userId/follow", {
    params: { userId: "review_author_1" },
    body: { following: "yes" },
  });

  assert.equal(response.status, 400);
  assert.deepEqual(response.body, { error: "following must be true or false" });
  assert.equal(reviewExistsCalls.length, 0);
});
