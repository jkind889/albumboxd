import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

export function NewOnAlbumboxd({ limit = 6 }) {
    const [albums, setAlbums] = useState([]);
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        let isMounted = true;

        async function fetchRecentAlbums() {
            setIsLoading(true);

            try {
                const params = new URLSearchParams({ limit: String(limit) });
                const res = await fetch(`http://localhost:3000/reviews/recent-albums?${params.toString()}`);

                if (!res.ok) {
                    setAlbums([]);
                    return;
                }

                const data = await res.json();

                if (isMounted) {
                    setAlbums(Array.isArray(data) ? data : []);
                }
            } catch (error) {
                console.error("Failed to fetch recent reviewed albums", error);

                if (isMounted) {
                    setAlbums([]);
                }
            } finally {
                if (isMounted) {
                    setIsLoading(false);
                }
            }
        }

        fetchRecentAlbums();

        return () => {
            isMounted = false;
        };
    }, [limit]);

    if (isLoading) {
        return <p className="front-empty-state">Loading new albums...</p>;
    }

    if (!albums.length) {
        return <p className="front-empty-state">No reviewed albums yet.</p>;
    }

    return (
        <div className="front-album-strip">
            {albums.map((album) => (
                <Link className="front-album-card" key={album.spotifyId} to={`/album/${album.spotifyId}`}>
                    {album.cover ? (
                        <img src={album.cover} alt={`${album.title} cover`} />
                    ) : (
                        <span className="front-album-cover-fallback">No cover</span>
                    )}
                    <span>{album.title}</span>
                    <small>{album.artist}</small>
                </Link>
            ))}
        </div>
    );
}

export default NewOnAlbumboxd;
