import {useParams} from "react-router-dom";
import { useMemo, useState, useEffect } from "react";
import ReviewForm from "./ReviewForm";
import ReviewList from "./ReviewList";
    
export function AlbumDetail()
{
    const {id} = useParams();
    const [album, setAlbum] = useState(null);
    const [reviewVersion, setReviewVersion] = useState(0);
    const review = useMemo(() => {
        void reviewVersion;
        const stored = JSON.parse(localStorage.getItem("reviews")) || [];
        return stored.filter((r) => r.albumId === id);
    }, [id, reviewVersion]);

    useEffect(() => {
        // Fetch album details from the backend API
        // Use the album ID from the URL parameters
        fetch(`http://localhost:3000/albums/album/${id}`)
        .then(res => res.json())
        .then(data => setAlbum(data))
    }, [id])

    const addReview = (review) => {
        const stored = JSON.parse(localStorage.getItem("reviews")) || [];
        const updated = [review, ...stored]

        localStorage.setItem("reviews", JSON.stringify(updated));
        setReviewVersion((version) => version + 1);

    };

     const removeReview= (date) => {
        const stored = JSON.parse(localStorage.getItem("reviews")) || [];
        const updated = stored.filter((r) => r.date !== date);
        localStorage.setItem("reviews", JSON.stringify(updated));

        setReviewVersion((version) => version + 1);
    }


     if (!album) return <p>Loading...</p>;

    const artistNames = album.artists?.length ? album.artists : [album.artist];
    const averageRating = review.length
        ? (review.reduce((total, item) => total + (Number(item.rating) || 0), 0) / review.length).toFixed(1)
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

    const saveAlbum = () => {
        // Save the album to localStorage for the collection page
        const saved = JSON.parse(localStorage.getItem("savedAlbums")) || [];

        // if the album exists we can alert the user and return early
        const exists= saved.some(a => a.id === album.id);
        if (exists) {
            alert("Album already saved in collection");
            return;
        }
        // push the album into the saved array and save it back to localStorage
        saved.push(album)
        console.log(saved);
        // Save the updated array back to localStorage
        localStorage.setItem("savedAlbums", JSON.stringify(saved));

    };




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
                            <strong>{review.length}</strong>
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
                        <button className="album-action-button" onClick={saveAlbum}>
                            Save to Collection
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
                                    <span>{review.length} review{review.length === 1 ? "" : "s"}</span>
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
                        <ReviewList reviews={review} onRemoveReview={removeReview} />
                    </section>
                </div>
            </div>
        </section>



        // Album Detail component rendered when user clicks on a search result, showing more information about the selected album
    );

}

export default AlbumDetail;
