const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const Ajv = require("ajv");

const {
  DATASET_SCHEMA,
  DatasetValidationError,
  MAX_DATASET_BYTES,
  SCHEMA_VERSION,
  datasetSha256,
  readDatasetFile,
  validateAlbumRow,
  validateDatasetObject,
} = require("../lib/catalogImport/dataset");

const SAMPLE_PATH = path.resolve(__dirname, "../data/catalog-import/catalog-import.sample.json");

function sampleDataset() {
  return JSON.parse(fs.readFileSync(SAMPLE_PATH, "utf8"));
}

function findIssue(quarantine, code) {
  return quarantine.issues.find((entry) => entry.code === code);
}

test("checked-in sample matches the complete draft-07 schema and runtime contract", () => {
  const ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true });
  const validate = ajv.compile(DATASET_SCHEMA);
  const sample = sampleDataset();

  assert.equal(validate(sample), true, JSON.stringify(validate.errors));
  const result = readDatasetFile(SAMPLE_PATH);
  assert.equal(result.dataset.schemaVersion, SCHEMA_VERSION);
  assert.equal(result.validAlbums.length, 2);
  assert.equal(result.quarantined.length, 0);
  assert.match(result.sha256, /^[0-9a-f]{64}$/);
  assert.equal(result.bytes, Buffer.byteLength(result.sourceText, "utf8"));
});

test("unknown envelope fields are fatal while unknown album fields quarantine only that row", () => {
  const invalidEnvelope = sampleDataset();
  invalidEnvelope.untrusted = true;
  assert.throws(
    () => validateDatasetObject(invalidEnvelope),
    (error) => (
      error instanceof DatasetValidationError
      && error.code === "INVALID_ENVELOPE"
      && error.errors.some((entry) => entry.code === "UNKNOWN_FIELD" && entry.pointer === "/untrusted")
    ),
  );

  const mixed = sampleDataset();
  mixed.albums[0].tracks = [];
  const result = validateDatasetObject(mixed);
  assert.equal(result.validAlbums.length, 1);
  assert.equal(result.validAlbums[0].index, 1);
  assert.equal(result.quarantined.length, 1);
  assert.equal(result.quarantined[0].code, "UNKNOWN_FIELD");
  assert.equal(result.quarantined[0].pointer, "/albums/0/tracks");
});

test("release date tuple validation accepts exact partial dates and rejects invented or impossible dates", () => {
  const base = sampleDataset().albums[0];
  const cases = [
    { releaseDate: "", releaseDatePrecision: "", releaseYear: null },
    { releaseDate: "0000", releaseDatePrecision: "year", releaseYear: 0 },
    { releaseDate: "1997", releaseDatePrecision: "year", releaseYear: 1997 },
    { releaseDate: "1997-05", releaseDatePrecision: "month", releaseYear: 1997 },
    { releaseDate: "2000-02-29", releaseDatePrecision: "day", releaseYear: 2000 },
  ];
  cases.forEach((dateTuple, index) => {
    assert.equal(validateAlbumRow({ ...base, ...dateTuple }, index).valid, true);
  });

  const mismatch = validateAlbumRow({ ...base, releaseDate: "1997-05", releaseDatePrecision: "day", releaseYear: 1997 }, 4);
  assert.equal(mismatch.valid, false);
  assert.ok(mismatch.errors.some((entry) => entry.code === "INVALID_DATE_TUPLE"));

  const impossible = validateAlbumRow({ ...base, releaseDate: "1997-02-29", releaseDatePrecision: "day", releaseYear: 1997 }, 5);
  assert.equal(impossible.valid, false);
  assert.ok(impossible.errors.some((entry) => entry.code === "INVALID_RELEASE_DATE"));
});

test("album semantics enforce MusicBrainz identity, credited display names, and CAA identity", () => {
  const base = sampleDataset().albums[0];

  const uppercaseMbid = validateAlbumRow({ ...base, releaseGroupMbid: base.releaseGroupMbid.toUpperCase() }, 0);
  assert.equal(uppercaseMbid.valid, false);
  assert.equal(uppercaseMbid.errors[0].pointer, "/albums/0/releaseGroupMbid");

  const displayMismatch = validateAlbumRow({ ...base, artistDisplayName: "Radio Head" }, 1);
  assert.ok(displayMismatch.errors.some((entry) => entry.code === "ARTIST_DISPLAY_MISMATCH"));

  const caaMismatch = validateAlbumRow({
    ...base,
    representativeReleaseMbid: "c771f7fc-9e62-4349-a2e3-ceaf7122bf5b",
  }, 2);
  assert.ok(caaMismatch.errors.some((entry) => entry.code === "INVALID_CAA_REFERENCE"));
});

test("selection signals preserve repeated observations from a range", () => {
  const album = sampleDataset().albums[0];
  const repeated = {
    ...album,
    selectionSignals: [
      ...album.selectionSignals,
      { range: "month", rank: 64, listenCount: 14000 },
    ],
  };
  assert.equal(validateAlbumRow(repeated, 0).valid, true);

  const missingSelectedSignal = {
    ...album,
    selectedRange: "all_time",
    selectionSignals: album.selectionSignals.filter((signal) => signal.range !== "all_time"),
  };
  const result = validateAlbumRow(missingSelectedSignal, 0);
  assert.ok(result.errors.some((entry) => entry.code === "MISSING_SELECTED_RANGE_SIGNAL"));
});

test("duplicate release-group source keys quarantine the later valid row", () => {
  const dataset = sampleDataset();
  dataset.albums[1] = JSON.parse(JSON.stringify(dataset.albums[0]));
  const result = validateDatasetObject(dataset);

  assert.equal(result.validAlbums.length, 1);
  assert.equal(result.validAlbums[0].index, 0);
  assert.equal(result.quarantined.length, 1);
  assert.equal(result.quarantined[0].code, "DUPLICATE_SOURCE_KEY");
  assert.equal(result.quarantined[0].sourceMbid, dataset.albums[0].releaseGroupMbid);
});

test("accepted selectedRange composition matches every declared quota", () => {
  const dataset = sampleDataset();
  dataset.selection.ranges.find((entry) => entry.range === "all_time").quota = 1;
  dataset.selection.ranges.find((entry) => entry.range === "year").quota = 1;
  dataset.albums[1].selectedRange = "year";

  const result = validateDatasetObject(dataset);
  assert.equal(result.quarantined.length, 0);
  assert.deepEqual(
    Object.fromEntries(dataset.selection.ranges.map(({ range }) => [
      range,
      result.validAlbums.filter(({ row }) => row.selectedRange === range).length,
    ])),
    { all_time: 1, year: 1, month: 0 },
  );
});

test("over-quota valid rows are quarantined instead of making composition fatal", () => {
  const dataset = sampleDataset();
  dataset.selection.ranges.find((entry) => entry.range === "all_time").quota = 1;
  dataset.selection.ranges.find((entry) => entry.range === "year").quota = 1;

  const result = validateDatasetObject(dataset);
  assert.equal(result.validAlbums.length, 1);
  assert.equal(result.validAlbums[0].index, 0);
  assert.equal(result.quarantined.length, 1);
  assert.equal(result.quarantined[0].code, "RANGE_QUOTA_EXCEEDED");
  assert.equal(result.quarantined[0].pointer, "/albums/1/selectedRange");
});

test("invalid rows do not consume range quota slots before later valid rows", () => {
  const dataset = sampleDataset();
  const rows = [0, 1, 2].map((index) => ({
    ...JSON.parse(JSON.stringify(dataset.albums[index % dataset.albums.length])),
    releaseGroupMbid: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    representativeReleaseMbid: null,
    cover: null,
    selectedRange: "all_time",
    title: `Quota row ${index + 1}`,
  }));
  rows[0].tracks = [];
  dataset.albums = rows;
  dataset.selection.targetAlbumCount = 3;
  dataset.selection.ranges.find((entry) => entry.range === "all_time").quota = 1;
  dataset.selection.ranges.find((entry) => entry.range === "year").quota = 2;

  const result = validateDatasetObject(dataset);
  assert.deepEqual(result.validAlbums.map(({ index }) => index), [1]);
  assert.equal(result.quarantined.length, 2);
  assert.equal(result.quarantined[0].code, "UNKNOWN_FIELD");
  assert.equal(result.quarantined[1].code, "RANGE_QUOTA_EXCEEDED");
});

test("dataset-wide rank limits and primary-artist cap quarantine unsafe rows", () => {
  const rankDataset = sampleDataset();
  rankDataset.albums[0].selectionSignals[0].rank = 101;
  const ranked = validateDatasetObject(rankDataset);
  assert.equal(ranked.validAlbums.length, 1);
  assert.ok(findIssue(ranked.quarantined[0], "RANK_EXCEEDS_CANDIDATE_LIMIT"));

  const capDataset = sampleDataset();
  capDataset.selection.maxPerPrimaryArtist = 1;
  capDataset.albums[1] = {
    ...capDataset.albums[1],
    representativeReleaseMbid: null,
    cover: null,
    artistDisplayName: "Radiohead",
    artistCredits: JSON.parse(JSON.stringify(capDataset.albums[0].artistCredits)),
  };
  const capped = validateDatasetObject(capDataset);
  assert.equal(capped.validAlbums.length, 1);
  assert.ok(findIssue(capped.quarantined[0], "PRIMARY_ARTIST_CAP_EXCEEDED"));
});

test("unsupported versions and semantic envelope contradictions are fatal", () => {
  const unsupported = sampleDataset();
  unsupported.schemaVersion = "2.0.0";
  assert.throws(
    () => validateDatasetObject(unsupported),
    (error) => error instanceof DatasetValidationError && error.code === "UNSUPPORTED_SCHEMA_VERSION",
  );

  const badQuota = sampleDataset();
  badQuota.selection.ranges[0].quota = 1;
  assert.throws(
    () => validateDatasetObject(badQuota),
    (error) => error.code === "INVALID_ENVELOPE" && error.errors.some((entry) => entry.code === "INVALID_QUOTA_TOTAL"),
  );

  const badTimestamp = sampleDataset();
  badTimestamp.generatedAt = "2026-02-30T00:00:00.000Z";
  assert.throws(
    () => validateDatasetObject(badTimestamp),
    (error) => error.code === "INVALID_ENVELOPE" && error.errors.some((entry) => entry.code === "INVALID_GENERATED_AT"),
  );
});

test("zero valid album rows is fatal and retains row quarantine details", () => {
  const dataset = sampleDataset();
  dataset.albums.forEach((album) => { album.releaseGroupMbid = "not-an-mbid"; });
  assert.throws(
    () => validateDatasetObject(dataset),
    (error) => (
      error instanceof DatasetValidationError
      && error.code === "NO_VALID_ALBUMS"
      && error.quarantined.length === 2
    ),
  );
});

test("file reader rejects malformed JSON and oversized input before parsing", (t) => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rescened-catalog-dataset-"));
  t.after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));

  const malformedPath = path.join(temporaryDirectory, "malformed.json");
  fs.writeFileSync(malformedPath, "{", "utf8");
  assert.throws(
    () => readDatasetFile(malformedPath),
    (error) => error instanceof DatasetValidationError && error.code === "MALFORMED_JSON",
  );

  const oversizedPath = path.join(temporaryDirectory, "oversized.json");
  fs.writeFileSync(oversizedPath, "", "utf8");
  fs.truncateSync(oversizedPath, MAX_DATASET_BYTES + 1);
  assert.throws(
    () => readDatasetFile(oversizedPath),
    (error) => error instanceof DatasetValidationError && error.code === "DATASET_TOO_LARGE",
  );
});

test("datasetSha256 hashes source text exactly and objects canonically", () => {
  const text = "{\"b\":2,\"a\":1}\n";
  assert.equal(datasetSha256(text), crypto.createHash("sha256").update(text).digest("hex"));
  assert.equal(datasetSha256({ b: 2, a: { d: 4, c: 3 } }), datasetSha256({ a: { c: 3, d: 4 }, b: 2 }));
});
