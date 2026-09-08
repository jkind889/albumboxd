const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const AlbumCatalog = require("../models/AlbumCatalog");
const { runBackfill } = require("../scripts/backfillMissingAlbumCovers");

const BARCODE = "012345678905";
const GROUP_MBID = "11111111-1111-4111-8111-111111111111";
const RELEASE_MBID = "22222222-2222-4222-8222-222222222222";
const enabled = String(process.env.RUN_MONGO_INTEGRATION || "").toLowerCase() === "true";

let replSet;

function response(data, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[String(name).toLowerCase()] || null },
    async json() { return data; },
  };
}

async function setup() {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replSet.getUri(), { dbName: "rescened_cover_backfill" });
  await AlbumCatalog.syncIndexes();
}

async function teardown() {
  if (mongoose.connection.readyState === 1) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
  if (replSet) await replSet.stop();
}

async function mockedProviderBackfillTest() {
  const target = await AlbumCatalog.create({
    albumId: crypto.randomUUID(),
    title: "Exact Barcode Album",
    artistDisplayName: "Exact Artist",
    artistCredits: [{ name: "Exact Artist", role: "main" }],
    releaseType: "album",
    releaseDate: "2026",
    cover: "",
    externalReferences: [{ provider: "barcode", entityType: "release", externalId: BARCODE }],
    catalogSource: "import",
  });
  const manual = await AlbumCatalog.create({
    albumId: crypto.randomUUID(),
    title: "Manual Cover Album",
    artistDisplayName: "Manual Artist",
    artistCredits: [{ name: "Manual Artist", role: "main" }],
    cover: "https://images.example.test/manual.jpg",
    catalogSource: "manual",
  });
  const calls = [];
  const dependencies = {
    AlbumCatalog,
    clock: () => new Date("2026-08-26T12:00:00.000Z"),
    sleepFn: async () => {},
    userAgent: "RescenedCoverBackfillIntegration/1.0 (integration@example.invalid)",
    fetchFn: async (url, options) => {
      calls.push({ url, method: options.method, headers: options.headers });
      if (options.method === "GET" && url.startsWith("https://musicbrainz.org/ws/2/release?")) {
        return response({
          count: 1,
          releases: [{
            id: RELEASE_MBID,
            barcode: BARCODE,
            title: "Exact Barcode Album",
            "release-group": { id: GROUP_MBID },
            "artist-credit": [{ name: "Exact Artist" }],
          }],
        });
      }
      if (options.method === "GET" && url === `https://coverartarchive.org/release-group/${GROUP_MBID}`) {
        return response({
          release: `https://musicbrainz.org/release/${RELEASE_MBID}`,
          images: [{
            approved: true,
            front: true,
            id: "98765",
            thumbnails: { "500": `https://coverartarchive.org/release/${RELEASE_MBID}/98765-500.jpg` },
          }],
        });
      }
      if (options.method === "HEAD" && url === `https://coverartarchive.org/release/${RELEASE_MBID}/front-500`) {
        return response(null, 200, { "content-type": "image/jpeg" });
      }
      throw new Error(`Unexpected provider request: ${options.method} ${url}`);
    },
  };

  const first = await runBackfill({ apply: true }, dependencies);
  assert.equal(first.counts.scanned, 1);
  assert.equal(first.counts.updated, 1);
  assert.equal(first.counts.unresolved, 0);
  const persisted = await AlbumCatalog.findById(target._id).lean();
  assert.equal(persisted.cover, `https://coverartarchive.org/release/${RELEASE_MBID}/front-500`);
  assert.equal(persisted.fieldProvenance.cover.source, "cover-art-archive");
  assert.equal(persisted.fieldProvenance.cover.releaseMbid, RELEASE_MBID);
  assert.equal(persisted.externalReferences.some((reference) => reference.externalId === RELEASE_MBID), true);
  assert.equal((await AlbumCatalog.findById(manual._id).lean()).cover, "https://images.example.test/manual.jpg");
  assert.equal(calls.length, 3);
  assert.equal(calls[0].headers["User-Agent"], dependencies.userAgent);

  const second = await runBackfill({ apply: true }, dependencies);
  assert.equal(second.counts.scanned, 0);
  assert.equal(second.counts.updated, 0);
  assert.equal(calls.length, 3);
}

if (enabled) {
  test.before(setup);
  test.after(teardown);
  test("backfill resolves a stored barcode, preserves manual covers, and reruns as a no-op", mockedProviderBackfillTest);
} else {
  test("backfill resolves a stored barcode, preserves manual covers, and reruns as a no-op", {
    skip: "Set RUN_MONGO_INTEGRATION=true in an environment that permits local Mongo processes",
  }, () => {});
}
