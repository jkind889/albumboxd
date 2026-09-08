const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");

const Notification = require("../models/Notification");

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function attributes(overrides = {}) {
  return {
    recipientUserId: "recipient",
    actorUserId: "actor",
    type: "follow",
    ...overrides,
  };
}

test("notifications generate immutable UUID-v4 public IDs only for new documents", () => {
  const notification = new Notification(attributes());
  assert.match(notification.notificationId, UUID_V4);
  assert.equal(notification.notificationId, notification.notificationId.toLowerCase());
  assert.equal(Notification.schema.path("notificationId").options.immutable, true);
  assert.equal(Notification.schema.path("notificationId").options.unique, true);

  const hydrated = Notification.hydrate({
    _id: new mongoose.Types.ObjectId(),
    ...attributes(),
  });
  assert.equal(hydrated.notificationId, undefined);
});

test("notifications reject malformed public IDs", () => {
  const notification = new Notification(attributes({ notificationId: new mongoose.Types.ObjectId().toString() }));
  assert.ok(notification.validateSync()?.errors.notificationId);
});
