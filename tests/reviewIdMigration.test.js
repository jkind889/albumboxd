const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { ObjectId } = require("bson");

const {
  applyPlan,
  buildPlan,
  loadPlan,
  parseArgs,
  readReviewedReport,
  runBatch,
  validateReviewedPlan,
  verifyReviewIds,
  writeReport,
} = require("../scripts/migrateReviewIds");

const EXISTING_REVIEW_ID = "123e4567-e89b-42d3-a456-426614174000";
const GENERATED_REVIEW_ID_ONE = "223e4567-e89b-42d3-a456-426614174000";
const GENERATED_REVIEW_ID_TWO = "323e4567-e89b-42d3-a456-426614174000";

function target(database = "review_id_test") {
  return {
    database,
    collection: {
      name: "reviews",
      namespace: `${database}.reviews`,
      exists: true,
      uuid: "review-collection-uuid",
    },
  };
}

function row(overrides = {}) {
  return {
    _id: new ObjectId(),
    userId: "user_1",
    albumCatalogId: new ObjectId(),
    reviewText: "A review that must never be written to the migration report.",
    rating: 4,
    date: new Date("2026-09-06T12:00:00.000Z"),
    ...overrides,
  };
}

function cloneRow(value) {
  return { ...value };
}

function fakeCollection(initialRows, { indexes = [] } = {}) {
  const rows = initialRows.map(cloneRow);
  const state = { findCalls: 0, updateCalls: [], indexes: [...indexes] };
  return {
    collectionName: "reviews",
    state,
    find() {
      state.findCalls += 1;
      return {
        sort() { return this; },
        toArray: async () => rows.map(cloneRow),
      };
    },
    async findOne(filter) {
      const found = rows.find((candidate) => String(candidate._id) === String(filter._id));
      return found ? cloneRow(found) : null;
    },
    async updateOne(filter, update) {
      state.updateCalls.push({ filter, update });
      const found = rows.find((candidate) => String(candidate._id) === String(filter._id));
      if (!found) return { matchedCount: 0 };
      const condition = filter.reviewId;
      if (condition?.$exists === false && Object.prototype.hasOwnProperty.call(found, "reviewId")) return { matchedCount: 0 };
      if (condition?.$type === 10 && (!Object.prototype.hasOwnProperty.call(found, "reviewId") || found.reviewId !== null)) return { matchedCount: 0 };
      Object.assign(found, update.$set);
      return { matchedCount: 1 };
    },
    listIndexes() {
      return { toArray: async () => state.indexes.map((index) => ({ ...index })) };
    },
    async createIndex(keys, options) {
      state.indexes.push({ key: keys, ...options });
      return options.name;
    },
  };
}

function fakeDatabase(database = "review_id_test") {
  return {
    databaseName: database,
    listCollections(query) {
      return {
        toArray: async () => (query.name === "reviews" ? [{ name: "reviews", info: { uuid: "review-collection-uuid" } }] : []),
      };
    },
  };
}

function fakeStartSession() {
  return Promise.resolve({
    async withTransaction(callback) { await callback(); },
    async endSession() {},
  });
}

function ambiguousCommitStartSession() {
  return Promise.resolve({
    async withTransaction(callback) {
      await callback();
      const error = new Error("timed out while waiting for the transaction commit result");
      error.errorLabels = ["UnknownTransactionCommitResult"];
      throw error;
    },
    async endSession() {},
  });
}

function retryingStartSession() {
  return Promise.resolve({
    async withTransaction(callback) {
      await callback();
      await callback();
    },
    async endSession() {},
  });
}

function uuidSequence(values) {
  let index = 0;
  return () => values[index++];
}

test("review-ID migration arguments default to dry-run and require a reviewed report for apply", () => {
  assert.deepEqual(parseArgs([]), {
    mode: "dry-run",
    report: "",
    reportProvided: false,
    confirmTarget: "",
    help: false,
  });
  assert.deepEqual(parseArgs(["--apply", "--report", "plan.json", "--confirm-target", "rescened"]), {
    mode: "apply",
    report: path.resolve("plan.json"),
    reportProvided: true,
    confirmTarget: "rescened",
    help: false,
  });
  assert.throws(() => parseArgs(["--apply", "--confirm-target", "rescened"]), (error) => error.code === "REPORT_REQUIRED");
  assert.throws(() => parseArgs(["--apply", "--report", "plan.json"]), (error) => error.code === "TARGET_CONFIRMATION_REQUIRED");
  assert.throws(() => parseArgs(["--dry-run", "--verify"]), (error) => error.code === "INVALID_ARGUMENTS");
  assert.throws(() => parseArgs(["--dry-run", "--confirm-target", "rescened"]), (error) => error.code === "INVALID_ARGUMENTS");
});

test("dry-run planning preserves stored UUIDs and generates deterministic assignments only for absent or null values", () => {
  const existing = row({ reviewId: EXISTING_REVIEW_ID });
  const missing = row();
  const nullValue = row({ reviewId: null });
  const plan = buildPlan({
    rows: [nullValue, existing, missing],
    target: target(),
    now: new Date("2026-09-06T13:00:00.000Z"),
    randomUuid: uuidSequence([GENERATED_REVIEW_ID_ONE, GENERATED_REVIEW_ID_TWO]),
  });

  assert.equal(plan.counts.totalReviews, 3);
  assert.equal(plan.counts.existingReviewIds, 1);
  assert.equal(plan.counts.missingReviewIds, 1);
  assert.equal(plan.counts.nullReviewIds, 1);
  assert.equal(plan.counts.assignments, 2);
  assert.equal(plan.blockers.length, 0);
  assert.deepEqual(plan.existingReviewIds, [{ mongoId: String(existing._id), reviewId: EXISTING_REVIEW_ID }]);
  assert.deepEqual(plan.assignments.map((entry) => entry.expectedReviewIdState).sort(), ["missing", "null"]);
  assert.deepEqual(plan.assignments.map((entry) => entry.reviewId), [GENERATED_REVIEW_ID_ONE, GENERATED_REVIEW_ID_TWO]);
  assert.equal(plan.target.documentCount, 3);
  assert.match(plan.target.reviewStateSha256, /^[0-9a-f]{64}$/);
  assert.match(plan.target.reviewContentSha256, /^[0-9a-f]{64}$/);
  assert.match(plan.planSha256, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(plan).includes(existing.reviewText), false);
});

test("dry-run planning blocks malformed and duplicate stored UUIDs", () => {
  const duplicateOne = row({ reviewId: EXISTING_REVIEW_ID });
  const duplicateTwo = row({ reviewId: EXISTING_REVIEW_ID });
  const malformed = row({ reviewId: EXISTING_REVIEW_ID.toUpperCase() });
  const plan = buildPlan({
    rows: [duplicateOne, duplicateTwo, malformed],
    target: target(),
    randomUuid: uuidSequence([GENERATED_REVIEW_ID_ONE]),
  });

  assert.equal(plan.blockers.length, 2);
  assert.ok(plan.blockers.some((entry) => entry.type === "duplicate_review_id"));
  assert.ok(plan.blockers.some((entry) => entry.type === "invalid_review_id"));
  assert.throws(() => validateReviewedPlan(plan), (error) => error.code === "BLOCKING_REVIEW_IDS");
});

test("sealed reports include an exact file checksum and reject changed content", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rescened-review-id-report-"));
  const reportPath = path.join(directory, "plan.json");
  const plan = buildPlan({
    rows: [row()],
    target: target(),
    randomUuid: uuidSequence([GENERATED_REVIEW_ID_ONE]),
  });
  try {
    const artifact = writeReport(reportPath, plan);
    assert.equal(fs.existsSync(artifact.path), true);
    assert.equal(fs.existsSync(artifact.checksumPath), true);
    assert.equal(readReviewedReport(reportPath).planSha256, plan.planSha256);
    assert.throws(() => writeReport(reportPath, plan), (error) => error.code === "REPORT_EXISTS");

    fs.appendFileSync(reportPath, " ", "utf8");
    assert.throws(() => readReviewedReport(reportPath), (error) => error.code === "REPORT_CHECKSUM_MISMATCH");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("the native collection plan can be applied idempotently in guarded batches and then verified", async () => {
  const rows = [row(), row({ reviewId: null }), row({ reviewId: EXISTING_REVIEW_ID })];
  const collection = fakeCollection(rows);
  const db = fakeDatabase();
  const plan = await loadPlan({
    db,
    collection,
    now: new Date("2026-09-06T13:00:00.000Z"),
    randomUuid: uuidSequence([GENERATED_REVIEW_ID_ONE, GENERATED_REVIEW_ID_TWO]),
  });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rescened-review-id-apply-"));
  const progressPath = path.join(directory, "progress.json");
  try {
    const result = await applyPlan({
      plan,
      db,
      collection,
      startSession: fakeStartSession,
      progressPath,
      now: () => new Date("2026-09-06T14:00:00.000Z"),
    });
    assert.equal(result.committedBatches, 1);
    assert.equal(result.verification.valid, true);
    assert.equal(collection.state.findCalls > 0, true);
    assert.equal(collection.state.updateCalls.length, 2);
    assert.equal(collection.state.indexes.some((index) => index.name === "reviewId_1" && index.unique), true);
    const progress = JSON.parse(fs.readFileSync(progressPath, "utf8"));
    assert.equal(progress.batches[0].assignmentCount, 2);
    assert.equal(progress.index.status, "verified");

    const retried = await applyPlan({
      plan,
      db,
      collection,
      startSession: fakeStartSession,
      progressPath,
      now: () => new Date("2026-09-06T14:01:00.000Z"),
    });
    assert.equal(retried.verification.valid, true);
    assert.equal(collection.state.updateCalls.length, 4);
    const verification = await verifyReviewIds({ db, collection, plan });
    assert.equal(verification.valid, true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("an ambiguous transaction commit is surfaced as potentially committed and can be retried safely", async () => {
  const collection = fakeCollection([row(), row({ reviewId: null })]);
  const db = fakeDatabase();
  const plan = await loadPlan({
    db,
    collection,
    randomUuid: uuidSequence([GENERATED_REVIEW_ID_ONE, GENERATED_REVIEW_ID_TWO]),
  });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rescened-review-id-ambiguous-"));
  const progressPath = path.join(directory, "progress.json");
  try {
    await assert.rejects(
      applyPlan({ plan, db, collection, startSession: ambiguousCommitStartSession, progressPath }),
      (error) => error.code === "REVIEW_ID_MIGRATION_COMMIT_OUTCOME_UNKNOWN" && error.databaseCommitState === "unknown",
    );
    assert.deepEqual(JSON.parse(fs.readFileSync(progressPath, "utf8")).batches, []);

    const retried = await applyPlan({ plan, db, collection, startSession: fakeStartSession, progressPath });
    assert.equal(retried.verification.valid, true);
    assert.equal(retried.progressPath, progressPath);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("transaction callback retries retain only the final attempt's progress counters", async () => {
  const collection = fakeCollection([row(), row({ reviewId: null })]);
  const plan = await loadPlan({
    db: fakeDatabase(),
    collection,
    randomUuid: uuidSequence([GENERATED_REVIEW_ID_ONE, GENERATED_REVIEW_ID_TWO]),
  });

  const result = await runBatch({
    entries: plan.assignments,
    collection,
    startSession: retryingStartSession,
  });

  assert.deepEqual(result, { updated: 0, alreadyApplied: 2 });
  assert.equal(collection.state.updateCalls.length, 4);
});

test("verification reports missing values, duplicates, and a missing unique index without mutating rows", async () => {
  const first = row({ reviewId: EXISTING_REVIEW_ID });
  const second = row({ reviewId: EXISTING_REVIEW_ID });
  const collection = fakeCollection([first, second, row()]);
  const verification = await verifyReviewIds({ db: fakeDatabase(), collection });

  assert.equal(verification.valid, false);
  assert.ok(verification.issues.some((entry) => entry.type === "duplicate_review_id"));
  assert.ok(verification.issues.some((entry) => entry.type === "invalid_or_missing_review_id"));
  assert.ok(verification.issues.some((entry) => entry.type === "missing_unique_review_id_index"));
  assert.equal(collection.state.updateCalls.length, 0);
});
