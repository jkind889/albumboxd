const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const AlbumCatalog = require("../models/AlbumCatalog");
const AlbumSubmission = require("../models/AlbumSubmission");
const { createCoverArtResolver } = require("../lib/coverArtArchive");
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

async function createSubmission(title, customize = (payload) => payload) {
  const payload = customize(body(title));
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

function providerResponse(data, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[String(name).toLowerCase()] || null },
    async json() { return data; },
  };
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
    coverResolver: null,
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
    approveAlbumSubmission({ submissionId: submission.submissionId, actorUserId: "moderator-a", confirmPossibleDuplicate: true, coverResolver: null }),
    approveAlbumSubmission({ submissionId: submission.submissionId, actorUserId: "moderator-b", confirmPossibleDuplicate: true, coverResolver: null }),
  ]);
  assert.equal(results[0].album.albumId, results[1].album.albumId);
  assert.equal(await AlbumCatalog.countDocuments({ title: "Concurrent Album" }), 1);
  const persisted = await AlbumSubmission.findOne({ submissionId: submission.submissionId });
  assert.equal(persisted.moderationHistory.filter((event) => event.action === "approved").length, 1);
}

async function automaticCoverApprovalTest() {
  const groupMbid = "11111111-1111-4111-8111-111111111111";
  const releaseMbid = "22222222-2222-4222-8222-222222222222";
  const submission = await createSubmission("CAA Transaction Album", (payload) => ({
    ...payload,
    supportingSources: [{
      type: "musicbrainz",
      url: `https://musicbrainz.org/release-group/${groupMbid}`,
      description: "Canonical release group",
    }],
  }));
  const calls = [];
  const resolver = createCoverArtResolver({
    clock: () => new Date("2026-08-26T12:00:00.000Z"),
    fetchFn: async (url, options) => {
      calls.push({ url, method: options.method });
      if (options.method === "GET" && url === `https://coverartarchive.org/release-group/${groupMbid}`) {
        return providerResponse({
          release: `https://musicbrainz.org/release/${releaseMbid}`,
          images: [{
            approved: true,
            front: true,
            id: "12345",
            thumbnails: { "500": `https://coverartarchive.org/release/${releaseMbid}/12345-500.jpg` },
          }],
        });
      }
      if (options.method === "HEAD" && url === `https://coverartarchive.org/release/${releaseMbid}/front-500`) {
        return providerResponse(null, 200, { "content-type": "image/jpeg" });
      }
      throw new Error(`Unexpected provider request: ${options.method} ${url}`);
    },
  });

  const first = await approveAlbumSubmission({
    submissionId: submission.submissionId,
    actorUserId: "moderator-user",
    confirmPossibleDuplicate: true,
    coverResolver: resolver.resolve,
  });
  const persisted = await AlbumCatalog.findOne({ albumId: first.album.albumId }).lean();
  assert.equal(persisted.cover, `https://coverartarchive.org/release/${releaseMbid}/front-500`);
  assert.equal(persisted.fieldProvenance.cover.source, "cover-art-archive");
  assert.equal(persisted.fieldProvenance.cover.releaseGroupMbid, groupMbid);
  assert.equal(persisted.fieldProvenance.cover.releaseMbid, releaseMbid);
  assert.equal(persisted.externalReferences.some((reference) => reference.externalId === groupMbid), true);
  assert.equal(persisted.externalReferences.some((reference) => reference.externalId === releaseMbid), true);

  const retry = await approveAlbumSubmission({
    submissionId: submission.submissionId,
    actorUserId: "moderator-user",
    coverResolver: async () => { throw new Error("idempotent retries must not resolve artwork"); },
  });
  assert.equal(retry.idempotent, true);
  assert.equal(retry.album.albumId, first.album.albumId);
  assert.equal(calls.length, 2);
}

async function rollbackTest() {
  const submission = await createSubmission("Rollback Album");
  const originalUpdate = AlbumSubmission.findOneAndUpdate;
  AlbumSubmission.findOneAndUpdate = async () => {
    throw new Error("forced approval failure");
  };
  try {
    await assert.rejects(
      approveAlbumSubmission({ submissionId: submission.submissionId, actorUserId: "moderator-user", confirmPossibleDuplicate: true, coverResolver: null }),
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
  test("approval persists mocked Cover Art Archive resolution and exact references", automaticCoverApprovalTest);
  test("approval rollback leaves no public catalog row", rollbackTest);
  test("submission query updates preserve status and append-only invariants", modelInvariantTest);
} else {
  test("transactional approval publishes a usable catalog album and keeps pending data private", { skip: "Set RUN_MONGO_INTEGRATION=true in an environment that permits local Mongo processes" }, () => {});
  test("concurrent approval retries are idempotent and create one album", { skip: "Set RUN_MONGO_INTEGRATION=true in an environment that permits local Mongo processes" }, () => {});
  test("approval persists mocked Cover Art Archive resolution and exact references", { skip: "Set RUN_MONGO_INTEGRATION=true in an environment that permits local Mongo processes" }, () => {});
  test("approval rollback leaves no public catalog row", { skip: "Set RUN_MONGO_INTEGRATION=true in an environment that permits local Mongo processes" }, () => {});
  test("submission query updates preserve status and append-only invariants", { skip: "Set RUN_MONGO_INTEGRATION=true in an environment that permits local Mongo processes" }, () => {});
}
