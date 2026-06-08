const assert = require("node:assert/strict");
const test = require("node:test");

const albumModelPath = require.resolve("../models/Albums");
const clerkPath = require.resolve("@clerk/express");
const albumRoutePath = require.resolve("../routes/album");

let authUserId = null;
let createdAlbum = null;
const createCalls = [];

function loadAlbumRouter() {
  delete require.cache[albumRoutePath];

  require.cache[albumModelPath] = {
    id: albumModelPath,
    filename: albumModelPath,
    loaded: true,
    exports: {
      create: async (album) => {
        createCalls.push(album);
        if (createdAlbum instanceof Error) {
          throw createdAlbum;
        }
        return createdAlbum || { _id: "album_123", ...album };
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

  return require("../routes/album");
}

async function postAlbum(body) {
  const router = loadAlbumRouter();
  const route = router.stack.find(
    (layer) => layer.route?.path === "/album" && layer.route.methods.post,
  );

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
  createdAlbum = null;
  createCalls.length = 0;
});

test("POST /albums/album saves an album with the authenticated Clerk user id", async () => {
  const payload = {
    userId: "frontend_user_should_not_win",
    spotifyId: "spotify_album_123",
    title: "Kind of Blue",
    artist: "Miles Davis",
    cover: "https://example.com/kind-of-blue.jpg",
  };

  const response = await postAlbum(payload);

  assert.equal(response.status, 201);
  assert.equal(createCalls.length, 1);
  assert.deepEqual(createCalls[0], {
    ...payload,
    userId: "user_clerk_123",
  });
  assert.equal(response.body.userId, "user_clerk_123");
  assert.equal(response.body.spotifyId, payload.spotifyId);
});

test("POST /albums/album returns 401 and does not save when Clerk has no user", async () => {
  authUserId = null;

  const response = await postAlbum({
    spotifyId: "spotify_album_123",
    title: "Kind of Blue",
    artist: "Miles Davis",
  });

  assert.equal(response.status, 401);
  assert.deepEqual(response.body, { error: "Unauthorized" });
  assert.equal(createCalls.length, 0);
});

test("POST /albums/album returns 500 when the album cannot be saved", async (t) => {
  t.mock.method(console, "log", () => {});
  createdAlbum = new Error("database unavailable");

  const response = await postAlbum({
    spotifyId: "spotify_album_123",
    title: "Kind of Blue",
    artist: "Miles Davis",
  });

  assert.equal(response.status, 500);
  assert.deepEqual(response.body, { error: "Failed to create album" });
});
