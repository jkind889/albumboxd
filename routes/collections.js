const express = require("express");
const Album = require("../models/Albums");
const { getAuth } = require("@clerk/express");
const { normalizeCatalogAlbum } = require("./utils/albumCatalog");
const router = express.Router();

function ensureAuthenticated(req, res, next) {
    const { userId } = getAuth(req);

    if (!userId) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    req.userId = userId;
    next();
}

// Flattens populated catalog data so collection views can keep using title/artist/cover.
function formatSavedAlbum(savedAlbum) {
    const album = typeof savedAlbum.toObject === "function" ? savedAlbum.toObject() : savedAlbum;
    const catalogAlbum = album.albumCatalogId;

    if (!catalogAlbum || typeof catalogAlbum !== "object" || !catalogAlbum.spotifyId) {
        return album;
    }

    return {
        ...normalizeCatalogAlbum(catalogAlbum),
        _id: album._id,
        albumCatalogId: catalogAlbum._id,
        userId: album.userId,
        savedAt: album.savedAt,
    };
}

router.get("/collection", ensureAuthenticated, async(req, res) =>
{
    const userId = req.userId;

    try {
        const albums = await Album.find({ userId }).populate("albumCatalogId").sort({ savedAt: -1 });
        res.json(albums.map(formatSavedAlbum));
    } catch (error) {
        console.log(error);
        res.status(500).json({ error: "Failed to fetch albums" });
    }
});


router.get("/collection/:spotifyId", ensureAuthenticated, async(req, res) => {
    try {
        const  userId  = req.userId;
        const { spotifyId } = req.params;

        const album = await Album.findOne({ spotifyId, userId }).populate("albumCatalogId");
        res.json({
            saved: !!album,
            album: album ? formatSavedAlbum(album) : null,
        });
    } catch (error) {
            console.log(error);
            res.status(500).json({ error: "Failed to check album in collection" });
    }
});

router.delete("/collection/album/:id", ensureAuthenticated, async(req, res) => {
    try {
        await Album.findOneAndDelete({ spotifyId: req.params.id, userId: req.userId });
        res.json({ message: "Album removed from collection" });
    } catch (error) {
        console.log(error)
        res.status(500).json({ error: "Failed to remove album" });
    }  
});

module.exports = router 
