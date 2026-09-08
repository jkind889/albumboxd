const crypto = require("node:crypto");
const { ObjectId } = require("mongodb");

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function idString(value) { return value && value.toHexString ? value.toHexString() : String(value || ""); }
function dateValue(value, fallback = new Date()) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (value && value.$date) return new Date(value.$date);
  const parsed = value ? new Date(value) : null;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed : fallback;
}
function objectId(value, fallback = null) {
  if (value instanceof ObjectId) return value;
  if (value && value._bsontype === "ObjectId") return new ObjectId(value.toHexString());
  return ObjectId.isValid(value) ? new ObjectId(value) : fallback;
}
function text(value) { return String(value || "").trim(); }
function canonicalUuidV4(value) { return typeof value === "string" && UUID_V4.test(value) ? value : null; }
function publicUuid(value) { return canonicalUuidV4(value) || crypto.randomUUID(); }

function userMapping(overrides = {}) {
  return new Map((overrides.users || []).map((entry) => [text(entry.legacyUserId), text(entry.targetUserId)]).filter(([from, to]) => from && to));
}

function remapSourceUsers(source, overrides) {
  const mapping = userMapping(overrides);
  if (!mapping.size) return source;
  const mapped = { ...source };
  const scalar = ["albums", "boarditems", "boards", "reviews", "likes", "userprofiles"];
  for (const collection of scalar) mapped[collection] = (source[collection] || []).map((row) => ({ ...row, ...(row.userId ? { userId: mapping.get(text(row.userId)) || text(row.userId) } : {}) }));
  mapped.follows = (source.follows || []).map((row) => ({ ...row, followerId: mapping.get(text(row.followerId)) || text(row.followerId), followingId: mapping.get(text(row.followingId)) || text(row.followingId) }));
  mapped.notifications = (source.notifications || []).map((row) => ({ ...row, recipientUserId: mapping.get(text(row.recipientUserId)) || text(row.recipientUserId), actorUserId: mapping.get(text(row.actorUserId)) || text(row.actorUserId) }));
  return mapped;
}

function buildCrosswalkMaps(results = []) {
  const byCatalog = new Map();
  const byProvider = new Map();
  for (const result of results) {
    if (!result.document || !["created", "reused"].includes(result.action)) continue;
    for (const id of result.identity.catalogIds || []) byCatalog.set(String(id), result.document);
    for (const key of result.identity.providerKeys || []) byProvider.set(String(key), result.document);
  }
  return { byCatalog, byProvider };
}

function resolveAlbum(row, maps) {
  const catalogId = row?.albumCatalogId ? maps.byCatalog.get(idString(row.albumCatalogId)) : null;
  if (catalogId) return catalogId;
  const provider = text(row?.spotifyId);
  return provider ? maps.byProvider.get(provider) || null : null;
}

function currentById(rows = []) {
  return new Map(rows.map((row) => [idString(row._id), row]));
}

function currentDefaultBoards(rows = []) {
  const map = new Map();
  for (const board of rows) if (board.isDefault && !map.has(board.userId)) map.set(board.userId, board);
  return map;
}

function cleanBoard(row, id, forceDefault = row.isDefault, boardId = row.boardId) {
  return {
    _id: id,
    boardId: publicUuid(boardId),
    userId: text(row.userId),
    title: text(row.title) || "Saved Albums",
    isDefault: Boolean(forceDefault),
    createdAt: dateValue(row.createdAt),
    updatedAt: dateValue(row.updatedAt, dateValue(row.createdAt)),
  };
}

function buildBoards(source, target) {
  // Target rows are included in a sealed plan as well. Normalize their public
  // IDs here so a plan can backfill an older candidate without applying a
  // model default at write time.
  const targetBoards = (target.boards || []).map((row) => ({ ...row, boardId: publicUuid(row.boardId) }));
  const existingById = currentById(targetBoards);
  const defaults = currentDefaultBoards(targetBoards);
  const boardMap = new Map();
  const documents = new Map(targetBoards.map((board) => [idString(board._id), board]));
  const sourceBoards = [...(source.boards || [])].sort((left, right) => dateValue(left.createdAt).getTime() - dateValue(right.createdAt).getTime());
  for (const row of sourceBoards) {
    const sourceId = idString(row._id);
    let targetBoard = row.isDefault && defaults.get(text(row.userId));
    if (!targetBoard) targetBoard = existingById.get(sourceId);
    if (!targetBoard) targetBoard = cleanBoard(row, objectId(row._id, new ObjectId()));
    if (row.isDefault && !defaults.has(text(row.userId))) defaults.set(text(row.userId), targetBoard);
    boardMap.set(sourceId, targetBoard._id);
    if (!documents.has(idString(targetBoard._id))) {
      documents.set(idString(targetBoard._id), cleanBoard(row, targetBoard._id, targetBoard.isDefault, targetBoard.boardId));
    }
  }
  return { boardMap, defaults, documents: [...documents.values()] };
}

function ensureDefaultBoard(userId, boardState) {
  const normalized = text(userId);
  if (!normalized) return null;
  const current = boardState.defaults.get(normalized);
  if (current) return current;
  const generated = cleanBoard({ userId: normalized, title: "Saved Albums", isDefault: true }, new ObjectId(), true);
  boardState.defaults.set(normalized, generated);
  boardState.documents.push(generated);
  return generated;
}

function transformReviews(source, maps, target) {
  // Seal IDs into the plan rather than relying on Mongoose defaults, because
  // application writes the raw operation document with replaceOne.
  const targetReviews = (target.reviews || []).map((row) => ({ ...row, reviewId: publicUuid(row.reviewId) }));
  const documents = new Map(targetReviews.map((row) => [idString(row._id), row]));
  const reviewMap = new Map();
  const issues = [];
  for (const row of source.reviews || []) {
    const album = resolveAlbum(row, maps);
    if (!album || !text(row.userId) || !text(row.reviewText)) {
      issues.push({ collection: "reviews", sourceId: idString(row._id), action: "quarantine", code: "UNRESOLVED_REVIEW_ALBUM" });
      continue;
    }
    const id = objectId(row._id, new ObjectId());
    const document = {
      _id: id,
      reviewId: publicUuid(row.reviewId),
      userId: text(row.userId),
      albumCatalogId: album._id,
      reviewText: text(row.reviewText),
      rating: Number(row.rating),
      date: dateValue(row.date),
    };
    if (!Number.isFinite(document.rating) || document.rating < 1 || document.rating > 5 || !Number.isInteger(document.rating * 2)) {
      issues.push({ collection: "reviews", sourceId: idString(row._id), action: "quarantine", code: "INVALID_REVIEW" });
      continue;
    }
    const existing = documents.get(idString(id));
    if (existing && (text(existing.reviewText) !== document.reviewText || Number(existing.rating) !== document.rating)) {
      issues.push({ collection: "reviews", sourceId: idString(row._id), action: "quarantine", code: "TARGET_REVIEW_CONFLICT" });
      continue;
    }
    documents.set(idString(id), existing || document);
    reviewMap.set(idString(row._id), id);
  }
  return { documents: [...documents.values()], reviewMap, issues };
}

function transformBoardItems(source, maps, boardState, target) {
  const documents = new Map();
  const issues = [];
  const add = (row, boardId, collection) => {
    const album = resolveAlbum(row, maps);
    const userId = text(row.userId);
    if (!album || !boardId || !userId) {
      issues.push({ collection, sourceId: idString(row._id), action: "quarantine", code: "UNRESOLVED_BOARD_ITEM" });
      return;
    }
    const savedAt = dateValue(row.savedAt, dateValue(row._id?.getTimestamp?.(), new Date()));
    const key = `${idString(boardId)}|${idString(album._id)}`;
    const document = {
      _id: objectId(row._id, new ObjectId()),
      userId,
      boardId,
      albumCatalogId: album._id,
      savedAt,
    };
    const existing = documents.get(key);
    if (!existing || savedAt < existing.savedAt) documents.set(key, document);
  };
  for (const row of target.boarditems || []) {
    documents.set(`${idString(row.boardId)}|${idString(row.albumCatalogId)}`, row);
  }
  for (const row of source.boarditems || []) {
    const boardId = boardState.boardMap.get(idString(row.boardId)) || row.boardId;
    add(row, objectId(boardId), "boarditems");
  }
  for (const row of source.albums || []) {
    const board = ensureDefaultBoard(text(row.userId), boardState);
    add(row, board?._id, "albums");
  }
  return { documents: [...documents.values()], issues };
}

function transformFollows(source, target) {
  const documents = new Map(target.follows.map((row) => [`${row.followerId}|${row.followingId}`, row]));
  const issues = [];
  for (const row of source.follows || []) {
    const followerId = text(row.followerId);
    const followingId = text(row.followingId);
    if (!followerId || !followingId || followerId === followingId) {
      issues.push({ collection: "follows", sourceId: idString(row._id), action: "quarantine", code: "INVALID_FOLLOW" });
      continue;
    }
    const key = `${followerId}|${followingId}`;
    if (!documents.has(key)) documents.set(key, { _id: objectId(row._id, new ObjectId()), followerId, followingId, createdAt: dateValue(row.createdAt), updatedAt: dateValue(row.updatedAt, dateValue(row.createdAt)) });
  }
  return { documents: [...documents.values()], issues };
}

function transformLikes(source, maps, reviewMap, target) {
  const documents = new Map();
  for (const row of target.likes || []) {
    const key = row.targetType === "review" ? `${row.userId}|review|${idString(row.reviewId)}` : `${row.userId}|album|${idString(row.albumCatalogId)}`;
    documents.set(key, row);
  }
  const issues = [];
  for (const row of source.likes || []) {
    const userId = text(row.userId);
    let document;
    if (row.targetType === "review") {
      const reviewId = reviewMap.get(idString(row.reviewId));
      if (!reviewId) {
        issues.push({ collection: "likes", sourceId: idString(row._id), action: "archive", code: "ORPHAN_REVIEW_LIKE" });
        continue;
      }
      document = { _id: objectId(row._id, new ObjectId()), userId, targetType: "review", reviewId, createdAt: dateValue(row.createdAt), updatedAt: dateValue(row.updatedAt, dateValue(row.createdAt)) };
    } else {
      const album = resolveAlbum(row, maps);
      if (!album || !userId) { issues.push({ collection: "likes", sourceId: idString(row._id), action: "quarantine", code: "UNRESOLVED_ALBUM_LIKE" }); continue; }
      document = { _id: objectId(row._id, new ObjectId()), userId, targetType: "album", albumCatalogId: album._id, createdAt: dateValue(row.createdAt), updatedAt: dateValue(row.updatedAt, dateValue(row.createdAt)) };
    }
    const key = document.targetType === "review" ? `${userId}|review|${idString(document.reviewId)}` : `${userId}|album|${idString(document.albumCatalogId)}`;
    if (!documents.has(key)) documents.set(key, document);
  }
  return { documents: [...documents.values()], issues };
}

function transformNotifications(source, reviewMap, target) {
  const targetNotifications = (target.notifications || []).map((row) => ({ ...row, notificationId: publicUuid(row.notificationId) }));
  const documents = new Map();
  for (const row of targetNotifications) {
    const key = row.type === "review_like" ? `${row.recipientUserId}|${row.actorUserId}|${row.type}|${idString(row.reviewId)}` : `${row.recipientUserId}|${row.actorUserId}|${row.type}`;
    documents.set(key, row);
  }
  const issues = [];
  for (const row of source.notifications || []) {
    const base = { _id: objectId(row._id, new ObjectId()), notificationId: publicUuid(row.notificationId), recipientUserId: text(row.recipientUserId), actorUserId: text(row.actorUserId), type: row.type, readAt: row.readAt ? dateValue(row.readAt) : null, createdAt: dateValue(row.createdAt), updatedAt: dateValue(row.updatedAt, dateValue(row.createdAt)) };
    if (!base.recipientUserId || !base.actorUserId || !["review_like", "follow"].includes(base.type)) { issues.push({ collection: "notifications", sourceId: idString(row._id), action: "quarantine", code: "INVALID_NOTIFICATION" }); continue; }
    if (base.type === "review_like") {
      base.reviewId = reviewMap.get(idString(row.reviewId));
      if (!base.reviewId) { issues.push({ collection: "notifications", sourceId: idString(row._id), action: "archive", code: "ORPHAN_REVIEW_NOTIFICATION" }); continue; }
    }
    const key = base.type === "review_like" ? `${base.recipientUserId}|${base.actorUserId}|${base.type}|${idString(base.reviewId)}` : `${base.recipientUserId}|${base.actorUserId}|${base.type}`;
    if (!documents.has(key)) documents.set(key, base);
  }
  return { documents: [...documents.values()], issues };
}

function transformProfiles(source, maps, reviewMap, boardState, target) {
  const targetByUser = new Map(target.userprofiles.map((row) => [text(row.userId), row]));
  const documents = new Map(targetByUser);
  const issues = [];
  for (const row of source.userprofiles || []) {
    const userId = text(row.userId);
    if (!userId) { issues.push({ collection: "userprofiles", sourceId: idString(row._id), action: "quarantine", code: "INVALID_PROFILE" }); continue; }
    const existing = targetByUser.get(userId);
    const favorites = (row.favoriteAlbums || []).map((item) => {
      const album = resolveAlbum(item, maps);
      return album ? { albumCatalogId: album._id, rank: Number(item.rank) } : null;
    }).filter((item) => item && Number.isInteger(item.rank) && item.rank >= 0 && item.rank <= 4);
    const listening = row.listeningNextAlbum ? resolveAlbum(row.listeningNextAlbum, maps) : null;
    const candidate = {
      _id: objectId(row._id, new ObjectId()), userId, bio: text(row.bio), spotifyProfileUrl: text(row.spotifyProfileUrl), isPrivate: Boolean(row.isPrivate), favoriteAlbums: favorites.slice(0, 5), listeningNextAlbum: listening ? { albumCatalogId: listening._id } : null, pinnedReviewId: reviewMap.get(idString(row.pinnedReviewId)) || null, pinnedBoardId: boardState.boardMap.get(idString(row.pinnedBoardId)) || objectId(row.pinnedBoardId), createdAt: dateValue(row.createdAt), updatedAt: dateValue(row.updatedAt, dateValue(row.createdAt)),
    };
    if (existing) {
      const merged = { ...candidate, ...existing, _id: existing._id, userId };
      if ((!existing.favoriteAlbums || existing.favoriteAlbums.length === 0) && candidate.favoriteAlbums.length) merged.favoriteAlbums = candidate.favoriteAlbums;
      if (!existing.listeningNextAlbum && candidate.listeningNextAlbum) merged.listeningNextAlbum = candidate.listeningNextAlbum;
      if (!existing.pinnedReviewId) merged.pinnedReviewId = candidate.pinnedReviewId;
      if (!existing.pinnedBoardId) merged.pinnedBoardId = candidate.pinnedBoardId;
      documents.set(userId, merged);
    } else documents.set(userId, candidate);
  }
  return { documents: [...documents.values()], issues };
}

function transformSocial({ source, target, catalogResults, overrides = {} }) {
  source = remapSourceUsers(source, overrides);
  const maps = buildCrosswalkMaps(catalogResults);
  const boardState = buildBoards(source, target);
  const reviews = transformReviews(source, maps, target);
  const follows = transformFollows(source, target);
  const boarditems = transformBoardItems(source, maps, boardState, target);
  const likes = transformLikes(source, maps, reviews.reviewMap, target);
  const notifications = transformNotifications(source, reviews.reviewMap, target);
  const userprofiles = transformProfiles(source, maps, reviews.reviewMap, boardState, target);
  return {
    documents: {
      boards: boardState.documents,
      follows: follows.documents,
      reviews: reviews.documents,
      boarditems: boarditems.documents,
      likes: likes.documents,
      notifications: notifications.documents,
      userprofiles: userprofiles.documents,
    },
    issues: [...reviews.issues, ...follows.issues, ...boarditems.issues, ...likes.issues, ...notifications.issues, ...userprofiles.issues],
    reviewMap: reviews.reviewMap,
    boardMap: boardState.boardMap,
  };
}

module.exports = {
  buildCrosswalkMaps,
  resolveAlbum,
  transformSocial,
  transformReviews,
  transformBoardItems,
  transformLikes,
  transformNotifications,
  transformProfiles,
};
