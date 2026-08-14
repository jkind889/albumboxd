const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const AlbumCatalog = require("../models/AlbumCatalog");
const AlbumSubmission = require("../models/AlbumSubmission");
const { approveAlbumSubmission } = require("../routes/utils/approval");
const {
  findDuplicateSignals,
  normalizeSubmissionPayload,
  snapshotForSubmission,
} = require("../routes/utils/submissions");

let replSet;
const integrationEnabled = String(process.env.RUN_MONGO_INTEGRATION || "").toLowerCase() === "true";

function body(title = "Integration Album") {
  return normalizeSubmissionPayload({
    proposedMetadata: {
      title,
      artistCredits: [{ name: "Integration Artist" }],
      releaseType: "album",
      releaseDate: "2026",
    },
    supportingSources: [{ type: "other", url: "https://example.com/evidence" }],
    externalReferences: [],
  });
}

async function createSubmission(title) {
  const payload = body(title);
  const duplicate = await findDuplicateSignals(payload);
  const submittedAt = new Date();
  const submission = await AlbumSubmission.create({
    submissionId: crypto.randomUUID(),
    submittedByUserId: "integration-user",
    proposedMetadata: payload.proposedMetadata,
    supportingSources: payload.supportingSources,
    externalReferences: payload.externalReferences,
    normalizedFingerprint: duplicate.fingerprint,
    candidateAlbumCatalogId: duplicate.candidateAlbumCatalogId,
    candidateSubmissionIds: duplicate.candidateSubmissionIds,
    duplicateSignals: duplicate.duplicateSignals,
    status: "pending",
    currentRevision: 1,
    revisions: [snapshotForSubmission(payload, duplicate, submittedAt, 1)],
    moderationHistory: [{ actorUserId: "integration-user", action: "submitted", reason: "", createdAt: submittedAt }],
  });
  return submission;
}

async function setup() {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replSet.getUri(), { dbName: "rescened_phase2b" });
  await Promise.all([AlbumCatalog.syncIndexes(), AlbumSubmission.syncIndexes()]);
}

async function teardown() {
  if (mongoose.connection.readyState === 1) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
  if (replSet) await replSet.stop();
}

async function transactionalApprovalTest() {
  const submission = await createSubmission("Transaction Album");
  assert.equal(await AlbumCatalog.countDocuments({ title: "Transaction Album" }), 0);

  const result = await approveAlbumSubmission({
    submissionId: submission.submissionId,
    actorUserId: "moderator-user",
    confirmPossibleDuplicate: true,
    reason: "Verified integration evidence",
  });

  assert.equal(result.suggestion.status, "approved");
  assert.match(result.album.albumId, /^[0-9a-f-]{36}$/);
  assert.equal(await AlbumCatalog.countDocuments({ title: "Transaction Album" }), 1);
  const catalog = await AlbumCatalog.findOne({ albumId: result.album.albumId });
  assert.equal(catalog.cover, "");
  assert.equal(catalog.catalogSource, "community");
  assert.equal(catalog.fieldProvenance.title.source, "community");
  assert.equal(catalog.fieldProvenance.title.submissionId, submission.submissionId);
  const persisted = await AlbumSubmission.findOne({ submissionId: submission.submissionId });
  assert.equal(persisted.status, "approved");
  assert.ok(persisted.approvedAlbumCatalogId);
  assert.equal(persisted.moderationHistory.filter((event) => event.action === "approved").length, 1);
}

async function concurrentApprovalTest() {
  const submission = await createSubmission("Concurrent Album");
  const results = await Promise.all([
    approveAlbumSubmission({ submissionId: submission.submissionId, actorUserId: "moderator-a", confirmPossibleDuplicate: true }),
    approveAlbumSubmission({ submissionId: submission.submissionId, actorUserId: "moderator-b", confirmPossibleDuplicate: true }),
  ]);
  assert.equal(results[0].album.albumId, results[1].album.albumId);
  assert.equal(await AlbumCatalog.countDocuments({ title: "Concurrent Album" }), 1);
  const persisted = await AlbumSubmission.findOne({ submissionId: submission.submissionId });
  assert.equal(persisted.moderationHistory.filter((event) => event.action === "approved").length, 1);
}

async function rollbackTest() {
  const submission = await createSubmission("Rollback Album");
  const originalUpdate = AlbumSubmission.findOneAndUpdate;
  AlbumSubmission.findOneAndUpdate = async () => {
    throw new Error("forced approval failure");
  };
  try {
    await assert.rejects(
      approveAlbumSubmission({ submissionId: submission.submissionId, actorUserId: "moderator-user", confirmPossibleDuplicate: true }),
      /forced approval failure/,
    );
  } finally {
    AlbumSubmission.findOneAndUpdate = originalUpdate;
  }
  assert.equal(await AlbumCatalog.countDocuments({ title: "Rollback Album" }), 0);
  const persisted = await AlbumSubmission.findOne({ submissionId: submission.submissionId });
  assert.equal(persisted.status, "pending");
}

async function modelInvariantTest() {
  const submission = await createSubmission("Invariant Album");
  await assert.rejects(
    AlbumSubmission.findOneAndUpdate(
      { _id: submission._id },
      { $set: { status: "approved" } },
      { runValidators: true },
    ),
    /Approved submissions must reference/,
  );
  await assert.rejects(
    AlbumSubmission.findOneAndUpdate(
      { _id: submission._id },
      { $set: { revisions: [] } },
      { runValidators: true },
    ),
    /append-only/,
  );
}

if (integrationEnabled) {
  test.before(setup);
  test.after(teardown);
  test("transactional approval publishes a usable catalog album and keeps pending data private", transactionalApprovalTest);
  test("concurrent approval retries are idempotent and create one album", concurrentApprovalTest);
  test("approval rollback leaves no public catalog row", rollbackTest);
  test("submission query updates preserve status and append-only invariants", modelInvariantTest);
} else {
  test("transactional approval publishes a usable catalog album and keeps pending data private", { skip: "Set RUN_MONGO_INTEGRATION=true in an environment that permits local Mongo processes" }, () => {});
  test("concurrent approval retries are idempotent and create one album", { skip: "Set RUN_MONGO_INTEGRATION=true in an environment that permits local Mongo processes" }, () => {});
  test("approval rollback leaves no public catalog row", { skip: "Set RUN_MONGO_INTEGRATION=true in an environment that permits local Mongo processes" }, () => {});
  test("submission query updates preserve status and append-only invariants", { skip: "Set RUN_MONGO_INTEGRATION=true in an environment that permits local Mongo processes" }, () => {});
}
