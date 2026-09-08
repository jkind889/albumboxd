#!/usr/bin/env node

/*
 * Give historical review documents the same persisted public UUID identity as
 * newly-created reviews. This deliberately talks to Review.collection instead
 * of using Mongoose queries: query hydration could otherwise invoke a schema
 * default and make an absent reviewId look like stored data.
 */

require("dotenv").config({ quiet: true });

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const mongoose = require("mongoose");
const { EJSON, ObjectId } = require("bson");
const Review = require("../models/Reviews");

const REVIEW_COLLECTION = "reviews";
const REVIEW_ID_INDEX = "reviewId_1";
const REPORT_VERSION = 1;
const BATCH_SIZE = 500;
const DEFAULT_REPORT_DIRECTORY = path.resolve(".migration", "review-ids");
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/;

const USAGE = `Usage:
  npm run db:migrate:review-ids -- --dry-run [--report <path>]
  npm run db:migrate:review-ids -- --apply --report <path> --confirm-target <database>
  npm run db:migrate:review-ids -- --verify [--report <path>]

Options:
  --dry-run                 Read raw review documents and write a sealed plan (default)
  --apply                   Apply a reviewed plan in guarded batches of ${BATCH_SIZE}
  --verify                  Check persisted UUID coverage, uniqueness, and the unique index
  --report <path>           Dry-run destination; required reviewed plan for --apply
  --confirm-target <name>   Required with --apply; must match the connected database name
  --help                    Show this help`;

class ReviewIdMigrationError extends Error {
  constructor(message, code = "REVIEW_ID_MIGRATION_FAILED", details = []) {
    super(message);
    this.name = "ReviewIdMigrationError";
    this.code = code;
    this.details = details;
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value instanceof Date || Buffer.isBuffer(value) || value?._bsontype || value instanceof RegExp) return value;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function canonicalEjson(value) {
  return EJSON.stringify(canonicalize(value), { canonical: true, relaxed: false });
}

function sha256(value) {
  return crypto.createHash("sha256").update(Buffer.isBuffer(value) ? value : String(value), "utf8").digest("hex");
}

function canonicalHash(value) {
  return sha256(canonicalEjson(value));
}

function defaultReportPath(now = new Date(), randomUuid = crypto.randomUUID) {
  const timestamp = new Date(now).toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return path.join(DEFAULT_REPORT_DIRECTORY, `review-id-plan-${timestamp}-${randomUuid()}.json`);
}

function parseArgs(argv = []) {
  const options = {
    mode: "dry-run",
    report: "",
    reportProvided: false,
    confirmTarget: "",
    help: false,
  };
  let explicitMode = "";
  const valueFlags = new Map([
    ["--report", "report"],
    ["--confirm-target", "confirmTarget"],
  ]);
  const seenValues = new Set();

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (["--dry-run", "--apply", "--verify"].includes(argument)) {
      const mode = argument.slice(2);
      if (explicitMode) throw new ReviewIdMigrationError("Exactly one of --dry-run, --apply, or --verify may be supplied", "INVALID_ARGUMENTS");
      explicitMode = mode;
      options.mode = mode;
      continue;
    }
    if (argument === "--help") {
      if (options.help) throw new ReviewIdMigrationError("--help may only be supplied once", "INVALID_ARGUMENTS");
      options.help = true;
      continue;
    }
    if (valueFlags.has(argument)) {
      if (seenValues.has(argument)) throw new ReviewIdMigrationError(`${argument} may only be supplied once`, "INVALID_ARGUMENTS");
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new ReviewIdMigrationError(`${argument} requires a value`, "INVALID_ARGUMENTS");
      options[valueFlags.get(argument)] = argument === "--report" ? path.resolve(value) : value;
      if (argument === "--report") options.reportProvided = true;
      seenValues.add(argument);
      index += 1;
      continue;
    }
    throw new ReviewIdMigrationError(`Unknown argument: ${argument}`, "INVALID_ARGUMENTS");
  }

  if (options.mode === "apply" && !options.confirmTarget) {
    throw new ReviewIdMigrationError("--apply requires --confirm-target <database>", "TARGET_CONFIRMATION_REQUIRED");
  }
  if (options.mode === "apply" && !options.reportProvided) {
    throw new ReviewIdMigrationError("--apply requires the reviewed dry-run report via --report <path>", "REPORT_REQUIRED");
  }
  if (options.mode === "dry-run" && options.confirmTarget) {
    throw new ReviewIdMigrationError("--confirm-target is only valid with --apply or --verify", "INVALID_ARGUMENTS");
  }
  return options;
}

function idString(value) {
  if (value === null || value === undefined) return "";
  return typeof value.toHexString === "function" ? value.toHexString() : String(value);
}

function isCanonicalUuidV4(value) {
  return typeof value === "string" && UUID_V4_PATTERN.test(value);
}

function isObjectIdString(value) {
  return typeof value === "string" && OBJECT_ID_PATTERN.test(value);
}

function reviewIdState(row) {
  if (!Object.prototype.hasOwnProperty.call(row, "reviewId")) return "missing";
  if (row.reviewId === null) return "null";
  if (isCanonicalUuidV4(row.reviewId)) return "existing";
  return "invalid";
}

function reportValue(value) {
  if (value === undefined) return { type: "undefined", value: null };
  if (value === null) return { type: "null", value: null };
  if (typeof value === "string") return { type: "string", value };
  return { type: typeof value, value: canonicalEjson(value) };
}

function stripReviewId(row) {
  const clone = { ...row };
  delete clone.reviewId;
  return clone;
}

function recordsStateHash(rows) {
  return canonicalHash(rows.map((row) => ({
    _id: row._id,
    state: reviewIdState(row),
    reviewId: Object.prototype.hasOwnProperty.call(row, "reviewId") ? row.reviewId : undefined,
  })));
}

function recordsContentHash(rows) {
  return canonicalHash(rows.map(stripReviewId));
}

function generateUniqueUuid(used, randomUuid) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = randomUuid();
    if (isCanonicalUuidV4(value) && !used.has(value)) {
      used.add(value);
      return value;
    }
  }
  throw new ReviewIdMigrationError("Could not generate a unique canonical UUID-v4 for a review", "UUID_GENERATION_FAILED");
}

function chunkAssignments(assignments) {
  const batches = [];
  for (let offset = 0; offset < assignments.length; offset += BATCH_SIZE) {
    const entries = assignments.slice(offset, offset + BATCH_SIZE);
    batches.push({
      id: `batch-${String(batches.length + 1).padStart(4, "0")}`,
      assignmentCount: entries.length,
      firstMongoId: entries[0].mongoId,
      lastMongoId: entries.at(-1).mongoId,
      assignmentsSha256: canonicalHash(entries),
    });
  }
  return batches;
}

function planSha256(plan) {
  return canonicalHash({ ...plan, planSha256: undefined });
}

function buildPlan({ rows = [], target, now = new Date(), randomUuid = crypto.randomUUID } = {}) {
  if (!target?.database || !target?.collection?.name) {
    throw new ReviewIdMigrationError("A target database and review collection identity are required", "REPORT_INVALID");
  }

  const existingReviewIds = [];
  const assignments = [];
  const blockers = [];
  const usedReviewIds = new Set();
  const duplicateIds = new Map();
  let missingReviewIds = 0;
  let nullReviewIds = 0;

  for (const row of rows) {
    const mongoId = idString(row?._id);
    if (!isObjectIdString(mongoId)) {
      blockers.push({ type: "invalid_mongo_id", mongoId: mongoId || null });
      continue;
    }
    const state = reviewIdState(row);
    if (state === "existing") {
      existingReviewIds.push({ mongoId, reviewId: row.reviewId });
      const prior = duplicateIds.get(row.reviewId) || [];
      prior.push(mongoId);
      duplicateIds.set(row.reviewId, prior);
      usedReviewIds.add(row.reviewId);
    } else if (state === "missing" || state === "null") {
      if (state === "missing") missingReviewIds += 1;
      else nullReviewIds += 1;
      assignments.push({ mongoId, reviewId: null, expectedReviewIdState: state });
    } else {
      blockers.push({ type: "invalid_review_id", mongoId, actualReviewId: reportValue(row.reviewId) });
    }
  }

  for (const [reviewId, mongoIds] of duplicateIds.entries()) {
    if (mongoIds.length > 1) blockers.push({ type: "duplicate_review_id", reviewId, mongoIds });
  }

  assignments.sort((left, right) => left.mongoId.localeCompare(right.mongoId));
  existingReviewIds.sort((left, right) => left.mongoId.localeCompare(right.mongoId));
  blockers.sort((left, right) => `${left.type}:${left.mongoId || left.reviewId || ""}`.localeCompare(`${right.type}:${right.mongoId || right.reviewId || ""}`));
  for (const assignment of assignments) assignment.reviewId = generateUniqueUuid(usedReviewIds, randomUuid);

  const plan = {
    schemaVersion: REPORT_VERSION,
    migration: "review-ids",
    mode: "dry-run",
    generatedAt: new Date(now).toISOString(),
    target: {
      ...target,
      documentCount: rows.length,
      reviewStateSha256: recordsStateHash(rows),
      reviewContentSha256: recordsContentHash(rows),
    },
    existingReviewIds,
    assignments,
    blockers,
    batches: chunkAssignments(assignments),
    counts: {
      totalReviews: rows.length,
      existingReviewIds: existingReviewIds.length,
      missingReviewIds,
      nullReviewIds,
      assignments: assignments.length,
      blockers: blockers.length,
    },
  };
  plan.planSha256 = planSha256(plan);
  return plan;
}

function reportContents(report) {
  return `${JSON.stringify(report, null, 2)}\n`;
}

function writeExclusive(filePath, contents) {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const temporary = path.join(path.dirname(resolved), `.${path.basename(resolved)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(temporary, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try {
    // link(2) is an atomic no-clobber publication on the same filesystem.
    fs.linkSync(temporary, resolved);
  } catch (error) {
    if (error.code === "EEXIST") throw new ReviewIdMigrationError(`Artifact already exists: ${resolved}`, "REPORT_EXISTS");
    throw error;
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return resolved;
}

function writeReport(reportPath, report) {
  const resolved = path.resolve(reportPath);
  const contents = reportContents(report);
  const digestPath = `${resolved}.sha256`;
  if (fs.existsSync(resolved) || fs.existsSync(digestPath)) {
    throw new ReviewIdMigrationError(`Artifact already exists: ${fs.existsSync(resolved) ? resolved : digestPath}`, "REPORT_EXISTS");
  }
  let reportPublished = false;
  try {
    writeExclusive(resolved, contents);
    reportPublished = true;
    writeExclusive(digestPath, `${sha256(contents)}\n`);
  } catch (error) {
    // The report is not considered sealed unless both artifacts exist. It is
    // safe to remove only the file this invocation just published.
    if (reportPublished) fs.rmSync(resolved, { force: true });
    throw error;
  }
  return { path: resolved, checksumPath: digestPath, sha256: sha256(contents) };
}

function readReviewedReport(reportPath) {
  const resolved = path.resolve(reportPath);
  let contents;
  let report;
  try {
    contents = fs.readFileSync(resolved, "utf8");
    report = JSON.parse(contents);
  } catch (error) {
    throw new ReviewIdMigrationError(`Could not read review-ID report: ${error.message}`, "REPORT_READ_FAILED");
  }
  let expectedFileChecksum;
  try {
    expectedFileChecksum = fs.readFileSync(`${resolved}.sha256`, "utf8").trim();
  } catch (error) {
    throw new ReviewIdMigrationError(`Could not read review-ID report checksum: ${error.message}`, "REPORT_CHECKSUM_MISSING");
  }
  if (!/^[0-9a-f]{64}$/.test(expectedFileChecksum) || expectedFileChecksum !== sha256(contents)) {
    throw new ReviewIdMigrationError("The review-ID report checksum does not match its contents", "REPORT_CHECKSUM_MISMATCH");
  }
  validateReviewedPlan(report, { allowBlockers: true });
  return report;
}

function validateReviewedPlan(report, { allowBlockers = false } = {}) {
  if (!report || report.schemaVersion !== REPORT_VERSION || report.migration !== "review-ids" || report.mode !== "dry-run") {
    throw new ReviewIdMigrationError("Apply requires a review-ID dry-run report", "REPORT_NOT_REVIEWABLE");
  }
  if (!report.target?.database || report.target?.collection?.name !== REVIEW_COLLECTION
    || typeof report.target.collection.namespace !== "string"
    || typeof report.target.collection.exists !== "boolean"
    || !Number.isInteger(report.target.documentCount) || report.target.documentCount < 0
    || !/^[0-9a-f]{64}$/.test(report.target.reviewStateSha256 || "")
    || !/^[0-9a-f]{64}$/.test(report.target.reviewContentSha256 || "")
    || !Array.isArray(report.existingReviewIds)
    || !Array.isArray(report.assignments)
    || !Array.isArray(report.blockers)
    || !Array.isArray(report.batches)
    || typeof report.planSha256 !== "string") {
    throw new ReviewIdMigrationError("The review-ID report has an invalid migration plan", "REPORT_INVALID");
  }
  if (report.planSha256 !== planSha256(report)) {
    throw new ReviewIdMigrationError("The embedded review-ID plan checksum does not match", "PLAN_CHECKSUM_MISMATCH");
  }
  if (report.blockers.length) {
    if (!allowBlockers) {
      throw new ReviewIdMigrationError("Historical review IDs require operator review before apply", "BLOCKING_REVIEW_IDS", report.blockers);
    }
    return;
  }
  const seenMongoIds = new Set();
  const seenReviewIds = new Set();
  for (const entry of report.existingReviewIds) {
    if (!isObjectIdString(entry?.mongoId) || !isCanonicalUuidV4(entry?.reviewId) || seenMongoIds.has(entry.mongoId) || seenReviewIds.has(entry.reviewId)) {
      throw new ReviewIdMigrationError("The review-ID report contains invalid existing identities", "REPORT_INVALID");
    }
    seenMongoIds.add(entry.mongoId);
    seenReviewIds.add(entry.reviewId);
  }
  for (const entry of report.assignments) {
    if (!isObjectIdString(entry?.mongoId) || !isCanonicalUuidV4(entry?.reviewId)
      || !["missing", "null"].includes(entry?.expectedReviewIdState)
      || seenMongoIds.has(entry.mongoId) || seenReviewIds.has(entry.reviewId)) {
      throw new ReviewIdMigrationError("The review-ID report contains invalid assignments", "REPORT_INVALID");
    }
    seenMongoIds.add(entry.mongoId);
    seenReviewIds.add(entry.reviewId);
  }
  if (seenMongoIds.size !== report.target.documentCount) {
    throw new ReviewIdMigrationError("The review-ID report does not account for every review document", "REPORT_INVALID");
  }
  if (canonicalHash(report.batches) !== canonicalHash(chunkAssignments(report.assignments))) {
    throw new ReviewIdMigrationError("The review-ID report contains invalid batch boundaries", "REPORT_INVALID");
  }
}

function collectionName(collection) {
  return collection?.collectionName || collection?.name || REVIEW_COLLECTION;
}

function databaseName(db) {
  const name = db?.databaseName || db?.name;
  if (!name || typeof name !== "string") throw new ReviewIdMigrationError("Could not determine the connected database name", "TARGET_CONFIRMATION_FAILED");
  return name;
}

async function getCollectionIdentity(db, name = REVIEW_COLLECTION) {
  const database = databaseName(db);
  const entries = await db.listCollections({ name }, { nameOnly: false }).toArray();
  const metadata = entries.find((entry) => entry.name === name);
  return {
    database,
    collection: {
      name,
      namespace: `${database}.${name}`,
      exists: Boolean(metadata),
      uuid: metadata?.info?.uuid ? canonicalEjson(metadata.info.uuid) : null,
    },
  };
}

async function readRawReviews(collection) {
  // This must remain a native collection cursor. Do not replace it with
  // Review.find(): Mongoose hydration can apply a reviewId default.
  return collection.find({}).sort({ _id: 1 }).toArray();
}

async function loadPlan({ db, collection, now = new Date(), randomUuid = crypto.randomUUID } = {}) {
  const identity = await getCollectionIdentity(db, collectionName(collection));
  const rows = await readRawReviews(collection);
  return buildPlan({ rows, target: identity, now, randomUuid });
}

function collectionIdentityMatches(expected, actual, { allowCreatedEmptyCollection = false } = {}) {
  if (expected?.database !== actual?.database || expected?.collection?.name !== actual?.collection?.name
    || expected?.collection?.namespace !== actual?.collection?.namespace) return false;
  if (!expected.collection.exists && allowCreatedEmptyCollection && actual.collection.exists) return true;
  return expected.collection.exists === actual.collection.exists && expected.collection.uuid === actual.collection.uuid;
}

function assignmentStateMatches(row, assignment, { allowAssigned = true } = {}) {
  const state = reviewIdState(row);
  if (state === assignment.expectedReviewIdState) return true;
  return allowAssigned && state === "existing" && row.reviewId === assignment.reviewId;
}

async function assertTargetMatchesPlan({ plan, db, collection, allowAssigned = true, allowCreatedEmptyCollection = false } = {}) {
  const actualIdentity = await getCollectionIdentity(db, collectionName(collection));
  if (!collectionIdentityMatches(plan.target, actualIdentity, { allowCreatedEmptyCollection })) {
    throw new ReviewIdMigrationError("The reviews collection identity changed after dry-run planning", "TARGET_BASELINE_MISMATCH", [{ expected: plan.target, actual: actualIdentity }]);
  }
  const rows = await readRawReviews(collection);
  if (rows.length !== plan.target.documentCount || recordsContentHash(rows) !== plan.target.reviewContentSha256) {
    throw new ReviewIdMigrationError("Review documents changed after dry-run planning", "TARGET_BASELINE_MISMATCH");
  }
  const byMongoId = new Map(rows.map((row) => [idString(row._id), row]));
  const expected = new Map();
  for (const entry of plan.existingReviewIds) expected.set(entry.mongoId, { type: "existing", reviewId: entry.reviewId });
  for (const entry of plan.assignments) expected.set(entry.mongoId, { type: "assignment", entry });
  if (expected.size !== byMongoId.size) {
    throw new ReviewIdMigrationError("The review document set changed after dry-run planning", "TARGET_BASELINE_MISMATCH");
  }
  for (const [mongoId, row] of byMongoId.entries()) {
    const planned = expected.get(mongoId);
    if (!planned) throw new ReviewIdMigrationError("A review document was added after dry-run planning", "TARGET_BASELINE_MISMATCH", [{ mongoId }]);
    if (planned.type === "existing" && row.reviewId !== planned.reviewId) {
      throw new ReviewIdMigrationError("A persisted review ID changed after dry-run planning", "TARGET_BASELINE_MISMATCH", [{ mongoId }]);
    }
    if (planned.type === "assignment" && !assignmentStateMatches(row, planned.entry, { allowAssigned })) {
      throw new ReviewIdMigrationError("A review ID changed after dry-run planning", "TARGET_BASELINE_MISMATCH", [{ mongoId }]);
    }
  }
  return rows;
}

function assignmentFilter(assignment) {
  const filter = { _id: new ObjectId(assignment.mongoId) };
  if (assignment.expectedReviewIdState === "missing") filter.reviewId = { $exists: false };
  else filter.reviewId = { $type: 10 };
  return filter;
}

function batchAssignments(plan, batch) {
  const index = plan.batches.findIndex((candidate) => candidate.id === batch.id);
  if (index < 0) throw new ReviewIdMigrationError(`Unknown batch ${batch.id}`, "REPORT_INVALID");
  const offset = plan.batches.slice(0, index).reduce((sum, candidate) => sum + candidate.assignmentCount, 0);
  const entries = plan.assignments.slice(offset, offset + batch.assignmentCount);
  if (entries.length !== batch.assignmentCount || canonicalHash(entries) !== batch.assignmentsSha256) {
    throw new ReviewIdMigrationError(`Reviewed assignments for ${batch.id} do not match`, "REPORT_INVALID");
  }
  return entries;
}

function transactionUnavailable(error) {
  return error?.code === 20 || error?.codeName === "IllegalOperation" || /transaction numbers are only allowed|transactions are not supported/i.test(String(error?.message || ""));
}

function hasErrorLabel(error, label) {
  return Boolean(
    (typeof error?.hasErrorLabel === "function" && error.hasErrorLabel(label))
    || (Array.isArray(error?.errorLabels) && error.errorLabels.includes(label)),
  );
}

function unknownTransactionCommitResult(error) {
  return hasErrorLabel(error, "UnknownTransactionCommitResult");
}

function commitOutcomeUnknownError(cause) {
  const error = new ReviewIdMigrationError(
    "MongoDB could not confirm whether a review-ID transaction committed",
    "REVIEW_ID_MIGRATION_COMMIT_OUTCOME_UNKNOWN",
  );
  error.databaseCommitState = "unknown";
  error.cause = cause;
  return error;
}

async function runBatch({ entries, collection, startSession } = {}) {
  if (typeof startSession !== "function") throw new ReviewIdMigrationError("Mongo transactions are unavailable", "TRANSACTION_UNAVAILABLE");
  const session = await startSession();
  if (!session || typeof session.withTransaction !== "function") throw new ReviewIdMigrationError("Mongo transactions are unavailable", "TRANSACTION_UNAVAILABLE");
  let committed = false;
  let result = { updated: 0, alreadyApplied: 0 };
  let primaryError = null;
  try {
    await session.withTransaction(async () => {
      // withTransaction may replay this callback after a transient failure.
      // Keep only the final callback's counters in durable progress.
      const attempt = { updated: 0, alreadyApplied: 0 };
      for (const assignment of entries) {
        const update = await collection.updateOne(assignmentFilter(assignment), { $set: { reviewId: assignment.reviewId } }, { session });
        if (Number(update?.matchedCount ?? 0) === 1) {
          attempt.updated += 1;
          continue;
        }
        const current = await collection.findOne({ _id: new ObjectId(assignment.mongoId) }, { projection: { _id: 1, reviewId: 1 }, session });
        if (!current) throw new ReviewIdMigrationError("A planned review was deleted before its ID could be assigned", "REVIEW_TARGET_DELETED", [{ mongoId: assignment.mongoId }]);
        if (current.reviewId === assignment.reviewId) {
          attempt.alreadyApplied += 1;
          continue;
        }
        throw new ReviewIdMigrationError("A planned review ID changed before assignment", "REVIEW_ID_CONFLICT", [{ mongoId: assignment.mongoId, actualReviewId: reportValue(current.reviewId) }]);
      }
      result = attempt;
    });
    committed = true;
    return result;
  } catch (error) {
    primaryError = transactionUnavailable(error)
      ? new ReviewIdMigrationError("Mongo transactions are unavailable", "TRANSACTION_UNAVAILABLE")
      : unknownTransactionCommitResult(error)
        ? commitOutcomeUnknownError(error)
        : error;
    throw primaryError;
  } finally {
    try {
      await session.endSession?.();
    } catch (error) {
      if (primaryError?.databaseCommitState === "unknown") {
        error.databaseCommitState = "unknown";
        error.code = primaryError.code;
        error.cause = primaryError;
      }
      if (committed) {
        error.databaseCommitted = true;
        error.code = error.code || "REVIEW_ID_MIGRATION_COMMITTED_SESSION_CLEANUP_FAILED";
      }
      throw error;
    }
  }
}

function progressPathFor(reportPath) {
  return `${path.resolve(reportPath)}.apply-progress.json`;
}

function atomicOverwrite(filePath, contents) {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const temporary = path.join(path.dirname(resolved), `.${path.basename(resolved)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(temporary, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try {
    fs.renameSync(temporary, resolved);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function readProgress(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new ReviewIdMigrationError(`Could not read migration progress: ${error.message}`, "PROGRESS_READ_FAILED");
  }
}

function initializeProgress({ plan, progressPath, now = new Date() } = {}) {
  const existing = readProgress(progressPath);
  if (existing) {
    if (existing.planSha256 !== plan.planSha256 || existing.target?.database !== plan.target.database
      || existing.target?.collection?.namespace !== plan.target.collection.namespace) {
      throw new ReviewIdMigrationError("Migration progress belongs to a different reviewed plan", "PROGRESS_PLAN_MISMATCH");
    }
    return existing;
  }
  const progress = {
    schemaVersion: REPORT_VERSION,
    migration: "review-ids",
    planSha256: plan.planSha256,
    target: plan.target,
    startedAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    batches: [],
    index: { status: "pending" },
  };
  try {
    atomicOverwrite(progressPath, `${JSON.stringify(progress, null, 2)}\n`);
  } catch (error) {
    throw new ReviewIdMigrationError(`Could not write migration progress: ${error.message}`, "PROGRESS_WRITE_FAILED");
  }
  return progress;
}

function recordProgress(progress, progressPath, patch, now = new Date()) {
  const next = { ...progress, ...patch, updatedAt: new Date(now).toISOString() };
  try {
    atomicOverwrite(progressPath, `${JSON.stringify(next, null, 2)}\n`);
  } catch (error) {
    throw new ReviewIdMigrationError(`Could not write migration progress: ${error.message}`, "PROGRESS_WRITE_FAILED");
  }
  return next;
}

async function ensureUniqueReviewIdIndex(collection) {
  let indexes = [];
  try {
    indexes = await collection.listIndexes().toArray();
  } catch (error) {
    if (error.code !== 26 && error.codeName !== "NamespaceNotFound") throw error;
  }
  const existing = indexes.find((index) => index.name === REVIEW_ID_INDEX);
  if (existing) {
    if (canonicalEjson(existing.key) !== canonicalEjson({ reviewId: 1 }) || !existing.unique
      || existing.partialFilterExpression || existing.sparse) {
      throw new ReviewIdMigrationError("The existing reviewId index does not enforce the required unique identity contract", "REVIEW_ID_INDEX_CONTRACT_MISMATCH", [{ index: existing }]);
    }
    return { created: false, name: REVIEW_ID_INDEX };
  }
  try {
    const name = await collection.createIndex({ reviewId: 1 }, { name: REVIEW_ID_INDEX, unique: true });
    return { created: true, name };
  } catch (error) {
    if (error?.code === 11000 || error?.codeName === "DuplicateKey") {
      throw new ReviewIdMigrationError("The unique reviewId index could not be created because duplicate values remain", "REVIEW_ID_UNIQUE_INDEX_FAILED");
    }
    throw error;
  }
}

async function hasUniqueReviewIdIndex(collection) {
  try {
    const indexes = await collection.listIndexes().toArray();
    return indexes.some((index) => index.name === REVIEW_ID_INDEX && index.unique
      && canonicalEjson(index.key) === canonicalEjson({ reviewId: 1 })
      && !index.partialFilterExpression && !index.sparse);
  } catch (error) {
    if (error.code === 26 || error.codeName === "NamespaceNotFound") return false;
    throw error;
  }
}

async function verifyReviewIds({ db, collection, plan } = {}) {
  if (plan && !plan.blockers?.length) {
    validateReviewedPlan(plan);
    await assertTargetMatchesPlan({
      plan,
      db,
      collection,
      allowAssigned: true,
      allowCreatedEmptyCollection: !plan.target.collection.exists && plan.target.documentCount === 0,
    });
  }
  const rows = await readRawReviews(collection);
  const byReviewId = new Map();
  const issues = [];
  for (const row of rows) {
    const mongoId = idString(row._id);
    if (!isCanonicalUuidV4(row.reviewId)) {
      issues.push({ type: "invalid_or_missing_review_id", mongoId, actualReviewId: reportValue(row.reviewId) });
      continue;
    }
    const entries = byReviewId.get(row.reviewId) || [];
    entries.push(mongoId);
    byReviewId.set(row.reviewId, entries);
  }
  for (const [reviewId, mongoIds] of byReviewId.entries()) {
    if (mongoIds.length > 1) issues.push({ type: "duplicate_review_id", reviewId, mongoIds });
  }
  const uniqueIndex = await hasUniqueReviewIdIndex(collection);
  if (!uniqueIndex) issues.push({ type: "missing_unique_review_id_index", index: REVIEW_ID_INDEX });
  return {
    valid: issues.length === 0,
    counts: { totalReviews: rows.length, validReviewIds: byReviewId.size, issues: issues.length },
    uniqueIndex,
    issues,
  };
}

async function applyPlan({ plan, db, collection, startSession, progressPath, now = () => new Date() } = {}) {
  validateReviewedPlan(plan);
  const resolvedProgressPath = progressPath || path.join(DEFAULT_REPORT_DIRECTORY, `${plan.planSha256}.apply-progress.json`);
  let committedBatches = 0;
  let databaseChanged = false;
  let progress;
  try {
    await assertTargetMatchesPlan({ plan, db, collection, allowAssigned: true });
    progress = initializeProgress({ plan, progressPath: resolvedProgressPath, now: now() });
    for (const batch of plan.batches) {
      const entries = batchAssignments(plan, batch);
      const result = await runBatch({ entries, collection, startSession });
      committedBatches += 1;
      databaseChanged = databaseChanged || result.updated > 0;
      const batches = [...(progress.batches || []).filter((entry) => entry.id !== batch.id), {
        id: batch.id,
        assignmentCount: batch.assignmentCount,
        updated: result.updated,
        alreadyApplied: result.alreadyApplied,
        committedAt: new Date(now()).toISOString(),
      }].sort((left, right) => left.id.localeCompare(right.id));
      progress = recordProgress(progress, resolvedProgressPath, { batches }, now());
    }
    const index = await ensureUniqueReviewIdIndex(collection);
    databaseChanged = databaseChanged || index.created;
    progress = recordProgress(progress, resolvedProgressPath, { index: { status: "verified", ...index } }, now());
    const verification = await verifyReviewIds({ db, collection, plan });
    if (!verification.valid) {
      throw new ReviewIdMigrationError("Review ID verification failed after applying the reviewed plan", "REVIEW_ID_VERIFICATION_FAILED", verification.issues);
    }
    progress = recordProgress(progress, resolvedProgressPath, { completedAt: new Date(now()).toISOString(), verification }, now());
    return { committedBatches, progressPath: resolvedProgressPath, verification };
  } catch (error) {
    const commitOutcomeUnknown = error.databaseCommitState === "unknown";
    if (databaseChanged || error.databaseCommitted || commitOutcomeUnknown) {
      if (!commitOutcomeUnknown) {
        error.databaseCommitted = true;
        if (error.code === "PROGRESS_WRITE_FAILED") error.code = "REVIEW_ID_MIGRATION_COMMITTED_PROGRESS_WRITE_FAILED";
        error.code = error.code || "REVIEW_ID_MIGRATION_COMMITTED_FAILED";
      }
    }
    throw error;
  }
}

async function main(argv = process.argv.slice(2), dependencies = {}) {
  let connectedHere = false;
  try {
    const options = parseArgs(argv);
    const output = dependencies.output || console;
    if (options.help) {
      output.log(USAGE);
      return 0;
    }
    const mongo = dependencies.mongoose || mongoose;
    if (!dependencies.skipConnect && mongo.connection?.readyState !== 1) {
      const mongoUri = dependencies.mongoUri || process.env.MONGO_URI;
      if (!mongoUri) throw new ReviewIdMigrationError("MONGO_URI is required", "MISSING_MONGO_URI");
      // The native collection below is the only reader/writer. Disable model
      // index creation too, so this inspection cannot alter target state.
      await mongo.connect(mongoUri, { autoIndex: false, autoCreate: false });
      connectedHere = true;
    }
    const db = dependencies.db || mongo.connection?.db;
    const collection = dependencies.collection || (dependencies.Review || Review).collection;
    if (!db || !collection) throw new ReviewIdMigrationError("A raw reviews collection connection is required", "MISSING_MONGO_URI");
    if (collectionName(collection) !== REVIEW_COLLECTION) {
      throw new ReviewIdMigrationError("Review-ID migration may only target the reviews collection", "TARGET_CONFIRMATION_FAILED");
    }
    if (options.confirmTarget && options.confirmTarget !== databaseName(db)) {
      throw new ReviewIdMigrationError("--confirm-target does not match the connected database", "TARGET_CONFIRMATION_FAILED", [{ confirmed: options.confirmTarget, connected: databaseName(db) }]);
    }

    if (options.mode === "dry-run") {
      const now = dependencies.now ? dependencies.now() : new Date();
      const report = await loadPlan({ db, collection, now, randomUuid: dependencies.randomUuid || crypto.randomUUID });
      const reportPath = options.report || defaultReportPath(now, dependencies.reportUuid || crypto.randomUUID);
      const artifact = writeReport(reportPath, report);
      output.log(JSON.stringify({ mode: "dry-run", report: artifact.path, checksum: artifact.sha256, planSha256: report.planSha256, counts: report.counts, blockers: report.blockers.length }, null, 2));
      return report.blockers.length ? 2 : 0;
    }

    const plan = options.reportProvided ? readReviewedReport(options.report) : null;
    if (options.mode === "apply") {
      const result = await applyPlan({
        plan,
        db,
        collection,
        startSession: dependencies.startSession || mongo.startSession?.bind(mongo),
        progressPath: progressPathFor(options.report),
        now: dependencies.now || (() => new Date()),
      });
      output.log(JSON.stringify({ mode: "apply", report: options.report, progress: result.progressPath, committedBatches: result.committedBatches, verification: result.verification }, null, 2));
      return 0;
    }

    const verification = await verifyReviewIds({ db, collection, plan });
    output.log(JSON.stringify({ mode: "verify", report: options.reportProvided ? options.report : null, ...verification }, null, 2));
    return verification.valid ? 0 : 2;
  } catch (error) {
    const output = dependencies.output || console;
    if (error.databaseCommitState === "unknown") {
      output.error(`${error.code || "REVIEW_ID_MIGRATION_COMMIT_OUTCOME_UNKNOWN"}: ${error.message}. MongoDB could not confirm the most recent commit; database changes may have committed. Do not treat this as a rollback.`);
    } else if (error.databaseCommitted) {
      output.error(`${error.code || "REVIEW_ID_MIGRATION_COMMITTED_FAILED"}: ${error.message}. Database changes were committed; do not treat this as a rollback.`);
    } else {
      output.error(`${error.code || "REVIEW_ID_MIGRATION_FAILED"}: ${error.message}`);
    }
    return 1;
  } finally {
    if (connectedHere) await (dependencies.mongoose || mongoose).disconnect();
  }
}

if (require.main === module) {
  main().then((exitCode) => { process.exitCode = exitCode; });
}

module.exports = {
  BATCH_SIZE,
  DEFAULT_REPORT_DIRECTORY,
  REVIEW_COLLECTION,
  REVIEW_ID_INDEX,
  REPORT_VERSION,
  ReviewIdMigrationError,
  applyPlan,
  assertTargetMatchesPlan,
  buildPlan,
  canonicalHash,
  defaultReportPath,
  getCollectionIdentity,
  isCanonicalUuidV4,
  loadPlan,
  main,
  parseArgs,
  planSha256,
  progressPathFor,
  readRawReviews,
  readReviewedReport,
  runBatch,
  validateReviewedPlan,
  verifyReviewIds,
  writeReport,
};
