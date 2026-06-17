const assert = require("node:assert/strict");
const test = require("node:test");

const notificationModelPath = require.resolve("../models/Notification");
const reviewModelPath = require.resolve("../models/Reviews");
const clerkPath = require.resolve("@clerk/express");
const notificationRoutePath = require.resolve("../routes/notifications");

let notificationDocuments = [];
let reviewDocuments = [];
let authUserId = "user_clerk_123";
let clerkUsers = [];
let shouldRejectClerkLookup = false;
const notificationFindCalls = [];
const notificationCountCalls = [];
const notificationUpdateManyCalls = [];
const reviewFindCalls = [];
const getUserListCalls = [];

function matchesValue(documentValue, queryValue) {
  if (queryValue && typeof queryValue === "object" && "$in" in queryValue) {
    return queryValue.$in.map(String).includes(String(documentValue));
  }

  return documentValue === queryValue || String(documentValue) === String(queryValue);
}

function matchesQuery(document, query) {
  return Object.entries(query).every(([key, value]) => matchesValue(document[key], value));
}

function sortByCreatedAtDesc(documents) {
  return [...documents].sort((first, second) => new Date(second.createdAt) - new Date(first.createdAt));
}

function loadNotificationRouter() {
  delete require.cache[notificationRoutePath];
  delete require.cache[notificationModelPath];
  delete require.cache[reviewModelPath];

  require.cache[notificationModelPath] = {
    id: notificationModelPath,
    filename: notificationModelPath,
    loaded: true,
    exports: {
      countDocuments: async (query) => {
        notificationCountCalls.push(query);
        return notificationDocuments.filter((notification) => matchesQuery(notification, query)).length;
      },
      find: (query) => {
        notificationFindCalls.push(query);
        const foundNotifications = sortByCreatedAtDesc(
          notificationDocuments.filter((notification) => matchesQuery(notification, query)),
        );

        return {
          sort: (sortOrder) => ({
            limit: async (limit) => {
              assert.deepEqual(sortOrder, { createdAt: -1 });
              return foundNotifications.slice(0, limit);
            },
          }),
        };
      },
      updateMany: async (query, update) => {
        notificationUpdateManyCalls.push({ query, update });
        const unreadIds = query._id.$in.map(String);

        notificationDocuments = notificationDocuments.map((notification) => {
          if (
            unreadIds.includes(String(notification._id))
            && notification.recipientUserId === query.recipientUserId
            && notification.readAt === null
          ) {
            return { ...notification, readAt: update.$set.readAt };
          }

          return notification;
        });
      },
    },
  };

  require.cache[reviewModelPath] = {
    id: reviewModelPath,
    filename: reviewModelPath,
    loaded: true,
    exports: {
      find: async (query) => {
        reviewFindCalls.push(query);
        const reviewIds = query._id.$in.map(String);

        return reviewDocuments.filter((review) => reviewIds.includes(String(review._id)));
      },
    },
  };

  require.cache[clerkPath] = {
    id: clerkPath,
    filename: clerkPath,
    loaded: true,
    exports: {
      getAuth: () => ({ userId: authUserId }),
      clerkClient: {
        users: {
          getUserList: async (query) => {
            getUserListCalls.push(query);

            if (shouldRejectClerkLookup) {
              throw new Error("Clerk lookup failed");
            }

            return { data: clerkUsers };
          },
        },
      },
    },
  };

  return require("../routes/notifications");
}

async function callRoute(method, path) {
  const router = loadNotificationRouter();
  const route = router.stack.find(
    (layer) => layer.route?.path === path && layer.route.methods[method],
  );

  assert.ok(route, `${method.toUpperCase()} ${path} should be registered`);

  const req = {};
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this.body = data;
      return this;
    },
  };

  for (const handler of route.route.stack.map((layer) => layer.handle)) {
    let nextWasCalled = false;
    await handler(req, res, () => {
      nextWasCalled = true;
    });

    if (!nextWasCalled) {
      break;
    }
  }

  return {
    status: res.statusCode,
    body: res.body,
  };
}

test.beforeEach(() => {
  notificationDocuments = [];
  reviewDocuments = [];
  authUserId = "user_clerk_123";
  clerkUsers = [];
  shouldRejectClerkLookup = false;
  notificationFindCalls.length = 0;
  notificationCountCalls.length = 0;
  notificationUpdateManyCalls.length = 0;
  reviewFindCalls.length = 0;
  getUserListCalls.length = 0;
});

test("GET /notifications/unread-count returns only current user unread notifications", async () => {
  notificationDocuments = [
    { _id: "notification_1", recipientUserId: "user_clerk_123", readAt: null },
    { _id: "notification_2", recipientUserId: "user_clerk_123", readAt: new Date("2026-06-16T10:00:00.000Z") },
    { _id: "notification_3", recipientUserId: "other_user", readAt: null },
  ];

  const response = await callRoute("get", "/unread-count");

  assert.equal(response.status, 200);
  assert.deepEqual(notificationCountCalls, [
    { recipientUserId: "user_clerk_123", readAt: null },
  ]);
  assert.deepEqual(response.body, { unreadCount: 1 });
});

test("GET /notifications returns newest notifications and marks unread rows read", async () => {
  const readAt = new Date("2026-06-15T10:00:00.000Z");
  notificationDocuments = [
    {
      _id: "notification_old",
      recipientUserId: "user_clerk_123",
      actorUserId: "follower_user",
      type: "follow",
      readAt,
      createdAt: new Date("2026-06-15T12:00:00.000Z"),
      updatedAt: new Date("2026-06-15T12:00:00.000Z"),
    },
    {
      _id: "notification_new",
      recipientUserId: "user_clerk_123",
      actorUserId: "liker_user",
      type: "review_like",
      reviewId: "review_123",
      spotifyId: "spotify_album_123",
      readAt: null,
      createdAt: new Date("2026-06-16T12:00:00.000Z"),
      updatedAt: new Date("2026-06-16T12:00:00.000Z"),
    },
  ];
  reviewDocuments = [
    {
      _id: "review_123",
      spotifyId: "spotify_album_123",
      title: "Kind of Blue",
      artist: "Miles Davis",
      cover: "https://example.com/kind-of-blue.jpg",
      rating: 5,
    },
  ];
  clerkUsers = [
    {
      id: "liker_user",
      username: "liker",
      imageUrl: "https://example.com/liker.jpg",
    },
    {
      id: "follower_user",
      username: "follower",
      imageUrl: "https://example.com/follower.jpg",
    },
  ];

  const response = await callRoute("get", "/");

  assert.equal(response.status, 200);
  assert.deepEqual(notificationFindCalls, [{ recipientUserId: "user_clerk_123" }]);
  assert.deepEqual(getUserListCalls, [{ userId: ["liker_user", "follower_user"] }]);
  assert.deepEqual(reviewFindCalls, [{ _id: { $in: ["review_123"] } }]);
  assert.equal(notificationUpdateManyCalls.length, 1);
  assert.deepEqual(notificationUpdateManyCalls[0].query, {
    _id: { $in: ["notification_new"] },
    recipientUserId: "user_clerk_123",
    readAt: null,
  });
  assert.equal(response.body.notifications.length, 2);
  assert.equal(response.body.notifications[0]._id, "notification_new");
  assert.equal(response.body.notifications[0].actor.username, "liker");
  assert.equal(response.body.notifications[0].review.title, "Kind of Blue");
  assert.equal(response.body.notifications[1]._id, "notification_old");
  assert.equal(response.body.notifications[1].actor.username, "follower");
  assert.ok(notificationDocuments.find((notification) => (
    notification._id === "notification_new" && notification.readAt instanceof Date
  )));
});
