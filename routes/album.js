const express = require("express");
const Album = require("../models/Albums");
const AlbumCatalog = require("../models/AlbumCatalog");
const { getAuth } = require("@clerk/express");
const {
    getOrCreateAlbumCatalog,
    normalizeCatalogAlbum,
} = require("./utils/albumCatalog");
const router = express.Router();
const CATALOG_PAGE_LIMIT = 24;
const MAX_CATALOG_PAGE_LIMIT = 24;

function ensureAuthenticated(req, res, next) {
    const { userId } = getAuth(req);

    if (!userId) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    req.userId = userId;
    next();
}

function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getPositiveInteger(value, fallback) {
    const parsedValue = Number.parseInt(value, 10);

    if (Number.isNaN(parsedValue) || parsedValue < 1) {
        return fallback;
    }

    return parsedValue;
}

function getCatalogLimit(value) {
    return Math.min(getPositiveInteger(value, CATALOG_PAGE_LIMIT), MAX_CATALOG_PAGE_LIMIT);
}

function buildCatalogQuery(query) {
    const trimmedQuery = query?.trim();

    if (!trimmedQuery) {
        return {};
    }

    const escapedQuery = escapeRegex(trimmedQuery);

    return {
        $or: [
            { title: { $regex: escapedQuery, $options: "i" } },
            { artist: { $regex: escapedQuery, $options: "i" } },
            { artists: { $regex: escapedQuery, $options: "i" } },
            { year: { $regex: escapedQuery, $options: "i" } },
            { label: { $regex: escapedQuery, $options: "i" } },
            { albumType: { $regex: escapedQuery, $options: "i" } },
        ],
    };
}

router.get("/catalog", async (req, res) => {
    try {
        const page = getPositiveInteger(req.query.page, 1);
        const limit = getCatalogLimit(req.query.limit);
        const skip = (page - 1) * limit;
        const catalogQuery = buildCatalogQuery(req.query.q);
        const [total, albums] = await Promise.all([
            AlbumCatalog.countDocuments(catalogQuery),
            AlbumCatalog.find(catalogQuery)
                .sort({ artist: 1, title: 1 })
                .skip(skip)
                .limit(limit),
        ]);

        res.json({
            results: albums.map(normalizeCatalogAlbum),
            page,
            limit,
            total,
            hasPreviousPage: page > 1,
            hasNextPage: skip + albums.length < total,
        });
    } catch (error) {
        res.status(500).json({ error: "Failed to fetch album catalog" });
    }
});

// Album detail pages use the catalog cache before making any Spotify request.
router.get("/album/:id", async(req, res) =>
{
    try {
        const album = await getOrCreateAlbumCatalog(req.params.id);
        res.json(normalizeCatalogAlbum(album));
    } catch (error) {
        res.status(500).json({ error: "Failed to fetch album details" });
    }
});

// User saves only store a reference to the shared catalog album.
router.post("/album", ensureAuthenticated, async(req, res) => 
{
    try {
        const { spotifyId } = req.body;

        if (!spotifyId) {
            return res.status(400).json({ error: "spotifyId is required" });
        }

        const catalogAlbum = await getOrCreateAlbumCatalog(spotifyId);
        const savedAlbum = await Album.create({
            albumCatalogId: catalogAlbum._id,
            spotifyId,
            userId: req.userId,
        });

        res.status(201).json({
            ...normalizeCatalogAlbum(catalogAlbum),
            _id: savedAlbum._id,
            albumCatalogId: savedAlbum.albumCatalogId,
            userId: savedAlbum.userId,
            savedAt: savedAlbum.savedAt,
        });
    } catch (error) {
        if (error.code === 11000) {
            return res.status(409).json({ error: "Album already exists in your collection" });
        }

        console.log(error);
        res.status(500).json({ error: "Failed to create album" });
    }
});




module.exports = router
