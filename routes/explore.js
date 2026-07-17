const express = require("express");
const AlbumCatalog = require("../models/AlbumCatalog");
const { getOrResolveArtist } = require("./utils/musicBrainz");

const router = express.Router();

function getAlbumArtistReference(album, spotifyArtistId) {
  const source = typeof album?.toObject === "function" ? album.toObject() : album;
  const artistReferences = [
    ...(source?.artistRefs || []),
    ...(source?.tracks || []).flatMap((track) => track.artistRefs || []),
  ];

  return artistReferences.find((artist) => artist.spotifyId === spotifyArtistId) || null;
}

router.get("/artists/:spotifyArtistId", async (req, res) => {
  const spotifyArtistId = String(req.params.spotifyArtistId || "").trim();

  try {
    const catalogAlbum = await AlbumCatalog.findOne({
      $or: [
        { "artistRefs.spotifyId": spotifyArtistId },
        { "tracks.artistRefs.spotifyId": spotifyArtistId },
      ],
    });
    const artistReference = getAlbumArtistReference(catalogAlbum, spotifyArtistId);

    if (!artistReference) {
      return res.status(404).json({
        error: "Artist has not been indexed in the album catalog yet",
      });
    }

    const result = await getOrResolveArtist({
      spotifyId: spotifyArtistId,
      name: artistReference.name,
    });

    return res.json(result);
  } catch (error) {
    console.error(`MusicBrainz resolution failed for artist ${spotifyArtistId}:`, error.message);
    return res.status(502).json({
      error: "Unable to resolve artist metadata right now",
    });
  }
});

module.exports = router;
module.exports.getAlbumArtistReference = getAlbumArtistReference;
