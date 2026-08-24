const { EJSON } = require("bson");
const { canonicalEjson, canonicalHash, LegacyMigrationError } = require("./runtime");

const SOURCE_COLLECTIONS = [
  "albumcatalogs", "albums", "boarditems", "boards", "reviews", "likes", "notifications",
  "userprofiles", "follows", "artistcatalogs", "artistneighborhoods", "albumsubmissions",
];

function valueType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (value instanceof Date) return "date";
  if (value && value._bsontype === "ObjectId") return "objectId";
  return typeof value;
}

function collectFieldStats(value, prefix = "", stats = {}) {
  const type = valueType(value);
  if (prefix) {
    const entry = stats[prefix] || { types: {}, count: 0 };
    entry.types[type] = (entry.types[type] || 0) + 1;
    entry.count += 1;
    stats[prefix] = entry;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectFieldStats(item, `${prefix}[]`, stats));
  } else if (value && typeof value === "object" && !(value instanceof Date) && value._bsontype !== "ObjectId") {
    Object.entries(value).forEach(([key, child]) => collectFieldStats(child, prefix ? `${prefix}.${key}` : key, stats));
  }
  return stats;
}

async function collectionInventory(collection) {
  const documents = await collection.find({}).sort({ _id: 1 }).toArray();
  const indexSpecs = await collection.listIndexes().toArray();
  const fields = {};
  documents.forEach((document) => collectFieldStats(document, "", fields));
  const dataHash = canonicalHash(documents);
  return {
    count: documents.length,
    dataHash,
    fields,
    indexes: indexSpecs.map((index) => EJSON.deserialize(EJSON.serialize(index, { relaxed: false }), { relaxed: false })),
  };
}

async function inventoryDatabase(db, collectionNames = SOURCE_COLLECTIONS) {
  const available = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map(({ name }) => name));
  const collections = {};
  for (const name of [...new Set([...collectionNames, ...available])].sort()) {
    if (!available.has(name)) continue;
    collections[name] = await collectionInventory(db.collection(name));
  }
  return {
    databaseName: db.databaseName,
    generatedAt: new Date().toISOString(),
    collections,
    databaseHash: canonicalHash(collections),
  };
}

async function assertDatabaseName(db, expected) {
  if (!db || db.databaseName !== expected) throw new LegacyMigrationError(`Connected to unexpected database ${db?.databaseName || "<none>"}`, "SOURCE_NAMESPACE_INVALID");
}

async function inventorySourceTarget({ sourceDb, targetDb, sourceName, targetName }) {
  await assertDatabaseName(sourceDb, sourceName);
  await assertDatabaseName(targetDb, targetName);
  const [source, target] = await Promise.all([
    inventoryDatabase(sourceDb),
    inventoryDatabase(targetDb, ["albumcatalogs", "albumsubmissions", "reviews", "likes", "boards", "boarditems", "userprofiles", "follows", "notifications"]),
  ]);
  return { source, target, generatedAt: new Date().toISOString() };
}

module.exports = {
  SOURCE_COLLECTIONS,
  canonicalEjson,
  collectionInventory,
  inventoryDatabase,
  inventorySourceTarget,
};
