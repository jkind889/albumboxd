const express = require("express")
const { getSpotifyAccessToken } = require("./utils/spotify");
const AlbumCatalog = require("../models/AlbumCatalog");
const {
    normalizeSpotifyAlbum,
    toSearchResult,
    upsertAlbumCatalog,
} = require("./utils/albumCatalog");
const {
    consumeSpotifyRateLimit,
    getUserOrIpRateLimitKey,
    isRateLimitError,
    searchRateLimit,
    sendRateLimitError,
} = require("./utils/rateLimit");
const router = express.Router()
const SEARCH_RESULT_LIMIT = 24;
const MAX_SEARCH_RESULT_LIMIT = 24;

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

function getPositiveInteger(value, fallback) {
    const parsedValue = Number.parseInt(value, 10);

    if (Number.isNaN(parsedValue) || parsedValue < 1) {
        return fallback;
    }

    return parsedValue;
}

function getSearchLimit(value) {
    return Math.min(getPositiveInteger(value, SEARCH_RESULT_LIMIT), MAX_SEARCH_RESULT_LIMIT);
}

async function getPagedLocalAlbums(query, { limit, skip }) {
    const textQuery = { $text: { $search: query } };
    const textCount = await AlbumCatalog.countDocuments(textQuery);

    if (textCount > 0) {
        const albums = await AlbumCatalog.find(
            textQuery,
            { score: { $meta: "textScore" } },
        )
            .sort({ score: { $meta: "textScore" } })
            .skip(skip)
            .limit(limit);

        return {
            albums,
            total: textCount,
        };
    }

    const regexQuery = buildRegexSearchQuery(query);
    const regexCount = await AlbumCatalog.countDocuments(regexQuery);
    const albums = await AlbumCatalog.find(regexQuery)
        .skip(skip)
        .limit(limit);

    return {
        albums,
        total: regexCount,
    };
}

async function searchSpotifyAlbums(query, { limit, offset = 0, excludedIds = [], rateLimitKey }) {
    if (limit <= 0) {
        return {
            results: [],
            total: 0,
        };
    }

    if (rateLimitKey) {
        await consumeSpotifyRateLimit(rateLimitKey);
    }

    const token = await getSpotifyAccessToken();

    const response = await fetch(`https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=album&limit=${limit}&offset=${offset}`, {
        headers: {
            "Authorization": `Bearer ${token}`
        }
    });

    if (!response.ok) {
        throw new Error(`Spotify search failed with status ${response.status}`);
    }

    const data = await response.json();
    const spotifyItems = data.albums.items || [];
    const spotifyTotal = Number(data.albums.total) || spotifyItems.length;
    const seenAlbums = new Set(excludedIds);
    const spotifyAlbums = await Promise.all(
        spotifyItems.map((item) => upsertAlbumCatalog(normalizeSpotifyAlbum(item))),
    );
    const results = [];

    for (const catalogAlbum of spotifyAlbums) {
        const result = toSearchResult(catalogAlbum);

        if (seenAlbums.has(result.id)) {
            continue;
        }

        seenAlbums.add(result.id);
        results.push(result);
    }

    return {
        results,
        total: spotifyTotal,
    };
}

async function getPagedSearchResults(query, { page, limit, rateLimitKey }) {
    const pageOffset = (page - 1) * limit;
    const localSearch = await getPagedLocalAlbums(query, {
        limit,
        skip: pageOffset,
    });
    const localResults = localSearch.albums.map(toSearchResult);
    const missingCount = limit - localResults.length;
    let spotifyResults = [];
    let spotifyTotal = 0;

    if (missingCount > 0) {
        const spotifyOffset = Math.max(pageOffset - localSearch.total, 0);
        const spotifySearch = await searchSpotifyAlbums(query, {
            limit: missingCount,
            offset: spotifyOffset,
            excludedIds: localResults.map((result) => result.id),
            rateLimitKey,
        });

        spotifyResults = spotifySearch.results;
        spotifyTotal = spotifySearch.total;
    }

    const results = [...localResults, ...spotifyResults];
    const totalAvailable = localSearch.total + spotifyTotal;
    const consumedCount = pageOffset + results.length;

    return {
        results,
        page,
        limit,
        hasPreviousPage: page > 1,
        hasNextPage: consumedCount < totalAvailable,
    };
}

router.get("/search", searchRateLimit, async(req, res) =>
{
    const query = req.query.q?.trim();

    if (!query) {
        return res.json([]);
    }

    try {
        const rateLimitKey = getUserOrIpRateLimitKey(req);

        if (req.query.page !== undefined) {
            const page = getPositiveInteger(req.query.page, 1);
            const limit = getSearchLimit(req.query.limit);
            return res.json(await getPagedSearchResults(query, { page, limit, rateLimitKey }));
        }

        // Return local catalog hits first; only ask Spotify when the cache cannot fill the page.
        const localAlbums = await getLocalAlbums(query);
        const localResults = localAlbums.map(toSearchResult);

        if (localResults.length >= SEARCH_RESULT_LIMIT) {
            return res.json(localResults);
        }

        const spotifyLimit = SEARCH_RESULT_LIMIT - localResults.length;
        const spotifySearch = await searchSpotifyAlbums(query, {
            limit: spotifyLimit,
            excludedIds: localResults.map((result) => result.id),
            rateLimitKey,
        });
        const results = [...localResults, ...spotifySearch.results];

        res.json(results);
    } catch (error) {
        if (isRateLimitError(error)) {
            return sendRateLimitError(res, error);
        }

        res.status(500).json({ error: "Failed to fetch search results" });
    }
})

module.exports = router
