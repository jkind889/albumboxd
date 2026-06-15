import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useAuth } from "@clerk/react";

function getArtistName(album) {
  if (Array.isArray(album.artists) && album.artists.length > 0) {
    return album.artists.join(", ");
  }

  return album.artist || "Artist unknown";
}

export function BoardDetail() {
  const { boardId } = useParams();
  const navigate = useNavigate();
  const { getToken, isSignedIn } = useAuth();
  const [board, setBoard] = useState(null);
  const [title, setTitle] = useState("");
  const [query, setQuery] = useState("");
  const [viewMode, setViewMode] = useState("grid");
  const [error, setError] = useState("");
  const [isSavingTitle, setIsSavingTitle] = useState(false);

  const fetchBoard = useCallback(async function fetchBoard() {
    if (!isSignedIn || !boardId) {
      setBoard(null);
      return;
    }

    try {
      const token = await getToken();
      const response = await fetch(`http://localhost:3000/boards/${boardId}`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (!response.ok) {
        throw new Error("Failed to fetch board");
      }

      const data = await response.json();
      setBoard(data);
      setTitle(data.title || "");
      setError("");
    } catch (boardError) {
      console.error(boardError);
      setBoard(null);
      setError("Could not load this board.");
    }
  }, [boardId, getToken, isSignedIn]);

  useEffect(() => {
    fetchBoard();
  }, [fetchBoard]);

  const filteredAlbums = useMemo(() => {
    const albums = board?.albums || [];
    const normalizedQuery = query.trim().toLowerCase();

    if (!normalizedQuery) {
      return albums;
    }

    return albums.filter((album) => [
      album.title,
      album.artist,
      ...(album.artists || []),
      album.year,
    ].join(" ").toLowerCase().includes(normalizedQuery));
  }, [board, query]);

  async function renameBoard(event) {
    event.preventDefault();

    const nextTitle = title.trim();

    if (!nextTitle || !board || nextTitle === board.title || isSavingTitle) {
      return;
    }

    try {
      setIsSavingTitle(true);
      const token = await getToken();
      const response = await fetch(`http://localhost:3000/boards/${board._id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ title: nextTitle }),
      });

      if (!response.ok) {
        throw new Error("Failed to rename board");
      }

      const updatedBoard = await response.json();
      setBoard((currentBoard) => ({ ...currentBoard, ...updatedBoard }));
      setTitle(updatedBoard.title);
      setError("");
    } catch (renameError) {
      console.error(renameError);
      setError("Could not rename this board.");
    } finally {
      setIsSavingTitle(false);
    }
  }

  async function deleteBoard() {
    if (!board || board.isDefault) {
      return;
    }

    try {
      const token = await getToken();
      const response = await fetch(`http://localhost:3000/boards/${board._id}`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (!response.ok) {
        throw new Error("Failed to delete board");
      }

      navigate("/boards");
    } catch (deleteError) {
      console.error(deleteError);
      setError("Could not delete this board.");
    }
  }

  async function removeAlbum(spotifyId) {
    if (!board) {
      return;
    }

    try {
      const token = await getToken();
      const response = await fetch(`http://localhost:3000/boards/${board._id}/albums/${spotifyId}`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (!response.ok) {
        throw new Error("Failed to remove album");
      }

      setBoard((currentBoard) => ({
        ...currentBoard,
        itemCount: Math.max(0, (currentBoard.itemCount || 1) - 1),
        albums: currentBoard.albums.filter((album) => album.spotifyId !== spotifyId),
      }));
    } catch (removeError) {
      console.error(removeError);
      setError("Could not remove that album.");
    }
  }

  if (!isSignedIn) {
    return (
      <section className="board-detail-page">
        <div className="boards-empty">
          <h1>Board</h1>
          <p>Sign in to view your boards.</p>
        </div>
      </section>
    );
  }

  if (!board) {
    return (
      <section className="board-detail-page">
        <div className="boards-empty">
          <h1>{error || "Loading board..."}</h1>
          <Link to="/boards">Back to boards</Link>
        </div>
      </section>
    );
  }

  return (
    <section className="board-detail-page">
      <div className="board-detail-header">
        <Link className="board-back-link" to="/boards">Boards</Link>
        <form className="board-title-form" onSubmit={renameBoard}>
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={80}
            aria-label="Board title"
          />
          <button type="submit" disabled={!title.trim() || title.trim() === board.title || isSavingTitle}>
            Rename
          </button>
        </form>
        <p>
          {board.isDefault ? "Default board" : "Board"} · {board.itemCount} album{board.itemCount === 1 ? "" : "s"}
        </p>
        <div className="board-detail-actions">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search this board"
          />
          <div className="profile-view-toggle" aria-label="Board view">
            <button
              className={viewMode === "grid" ? "profile-view-toggle-active" : ""}
              type="button"
              onClick={() => setViewMode("grid")}
            >
              Grid
            </button>
            <button
              className={viewMode === "list" ? "profile-view-toggle-active" : ""}
              type="button"
              onClick={() => setViewMode("list")}
            >
              List
            </button>
          </div>
          {!board.isDefault && (
            <button className="board-danger-button" type="button" onClick={deleteBoard}>
              Delete
            </button>
          )}
        </div>
      </div>

      {error && <p className="boards-error">{error}</p>}

      {filteredAlbums.length === 0 ? (
        <div className="boards-empty">
          <h2>No albums here yet</h2>
          <p>Save albums from their detail pages to build this board.</p>
        </div>
      ) : viewMode === "grid" ? (
        <div className="board-album-grid">
          {filteredAlbums.map((album) => (
            <article className="board-album-card" key={album.spotifyId}>
              <Link to={`/album/${album.spotifyId}`}>
                {album.cover ? <img src={album.cover} alt={`${album.title} cover`} /> : <span>No cover</span>}
                <h2>{album.title || "Untitled album"}</h2>
                <p>{getArtistName(album)}</p>
              </Link>
              <button type="button" onClick={() => removeAlbum(album.spotifyId)}>Remove</button>
            </article>
          ))}
        </div>
      ) : (
        <div className="board-album-list">
          {filteredAlbums.map((album) => (
            <article className="board-album-row" key={album.spotifyId}>
              <Link to={`/album/${album.spotifyId}`}>
                {album.cover ? <img src={album.cover} alt={`${album.title} cover`} /> : <span>No cover</span>}
                <strong>{album.title || "Untitled album"}</strong>
                <em>{getArtistName(album)}</em>
              </Link>
              <button type="button" onClick={() => removeAlbum(album.spotifyId)}>Remove</button>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

export default BoardDetail;
