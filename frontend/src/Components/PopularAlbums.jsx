import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

export function PopularAlbums({ limit = 5, window = "30d" }) {
    const [albums, setAlbums] = useState([]);
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        let isMounted = true;

        async function fetchPopularAlbums() {
            setIsLoading(true);

            try {
                const params = new URLSearchParams({
                    limit: String(limit),
                    window,
                });
                const res = await fetch(`http://localhost:3000/reviews/popular?${params.toString()}`);

                if (!res.ok) {
                    setAlbums([]);
                    return;
                }

                const data = await res.json();

                if (isMounted) {
                    setAlbums(Array.isArray(data) ? data : []);
                }
            } catch (error) {
                console.error("Failed to fetch popular albums", error);

                if (isMounted) {
                    setAlbums([]);
                }
            } finally {
                if (isMounted) {
                    setIsLoading(false);
                }
            }
        }

        fetchPopularAlbums();

        return () => {
            isMounted = false;
        };
    }, [limit, window]);

    if (isLoading) {
        return <p className="popular-albums-empty">Loading popular albums...</p>;
    }

    if (!albums.length) {
        return <p className="popular-albums-empty">No popular albums yet.</p>;
    }

    return (
        <div className="popular-albums-grid">
            {albums.map((album, index) => (
                <Link
                    key={album.spotifyId}
                    className="popular-album-card"
                    to={`/album/${album.spotifyId}`}
                >
                    <span className="popular-album-rank">{index + 1}</span>
                    {album.cover ? (
                        <img
                            className="popular-album-cover"
                            src={album.cover}
                            alt={`${album.title} cover`}
                        />
                    ) : (
                        <div className="popular-album-cover popular-album-cover-fallback">
                            No cover
                        </div>
                    )}
                    <div className="popular-album-info">
                        <h4>{album.title}</h4>
                        <p>{album.artist}</p>
                    </div>
                </Link>
            ))}
        </div>
    );
}

export default PopularAlbums;
