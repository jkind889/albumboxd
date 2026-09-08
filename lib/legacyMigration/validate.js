const mongoose = require("mongoose");
const AlbumCatalog = require("../../models/AlbumCatalog");
const Review = require("../../models/Reviews");
const Like = require("../../models/Like");
const Board = require("../../models/Board");
const BoardItem = require("../../models/BoardItem");
const Notification = require("../../models/Notification");
const UserProfile = require("../../models/UserProfile");
const Follow = require("../../models/Follow");
const { LegacyMigrationError, canonicalHash } = require("./runtime");

const MODELS = { albumcatalogs: AlbumCatalog, reviews: Review, likes: Like, boards: Board, boarditems: BoardItem, notifications: Notification, userprofiles: UserProfile, follows: Follow };
const FORBIDDEN_KEYS = new Set(["spotifyId", "spotifyUrl", "spotifyProfileUrl"]);
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function idString(value) { return value && value.toHexString ? value.toHexString() : String(value || ""); }

function forbiddenFields(value, path = "", collection = "", results = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => forbiddenFields(item, `${path}[${index}]`, collection, results));
    return results;
  }
  if (!value || typeof value !== "object" || value instanceof Date) return results;
  for (const [key, child] of Object.entries(value)) {
    const current = path ? `${path}.${key}` : key;
    if (FORBIDDEN_KEYS.has(key) && !(collection === "userprofiles" && key === "spotifyProfileUrl" && path === "")) results.push(current);
    if (key.toLowerCase().includes("spotify") && !(collection === "userprofiles" && key === "spotifyProfileUrl" && path === "")) results.push(current);
    forbiddenFields(child, current, collection, results);
  }
  return results;
}

async function validateModelDocument(collection, document) {
  const Model = MODELS[collection];
  if (!Model) return;
  const instance = new Model(document);
  await instance.validate();
}

function addIssue(issues, collection, code, message, details = {}) {
  issues.push({ collection, code, message, ...details });
}

function validatePublicIds(issues, collection, rows, field) {
  const values = new Set();
  for (const row of rows || []) {
    const value = row?.[field];
    if (typeof value !== "string" || !UUID_V4.test(value)) {
      addIssue(issues, collection, `INVALID_${field.replace(/([A-Z])/g, "_$1").toUpperCase()}`, `${field} must be a canonical UUID-v4`, { id: idString(row?._id) });
      continue;
    }
    if (values.has(value)) addIssue(issues, collection, `DUPLICATE_${field.replace(/([A-Z])/g, "_$1").toUpperCase()}`, `Duplicate ${field} ${value}`);
    values.add(value);
  }
}

async function validateDocuments(documents) {
  const issues = [];
  for (const [collection, rows] of Object.entries(documents)) {
    for (const document of rows || []) {
      const forbidden = forbiddenFields(document, "", collection);
      if (forbidden.length) addIssue(issues, collection, "FORBIDDEN_LEGACY_FIELD", "Active target document contains a forbidden provider field", { fields: forbidden, id: idString(document._id) });
      try { await validateModelDocument(collection, document); } catch (error) { addIssue(issues, collection, "MODEL_VALIDATION_FAILED", error.message, { id: idString(document._id) }); }
    }
  }
  const albums = documents.albumcatalogs || [];
  const albumIds = new Set();
  const refs = new Set();
  const tracks = new Set();
  for (const album of albums) {
    if (albumIds.has(album.albumId)) addIssue(issues, "albumcatalogs", "DUPLICATE_ALBUM_ID", `Duplicate albumId ${album.albumId}`);
    albumIds.add(album.albumId);
    for (const reference of album.externalReferences || []) {
      const key = `${String(reference.provider).toLowerCase()}|${String(reference.entityType).toLowerCase()}|${String(reference.externalId).toLowerCase()}`;
      if (refs.has(key)) addIssue(issues, "albumcatalogs", "DUPLICATE_EXTERNAL_REFERENCE", `Duplicate external reference ${key}`);
      refs.add(key);
    }
    const positions = new Set();
    for (const track of album.tracks || []) {
      if (tracks.has(track.trackId)) addIssue(issues, "albumcatalogs", "DUPLICATE_TRACK_ID", `Duplicate trackId ${track.trackId}`);
      tracks.add(track.trackId);
      const position = `${track.discNumber}:${track.trackNumber}`;
      if (positions.has(position)) addIssue(issues, "albumcatalogs", "DUPLICATE_TRACK_POSITION", `Duplicate track position ${position}`, { id: idString(album._id) });
      positions.add(position);
    }
  }
  const boardIds = new Set((documents.boards || []).map((row) => idString(row._id)));
  const boardsById = new Map((documents.boards || []).map((row) => [idString(row._id), row]));
  // Validate the raw sealed-plan values before model construction can supply
  // schema defaults. These documents are written by raw replaceOne calls.
  validatePublicIds(issues, "reviews", documents.reviews, "reviewId");
  validatePublicIds(issues, "boards", documents.boards, "boardId");
  validatePublicIds(issues, "notifications", documents.notifications, "notificationId");
  const defaultUsers = new Set();
  for (const board of documents.boards || []) {
    if (board.isDefault) {
      if (defaultUsers.has(board.userId)) addIssue(issues, "boards", "DUPLICATE_DEFAULT_BOARD", `Multiple default boards for ${board.userId}`);
      defaultUsers.add(board.userId);
    }
  }
  const reviewIds = new Set((documents.reviews || []).map((row) => idString(row._id)));
  const boardItems = new Set();
  for (const item of documents.boarditems || []) {
    if (!boardIds.has(idString(item.boardId))) addIssue(issues, "boarditems", "DANGLING_BOARD", "BoardItem references a missing board", { id: idString(item._id) });
    const owner = boardsById.get(idString(item.boardId));
    if (owner && String(owner.userId) !== String(item.userId)) addIssue(issues, "boarditems", "BOARD_OWNER_MISMATCH", "BoardItem userId does not match its board owner", { id: idString(item._id) });
    if (!albumIds.has(String((documents.albumcatalogs || []).find((album) => idString(album._id) === idString(item.albumCatalogId))?.albumId || "")) && !(documents.albumcatalogs || []).some((album) => idString(album._id) === idString(item.albumCatalogId))) addIssue(issues, "boarditems", "DANGLING_ALBUM", "BoardItem references a missing album", { id: idString(item._id) });
    const key = `${idString(item.boardId)}|${idString(item.albumCatalogId)}`;
    if (boardItems.has(key)) addIssue(issues, "boarditems", "DUPLICATE_BOARD_ITEM", `Duplicate board item ${key}`);
    boardItems.add(key);
  }
  for (const review of documents.reviews || []) if (!(documents.albumcatalogs || []).some((album) => idString(album._id) === idString(review.albumCatalogId))) addIssue(issues, "reviews", "DANGLING_ALBUM", "Review references a missing album", { id: idString(review._id) });
  const likeKeys = new Set();
  for (const like of documents.likes || []) {
    const validTarget = like.targetType === "album" ? like.albumCatalogId && (documents.albumcatalogs || []).some((album) => idString(album._id) === idString(like.albumCatalogId)) : like.reviewId && reviewIds.has(idString(like.reviewId));
    if (!validTarget) addIssue(issues, "likes", "INVALID_LIKE_TARGET", "Like has no valid target", { id: idString(like._id) });
    const key = like.targetType === "album" ? `${like.userId}|album|${idString(like.albumCatalogId)}` : `${like.userId}|review|${idString(like.reviewId)}`;
    if (likeKeys.has(key)) addIssue(issues, "likes", "DUPLICATE_LIKE", `Duplicate like ${key}`);
    likeKeys.add(key);
  }
  for (const notification of documents.notifications || []) if (notification.type === "review_like" && !reviewIds.has(idString(notification.reviewId))) addIssue(issues, "notifications", "DANGLING_REVIEW", "Notification references a missing review", { id: idString(notification._id) });
  for (const profile of documents.userprofiles || []) {
    const ranks = new Set();
    for (const favorite of profile.favoriteAlbums || []) {
      if (ranks.has(favorite.rank)) addIssue(issues, "userprofiles", "DUPLICATE_FAVORITE_RANK", `Duplicate favorite rank ${favorite.rank}`, { id: idString(profile._id) });
      ranks.add(favorite.rank);
      if (!(documents.albumcatalogs || []).some((album) => idString(album._id) === idString(favorite.albumCatalogId))) addIssue(issues, "userprofiles", "DANGLING_FAVORITE", "Profile favorite references a missing album", { id: idString(profile._id) });
    }
    if (profile.pinnedReviewId && !reviewIds.has(idString(profile.pinnedReviewId))) addIssue(issues, "userprofiles", "DANGLING_PINNED_REVIEW", "Profile references a missing pinned review", { id: idString(profile._id) });
    if (profile.pinnedBoardId && !boardIds.has(idString(profile.pinnedBoardId))) addIssue(issues, "userprofiles", "DANGLING_PINNED_BOARD", "Profile references a missing pinned board", { id: idString(profile._id) });
  }
  return issues;
}

async function validateModelDocuments(documents) {
  const issues = await validateDocuments(documents);
  if (issues.length) throw new LegacyMigrationError("Target document validation failed", "PLAN_VALIDATION_FAILED", issues);
  return { valid: true, fingerprint: canonicalHash(documents) };
}

module.exports = { FORBIDDEN_KEYS, MODELS, forbiddenFields, validateDocuments, validateModelDocuments };
