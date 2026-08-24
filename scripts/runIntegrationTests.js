#!/usr/bin/env node

const { spawnSync } = require("node:child_process");

const files = [
  "tests/moderation.integration.test.js",
  "tests/catalogImport.integration.test.js",
  "tests/legacyMigration.integration.test.js",
];
const result = spawnSync(process.execPath, ["--test", ...files], {
  stdio: "inherit",
  env: { ...process.env, RUN_MONGO_INTEGRATION: "true" },
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
