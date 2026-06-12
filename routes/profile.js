const express = require("express");
const { getAuth } = require("@clerk/express");
const UserProfile = require("../models/UserProfile");
const {
  getOrCreateAlbumCatalog,
  normalizeCatalogAlbum,
} = require("./utils/albumCatalog");

const router = express.Router();
const MAX_BIO_LENGTH = 280;
const MAX_FAVORITE_ALBUMS = 5;

function ensureAuthenticated(req, res, next) {
  const { userId } = getAuth(req);

  if (!userId) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  req.userId = userId;
  next();
}

function getCatalogAlbum(favoriteAlbum) {
  const catalogAlbum = favoriteAlbum.albumCatalogId;

  if (catalogAlbum && typeof catalogAlbum === "object" && catalogAlbum.spotifyId) {
    return catalogAlbum;
  }

  return {
    spotifyId: favoriteAlbum.spotifyId,
    title: "Unknown Album",
    artist: "Unknown Artist",
  };
}

function formatProfile(profile) {
  const source = typeof profile.toObject === "function" ? profile.toObject() : profile;
  const favoriteAlbums = [...(source.favoriteAlbums || [])]
    .sort((first, second) => first.rank - second.rank)
    .map((favoriteAlbum) => normalizeCatalogAlbum(getCatalogAlbum(favoriteAlbum)));

  return {
    bio: source.bio || "",
    favoriteAlbums,
  };
}

async function getOrCreateProfile(userId) {
  const existingProfile = await UserProfile.findOne({ userId })
    .populate("favoriteAlbums.albumCatalogId");

  if (existingProfile) {
    return existingProfile;
  }

  return UserProfile.create({
    userId,
    bio: "",
    favoriteAlbums: [],
  });
}

router.get("/me", ensureAuthenticated, async(req, res) => {
  try {
    const profile = await getOrCreateProfile(req.userId);
    res.json(formatProfile(profile));
  } catch (error) {
    console.log(error);
    res.status(500).json({ error: "Failed to fetch profile" });
  }
});

router.put("/me", ensureAuthenticated, async(req, res) => {
  try {
    const bio = typeof req.body.bio === "string" ? req.body.bio.trim() : "";
    const favoriteAlbumIds = Array.isArray(req.body.favoriteAlbumIds)
      ? req.body.favoriteAlbumIds.map((id) => String(id).trim()).filter(Boolean)
      : [];

    if (bio.length > MAX_BIO_LENGTH) {
      return res.status(400).json({ error: "Bio must be 280 characters or fewer" });
    }

    if (favoriteAlbumIds.length > MAX_FAVORITE_ALBUMS) {
      return res.status(400).json({ error: "Choose up to five favorite albums" });
    }

    if (new Set(favoriteAlbumIds).size !== favoriteAlbumIds.length) {
      return res.status(400).json({ error: "Favorite albums must be unique" });
    }

    const favoriteAlbums = await Promise.all(
      favoriteAlbumIds.map(async(spotifyId, index) => {
        const catalogAlbum = await getOrCreateAlbumCatalog(spotifyId);

        return {
          spotifyId,
          albumCatalogId: catalogAlbum._id,
          rank: index,
        };
      }),
    );

    const profile = await UserProfile.findOneAndUpdate(
      { userId: req.userId },
      {
        $set: {
          userId: req.userId,
          bio,
          favoriteAlbums,
        },
      },
      {
        new: true,
        upsert: true,
        setDefaultsOnInsert: true,
      },
    ).populate("favoriteAlbums.albumCatalogId");

    res.json(formatProfile(profile));
  } catch (error) {
    console.log(error);
    res.status(500).json({ error: "Failed to update profile" });
  }
});

module.exports = router;
