const express = require("express");
const AlbumCatalog = require("../models/AlbumCatalog");
const { normalizeCatalogAlbum, toSearchResult } = require("./utils/albumCatalog");

const router = express.Router();
const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 24;

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getLimit(value) {
  const parsed = Number.parseInt(value, 10);
  return Math.min(Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_LIMIT, MAX_LIMIT);
}

function buildQuery(query) {
  const escaped = escapeRegex(query);
  return {
    $or: [
      { title: { $regex: escaped, $options: "i" } },
      { artistDisplayName: { $regex: escaped, $options: "i" } },
      { "artistCredits.name": { $regex: escaped, $options: "i" } },
      { label: { $regex: escaped, $options: "i" } },
    ],
  };
}

async function findLocal(query, { skip = 0, limit }) {
  const searchQuery = buildQuery(query);
  const [total, albums] = await Promise.all([
    AlbumCatalog.countDocuments(searchQuery),
    AlbumCatalog.find(searchQuery).sort({ artistDisplayName: 1, title: 1 }).skip(skip).limit(limit),
  ]);
  return { total, albums };
}

router.get("/search", async (req, res) => {
  const query = String(req.query.q || "").trim();
  if (!query) return res.json([]);

  try {
    const limit = getLimit(req.query.limit);
    if (req.query.page !== undefined) {
      const page = Math.max(Number.parseInt(req.query.page, 10) || 1, 1);
      const result = await findLocal(query, { skip: (page - 1) * limit, limit });
      return res.json({
        results: result.albums.map(toSearchResult),
        page,
        limit,
        hasPreviousPage: page > 1,
        hasNextPage: page * limit < result.total,
      });
    }
    const result = await findLocal(query, { limit });
    return res.json(result.albums.map(toSearchResult));
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Failed to fetch search results" });
  }
});

module.exports = router;
