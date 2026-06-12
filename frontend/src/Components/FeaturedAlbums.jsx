import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

export function FeaturedAlbums({ limit = 5 }) {
    const [albums, setAlbums] = useState([]);

    useEffect(() => {
        let isMounted = true;

        async function fetchFeaturedAlbums() {
            try {
                const params = new URLSearchParams({ limit: String(limit) });
                const res = await fetch(`http://localhost:3000/reviews/featured?${params.toString()}`);

                if (!res.ok) {
                    setAlbums([]);
                    return;
                }

                const data = await res.json();

                if (isMounted) {
                    setAlbums(Array.isArray(data) ? data : []);
                }
            } catch (error) {
                console.error("Failed to fetch featured albums", error);

                if (isMounted) {
                    setAlbums([]);
                }
            }
        }

        fetchFeaturedAlbums();

        return () => {
            isMounted = false;
        };
    }, [limit]);

    if (!albums.length) {
        return null;
    }

    return (
        <div className="featured-albums">
            {albums.map((album) => (
                <Link
                    key={album.spotifyId}
                    className="featured-album"
                    to={`/album/${album.spotifyId}`}
                    title={`${album.artist} - ${album.title}`}
                >
                    <img
                        src={album.cover}
                        alt={`${album.artist} - ${album.title}`}
                        className="featured-album-cover"
                    />
                </Link>
            ))}
        </div>
    );
}

export default FeaturedAlbums;
