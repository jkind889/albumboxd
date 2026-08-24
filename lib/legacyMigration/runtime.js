const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { EJSON } = require("bson");
const { MongoClient } = require("mongodb");

const DEFAULT_RUN_ROOT = path.resolve(".migration", "legacy-gen1");
const MODES = new Set(["inventory", "dry-run", "validate", "apply", "verify"]);

class LegacyMigrationError extends Error {
  constructor(message, code = "LEGACY_MIGRATION_FAILED", details = []) {
    super(message);
    this.name = "LegacyMigrationError";
    this.code = code;
    this.details = details;
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  // Preserve BSON scalar values for EJSON (Date, ObjectId, Binary, Decimal128,
  // etc.). Treating them as ordinary objects would erase dates and turn an
  // ObjectId into its internal byte map, breaking drift detection.
  if (value instanceof Date || Buffer.isBuffer(value) || value?._bsontype || value instanceof RegExp) return value;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function canonicalEjson(value) {
  return EJSON.stringify(canonicalize(value), { canonical: true, relaxed: false });
}

function sha256(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function canonicalHash(value) {
  return sha256(canonicalEjson(value));
}

function parseArguments(argv = []) {
  const result = {
    mode: "dry-run",
    runDir: "",
    overrides: "",
    planSha256: "",
    confirmTarget: "",
    help: false,
  };
  let explicitMode = "";
  const values = new Set(["--run-dir", "--overrides", "--plan-sha256", "--confirm-target"]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (MODES.has(flag.replace(/^--/, ""))) {
      const mode = flag.slice(2);
      if (explicitMode && explicitMode !== mode) {
        throw new LegacyMigrationError("Exactly one migration mode may be selected", "INVALID_ARGUMENTS");
      }
      if (explicitMode === mode) throw new LegacyMigrationError(`${flag} may only be supplied once`, "INVALID_ARGUMENTS");
      explicitMode = mode;
      result.mode = mode;
      continue;
    }
    if (flag === "--help") {
      result.help = true;
      continue;
    }
    if (values.has(flag)) {
      if (result[flag.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())]) {
        throw new LegacyMigrationError(`${flag} may only be supplied once`, "INVALID_ARGUMENTS");
      }
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new LegacyMigrationError(`${flag} requires a value`, "INVALID_ARGUMENTS");
      const key = flag.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      result[key] = value;
      index += 1;
      continue;
    }
    throw new LegacyMigrationError(`Unknown argument: ${flag}`, "INVALID_ARGUMENTS");
  }
  if (!result.help && !result.runDir) throw new LegacyMigrationError("--run-dir is required", "INVALID_ARGUMENTS");
  if (result.mode === "apply" && (!result.planSha256 || !result.confirmTarget)) {
    throw new LegacyMigrationError("--apply requires --plan-sha256 and --confirm-target", "INVALID_ARGUMENTS");
  }
  if (result.mode === "verify" && !result.planSha256) {
    throw new LegacyMigrationError("--verify requires --plan-sha256", "INVALID_ARGUMENTS");
  }
  return result;
}

function databaseNameFromUri(uri) {
  if (typeof uri !== "string" || !uri.trim()) throw new LegacyMigrationError("MongoDB URI is required", "MISSING_ENV");
  const match = /^(mongodb(?:\+srv)?):\/\/[^/]+(?:\/([^?]*))?(?:\?.*)?$/i.exec(uri.trim());
  if (!match || !match[2]) {
    throw new LegacyMigrationError("Migration MongoDB URIs must contain an explicit database name", "SOURCE_NAMESPACE_INVALID");
  }
  const name = decodeURIComponent(match[2]).trim();
  if (!name || name === "test" || name.includes("/")) {
    throw new LegacyMigrationError(`Unsafe migration database name: ${name || "<empty>"}`, "SOURCE_NAMESPACE_INVALID");
  }
  return name;
}

function databaseNamespaceFromUri(uri) {
  const value = String(uri || "").trim();
  const match = /^(mongodb(?:\+srv)?:\/\/)([^/]+)\/([^?]+)(?:\?.*)?$/i.exec(value);
  if (!match) return "";
  const authority = match[2].replace(/^[^@]*@/, "").toLowerCase();
  return `${match[1].toLowerCase()}${authority}/${decodeURIComponent(match[3]).toLowerCase()}`;
}

function assertMigrationUris(sourceUri, targetUri) {
  const source = databaseNameFromUri(sourceUri);
  const target = databaseNameFromUri(targetUri);
  if (source === target || databaseNamespaceFromUri(sourceUri) === databaseNamespaceFromUri(targetUri)) throw new LegacyMigrationError("Source and target databases must differ", "SOURCE_TARGET_COLLISION");
  return { source, target };
}

function requiredEnvironment(env = process.env) {
  const sourceUri = env.LEGACY_MONGO_URI;
  const targetUri = env.MIGRATION_TARGET_MONGO_URI;
  if (!sourceUri || !targetUri) throw new LegacyMigrationError("LEGACY_MONGO_URI and MIGRATION_TARGET_MONGO_URI are required", "MISSING_ENV");
  return { sourceUri, targetUri, ...assertMigrationUris(sourceUri, targetUri) };
}

function ensureRunDirectory(runDir) {
  const resolved = path.resolve(runDir);
  if (resolved === path.parse(resolved).root) throw new LegacyMigrationError("Run directory is too broad", "INVALID_RUN_DIRECTORY");
  fs.mkdirSync(resolved, { recursive: true });
  return resolved;
}

async function acquireRunLock(runDir, mode = "migration") {
  const lockPath = path.join(path.resolve(runDir), ".run.lock");
  const payload = `${JSON.stringify({ pid: process.pid, mode, acquiredAt: new Date().toISOString() })}\n`;
  try {
    await fsp.writeFile(lockPath, payload, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    if (error.code === "EEXIST") throw new LegacyMigrationError(`Migration run directory is locked: ${lockPath}`, "MIGRATION_LOCKED");
    throw error;
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await fsp.unlink(lockPath).catch((error) => { if (error.code !== "ENOENT") throw error; });
  };
}

function newRunId(clock = () => new Date()) {
  const date = clock().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `${date}-${crypto.randomUUID()}`;
}

async function connectMongo(uri, options = {}) {
  const client = new MongoClient(uri, {
    maxPoolSize: options.maxPoolSize || 4,
    serverSelectionTimeoutMS: options.serverSelectionTimeoutMS || 15_000,
    connectTimeoutMS: options.connectTimeoutMS || 15_000,
    retryWrites: true,
    readPreference: options.readPreference || "primary",
  });
  await client.connect();
  return client;
}

function redactedUri(uri) {
  return String(uri || "").replace(/(mongodb(?:\+srv)?:\/\/)([^/@]+):([^/@]+)@/i, "$1<redacted>@");
}

module.exports = {
  DEFAULT_RUN_ROOT,
  LegacyMigrationError,
  MODES,
  assertMigrationUris,
  acquireRunLock,
  canonicalEjson,
  canonicalHash,
  canonicalize,
  connectMongo,
  databaseNameFromUri,
  databaseNamespaceFromUri,
  ensureRunDirectory,
  newRunId,
  parseArguments,
  redactedUri,
  requiredEnvironment,
  sha256,
};
