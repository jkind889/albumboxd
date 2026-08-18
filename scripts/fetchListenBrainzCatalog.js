#!/usr/bin/env node

const path = require("node:path");
const {
  DEFAULT_RANGE_CONFIGS,
  DEFAULT_USER_AGENT,
  runCatalogFetch,
} = require("../lib/catalogImport/listenBrainz");

function parseArguments(argv) {
  let outputPath = "";
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument !== "--output") throw new TypeError(`Unknown argument: ${argument}`);
    if (outputPath) throw new TypeError("--output may only be provided once");
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new TypeError("--output requires a file path");
    outputPath = value;
    index += 1;
  }
  if (!outputPath) throw new TypeError("Usage: npm run catalog:fetch -- --output <seed.json>");
  return { outputPath: path.resolve(outputPath) };
}

function progressLogger(event) {
  if (event.type !== "selected") return;
  process.stdout.write(
    `\rSelecting ${event.range}: ${String(event.selectedInRange).padStart(3, " ")}/${event.quota}`,
  );
  if (event.selectedInRange === event.quota) process.stdout.write("\n");
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const { outputPath } = parseArguments(argv);
  const cacheDir = env.CATALOG_FETCH_CACHE_DIR
    ? path.resolve(env.CATALOG_FETCH_CACHE_DIR)
    : path.join(path.dirname(outputPath), ".cache", "catalog-import", "musicbrainz");
  const userAgent = env.MUSICBRAINZ_USER_AGENT || DEFAULT_USER_AGENT;
  const target = DEFAULT_RANGE_CONFIGS.reduce((total, config) => total + config.quota, 0);
  console.log(`Fetching ${target} ranked release groups for the Rescened catalog...`);
  const result = await runCatalogFetch({
    outputPath,
    cacheDir,
    userAgent,
    onProgress: progressLogger,
  });
  console.log(`Dataset: ${result.artifacts.outputPath}`);
  console.log(`SHA-256: ${result.artifacts.checksum}`);
  console.log(`Fetch report: ${result.artifacts.reportPath}`);
  console.log(
    `MusicBrainz cache: ${result.report.candidates.cacheHits} hits, ${result.report.candidates.cacheMisses} misses`,
  );
  return result;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`Catalog fetch failed [${error.code || "error"}]: ${error.message}\n`);
    if (error.report) {
      const rejected = Array.isArray(error.report.rejections) ? error.report.rejections.length : 0;
      process.stderr.write(`Fetch report written with ${rejected} rejected candidates.\n`);
    }
    process.exitCode = 1;
  });
}

module.exports = { main, parseArguments, progressLogger };
