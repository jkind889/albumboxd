const express = require("express")
const { getSpotifyAccessToken } = require("./utils/spotify");
const AlbumCatalog = require("../models/AlbumCatalog");
const {
    normalizeSpotifyAlbum,
    toSearchResult,
    upsertAlbumCatalog,
} = require("./utils/albumCatalog");
const router = express.Router()

// User search text becomes a regex query, so escape special characters first.
function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

router.get("/search", async(req, res) =>
{
    const query = req.query.q?.trim();

    if (!query) {
        return res.json([]);
    }

    try {
        // Return local catalog hits first, then warm the cache with fresh Spotify results.
        const escapedQuery = escapeRegex(query);
        const localAlbums = await AlbumCatalog.find({
            $or: [
                { title: { $regex: escapedQuery, $options: "i" } },
                { artist: { $regex: escapedQuery, $options: "i" } },
                { artists: { $regex: escapedQuery, $options: "i" } },
            ],
        }).limit(24);

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

        for (const album of localAlbums) {
            const result = toSearchResult(album);
            seenAlbums.add(result.id);
            results.push(result);
        }

        for (const item of data.albums.items || []) {
            const catalogAlbum = await upsertAlbumCatalog(normalizeSpotifyAlbum(item));
            const result = toSearchResult(catalogAlbum);

            if (seenAlbums.has(result.id)) {
                continue;
            }

            seenAlbums.add(result.id);
            results.push(result);
        }

        res.json(results);
    } catch (error) {
        res.status(500).json({ error: "Failed to fetch search results" });
    }
})

module.exports = router
