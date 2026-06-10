const express = require("express");
const { getSpotifyAccessToken } = require("./utils/spotify");
const Album = require("../models/Albums");
const { getAuth } = require("@clerk/express");
const router = express.Router();

function ensureAuthenticated(req, res, next) {
    const { userId } = getAuth(req);

    if (!userId) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    req.userId = userId;
    next();
}

router.get("/collection", ensureAuthenticated, async(req, res) =>
{
    const userId = req.userId;

    try {
        const albums = await Album.find({ userId });
        res.json(albums);
    } catch (error) {
        console.log(error);
        res.status(500).json({ error: "Failed to fetch albums" });
    }
});


router.get("/collection/:spotifyId", ensureAuthenticated, async(req, res) => {
    try {
        const  userId  = req.userId;
        const { spotifyId } = req.params;

        const album = await Album.findOne({ spotifyId, userId });
        res.json({
            saved: !!album,
            album,
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
