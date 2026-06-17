const express = require("express");
const { getAuth } = require("@clerk/express");
const Album = require("../models/Albums");
const Board = require("../models/Board");
const BoardItem = require("../models/BoardItem");
const {
  getOrCreateAlbumCatalog,
  normalizeCatalogAlbum,
} = require("./utils/albumCatalog");

const router = express.Router();
const DEFAULT_BOARD_TITLE = "Saved albums";
const BOARD_PREVIEW_LIMIT = 4;

function ensureAuthenticated(req, res, next) {
  const { userId } = getAuth(req);

  if (!userId) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  req.userId = userId;
  next();
}

function getPlain(document) {
  return typeof document?.toObject === "function" ? document.toObject() : document;
}

function normalizeTitle(value) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

async function getDefaultBoard(userId) {
  const existingBoard = await Board.findOne({ userId, isDefault: true });

  if (existingBoard) {
    return existingBoard;
  }

  try {
    return await Board.create({
      userId,
      title: DEFAULT_BOARD_TITLE,
      isDefault: true,
    });
  } catch (error) {
    // **the error is for if two boards get created at the same time (duplicate key error) itll return the first board that was created and disregard the other**
    if (error.code === 11000) {
      return Board.findOne({ userId, isDefault: true });
    }

    throw error;
  }
}

async function syncDefaultBoardFromSavedAlbums(userId) {
  const defaultBoard = await getDefaultBoard(userId);
  const savedAlbums = await Album.find({ userId });

  if (savedAlbums.length === 0) {
    return defaultBoard;
  }

  await BoardItem.bulkWrite(
    savedAlbums.map((savedAlbum) => ({
      updateOne: {
        filter: {
          boardId: defaultBoard._id,
          spotifyId: savedAlbum.spotifyId,
        },
        update: {
          $setOnInsert: {
            userId,
            boardId: defaultBoard._id,
            spotifyId: savedAlbum.spotifyId,
            albumCatalogId: savedAlbum.albumCatalogId,
            savedAt: savedAlbum.savedAt,
          },
        },
        upsert: true,
      },
    })),
    { ordered: false },
  );

  return defaultBoard;
}

async function getOwnedBoard(userId, boardId) {
  if (boardId === "default") {
    return getDefaultBoard(userId);
  }

  return Board.findOne({ _id: boardId, userId });
}

function formatBoardItem(item) {
  const source = getPlain(item);
  const catalogAlbum = source.albumCatalogId;

  if (!catalogAlbum || typeof catalogAlbum !== "object" || !catalogAlbum.spotifyId) {
    return source;
  }

  return {
    ...normalizeCatalogAlbum(catalogAlbum),
    _id: source._id,
    boardId: source.boardId,
    albumCatalogId: catalogAlbum._id,
    userId: source.userId,
    savedAt: source.savedAt,
  };
}

async function formatBoardSummary(board) {
  const source = getPlain(board);
  const [items, count] = await Promise.all([
    BoardItem.find({ boardId: source._id })
      .populate("albumCatalogId")
      .sort({ savedAt: -1 })
      .limit(BOARD_PREVIEW_LIMIT),
    BoardItem.countDocuments({ boardId: source._id }),
  ]);

  return {
    _id: source._id,
    userId: source.userId,
    title: source.title,
    isDefault: Boolean(source.isDefault),
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
    itemCount: count,
    previewAlbums: items.map(formatBoardItem),
  };
}

async function saveAlbumToLegacyCollection({ userId, catalogAlbum, spotifyId, savedAt }) {
  await Album.findOneAndUpdate(
    { spotifyId, userId },
    {
      $setOnInsert: {
        albumCatalogId: catalogAlbum._id,
        spotifyId,
        userId,
        savedAt,
      },
    },
    { upsert: true, setDefaultsOnInsert: true },
  );
}

router.get("/", ensureAuthenticated, async (req, res) => {
  try {
    await syncDefaultBoardFromSavedAlbums(req.userId);
    const boards = await Board.find({ userId: req.userId }).sort({ isDefault: -1, updatedAt: -1 });
    res.json(await Promise.all(boards.map(formatBoardSummary)));
  } catch (error) {
    console.log(error);
    res.status(500).json({ error: "Failed to fetch boards" });
  }
});

router.post("/", ensureAuthenticated, async (req, res) => {
  try {
    const title = normalizeTitle(req.body.title);

    if (!title) {
      return res.status(400).json({ error: "Board title is required" });
    }

    const board = await Board.create({
      userId: req.userId,
      title,
    });

    res.status(201).json(await formatBoardSummary(board));
  } catch (error) {
    console.log(error);
    res.status(500).json({ error: "Failed to create board" });
  }
});

router.get("/album/:spotifyId", ensureAuthenticated, async (req, res) => {
  try {
    await syncDefaultBoardFromSavedAlbums(req.userId);
    const boardItems = await BoardItem.find({
      userId: req.userId,
      spotifyId: req.params.spotifyId,
    }).populate("boardId");

    const boards = boardItems
      .map((item) => getPlain(item).boardId)
      .filter((board) => board && typeof board === "object")
      .map((board) => ({
        _id: board._id,
        title: board.title,
        isDefault: Boolean(board.isDefault),
      }));

    res.json({
      saved: boards.length > 0,
      boards,
    });
  } catch (error) {
    console.log(error);
    res.status(500).json({ error: "Failed to check board saves" });
  }
});

router.get("/:boardId", ensureAuthenticated, async (req, res) => {
  try {
    await syncDefaultBoardFromSavedAlbums(req.userId);
    const board = await getOwnedBoard(req.userId, req.params.boardId);

    if (!board) {
      return res.status(404).json({ error: "Board not found" });
    }

    const items = await BoardItem.find({ boardId: board._id })
      .populate("albumCatalogId")
      .sort({ savedAt: -1 });

    res.json({
      ...(await formatBoardSummary(board)),
      albums: items.map(formatBoardItem),
    });
  } catch (error) {
    console.log(error);
    res.status(500).json({ error: "Failed to fetch board" });
  }
});

router.patch("/:boardId", ensureAuthenticated, async (req, res) => {
  try {
    const title = normalizeTitle(req.body.title);

    if (!title) {
      return res.status(400).json({ error: "Board title is required" });
    }

    const board = await getOwnedBoard(req.userId, req.params.boardId);

    if (!board) {
      return res.status(404).json({ error: "Board not found" });
    }

    board.title = title;
    await board.save();

    res.json(await formatBoardSummary(board));
  } catch (error) {
    console.log(error);
    res.status(500).json({ error: "Failed to rename board" });
  }
});

router.delete("/:boardId", ensureAuthenticated, async (req, res) => {
  try {
    const board = await getOwnedBoard(req.userId, req.params.boardId);

    if (!board) {
      return res.status(404).json({ error: "Board not found" });
    }

    if (board.isDefault) {
      return res.status(400).json({ error: "The default board cannot be deleted" });
    }

    await BoardItem.deleteMany({ boardId: board._id });
    await Board.deleteOne({ _id: board._id, userId: req.userId });

    res.json({ message: "Board deleted" });
  } catch (error) {
    console.log(error);
    res.status(500).json({ error: "Failed to delete board" });
  }
});

router.post("/:boardId/albums", ensureAuthenticated, async (req, res) => {
  try {
    const { spotifyId } = req.body;

    if (!spotifyId) {
      return res.status(400).json({ error: "spotifyId is required" });
    }

    const board = await getOwnedBoard(req.userId, req.params.boardId);

    if (!board) {
      return res.status(404).json({ error: "Board not found" });
    }

    const catalogAlbum = await getOrCreateAlbumCatalog(spotifyId);
    const savedAt = new Date();
    const boardItem = await BoardItem.findOneAndUpdate(
      {
        boardId: board._id,
        spotifyId,
      },
      {
        $setOnInsert: {
          userId: req.userId,
          boardId: board._id,
          spotifyId,
          albumCatalogId: catalogAlbum._id,
          savedAt,
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    ).populate("albumCatalogId");

    if (board.isDefault) {
      await saveAlbumToLegacyCollection({
        userId: req.userId,
        catalogAlbum,
        spotifyId,
        savedAt,
      });
    }

    res.status(201).json({
      board: await formatBoardSummary(board),
      album: formatBoardItem(boardItem),
    });
  } catch (error) {
    console.log(error);
    res.status(500).json({ error: "Failed to save album to board" });
  }
});

router.delete("/:boardId/albums/:spotifyId", ensureAuthenticated, async (req, res) => {
  try {
    const board = await getOwnedBoard(req.userId, req.params.boardId);

    if (!board) {
      return res.status(404).json({ error: "Board not found" });
    }

    await BoardItem.findOneAndDelete({
      boardId: board._id,
      spotifyId: req.params.spotifyId,
    });

    if (board.isDefault) {
      await Album.findOneAndDelete({
        spotifyId: req.params.spotifyId,
        userId: req.userId,
      });
    }

    res.json({ message: "Album removed from board" });
  } catch (error) {
    console.log(error);
    res.status(500).json({ error: "Failed to remove album from board" });
  }
});

module.exports = router;
