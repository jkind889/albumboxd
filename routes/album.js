const express = require("express");
const { getSpotifyAccessToken } = require("./utils/spotify");
const router = express.Router();

router.get("/album/:id", async(req, res) =>
{
    try {
        const token = await getSpotifyAccessToken();

        const response = await fetch(`https://api.spotify.com/v1/albums/${req.params.id}`, {
            headers: {
                "Authorization": `Bearer ${token}`
            }
        });

        const data = await response.json();

        const album = {
            id: data.id,
            title: data.name,
            artist: data.artists?.[0]?.name || "Unknown Artist",
            year: data.release_date?.slice(0, 4) || "unknown",
            genres: data.genres || [],
            imgs: data.images || []
        };
        res.json(album);
    } catch (error) {
        res.status(500).json({ error: "Failed to fetch album details" });
    }
});







module.exports = router
