import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

export function FeaturedAlbums({ limit = 5 }) {
    const [albums, setAlbums] = useState([]);
    const [activeIndex, setActiveIndex] = useState(0);

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
                    setActiveIndex(0);
                }
            } catch (error) {
                console.error("Failed to fetch featured albums", error);

                if (isMounted) {
                    setAlbums([]);
                    setActiveIndex(0);
                }
            }
        }

        fetchFeaturedAlbums();

        return () => {
            isMounted = false;
        };
    }, [limit]);

    const normalizedActiveIndex = albums.length ? Math.min(activeIndex, albums.length - 1) : 0;
    const visibleAlbums = useMemo(() => {
        if (!albums.length) {
            return [];
        }

        return [-1, 0, 1].map((offset) => {
            const index = (normalizedActiveIndex + offset + albums.length) % albums.length;

            return {
                album: albums[index],
                position: offset,
            };
        });
    }, [normalizedActiveIndex, albums]);

    if (!albums.length) {
        return null;
    }

    const activeAlbum = albums[normalizedActiveIndex] || albums[0];

    const moveCarousel = (step) => {
        setActiveIndex((currentIndex) => (currentIndex + step + albums.length) % albums.length);
    };

    return (
        <div className="featured-carousel" aria-label="Featured albums">
            <button
                type="button"
                className="featured-carousel-control featured-carousel-control-prev"
                onClick={() => moveCarousel(-1)}
                aria-label="Previous featured album"
            >
                &lt;
            </button>

            <div className="featured-carousel-stage">
                {visibleAlbums.map(({ album, position }) => (
                    <Link
                        key={`${album.spotifyId}-${position}`}
                        className={`featured-carousel-panel position-${position}`}
                        to={`/album/${album.spotifyId}`}
                        title={`${album.artist} - ${album.title}`}
                        aria-hidden={position !== 0}
                        tabIndex={position === 0 ? 0 : -1}
                    >
                        <img
                            src={album.cover}
                            alt={`${album.artist} - ${album.title}`}
                            className="featured-carousel-cover"
                        />
                    </Link>
                ))}
            </div>

            <aside className="featured-carousel-info">
                <p className="featured-carousel-kicker">Featured Album</p>
                <h2>{activeAlbum.title}</h2>
                <p>{activeAlbum.artist}</p>
                <div className="featured-carousel-stats">
                    <span>{Number(activeAlbum.averageRating || 0).toFixed(1)} avg</span>
                    <span>{activeAlbum.reviewCount || 0} reviews</span>
                    {activeAlbum.year && <span>{activeAlbum.year}</span>}
                </div>
            </aside>

            <button
                type="button"
                className="featured-carousel-control featured-carousel-control-next"
                onClick={() => moveCarousel(1)}
                aria-label="Next featured album"
            >
                &gt;
            </button>
        </div>
    );
}

export default FeaturedAlbums;
