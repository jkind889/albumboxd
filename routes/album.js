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
            artists: data.artists?.map((artist) => artist.name) || [],
            year: data.release_date?.slice(0, 4) || "unknown",
            releaseDate: data.release_date || "",
            genres: data.genres || [],
            imgs: data.images || [],
            totalTracks: data.total_tracks || 0,
            label: data.label || "",
            albumType: data.album_type || "album",
            spotifyUrl: data.external_urls?.spotify || ""
        };
        res.json(album);
    } catch (error) {
        res.status(500).json({ error: "Failed to fetch album details" });
    }
});

router.post("/album", ensureAuthenticated, async(req, res) => 
{
    try {
        const album = await Album.create({ ...req.body, userId: req.userId });
        res.status(201).json(album);
    } catch (error) {
        if (error.code === 11000) {
            return res.status(409).json({ error: "Album already exists in your collection" });
        }

        console.log(error);
        res.status(500).json({ error: "Failed to create album" });
    }
});




module.exports = router
