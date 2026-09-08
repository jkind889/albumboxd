const test = require("node:test");
const assert = require("node:assert/strict");
const { canonicalHash } = require("../lib/legacyMigration/runtime");
const { applyPlan } = require("../lib/legacyMigration/apply");
const { inventoryDatabase } = require("../lib/legacyMigration/inventory");

function copyDocument(document) {
  return document ? { ...document } : null;
}

function sameValue(left, right) {
  return String(left) === String(right);
}

function matchesFilter(document, filter = {}) {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === "$or") return expected.some((branch) => matchesFilter(document, branch));
    if (expected && typeof expected === "object" && !Array.isArray(expected)) {
      if (Object.prototype.hasOwnProperty.call(expected, "$exists")) {
        return Object.prototype.hasOwnProperty.call(document, key) === expected.$exists;
      }
      if (Object.prototype.hasOwnProperty.call(expected, "$lt")) return document[key] < expected.$lt;
    }
    return sameValue(document[key], expected);
  });
}

function defaultIndexName(keys) {
  return Object.entries(keys).map(([key, direction]) => `${key}_${direction}`).join("_");
}

function fakeTargetDatabase(seed) {
  const states = new Map();
  const events = [];

  function getState(name) {
    if (!states.has(name)) states.set(name, { exists: false, documents: [], indexes: [] });
    return states.get(name);
  }

  for (const [name, documents] of Object.entries(seed)) {
    const state = getState(name);
    state.exists = true;
    state.documents = documents.map(copyDocument);
  }

  function uniquePublicIdCanBuild(name, keys, options, state) {
    const field = name === "reviews" ? "reviewId" : name === "boards" ? "boardId" : name === "notifications" ? "notificationId" : "";
    if (!field || !options.unique || keys[field] !== 1 || Object.keys(keys).length !== 1) return true;
    const values = state.documents.map((document) => document[field]);
    return values.every((value) => typeof value === "string" && value)
      && new Set(values).size === values.length;
  }

  const database = {
    databaseName: "legacy_index_order_candidate",
    listCollections() {
      return {
        toArray: async () => [...states.entries()]
          .filter(([, state]) => state.exists)
          .map(([name]) => ({ name })),
      };
    },
    collection(name) {
      const state = getState(name);
      return {
        find(filter = {}) {
          return {
            sort() { return this; },
            toArray: async () => state.documents.filter((document) => matchesFilter(document, filter)).map(copyDocument),
          };
        },
        async findOne(filter = {}) {
          const document = state.documents.find((candidate) => matchesFilter(candidate, filter));
          return copyDocument(document);
        },
        listIndexes() {
          return {
            toArray: async () => state.indexes.map((index) => ({
              ...index,
              key: { ...index.key },
              partialFilterExpression: index.partialFilterExpression ? { ...index.partialFilterExpression } : undefined,
            })),
          };
        },
        async createIndex(keys, options = {}) {
          events.push({ type: "createIndex", collection: name, keys: { ...keys } });
          if (!uniquePublicIdCanBuild(name, keys, options, state)) {
            const error = new Error(`duplicate null values prevent ${name} public-ID index creation`);
            error.code = 11000;
            throw error;
          }
          state.exists = true;
          const textIndex = Object.values(keys).some((value) => value === "text");
          state.indexes.push({
            ...options,
            name: options.name || defaultIndexName(keys),
            key: textIndex ? { _fts: "text", _ftsx: 1 } : { ...keys },
          });
          return options.name || defaultIndexName(keys);
        },
        async replaceOne(filter, document, options = {}) {
          events.push({ type: "replaceOne", collection: name, id: document._id });
          state.exists = true;
          const index = state.documents.findIndex((candidate) => matchesFilter(candidate, filter));
          if (index >= 0) {
            state.documents[index] = copyDocument(document);
            return { matchedCount: 1, modifiedCount: 1 };
          }
          if (!options.upsert) return { matchedCount: 0, modifiedCount: 0 };
          state.documents.push(copyDocument(document));
          return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
        },
        async updateOne(filter, update, options = {}) {
          let document = state.documents.find((candidate) => matchesFilter(candidate, filter));
          if (!document && options.upsert) {
            document = { _id: filter._id };
            Object.assign(document, update.$setOnInsert || {}, update.$set || {});
            state.documents.push(document);
            state.exists = true;
            return { matchedCount: 0, upsertedCount: 1 };
          }
          if (!document) return { matchedCount: 0, upsertedCount: 0 };
          Object.assign(document, update.$set || {});
          for (const [field, value] of Object.entries(update.$addToSet || {})) {
            if (!Array.isArray(document[field])) document[field] = [];
            if (!document[field].some((entry) => sameValue(entry, value))) document[field].push(value);
          }
          state.exists = true;
          return { matchedCount: 1, upsertedCount: 0 };
        },
      };
    },
  };

  return { database, events, getState };
}

function operation(collection, before, after, batchId) {
  return {
    collection,
    stage: collection,
    action: "update",
    targetId: after._id,
    beforeHash: canonicalHash(before),
    afterHash: canonicalHash(after),
    document: after,
    batchId,
  };
}

test("legacy apply assigns public IDs before building their unique indexes and verifies indexes on a no-op retry", async () => {
  const boards = [
    { _id: "board-one", userId: "user-one", title: "One", isDefault: false },
    { _id: "board-two", userId: "user-two", title: "Two", isDefault: false, boardId: null },
  ];
  const notifications = [
    { _id: "notification-one", recipientUserId: "user-one", actorUserId: "actor-one", type: "follow", readAt: null },
    { _id: "notification-two", recipientUserId: "user-one", actorUserId: "actor-two", type: "follow", readAt: null, notificationId: null },
  ];
  const reviews = [
    { _id: "review-one", userId: "user-one", reviewText: "One", rating: 4 },
    { _id: "review-two", userId: "user-two", reviewText: "Two", rating: 4, reviewId: null },
  ];
  const target = fakeTargetDatabase({ reviews, boards, notifications });
  const inventory = await inventoryDatabase(target.database, []);
  const boardAfter = [
    { ...boards[0], boardId: "11111111-1111-4111-8111-111111111111" },
    { ...boards[1], boardId: "22222222-2222-4222-8222-222222222222" },
  ];
  const notificationAfter = [
    { ...notifications[0], notificationId: "33333333-3333-4333-8333-333333333333" },
    { ...notifications[1], notificationId: "44444444-4444-4444-8444-444444444444" },
  ];
  const reviewAfter = [
    { ...reviews[0], reviewId: "55555555-5555-4555-8555-555555555555" },
    { ...reviews[1], reviewId: "66666666-6666-4666-8666-666666666666" },
  ];
  const operations = [
    operation("reviews", reviews[0], reviewAfter[0], "batch-0000"),
    operation("reviews", reviews[1], reviewAfter[1], "batch-0000"),
    operation("boards", boards[0], boardAfter[0], "batch-0000"),
    operation("boards", boards[1], boardAfter[1], "batch-0000"),
    operation("notifications", notifications[0], notificationAfter[0], "batch-0001"),
    operation("notifications", notifications[1], notificationAfter[1], "batch-0001"),
  ];
  const plan = {
    schemaVersion: "1.0.0",
    runId: "public-id-index-order",
    generatedAt: "2026-09-07T00:00:00.000Z",
    source: { database: "legacy_source", fingerprint: "source" },
    target: { database: target.database.databaseName, fingerprint: inventory.databaseHash },
    outcome: { catalog: [], socialIssues: [] },
    operations,
    batches: [
      { id: "batch-0000", operationCount: 2 },
      { id: "batch-0001", operationCount: 2 },
    ],
    counts: { operations: operations.length, batches: 2 },
    validation: { fingerprint: "validation" },
  };
  plan.planSha256 = canonicalHash({ ...plan, planSha256: undefined });
  const client = {
    startSession() {
      return {
        async withTransaction(callback) { await callback(); },
        async endSession() {},
      };
    },
  };

  const applied = await applyPlan({
    targetDb: target.database,
    client,
    plan,
    expectedPlanSha256: plan.planSha256,
    confirmTarget: target.database.databaseName,
  });

  assert.equal(applied.applied, true);
  assert.deepEqual(target.getState("reviews").documents.map((document) => document.reviewId), reviewAfter.map((document) => document.reviewId));
  assert.deepEqual(target.getState("boards").documents.map((document) => document.boardId), boardAfter.map((document) => document.boardId));
  assert.deepEqual(target.getState("notifications").documents.map((document) => document.notificationId), notificationAfter.map((document) => document.notificationId));
  const lastReplacement = target.events.reduce(
    (last, event, index) => event.type === "replaceOne" ? index : last,
    -1,
  );
  const publicIdIndexBuilds = target.events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event.type === "createIndex"
      && Object.keys(event.keys).length === 1
      && ["reviewId", "boardId", "notificationId"].some((field) => event.keys[field] === 1));
  assert.equal(publicIdIndexBuilds.length, 3);
  assert.ok(publicIdIndexBuilds.every(({ index }) => index > lastReplacement), "public-ID indexes must be created after every sealed replacement");
  assert.equal(target.getState("migrationruns").documents[0].status, "completed");

  target.getState("boards").indexes = target.getState("boards").indexes.filter((index) => index.name !== "boardId_1");
  target.getState("notifications").indexes = target.getState("notifications").indexes.filter((index) => index.name !== "notificationId_1");
  target.getState("reviews").indexes = target.getState("reviews").indexes.filter((index) => index.name !== "reviewId_1");
  const eventCountBeforeRetry = target.events.length;
  const retried = await applyPlan({
    targetDb: target.database,
    client,
    plan,
    expectedPlanSha256: plan.planSha256,
    confirmTarget: target.database.databaseName,
  });

  assert.equal(retried.noop, true);
  const retryEvents = target.events.slice(eventCountBeforeRetry);
  assert.equal(retryEvents.some((event) => event.type === "replaceOne"), false);
  assert.equal(retryEvents.some((event) => event.type === "createIndex" && event.collection === "reviews" && event.keys.reviewId === 1), true);
  assert.equal(retryEvents.some((event) => event.type === "createIndex" && event.collection === "boards" && event.keys.boardId === 1), true);
  assert.equal(retryEvents.some((event) => event.type === "createIndex" && event.collection === "notifications" && event.keys.notificationId === 1), true);
});
