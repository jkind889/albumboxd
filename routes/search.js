const express = require("express")
const { getSpotifyAccessToken } = require("./utils/spotify");
const router = express.Router()

router.get("/search", async(req, res) =>
{
    const query = req.query.q?.trim();

    if (!query) {
        return res.json([]);
    }

    try {

        const token = await getSpotifyAccessToken();

        const response = await fetch(`https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=album&limit=24`, {
            headers: {
                "Authorization": `Bearer ${token}`
            }
        });

        if (!response.ok) {
            throw new Error(`Spotify search failed with status ${response.status}`);
        }

        const data = await response.json();
        const seenAlbums = new Set();
        const results = [];

        for (const item of data.albums.items || []) {
            // Create a unique key for each album based on master_id or a combination of title and year
            const normalizedTitle = (item.name || "").toLowerCase().trim();
            const artist = (item.artists?.[0]?.name || "Unknown Artist").toLowerCase().trim();

            const year = item.release_date?.slice(0, 4) || "unknown";


            const uniqueKey = `${normalizedTitle}-${artist}-${year}`;

            if (seenAlbums.has(uniqueKey)) {
                continue;
            }

            seenAlbums.add(uniqueKey);
            

            // Add the album to the results array with the necessary details
            results.push({  
                id: item.id,
                title: item.name,
                artist: item.artists?.[0]?.name || "Unknown Artist",
                year,
                cover: item.images?.[0]?.url || null
            });

        }

        res.json(results);
    } catch (error) {
        res.status(500).json({ error: "Failed to fetch search results" });
    }
})

module.exports = router