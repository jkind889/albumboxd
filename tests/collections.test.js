const assert = require("node:assert/strict");
const test = require("node:test");

const albumModelPath = require.resolve("../models/Albums");
const clerkPath = require.resolve("@clerk/express");
const collectionRoutePath = require.resolve("../routes/collections");

let authUserId = "user_clerk_123";
let foundAlbums = [];
let foundAlbum = null;
const findCalls = [];
const findOneCalls = [];
const deleteCalls = [];

function loadCollectionRouter() {
  delete require.cache[collectionRoutePath];

  require.cache[albumModelPath] = {
    id: albumModelPath,
    filename: albumModelPath,
    loaded: true,
    exports: {
      find: async (query) => {
        findCalls.push(query);
        return foundAlbums;
      },
      findOne: async (query) => {
        findOneCalls.push(query);
        return foundAlbum;
      },
      findOneAndDelete: async (query) => {
        deleteCalls.push(query);
        return { _id: "album_123", ...query };
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

  return require("../routes/collections");
}

async function callRoute(method, path, params = {}) {
  const router = loadCollectionRouter();
  const route = router.stack.find(
    (layer) => layer.route?.path === path && layer.route.methods[method],
  );

  assert.ok(route, `${method.toUpperCase()} ${path} should be registered`);

  const req = { params };
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
  foundAlbums = [];
  foundAlbum = null;
  findCalls.length = 0;
  findOneCalls.length = 0;
  deleteCalls.length = 0;
});

test("GET /collections/collection lists albums for the authenticated user", async () => {
  foundAlbums = [{ spotifyId: "spotify_album_123", title: "Kind of Blue" }];

  const response = await callRoute("get", "/collection");

  assert.equal(response.status, 200);
  assert.deepEqual(findCalls, [{ userId: "user_clerk_123" }]);
  assert.deepEqual(response.body, foundAlbums);
});

test("GET /collections/collection/:spotifyId checks saved state for the authenticated user", async () => {
  foundAlbum = { spotifyId: "spotify_album_123", title: "Kind of Blue" };

  const response = await callRoute("get", "/collection/:spotifyId", {
    spotifyId: "spotify_album_123",
  });

  assert.equal(response.status, 200);
  assert.deepEqual(findOneCalls, [
    { spotifyId: "spotify_album_123", userId: "user_clerk_123" },
  ]);
  assert.deepEqual(response.body, {
    saved: true,
    album: foundAlbum,
  });
});

test("DELETE /collections/collection/album/:id removes an album for the authenticated user", async () => {
  const response = await callRoute("delete", "/collection/album/:id", {
    id: "spotify_album_123",
  });

  assert.equal(response.status, 200);
  assert.deepEqual(deleteCalls, [
    { spotifyId: "spotify_album_123", userId: "user_clerk_123" },
  ]);
  assert.deepEqual(response.body, { message: "Album removed from collection" });
});
