const { canonicalHash, canonicalEjson, LegacyMigrationError } = require("./runtime");
const { MODELS } = require("./validate");
const { verifyPlanHash } = require("./plan");

const LEASE_MS = 5 * 60 * 1000;

async function ensureIndexes(targetDb) {
  for (const [collectionName, Model] of Object.entries(MODELS)) {
    if (!Model?.schema) continue;
    const collection = targetDb.collection(collectionName);
    let existingIndexes = [];
    try { existingIndexes = await collection.listIndexes().toArray(); } catch (error) {
      if (error.code !== 26 && error.codeName !== "NamespaceNotFound") throw error;
    }
    const existing = new Map(existingIndexes.map((index) => [index.name, index]));
    for (const [keys, options = {}] of Model.schema.indexes()) {
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

async function applyBatch(targetDb, batch, session) {
  for (const operation of batch.operations) {
    const collection = await assertOperationPrecondition(targetDb, operation, session);
    await collection.replaceOne({ _id: operation.targetId }, operation.document, { upsert: true, session });
  }
}

async function applyPlan({ targetDb, client, plan, expectedPlanSha256, confirmTarget, runId = plan.runId }) {
  verifyPlanHash(plan, expectedPlanSha256);
  if (confirmTarget !== targetDb.databaseName || confirmTarget === "test") throw new LegacyMigrationError("Target confirmation does not match the safe target database", "TARGET_CONFIRMATION_FAILED");
  if (!client || typeof client.startSession !== "function") throw new LegacyMigrationError("Mongo transactions are unavailable", "TRANSACTION_UNAVAILABLE");
  await ensureIndexes(targetDb);
  const lease = await acquireLease(targetDb, plan, runId);
  if (lease.completed) return { applied: false, noop: true, completedBatches: lease.completedBatches };
  const ledger = targetDb.collection("migrationruns");
  const completed = new Set(lease.completedBatches);
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
  await ledger.updateOne({ _id: runId }, { $set: { status: "completed", leaseUntil: null, updatedAt: new Date(), completedAt: new Date() } });
  return { applied: true, noop: false, batchCount: plan.batches.length, operationCount: plan.operations.length };
}

module.exports = { LEASE_MS, applyPlan, ensureIndexes };
