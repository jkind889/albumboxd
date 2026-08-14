require("dotenv").config();
const mongoose = require("mongoose");
const crypto = require("node:crypto");
const AlbumCatalog = require("../models/AlbumCatalog");
const Board = require("../models/Board");
const BoardItem = require("../models/BoardItem");
const Review = require("../models/Reviews");
const UserProfile = require("../models/UserProfile");

const albums = [
  { title: "Kind of Blue", artistDisplayName: "Miles Davis", releaseDate: "1959-08-17", cover: "https://placehold.co/640x640?text=Kind+of+Blue" },
  { title: "Blue Train", artistDisplayName: "John Coltrane", releaseDate: "1957-09-15", cover: "https://placehold.co/640x640?text=Blue+Train" },
  { title: "The Miseducation of Lauryn Hill", artistDisplayName: "Lauryn Hill", releaseDate: "1998-08-25", cover: "https://placehold.co/640x640?text=Miseducation" },
].map((album) => ({ ...album, albumId: crypto.randomUUID(), catalogSource: "manual" }));

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  const inserted = await AlbumCatalog.insertMany(albums, { ordered: true });
  const userIds = ["demo_listener", "demo_reviewer"];
  const boards = await Promise.all(userIds.map((userId) => Board.create({ userId, title: "Saved albums", isDefault: true })));
  await BoardItem.insertMany([
    { userId: userIds[0], boardId: boards[0]._id, albumCatalogId: inserted[0]._id },
    { userId: userIds[1], boardId: boards[1]._id, albumCatalogId: inserted[2]._id },
  ]);
  await Review.create({ userId: userIds[1], albumCatalogId: inserted[2]._id, rating: 5, reviewText: "A landmark record." });
  await UserProfile.create(userIds.map((userId, index) => ({ userId, favoriteAlbums: [{ albumCatalogId: inserted[index]._id, rank: 0 }] })));
  console.log(`Seeded ${inserted.length} albums.`);
  await mongoose.disconnect();
}

main().catch(async (error) => { console.error(error); await mongoose.disconnect(); process.exitCode = 1; });
