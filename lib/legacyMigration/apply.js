const { canonicalHash, canonicalEjson, LegacyMigrationError } = require("./runtime");
const { inventoryDatabase } = require("./inventory");
const { MODELS } = require("./validate");
const { verifyPlanHash } = require("./plan");

const LEASE_MS = 5 * 60 * 1000;
const PUBLIC_ID_INDEXES = new Map([
  ["reviews", "reviewId"],
  ["boards", "boardId"],
  ["notifications", "notificationId"],
]);

function isDeferredPublicIdIndex(collectionName, keys, options, deferPublicIdIndexes) {
  const publicId = PUBLIC_ID_INDEXES.get(collectionName);
  return Boolean(
    deferPublicIdIndexes
      && options.unique
      && publicId
      && Object.keys(keys).length === 1
      && keys[publicId] === 1,
  );
}

async function ensureIndexes(targetDb, { deferPublicIdIndexes = false } = {}) {
  for (const [collectionName, Model] of Object.entries(MODELS)) {
    if (!Model?.schema) continue;
    const collection = targetDb.collection(collectionName);
    let existingIndexes = [];
    try { existingIndexes = await collection.listIndexes().toArray(); } catch (error) {
      if (error.code !== 26 && error.codeName !== "NamespaceNotFound") throw error;
    }
    const existing = new Map(existingIndexes.map((index) => [index.name, index]));
    for (const [keys, options = {}] of Model.schema.indexes()) {
      if (isDeferredPublicIdIndex(collectionName, keys, options, deferPublicIdIndexes)) continue;
      const name = options.name || Object.entries(keys).map(([key, direction]) => `${key}_${direction}`).join("_");
      const current = existing.get(name);
      if (current) {
        const textIndex = Object.values(keys).some((value) => value === "text");
        const keyMatches = textIndex
          ? Object.prototype.hasOwnProperty.call(current.key || {}, "_fts")
          : canonicalEjson(current.key) === canonicalEjson(keys);
        const optionsMatch = Boolean(current.unique) === Boolean(options.unique)
          && Boolean(current.sparse) === Boolean(options.sparse)
          && canonicalEjson(current.partialFilterExpression || null) === canonicalEjson(options.partialFilterExpression || null);
        if (!keyMatches || !optionsMatch) throw new LegacyMigrationError(`Index contract mismatch for ${collectionName}.${name}`, "INDEX_BUILD_FAILED", [{ current, expected: { keys, options } }]);
        continue;
      }
      await collection.createIndex(keys, options);
    }
  }
  const ledger = targetDb.collection("migrationruns");
  await ledger.createIndex({ planSha256: 1 }, { unique: true });
  await ledger.createIndex({ leaseUntil: 1 });
}

async function acquireLease(targetDb, plan, runId) {
  const ledger = targetDb.collection("migrationruns");
  const now = new Date();
  const existing = await ledger.findOne({ _id: runId });
  if (existing && existing.planSha256 !== plan.planSha256) throw new LegacyMigrationError("Run ID is already bound to another plan", "PLAN_CHECKSUM_MISMATCH");
  if (existing?.status === "completed") return { completed: true, completedBatches: existing.completedBatches || [] };
  const leaseUntil = new Date(now.getTime() + LEASE_MS);
  try {
    const result = await ledger.updateOne(
      { _id: runId, $or: [{ leaseUntil: { $exists: false } }, { leaseUntil: null }, { leaseUntil: { $lt: now } }] },
      { $set: { planSha256: plan.planSha256, targetDatabase: plan.target.database, updatedAt: now, leaseUntil, status: "running" }, $setOnInsert: { _id: runId, createdAt: now, completedBatches: [] } },
      { upsert: true },
    );
    if (!result.matchedCount && !result.upsertedCount) throw new LegacyMigrationError("Another migration process holds the plan lease", "MIGRATION_LOCKED");
  } catch (error) {
    if (error.code === 11000) throw new LegacyMigrationError("Another migration process holds the plan lease", "MIGRATION_LOCKED");
    throw error;
  }
  return { completed: false, completedBatches: existing?.completedBatches || [] };
}

async function assertOperationPrecondition(targetDb, operation, session) {
  const collection = targetDb.collection(operation.collection);
  const current = await collection.findOne({ _id: operation.targetId }, { session });
  if (!operation.beforeHash) {
    if (current) throw new LegacyMigrationError(`Target key is already occupied: ${operation.collection}/${operation.targetId}`, "TARGET_DRIFT");
  } else if (!current || canonicalHash(current) !== operation.beforeHash) {
    throw new LegacyMigrationError(`Target changed after planning: ${operation.collection}/${operation.targetId}`, "BATCH_PRECONDITION_FAILED");
  }
  return collection;
}

function assertLedgerBinding(run, plan, targetDb) {
  if (run.planSha256 !== plan.planSha256) {
    throw new LegacyMigrationError("Run ID is already bound to another plan", "PLAN_CHECKSUM_MISMATCH");
  }
  if (run.targetDatabase && run.targetDatabase !== targetDb.databaseName) {
    throw new LegacyMigrationError(
      "Migration ledger is bound to another target database",
      "TARGET_CONFIRMATION_FAILED",
      [{ expected: targetDb.databaseName, actual: run.targetDatabase }],
    );
  }
}

async function assertInitialTargetFingerprint(targetDb, plan) {
  const expected = plan.target?.fingerprint;
  if (typeof expected !== "string" || !expected) {
    throw new LegacyMigrationError(
      "Migration plan does not contain a target baseline fingerprint",
      "TARGET_BASELINE_MISMATCH",
    );
  }
  // Passing an empty requested-collection list still inventories every
  // collection that actually exists, matching the target inventory captured
  // when the plan was built without inventing missing namespaces.
  const inventory = await inventoryDatabase(targetDb, []);
  if (inventory.databaseHash !== expected) {
    throw new LegacyMigrationError(
      "Target database changed after migration planning",
      "TARGET_BASELINE_MISMATCH",
      [{ expected, actual: inventory.databaseHash, database: targetDb.databaseName }],
    );
  }
}

async function assertLedgerOperationState(targetDb, plan, run) {
  assertLedgerBinding(run, plan, targetDb);
  const planBatchIds = new Set((plan.batches || []).map((batch) => batch.id));
  const completedBatchIds = new Set(run.completedBatches || []);
  const unknownBatches = [...completedBatchIds].filter((batchId) => !planBatchIds.has(batchId));
  if (unknownBatches.length) {
    throw new LegacyMigrationError(
      "Migration ledger contains batches that are absent from the sealed plan",
      "TARGET_DRIFT",
      unknownBatches.map((batchId) => ({ batchId })),
    );
  }
  if (run.status === "completed") {
    const incomplete = [...planBatchIds].filter((batchId) => !completedBatchIds.has(batchId));
    if (incomplete.length) {
      throw new LegacyMigrationError(
        "Completed migration ledger is missing sealed plan batches",
        "TARGET_DRIFT",
        incomplete.map((batchId) => ({ batchId })),
      );
    }
  }

  const mismatches = [];
  for (const operation of plan.operations || []) {
    const completed = completedBatchIds.has(operation.batchId);
    const current = await targetDb.collection(operation.collection).findOne({ _id: operation.targetId });
    const expectedHash = completed ? operation.afterHash : operation.beforeHash;
    const matches = expectedHash
      ? Boolean(current) && canonicalHash(current) === expectedHash
      : !current;
    if (!matches) {
      mismatches.push({
        batchId: operation.batchId,
        collection: operation.collection,
        targetId: operation.targetId,
        expectedState: completed ? "after" : "before",
        expectedHash: expectedHash || null,
        actualHash: current ? canonicalHash(current) : null,
      });
    }
  }
  if (mismatches.length) {
    throw new LegacyMigrationError(
      "Target state does not match the resumable migration ledger",
      "BATCH_PRECONDITION_FAILED",
      mismatches,
    );
  }
  return { completedBatches: [...completedBatchIds] };
}

async function applyBatch(targetDb, batch, session) {
  for (const operation of batch.operations) {
    const collection = await assertOperationPrecondition(targetDb, operation, session);
    await collection.replaceOne({ _id: operation.targetId }, operation.document, { upsert: true, session });
  }
}

async function applyPlan({ targetDb, client, plan, expectedPlanSha256, confirmTarget, runId = plan.runId }) {
  verifyPlanHash(plan, expectedPlanSha256);
  if (
    confirmTarget !== targetDb.databaseName
    || confirmTarget !== plan.target?.database
    || confirmTarget === "test"
  ) {
    throw new LegacyMigrationError(
      "Target confirmation does not match the connected database and sealed plan",
      "TARGET_CONFIRMATION_FAILED",
      [{ confirmation: confirmTarget, connected: targetDb.databaseName, planned: plan.target?.database || null }],
    );
  }
  if (!client || typeof client.startSession !== "function") throw new LegacyMigrationError("Mongo transactions are unavailable", "TRANSACTION_UNAVAILABLE");
  const ledger = targetDb.collection("migrationruns");
  let existingRun = await ledger.findOne({ _id: runId });
  let lease;

  if (!existingRun) {
    // The pristine target fingerprint is meaningful only before indexes or a
    // migration ledger are created. Establish the ledger immediately after
    // this check so an index-build crash is a resumable run, not false drift.
    await assertInitialTargetFingerprint(targetDb, plan);
    lease = await acquireLease(targetDb, plan, runId);
    existingRun = await ledger.findOne({ _id: runId });
  } else {
    // A retry cannot match the original database fingerprint because earlier
    // batches and the ledger intentionally changed it. Prove instead that
    // every completed batch is at its sealed after-state and every remaining
    // batch is still at its sealed before-state.
    await assertLedgerOperationState(targetDb, plan, existingRun);
    if (existingRun.status === "completed") {
      await ensureIndexes(targetDb);
      return { applied: false, noop: true, completedBatches: existingRun.completedBatches || [] };
    }
    lease = await acquireLease(targetDb, plan, runId);
    existingRun = await ledger.findOne({ _id: runId });
    await assertLedgerOperationState(targetDb, plan, existingRun);
  }

  if (lease?.completed || existingRun?.status === "completed") {
    // A completed sealed plan may be retried after an interrupted index build.
    // Its documents have already passed the ledger-state check above, so build
    // or verify the schema indexes before returning the no-op result.
    await ensureIndexes(targetDb);
    return {
      applied: false,
      noop: true,
      completedBatches: existingRun?.completedBatches || lease?.completedBatches || [],
    };
  }
  // Preserve every pre-existing schema-index guard except the public-ID
  // indexes. Those three can only be valid after the sealed raw replacements
  // assign UUIDs to old candidate records.
  await ensureIndexes(targetDb, { deferPublicIdIndexes: true });
  const completed = new Set(existingRun?.completedBatches || lease?.completedBatches || []);
  for (const batch of plan.batches) {
    if (completed.has(batch.id)) continue;
    const operations = plan.operations.filter((operation) => operation.batchId === batch.id);
    let session;
    try {
      session = client.startSession();
      await session.withTransaction(async () => {
        await applyBatch(targetDb, { ...batch, operations }, session);
        await ledger.updateOne({ _id: runId }, { $addToSet: { completedBatches: batch.id }, $set: { updatedAt: new Date(), leaseUntil: new Date(Date.now() + LEASE_MS) } }, { session });
      }, { writeConcern: { w: "majority" } });
    } catch (error) {
      throw new LegacyMigrationError(`Migration batch ${batch.id} failed`, error.code || "TRANSACTION_ROLLED_BACK", [{ cause: error.message, batchId: batch.id }]);
    } finally {
      await session?.endSession();
    }
  }
  // Public-ID indexes must be built only after every sealed replacement has
  // run. A legacy candidate can contain multiple null or absent IDs before
  // this plan assigns their UUIDs, which would make a unique index build fail
  // even though the final sealed documents satisfy the schema.
  await ensureIndexes(targetDb);
  await ledger.updateOne({ _id: runId }, { $set: { status: "completed", leaseUntil: null, updatedAt: new Date(), completedAt: new Date() } });
  return { applied: true, noop: false, batchCount: plan.batches.length, operationCount: plan.operations.length };
}

module.exports = {
  LEASE_MS,
  applyPlan,
  assertInitialTargetFingerprint,
  assertLedgerOperationState,
  ensureIndexes,
};
