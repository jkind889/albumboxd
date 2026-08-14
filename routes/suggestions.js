const express = require("express");
const { getAuth } = require("@clerk/express");
const AlbumSubmission = require("../models/AlbumSubmission");
const {
  SubmissionValidationError,
  cursorFilter,
  decodeCursor,
  encodeCursor,
  findDuplicateSignals,
  getPageLimit,
  isModerator,
  isSubmissionsEnabled,
  normalizeSubmissionPayload,
  serializeSubmission,
  snapshotForSubmission,
} = require("./utils/submissions");
const {
  submissionCreateRateLimit,
  submissionMutationRateLimit,
} = require("./utils/rateLimit");

const router = express.Router();

function viewer(req) {
  try {
    return getAuth(req).userId || "";
  } catch {
    return "";
  }
}

function auth(req, res, next) {
  const userId = viewer(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  req.userId = userId;
  return next();
}

function submissionsEnabled(req, res, next) {
  if (!isSubmissionsEnabled()) {
    return res.status(503).json({ error: "Community submissions are currently disabled", code: "SUBMISSIONS_DISABLED" });
  }
  return next();
}

function sendRouteError(res, error, fallback) {
  if (error instanceof SubmissionValidationError || error?.code === "INVALID_CURSOR") {
    const body = { error: error.message, code: error.code || "INVALID_SUBMISSION" };
    if (error.details?.length) body.details = error.details;
    return res.status(400).json(body);
  }
  if (error?.name === "ValidationError" || error?.name === "CastError") {
    return res.status(400).json({ error: "Submission data is invalid", code: "INVALID_SUBMISSION" });
  }
  if (error?.status && error.status >= 400 && error.status < 500) {
    return res.status(error.status).json({ error: error.message, code: error.code });
  }
  return res.status(500).json({ error: fallback });
}

async function findSubmission(query) {
  let result = AlbumSubmission.findOne(query);
  if (result && typeof result.populate === "function") {
    result = result.populate("candidateAlbumCatalogId").populate("approvedAlbumCatalogId");
  }
  return result;
}

function submissionUpdate(payload, duplicate, revision, status) {
  return {
    proposedMetadata: payload.proposedMetadata,
    supportingSources: payload.supportingSources,
    externalReferences: payload.externalReferences,
    normalizedFingerprint: duplicate.fingerprint,
    candidateAlbumCatalogId: duplicate.candidateAlbumCatalogId || null,
    candidateSubmissionIds: duplicate.candidateSubmissionIds,
    duplicateSignals: duplicate.duplicateSignals,
    currentRevision: revision,
    status,
  };
}

router.post("/", auth, submissionsEnabled, submissionCreateRateLimit, async (req, res) => {
  try {
    const payload = normalizeSubmissionPayload(req.body);
    const duplicate = await findDuplicateSignals(payload);
    const submittedAt = new Date();
    const snapshot = snapshotForSubmission(payload, duplicate, submittedAt, 1);
    const submission = await AlbumSubmission.create({
      submittedByUserId: req.userId,
      ...submissionUpdate(payload, duplicate, 1, "pending"),
      revisions: [snapshot],
      moderationHistory: [{ actorUserId: req.userId, action: "submitted", reason: "", createdAt: submittedAt }],
    });
    return res.status(201).json(serializeSubmission(submission, { detail: true }));
  } catch (error) {
    return sendRouteError(res, error, "Failed to create suggestion");
  }
});

router.get("/mine", auth, async (req, res) => {
  try {
    const queryParams = req.query || {};
    const cursor = decodeCursor(queryParams.cursor);
    const limit = getPageLimit(queryParams.limit);
    const query = { submittedByUserId: req.userId, ...cursorFilter(cursor) };
    const rows = await AlbumSubmission.find(query).sort({ createdAt: -1, _id: -1 }).limit(limit + 1);
    const hasNextPage = rows.length > limit;
    const page = hasNextPage ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    return res.json({
      suggestions: page.map((submission) => serializeSubmission(submission)),
      nextCursor: hasNextPage && last ? encodeCursor(last.createdAt, last._id) : null,
    });
  } catch (error) {
    return sendRouteError(res, error, "Failed to fetch suggestions");
  }
});

router.get("/:submissionId", auth, async (req, res) => {
  try {
    const submission = await findSubmission({ submissionId: req.params.submissionId });
    if (!submission) return res.status(404).json({ error: "Suggestion not found" });
    if (submission.submittedByUserId !== req.userId && !isModerator(req.userId)) {
      return res.status(404).json({ error: "Suggestion not found" });
    }
    return res.json(serializeSubmission(submission, { detail: true }));
  } catch (error) {
    return sendRouteError(res, error, "Failed to fetch suggestion");
  }
});

router.post("/:submissionId/revise", auth, submissionsEnabled, submissionMutationRateLimit, async (req, res) => {
  try {
    const current = await AlbumSubmission.findOne({ submissionId: req.params.submissionId });
    if (!current || current.submittedByUserId !== req.userId) return res.status(404).json({ error: "Suggestion not found" });
    if (current.status !== "needs_changes") {
      return res.status(409).json({ error: "Only suggestions needing changes can be revised", code: "INVALID_SUBMISSION_STATE" });
    }
    const payload = normalizeSubmissionPayload(req.body);
    const duplicate = await findDuplicateSignals(payload, { excludeSubmissionId: current._id });
    const revision = current.currentRevision + 1;
    const submittedAt = new Date();
    const snapshot = snapshotForSubmission(payload, duplicate, submittedAt, revision);
    const updated = await AlbumSubmission.findOneAndUpdate(
      { submissionId: req.params.submissionId, submittedByUserId: req.userId, status: "needs_changes", currentRevision: current.currentRevision },
      {
        $set: submissionUpdate(payload, duplicate, revision, "pending"),
        $push: {
          revisions: snapshot,
          moderationHistory: { actorUserId: req.userId, action: "revised", reason: "", createdAt: submittedAt },
        },
      },
      { returnDocument: "after", runValidators: true },
    );
    if (!updated) return res.status(409).json({ error: "Suggestion changed while it was being revised", code: "REVISION_CONFLICT" });
    return res.json(serializeSubmission(updated, { detail: true }));
  } catch (error) {
    return sendRouteError(res, error, "Failed to revise suggestion");
  }
});

router.post("/:submissionId/withdraw", auth, submissionsEnabled, submissionMutationRateLimit, async (req, res) => {
  try {
    const current = await AlbumSubmission.findOne({ submissionId: req.params.submissionId });
    if (!current || current.submittedByUserId !== req.userId) return res.status(404).json({ error: "Suggestion not found" });
    if (!["pending", "needs_changes"].includes(current.status)) {
      return res.status(409).json({ error: "Only active suggestions can be withdrawn", code: "INVALID_SUBMISSION_STATE" });
    }
    const updated = await AlbumSubmission.findOneAndUpdate(
      { submissionId: req.params.submissionId, submittedByUserId: req.userId, status: { $in: ["pending", "needs_changes"] } },
      {
        $set: { status: "withdrawn" },
        $push: { moderationHistory: { actorUserId: req.userId, action: "withdrawn", reason: "", createdAt: new Date() } },
      },
      { returnDocument: "after", runValidators: true },
    );
    if (!updated) return res.status(409).json({ error: "Suggestion changed while it was being withdrawn", code: "STATE_CONFLICT" });
    return res.json(serializeSubmission(updated, { detail: true }));
  } catch (error) {
    return sendRouteError(res, error, "Failed to withdraw suggestion");
  }
});

module.exports = router;
