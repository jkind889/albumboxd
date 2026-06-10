import {useParams} from "react-router-dom";
import {useState, useEffect } from "react";
import ReviewForm from "./ReviewForm";
import ReviewList from "./ReviewList";
import { useAuth } from "@clerk/react";
export function AlbumDetail()
{
    const {id} = useParams();
    const [album, setAlbum] = useState(null);
    const [reviews, setReviews] = useState([]);
    const [isSaved, setIsSaved] = useState(false);
    const { getToken } = useAuth();

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
            `http://localhost:3000/collections/collection/${id}`,
            {
                headers: {
                Authorization: `Bearer ${token}`,
                },
            }
            );

            if (!res.ok) {
                setIsSaved(false);
                return;
            }

            const data = await res.json();
            setIsSaved(data.saved);
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
            return;
        }

        const newReview = await res.json();
        console.log("Review saved to server:", newReview);
        setReviews((prev) => [newReview, ...prev]);

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
    const averageRating = reviews.length
        ? (reviews.reduce((total, item) => total + (Number(item.rating) || 0), 0) / reviews.length).toFixed(1)
        : null;
    const albumArt = album.imgs?.[0]?.url;
    const accentStyle = albumArt
        ? {
            "--album-cover": `url(${albumArt})`
          }
        : undefined;
    const releaseDateLabel = album.releaseDate
        ? new Date(`${album.releaseDate}T00:00:00`).toLocaleDateString(undefined, {
            year: "numeric",
            month: "long",
            day: album.releaseDate.length > 7 ? "numeric" : undefined
          })
        : null;

// users can keep saving the same album over and over again, need to check if the album already exists in the user's collection before saving
    async function handleSaveToCollection() {
        const token = await getToken();
        

        const res = await fetch("http://localhost:3000/albums/album", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${token}`
            },
            body: JSON.stringify({
                spotifyId: album.id,
                title: album.title,
                artist: artistNames.join(", "),
                cover: albumArt
             }),
        });
        const data = await res.json();

        if (res.status === 409) {
            alert("This album is already in your collection.");
            return;
        }
        
        if (!res.ok) {
            console.error("Failed to save album to collection");
            alert("Failed to save album to collection. Please try again.");
            return;
        }
        if (res.ok) {
            setIsSaved(true);
        }


        console.log("Album saved to collection:", data);
    }



    return (

        <section className="album-detail-page" style={accentStyle}>
            <div className="album-detail-overlay" />
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

                    <div className="album-sidebar-stats">
                        <div>
                            <span className="album-stat-label">Tracks</span>
                            <strong>{album.totalTracks || "--"}</strong>
                        </div>
                        <div>
                            <span className="album-stat-label">Reviews</span>
                            <strong>{reviews.length}</strong>
                        </div>
                        <div>
                            <span className="album-stat-label">Avg.</span>
                            <strong>{averageRating || "--"}</strong>
                        </div>
                    </div>

                    <div className="album-spotify-card">
                        <div className="album-panel-header">
                            <span>Listen on Spotify</span>
                        </div>
                        <p>
                            {album.spotifyUrl
                                ? "Open the album on Spotify."
                                : "Spotify link unavailable for this album."}
                        </p>
                        {album.spotifyUrl && (
                            <a
                                className="album-primary-link"
                                href={album.spotifyUrl}
                                target="_blank"
                                rel="noreferrer"
                            >
                                Open Album
                            </a>
                        )}
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

                    <div className="album-action-row">
                        <button className="album-action-button" disabled={isSaved} onClick={handleSaveToCollection}>
                            {isSaved ? "Saved to Collection" : "Save to Collection"}
                        </button>
                    </div>

                    <div className="album-detail-grid">
                        <section className="album-detail-copy">
                            <div className="album-info-panel">
                                <h2>Details</h2>
                                <dl className="album-facts">
                                    <div>
                                        <dt>Artist</dt>
                                        <dd>{artistNames.join(", ")}</dd>
                                    </div>
                                    <div>
                                        <dt>Release</dt>
                                        <dd>{releaseDateLabel || album.year}</dd>
                                    </div>
                                    <div>
                                        <dt>Format</dt>
                                        <dd>{album.albumType}</dd>
                                    </div>
                                    <div>
                                        <dt>Tracks</dt>
                                        <dd>{album.totalTracks || "Unknown"}</dd>
                                    </div>
                                </dl>
                            </div>

                            {album.genres?.length > 0 && (
                                <div className="album-info-panel">
                                    <h2>Genres</h2>
                                    <div className="album-tag-row">
                                        {album.genres.map((genre) => (
                                            <span className="album-tag" key={genre}>{genre}</span>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </section>

                        <aside className="album-detail-sidepanel">
                            <div className="album-ratings-panel">
                                <div className="album-panel-header">
                                    <span>Ratings</span>
                                    <span>{reviews.length} review{reviews.length === 1 ? "" : "s"}</span>
                                </div>
                                <div className="album-rating-value">{averageRating || "--"}</div>
                                <p>
                                    {averageRating
                                        ? "Community score from saved album reviews."
                                        : "No ratings yet. Add the first review below."}
                                </p>
                            </div>
                        </aside>
                    </div>

                    <section className="album-reviews-section">
                        <ReviewForm album={album} onAddReview={addReview} />
                        <ReviewList reviews={reviews} onRemoveReview={removeReview} />
                    </section>
                </div>
            </div>
        </section>



        // Album Detail component rendered when user clicks on a search result, showing more information about the selected album
    );

}

export default AlbumDetail;
