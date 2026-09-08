const test = require("node:test");
const assert = require("node:assert/strict");
const {
  isAlbumId,
  normalizeAlbumInput,
  normalizeCatalogAlbum,
  requireAlbumId,
} = require("../routes/utils/albumCatalog");
const AlbumCatalog = require("../models/AlbumCatalog");
const BoardItem = require("../models/BoardItem");
const Review = require("../models/Reviews");
const Like = require("../models/Like");
const UserProfile = require("../models/UserProfile");

test("catalog records receive immutable UUID v4 public identities", () => {
  const album = normalizeAlbumInput({ title: "Kind of Blue", artistDisplayName: "Miles Davis", releaseDate: "1959-08-17" });
  assert.equal(isAlbumId(album.albumId), true);
  assert.equal(album.releaseYear, 1959);
  assert.equal(album.artistCredits[0].name, "Miles Davis");
  assert.throws(() => requireAlbumId("spotify-album"), /UUID v4/);
});

test("catalog serializer exposes provider-neutral fields and no Mongo identity", () => {
  const serialized = normalizeCatalogAlbum({
    _id: "internal",
    albumId: "123e4567-e89b-42d3-a456-426614174000",
    title: "Blue Train",
    artistDisplayName: "John Coltrane",
    releaseType: "album",
    releaseDate: "1957",
    releaseYear: 1957,
    tracks: [{ trackId: "track-1", title: "Blue Train" }],
  });
  assert.equal(serialized.albumId, "123e4567-e89b-42d3-a456-426614174000");
  assert.equal("_id" in serialized, false);
  assert.equal("spotifyId" in serialized, false);
  assert.equal(serialized.tracks[0].title, "Blue Train");
});

test("social models reference the catalog internally and do not persist provider IDs", () => {
  for (const schema of [AlbumCatalog.schema, BoardItem.schema, Review.schema, Like.schema, UserProfile.schema]) {
    assert.equal(schema.path("spotifyId"), undefined);
  }
  assert.ok(BoardItem.schema.path("albumCatalogId"));
  assert.ok(Review.schema.path("albumCatalogId"));
  assert.ok(Like.schema.path("albumCatalogId"));
});
