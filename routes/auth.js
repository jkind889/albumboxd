const express = require("express")
const Album = require("../models/Albums.js");
const router = express.Router()

router.get("/", (req, res) => {
  res.send("auth route");
});

router.post("/test", async (req, res) => {
  try {
    const album = await Album.create({
      spotifyId: "123",
      title: "Graduation",
      artist: "Kanye West",
      cover: "image_url",
    });

    res.json(album);
  } catch (err) {
    console.log(err);
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;


