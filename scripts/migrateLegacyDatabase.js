#!/usr/bin/env node

require("dotenv").config({ quiet: true });

const fs = require("node:fs/promises");
const path = require("node:path");
const { ObjectId } = require("mongodb");
const {
  LegacyMigrationError,
  acquireRunLock,
  canonicalHash,
  connectMongo,
  ensureRunDirectory,
  parseArguments,
  requiredEnvironment,
} = require("../lib/legacyMigration/runtime");
const { readJson, sealJson, writeJson } = require("../lib/legacyMigration/artifacts");
const { inventoryDatabase, inventorySourceTarget, SOURCE_COLLECTIONS } = require("../lib/legacyMigration/inventory");
const { buildCatalogCrosswalk } = require("../lib/legacyMigration/catalogCrosswalk");
const { createMusicBrainzClient } = require("../lib/legacyMigration/musicBrainz");
const { transformSocial } = require("../lib/legacyMigration/transform");
const { buildMigrationPlan, verifyPlanHash } = require("../lib/legacyMigration/plan");
const { applyPlan } = require("../lib/legacyMigration/apply");
const { verifyPlanApplied } = require("../lib/legacyMigration/verify");
const { MODELS, forbiddenFields } = require("../lib/legacyMigration/validate");

const TARGET_COLLECTIONS = ["albumcatalogs", "albumsubmissions", "reviews", "likes", "boards", "boarditems", "userprofiles", "follows", "notifications"];
const USAGE = `Usage:
  npm run db:migrate:legacy -- --inventory --run-dir <path>
  npm run db:migrate:legacy -- --dry-run --run-dir <path> [--overrides <file>]
  npm run db:migrate:legacy -- --validate --run-dir <path>
  npm run db:migrate:legacy -- --apply --run-dir <path> --plan-sha256 <sha> --confirm-target <database>
  npm run db:migrate:legacy -- --verify --run-dir <path> --plan-sha256 <sha>`;

async function readCollections(db, names) {
  const available = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map(({ name }) => name));
  const result = {};
  for (const name of names) result[name] = available.has(name) ? await db.collection(name).find({}).sort({ _id: 1 }).toArray() : [];
  return result;
}

async function loadOverrides(filePath) {
  if (!filePath) return { schemaVersion: "1.0.0", albums: [], users: [], orphans: [] };
  const overrides = await readJson(filePath);
  if (!overrides || overrides.schemaVersion !== "1.0.0" || !Array.isArray(overrides.albums) || !Array.isArray(overrides.users) || !Array.isArray(overrides.orphans)) {
    throw new LegacyMigrationError("Override file does not match schemaVersion 1.0.0", "OVERRIDE_INVALID");
  }
  const requireAudit = (entry, label) => {
    if (!entry || typeof entry !== "object" || typeof entry.reason !== "string" || !entry.reason.trim() || typeof entry.approver !== "string" || !entry.approver.trim() || typeof entry.decisionAt !== "string" || Number.isNaN(Date.parse(entry.decisionAt))) {
      throw new LegacyMigrationError(`${label} override requires reason, approver, and ISO decisionAt`, "OVERRIDE_INVALID");
    }
  };
  const checkKeys = (entry, allowed, label) => {
    for (const key of Object.keys(entry)) if (!allowed.has(key)) throw new LegacyMigrationError(`${label} override contains unknown field ${key}`, "OVERRIDE_INVALID");
  };
  overrides.albums.forEach((entry, index) => {
    const label = `albums[${index}]`;
    checkKeys(entry, new Set(["legacyCatalogId", "decision", "albumId", "targetAlbumId", "releaseGroupMbid", "releaseMbid", "reason", "approver", "decisionAt"]), label);
    requireAudit(entry, label);
    if (!ObjectId.isValid(entry.legacyCatalogId)) throw new LegacyMigrationError(`${label}.legacyCatalogId must be a Mongo ObjectId`, "OVERRIDE_INVALID");
    if (!["reuse", "map", "select_edition", "archive"].includes(entry.decision)) throw new LegacyMigrationError(`${label}.decision is unsupported`, "OVERRIDE_INVALID");
    if (entry.decision === "reuse" && !entry.albumId && !entry.targetAlbumId) throw new LegacyMigrationError(`${label}.reuse requires albumId`, "OVERRIDE_INVALID");
    if (["map", "select_edition"].includes(entry.decision) && !entry.releaseGroupMbid && !entry.releaseMbid) throw new LegacyMigrationError(`${label}.${entry.decision} requires a MusicBrainz MBID`, "OVERRIDE_INVALID");
  });
  overrides.users.forEach((entry, index) => {
    const label = `users[${index}]`;
    checkKeys(entry, new Set(["legacyUserId", "targetUserId", "decision", "reason", "approver", "decisionAt"]), label);
    requireAudit(entry, label);
    if (!entry.legacyUserId || !entry.targetUserId || entry.decision !== "map") throw new LegacyMigrationError(`${label} must map a legacyUserId to a targetUserId`, "OVERRIDE_INVALID");
  });
  overrides.orphans.forEach((entry, index) => {
    const label = `orphans[${index}]`;
    checkKeys(entry, new Set(["collection", "sourceId", "decision", "reason", "approver", "decisionAt"]), label);
    requireAudit(entry, label);
    if (!entry.collection || !entry.sourceId || entry.decision !== "archive") throw new LegacyMigrationError(`${label} must archive a collection/sourceId pair`, "OVERRIDE_INVALID");
  });
  return overrides;
}

async function loadOrCreateInventory(runDir, sourceDb, targetDb, sourceName, targetName) {
  const filePath = path.join(runDir, "inventory.json");
  try {
    return await readJson(filePath, { canonical: true });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const inventory = await inventorySourceTarget({ sourceDb, targetDb, sourceName, targetName });
  await sealJson(runDir, "inventory.json", inventory);
  return inventory;
}

async function checkClerkUsers(sourceDocuments, overrides = {}) {
  const userMap = new Map((overrides.users || []).map((entry) => [String(entry.legacyUserId || ""), String(entry.targetUserId || "")]).filter(([from, to]) => from && to));
  const mapped = (value) => userMap.get(String(value || "")) || value;
  const userIds = [...new Set([
    ...(sourceDocuments.reviews || []).map((row) => mapped(row.userId)),
    ...(sourceDocuments.likes || []).map((row) => mapped(row.userId)),
    ...(sourceDocuments.boards || []).map((row) => mapped(row.userId)),
    ...(sourceDocuments.boarditems || []).map((row) => mapped(row.userId)),
    ...(sourceDocuments.follows || []).flatMap((row) => [mapped(row.followerId), mapped(row.followingId)]),
    ...(sourceDocuments.userprofiles || []).map((row) => mapped(row.userId)),
    ...(sourceDocuments.notifications || []).flatMap((row) => [mapped(row.recipientUserId), mapped(row.actorUserId)]),
  ].filter(Boolean))];
  if (!userIds.length) return { checked: 0, missing: [] };
  if (!process.env.CLERK_SECRET_KEY) return { checked: 0, missing: [], skipped: true };
  try {
    const { clerkClient } = require("@clerk/express");
    const found = new Set();
    for (let index = 0; index < userIds.length; index += 100) {
      const listed = await clerkClient.users.getUserList({ userId: userIds.slice(index, index + 100) });
      const users = Array.isArray(listed) ? listed : listed.data || [];
      users.forEach((user) => found.add(user.id));
    }
    return { checked: userIds.length, missing: userIds.filter((id) => !found.has(id)) };
  } catch (error) {
    throw new LegacyMigrationError("Clerk identity verification failed", "CLERK_IDENTITY_CHECK_FAILED", [{ message: error.message }]);
  }
}

async function validatePlanDocuments(plan) {
  const issues = [];
  for (const operation of plan.operations || []) {
    const forbidden = forbiddenFields(operation.document, "", operation.collection);
    if (forbidden.length) issues.push({ collection: operation.collection, fields: forbidden, id: operation.targetId });
    const Model = MODELS[operation.collection];
    if (Model) {
      try { await new Model(operation.document).validate(); } catch (error) { issues.push({ collection: operation.collection, id: operation.targetId, message: error.message }); }
    }
  }
  if (issues.length) throw new LegacyMigrationError("Sealed plan validation failed", "PLAN_VALIDATION_FAILED", issues);
  return { valid: true, operationCount: plan.operations.length, planSha256: plan.planSha256 };
}

async function runInventory(options, env) {
  const sourceClient = await connectMongo(env.sourceUri, { readPreference: "secondaryPreferred" });
  const targetClient = await connectMongo(env.targetUri, { readPreference: "secondaryPreferred" });
  try {
    const inventory = await inventorySourceTarget({ sourceDb: sourceClient.db(env.source), targetDb: targetClient.db(env.target), sourceName: env.source, targetName: env.target });
    await sealJson(options.runDir, "inventory.json", inventory);
    return { mode: options.mode, inventory, exitCode: 0 };
  } finally { await Promise.all([sourceClient.close(), targetClient.close()]); }
}

async function runDryRun(options, env) {
  const sourceClient = await connectMongo(env.sourceUri, { readPreference: "secondaryPreferred" });
  const targetClient = await connectMongo(env.targetUri);
  try {
    const sourceDb = sourceClient.db(env.source);
    const targetDb = targetClient.db(env.target);
    const sourceDocuments = await readCollections(sourceDb, SOURCE_COLLECTIONS);
    const targetDocuments = await readCollections(targetDb, TARGET_COLLECTIONS);
    const inventory = await loadOrCreateInventory(options.runDir, sourceDb, targetDb, env.source, env.target);
    const overrides = await loadOverrides(options.overrides);
    const clerk = await checkClerkUsers(sourceDocuments, overrides);
    if (clerk.missing.length) throw new LegacyMigrationError("Legacy social data references missing Clerk users", "BLOCKING_QUARANTINE", clerk.missing.map((userId) => ({ userId })));
    const client = createMusicBrainzClient({
      cacheDir: path.join(options.runDir, "musicbrainz"),
      userAgent: process.env.MUSICBRAINZ_USER_AGENT,
    });
    const catalog = await buildCatalogCrosswalk({
      sourceDocuments,
      targetRows: targetDocuments.albumcatalogs,
      overrides,
      client,
      onProgress: ({ index, total }) => process.stdout.write(`\rHydrating legacy catalog ${index}/${total}`),
    });
    process.stdout.write("\n");
    await writeJson(path.join(options.runDir, "crosswalk.protected.json"), { schemaVersion: "1.0.0", generatedAt: new Date().toISOString(), crosswalk: catalog.crosswalk, stats: client.stats });
    const social = transformSocial({ source: sourceDocuments, target: targetDocuments, catalogResults: catalog.results, overrides });
    const plan = await buildMigrationPlan({ inventory, sourceDocuments, targetDocuments, catalogResults: catalog.results, social, runId: path.basename(options.runDir) });
    await validatePlanDocuments(plan);
    const sealed = await sealJson(options.runDir, "plan.json", plan);
    // `planSha256` is the hash of the canonical plan with its self-hash omitted.
    // The file digest is intentionally reported separately; using the latter as
    // the apply token would make verification impossible because the file
    // necessarily contains `planSha256`.
    await writeJson(path.join(options.runDir, "plan-report.json"), { planSha256: plan.planSha256, fileSha256: sealed.sha256, counts: plan.counts, clerk, musicBrainz: client.stats, quarantines: plan.outcome.socialIssues });
    const quarantinedCatalog = catalog.crosswalk
      .filter((row) => ["quarantined", "archived"].includes(row.action))
      .map(({ legacyProviderKeys, ...row }) => row);
    await writeJson(path.join(options.runDir, "quarantine.json"), { catalog: quarantinedCatalog, social: social.issues });
    const hasNonblocking = catalog.results.some((result) => result.action === "quarantined" || result.action === "archived");
    return { mode: options.mode, planSha256: plan.planSha256, fileSha256: sealed.sha256, counts: plan.counts, exitCode: hasNonblocking ? 2 : 0 };
  } finally { await Promise.all([sourceClient.close(), targetClient.close()]); }
}

async function loadPlan(runDir) {
  try { return await readJson(path.join(runDir, "plan.json"), { canonical: true }); } catch (error) { throw new LegacyMigrationError(`Unable to read sealed plan: ${error.message}`, "INVENTORY_REQUIRED"); }
}

async function runValidate(options) {
  const plan = await loadPlan(options.runDir);
  verifyPlanHash(plan, plan.planSha256);
  const report = await validatePlanDocuments(plan);
  await writeJson(path.join(options.runDir, "validation-report.json"), report);
  return { mode: options.mode, planSha256: plan.planSha256, report, exitCode: 0 };
}

async function runApply(options, env) {
  const plan = await loadPlan(options.runDir);
  verifyPlanHash(plan, options.planSha256);
  const targetClient = await connectMongo(env.targetUri);
  try {
    const result = await applyPlan({ targetDb: targetClient.db(env.target), client: targetClient, plan, expectedPlanSha256: options.planSha256, confirmTarget: options.confirmTarget });
    await writeJson(path.join(options.runDir, "apply-report.json"), { ...result, planSha256: options.planSha256, target: env.target });
    return { mode: options.mode, planSha256: options.planSha256, result, exitCode: 0 };
  } finally { await targetClient.close(); }
}

async function runVerify(options, env) {
  const plan = await loadPlan(options.runDir);
  const targetClient = await connectMongo(env.targetUri, { readPreference: "secondaryPreferred" });
  try {
    const result = await verifyPlanApplied({ targetDb: targetClient.db(env.target), plan, expectedPlanSha256: options.planSha256 });
    await writeJson(path.join(options.runDir, "verify-report.json"), { ...result, planSha256: options.planSha256, target: env.target });
    return { mode: options.mode, planSha256: options.planSha256, result, exitCode: 0 };
  } finally { await targetClient.close(); }
}

async function main(argv = process.argv.slice(2), environment = process.env, output = console) {
  let options;
  let releaseRunLock;
  try {
    options = parseArguments(argv);
    if (options.help) { output.log(USAGE); return 0; }
    options.runDir = ensureRunDirectory(options.runDir);
    // Validation is deliberately artifact-only: it must be safe to run on an
    // exported run directory without credentials, a MongoDB connection, or
    // any network access.
    const env = options.mode === "validate" ? null : requiredEnvironment(environment);
    if (options.mode !== "validate") releaseRunLock = await acquireRunLock(options.runDir, options.mode);
    const result = options.mode === "inventory" ? await runInventory(options, env)
      : options.mode === "dry-run" ? await runDryRun(options, env)
        : options.mode === "validate" ? await runValidate(options)
          : options.mode === "apply" ? await runApply(options, env)
            : await runVerify(options, env);
    output.log(JSON.stringify(result, null, 2));
    return result.exitCode;
  } catch (error) {
    output.error(`${error.code || "LEGACY_MIGRATION_FAILED"}: ${error.message}`);
    if (error.details?.length) output.error(JSON.stringify(error.details, null, 2));
    return 1;
  } finally {
    await releaseRunLock?.();
  }
}

if (require.main === module) main().then((code) => { process.exitCode = code; });

module.exports = { USAGE, checkClerkUsers, loadOverrides, main, readCollections, validatePlanDocuments };
