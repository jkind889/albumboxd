const express = require("express")
const router = express.Router()

router.get("/search", async(req, res) =>
{
    const query = req.query.q?.trim();

    if (!query) {
        return res.json([]);
    }

    try {
        const response = await fetch(
            `https://api.discogs.com/database/search?q=${encodeURIComponent(query)}&type=release&per_page=50`,
            {
                headers:
                {
                    "User-Agent": "album-boxd/1.0"
                }
            }
        );

        if (!response.ok) {
            throw new Error(`Discogs search failed with status ${response.status}`);
        }

        const data = await response.json();
        const seenAlbums = new Set();
        const results = [];

        for (const item of data.results || []) {
            // Create a unique key for each album based on master_id or a combination of title and year
            const normalizedTitle = (item.title || "").toLowerCase().trim();


            // Split the title into artist and album title using " - " as a separator, so artist holds the name and albumTitle holds the title of the album. If the title doesn't contain " - ", then artist will be "Unknown Artist" and albumTitle will be the full title.
            const [artist = "Unknown Artist", albumTitle = item.title || "Unknown Album"] =
                (item.title || "").split(/\s+-\s+(.+)/);




            // either discogs gives us a master_id which is unique to the album, or we create a key based on the title and year (since some releases don't have a master_id)
            const uniqueKey = item.master_id || `${normalizedTitle}-${artist}-${item.year || "unknown"}`;

            if (seenAlbums.has(uniqueKey)) {
                continue;
            }

            seenAlbums.add(uniqueKey);
            

            // Add the album to the results array with the necessary details
            results.push({  
                id: item.id,
                title: albumTitle,
                artist,
                year: item.year,
                cover: item.cover_image
            });

            if (results.length === 24) {
                break;
            }
        }

        res.json(results);
    } catch (error) {
        res.status(500).json({ error: "Failed to fetch search results" });
    }
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
