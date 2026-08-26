const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { ObjectId } = require("mongodb");
const { MongoMemoryReplSet } = require("mongodb-memory-server");
const { canonicalHash } = require("../lib/legacyMigration/runtime");
const { applyPlan } = require("../lib/legacyMigration/apply");
const { sealJson } = require("../lib/legacyMigration/artifacts");
const { inventoryDatabase } = require("../lib/legacyMigration/inventory");
const { verifyPlanApplied } = require("../lib/legacyMigration/verify");
const { runExecute } = require("../scripts/migrateLegacyDatabase");

const enabled = process.env.RUN_MONGO_INTEGRATION === "true";

test("legacy migration apply and verify commit a sealed plan atomically", { skip: !enabled }, async (context) => {
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
    const targetInventory = await inventoryDatabase(targetDb, []);
    const plan = {
      schemaVersion: "1.0.0",
      runId: "integration-run",
      generatedAt: new Date().toISOString(),
      source: { database: "rescened_legacy_source_test", fingerprint: "source" },
      target: { database: targetDb.databaseName, fingerprint: targetInventory.databaseHash },
      outcome: { catalog: [], socialIssues: [] },
      operations: [{ collection: "albumcatalogs", stage: "catalog", action: "insert", targetId: document._id, beforeHash: null, afterHash: canonicalHash(document), document, batchId: "batch-0000" }],
      batches: [{ id: "batch-0000", operationCount: 1 }],
      counts: { operations: 1, batches: 1 },
      validation: { fingerprint: "validation" },
    };
    plan.planSha256 = canonicalHash({ ...plan, planSha256: undefined });

    await targetDb.collection("driftmarkers").insertOne({ changedAfterPlanning: true });
    await assert.rejects(
      applyPlan({ targetDb, client, plan, expectedPlanSha256: plan.planSha256, confirmTarget: targetDb.databaseName }),
      (error) => error.code === "TARGET_BASELINE_MISMATCH",
    );
    assert.equal(await targetDb.collection("migrationruns").countDocuments(), 0);
    await targetDb.collection("driftmarkers").drop();

    const wrongTargetPlan = {
      ...plan,
      target: { ...plan.target, database: "another_candidate" },
    };
    wrongTargetPlan.planSha256 = canonicalHash({ ...wrongTargetPlan, planSha256: undefined });
    await assert.rejects(
      applyPlan({
        targetDb,
        client,
        plan: wrongTargetPlan,
        expectedPlanSha256: wrongTargetPlan.planSha256,
        confirmTarget: targetDb.databaseName,
      }),
      (error) => error.code === "TARGET_CONFIRMATION_FAILED",
    );
    assert.equal(await targetDb.collection("migrationruns").countDocuments(), 0);

    const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "rescened-legacy-execute-"));
    context.after(() => fs.rm(runDir, { recursive: true, force: true }));
    await sealJson(runDir, "plan.json", plan);
    const executionOptions = {
      runDir,
      planSha256: plan.planSha256,
      confirmTarget: targetDb.databaseName,
    };
    const executionEnv = {
      target: targetDb.databaseName,
      targetUri: replSet.getUri(targetDb.databaseName),
    };
    const applied = await runExecute(executionOptions, executionEnv);
    assert.equal(applied.apply.applied, true);
    assert.equal(applied.verification.verified, true);
    assert.equal((await fs.stat(applied.reports.apply)).isFile(), true);
    assert.equal((await fs.stat(applied.reports.verify)).isFile(), true);
    const verified = await verifyPlanApplied({ targetDb, plan, expectedPlanSha256: plan.planSha256 });
    assert.equal(verified.verified, true);
    const rerun = await runExecute(executionOptions, executionEnv);
    assert.equal(rerun.apply.noop, true);
    assert.equal(rerun.verification.verified, true);
    assert.notEqual(rerun.reports.apply, applied.reports.apply);
    assert.notEqual(rerun.reports.verify, applied.reports.verify);

    await targetDb.collection("albumcatalogs").updateOne(
      { _id: document._id },
      { $set: { title: "Unexpected edit after completion" } },
    );
    await assert.rejects(
      applyPlan({ targetDb, client, plan, expectedPlanSha256: plan.planSha256, confirmTarget: targetDb.databaseName }),
      (error) => error.code === "BATCH_PRECONDITION_FAILED",
    );
  } finally {
    await client.close();
    await replSet.stop();
  }
});

test("legacy migration resumes only when completed and remaining batches match the ledger", { skip: !enabled }, async () => {
  const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  const client = new (require("mongodb").MongoClient)(replSet.getUri(), { retryWrites: true });
  await client.connect();
  try {
    const targetDb = client.db("rescened_legacy_candidate_resume");
    const makeDocument = (number) => ({
      _id: new ObjectId(),
      albumId: `${String(number).padStart(8, "0")}-1111-4111-8111-111111111111`,
      title: `Resume Album ${number}`,
      artistDisplayName: "Resume Artist",
      artistCredits: [{ name: "Resume Artist", role: "main" }],
      releaseType: "album",
      releaseDate: "2020",
      releaseDatePrecision: "year",
      releaseYear: 2020,
      tracks: [],
      label: "",
      cover: "",
      externalReferences: [{
        provider: "musicbrainz",
        entityType: "release-group",
        externalId: `${String(number).padStart(8, "0")}-2222-4222-8222-222222222222`,
        url: "",
      }],
      fieldProvenance: { title: { source: "musicbrainz", license: "CC0" } },
      catalogSource: "import",
      createdAt: new Date("2026-08-25T12:00:00.000Z"),
      updatedAt: new Date("2026-08-25T12:00:00.000Z"),
    });
    const first = makeDocument(1);
    const secondBefore = makeDocument(2);
    const second = {
      ...secondBefore,
      title: "Resume Album 2 Updated",
      updatedAt: new Date("2026-08-25T12:05:00.000Z"),
    };
    const operations = [
      {
        collection: "albumcatalogs",
        stage: "catalog",
        action: "insert",
        targetId: first._id,
        beforeHash: null,
        afterHash: canonicalHash(first),
        document: first,
        batchId: "batch-0000",
      },
      {
        collection: "albumcatalogs",
        stage: "catalog",
        action: "update",
        targetId: second._id,
        beforeHash: canonicalHash(secondBefore),
        afterHash: canonicalHash(second),
        document: second,
        batchId: "batch-0001",
      },
    ];
    const plan = {
      schemaVersion: "1.0.0",
      runId: "resume-run",
      generatedAt: new Date().toISOString(),
      source: { database: "rescened_legacy_source_resume", fingerprint: "source" },
      // Resumes prove per-operation state instead of comparing the intentionally
      // changed database with its original baseline fingerprint.
      target: { database: targetDb.databaseName, fingerprint: "original-baseline" },
      outcome: { catalog: [], socialIssues: [] },
      operations,
      batches: operations.map((operation) => ({ id: operation.batchId, operationCount: 1 })),
      counts: { operations: 2, batches: 2 },
      validation: { fingerprint: "validation" },
    };
    plan.planSha256 = canonicalHash({ ...plan, planSha256: undefined });

    await targetDb.collection("albumcatalogs").insertMany([first, secondBefore]);
    await targetDb.collection("migrationruns").insertOne({
      _id: plan.runId,
      planSha256: plan.planSha256,
      targetDatabase: targetDb.databaseName,
      status: "running",
      leaseUntil: null,
      completedBatches: ["batch-0000"],
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const resumed = await applyPlan({
      targetDb,
      client,
      plan,
      expectedPlanSha256: plan.planSha256,
      confirmTarget: targetDb.databaseName,
    });
    assert.equal(resumed.applied, true);
    assert.equal(await targetDb.collection("albumcatalogs").countDocuments(), 2);
    assert.equal((await targetDb.collection("albumcatalogs").findOne({ _id: second._id })).title, second.title);
    const ledger = await targetDb.collection("migrationruns").findOne({ _id: plan.runId });
    assert.equal(ledger.status, "completed");
    assert.deepEqual(new Set(ledger.completedBatches), new Set(["batch-0000", "batch-0001"]));
  } finally {
    await client.close();
    await replSet.stop();
  }
});
