const express = require("express")
const router = express.Router()

router.get("/search", async(req, res) =>
{

    const query = req.query.q;

    const response = await fetch(
        `https://api.discogs.com/database/search?q=${query}&type=release`,
        {
            headers:
            {
                "User-Agent": "album-boxd/1.0"
            }
        }
    );

    const data = await response.json()

    const results = data.results.slice(0, 10).map(item => ({
      id: item.id,
      title: item.title,
      year: item.year,
      cover: item.cover_image
    }));

    res.json(results);
})

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
            genres: data.genres || []
        };
        res.json(album);
    } catch (error) {
        res.status(500).json({ error: "Failed to fetch album details" });
    }
});







module.exports = router