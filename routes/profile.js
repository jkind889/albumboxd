const express = require("express");
const { getAuth } = require("@clerk/express");
const UserProfile = require("../models/UserProfile");
const Follow = require("../models/Follow");
const Review = require("../models/Reviews");
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
    userId: source.userId,
    bio: source.bio || "",
    favoriteAlbums,
  };
}

async function getSocialStats(userId, viewerId) {
  const [followerCount, followingCount, isFollowing] = await Promise.all([
    Follow.countDocuments({ followingId: userId }),
    Follow.countDocuments({ followerId: userId }),
    viewerId && viewerId !== userId
      ? Follow.exists({ followerId: viewerId, followingId: userId })
      : Promise.resolve(false),
  ]);

  return {
    followerCount,
    followingCount,
    isFollowing: Boolean(isFollowing),
    isCurrentUser: Boolean(viewerId && viewerId === userId),
  };
}

async function formatProfileWithSocial(profile, viewerId) {
  const formattedProfile = formatProfile(profile);
  const socialStats = await getSocialStats(formattedProfile.userId, viewerId);

  return {
    ...formattedProfile,
    ...socialStats,
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

async function isFollowableUser(userId) {
  return Boolean(await Review.exists({ userId }));
}

router.get("/me", ensureAuthenticated, async(req, res) => {
  try {
    const profile = await getOrCreateProfile(req.userId);
    res.json(await formatProfileWithSocial(profile, req.userId));
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

    res.json(await formatProfileWithSocial(profile, req.userId));
  } catch (error) {
    console.log(error);
    res.status(500).json({ error: "Failed to update profile" });
  }
});

router.put("/:userId/follow", ensureAuthenticated, async(req, res) => {
  try {
    const targetUserId = String(req.params.userId || "").trim();

    if (req.body.following !== true && req.body.following !== false) {
      return res.status(400).json({ error: "following must be true or false" });
    }

    if (!targetUserId) {
      return res.status(400).json({ error: "User id is required" });
    }

    if (targetUserId === req.userId) {
      return res.status(400).json({ error: "You cannot follow yourself" });
    }

    if (!(await isFollowableUser(targetUserId))) {
      return res.status(404).json({ error: "User not found" });
    }

    await Promise.all([
      getOrCreateProfile(req.userId),
      getOrCreateProfile(targetUserId),
    ]);

    if (req.body.following) {
      await Follow.updateOne(
        { followerId: req.userId, followingId: targetUserId },
        { $setOnInsert: { followerId: req.userId, followingId: targetUserId } },
        { upsert: true },
      );
    } else {
      await Follow.deleteOne({ followerId: req.userId, followingId: targetUserId });
    }

    res.json({
      targetUserId,
      ...(await getSocialStats(targetUserId, req.userId)),
    });
  } catch (error) {
    console.log(error);
    res.status(500).json({ error: "Failed to update follow status" });
  }
});

router.get("/:userId", async(req, res) => {
  try {
    const targetUserId = String(req.params.userId || "").trim();
    const { userId: viewerId } = getAuth(req);

    if (!targetUserId) {
      return res.status(400).json({ error: "User id is required" });
    }

    if (!(await isFollowableUser(targetUserId))) {
      return res.status(404).json({ error: "User not found" });
    }

    const profile = await getOrCreateProfile(targetUserId);
    res.json(await formatProfileWithSocial(profile, viewerId));
  } catch (error) {
    console.log(error);
    res.status(500).json({ error: "Failed to fetch profile" });
  }
});

module.exports = router;
