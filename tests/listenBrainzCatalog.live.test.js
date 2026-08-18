const assert = require("node:assert/strict");
const test = require("node:test");

const {
  DEFAULT_MUSICBRAINZ_INTERVAL_MS,
  DEFAULT_USER_AGENT,
  fetchCatalogDataset,
} = require("../lib/catalogImport/listenBrainz");
const { validateDatasetObject } = require("../lib/catalogImport/dataset");

const liveEnabled = String(process.env.RUN_LIVE_CATALOG_FETCH || "").toLowerCase() === "true";

async function liveCatalogFetchSmokeTest() {
  const rangeConfigs = [
    { range: "all_time", quota: 1, candidateLimit: 10 },
    { range: "year", quota: 0, candidateLimit: 1 },
    { range: "month", quota: 0, candidateLimit: 1 },
  ];
  const userAgent = process.env.MUSICBRAINZ_USER_AGENT || DEFAULT_USER_AGENT;

  const { dataset, report } = await fetchCatalogDataset({
    rangeConfigs,
    userAgent,
    // Keep the production MusicBrainz request interval; this smoke test must
    // never exercise a faster test-only path against the public service.
    musicBrainzIntervalMs: DEFAULT_MUSICBRAINZ_INTERVAL_MS,
  });
  const validation = validateDatasetObject(dataset);

  assert.equal(report.status, "complete");
  assert.equal(dataset.schemaVersion, "1.0.0");
  assert.equal(dataset.selection.targetAlbumCount, 1);
  assert.equal(dataset.albums.length, 1);
  assert.equal(dataset.albums[0].selectedRange, "all_time");
  assert.deepEqual(
    dataset.selection.ranges.map(({ range, quota }) => ({ range, quota })),
    [
      { range: "all_time", quota: 1 },
      { range: "year", quota: 0 },
      { range: "month", quota: 0 },
    ],
  );
  assert.equal(validation.validAlbums.length, 1);
  assert.equal(validation.quarantined.length, 0);
}

if (liveEnabled) {
  test("live public APIs produce one strict catalog album", { timeout: 120_000 }, liveCatalogFetchSmokeTest);
} else {
  test("live public APIs produce one strict catalog album", {
    skip: "Set RUN_LIVE_CATALOG_FETCH=true to call the public ListenBrainz and MusicBrainz APIs",
  }, () => {});
}
