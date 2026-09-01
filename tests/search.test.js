const assert = require("node:assert/strict");
const test = require("node:test");

const adapterPath = require.resolve("../lib/musicBrainzSearch");
const rateLimitPath = require.resolve("../routes/utils/rateLimit");
const searchPath = require.resolve("../routes/search");
const AlbumCatalog = require("../models/AlbumCatalog");

const ORIGINAL_FIND = AlbumCatalog.find;

const GROUP = "11111111-1111-4111-8111-111111111111";
const GROUP_TWO = "22222222-2222-4222-8222-222222222222";

function candidate(externalId = GROUP, title = "Known Album") {
  return {
    kind: "external",
    provider: "musicbrainz",
    entityType: "release-group",
    externalId,
    title,
    artistDisplayName: "An Artist",
    artistCredits: [{ name: "An Artist", role: "main" }],
    releaseType: "album",
    releaseDate: "2024",
    releaseDatePrecision: "year",
    releaseYear: 2024,
    cover: `https://coverartarchive.org/release-group/${externalId}/front-250`,
    sourceUrl: `https://musicbrainz.org/release-group/${externalId}`,
  };
}

function response() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    set(name, value) { this.headers[name] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function callRoute(router, method, path, req = {}) {
  const route = router.stack.find((layer) => layer.route?.path === path && layer.route.methods[method]);
  assert.ok(route, `${method.toUpperCase()} ${path} should be registered`);
  const res = response();
  return (async () => {
    for (const handler of route.route.stack.map((layer) => layer.handle)) {
      let nextCalled = false;
      await handler(req, res, () => { nextCalled = true; });
      if (!nextCalled) break;
    }
    return { status: res.statusCode, body: res.body };
  })();
}

function query(rows) {
  return {
    lean() { return this; },
    exec() { return Promise.resolve(rows); },
  };
}

function install({ searchResults = [], draft = null, catalogs = [], searchError = null } = {}) {
  let searchCalls = 0;
  let draftCalls = 0;
  AlbumCatalog.find = () => query(catalogs);
  require.cache[rateLimitPath] = {
    id: rateLimitPath,
    filename: rateLimitPath,
    loaded: true,
    exports: { externalSearchRateLimit: (req, res, next) => next() },
  };
  require.cache[adapterPath] = {
    id: adapterPath,
    filename: adapterPath,
    loaded: true,
    exports: {
      MusicBrainzSearchError: class MusicBrainzSearchError extends Error {},
      normalizeLimit: (value) => value === undefined ? 12 : Math.min(Number(value), 12),
      normalizeSearchQuery: (value) => String(value || "").trim().replace(/\s+/gu, " ") || (() => { throw new Error("query required"); })(),
      searchReleaseGroups: async (queryValue, limit) => {
        searchCalls += 1;
        if (searchError) throw searchError;
        assert.equal(queryValue, "imaginal disk");
        assert.equal(limit, 12);
        return searchResults;
      },
      getSuggestionDraft: async () => {
        draftCalls += 1;
        return draft;
      },
    },
  };
  delete require.cache[searchPath];
  const router = require("../routes/search");
  return { router, get searchCalls() { return searchCalls; }, get draftCalls() { return draftCalls; } };
}

test.afterEach(() => {
  AlbumCatalog.find = ORIGINAL_FIND;
  delete require.cache[adapterPath];
  delete require.cache[rateLimitPath];
  delete require.cache[searchPath];
  delete process.env.EXTERNAL_ALBUM_SEARCH_ENABLED;
});

test("external search reconciles known MBIDs into normal catalog matches", async () => {
  process.env.EXTERNAL_ALBUM_SEARCH_ENABLED = "true";
  const known = {
    albumId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    title: "Known Album",
    artistDisplayName: "An Artist",
    artistCredits: [{ name: "An Artist", role: "main" }],
    releaseType: "album",
    releaseDate: "2024",
    releaseYear: 2024,
    externalReferences: [{ provider: "musicbrainz", entityType: "release-group", externalId: GROUP.toUpperCase() }],
  };
  const installed = install({ searchResults: [candidate(GROUP), candidate(GROUP_TWO, "New Album")], catalogs: [known] });

  const result = await callRoute(installed.router, "get", "/external", { query: { q: "  imaginal   disk  " } });

  assert.equal(result.status, 200);
  assert.equal(result.body.query, "imaginal disk");
  assert.deepEqual(result.body.catalogMatches.map((album) => album.albumId), [known.albumId]);
  assert.deepEqual(result.body.candidates.map((item) => item.externalId), [GROUP_TWO]);
  assert.equal(installed.searchCalls, 1);
});

test("external endpoints are optional and disabled by default", async () => {
  const installed = install({ searchResults: [candidate()] });

  const result = await callRoute(installed.router, "get", "/external", { query: { q: "imaginal disk" } });

  assert.equal(result.status, 503);
  assert.equal(result.body.code, "EXTERNAL_SEARCH_DISABLED");
  assert.equal(installed.searchCalls, 0);
});

test("invalid MBIDs are rejected before catalog or provider lookup", async () => {
  process.env.EXTERNAL_ALBUM_SEARCH_ENABLED = "true";
  const installed = install({ draft: {} });

  const result = await callRoute(installed.router, "get", "/musicbrainz/release-group/:mbid", { params: { mbid: "not-an-mbid" } });

  assert.equal(result.status, 400);
  assert.equal(result.body.code, "INVALID_EXTERNAL_SEARCH");
  assert.equal(installed.draftCalls, 0);
});

test("provider failures are isolated behind the external unavailable contract", async () => {
  process.env.EXTERNAL_ALBUM_SEARCH_ENABLED = "true";
  const installed = install({ searchError: new Error("provider down") });

  const result = await callRoute(installed.router, "get", "/external", { query: { q: "imaginal disk" } });

  assert.equal(result.status, 502);
  assert.equal(result.body.code, "EXTERNAL_SEARCH_UNAVAILABLE");
});

test("exact lookup returns the suggestion draft and never creates catalog data", async () => {
  process.env.EXTERNAL_ALBUM_SEARCH_ENABLED = "true";
  const draft = {
    proposedMetadata: { title: "New Album" },
    supportingSources: [{ type: "musicbrainz", url: "https://musicbrainz.org/release-group/22222222-2222-4222-8222-222222222222" }],
    externalReferences: [{ provider: "musicbrainz", entityType: "release-group", externalId: GROUP_TWO }],
  };
  const installed = install({ draft });
  const result = await callRoute(installed.router, "get", "/musicbrainz/release-group/:mbid", { params: { mbid: GROUP_TWO } });

  assert.equal(result.status, 200);
  assert.deepEqual(result.body, draft);
  assert.equal(installed.draftCalls, 1);
});
