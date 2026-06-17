require("dotenv").config();

const mongoose = require("mongoose");
const Album = require("../models/Albums");
const AlbumCatalog = require("../models/AlbumCatalog");
const Follow = require("../models/Follow");
const Review = require("../models/Reviews");
const UserProfile = require("../models/UserProfile");

const viewerUserId = process.env.DEMO_VIEWER_ID || process.env.SOCIAL_SEED_VIEWER_ID || "user_clerk_123";

const demoAlbums = [
  {
    _id: "64b000000000000000000001",
    spotifyId: "demo-kind-of-blue",
    title: "Kind of Blue",
    artist: "Miles Davis",
    artists: ["Miles Davis"],
    year: "1959",
    releaseDate: "1959-08-17",
    cover: "https://i.scdn.co/image/ab67616d0000b273c1f7fcb6f97a50e1c47509d1",
    totalTracks: 5,
    label: "Columbia",
    albumType: "album",
  },
  {
    _id: "64b000000000000000000002",
    spotifyId: "demo-blue-train",
    title: "Blue Train",
    artist: "John Coltrane",
    artists: ["John Coltrane"],
    year: "1958",
    releaseDate: "1958",
    cover: "https://i.scdn.co/image/ab67616d0000b273e04f675c220cbe73b74d2e8f",
    totalTracks: 5,
    label: "Blue Note",
    albumType: "album",
  },
  {
    _id: "64b000000000000000000003",
    spotifyId: "demo-miseducation",
    title: "The Miseducation of Lauryn Hill",
    artist: "Ms. Lauryn Hill",
    artists: ["Ms. Lauryn Hill"],
    year: "1998",
    releaseDate: "1998-08-25",
    cover: "https://i.scdn.co/image/ab67616d0000b273cf6f1f9bbf07c2f51a5d8b7f",
    totalTracks: 16,
    label: "Ruffhouse",
    albumType: "album",
  },
];

const demoProfiles = [
  {
    userId: viewerUserId,
    bio: "Demo viewer following a few albumboxd listeners.",
    favoriteAlbums: [],
  },
  {
    userId: "demo_user_ada",
    bio: "Jazz shelves, liner notes, and repeat listens.",
    favoriteAlbums: [
      {
        spotifyId: "demo-kind-of-blue",
        albumCatalogId: demoAlbums[0]._id,
        rank: 0,
      },
      {
        spotifyId: "demo-blue-train",
        albumCatalogId: demoAlbums[1]._id,
        rank: 1,
      },
    ],
  },
  {
    userId: "demo_user_miles",
    bio: "Looking for records that feel lived in.",
    favoriteAlbums: [
      {
        spotifyId: "demo-miseducation",
        albumCatalogId: demoAlbums[2]._id,
        rank: 0,
      },
    ],
  },
];

const demoReviews = [
  {
    _id: "65b000000000000000000001",
    userId: "demo_user_ada",
    spotifyId: "demo-kind-of-blue",
    title: "Kind of Blue",
    artist: "Miles Davis",
    cover: demoAlbums[0].cover,
    rating: 5,
    reviewText: "Still sounds like a room changing temperature.",
    date: new Date("2026-06-10T18:30:00.000Z"),
  },
  {
    _id: "65b000000000000000000002",
    userId: "demo_user_miles",
    spotifyId: "demo-miseducation",
    title: "The Miseducation of Lauryn Hill",
    artist: "Ms. Lauryn Hill",
    cover: demoAlbums[2].cover,
    rating: 5,
    reviewText: "A personal record that somehow keeps getting bigger.",
    date: new Date("2026-06-11T20:15:00.000Z"),
  },
  {
    _id: "65b000000000000000000003",
    userId: "demo_user_ada",
    spotifyId: "demo-blue-train",
    title: "Blue Train",
    artist: "John Coltrane",
    cover: demoAlbums[1].cover,
    rating: 4,
    reviewText: "Bright, direct, and impossible to leave alone.",
    date: new Date("2026-06-12T16:45:00.000Z"),
  },
];

const demoSavedAlbums = [
  {
    userId: "demo_user_ada",
    spotifyId: "demo-kind-of-blue",
    albumCatalogId: demoAlbums[0]._id,
    savedAt: new Date("2026-06-09T14:00:00.000Z"),
  },
  {
    userId: "demo_user_miles",
    spotifyId: "demo-miseducation",
    albumCatalogId: demoAlbums[2]._id,
    savedAt: new Date("2026-06-10T14:00:00.000Z"),
  },
];

async function seedSocialDemo() {
  if (!process.env.MONGO_URI) {
    throw new Error("Missing MONGO_URI in the server environment.");
  }

  await mongoose.connect(process.env.MONGO_URI);

  for (const album of demoAlbums) {
    await AlbumCatalog.findOneAndUpdate(
      { spotifyId: album.spotifyId },
      { $set: album },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
  }

  for (const profile of demoProfiles) {
    await UserProfile.findOneAndUpdate(
      { userId: profile.userId },
      { $set: profile },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
  }

  for (const review of demoReviews) {
    await Review.findOneAndUpdate(
      { _id: review._id },
      { $set: review },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
  }

  for (const savedAlbum of demoSavedAlbums) {
    await Album.findOneAndUpdate(
      { spotifyId: savedAlbum.spotifyId, userId: savedAlbum.userId },
      { $set: savedAlbum },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
  }

  for (const followingId of ["demo_user_ada", "demo_user_miles"]) {
    await Follow.updateOne(
      { followerId: viewerUserId, followingId },
      { $setOnInsert: { followerId: viewerUserId, followingId } },
      { upsert: true },
    );
  }

  console.log(`Seeded social demo data. Following feed viewer: ${viewerUserId}`);
}

seedSocialDemo()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.connection.close();
  });
