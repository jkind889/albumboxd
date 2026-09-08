import { API_BASE_URL } from "../config/api";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useAuth } from "@clerk/react";
import AsyncState from "../Components/Loading/AsyncState";

function getArtistName(album) {
  return album.artistDisplayName || "Artist unknown";
}

export function BoardDetail() {
  const { boardId, userId } = useParams();
  const navigate = useNavigate();
  const { getToken, isSignedIn } = useAuth();
  const isPublicBoard = Boolean(userId);
  const [board, setBoard] = useState(null);
  const [title, setTitle] = useState("");
  const [query, setQuery] = useState("");
  const [viewMode, setViewMode] = useState("grid");
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSavingTitle, setIsSavingTitle] = useState(false);

  const fetchBoard = useCallback(async function fetchBoard() {
    if ((!isSignedIn && !isPublicBoard) || !boardId) {
      setBoard(null);
      setLoadError("");
      setIsLoading(false);
      return;
    }

    try {
      setIsLoading(true);
      setLoadError("");
      const token = isSignedIn ? await getToken() : null;
      const boardUrl = isPublicBoard
        ? `${API_BASE_URL}/profile/${encodeURIComponent(userId)}/boards/${boardId}`
        : `${API_BASE_URL}/boards/${boardId}`;
      const response = await fetch(boardUrl, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });

      if (!response.ok) {
        throw new Error("Failed to fetch board");
      }

      const data = await response.json();
      setBoard(data);
      setTitle(data.title || "");
      setLoadError("");
    } catch (boardError) {
      console.error(boardError);
      setBoard(null);
      setLoadError("Could not load this board.");
    } finally {
      setIsLoading(false);
    }
  }, [boardId, getToken, isPublicBoard, isSignedIn, userId]);

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
      album.artistDisplayName,
      album.releaseYear,
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
      setActionError("");
      const token = await getToken();
      const response = await fetch(`${API_BASE_URL}/boards/${board.boardId}`, {
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
      setActionError("");
    } catch (renameError) {
      console.error(renameError);
      setActionError("Could not rename this board.");
    } finally {
      setIsSavingTitle(false);
    }
  }

  async function deleteBoard() {
    if (!board || board.isDefault) {
      return;
    }

    try {
      setActionError("");
      const token = await getToken();
      const response = await fetch(`${API_BASE_URL}/boards/${board.boardId}`, {
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
      setActionError("Could not delete this board.");
    }
  }

  async function removeAlbum(albumId) {
    if (!board) {
      return;
    }

    try {
      setActionError("");
      const token = await getToken();
      const response = await fetch(`${API_BASE_URL}/boards/${board.boardId}/albums/${albumId}`, {
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
        albums: currentBoard.albums.filter((album) => album.albumId !== albumId),
      }));
    } catch (removeError) {
      console.error(removeError);
      setActionError("Could not remove that album.");
    }
  }

  if (!isSignedIn && !isPublicBoard) {
    return (
      <section className="board-detail-page">
        <div className="boards-empty">
          <h1>Board</h1>
          <p>Sign in to view your boards.</p>
        </div>
      </section>
    );
  }

  if (isLoading || loadError || !board) {
    return (
      <section className="board-detail-page">
        <AsyncState
          isLoading={isLoading}
          error={loadError}
          isEmpty={!isLoading && !loadError && !board}
          loadingVariant="detail"
          loadingMessage="Loading board"
          errorTitle="Board unavailable"
          emptyTitle="Board unavailable"
          emptyBody="This board could not be found."
        />
        <Link className="board-back-link" to={isPublicBoard ? `/profile/${userId}` : "/boards"}>
          {isPublicBoard ? "Back to profile" : "Back to boards"}
        </Link>
      </section>
    );
  }

  return (
    <section className="board-detail-page">
      <div className="board-detail-header">
        <Link className="board-back-link" to={isPublicBoard ? `/profile/${userId}` : "/boards"}>
          {isPublicBoard ? "Profile" : "Boards"}
        </Link>
        {isPublicBoard ? (
          <h1>{board.title}</h1>
        ) : (
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
        )}
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
          {!isPublicBoard && !board.isDefault && (
            <button className="board-danger-button" type="button" onClick={deleteBoard}>
              Delete
            </button>
          )}
        </div>
      </div>

      {actionError && <p className="boards-error">{actionError}</p>}

      {filteredAlbums.length === 0 ? (
        <div className="boards-empty">
          <h2>No albums here yet</h2>
          <p>Save albums from their detail pages to build this board.</p>
        </div>
      ) : viewMode === "grid" ? (
        <div className="board-album-grid">
          {filteredAlbums.map((album) => (
            <article className="board-album-card" key={album.albumId}>
              <Link to={`/album/${album.albumId}`}>
                {album.cover ? <img src={album.cover} alt={`${album.title} cover`} /> : <span>No cover</span>}
                <h2>{album.title || "Untitled album"}</h2>
                <p>{getArtistName(album)}</p>
              </Link>
              {!isPublicBoard && (
                <button type="button" onClick={() => removeAlbum(album.albumId)}>Remove</button>
              )}
            </article>
          ))}
        </div>
      ) : (
        <div className="board-album-list">
          {filteredAlbums.map((album) => (
            <article className="board-album-row" key={album.albumId}>
              <Link to={`/album/${album.albumId}`}>
                {album.cover ? <img src={album.cover} alt={`${album.title} cover`} /> : <span>No cover</span>}
                <strong>{album.title || "Untitled album"}</strong>
                <em>{getArtistName(album)}</em>
              </Link>
              {!isPublicBoard && (
                <button type="button" onClick={() => removeAlbum(album.albumId)}>Remove</button>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

export default BoardDetail;
