const express = require("express");
const Album = require("../models/Albums");
const AlbumCatalog = require("../models/AlbumCatalog");
const { getAuth } = require("@clerk/express");
const {
    getOrCreateAlbumCatalog,
    normalizeCatalogAlbum,
} = require("./utils/albumCatalog");
const router = express.Router();

function ensureAuthenticated(req, res, next) {
    const { userId } = getAuth(req);

    if (!userId) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    req.userId = userId;
    next();
}

router.get("/catalog", async (req, res) => {
    try {
        const albums = await AlbumCatalog.find({}).sort({ artist: 1, title: 1 });
        res.json(albums.map(normalizeCatalogAlbum));
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
