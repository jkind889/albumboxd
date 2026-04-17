const express = require("express");
const router = express.Router();

router.get("/album/:id", async(req, res) =>
{
    try {
        const response = await fetch(
            `https://api.discogs.com/releases/${req.params.id}`,
            {
                headers:
                {
                    "User-Agent": "album-boxd/1.0"
                }
            }
        );

        const data = await response.json();

        const album = {
            id: data.id,
            title: data.title,
            artist: data.artists?.[0]?.name || "Unknown Artist",
            year: data.year,
            genres: data.genres || [],
            imgs: data.images || []
        };
        res.json(album);
    } catch (error) {
        res.status(500).json({ error: "Failed to fetch album details" });
    }
});







module.exports = router
