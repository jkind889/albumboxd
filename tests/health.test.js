const assert = require("node:assert/strict");
const test = require("node:test");

const mongoosePath = require.resolve("mongoose");
const healthRoutePath = require.resolve("../routes/health");

let readyState = 1;

function loadHealthRouter() {
  delete require.cache[healthRoutePath];

  require.cache[mongoosePath] = {
    id: mongoosePath,
    filename: mongoosePath,
    loaded: true,
    exports: {
      connection: {
        get readyState() {
          return readyState;
        },
      },
    },
  };

  return require("../routes/health");
}

async function callHealthRoute() {
  const router = loadHealthRouter();
  const route = router.stack.find(
    (layer) => layer.route?.path === "/" && layer.route.methods.get,
  );

  assert.ok(route, "GET /health should be registered");

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

  await route.route.stack[0].handle({}, res);

  return {
    status: res.statusCode,
    body: res.body,
  };
}

test.beforeEach(() => {
  readyState = 1;
});

test("GET /health returns ok when Mongo is connected", async () => {
  const response = await callHealthRoute();

  assert.equal(response.status, 200);
  assert.equal(response.body.status, "ok");
  assert.equal(response.body.service, "rescened-api");
  assert.equal(response.body.database.status, "connected");
  assert.equal(response.body.database.readyState, 1);
  assert.equal(typeof response.body.uptime, "number");
  assert.match(response.body.timestamp, /^\d{4}-\d{2}-\d{2}T/);
});

test("GET /health returns 503 when Mongo is disconnected", async () => {
  readyState = 0;

  const response = await callHealthRoute();

  assert.equal(response.status, 503);
  assert.equal(response.body.status, "degraded");
  assert.equal(response.body.database.status, "disconnected");
  assert.equal(response.body.database.readyState, 0);
});
