const assert = require("node:assert/strict");
const test = require("node:test");

const profileModelPath = require.resolve("../models/UserProfile");
const followModelPath = require.resolve("../models/Follow");
const reviewModelPath = require.resolve("../models/Reviews");
const albumModelPath = require.resolve("../models/Albums");
const boardModelPath = require.resolve("../models/Board");
const boardItemModelPath = require.resolve("../models/BoardItem");
const likeModelPath = require.resolve("../models/Like");
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
let activityReviewDocuments = [];
let activitySavedAlbumDocuments = [];
let boardDocuments = [];
let boardItemDocuments = [];
let likeDocuments = [];
let clerkUsers = [];
let shouldRejectClerkLookup = false;
const findOneCalls = [];
const createCalls = [];
const updateCalls = [];
const getOrCreateCalls = [];
const reviewExistsCalls = [];
const reviewFindCalls = [];
const reviewFindOneCalls = [];
const reviewSortCalls = [];
const reviewLimitCalls = [];
const albumFindCalls = [];
const albumPopulateCalls = [];
const albumSortCalls = [];
const albumLimitCalls = [];
const boardFindOneCalls = [];
const boardItemFindCalls = [];
const boardItemPopulateCalls = [];
const boardItemSortCalls = [];
const boardItemLimitCalls = [];
const boardItemCountCalls = [];
const followFindCalls = [];
const followUpdateCalls = [];
const followDeleteCalls = [];
const getUserListCalls = [];
const likeFindCalls = [];

function chainResult(result) {
  const chain = {
    populate(path) {
      this.populatePath = path;
      return this;
    },
    then(resolve, reject) {
      return Promise.resolve(result).then(resolve, reject);
    },
  };

  return chain;
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
  delete require.cache[likeModelPath];

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
      find: async (query) => {
        followFindCalls.push(query);
        return followDocuments.filter((follow) => (
          Object.entries(query).every(([key, value]) => follow[key] === value)
        ));
      },
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
      find: (query) => {
        reviewFindCalls.push(query);

        return {
          sort: (sortOrder) => {
            reviewSortCalls.push(sortOrder);

            return {
              limit: async (limit) => {
                reviewLimitCalls.push(limit);
                const userIds = query.userId?.$in || [query.userId].filter(Boolean);

                return activityReviewDocuments
                  .filter((review) => userIds.includes(review.userId))
                  .sort((first, second) => new Date(second.date) - new Date(first.date))
                  .slice(0, limit);
              },
            };
          },
        };
      },
      findOne: async (query) => {
        reviewFindOneCalls.push(query);
        return activityReviewDocuments.find((review) => (
          String(review._id) === String(query._id) && review.userId === query.userId
        )) || null;
      },
    },
  };

  require.cache[albumModelPath] = {
    id: albumModelPath,
    filename: albumModelPath,
    loaded: true,
    exports: {
      find: (query) => {
        albumFindCalls.push(query);

        return {
          populate: (path) => {
            albumPopulateCalls.push(path);

            return {
              sort: (sortOrder) => {
                albumSortCalls.push(sortOrder);
                const sortedAlbums = activitySavedAlbumDocuments
                  .filter((album) => album.userId === query.userId)
                  .sort((first, second) => new Date(second.savedAt) - new Date(first.savedAt));

                return {
                  limit: async (limit) => {
                    albumLimitCalls.push(limit);

                    return sortedAlbums.slice(0, limit);
                  },
                  then: (resolve, reject) => Promise.resolve(sortedAlbums).then(resolve, reject),
                };
              },
            };
          },
        };
      },
    },
  };

  require.cache[boardModelPath] = {
    id: boardModelPath,
    filename: boardModelPath,
    loaded: true,
    exports: {
      findOne: async (query) => {
        boardFindOneCalls.push(query);
        return boardDocuments.find((board) => (
          String(board._id) === String(query._id) && board.userId === query.userId
        )) || null;
      },
    },
  };

  require.cache[boardItemModelPath] = {
    id: boardItemModelPath,
    filename: boardItemModelPath,
    loaded: true,
    exports: {
      find: (query) => {
        boardItemFindCalls.push(query);

        return {
          populate: (path) => {
            boardItemPopulateCalls.push(path);

            return {
              sort: (sortOrder) => {
                boardItemSortCalls.push(sortOrder);
                const sortedItems = boardItemDocuments
                  .filter((item) => String(item.boardId) === String(query.boardId))
                  .sort((first, second) => new Date(second.savedAt) - new Date(first.savedAt));

                return {
                  limit: async (limit) => {
                    boardItemLimitCalls.push(limit);
                    return sortedItems.slice(0, limit);
                  },
                  then: (resolve, reject) => Promise.resolve(sortedItems).then(resolve, reject),
                };
              },
            };
          },
        };
      },
      countDocuments: async (query) => {
        boardItemCountCalls.push(query);
        return boardItemDocuments.filter((item) => String(item.boardId) === String(query.boardId)).length;
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

  return require("../routes/profile");
}

async function callRoute(method, path, { body = {}, params = {}, query = {} } = {}) {
  const router = loadProfileRouter();
  const route = router.stack.find(
    (layer) => layer.route?.path === path && layer.route.methods[method],
  );

  assert.ok(route, `${method.toUpperCase()} ${path} should be registered`);

  const req = { body, params, query };
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
  activityReviewDocuments = [];
  activitySavedAlbumDocuments = [];
  boardDocuments = [];
  boardItemDocuments = [];
  likeDocuments = [];
  clerkUsers = [];
  shouldRejectClerkLookup = false;
  findOneCalls.length = 0;
  createCalls.length = 0;
  updateCalls.length = 0;
  getOrCreateCalls.length = 0;
  reviewExistsCalls.length = 0;
  reviewFindCalls.length = 0;
  reviewFindOneCalls.length = 0;
  reviewSortCalls.length = 0;
  reviewLimitCalls.length = 0;
  albumFindCalls.length = 0;
  albumPopulateCalls.length = 0;
  albumSortCalls.length = 0;
  albumLimitCalls.length = 0;
  boardFindOneCalls.length = 0;
  boardItemFindCalls.length = 0;
  boardItemPopulateCalls.length = 0;
  boardItemSortCalls.length = 0;
  boardItemLimitCalls.length = 0;
  boardItemCountCalls.length = 0;
  followFindCalls.length = 0;
  followUpdateCalls.length = 0;
  followDeleteCalls.length = 0;
  getUserListCalls.length = 0;
  likeFindCalls.length = 0;
});

test("GET /profile/me creates and returns an empty current user profile", async () => {
  const response = await callRoute("get", "/me");

  assert.equal(response.status, 200);
  assert.deepEqual(findOneCalls, [{ userId: "user_clerk_123" }]);
  assert.deepEqual(createCalls, [
    {
      userId: "user_clerk_123",
      bio: "",
      spotifyProfileUrl: "",
      favoriteAlbums: [],
      listeningNextAlbum: null,
      pinnedReviewId: null,
      pinnedBoardId: null,
    },
  ]);
  assert.deepEqual(response.body, {
    userId: "user_clerk_123",
    username: "albumboxd user",
    imageUrl: "",
    bio: "",
    spotifyProfileUrl: "",
    favoriteAlbums: [],
    listeningNextAlbum: null,
    pinnedReview: null,
    pinnedBoard: null,
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
    spotifyProfileUrl: "https://open.spotify.com/user/currentlistener",
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
    listeningNextAlbum: {
      spotifyId: "album_2",
      albumCatalogId: {
        spotifyId: "album_2",
        title: "Blue Train",
        artist: "John Coltrane",
        artists: ["John Coltrane"],
        year: "1958",
        cover: "https://example.com/album_2.jpg",
      },
    },
  });

  const response = await callRoute("get", "/me");

  assert.equal(response.status, 200);
  assert.equal(createCalls.length, 0);
  assert.deepEqual(
    response.body.favoriteAlbums.map((album) => album.spotifyId),
    ["album_1", "album_2"],
  );
  assert.equal(response.body.bio, "Jazz forever.");
  assert.equal(response.body.spotifyProfileUrl, "https://open.spotify.com/user/currentlistener");
  assert.equal(response.body.listeningNextAlbum.spotifyId, "album_2");
});

test("PUT /profile/me saves bio and ordered favorite albums", async () => {
  updatedProfile = {
    userId: "user_clerk_123",
    bio: "Five records I keep close.",
    spotifyProfileUrl: "https://open.spotify.com/user/currentlistener",
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
      spotifyProfileUrl: " https://open.spotify.com/user/currentlistener ",
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
        spotifyProfileUrl: "https://open.spotify.com/user/currentlistener",
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
        listeningNextAlbum: null,
        pinnedReviewId: null,
        pinnedBoardId: null,
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
  assert.equal(response.body.spotifyProfileUrl, "https://open.spotify.com/user/currentlistener");
});

test("PUT /profile/me saves listening next, pinned review, and pinned board", async () => {
  activityReviewDocuments = [
    {
      _id: "review_1",
      userId: "user_clerk_123",
      spotifyId: "album_1",
      title: "Kind of Blue",
      artist: "Miles Davis",
      cover: "https://example.com/kind-of-blue.jpg",
      rating: 5,
      reviewText: "Still the one.",
      date: new Date("2026-06-10T10:00:00.000Z"),
    },
  ];
  boardDocuments = [
    {
      _id: "board_1",
      userId: "user_clerk_123",
      title: "Night Drive",
      isDefault: false,
      createdAt: new Date("2026-06-09T10:00:00.000Z"),
      updatedAt: new Date("2026-06-11T10:00:00.000Z"),
    },
  ];
  boardItemDocuments = [
    {
      _id: "board_item_1",
      userId: "user_clerk_123",
      boardId: "board_1",
      spotifyId: "album_2",
      savedAt: new Date("2026-06-12T10:00:00.000Z"),
      albumCatalogId: {
        _id: "catalog_album_2",
        spotifyId: "album_2",
        title: "Blue Train",
        artist: "John Coltrane",
        cover: "https://example.com/blue-train.jpg",
      },
    },
  ];
  updatedProfile = {
    userId: "user_clerk_123",
    bio: "",
    spotifyProfileUrl: "",
    favoriteAlbums: [],
    listeningNextAlbum: {
      spotifyId: "album_2",
      albumCatalogId: {
        spotifyId: "album_2",
        title: "Blue Train",
        artist: "John Coltrane",
        artists: ["John Coltrane"],
        year: "1958",
        cover: "https://example.com/album_2.jpg",
      },
    },
    pinnedReviewId: activityReviewDocuments[0],
    pinnedBoardId: boardDocuments[0],
  };

  const response = await callRoute("put", "/me", {
    body: {
      favoriteAlbumIds: [],
      listeningNextAlbumId: "album_2",
      pinnedReviewId: "review_1",
      pinnedBoardId: "board_1",
    },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(getOrCreateCalls, ["album_2"]);
  assert.deepEqual(reviewFindOneCalls, [{ _id: "review_1", userId: "user_clerk_123" }]);
  assert.deepEqual(boardFindOneCalls, [{ _id: "board_1", userId: "user_clerk_123" }]);
  assert.deepEqual(updateCalls[0].update.$set.listeningNextAlbum, {
    spotifyId: "album_2",
    albumCatalogId: "catalog_album_2",
  });
  assert.equal(updateCalls[0].update.$set.pinnedReviewId, "review_1");
  assert.equal(updateCalls[0].update.$set.pinnedBoardId, "board_1");
  assert.equal(response.body.listeningNextAlbum.spotifyId, "album_2");
  assert.equal(response.body.pinnedReview._id, "review_1");
  assert.equal(response.body.pinnedBoard._id, "board_1");
  assert.equal(response.body.pinnedBoard.itemCount, 1);
  assert.equal(response.body.pinnedBoard.previewAlbums[0].spotifyId, "album_2");
});

test("PUT /profile/me clears listening next and pinned profile slots", async () => {
  updatedProfile = {
    userId: "user_clerk_123",
    bio: "",
    spotifyProfileUrl: "",
    favoriteAlbums: [],
    listeningNextAlbum: null,
    pinnedReviewId: null,
    pinnedBoardId: null,
  };

  const response = await callRoute("put", "/me", {
    body: {
      favoriteAlbumIds: [],
      listeningNextAlbumId: "",
      pinnedReviewId: "",
      pinnedBoardId: "",
    },
  });

  assert.equal(response.status, 200);
  assert.equal(getOrCreateCalls.length, 0);
  assert.equal(reviewFindOneCalls.length, 0);
  assert.equal(boardFindOneCalls.length, 0);
  assert.equal(updateCalls[0].update.$set.listeningNextAlbum, null);
  assert.equal(updateCalls[0].update.$set.pinnedReviewId, null);
  assert.equal(updateCalls[0].update.$set.pinnedBoardId, null);
  assert.equal(response.body.listeningNextAlbum, null);
  assert.equal(response.body.pinnedReview, null);
  assert.equal(response.body.pinnedBoard, null);
});

test("PUT /profile/me rejects pinned review not owned by the current user", async () => {
  activityReviewDocuments = [
    {
      _id: "review_1",
      userId: "other_user",
      spotifyId: "album_1",
      title: "Kind of Blue",
      artist: "Miles Davis",
      rating: 5,
      reviewText: "Not yours.",
      date: new Date("2026-06-10T10:00:00.000Z"),
    },
  ];

  const response = await callRoute("put", "/me", {
    body: {
      favoriteAlbumIds: [],
      pinnedReviewId: "review_1",
    },
  });

  assert.equal(response.status, 400);
  assert.deepEqual(response.body, { error: "Pinned review must belong to your profile" });
  assert.equal(updateCalls.length, 0);
});

test("PUT /profile/me rejects pinned board not owned by the current user", async () => {
  boardDocuments = [
    {
      _id: "board_1",
      userId: "other_user",
      title: "Someone else's board",
    },
  ];

  const response = await callRoute("put", "/me", {
    body: {
      favoriteAlbumIds: [],
      pinnedBoardId: "board_1",
    },
  });

  assert.equal(response.status, 400);
  assert.deepEqual(response.body, { error: "Pinned board must belong to your profile" });
  assert.equal(updateCalls.length, 0);
});

test("PUT /profile/me clears an empty Spotify profile URL", async () => {
  updatedProfile = {
    userId: "user_clerk_123",
    bio: "",
    spotifyProfileUrl: "",
    favoriteAlbums: [],
    listeningNextAlbum: null,
    pinnedReviewId: null,
    pinnedBoardId: null,
  };

  const response = await callRoute("put", "/me", {
    body: {
      spotifyProfileUrl: "  ",
      favoriteAlbumIds: [],
    },
  });

  assert.equal(response.status, 200);
  assert.equal(updateCalls[0].update.$set.spotifyProfileUrl, "");
  assert.equal(response.body.spotifyProfileUrl, "");
});

test("PUT /profile/me rejects invalid Spotify profile URLs", async () => {
  const response = await callRoute("put", "/me", {
    body: {
      spotifyProfileUrl: "https://example.com/user/currentlistener",
      favoriteAlbumIds: [],
    },
  });

  assert.equal(response.status, 400);
  assert.deepEqual(response.body, { error: "Spotify profile must be an https://open.spotify.com/user/... URL" });
  assert.equal(updateCalls.length, 0);
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

test("GET /profile/me/network returns followed user review activity newest first", async () => {
  followDocuments = [
    { followerId: "user_clerk_123", followingId: "review_author_1" },
    { followerId: "user_clerk_123", followingId: "review_author_2" },
    { followerId: "other_user", followingId: "review_author_3" },
  ];
  activityReviewDocuments = [
    {
      _id: "older_review",
      userId: "review_author_1",
      spotifyId: "album_1",
      title: "Kind of Blue",
      artist: "Miles Davis",
      cover: "https://example.com/kind-of-blue.jpg",
      rating: 5,
      reviewText: "Still the one.",
      date: new Date("2026-06-10T10:00:00.000Z"),
    },
    {
      _id: "newer_review",
      userId: "review_author_2",
      spotifyId: "album_2",
      title: "Blue Train",
      artist: "John Coltrane",
      cover: "https://example.com/blue-train.jpg",
      rating: 4,
      reviewText: "Hard bop glow.",
      date: new Date("2026-06-11T10:00:00.000Z"),
    },
    {
      _id: "unfollowed_review",
      userId: "review_author_3",
      spotifyId: "album_3",
      title: "Not in Feed",
      artist: "Someone Else",
      rating: 3,
      reviewText: "Should not render.",
      date: new Date("2026-06-12T10:00:00.000Z"),
    },
  ];
  clerkUsers = [
    {
      id: "review_author_1",
      username: "kindofkaren",
      imageUrl: "https://example.com/karen.jpg",
    },
    {
      id: "review_author_2",
      username: "bluebill",
      imageUrl: "https://example.com/bill.jpg",
    },
  ];
  likeDocuments = [
    {
      userId: "user_clerk_123",
      targetType: "review",
      reviewId: "newer_review",
    },
    {
      userId: "other_listener",
      targetType: "review",
      reviewId: "newer_review",
    },
  ];

  const response = await callRoute("get", "/me/network");

  assert.equal(response.status, 200);
  assert.deepEqual(followFindCalls, [{ followerId: "user_clerk_123" }]);
  assert.deepEqual(reviewFindCalls, [{ userId: { $in: ["review_author_1", "review_author_2"] } }]);
  assert.deepEqual(reviewSortCalls, [{ date: -1 }]);
  assert.deepEqual(reviewLimitCalls, [20]);
  assert.deepEqual(getUserListCalls, [{ userId: ["review_author_2", "review_author_1"] }]);
  assert.deepEqual(
    response.body.map((activity) => activity.id),
    ["newer_review", "older_review"],
  );
  assert.deepEqual(response.body[0], {
    id: "newer_review",
    type: "review",
    actor: {
      userId: "review_author_2",
      username: "bluebill",
      imageUrl: "https://example.com/bill.jpg",
    },
    userId: "review_author_2",
    createdAt: new Date("2026-06-11T10:00:00.000Z"),
    album: {
      spotifyId: "album_2",
      title: "Blue Train",
      artist: "John Coltrane",
      cover: "https://example.com/blue-train.jpg",
    },
    rating: 4,
    reviewText: "Hard bop glow.",
    likeCount: 2,
    likedByViewer: true,
  });
});

test("GET /profile/me/network returns empty when not following anyone", async () => {
  const response = await callRoute("get", "/me/network");

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, []);
  assert.deepEqual(followFindCalls, [{ followerId: "user_clerk_123" }]);
  assert.equal(reviewFindCalls.length, 0);
  assert.equal(getUserListCalls.length, 0);
});

test("GET /profile/me/network excludes self-follow rows", async () => {
  followDocuments = [
    { followerId: "user_clerk_123", followingId: "user_clerk_123" },
  ];

  const response = await callRoute("get", "/me/network");

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, []);
  assert.equal(reviewFindCalls.length, 0);
});

test("GET /profile/me/network falls back when Clerk actor lookup fails", async () => {
  shouldRejectClerkLookup = true;
  followDocuments = [
    { followerId: "user_clerk_123", followingId: "review_author_1" },
  ];
  activityReviewDocuments = [
    {
      _id: "review_lookup_failure",
      userId: "review_author_1",
      spotifyId: "album_1",
      title: "Kind of Blue",
      artist: "Miles Davis",
      rating: 5,
      reviewText: "Still renders.",
      date: new Date("2026-06-10T10:00:00.000Z"),
    },
  ];

  const response = await callRoute("get", "/me/network");

  assert.equal(response.status, 200);
  assert.deepEqual(response.body[0].actor, {
    userId: "review_author_1",
    username: "albumboxd user",
    imageUrl: "",
  });
});

test("GET /profile/me/activity returns current user's saved and reviewed activity", async () => {
  activityReviewDocuments = [
    {
      _id: "own_review",
      userId: "user_clerk_123",
      spotifyId: "album_1",
      title: "Kind of Blue",
      artist: "Miles Davis",
      cover: "https://example.com/kind-of-blue.jpg",
      rating: 5,
      reviewText: "Mine.",
      date: new Date("2026-06-10T10:00:00.000Z"),
    },
  ];
  activitySavedAlbumDocuments = [
    {
      _id: "own_save",
      userId: "user_clerk_123",
      spotifyId: "album_2",
      savedAt: new Date("2026-06-11T10:00:00.000Z"),
      albumCatalogId: {
        _id: "catalog_album_2",
        spotifyId: "album_2",
        title: "Blue Train",
        artist: "John Coltrane",
        cover: "https://example.com/blue-train.jpg",
      },
    },
  ];
  clerkUsers = [
    {
      id: "user_clerk_123",
      username: "currentlistener",
      imageUrl: "https://example.com/current.jpg",
    },
  ];

  const response = await callRoute("get", "/me/activity");

  assert.equal(response.status, 200);
  assert.deepEqual(reviewFindCalls, [{ userId: "user_clerk_123" }]);
  assert.deepEqual(albumFindCalls, [{ userId: "user_clerk_123" }]);
  assert.deepEqual(albumPopulateCalls, ["albumCatalogId"]);
  assert.deepEqual(
    response.body.map((activity) => activity.type),
    ["saved_album", "review"],
  );
  assert.deepEqual(response.body[0], {
    id: "own_save",
    type: "saved_album",
    actor: {
      userId: "user_clerk_123",
      username: "currentlistener",
      imageUrl: "https://example.com/current.jpg",
    },
    userId: "user_clerk_123",
    createdAt: new Date("2026-06-11T10:00:00.000Z"),
    album: {
      spotifyId: "album_2",
      title: "Blue Train",
      artist: "John Coltrane",
      cover: "https://example.com/blue-train.jpg",
    },
  });
});

test("GET /profile/:userId/activity returns public profile saved and reviewed activity", async () => {
  reviewUserIds.add("review_author_1");
  activityReviewDocuments = [
    {
      _id: "public_review",
      userId: "review_author_1",
      spotifyId: "album_1",
      title: "Kind of Blue",
      artist: "Miles Davis",
      rating: 5,
      reviewText: "Public review.",
      date: new Date("2026-06-10T10:00:00.000Z"),
    },
  ];
  activitySavedAlbumDocuments = [
    {
      _id: "public_save",
      userId: "review_author_1",
      spotifyId: "album_2",
      savedAt: new Date("2026-06-12T10:00:00.000Z"),
      albumCatalogId: {
        _id: "catalog_album_2",
        spotifyId: "album_2",
        title: "Blue Train",
        artist: "John Coltrane",
        cover: "https://example.com/blue-train.jpg",
      },
    },
  ];

  const response = await callRoute("get", "/:userId/activity", {
    params: { userId: "review_author_1" },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(reviewExistsCalls, [{ userId: "review_author_1" }]);
  assert.deepEqual(
    response.body.map((activity) => activity.type),
    ["saved_album", "review"],
  );
});

test("GET /profile/:userId/saved returns public profile saved albums newest first", async () => {
  reviewUserIds.add("review_author_1");
  activitySavedAlbumDocuments = [
    {
      _id: "older_save",
      userId: "review_author_1",
      spotifyId: "album_1",
      savedAt: new Date("2026-06-10T10:00:00.000Z"),
      albumCatalogId: {
        _id: "catalog_album_1",
        spotifyId: "album_1",
        title: "Kind of Blue",
        artist: "Miles Davis",
        artists: ["Miles Davis"],
        year: "1959",
        cover: "https://example.com/kind-of-blue.jpg",
      },
    },
    {
      _id: "newer_save",
      userId: "review_author_1",
      spotifyId: "album_2",
      savedAt: new Date("2026-06-12T10:00:00.000Z"),
      albumCatalogId: {
        _id: "catalog_album_2",
        spotifyId: "album_2",
        title: "Blue Train",
        artist: "John Coltrane",
        artists: ["John Coltrane"],
        year: "1958",
        cover: "https://example.com/blue-train.jpg",
      },
    },
    {
      _id: "other_user_save",
      userId: "other_user",
      spotifyId: "album_3",
      savedAt: new Date("2026-06-13T10:00:00.000Z"),
      albumCatalogId: {
        _id: "catalog_album_3",
        spotifyId: "album_3",
        title: "Not This Shelf",
        artist: "Someone Else",
      },
    },
  ];

  const response = await callRoute("get", "/:userId/saved", {
    params: { userId: "review_author_1" },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(reviewExistsCalls, [{ userId: "review_author_1" }]);
  assert.deepEqual(albumFindCalls, [{ userId: "review_author_1" }]);
  assert.deepEqual(albumPopulateCalls, ["albumCatalogId"]);
  assert.deepEqual(albumSortCalls, [{ savedAt: -1 }]);
  assert.equal(albumLimitCalls.length, 0);
  assert.deepEqual(
    response.body.map((album) => album.spotifyId),
    ["album_2", "album_1"],
  );
  assert.deepEqual(response.body[0], {
    id: "album_2",
    spotifyId: "album_2",
    title: "Blue Train",
    artist: "John Coltrane",
    artists: ["John Coltrane"],
    year: "1958",
    releaseDate: "",
    genres: [],
    imgs: [],
    cover: "https://example.com/blue-train.jpg",
    totalTracks: 0,
    tracks: [],
    label: "",
    albumType: "album",
    spotifyUrl: "",
    _id: "newer_save",
    albumCatalogId: "catalog_album_2",
    userId: "review_author_1",
    savedAt: new Date("2026-06-12T10:00:00.000Z"),
  });
});

test("GET /profile/:userId/saved returns 404 for a user without reviews", async () => {
  const response = await callRoute("get", "/:userId/saved", {
    params: { userId: "random_user" },
  });

  assert.equal(response.status, 404);
  assert.deepEqual(response.body, { error: "User not found" });
  assert.equal(albumFindCalls.length, 0);
});

test("GET /profile/:userId/boards/:boardId returns a public read-only board", async () => {
  reviewUserIds.add("review_author_1");
  boardDocuments = [
    {
      _id: "board_1",
      userId: "review_author_1",
      title: "Start Here",
      isDefault: false,
      createdAt: new Date("2026-06-09T10:00:00.000Z"),
      updatedAt: new Date("2026-06-11T10:00:00.000Z"),
    },
  ];
  boardItemDocuments = [
    {
      _id: "board_item_1",
      userId: "review_author_1",
      boardId: "board_1",
      spotifyId: "album_1",
      savedAt: new Date("2026-06-10T10:00:00.000Z"),
      albumCatalogId: {
        _id: "catalog_album_1",
        spotifyId: "album_1",
        title: "Kind of Blue",
        artist: "Miles Davis",
        cover: "https://example.com/kind-of-blue.jpg",
      },
    },
  ];

  const response = await callRoute("get", "/:userId/boards/:boardId", {
    params: { userId: "review_author_1", boardId: "board_1" },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(reviewExistsCalls, [{ userId: "review_author_1" }]);
  assert.deepEqual(boardFindOneCalls, [{ _id: "board_1", userId: "review_author_1" }]);
  assert.equal(response.body._id, "board_1");
  assert.equal(response.body.title, "Start Here");
  assert.equal(response.body.itemCount, 1);
  assert.deepEqual(
    response.body.albums.map((album) => album.spotifyId),
    ["album_1"],
  );
});

test("GET /profile/:userId/network returns followers and following users", async () => {
  reviewUserIds.add("review_author_1");
  followDocuments = [
    { followerId: "fan_1", followingId: "review_author_1" },
    { followerId: "fan_2", followingId: "review_author_1" },
    { followerId: "review_author_1", followingId: "artist_friend" },
  ];
  clerkUsers = [
    {
      id: "fan_1",
      username: "firstfan",
      imageUrl: "https://example.com/fan-1.jpg",
    },
    {
      id: "fan_2",
      username: "secondfan",
      imageUrl: "https://example.com/fan-2.jpg",
    },
    {
      id: "artist_friend",
      username: "artistfriend",
      imageUrl: "https://example.com/artist-friend.jpg",
    },
  ];

  const response = await callRoute("get", "/:userId/network", {
    params: { userId: "review_author_1" },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(reviewExistsCalls, [{ userId: "review_author_1" }]);
  assert.deepEqual(followFindCalls, [
    { followingId: "review_author_1" },
    { followerId: "review_author_1" },
  ]);
  assert.deepEqual(response.body, {
    userId: "review_author_1",
    followers: [
      {
        userId: "fan_1",
        username: "firstfan",
        imageUrl: "https://example.com/fan-1.jpg",
      },
      {
        userId: "fan_2",
        username: "secondfan",
        imageUrl: "https://example.com/fan-2.jpg",
      },
    ],
    following: [
      {
        userId: "artist_friend",
        username: "artistfriend",
        imageUrl: "https://example.com/artist-friend.jpg",
      },
    ],
    followerCount: 2,
    followingCount: 1,
  });
});

test("GET /profile/:userId/network returns 404 for a user without reviews", async () => {
  const response = await callRoute("get", "/:userId/network", {
    params: { userId: "random_user" },
  });

  assert.equal(response.status, 404);
  assert.deepEqual(response.body, { error: "User not found" });
  assert.equal(followFindCalls.length, 0);
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
      spotifyProfileUrl: "",
      favoriteAlbums: [],
      listeningNextAlbum: null,
      pinnedReviewId: null,
      pinnedBoardId: null,
    },
  ]);
  assert.deepEqual(response.body, {
    userId: "review_author_1",
    username: "albumboxd user",
    imageUrl: "",
    bio: "",
    spotifyProfileUrl: "",
    favoriteAlbums: [],
    listeningNextAlbum: null,
    pinnedReview: null,
    pinnedBoard: null,
    followerCount: 3,
    followingCount: 1,
    isFollowing: true,
    isCurrentUser: false,
  });
});

test("GET /profile/:userId includes Clerk username and profile image", async () => {
  reviewUserIds.add("review_author_1");
  clerkUsers = [
    {
      id: "review_author_1",
      username: "blueposter",
      imageUrl: "https://example.com/blueposter.jpg",
    },
  ];

  const response = await callRoute("get", "/:userId", {
    params: { userId: "review_author_1" },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(getUserListCalls, [{ userId: ["review_author_1"] }]);
  assert.equal(response.body.username, "blueposter");
  assert.equal(response.body.imageUrl, "https://example.com/blueposter.jpg");
});

test("GET /profile/:userId exposes a saved Spotify profile URL", async () => {
  reviewUserIds.add("review_author_1");
  profilesByUserId.set("review_author_1", {
    userId: "review_author_1",
    bio: "A public listener.",
    spotifyProfileUrl: "https://open.spotify.com/user/publiclistener",
    favoriteAlbums: [],
  });

  const response = await callRoute("get", "/:userId", {
    params: { userId: "review_author_1" },
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.spotifyProfileUrl, "https://open.spotify.com/user/publiclistener");
  assert.equal(createCalls.length, 0);
});

test("GET /profile/:userId exposes public profile pins", async () => {
  reviewUserIds.add("review_author_1");
  const pinnedReview = {
    _id: "public_review",
    userId: "review_author_1",
    spotifyId: "album_1",
    title: "Kind of Blue",
    artist: "Miles Davis",
    cover: "https://example.com/kind-of-blue.jpg",
    rating: 5,
    reviewText: "Public review.",
    date: new Date("2026-06-10T10:00:00.000Z"),
  };
  const pinnedBoard = {
    _id: "public_board",
    userId: "review_author_1",
    title: "Start Here",
    isDefault: false,
  };
  profilesByUserId.set("review_author_1", {
    userId: "review_author_1",
    bio: "A public listener.",
    spotifyProfileUrl: "",
    favoriteAlbums: [],
    listeningNextAlbum: {
      spotifyId: "album_2",
      albumCatalogId: {
        spotifyId: "album_2",
        title: "Blue Train",
        artist: "John Coltrane",
        artists: ["John Coltrane"],
        year: "1958",
        cover: "https://example.com/album_2.jpg",
      },
    },
    pinnedReviewId: pinnedReview,
    pinnedBoardId: pinnedBoard,
  });
  boardItemDocuments = [
    {
      _id: "public_board_item",
      userId: "review_author_1",
      boardId: "public_board",
      spotifyId: "album_2",
      savedAt: new Date("2026-06-12T10:00:00.000Z"),
      albumCatalogId: {
        _id: "catalog_album_2",
        spotifyId: "album_2",
        title: "Blue Train",
        artist: "John Coltrane",
        cover: "https://example.com/blue-train.jpg",
      },
    },
  ];

  const response = await callRoute("get", "/:userId", {
    params: { userId: "review_author_1" },
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.listeningNextAlbum.spotifyId, "album_2");
  assert.equal(response.body.pinnedReview._id, "public_review");
  assert.equal(response.body.pinnedBoard._id, "public_board");
  assert.equal(response.body.pinnedBoard.previewAlbums[0].spotifyId, "album_2");
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
