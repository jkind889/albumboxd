#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { readDatasetFile } = require("../lib/catalogImport/dataset");
const { CatalogImportError } = require("../lib/catalogImport/persistence");

const USAGE = `Usage:
  npm run catalog:validate -- --input <dataset.json> [--report <report.json>]

Options:
  --input <path>    Catalog dataset to validate (required)
  --report <path>   Validation report output path
  --help            Show this help`;

function parseValidateArgs(argv = []) {
  const options = { input: "", report: "", help: false };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") {
      if (options.help) throw new CatalogImportError("--help may only be supplied once", "INVALID_ARGUMENTS");
      options.help = true;
      continue;
    }
    if (argument !== "--input" && argument !== "--report") {
      throw new CatalogImportError(`Unknown argument: ${argument}`, "INVALID_ARGUMENTS");
    }
    if (seen.has(argument)) throw new CatalogImportError(`${argument} may only be supplied once`, "INVALID_ARGUMENTS");
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new CatalogImportError(`${argument} requires a value`, "INVALID_ARGUMENTS");
    }
    seen.add(argument);
    options[argument.slice(2)] = value;
    index += 1;
  }
  if (!options.help && !options.input) {
    throw new CatalogImportError("--input is required", "INVALID_ARGUMENTS");
  }
  return options;
}

function defaultReportPath(input) {
  const parsed = path.parse(path.resolve(input));
  return path.join(parsed.dir, `${parsed.name}.validation-report.json`);
}

function canonicalValidationPath(target) {
  const resolved = path.resolve(target);
  try {
    return fs.realpathSync.native(resolved);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return resolved;
  }
}

function validationReportPath(input, report) {
  const sourcePath = canonicalValidationPath(input);
  const targetPath = canonicalValidationPath(report || defaultReportPath(input));
  if (sourcePath === targetPath) {
    throw new CatalogImportError(
      "Validation report path must be different from the input dataset path",
      "INVALID_ARTIFACT_PATHS",
    );
  }
  return targetPath;
}

function writeJsonAtomic(target, value) {
  const resolved = path.resolve(target);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const temporary = `${resolved}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    fs.renameSync(temporary, resolved);
  } catch (error) {
    try {
      fs.unlinkSync(temporary);
    } catch (cleanupError) {
      if (cleanupError.code !== "ENOENT") throw cleanupError;
    }
    throw error;
  }
  return resolved;
}

async function main(argv = process.argv.slice(2), dependencies = {}) {
  const output = dependencies.output || console;
  let options;
  let target;
  try {
    options = parseValidateArgs(argv);
    if (options.help) {
      output.log(USAGE);
      return 0;
    }
    target = validationReportPath(options.input, options.report);
    const validation = await (dependencies.readDatasetFile || readDatasetFile)(options.input);
    const report = {
      reportVersion: "1.0.0",
      datasetId: validation.dataset.datasetId,
      schemaVersion: validation.dataset.schemaVersion,
      generatedAt: new Date().toISOString(),
      fatal: false,
      counts: {
        total: validation.dataset.albums.length,
        valid: validation.validAlbums.length,
        quarantined: validation.quarantined.length,
      },
      quarantine: validation.quarantined,
    };
    const writtenTarget = writeJsonAtomic(target, report);
    output.log(JSON.stringify({ counts: report.counts, report: writtenTarget }, null, 2));
    return validation.quarantined.length ? 2 : 0;
  } catch (error) {
    if (target) {
      try {
        writeJsonAtomic(target, {
          reportVersion: "1.0.0",
          generatedAt: new Date().toISOString(),
          fatal: true,
          quarantine: Array.isArray(error.quarantined) ? error.quarantined : [],
          error: {
            code: error.code || "DATASET_VALIDATION_FAILED",
            message: error.message,
            details: error.errors || error.details || [],
            quarantined: Array.isArray(error.quarantined) ? error.quarantined : [],
          },
        });
      } catch (reportError) {
        output.error(`Could not write fatal validation report: ${reportError.message}`);
      }
    }
    output.error(`${error.code || "DATASET_VALIDATION_FAILED"}: ${error.message}`);
    return 1;
  }
}

if (require.main === module) {
  main().then((exitCode) => {
    process.exitCode = exitCode;
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  USAGE,
  parseValidateArgs,
  defaultReportPath,
  validationReportPath,
  main,
};
