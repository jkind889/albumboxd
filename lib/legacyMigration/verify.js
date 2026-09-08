const { canonicalHash, LegacyMigrationError } = require("./runtime");
const { verifyPlanHash } = require("./plan");
const { validateDocuments } = require("./validate");

const ALL_TARGET_COLLECTIONS = ["albumcatalogs", "reviews", "likes", "boards", "boarditems", "notifications", "userprofiles", "follows"];

async function readTargetDocuments(targetDb, collections) {
  const documents = {};
  for (const collection of collections) documents[collection] = await targetDb.collection(collection).find({}).sort({ _id: 1 }).toArray();
  return documents;
}

async function verifyPlanApplied({ targetDb, plan, expectedPlanSha256 }) {
  verifyPlanHash(plan, expectedPlanSha256);
  const collections = ALL_TARGET_COLLECTIONS;
  const documents = await readTargetDocuments(targetDb, collections);
  const byId = new Map();
  for (const [collection, rows] of Object.entries(documents)) for (const row of rows) byId.set(`${collection}|${row._id?.toHexString?.() || row._id}`, row);
  const mismatches = [];
  for (const operation of plan.operations) {
    const key = `${operation.collection}|${operation.targetId?.toHexString?.() || operation.targetId}`;
    const current = byId.get(key);
    if (!current || canonicalHash(current) !== operation.afterHash) mismatches.push({ collection: operation.collection, id: key });
  }
  if (mismatches.length) throw new LegacyMigrationError("Candidate does not contain the sealed plan", "RECONCILIATION_FAILED", mismatches);
  const issues = await validateDocuments(documents);
  if (issues.length) throw new LegacyMigrationError("Candidate relationship verification failed", "RELATIONSHIP_INVALID", issues);
  const ledger = await targetDb.collection("migrationruns").findOne({ _id: plan.runId });
  if (!ledger || ledger.status !== "completed" || ledger.planSha256 !== expectedPlanSha256) throw new LegacyMigrationError("Migration ledger is not complete for the sealed plan", "RECONCILIATION_FAILED");
  return { verified: true, operationCount: plan.operations.length, collections, ledgerStatus: ledger.status };
}

module.exports = { ALL_TARGET_COLLECTIONS, readTargetDocuments, verifyPlanApplied };
