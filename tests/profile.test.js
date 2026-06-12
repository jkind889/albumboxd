const assert = require("node:assert/strict");
const test = require("node:test");

const profileModelPath = require.resolve("../models/UserProfile");
const albumCatalogHelperPath = require.resolve("../routes/utils/albumCatalog");
const clerkPath = require.resolve("@clerk/express");
const profileRoutePath = require.resolve("../routes/profile");

let authUserId = "user_clerk_123";
let foundProfile = null;
let createdProfile = null;
let updatedProfile = null;
let getOrCreateError = null;
const findOneCalls = [];
const createCalls = [];
const updateCalls = [];
const getOrCreateCalls = [];

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
        return chainResult(foundProfile);
      },
      create: async (profile) => {
        createCalls.push(profile);
        return createdProfile || profile;
      },
      findOneAndUpdate: (query, update, options) => {
        updateCalls.push({ query, update, options });
        return chainResult(updatedProfile);
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

async function callRoute(method, path, { body = {} } = {}) {
  const router = loadProfileRouter();
  const route = router.stack.find(
    (layer) => layer.route?.path === path && layer.route.methods[method],
  );

  assert.ok(route, `${method.toUpperCase()} ${path} should be registered`);

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
  foundProfile = null;
  createdProfile = null;
  updatedProfile = null;
  getOrCreateError = null;
  findOneCalls.length = 0;
  createCalls.length = 0;
  updateCalls.length = 0;
  getOrCreateCalls.length = 0;
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
    bio: "",
    favoriteAlbums: [],
  });
});

test("GET /profile/me returns populated favorite albums in rank order", async () => {
  foundProfile = {
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
  };

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
