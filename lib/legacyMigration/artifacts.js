const fs = require("node:fs/promises");
const path = require("node:path");
const { EJSON } = require("bson");
const { LegacyMigrationError, canonicalEjson, sha256 } = require("./runtime");

async function ensureDirectory(directory) {
  await fs.mkdir(directory, { recursive: true });
}

async function writeAtomic(filePath, contents, options = {}) {
  const resolved = path.resolve(filePath);
  await ensureDirectory(path.dirname(resolved));
  try {
    await fs.access(resolved);
    if (!options.overwrite) throw new LegacyMigrationError(`Artifact already exists: ${resolved}`, "ARTIFACT_EXISTS");
  } catch (error) {
    if (error.code !== "ENOENT" && error.code !== "ARTIFACT_EXISTS") throw error;
    if (error.code === "ARTIFACT_EXISTS") throw error;
  }
  const temporary = path.join(path.dirname(resolved), `.${path.basename(resolved)}.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(temporary, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try {
    await fs.rename(temporary, resolved);
  } catch (error) {
    await fs.unlink(temporary).catch(() => {});
    throw error;
  }
  return resolved;
}

async function writeJson(filePath, value, options = {}) {
  const contents = options.canonical ? `${canonicalEjson(value)}\n` : `${JSON.stringify(value, null, 2)}\n`;
  return writeAtomic(filePath, contents, options);
}

async function readJson(filePath, options = {}) {
  const contents = await fs.readFile(filePath, "utf8");
  return options.canonical ? EJSON.parse(contents, { relaxed: false }) : JSON.parse(contents);
}

async function writeDigest(filePath, contents, options = {}) {
  return writeAtomic(filePath, `${sha256(contents)}\n`, options);
}

async function sealJson(runDir, name, value) {
  const target = path.join(runDir, name);
  const contents = `${canonicalEjson(value)}\n`;
  await writeAtomic(target, contents);
  const digestPath = `${target}.sha256`;
  await writeDigest(digestPath, contents);
  return { path: target, sha256: sha256(contents), digestPath };
}

module.exports = { ensureDirectory, readJson, sealJson, writeAtomic, writeDigest, writeJson };
