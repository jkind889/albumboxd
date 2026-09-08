const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const mongoose = require("mongoose");

const {
  guardedFilter,
  main,
  normalizedResolution,
  parseArgs,
  runBackfill,
} = require("../scripts/backfillMissingAlbumCovers");

const RELEASE_ONE = "59211ea4-ffd2-4ad9-9a4e-e4f9a8c2fdf1";
const RELEASE_TWO = "3da56899-5c99-4e4c-8050-c5f5210f12c6";

function album(overrides = {}) {
  return {
    _id: new mongoose.Types.ObjectId(),
    albumId: crypto.randomUUID(),
    title: "Test Album",
    artistDisplayName: "Test Artist",
    cover: "",
    externalReferences: [],
    fieldProvenance: {},
    updatedAt: new Date("2026-08-26T12:00:00.000Z"),
    ...overrides,
  };
}

function resolverResult(releaseMbid = RELEASE_ONE) {
  return {
    status: "resolved",
    cover: `https://coverartarchive.org/release/${releaseMbid}/front-500`,
    sourceReleaseMbid: releaseMbid,
    releaseGroupMbid: "b84ee12a-09ef-421b-82de-0441a926375b",
    imageId: 123,
    method: "release-group",
  };
}

function fakeModel({ updateResult = { acknowledged: true, matchedCount: 1 }, onUpdate } = {}) {
  const state = { updateCalls: [], ownerCalls: [] };
  return {
    state,
    findOne(query) {
      state.ownerCalls.push(query);
      return Promise.resolve(null);
    },
    updateOne(filter, update) {
      state.updateCalls.push({ filter, update });
      if (onUpdate) onUpdate(filter, update);
      return Promise.resolve(updateResult);
    },
  };
}

test("backfill argument parsing defaults to dry-run and rejects conflicting modes", () => {
  assert.deepEqual(parseArgs([]), { apply: false, dryRun: true, report: "", help: false });
  assert.deepEqual(parseArgs(["--apply", "--report", "report.json"]), {
    apply: true,
    dryRun: false,
    report: "report.json",
    help: false,
  });
  assert.throws(() => parseArgs(["--apply", "--dry-run"]), /cannot be used together/);
  assert.throws(() => parseArgs(["--report"]), /requires a value/);
});

test("dry-run resolves missing covers without writing", async () => {
  const rows = [album(), album({ cover: "   " })];
  const model = fakeModel();
  let calls = 0;
  const report = await runBackfill({}, {
    albums: rows,
    AlbumCatalog: model,
    resolveCoverArt: async () => {
      calls += 1;
      return resolverResult(calls === 1 ? RELEASE_ONE : RELEASE_TWO);
    },
    now: () => new Date("2026-08-26T13:00:00.000Z"),
  });
  assert.equal(report.mode, "dry-run");
  assert.equal(report.counts.resolved, 2);
  assert.equal(report.counts.updated, 0);
  assert.equal(model.state.updateCalls.length, 0);
  assert.equal(report.entries[0].cover.includes("front-500"), true);
});

test("apply uses blank-cover and updatedAt guards, provenance, and a safe release reference", async () => {
  const row = album();
  const model = fakeModel({
    onUpdate(_filter, update) {
      row.cover = update.$set.cover;
      row.fieldProvenance.cover = update.$set["fieldProvenance.cover"];
      row.externalReferences.push(...(update.$addToSet ? [update.$addToSet.externalReferences] : []));
    },
  });
  const report = await runBackfill({ apply: true }, {
    albums: [row],
    AlbumCatalog: model,
    resolveCoverArt: async () => resolverResult(),
    now: () => new Date("2026-08-26T13:00:00.000Z"),
  });
  assert.equal(report.mode, "apply");
  assert.equal(report.counts.updated, 1);
  assert.equal(model.state.updateCalls.length, 1);
  const operation = model.state.updateCalls[0];
  assert.equal(operation.filter._id, row._id);
  assert.equal(operation.filter.updatedAt, row.updatedAt);
  assert.ok(operation.filter.$or.some((clause) => clause.cover instanceof RegExp));
  assert.equal(operation.update.$set.cover, `https://coverartarchive.org/release/${RELEASE_ONE}/front-500`);
  assert.equal(operation.update.$set["fieldProvenance.cover"].source, "cover-art-archive");
  assert.equal(operation.update.$addToSet.externalReferences.externalId, RELEASE_ONE);
  assert.equal(row.cover.endsWith("front-500"), true);
});

test("manual/concurrent covers win and are reported as a conflict", async () => {
  const row = album();
  const model = fakeModel({ updateResult: { acknowledged: true, matchedCount: 0 } });
  const report = await runBackfill({ apply: true }, {
    albums: [row],
    AlbumCatalog: model,
    resolveCoverArt: async () => resolverResult(),
  });
  assert.equal(report.entries[0].status, "conflict");
  assert.equal(report.entries[0].reason, "concurrent_update");
  assert.equal(report.counts.concurrentUpdates, 1);
  assert.equal(report.counts.conflicts, 1);
});

test("reference conflicts do not append another album's release reference", async () => {
  const row = album();
  const owner = album({ cover: "existing-cover" });
  const model = fakeModel();
  const report = await runBackfill({ apply: true }, {
    albums: [row],
    AlbumCatalog: model,
    resolveCoverArt: async () => resolverResult(),
    findReferenceOwner: async () => owner,
  });
  assert.equal(report.entries[0].reason, "reference_conflict");
  assert.equal(report.counts.referenceConflicts, 1);
  assert.equal(report.counts.conflicts, 1);
  assert.equal(model.state.updateCalls.length, 0);
});

test("provider failures and unresolved rows continue and are included in the report", async () => {
  const rows = [album(), album(), album()];
  const model = fakeModel();
  const report = await runBackfill({}, {
    albums: rows,
    AlbumCatalog: model,
    resolveCoverArt: async (_row, context) => {
      assert.equal(context.timeoutMs, 15_000);
      if (_row === rows[0]) return { status: "unresolved", reason: "no_identity" };
      if (_row === rows[1]) throw Object.assign(new Error("temporary outage"), { code: "ETIMEDOUT" });
      return resolverResult();
    },
  });
  assert.equal(report.entries.length, 3);
  assert.equal(report.counts.unresolved, 1);
  assert.equal(report.counts.failures, 1);
  assert.equal(report.counts.resolved, 1);
  assert.equal(report.entries[1].reason, "transient_provider_failure");
});

test("metadata mismatches use the documented conflicting-identity report reason", async () => {
  const report = await runBackfill({}, {
    albums: [album()],
    AlbumCatalog: fakeModel(),
    resolveCoverArt: async () => ({ status: "unresolved", reason: "metadata_mismatch" }),
  });
  assert.equal(report.entries[0].reason, "conflicting_identity");
  assert.equal(report.counts.unresolved, 1);
});

test("the default backfill worker pool never exceeds four concurrent jobs", async () => {
  const rows = Array.from({ length: 9 }, () => album());
  let active = 0;
  let maximumActive = 0;
  const report = await runBackfill({}, {
    albums: rows,
    AlbumCatalog: fakeModel(),
    resolveCoverArt: async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
      return { status: "unresolved", reason: "no_identity" };
    },
  });
  assert.equal(report.entries.length, rows.length);
  assert.equal(maximumActive, 4);
});

test("a release-reference ownership race is reported without aborting later rows", async () => {
  const rows = [album(), album()];
  const model = fakeModel();
  model.updateOne = async (filter, update) => {
    model.state.updateCalls.push({ filter, update });
    if (update.$addToSet.externalReferences.externalId === RELEASE_ONE) {
      throw Object.assign(new Error("duplicate reference"), { code: 11000 });
    }
    return { acknowledged: true, matchedCount: 1 };
  };
  const report = await runBackfill({ apply: true }, {
    albums: rows,
    AlbumCatalog: model,
    resolveCoverArt: async (row) => resolverResult(row === rows[0] ? RELEASE_ONE : RELEASE_TWO),
  });
  assert.equal(report.entries[0].reason, "reference_conflict");
  assert.equal(report.entries[1].status, "updated");
  assert.equal(report.counts.referenceConflicts, 1);
});

test("main writes an atomic report and returns exit code 2 for unresolved work", async () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rescened-cover-backfill-"));
  const reportPath = path.join(temporaryDirectory, "report.json");
  const output = { logs: [], errors: [], log(value) { this.logs.push(value); }, error(value) { this.errors.push(value); } };
  try {
    const exitCode = await main(["--report", reportPath], {
      skipConnect: true,
      output,
      albums: [album()],
      resolveCoverArt: async () => ({ status: "unresolved", reason: "no_approved_front" }),
    });
    assert.equal(exitCode, 2);
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    assert.equal(report.fatal, false);
    assert.equal(report.entries[0].reason, "no_approved_front");
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("guarded filter retains the exact original timestamp", () => {
  const row = album({ updatedAt: new Date("2026-08-20T00:00:00.000Z") });
  const filter = guardedFilter(row);
  assert.equal(filter.updatedAt, row.updatedAt);
  assert.equal(filter.$or.length, 4);
});

test("normalization rejects a cover whose canonical URL and claimed source release differ", () => {
  const result = normalizedResolution({
    status: "resolved",
    cover: `https://coverartarchive.org/release/${RELEASE_ONE}/front-500`,
    releaseMbid: RELEASE_TWO,
  }, new Date("2026-08-26T12:00:00.000Z"));
  assert.equal(result.resolved, false);
  assert.equal(result.reason, "invalid_response");
});
