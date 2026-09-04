const express = require("express");
const { getAuth } = require("@clerk/express");
const Board = require("../models/Board");
const BoardItem = require("../models/BoardItem");
const { findAlbumByPublicId, normalizeCatalogAlbum } = require("./utils/albumCatalog");
const { albumSaveRateLimit } = require("./utils/rateLimit");

const router = express.Router();
const DEFAULT_TITLE = "Saved albums";
const PREVIEW_LIMIT = 4;

function auth(req, res, next) {
  const { userId } = getAuth(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  req.userId = userId;
  next();
}
function plain(value) { return typeof value?.toObject === "function" ? value.toObject() : value; }
function title(value) { return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : ""; }

async function getDefaultBoard(userId) {
  const existing = await Board.findOne({ userId, isDefault: true });
  if (existing) return existing;
  try { return await Board.create({ userId, title: DEFAULT_TITLE, isDefault: true }); }
  catch (error) { if (error.code === 11000) return Board.findOne({ userId, isDefault: true }); throw error; }
}
async function ownedBoard(userId, boardId) { return boardId === "default" ? getDefaultBoard(userId) : Board.findOne({ _id: boardId, userId }); }
function formatItem(item) {
  const source = plain(item);
  const album = source.albumCatalogId;
  return album && typeof album === "object"
    ? { ...normalizeCatalogAlbum(album), boardId: source.boardId, userId: source.userId, savedAt: source.savedAt }
    : source;
}
async function summary(board) {
  const source = plain(board);
  const [items, itemCount] = await Promise.all([
    BoardItem.find({ boardId: source._id }).populate("albumCatalogId").sort({ savedAt: -1 }).limit(PREVIEW_LIMIT),
    BoardItem.countDocuments({ boardId: source._id }),
  ]);
  return { _id: source._id, userId: source.userId, title: source.title, isDefault: Boolean(source.isDefault), createdAt: source.createdAt, updatedAt: source.updatedAt, itemCount, previewAlbums: items.map(formatItem) };
}

router.get("/", auth, async (req, res) => {
  try {
    await getDefaultBoard(req.userId);
    const boards = await Board.find({ userId: req.userId }).sort({ isDefault: -1, updatedAt: -1 });
    res.json(await Promise.all(boards.map(summary)));
  } catch (error) { res.status(500).json({ error: "Failed to fetch boards" }); }
});

router.post("/", auth, async (req, res) => {
  try {
    const boardTitle = title(req.body.title);
    if (!boardTitle) return res.status(400).json({ error: "Board title is required" });
    res.status(201).json(await summary(await Board.create({ userId: req.userId, title: boardTitle })));
  } catch (error) { res.status(500).json({ error: "Failed to create board" }); }
});

router.get("/album/:albumId", auth, async (req, res) => {
  try {
    const album = await findAlbumByPublicId(req.params.albumId);
    const items = await BoardItem.find({ userId: req.userId, albumCatalogId: album._id }).populate("boardId");
    const boards = items.map((item) => plain(item).boardId).filter(Boolean).map((board) => ({ _id: board._id, title: board.title, isDefault: Boolean(board.isDefault) }));
    res.json({ albumId: album.albumId, saved: boards.length > 0, boards });
  } catch (error) { res.status(error.status || 500).json({ error: error.status ? error.message : "Failed to check board saves" }); }
});

router.get("/:boardId", auth, async (req, res) => {
  try {
    const board = await ownedBoard(req.userId, req.params.boardId);
    if (!board) return res.status(404).json({ error: "Board not found" });
    const items = await BoardItem.find({ boardId: board._id }).populate("albumCatalogId").sort({ savedAt: -1 });
    res.json({ ...(await summary(board)), albums: items.map(formatItem) });
  } catch (error) { res.status(500).json({ error: "Failed to fetch board" }); }
});

router.patch("/:boardId", auth, async (req, res) => {
  try {
    const board = await ownedBoard(req.userId, req.params.boardId);
    const boardTitle = title(req.body.title);
    if (!boardTitle) return res.status(400).json({ error: "Board title is required" });
    if (!board) return res.status(404).json({ error: "Board not found" });
    board.title = boardTitle;
    await board.save();
    res.json(await summary(board));
  } catch (error) { res.status(500).json({ error: "Failed to rename board" }); }
});

router.delete("/:boardId", auth, async (req, res) => {
  try {
    const board = await ownedBoard(req.userId, req.params.boardId);
    if (!board) return res.status(404).json({ error: "Board not found" });
    if (board.isDefault) return res.status(400).json({ error: "The default board cannot be deleted" });
    await BoardItem.deleteMany({ boardId: board._id });
    await Board.deleteOne({ _id: board._id, userId: req.userId });
    res.json({ message: "Board deleted" });
  } catch (error) { res.status(500).json({ error: "Failed to delete board" }); }
});

router.post("/:boardId/albums", auth, albumSaveRateLimit, async (req, res) => {
  try {
    const board = await ownedBoard(req.userId, req.params.boardId);
    if (!board) return res.status(404).json({ error: "Board not found" });
    const album = await findAlbumByPublicId(req.body.albumId);
    const item = await BoardItem.findOneAndUpdate(
      { boardId: board._id, albumCatalogId: album._id },
      { $setOnInsert: { userId: req.userId, boardId: board._id, albumCatalogId: album._id, savedAt: new Date() } },
      { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
    ).populate("albumCatalogId");
    res.status(201).json({ board: await summary(board), album: formatItem(item) });
  } catch (error) { res.status(error.status || 500).json({ error: error.status ? error.message : "Failed to save album to board" }); }
});

router.delete("/:boardId/albums/:albumId", auth, async (req, res) => {
  try {
    const board = await ownedBoard(req.userId, req.params.boardId);
    if (!board) return res.status(404).json({ error: "Board not found" });
    const album = await findAlbumByPublicId(req.params.albumId);
    await BoardItem.deleteOne({ boardId: board._id, albumCatalogId: album._id });
    res.json({ message: "Album removed from board" });
  } catch (error) { res.status(error.status || 500).json({ error: error.status ? error.message : "Failed to remove album from board" }); }
});

module.exports = router;
