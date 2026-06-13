const express = require("express")
const { getSpotifyAccessToken } = require("./utils/spotify");
const AlbumCatalog = require("../models/AlbumCatalog");
const {
    normalizeSpotifyAlbum,
    toSearchResult,
    upsertAlbumCatalog,
} = require("./utils/albumCatalog");
const router = express.Router()
const SEARCH_RESULT_LIMIT = 24;

// User search text becomes a regex query, so escape special characters first.
function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildRegexSearchQuery(query) {
    const escapedQuery = escapeRegex(query);

    return {
        $or: [
            { title: { $regex: escapedQuery, $options: "i" } },
            { artist: { $regex: escapedQuery, $options: "i" } },
            { artists: { $regex: escapedQuery, $options: "i" } },
        ],
    };
}

async function getLocalAlbums(query) {
    const textAlbums = await AlbumCatalog.find(
        { $text: { $search: query } },
        { score: { $meta: "textScore" } },
    )
        .sort({ score: { $meta: "textScore" } })
        .limit(SEARCH_RESULT_LIMIT);

    if (textAlbums.length > 0) {
        return textAlbums;
    }

    return AlbumCatalog.find(buildRegexSearchQuery(query)).limit(SEARCH_RESULT_LIMIT);
}

router.get("/search", async(req, res) =>
{
    const query = req.query.q?.trim();

    if (!query) {
        return res.json([]);
    }

    try {
        // Return local catalog hits first; only ask Spotify when the cache cannot fill the page.
        const localAlbums = await getLocalAlbums(query);
        const localResults = localAlbums.map(toSearchResult);

        if (localResults.length >= SEARCH_RESULT_LIMIT) {
            return res.json(localResults);
        }

        const token = await getSpotifyAccessToken();

        const spotifyLimit = SEARCH_RESULT_LIMIT - localResults.length;
        const response = await fetch(`https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=album&limit=${spotifyLimit}`, {
            headers: {
                "Authorization": `Bearer ${token}`
            }
        });

        if (!response.ok) {
            throw new Error(`Spotify search failed with status ${response.status}`);
        }

        const data = await response.json();
        const seenAlbums = new Set(localResults.map((result) => result.id));
        const spotifyItems = data.albums.items || [];
        const spotifyAlbums = await Promise.all(
            spotifyItems.map((item) => upsertAlbumCatalog(normalizeSpotifyAlbum(item))),
        );

        const results = [...localResults];
        for (const catalogAlbum of spotifyAlbums) {
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
