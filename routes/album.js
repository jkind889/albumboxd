const express = require("express");
const { getSpotifyAccessToken } = require("./utils/spotify");
const Album = require("../models/Albums");
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

router.post("/album", async(req, res) => 
{
    try {
        const album = await Album.create(req.body);
        res.status(201).json(album);
    } catch (error) {
        console.log(error);
        res.status(500).json({ error: "Failed to create album" });
    }
});

router.get("/user/:userId", async(req, res) =>
{
    try {
        const albums = await Album.find({ userId: req.params.userId });
        res.json(albums);
    } catch (error) {
        console.log(error);
        res.status(500).json({ error: "Failed to fetch albums" });
    }
});

router.delete("/album/:id", async(req, res) => {
    try {
        await Album.findOneAndDelete({ spotifyId: req.params.id });
        res.json({ message: "Album removed from collection" });
    } catch (error) {
        console.log(error)
        res.status(500).json({ error: "Failed to remove album" });
    }  
});




module.exports = router
