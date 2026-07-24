import { API_BASE_URL } from "../config/api";
import {Link, useLocation, useParams} from "react-router-dom";
import {useState, useEffect } from "react";
import ReviewForm from "./ReviewForm";
import AlbumReviewFeed from "./AlbumReviewFeed";
import LikeButton from "./LikeButton";
import AsyncState from "./Loading/AsyncState";
import { SignInButton, useAuth } from "@clerk/react";
import { getApiErrorMessage } from "../utils/apiErrors";

const RATING_BUCKETS = [1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5];

const getEmptyRatingDistribution = () => (
    RATING_BUCKETS.map((rating) => ({ rating, count: 0 }))
);

const normalizeRatingDistribution = (distribution) => {
    const countsByRating = new Map(
        (Array.isArray(distribution) ? distribution : []).map((bucket) => [
            Number(bucket.rating),
            Number(bucket.count) || 0,
        ])
    );

    return getEmptyRatingDistribution().map((bucket) => ({
        ...bucket,
        count: countsByRating.get(bucket.rating) || 0,
    }));
};

const getAverageRatingFromDistribution = (distribution) => {
    const reviewCount = distribution.reduce((total, bucket) => total + bucket.count, 0);

    if (!reviewCount) {
        return null;
    }

    const ratingTotal = distribution.reduce((total, bucket) => total + (bucket.rating * bucket.count), 0);
    return (ratingTotal / reviewCount).toFixed(1);
};

const adjustRatingDistribution = (distribution, rating, delta) => {
    const normalizedRating = Number(rating);

    if (!RATING_BUCKETS.includes(normalizedRating)) {
        return normalizeRatingDistribution(distribution);
    }

    return normalizeRatingDistribution(distribution).map((bucket) => (
        bucket.rating === normalizedRating
            ? { ...bucket, count: Math.max(0, bucket.count + delta) }
            : bucket
    ));
};

const getDefaultAlbumSocial = () => ({
    savedCount: 0,
    reviewCount: 0,
    averageRating: null,
    ratingDistribution: getEmptyRatingDistribution(),
    followedReviewers: [],
    followedAlbumLikers: [],
});

export function AlbumDetail()
{
    const {id} = useParams();
    const [album, setAlbum] = useState(null);
    const [isAlbumLoading, setIsAlbumLoading] = useState(true);
    const [albumError, setAlbumError] = useState("");
    const [reviews, setReviews] = useState([]);
    const [isSaved, setIsSaved] = useState(false);
    const [isBoardStateLoading, setIsBoardStateLoading] = useState(false);
    const [savedBoardIds, setSavedBoardIds] = useState([]);
    const [boards, setBoards] = useState([]);
    const [activeTab, setActiveTab] = useState("artist");
    const [isReviewModalOpen, setIsReviewModalOpen] = useState(false);
    const [isBoardModalOpen, setIsBoardModalOpen] = useState(false);
    const [newBoardTitle, setNewBoardTitle] = useState("");
    const [boardSaveMessage, setBoardSaveMessage] = useState("");
    const [isSavingBoard, setIsSavingBoard] = useState(false);
    const [albumLike, setAlbumLike] = useState({ likeCount: 0, likedByViewer: false });
    const [albumSocial, setAlbumSocial] = useState(getDefaultAlbumSocial);
    const [expandedSocialSections, setExpandedSocialSections] = useState({});
    const [likeMessage, setLikeMessage] = useState("");
    const [reviewActionMessage, setReviewActionMessage] = useState("");
    const { getToken, isSignedIn, userId } = useAuth();
    const location = useLocation();
    const canUseAuthenticatedActions = Boolean(isSignedIn && userId);

    useEffect(() => {
        async function fetchReviews() {
            try {
                const token = userId ? await getToken() : null;
                const headers = token ? { Authorization: `Bearer ${token}` } : {};
                const res = await fetch(`${API_BASE_URL}/reviews/review/album/${id}`, { headers });

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
    }, [getToken, id, userId])

    useEffect(() => {
        async function fetchAlbumLike() {
            try {
                const token = userId ? await getToken() : null;
                const headers = token ? { Authorization: `Bearer ${token}` } : {};
                const res = await fetch(`${API_BASE_URL}/likes/album/${id}`, { headers });

                if (!res.ok) {
                    setAlbumLike({ likeCount: 0, likedByViewer: false });
                    return;
                }

                const data = await res.json();
                setAlbumLike({
                    likeCount: Number(data.likeCount) || 0,
                    likedByViewer: Boolean(data.likedByViewer),
                });
            } catch (error) {
                console.error("Failed to fetch album likes", error);
                setAlbumLike({ likeCount: 0, likedByViewer: false });
            }
        }

        if (id) {
            fetchAlbumLike();
        }
    }, [getToken, id, userId]);

    useEffect(() => {
        let shouldIgnore = false;

        async function fetchAlbumSocial() {
            try {
                const token = userId ? await getToken() : null;
                const headers = token ? { Authorization: `Bearer ${token}` } : {};
                const res = await fetch(`${API_BASE_URL}/albums/album/${id}/social`, { headers });

                if (!res.ok) {
                    throw new Error("Failed to fetch album social context");
                }

                const data = await res.json();

                if (!shouldIgnore) {
                    setAlbumSocial({
                        savedCount: Number(data.savedCount) || 0,
                        reviewCount: Number(data.reviewCount) || 0,
                        averageRating: Number.isFinite(Number(data.averageRating)) ? Number(data.averageRating) : null,
                        ratingDistribution: normalizeRatingDistribution(data.ratingDistribution),
                        followedReviewers: Array.isArray(data.followedReviewers) ? data.followedReviewers : [],
                        followedAlbumLikers: Array.isArray(data.followedAlbumLikers) ? data.followedAlbumLikers : [],
                    });
                }
            } catch (error) {
                console.error("Failed to fetch album social context", error);

                if (!shouldIgnore) {
                    setAlbumSocial(getDefaultAlbumSocial());
                }
            }
        }

        if (id) {
            fetchAlbumSocial();
        }

        return () => {
            shouldIgnore = true;
        };
    }, [getToken, id, userId]);

    useEffect(() => {
        let shouldIgnore = false;

        async function checkIfSaved() {
            if (!canUseAuthenticatedActions) {
                setIsBoardStateLoading(false);
                setIsSaved(false);
                setSavedBoardIds([]);
                setBoards([]);
                setIsBoardModalOpen(false);
                return;
            }

            try {
                setIsBoardStateLoading(true);
                const token = await getToken();

                const res = await fetch(
                `${API_BASE_URL}/boards/album/${id}`,
                {
                    headers: {
                    Authorization: `Bearer ${token}`,
                    },
                }
                );

                if (shouldIgnore) {
                    return;
                }

                if (!res.ok) {
                    setIsSaved(false);
                    setSavedBoardIds([]);
                    return;
                }

                const data = await res.json();
                setIsSaved(data.saved);
                setSavedBoardIds(Array.isArray(data.boards) ? data.boards.map((board) => String(board._id)) : []);
            } catch (error) {
                console.error("Failed to check board saves", error);

                if (!shouldIgnore) {
                    setIsSaved(false);
                    setSavedBoardIds([]);
                }
            } finally {
                if (!shouldIgnore) {
                    setIsBoardStateLoading(false);
                }
            }
        }

        if (id) {
            checkIfSaved();
        }

        return () => {
            shouldIgnore = true;
        };
    }, [canUseAuthenticatedActions, id, getToken]);
        

    useEffect(() => {
        let shouldIgnore = false;

        async function fetchAlbum() {
            try {
                setIsAlbumLoading(true);
                setAlbumError("");

                const res = await fetch(`${API_BASE_URL}/albums/album/${id}`);

                if (!res.ok) {
                    throw new Error(await getApiErrorMessage(res, "Failed to fetch album"));
                }

                const data = await res.json();

                if (!shouldIgnore) {
                    setAlbum(data);
                }
            } catch (error) {
                console.error("Failed to fetch album", error);

                if (!shouldIgnore) {
                    setAlbum(null);
                    setAlbumError(error.message || "Could not load this album.");
                }
            } finally {
                if (!shouldIgnore) {
                    setIsAlbumLoading(false);
                }
            }
        }

        if (id) {
            fetchAlbum();
        }

        return () => {
            shouldIgnore = true;
        };
    }, [id])

    async function addReview(review) {
        if (!canUseAuthenticatedActions) {
            return false;
        }

        setReviewActionMessage("");
        const token = await getToken();
        const res = await fetch(`${API_BASE_URL}/reviews/review`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${token}`
            },
            body: JSON.stringify(review)  
          });
        if (!res.ok) {
            const message = await getApiErrorMessage(res, "Failed to submit review");
            console.error("Failed to submit review");
            setReviewActionMessage(message);
            return false;
        }

        const newReview = await res.json();
        console.log("Review saved to server:", newReview);
        setReviews((prev) => [newReview, ...prev]);
        setAlbumSocial((currentSocial) => {
            const ratingDistribution = adjustRatingDistribution(currentSocial.ratingDistribution, newReview.rating, 1);

            return {
                ...currentSocial,
                reviewCount: (Number(currentSocial.reviewCount) || 0) + 1,
                averageRating: getAverageRatingFromDistribution(ratingDistribution),
                ratingDistribution,
            };
        });
        return true;

    };

    async function removeReview(id) {
        if (!canUseAuthenticatedActions) {
            return;
        }

        setReviewActionMessage("");
        const token = await getToken();
        const res = await fetch(`${API_BASE_URL}/reviews/review/user/${id}`, {
            method: "DELETE",
            headers: {
                "Authorization": `Bearer ${token}`
            }
        });
        if (!res.ok) {
            const message = await getApiErrorMessage(res, "Failed to delete review");
            console.error("Failed to delete review");
            setReviewActionMessage(message);
            return;
        }
        const removedReview = reviews.find((review) => review._id === id);
        setReviews((prev) => prev.filter((review) => review._id !== id));
        setAlbumSocial((currentSocial) => {
            const ratingDistribution = adjustRatingDistribution(currentSocial.ratingDistribution, removedReview?.rating, -1);

            return {
                ...currentSocial,
                reviewCount: Math.max(0, (Number(currentSocial.reviewCount) || 0) - 1),
                averageRating: getAverageRatingFromDistribution(ratingDistribution),
                ratingDistribution,
            };
        });
    };

    function updateReviewLikeState(reviewId, nextState) {
        setReviews((currentReviews) => (
            currentReviews.map((review) => (
                review._id === reviewId ? { ...review, ...nextState } : review
            ))
        ));
    }

    async function toggleReviewLike(review) {
        if (!canUseAuthenticatedActions) {
            setLikeMessage("Sign in to like reviews.");
            return;
        }

        const reviewId = review._id;
        const nextLiked = !review.likedByViewer;
        const previousLikeCount = Number(review.likeCount) || 0;
        const nextLikeCount = Math.max(0, previousLikeCount + (nextLiked ? 1 : -1));

        setLikeMessage("");
        updateReviewLikeState(reviewId, {
            likedByViewer: nextLiked,
            likeCount: nextLikeCount,
        });

        try {
            const token = await getToken();
            const response = await fetch(`${API_BASE_URL}/likes/review/${reviewId}`, {
                method: "PUT",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify({ liked: nextLiked }),
            });

            if (!response.ok) {
                throw new Error(await getApiErrorMessage(response, "Failed to update review like"));
            }

            const data = await response.json();
            updateReviewLikeState(reviewId, {
                likedByViewer: Boolean(data.likedByViewer),
                likeCount: Number(data.likeCount) || 0,
            });
        } catch (error) {
            console.error(error);
            updateReviewLikeState(reviewId, {
                likedByViewer: Boolean(review.likedByViewer),
                likeCount: previousLikeCount,
            });
            setLikeMessage(error.message || "Could not update that like.");
        }
    }

    async function toggleAlbumLike() {
        if (!canUseAuthenticatedActions) {
            setLikeMessage("Sign in to like albums.");
            return;
        }

        const nextLiked = !albumLike.likedByViewer;
        const previousAlbumLike = albumLike;
        const nextLikeCount = Math.max(0, (Number(albumLike.likeCount) || 0) + (nextLiked ? 1 : -1));

        setLikeMessage("");
        setAlbumLike({
            likedByViewer: nextLiked,
            likeCount: nextLikeCount,
        });

        try {
            const token = await getToken();
            const response = await fetch(`${API_BASE_URL}/likes/album/${id}`, {
                method: "PUT",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify({ liked: nextLiked }),
            });

            if (!response.ok) {
                throw new Error(await getApiErrorMessage(response, "Failed to update album like"));
            }

            const data = await response.json();
            setAlbumLike({
                likedByViewer: Boolean(data.likedByViewer),
                likeCount: Number(data.likeCount) || 0,
            });
        } catch (error) {
            console.error(error);
            setAlbumLike(previousAlbumLike);
            setLikeMessage(error.message || "Could not update that like.");
        }
    }

     if (isAlbumLoading || albumError || !album) {
        return (
            <AsyncState
                isLoading={isAlbumLoading}
                error={albumError}
                isEmpty={!isAlbumLoading && !albumError && !album}
                loadingVariant="detail"
                loadingMessage="Loading album"
                errorTitle="Album unavailable"
                emptyTitle="Album unavailable"
                emptyBody="This album could not be found."
            />
        );
     }

    const artistNames = album.artists?.length ? album.artists : [album.artist];
    const userReviews = reviews.filter((review) => review.userId);
    const socialReviewCount = Number(albumSocial.reviewCount) || userReviews.length;
    const socialSavedCount = Number(albumSocial.savedCount) || 0;
    const localAverageRating = userReviews.length
        ? (userReviews.reduce((total, item) => total + (Number(item.rating) || 0), 0) / userReviews.length).toFixed(1)
        : null;
    const ratingDistribution = normalizeRatingDistribution(albumSocial.ratingDistribution);
    const distributionAverageRating = getAverageRatingFromDistribution(ratingDistribution);
    const averageRating = Number.isFinite(Number(albumSocial.averageRating))
        ? Number(albumSocial.averageRating).toFixed(1)
        : distributionAverageRating || localAverageRating;
    const maxRatingBucketCount = Math.max(...ratingDistribution.map((bucket) => bucket.count), 0);
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
        return (Number(second.likeCount) || 0) - (Number(first.likeCount) || 0)
            || (Number(second.rating) || 0) - (Number(first.rating) || 0)
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
        if (!canUseAuthenticatedActions) {
            return;
        }

        const wasSaved = isSaved;
        const token = await getToken();
        setBoardSaveMessage("");
        

        const res = await fetch(`${API_BASE_URL}/boards/default/albums`, {
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
        if (!res.ok) {
            const message = await getApiErrorMessage(res, "Failed to save album to collection. Please try again.");
            console.error("Failed to save album to collection");
            setBoardSaveMessage(message);
            return;
        }
        const data = await res.json();
        if (res.ok) {
            setIsSaved(true);
            if (!wasSaved) {
                setAlbumSocial((currentSocial) => ({
                    ...currentSocial,
                    savedCount: (Number(currentSocial.savedCount) || 0) + 1,
                }));
            }
            if (data.board?._id) {
                setSavedBoardIds((currentIds) => [...new Set([...currentIds, String(data.board._id)])]);
            }
        }


        console.log("Album saved to collection:", data);
    }

    async function fetchBoards() {
        if (!canUseAuthenticatedActions) {
            return;
        }

        const token = await getToken();
        const res = await fetch(`${API_BASE_URL}/boards`, {
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
        if (!canUseAuthenticatedActions) {
            return;
        }

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
        if (!canUseAuthenticatedActions || isSavingBoard) {
            return;
        }

        try {
            const wasSaved = isSaved;
            setIsSavingBoard(true);
            const token = await getToken();
            const res = await fetch(`${API_BASE_URL}/boards/${boardId}/albums`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify({ spotifyId: album.id }),
            });

            if (!res.ok) {
                throw new Error(await getApiErrorMessage(res, "Failed to save album to board"));
            }

            const data = await res.json();
            setIsSaved(true);
            if (!wasSaved) {
                setAlbumSocial((currentSocial) => ({
                    ...currentSocial,
                    savedCount: (Number(currentSocial.savedCount) || 0) + 1,
                }));
            }
            if (data.board?._id) {
                setSavedBoardIds((currentIds) => [...new Set([...currentIds, String(data.board._id)])]);
            }
            setBoardSaveMessage(`Saved to ${data.board?.title || "board"}.`);
            await fetchBoards();
        } catch (error) {
            console.error(error);
            setBoardSaveMessage(error.message || "Could not save to that board.");
        } finally {
            setIsSavingBoard(false);
        }
    }

    async function createBoardAndSave(event) {
        event.preventDefault();

        if (!canUseAuthenticatedActions) {
            return;
        }

        const title = newBoardTitle.trim();

        if (!title || isSavingBoard) {
            return;
        }

        try {
            setIsSavingBoard(true);
            const token = await getToken();
            const createResponse = await fetch(`${API_BASE_URL}/boards`, {
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

    const renderSignInAction = (label, icon = null) => (
        <SignInButton mode="modal">
            <button className="album-side-action" type="button">
                {icon && <span aria-hidden="true">{icon}</span>}
                {label}
            </button>
        </SignInButton>
    );

    const getSocialInitial = (user) => {
        const username = String(user.username || "").trim();
        return username ? username.charAt(0).toUpperCase() : "?";
    };

    const renderSocialUser = (user) => (
        <Link className="album-social-user" key={user.userId} to={`/profile/${encodeURIComponent(user.userId)}`}>
            <span className="album-social-avatar" aria-hidden="true">
                {user.imageUrl ? <img src={user.imageUrl} alt="" /> : getSocialInitial(user)}
            </span>
            <span>{user.username || "rescened user"}</span>
        </Link>
    );

    const renderSocialSection = ({ id: sectionId, title, users }) => {
        if (users.length === 0) {
            return null;
        }

        const isExpanded = Boolean(expandedSocialSections[sectionId]);
        const visibleUsers = isExpanded ? users : users.slice(0, 3);
        const hiddenCount = users.length - visibleUsers.length;

        return (
            <div className="album-social-section" key={sectionId}>
                <div className="album-social-section-header">
                    <span>{title}</span>
                    <strong>{users.length}</strong>
                </div>
                <div className="album-social-users">
                    {visibleUsers.map(renderSocialUser)}
                </div>
                {users.length > 3 && (
                    <button
                        className="album-social-toggle"
                        type="button"
                        onClick={() => setExpandedSocialSections((currentSections) => ({
                            ...currentSections,
                            [sectionId]: !isExpanded,
                        }))}
                    >
                        {isExpanded ? "Show less" : `Show ${hiddenCount} more`}
                    </button>
                )}
            </div>
        );
    };

    const socialSections = [
        {
            id: "reviewers",
            title: "Reviewed by people you follow",
            users: albumSocial.followedReviewers,
        },
        {
            id: "likers",
            title: "Liked by people you follow",
            users: albumSocial.followedAlbumLikers,
        },
    ];
    const hasAlbumSocialConnections = socialSections.some((section) => section.users.length > 0);



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
                        {canUseAuthenticatedActions ? (
                            <button className="album-side-action" disabled={isSaved || isBoardStateLoading} onClick={handleSaveToCollection}>
                                <span aria-hidden="true">+</span>
                                {isBoardStateLoading ? "Checking..." : isSaved ? "Saved" : "Save"}
                            </button>
                        ) : renderSignInAction("Save", "+")}
                        {canUseAuthenticatedActions ? (
                            <button className="album-side-action" type="button" onClick={openBoardModal} disabled={isBoardStateLoading}>
                                Boards...
                            </button>
                        ) : renderSignInAction("Boards...")}
                        <div className="album-side-action album-like-action">
                            <LikeButton
                                liked={albumLike.likedByViewer}
                                count={albumLike.likeCount}
                                label="album"
                                message={likeMessage}
                                onToggle={toggleAlbumLike}
                            />
                        </div>
                        {canUseAuthenticatedActions ? (
                            <button className="album-side-action" type="button" onClick={() => {
                                setReviewActionMessage("");
                                setIsReviewModalOpen(true);
                            }}>
                                <span aria-hidden="true">★</span>
                                Rate
                            </button>
                        ) : renderSignInAction("Rate", "★")}
                        {canUseAuthenticatedActions ? (
                            <button className="album-side-action" type="button" onClick={() => {
                                setReviewActionMessage("");
                                setIsReviewModalOpen(true);
                            }}>
                                Review or log...
                            </button>
                        ) : renderSignInAction("Review or log...")}
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
                        {boardSaveMessage && <p className="board-save-message">{boardSaveMessage}</p>}
                    </div>

                    <div className="album-ratings-panel">
                        <div className="album-panel-header">
                            <span>Community</span>
                            <span>{socialReviewCount} review{socialReviewCount === 1 ? "" : "s"}</span>
                        </div>
                        <div className="album-social-stats">
                            <div>
                                <strong>{socialSavedCount}</strong>
                                <span>saved</span>
                            </div>
                            <div>
                                <strong>{socialReviewCount}</strong>
                                <span>reviewed</span>
                            </div>
                        </div>
                        <div className="album-rating-summary">
                            <div className="album-rating-bars" role="list" aria-label="Community rating distribution">
                                {ratingDistribution.map((bucket) => (
                                    <div
                                        className="album-rating-bucket"
                                        key={bucket.rating}
                                        role="listitem"
                                        aria-label={`${bucket.count} review${bucket.count === 1 ? "" : "s"} rated ${bucket.rating} stars`}
                                        title={`${bucket.rating} stars: ${bucket.count}`}
                                    >
                                        <span className="album-rating-count">{bucket.count}</span>
                                        <span
                                            className="album-rating-bar"
                                            style={{
                                                "--bar-height": maxRatingBucketCount
                                                    ? `${Math.max((bucket.count / maxRatingBucketCount) * 48, bucket.count > 0 ? 4 : 0)}px`
                                                    : "0px",
                                            }}
                                        />
                                        <span className="album-rating-label">{bucket.rating}</span>
                                    </div>
                                ))}
                            </div>
                            <strong>{averageRating || "--"}</strong>
                        </div>
                    </div>

                    {hasAlbumSocialConnections && (
                        <div className="album-social-panel">
                            {socialSections.map(renderSocialSection)}
                        </div>
                    )}
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
                                        <p className="album-empty-copy">
                                            {album.isPartial
                                                ? "Track details are temporarily unavailable."
                                                : "No tracks available."}
                                        </p>
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
                                onToggleReviewLike={toggleReviewLike}
                                likeMessage={likeMessage}
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
                                    onToggleReviewLike={toggleReviewLike}
                                    likeMessage={likeMessage}
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
                                    onToggleReviewLike={toggleReviewLike}
                                    likeMessage={likeMessage}
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
                        {reviewActionMessage && <p className="review-action-message">{reviewActionMessage}</p>}
                        <ReviewForm album={album} onAddReview={addReview} onSubmitted={() => {
                            setReviewActionMessage("");
                            setIsReviewModalOpen(false);
                        }} />
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
