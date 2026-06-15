import {Link, useLocation, useParams} from "react-router-dom";
import {useState, useEffect } from "react";
import ReviewForm from "./ReviewForm";
import AlbumReviewFeed from "./AlbumReviewFeed";
import { useAuth } from "@clerk/react";
export function AlbumDetail()
{
    const {id} = useParams();
    const [album, setAlbum] = useState(null);
    const [reviews, setReviews] = useState([]);
    const [isSaved, setIsSaved] = useState(false);
    const [savedBoardIds, setSavedBoardIds] = useState([]);
    const [boards, setBoards] = useState([]);
    const [activeTab, setActiveTab] = useState("artist");
    const [isReviewModalOpen, setIsReviewModalOpen] = useState(false);
    const [isBoardModalOpen, setIsBoardModalOpen] = useState(false);
    const [newBoardTitle, setNewBoardTitle] = useState("");
    const [boardSaveMessage, setBoardSaveMessage] = useState("");
    const [isSavingBoard, setIsSavingBoard] = useState(false);
    const { getToken, userId } = useAuth();
    const location = useLocation();

    useEffect(() => {
        async function fetchReviews() {
            try {
                const res = await fetch(`http://localhost:3000/reviews/review/album/${id}`);

                if (!res.ok) {
                    console.error("Failed to fetch reviews");
                    setReviews([]);
                    return;
                }

                const data = await res.json();
                setReviews(Array.isArray(data) ? data : []);
            } catch (error) {
                console.error("Failed to fetch reviews", error);
                setReviews([]);
            }
        }

        if (id) {
            fetchReviews();
        }
    }, [id])

    useEffect(() => {
        async function checkIfSaved() {
            const token = await getToken();

            const res = await fetch(
            `http://localhost:3000/boards/album/${id}`,
            {
                headers: {
                Authorization: `Bearer ${token}`,
                },
            }
            );

            if (!res.ok) {
                setIsSaved(false);
                setSavedBoardIds([]);
                return;
            }

            const data = await res.json();
            setIsSaved(data.saved);
            setSavedBoardIds(Array.isArray(data.boards) ? data.boards.map((board) => String(board._id)) : []);
        }

        if (id) {
            checkIfSaved();
        }
    }, [id, getToken]);
        

    useEffect(() => {
        // Fetch album details from the backend API
        // Use the album ID from the URL parameters
        fetch(`http://localhost:3000/albums/album/${id}`)
        .then(res => res.json())
        .then(data => setAlbum(data))
    }, [id])

    async function addReview(review) {
        const token = await getToken();
        const res = await fetch("http://localhost:3000/reviews/review", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${token}`
            },
            body: JSON.stringify(review)  
          });
        if (!res.ok) {
            console.error("Failed to submit review");
            return false;
        }

        const newReview = await res.json();
        console.log("Review saved to server:", newReview);
        setReviews((prev) => [newReview, ...prev]);
        return true;

    };

    async function removeReview(id) {
        const token = await getToken();
        const res = await fetch(`http://localhost:3000/reviews/review/user/${id}`, {
            method: "DELETE",
            headers: {
                "Authorization": `Bearer ${token}`
            }
        });
        if (!res.ok) {
            console.error("Failed to delete review");
            return;
        }
        setReviews((prev) => prev.filter((review) => review._id !== id));
    };


     if (!album) return <p>Loading...</p>;

    const artistNames = album.artists?.length ? album.artists : [album.artist];
    const userReviews = reviews.filter((review) => review.userId);
    const averageRating = userReviews.length
        ? (userReviews.reduce((total, item) => total + (Number(item.rating) || 0), 0) / userReviews.length).toFixed(1)
        : null;
    const albumArt = album.imgs?.[0]?.url;
    const isReviewsRoute = location.pathname.endsWith("/reviews");
    const reviewSort = new URLSearchParams(location.search).get("sort") === "popular" ? "popular" : "recent";
    const releaseDateLabel = album.releaseDate
        ? new Date(`${album.releaseDate}T00:00:00`).toLocaleDateString(undefined, {
            year: "numeric",
            month: "long",
            day: album.releaseDate.length > 7 ? "numeric" : undefined
          })
        : null;
    const sortedTracks = [...(album.tracks || [])].sort((first, second) => {
        const firstDisc = Number(first.discNumber) || 1;
        const secondDisc = Number(second.discNumber) || 1;
        const firstTrack = Number(first.trackNumber) || 0;
        const secondTrack = Number(second.trackNumber) || 0;

        return firstDisc - secondDisc || firstTrack - secondTrack;
    });
    const hasMultipleDiscs = sortedTracks.some((track) => Number(track.discNumber) > 1);
    const previewTracks = sortedTracks.slice(0, 14);
    const hasMoreTracks = sortedTracks.length > 14;
    const recentReviews = [...userReviews].sort((first, second) => {
        return new Date(second.date || 0).getTime() - new Date(first.date || 0).getTime();
    });
    const popularReviews = [...userReviews].sort((first, second) => {
        return (Number(second.rating) || 0) - (Number(first.rating) || 0)
            || new Date(second.date || 0).getTime() - new Date(first.date || 0).getTime();
    });
    const selectedReviews = reviewSort === "popular" ? popularReviews : recentReviews;
    const formatTrackDuration = (durationMs) => {
        const totalSeconds = Math.floor((Number(durationMs) || 0) / 1000);

        if (!totalSeconds) {
            return "--:--";
        }

        const minutes = Math.floor(totalSeconds / 60);
        const seconds = String(totalSeconds % 60).padStart(2, "0");

        return `${minutes}:${seconds}`;
    };

// users can keep saving the same album over and over again, need to check if the album already exists in the user's collection before saving
    async function handleSaveToCollection() {
        const token = await getToken();
        

        const res = await fetch("http://localhost:3000/boards/default/albums", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${token}`
            },
            // The backend uses this ID to find or create the catalog album before saving.
            body: JSON.stringify({
                spotifyId: album.id,
             }),
        });
        const data = await res.json();

        if (!res.ok) {
            console.error("Failed to save album to collection");
            alert("Failed to save album to collection. Please try again.");
            return;
        }
        if (res.ok) {
            setIsSaved(true);
            if (data.board?._id) {
                setSavedBoardIds((currentIds) => [...new Set([...currentIds, String(data.board._id)])]);
            }
        }


        console.log("Album saved to collection:", data);
    }

    async function fetchBoards() {
        const token = await getToken();
        const res = await fetch("http://localhost:3000/boards", {
            headers: {
                Authorization: `Bearer ${token}`,
            },
        });

        if (!res.ok) {
            throw new Error("Failed to fetch boards");
        }

        const data = await res.json();
        setBoards(Array.isArray(data) ? data : []);
    }

    async function openBoardModal() {
        try {
            await fetchBoards();
            setBoardSaveMessage("");
            setIsBoardModalOpen(true);
        } catch (error) {
            console.error(error);
            alert("Failed to load boards. Please try again.");
        }
    }

    async function saveAlbumToBoard(boardId) {
        if (isSavingBoard) {
            return;
        }

        try {
            setIsSavingBoard(true);
            const token = await getToken();
            const res = await fetch(`http://localhost:3000/boards/${boardId}/albums`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify({ spotifyId: album.id }),
            });

            if (!res.ok) {
                throw new Error("Failed to save album to board");
            }

            const data = await res.json();
            setIsSaved(true);
            if (data.board?._id) {
                setSavedBoardIds((currentIds) => [...new Set([...currentIds, String(data.board._id)])]);
            }
            setBoardSaveMessage(`Saved to ${data.board?.title || "board"}.`);
            await fetchBoards();
        } catch (error) {
            console.error(error);
            setBoardSaveMessage("Could not save to that board.");
        } finally {
            setIsSavingBoard(false);
        }
    }

    async function createBoardAndSave(event) {
        event.preventDefault();

        const title = newBoardTitle.trim();

        if (!title || isSavingBoard) {
            return;
        }

        try {
            setIsSavingBoard(true);
            const token = await getToken();
            const createResponse = await fetch("http://localhost:3000/boards", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify({ title }),
            });

            if (!createResponse.ok) {
                throw new Error("Failed to create board");
            }

            const createdBoard = await createResponse.json();
            setBoards((currentBoards) => [createdBoard, ...currentBoards]);
            setNewBoardTitle("");
            setIsSavingBoard(false);
            await saveAlbumToBoard(createdBoard._id);
        } catch (error) {
            console.error(error);
            setBoardSaveMessage("Could not create that board.");
            setIsSavingBoard(false);
        }
    }



    return (

        <section className="album-detail-page">
            <div className="album-detail-shell">
                <aside className="album-detail-sidebar">
                    <div className="album-poster-card">
                        {albumArt ? (
                            <img
                                className="album-poster-image"
                                src={albumArt}
                                alt={`${album.title} cover`}
                            />
                        ) : (
                            <div className="album-poster-fallback">No cover art</div>
                        )}
                    </div>

                    <div className="album-side-actions" aria-label="Album actions">
                        <button className="album-side-action" disabled={isSaved} onClick={handleSaveToCollection}>
                            <span aria-hidden="true">+</span>
                            {isSaved ? "Saved" : "Save"}
                        </button>
                        <button className="album-side-action" type="button" onClick={openBoardModal}>
                            Boards...
                        </button>
                        <button className="album-side-action" type="button" onClick={() => setIsReviewModalOpen(true)}>
                            <span aria-hidden="true">★</span>
                            Rate
                        </button>
                        <button className="album-side-action" type="button" onClick={() => setIsReviewModalOpen(true)}>
                            Review or log...
                        </button>
                        {album.spotifyUrl && (
                            <a
                                className="album-side-action"
                                href={album.spotifyUrl}
                                target="_blank"
                                rel="noreferrer"
                            >
                                Open in Spotify
                            </a>
                        )}
                    </div>

                    <div className="album-ratings-panel">
                        <div className="album-panel-header">
                            <span>Ratings</span>
                            <span>{userReviews.length} user review{userReviews.length === 1 ? "" : "s"}</span>
                        </div>
                        <div className="album-rating-summary">
                            <div className="album-rating-bars" aria-hidden="true">
                                {[2, 4, 6, 8, 10, 7, 3, 3].map((height, index) => (
                                    <span key={index} style={{"--bar-height": `${height * 4}px`}} />
                                ))}
                            </div>
                            <strong>{averageRating || "--"}</strong>
                        </div>
                    </div>
                </aside>

                <div className="album-detail-main">
                    <div className="album-title-block">
                        <p className="album-detail-kicker">{album.albumType}</p>
                        <h1>{album.title}</h1>
                        <div className="album-meta-line">
                            <span>{album.year}</span>
                            <span>{artistNames.join(", ")}</span>
                            {album.label && <span>{album.label}</span>}
                        </div>
                    </div>

                    <nav className="album-tabs" aria-label="Album sections">
                        {["artist", "release", "format", "tracks"].map((tab) => (
                            <button
                                key={tab}
                                type="button"
                                className={activeTab === tab ? "album-tab album-tab-active" : "album-tab"}
                                onClick={() => setActiveTab(tab)}
                            >
                                {tab}
                            </button>
                        ))}
                    </nav>

                    {!isReviewsRoute && (
                        <section className="album-info-panel">
                            {activeTab === "artist" && (
                                <dl className="album-facts">
                                    <div>
                                        <dt>Artist</dt>
                                        <dd>{artistNames.join(", ")}</dd>
                                    </div>
                                    {album.label && (
                                        <div>
                                            <dt>Label</dt>
                                            <dd>{album.label}</dd>
                                        </div>
                                    )}
                                </dl>
                            )}

                            {activeTab === "release" && (
                                <dl className="album-facts">
                                    <div>
                                        <dt>Release</dt>
                                        <dd>{releaseDateLabel || album.year || "Unknown"}</dd>
                                    </div>
                                    <div>
                                        <dt>Year</dt>
                                        <dd>{album.year || "Unknown"}</dd>
                                    </div>
                                </dl>
                            )}

                            {activeTab === "format" && (
                                <dl className="album-facts">
                                    <div>
                                        <dt>Format</dt>
                                        <dd>{album.albumType || "Album"}</dd>
                                    </div>
                                    <div>
                                        <dt>Tracks</dt>
                                        <dd>{album.totalTracks || sortedTracks.length || "Unknown"}</dd>
                                    </div>
                                </dl>
                            )}

                            {activeTab === "tracks" && (
                                <div className="album-tracklist album-tracklist-tab">
                                    {sortedTracks.length > 0 ? (
                                        <>
                                            <ol>
                                                {(hasMoreTracks ? previewTracks : sortedTracks).map((track, index) => {
                                                const trackNumber = Number(track.trackNumber) || index + 1;
                                                const discNumber = Number(track.discNumber) || 1;
                                                const trackLabel = hasMultipleDiscs
                                                    ? `${discNumber}.${trackNumber}`
                                                    : trackNumber;

                                                return (
                                                    <li key={track.spotifyId || `${discNumber}-${trackNumber}-${track.title}`}>
                                                        <span className="album-track-number">{trackLabel}</span>
                                                        <span className="album-track-title">{track.title || "Untitled Track"}</span>
                                                        <span className="album-track-duration">{formatTrackDuration(track.durationMs)}</span>
                                                    </li>
                                                );
                                            })}
                                            </ol>
                                            {hasMoreTracks && album.spotifyUrl && (
                                                <a className="album-more-link" href={album.spotifyUrl} target="_blank" rel="noreferrer">
                                                    More
                                                </a>
                                            )}
                                        </>
                                    ) : (
                                        <p className="album-empty-copy">No tracks available.</p>
                                    )}
                                </div>
                            )}
                        </section>
                    )}

                    {isReviewsRoute ? (
                        <section className="album-reviews-section">
                            <div className="album-section-heading">
                                <h2>{reviewSort === "popular" ? "Popular Reviews" : "Recent Reviews"}</h2>
                                <Link className="album-more-link" to={`/album/${id}`}>Back to album</Link>
                            </div>
                            <AlbumReviewFeed
                                reviews={selectedReviews}
                                currentUserId={userId}
                                onRemoveReview={removeReview}
                            />
                        </section>
                    ) : (
                        <section className="album-review-previews">
                            <div className="album-review-column">
                                <div className="album-section-heading">
                                    <h2>Popular Reviews</h2>
                                    {popularReviews.length > 2 && <Link className="album-more-link" to={`/album/${id}/reviews?sort=popular`}>More</Link>}
                                </div>
                                <AlbumReviewFeed
                                    reviews={popularReviews.slice(0, 2)}
                                    currentUserId={userId}
                                    onRemoveReview={removeReview}
                                />
                            </div>
                            <div className="album-review-column">
                                <div className="album-section-heading">
                                    <h2>Recent Reviews</h2>
                                    {recentReviews.length > 2 && <Link className="album-more-link" to={`/album/${id}/reviews?sort=recent`}>More</Link>}
                                </div>
                                <AlbumReviewFeed
                                    reviews={recentReviews.slice(0, 2)}
                                    currentUserId={userId}
                                    onRemoveReview={removeReview}
                                />
                            </div>
                        </section>
                    )}
                </div>
            </div>
            {isReviewModalOpen && (
                <div className="review-modal-backdrop" role="presentation" onMouseDown={() => setIsReviewModalOpen(false)}>
                    <div className="review-modal" role="dialog" aria-modal="true" aria-label={`Review ${album.title}`} onMouseDown={(event) => event.stopPropagation()}>
                        <button className="review-modal-close" type="button" onClick={() => setIsReviewModalOpen(false)} aria-label="Close review form">
                            ×
                        </button>
                        <ReviewForm album={album} onAddReview={addReview} onSubmitted={() => setIsReviewModalOpen(false)} />
                    </div>
                </div>
            )}
            {isBoardModalOpen && (
                <div className="review-modal-backdrop" role="presentation" onMouseDown={() => setIsBoardModalOpen(false)}>
                    <div className="review-modal board-save-modal" role="dialog" aria-modal="true" aria-label={`Save ${album.title} to a board`} onMouseDown={(event) => event.stopPropagation()}>
                        <button className="review-modal-close" type="button" onClick={() => setIsBoardModalOpen(false)} aria-label="Close board picker">
                            ×
                        </button>
                        <div className="board-save-modal-header">
                            <h2>Save to board</h2>
                            <p>{album.title}</p>
                        </div>
                        <div className="board-save-list">
                            {boards.map((board) => {
                                const boardId = String(board._id);
                                const alreadySaved = savedBoardIds.includes(boardId);

                                return (
                                    <button
                                        className="board-save-option"
                                        key={board._id}
                                        type="button"
                                        onClick={() => saveAlbumToBoard(board._id)}
                                        disabled={alreadySaved || isSavingBoard}
                                    >
                                        <span>{board.title}</span>
                                        <small>{alreadySaved ? "Saved" : `${board.itemCount || 0} albums`}</small>
                                    </button>
                                );
                            })}
                        </div>
                        <form className="board-save-create" onSubmit={createBoardAndSave}>
                            <input
                                value={newBoardTitle}
                                onChange={(event) => setNewBoardTitle(event.target.value)}
                                placeholder="Create a new board"
                                maxLength={80}
                            />
                            <button type="submit" disabled={!newBoardTitle.trim() || isSavingBoard}>
                                Create
                            </button>
                        </form>
                        {boardSaveMessage && <p className="board-save-message">{boardSaveMessage}</p>}
                    </div>
                </div>
            )}
        </section>



        // Album Detail component rendered when user clicks on a search result, showing more information about the selected album
    );

}

export default AlbumDetail;
