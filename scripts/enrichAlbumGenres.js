require("dotenv").config();

const mongoose = require("mongoose");
const AlbumCatalog = require("../models/AlbumCatalog");
const {
  enrichAlbumGenres,
  isAlbumGenreEnrichmentDue,
} = require("../routes/utils/albumGenreEnrichment");

function parseArguments(args) {
  const options = {
    dryRun: false,
    force: false,
    limit: Number.POSITIVE_INFINITY,
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (argument === "--dry-run") {
      options.dryRun = true;
      continue;
    }

    if (argument === "--force") {
      options.force = true;
      continue;
    }

    if (argument === "--limit" || argument.startsWith("--limit=")) {
      const rawLimit = argument === "--limit"
        ? args[index += 1]
        : argument.slice("--limit=".length);
      const limit = Number.parseInt(rawLimit, 10);

      if (!Number.isInteger(limit) || limit < 1) {
        throw new TypeError("--limit must be a positive integer");
      }

      options.limit = limit;
      continue;
    }

    throw new TypeError(`Unknown argument: ${argument}`);
  }

  return options;
}

function createSummary() {
  return {
    eligible: 0,
    resolved: 0,
    empty: 0,
    not_found: 0,
    ambiguous: 0,
    failed: 0,
    missing: 0,
    skipped: 0,
  };
}

async function runBackfill(options) {
  const summary = createSummary();
  const cursor = AlbumCatalog.find({}).sort({ _id: 1 }).cursor();

  for await (const album of cursor) {
    if (!isAlbumGenreEnrichmentDue(album, { force: options.force })) {
      continue;
    }

    summary.eligible += 1;

    if (options.dryRun) {
      if (summary.eligible >= options.limit) {
        break;
      }

      continue;
    }

    const result = await enrichAlbumGenres(album.spotifyId, {
      force: options.force,
    });
    const resultStatus = Object.hasOwn(summary, result.status)
      ? result.status
      : "failed";

    summary[resultStatus] += 1;
    console.log(`${album.spotifyId}: ${result.status}`);

    if (summary.eligible >= options.limit) {
      break;
    }
  }

  return summary;
}

async function main(args = process.argv.slice(2)) {
  const options = parseArguments(args);

  if (!process.env.MONGO_URI) {
    throw new Error("MONGO_URI is required");
  }

  await mongoose.connect(process.env.MONGO_URI);

  try {
    const summary = await runBackfill(options);
    console.log(JSON.stringify({
      mode: options.dryRun ? "dry-run" : "write",
      limit: Number.isFinite(options.limit) ? options.limit : null,
      ...summary,
    }, null, 2));
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  createSummary,
  main,
  parseArguments,
  runBackfill,
};
