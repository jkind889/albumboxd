const assert = require("node:assert/strict");
const test = require("node:test");

const AlbumCatalog = require("../models/AlbumCatalog");
const searchRouter = require("../routes/search");
const albumRouter = require("../routes/album");

const ORIGINAL_COUNT_DOCUMENTS = AlbumCatalog.countDocuments;
const ORIGINAL_FIND = AlbumCatalog.find;
const ALBUM_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const ENDPOINTS = [
  { name: "/search/search", router: searchRouter, path: "/search", extract: (body) => body },
  { name: "/albums/catalog", router: albumRouter, path: "/catalog", extract: (body) => body.results },
];

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

async function callRoute(router, method, path, req = {}) {
  const route = router.stack.find((layer) => layer.route?.path === path && layer.route.methods[method]);
  assert.ok(route, `${method.toUpperCase()} ${path} should be registered`);
  const res = response();
  for (const handler of route.route.stack.map((layer) => layer.handle)) {
    let nextCalled = false;
    await handler(req, res, () => { nextCalled = true; });
    if (!nextCalled) break;
  }
  return { status: res.statusCode, body: res.body };
}

function fieldValues(album, field) {
  if (field === "artistCredits.name") return album.artistCredits.map((credit) => credit.name);
  return [album[field]];
}

function matchingAlbums(query, albums) {
  return albums.filter((album) => query.$or.some((clause) => {
    const [field, condition] = Object.entries(clause)[0];
    const regex = new RegExp(condition.$regex, condition.$options);
    return fieldValues(album, field).some((value) => regex.test(String(value || "")));
  }));
}

function installCatalogMock(albums) {
  AlbumCatalog.countDocuments = async (query) => matchingAlbums(query, albums).length;
  AlbumCatalog.find = (query) => {
    let rows = matchingAlbums(query, albums);
    return {
      sort() { return this; },
      skip(value) { rows = rows.slice(value); return this; },
      limit(value) { return Promise.resolve(rows.slice(0, value)); },
    };
  };
}

function albumWithArtist(artistDisplayName) {
  return {
    albumId: ALBUM_ID,
    title: "Appetite for Destruction",
    artistDisplayName,
    artistCredits: [{ name: artistDisplayName, role: "main" }],
    releaseType: "album",
    releaseDate: "1987",
    releaseDatePrecision: "year",
    releaseYear: 1987,
    cover: "",
    tracks: [],
    label: "",
  };
}

test.afterEach(() => {
  AlbumCatalog.countDocuments = ORIGINAL_COUNT_DOCUMENTS;
  AlbumCatalog.find = ORIGINAL_FIND;
});

test("ASCII apostrophe queries match typographic apostrophes on both catalog endpoints", async () => {
  installCatalogMock([albumWithArtist("Guns N’ Roses")]);

  for (const endpoint of ENDPOINTS) {
    const result = await callRoute(endpoint.router, "get", endpoint.path, {
      query: { q: "Guns N' Roses" },
    });

    assert.equal(result.status, 200, endpoint.name);
    assert.deepEqual(endpoint.extract(result.body).map((album) => album.albumId), [ALBUM_ID], endpoint.name);
  }
});

test("typographic apostrophe queries match ASCII apostrophes on both catalog endpoints", async () => {
  installCatalogMock([albumWithArtist("Guns N' Roses")]);

  for (const endpoint of ENDPOINTS) {
    const result = await callRoute(endpoint.router, "get", endpoint.path, {
      query: { q: "Guns N’ Roses" },
    });

    assert.equal(result.status, 200, endpoint.name);
    assert.deepEqual(endpoint.extract(result.body).map((album) => album.albumId), [ALBUM_ID], endpoint.name);
  }
});
