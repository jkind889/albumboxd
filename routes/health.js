const express = require("express");
const mongoose = require("mongoose");

const router = express.Router();

const DATABASE_STATES = {
  0: "disconnected",
  1: "connected",
  2: "connecting",
  3: "disconnecting",
};

function getDatabaseStatus() {
  const readyState = mongoose.connection.readyState;

  return {
    status: DATABASE_STATES[readyState] || "unknown",
    readyState,
  };
}

router.get("/", (req, res) => {
  const database = getDatabaseStatus();

  res.status(200).json({
    status: database.status === "connected" ? "ok" : "degraded",
    service: "rescened-api",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    database,
  });
});

module.exports = router;
module.exports.getDatabaseStatus = getDatabaseStatus;
