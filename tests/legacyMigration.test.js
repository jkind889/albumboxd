const test = require("node:test");
const assert = require("node:assert/strict");
const { ObjectId } = require("mongodb");
const {
  LegacyMigrationError,
  canonicalHash,
  databaseNameFromUri,
  parseArguments,
  requiredEnvironment,
} = require("../lib/legacyMigration/runtime");
const { buildCatalogCrosswalk } = require("../lib/legacyMigration/catalogCrosswalk");
const { transformSocial } = require("../lib/legacyMigration/transform");
const { buildMigrationPlan, verifyPlanHash } = require("../lib/legacyMigration/plan");
const { forbiddenFields, validateDocuments } = require("../lib/legacyMigration/validate");
const mb = require("../lib/legacyMigration/musicBrainz");

const ids = {
  group: "11111111-1111-4111-8111-111111111111",
  release: "22222222-2222-4222-8222-222222222222",
  releaseTwo: "44444444-4444-4444-8444-444444444444",
  artist: "33333333-3333-4333-8333-333333333333",
};

function fixture() {
  const now = new Date("2026-08-23T00:00:00.000Z");
  const catalogId = new ObjectId();
  const boardId = new ObjectId();
  const reviewId = new ObjectId();
  const source = {
    albumcatalogs: [{ _id: catalogId, spotifyId: "legacy-provider-key", title: "Legacy", artist: "Artist", musicBrainzReleaseGroupId: ids.group, musicBrainzReleaseIds: [ids.release], musicBrainzMappingStatus: "resolved", createdAt: now }],
    albums: [],
    boarditems: [],
    boards: [{ _id: boardId, userId: "user_1", title: "Saved", isDefault: true, createdAt: now, updatedAt: now }],
    reviews: [{ _id: reviewId, userId: "user_1", spotifyId: "legacy-provider-key", reviewText: "Good", rating: 4, date: now }],
    likes: [{ _id: new ObjectId(), userId: "user_1", targetType: "review", reviewId, spotifyId: "legacy-provider-key", createdAt: now, updatedAt: now }],
    notifications: [{ _id: new ObjectId(), recipientUserId: "user_1", actorUserId: "user_2", type: "review_like", reviewId, spotifyId: "legacy-provider-key", readAt: null, createdAt: now, updatedAt: now }],
    userprofiles: [{ _id: new ObjectId(), userId: "user_1", bio: "", spotifyProfileUrl: "https://open.spotify.com/user/user_1", isPrivate: false, favoriteAlbums: [], listeningNextAlbum: null, pinnedReviewId: null, pinnedBoardId: boardId, createdAt: now, updatedAt: now }],
    follows: [{ _id: new ObjectId(), followerId: "user_1", followingId: "user_2", createdAt: now, updatedAt: now }],
  };
  const target = { albumcatalogs: [], reviews: [], likes: [], boards: [], boarditems: [], notifications: [], userprofiles: [], follows: [], albumsubmissions: [] };
  const group = { id: ids.group, title: "Fresh Album", "artist-credit": [{ name: "Artist", joinphrase: "", artist: { id: ids.artist, name: "Artist" } }], "primary-type": "Album", "secondary-types": [], "first-release-date": "2020-01-01" };
  const release = { id: ids.release, "release-group": { id: ids.group }, date: "2020-01-01", "label-info": [{ label: { name: "Label" } }], media: [{ position: 1, tracks: [{ position: 1, title: "Track", length: 1000, "artist-credit": [{ name: "Artist", joinphrase: "", artist: { id: ids.artist, name: "Artist" } }] }] }] };
  const client = {
    hydrateReleaseGroup: async () => ({ ...mb.groupMetadata(group, now.toISOString()), raw: group }),
    hydrateRelease: async () => ({ ...mb.releaseMetadata(release, ids.group, now.toISOString()), raw: release }),
  };
  return { source, target, client };
}

test("migration argument and namespace guards require explicit safe databases", () => {
  assert.equal(parseArguments(["--inventory", "--run-dir", ".migration/run"]).mode, "inventory");
  assert.throws(() => parseArguments(["--apply", "--run-dir", "x"]), (error) => error.code === "INVALID_ARGUMENTS");
  assert.throws(() => databaseNameFromUri("mongodb://localhost:27017/test"), (error) => error.code === "SOURCE_NAMESPACE_INVALID");
  assert.deepEqual(requiredEnvironment({ LEGACY_MONGO_URI: "mongodb://localhost/source", MIGRATION_TARGET_MONGO_URI: "mongodb://localhost/candidate" }).source, "source");
  assert.throws(() => requiredEnvironment({ LEGACY_MONGO_URI: "mongodb://localhost/source", MIGRATION_TARGET_MONGO_URI: "mongodb://localhost/source" }), (error) => error.code === "SOURCE_TARGET_COLLISION");
});

test("canonical hashes are stable and plan checksums detect tampering", () => {
  const first = canonicalHash({ b: 2, a: 1 });
  assert.equal(first, canonicalHash({ a: 1, b: 2 }));
  assert.notEqual(canonicalHash({ at: new Date("2026-01-01T00:00:00.000Z") }), canonicalHash({ at: new Date("2026-01-02T00:00:00.000Z") }));
  const plan = { planSha256: "", operations: [] };
  plan.planSha256 = canonicalHash({ ...plan, planSha256: undefined });
  assert.equal(verifyPlanHash(plan, plan.planSha256), true);
  plan.operations.push({ collection: "reviews" });
  assert.throws(() => verifyPlanHash(plan, plan.planSha256), (error) => error.code === "PLAN_CHECKSUM_MISMATCH");
});

test("catalog hydration creates provider-neutral documents and social transforms", async () => {
  const { source, target, client } = fixture();
  const catalog = await buildCatalogCrosswalk({ sourceDocuments: source, targetRows: target.albumcatalogs, client, overrides: { albums: [] } });
  assert.equal(catalog.counts.created, 1);
  assert.equal(catalog.results[0].document.title, "Fresh Album");
  assert.equal(catalog.results[0].document.tracks[0].title, "Track");
  assert.equal(forbiddenFields(catalog.results[0].document, "", "albumcatalogs").length, 0);

  const social = transformSocial({ source, target, catalogResults: catalog.results });
  assert.equal(social.documents.reviews.length, 1);
  assert.equal(social.documents.likes.length, 1);
  assert.equal(social.documents.notifications.length, 1);
  assert.equal(social.documents.follows.length, 1);
  assert.equal(forbiddenFields(social.documents.reviews[0], "", "reviews").length, 0);
  assert.equal(forbiddenFields(social.documents.userprofiles[0], "", "userprofiles").length, 0);
  const issues = await validateDocuments({ albumcatalogs: [catalog.results[0].document], ...social.documents });
  assert.deepEqual(issues, []);
});

test("orphan review interactions are archived and not converted into active targets", async () => {
  const { source, target, client } = fixture();
  source.likes.push({ _id: new ObjectId(), userId: "user_1", targetType: "review", reviewId: new ObjectId(), spotifyId: "legacy-provider-key" });
  source.notifications.push({ _id: new ObjectId(), recipientUserId: "user_1", actorUserId: "user_2", type: "review_like", reviewId: new ObjectId(), spotifyId: "legacy-provider-key" });
  const catalog = await buildCatalogCrosswalk({ sourceDocuments: source, targetRows: target.albumcatalogs, client, overrides: { albums: [] } });
  const social = transformSocial({ source, target, catalogResults: catalog.results });
  assert.equal(social.issues.filter((issue) => issue.action === "archive").length, 2);
  assert.equal(social.documents.likes.length, 1);
  assert.equal(social.documents.notifications.length, 1);
});

test("duplicate release-group editions quarantine conflicting tracklists", async () => {
  const { source, target, client } = fixture();
  const secondRelease = {
    id: ids.releaseTwo,
    "release-group": { id: ids.group },
    date: "2020-01-01",
    "label-info": [{ label: { name: "Label" } }],
    media: [{ position: 1, tracks: [
      { position: 1, title: "Track 1", length: 1000 },
      { position: 2, title: "Track 2", length: 1000 },
    ] }],
  };
  source.albumcatalogs.push({ _id: new ObjectId(), spotifyId: "second-provider-key", title: "Legacy", artist: "Artist", musicBrainzReleaseGroupId: ids.group, musicBrainzReleaseIds: [ids.releaseTwo], createdAt: new Date("2026-08-23T00:00:00.000Z") });
  const originalHydrateRelease = client.hydrateRelease;
  client.hydrateRelease = async (mbid, expectedGroup) => {
    if (mbid === ids.releaseTwo) return { ...mb.releaseMetadata(secondRelease, expectedGroup, new Date().toISOString()), raw: secondRelease };
    return originalHydrateRelease(mbid, expectedGroup);
  };
  const catalog = await buildCatalogCrosswalk({ sourceDocuments: source, targetRows: target.albumcatalogs, client, overrides: { albums: [] } });
  assert.equal(catalog.counts.created, 1);
  assert.equal(catalog.counts.reused, 1);
  assert.equal(catalog.results[0].document._id.toHexString(), catalog.results[1].document._id.toHexString());
  assert.equal(catalog.results[0].document.tracks.length, 0);
  assert.equal(catalog.results[1].document.tracks.length, 0);
  assert.equal(catalog.results[1].issue, "AMBIGUOUS_EDITION");
});

test("migration plan is model-valid, batched, and recheckable", async () => {
  const { source, target, client } = fixture();
  const catalog = await buildCatalogCrosswalk({ sourceDocuments: source, targetRows: target.albumcatalogs, client, overrides: { albums: [] } });
  const social = transformSocial({ source, target, catalogResults: catalog.results });
  const plan = await buildMigrationPlan({ inventory: { source: { databaseName: "source", databaseHash: "source-hash" }, target: { databaseName: "candidate", databaseHash: "target-hash" } }, sourceDocuments: source, targetDocuments: target, catalogResults: catalog.results, social, runId: "test-run" });
  assert.ok(plan.operations.length > 0);
  assert.equal(plan.batches.length, 1);
  assert.equal(plan.counts.catalogCreated, 1);
  assert.equal(verifyPlanHash(plan, plan.planSha256), true);
});

test("MusicBrainz endpoint cache keys separate endpoints", () => {
  assert.notEqual(mb.endpointKey("https://musicbrainz.org/ws/2/release-group/one"), mb.endpointKey("https://musicbrainz.org/ws/2/release/two"));
});
