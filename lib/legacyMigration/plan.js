const { canonicalEjson, canonicalHash, LegacyMigrationError } = require("./runtime");
const { validateModelDocuments } = require("./validate");

const STAGES = ["catalog", "boards", "follows", "reviews", "boarditems", "likes", "notifications", "userprofiles"];
const COLLECTION_STAGE = { albumcatalogs: "catalog", boards: "boards", follows: "follows", reviews: "reviews", boarditems: "boarditems", likes: "likes", notifications: "notifications", userprofiles: "userprofiles" };

function idString(value) { return value && value.toHexString ? value.toHexString() : String(value || ""); }
function sameDocument(left, right) { return canonicalEjson(left) === canonicalEjson(right); }
function rowsById(rows = []) { return new Map(rows.map((row) => [idString(row._id), row])); }

function applyCatalogResults(targetRows, catalogResults) {
  const map = rowsById(targetRows);
  for (const result of catalogResults) if (result.document && ["created", "reused"].includes(result.action)) map.set(idString(result.document._id), result.document);
  return [...map.values()];
}

function makeOperation(collection, before, after, source = null) {
  return {
    collection,
    stage: COLLECTION_STAGE[collection],
    action: before ? "update" : "insert",
    targetId: after._id,
    beforeHash: before ? canonicalHash(before) : null,
    afterHash: canonicalHash(after),
    document: after,
    source,
  };
}

function createOperations(targetDocuments, finalDocuments, sourceByCollection = {}) {
  const operations = [];
  for (const [collection, finalRows] of Object.entries(finalDocuments)) {
    if (!COLLECTION_STAGE[collection]) continue;
    const existing = rowsById(targetDocuments[collection] || []);
    for (const document of finalRows || []) {
      const before = existing.get(idString(document._id));
      if (!before || !sameDocument(before, document)) operations.push(makeOperation(collection, before, document, sourceByCollection[collection]?.[idString(document._id)] || null));
    }
  }
  const stageRank = new Map(STAGES.map((stage, index) => [stage, index]));
  operations.sort((left, right) => stageRank.get(left.stage) - stageRank.get(right.stage) || left.collection.localeCompare(right.collection) || idString(left.targetId).localeCompare(idString(right.targetId)));
  const batches = [];
  let current = [];
  let currentBytes = 0;
  let batchNumber = 0;
  for (const operation of operations) {
    const bytes = Buffer.byteLength(canonicalEjson(operation), "utf8");
    if (current.length && (current.length >= 250 || currentBytes + bytes > 4 * 1024 * 1024)) {
      batches.push({ id: `batch-${String(batchNumber).padStart(4, "0")}`, operations: current });
      batchNumber += 1;
      current = [];
      currentBytes = 0;
    }
    current.push(operation);
    currentBytes += bytes;
  }
  if (current.length) batches.push({ id: `batch-${String(batchNumber).padStart(4, "0")}`, operations: current });
  batches.forEach((batch) => batch.operations.forEach((operation) => { operation.batchId = batch.id; }));
  return { operations, batches };
}

function publicCrosswalk(catalogResults) {
  return catalogResults.map((result) => ({
    legacyCatalogIds: result.identity.catalogIds,
    targetObjectId: result.document?._id || null,
    targetAlbumId: result.document?.albumId || null,
    socialPriority: Boolean(result.identity.social),
    action: result.action,
    issue: result.issue || null,
    match: result.match || null,
  }));
}

function blockingIssues(catalogResults, socialIssues) {
  const blocking = [];
  for (const result of catalogResults) if (result.identity.social && !["created", "reused"].includes(result.action)) blocking.push({ code: "BLOCKING_SOCIAL_ALBUM", identity: result.identity.key, issue: result.issue });
  for (const issue of socialIssues) if (issue.action !== "archive") blocking.push(issue);
  return blocking;
}

async function buildMigrationPlan({ inventory, sourceDocuments, targetDocuments, catalogResults, social, runId, generatedAt = new Date().toISOString() }) {
  const finalDocuments = {
    albumcatalogs: applyCatalogResults(targetDocuments.albumcatalogs || [], catalogResults),
    ...social.documents,
  };
  const validation = await validateModelDocuments(finalDocuments);
  const blocking = blockingIssues(catalogResults, social.issues || []);
  if (blocking.length) throw new LegacyMigrationError("Blocking migration conflicts require overrides", "BLOCKING_QUARANTINE", blocking);
  const sourceByCollection = {};
  const operationPlan = createOperations(targetDocuments, finalDocuments, sourceByCollection);
  const plan = {
    schemaVersion: "1.0.0",
    runId,
    generatedAt,
    source: { database: inventory.source.databaseName, fingerprint: inventory.source.databaseHash },
    target: { database: inventory.target.databaseName, fingerprint: inventory.target.databaseHash },
    outcome: { catalog: publicCrosswalk(catalogResults), socialIssues: social.issues || [] },
    operations: operationPlan.operations,
    batches: operationPlan.batches.map((batch) => ({ id: batch.id, operationCount: batch.operations.length })),
    counts: {
      catalogRows: catalogResults.length,
      catalogCreated: catalogResults.filter((result) => result.action === "created").length,
      catalogReused: catalogResults.filter((result) => result.action === "reused").length,
      catalogQuarantined: catalogResults.filter((result) => result.action === "quarantined").length,
      operations: operationPlan.operations.length,
      batches: operationPlan.batches.length,
      archived: (social.issues || []).filter((issue) => issue.action === "archive").length,
    },
    validation: { fingerprint: validation.fingerprint },
  };
  plan.planSha256 = canonicalHash({ ...plan, planSha256: undefined });
  return plan;
}

function verifyPlanHash(plan, expected) {
  const actual = canonicalHash({ ...plan, planSha256: undefined });
  if (actual !== expected || plan.planSha256 !== expected) throw new LegacyMigrationError("Migration plan checksum mismatch", "PLAN_CHECKSUM_MISMATCH", [{ expected, actual, embedded: plan.planSha256 }]);
  return true;
}

module.exports = {
  COLLECTION_STAGE,
  STAGES,
  buildMigrationPlan,
  createOperations,
  publicCrosswalk,
  verifyPlanHash,
};
