const express = require("express")
const Album = require("../models/Albums.js");
const AlbumCatalog = require("../models/AlbumCatalog.js");
const router = express.Router()

router.get("/", (req, res) => {
  res.send("auth route");
});

// Dev-only seed endpoint that mirrors the catalog-plus-user-save data shape.
router.post("/test", async (req, res) => {
  try {
    const catalogAlbum = await AlbumCatalog.findOneAndUpdate(
      { spotifyId: "123" },
      {
        $set: {
          spotifyId: "123",
          title: "Graduation",
          artist: "Kanye West",
          artists: ["Kanye West"],
          cover: "image_url",
        },
      },
      { returnDocument: "after", upsert: true, setDefaultsOnInsert: true },
    );

    const album = await Album.create({
      albumCatalogId: catalogAlbum._id,
      spotifyId: catalogAlbum.spotifyId,
      userId: "test_user",
    });

    res.json({
      ...album.toObject(),
      title: "Graduation",
      artist: "Kanye West",
      cover: "image_url",
    });
  } catch (err) {
    console.log(err);
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
