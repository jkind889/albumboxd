const test = require("node:test");
const assert = require("node:assert/strict");
const { ObjectId } = require("mongodb");
const { MongoMemoryReplSet } = require("mongodb-memory-server");
const { canonicalHash } = require("../lib/legacyMigration/runtime");
const { applyPlan } = require("../lib/legacyMigration/apply");
const { verifyPlanApplied } = require("../lib/legacyMigration/verify");

const enabled = process.env.RUN_MONGO_INTEGRATION === "true";

test("legacy migration apply and verify commit a sealed plan atomically", { skip: !enabled }, async () => {
  const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  const client = new (require("mongodb").MongoClient)(replSet.getUri(), { retryWrites: true });
  await client.connect();
  try {
    const targetDb = client.db("rescened_legacy_candidate_test");
    const document = {
      _id: new ObjectId(),
      albumId: "11111111-1111-4111-8111-111111111111",
      title: "Integration Album",
      artistDisplayName: "Integration Artist",
      artistCredits: [{ name: "Integration Artist", role: "main" }],
      releaseType: "album",
      releaseDate: "2020",
      releaseDatePrecision: "year",
      releaseYear: 2020,
      tracks: [],
      label: "",
      cover: "",
      externalReferences: [{ provider: "musicbrainz", entityType: "release-group", externalId: "22222222-2222-4222-8222-222222222222", url: "https://musicbrainz.org/release-group/22222222-2222-4222-8222-222222222222" }],
      fieldProvenance: { title: { source: "musicbrainz", license: "CC0" } },
      catalogSource: "import",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const plan = {
      schemaVersion: "1.0.0",
      runId: "integration-run",
      generatedAt: new Date().toISOString(),
      source: { database: "rescened_legacy_source_test", fingerprint: "source" },
      target: { database: targetDb.databaseName, fingerprint: "target" },
      outcome: { catalog: [], socialIssues: [] },
      operations: [{ collection: "albumcatalogs", stage: "catalog", action: "insert", targetId: document._id, beforeHash: null, afterHash: canonicalHash(document), document, batchId: "batch-0000" }],
      batches: [{ id: "batch-0000", operationCount: 1 }],
      counts: { operations: 1, batches: 1 },
      validation: { fingerprint: "validation" },
    };
    plan.planSha256 = canonicalHash({ ...plan, planSha256: undefined });
    const applied = await applyPlan({ targetDb, client, plan, expectedPlanSha256: plan.planSha256, confirmTarget: targetDb.databaseName });
    assert.equal(applied.applied, true);
    const verified = await verifyPlanApplied({ targetDb, plan, expectedPlanSha256: plan.planSha256 });
    assert.equal(verified.verified, true);
    const rerun = await applyPlan({ targetDb, client, plan, expectedPlanSha256: plan.planSha256, confirmTarget: targetDb.databaseName });
    assert.equal(rerun.noop, true);
  } finally {
    await client.close();
    await replSet.stop();
  }
});
