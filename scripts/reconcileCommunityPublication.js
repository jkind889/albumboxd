#!/usr/bin/env node

/*
 * Reconcile fields introduced by the approved-submission feed and catalog
 * correction workflow. The default mode is read-only and writes a reviewable
 * report. Applying a report requires an explicit database-name confirmation;
 * this command never guesses at ambiguous historical approvals.
 */

require("dotenv").config({ quiet: true });

const fs = require("node:fs");
const path = require("node:path");
const mongoose = require("mongoose");
const AlbumCatalog = require("../models/AlbumCatalog");
const AlbumSubmission = require("../models/AlbumSubmission");

const DEFAULT_REPORT_PATH = path.resolve(".migration", "community-state", "reconciliation-report.json");
const PUBLICATION_TYPES = new Set(["catalog_created", "catalog_linked", "catalog_corrected"]);

const USAGE = `Usage:
  npm run db:reconcile-community-state -- --dry-run [--report <path>]
  npm run db:reconcile-community-state -- --apply --confirm-target <database> --report <path>

Options:
  --dry-run                 Read and report only (default)
  --apply                   Apply the generated plan in one Mongo transaction
  --confirm-target <name>   Required with --apply; must match the connected database name
  --report <path>           JSON report path (default: ${DEFAULT_REPORT_PATH})
  --help                    Show this help`;

class ReconciliationError extends Error {
  constructor(message, code = "COMMUNITY_RECONCILIATION_FAILED", details = []) {
    super(message);
    this.name = "ReconciliationError";
    this.code = code;
    this.details = details;
  }
}

function parseArgs(argv = []) {
  const options = { apply: false, dryRun: true, confirmTarget: "", report: DEFAULT_REPORT_PATH, reportProvided: false, help: false };
  let mode = "";

  function readValue(index, flag) {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new ReconciliationError(`${flag} requires a value`, "INVALID_ARGUMENTS");
    return value;
  }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dry-run" || argument === "--apply") {
      if (mode) throw new ReconciliationError("--apply and --dry-run may only be specified once", "INVALID_ARGUMENTS");
      mode = argument;
      options.apply = argument === "--apply";
      options.dryRun = !options.apply;
    } else if (argument === "--confirm-target") {
      options.confirmTarget = readValue(index, argument);
      index += 1;
    } else if (argument === "--report") {
      options.report = path.resolve(readValue(index, argument));
      options.reportProvided = true;
      index += 1;
    } else if (argument === "--help") {
      options.help = true;
    } else {
      throw new ReconciliationError(`Unknown argument: ${argument}`, "INVALID_ARGUMENTS");
    }
  }

  if (options.apply && !options.confirmTarget) {
    throw new ReconciliationError("--apply requires --confirm-target <database>", "TARGET_CONFIRMATION_REQUIRED");
  }
  if (options.apply && !options.reportProvided) {
    throw new ReconciliationError("--apply requires the reviewed dry-run report via --report <path>", "REPORT_REQUIRED");
  }
  return options;
}

function plain(value) {
  if (value && typeof value.toObject === "function") return value.toObject({ depopulate: true, versionKey: false });
  return value || {};
}

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function idString(value) {
  if (value === null || value === undefined) return "";
  return typeof value.toHexString === "function" ? value.toHexString() : String(value);
}

function validDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return !Number.isNaN(date.valueOf());
}

function eventApprovedAt(submission) {
  const events = (submission.moderationHistory || []).filter((event) => event.action === "approved");
  if (events.length !== 1 || !validDate(events[0].createdAt)) return null;
  return new Date(events[0].createdAt);
}

function communityProvenanceBelongsTo(provenance, submissionId) {
  return Object.values(provenance || {}).some((entry) => entry && entry.submissionId === submissionId);
}

function historicalPublicationType(submission, album) {
  const source = plain(submission);
  if (source.submissionType === "catalog_correction") return "catalog_corrected";
  return communityProvenanceBelongsTo(plain(album).fieldProvenance, source.submissionId)
    ? "catalog_created"
    : "catalog_linked";
}

function buildPlan({ albums = [], submissions = [], now = new Date() } = {}) {
  const catalogUpdates = [];
  const submissionUpdates = [];
  const ambiguous = [];

  albums.forEach((row) => {
    const album = plain(row);
    const revision = Number(album.catalogRevision);
    if (!Number.isInteger(revision) || revision < 1) {
      if (album.catalogRevision !== undefined && album.catalogRevision !== null) {
        ambiguous.push({
          albumId: album.albumId || idString(album._id),
          reason: "catalogRevision is present but is not a positive integer",
        });
      } else {
        catalogUpdates.push({
          id: idString(album._id),
          albumId: album.albumId || null,
          expectedRevision: null,
          set: { catalogRevision: 1 },
        });
      }
    }
  });

  submissions.forEach((row) => {
    const submission = plain(row);
    const approvedAt = eventApprovedAt(submission);
    const currentApprovedAt = submission.approvedAt;
    const currentType = submission.approvalPublicationType;

    if (!approvedAt || (currentApprovedAt && !validDate(currentApprovedAt))) {
      ambiguous.push({
        submissionId: submission.submissionId || idString(submission._id),
        reason: !approvedAt ? "expected exactly one approved moderation event with a valid timestamp" : "approvedAt is invalid",
      });
      return;
    }

    if (currentApprovedAt && new Date(currentApprovedAt).getTime() !== approvedAt.getTime()) {
      ambiguous.push({
        submissionId: submission.submissionId || idString(submission._id),
        reason: "stored approvedAt differs from the append-only approved event",
      });
      return;
    }

    const album = plain(submission.approvedAlbumCatalogId);
    if (!album._id || !album.albumId) {
      ambiguous.push({
        submissionId: submission.submissionId || idString(submission._id),
        reason: "approved submission does not have a usable populated catalog album",
      });
      return;
    }

    const publicationType = historicalPublicationType(submission, album);
    if (currentType && currentType !== publicationType) {
      ambiguous.push({
        submissionId: submission.submissionId || idString(submission._id),
        reason: `stored publication type ${currentType} conflicts with durable catalog evidence ${publicationType}`,
      });
      return;
    }
    if (currentType && !PUBLICATION_TYPES.has(currentType)) {
      ambiguous.push({
        submissionId: submission.submissionId || idString(submission._id),
        reason: "stored publication type is not supported",
      });
      return;
    }

    const set = {};
    if (!currentApprovedAt) set.approvedAt = approvedAt;
    if (!currentType) set.approvalPublicationType = publicationType;
    if (Object.keys(set).length) {
      submissionUpdates.push({
        id: idString(submission._id),
        submissionId: submission.submissionId || null,
        expectedApprovedAt: currentApprovedAt || null,
        expectedPublicationType: currentType || null,
        set,
      });
    }
  });

  return {
    generatedAt: now.toISOString(),
    catalogUpdates,
    submissionUpdates,
    ambiguous,
    counts: {
      catalogRevisionInitializations: catalogUpdates.length,
      approvalMetadataUpdates: submissionUpdates.length,
      ambiguous: ambiguous.length,
    },
  };
}

function writeReport(reportPath, report) {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  const temporary = `${reportPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, reportPath);
}

function readReviewedReport(reportPath) {
  let report;
  try {
    report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  } catch (error) {
    throw new ReconciliationError(`Could not read review report: ${error.message}`, "REPORT_READ_FAILED");
  }
  if (report?.mode !== "dry-run") {
    throw new ReconciliationError("Apply requires a dry-run report; the supplied report is not reviewable", "REPORT_NOT_REVIEWABLE");
  }
  if (!Array.isArray(report.catalogUpdates) || !Array.isArray(report.submissionUpdates) || !Array.isArray(report.ambiguous)) {
    throw new ReconciliationError("The review report has an invalid reconciliation plan", "REPORT_INVALID");
  }
  if (report.ambiguous.length) {
    throw new ReconciliationError("Ambiguous historical records require review before apply", "AMBIGUOUS_RECONCILIATION", report.ambiguous);
  }
  return report;
}

async function loadPlan({ AlbumCatalog: Catalog = AlbumCatalog, AlbumSubmission: Submission = AlbumSubmission, now } = {}) {
  const albums = await Catalog.find({}).lean();
  const submissions = await Submission.find({ status: "approved" }).populate("approvedAlbumCatalogId").lean();
  return buildPlan({ albums, submissions, now });
}

async function applyPlan({ plan, db = mongoose, AlbumCatalog: Catalog = AlbumCatalog, AlbumSubmission: Submission = AlbumSubmission } = {}) {
  if (!plan || !Array.isArray(plan.catalogUpdates) || !Array.isArray(plan.submissionUpdates) || plan.ambiguous?.length) {
    throw new ReconciliationError("A reviewed, unambiguous reconciliation plan is required", "REPORT_NOT_REVIEWABLE");
  }
  if (!db || typeof db.startSession !== "function") {
    throw new ReconciliationError("Mongo transactions are unavailable", "TRANSACTION_UNAVAILABLE");
  }
  const session = await db.startSession();
  let committed = false;
  try {
    if (typeof session.withTransaction !== "function") {
      throw new ReconciliationError("Mongo transactions are unavailable", "TRANSACTION_UNAVAILABLE");
    }
    await session.withTransaction(async () => {
      for (const update of plan.catalogUpdates) {
        const filter = { _id: update.id };
        filter.catalogRevision = update.expectedRevision === null ? { $exists: false } : update.expectedRevision;
        const result = await Catalog.updateOne(filter, { $set: update.set }, { session });
        if (Number(result?.matchedCount ?? 0) !== 1) {
          throw new ReconciliationError("A catalog row changed during reconciliation", "CONCURRENT_RECONCILIATION", [update]);
        }
      }
      for (const update of plan.submissionUpdates) {
        const filter = { _id: update.id, status: "approved", approvedAt: update.expectedApprovedAt };
        filter.approvalPublicationType = update.expectedPublicationType;
        const result = await Submission.updateOne(filter, { $set: update.set }, { session });
        if (Number(result?.matchedCount ?? 0) !== 1) {
          throw new ReconciliationError("An approved submission changed during reconciliation", "CONCURRENT_RECONCILIATION", [update]);
        }
      }
    });
    committed = true;
    return { committed: true };
  } catch (error) {
    if (!committed && error.code === "TRANSACTION_ROLLED_BACK") throw error;
    throw error;
  } finally {
    try {
      await session.endSession?.();
    } catch (error) {
      if (committed) {
        error.databaseCommitted = true;
        error.code = error.code || "RECONCILIATION_COMMITTED_SESSION_CLEANUP_FAILED";
      }
      throw error;
    }
  }
}

async function main(argv = process.argv.slice(2), dependencies = {}) {
  let options;
  let connectedHere = false;
  try {
    options = parseArgs(argv);
    if (options.help) {
      (dependencies.output || console).log(USAGE);
      return 0;
    }
    const db = dependencies.mongoose || mongoose;
    if (db.connection?.readyState !== 1) {
      const mongoUri = dependencies.mongoUri || process.env.MONGO_URI;
      if (!mongoUri) throw new ReconciliationError("MONGO_URI is required", "MISSING_MONGO_URI");
      await db.connect(mongoUri);
      connectedHere = true;
    }
    if (options.apply && options.confirmTarget !== db.connection.name) {
      throw new ReconciliationError("--confirm-target does not match the connected database", "TARGET_CONFIRMATION_FAILED", [
        { confirmed: options.confirmTarget, connected: db.connection.name },
      ]);
    }

    let plan;
    if (options.apply) {
      plan = readReviewedReport(options.report);
    } else {
      plan = await (dependencies.loadPlan || loadPlan)({
        AlbumCatalog: dependencies.AlbumCatalog || AlbumCatalog,
        AlbumSubmission: dependencies.AlbumSubmission || AlbumSubmission,
        now: dependencies.now || new Date(),
      });
      writeReport(options.report, { mode: "dry-run", ...plan });
    }
    if (options.apply) {
      await applyPlan({
        plan,
        db,
        AlbumCatalog: dependencies.AlbumCatalog || AlbumCatalog,
        AlbumSubmission: dependencies.AlbumSubmission || AlbumSubmission,
      });
    }
    (dependencies.output || console).log(JSON.stringify({ mode: options.apply ? "apply" : "dry-run", counts: plan.counts, ambiguous: plan.ambiguous.length, report: options.report }, null, 2));
    return plan.ambiguous.length ? 2 : 0;
  } catch (error) {
    const output = dependencies.output || console;
    if (error.databaseCommitted) {
      output.error(`${error.code || "RECONCILIATION_COMMITTED_SESSION_CLEANUP_FAILED"}: ${error.message}. Database changes were committed; do not treat this as a rollback.`);
    } else {
      output.error(`${error.code || "COMMUNITY_RECONCILIATION_FAILED"}: ${error.message}`);
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
  DEFAULT_REPORT_PATH,
  PUBLICATION_TYPES,
  ReconciliationError,
  applyPlan,
  buildPlan,
  eventApprovedAt,
  historicalPublicationType,
  loadPlan,
  main,
  parseArgs,
};
