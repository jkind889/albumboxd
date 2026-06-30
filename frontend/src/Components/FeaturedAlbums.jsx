import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { API_BASE_URL } from "../config/api";

function ArrowIcon() {
    return (
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
            <path d="M5 12h13M13 6l6 6-6 6" />
        </svg>
    );
}

export function FeaturedAlbums({ limit = 24 }) {
    const [albums, setAlbums] = useState([]);
    const [activeAlbumId, setActiveAlbumId] = useState("");
    const [status, setStatus] = useState("loading");

    useEffect(() => {
        const controller = new AbortController();

        async function fetchCatalogAlbums() {
            try {
                setStatus("loading");
                const params = new URLSearchParams({
                    page: "1",
                    limit: String(limit),
                });
                const response = await fetch(`${API_BASE_URL}/albums/catalog?${params.toString()}`, {
                    signal: controller.signal,
                });

                if (!response.ok) {
                    throw new Error("Catalog request failed");
                }

                const data = await response.json();
                const results = Array.isArray(data) ? data : data.results;
                const nextAlbums = Array.isArray(results) ? results : [];

                setAlbums(nextAlbums);
                setActiveAlbumId(nextAlbums[2]?.id || nextAlbums[0]?.id || "");
                setStatus(nextAlbums.length ? "ready" : "empty");
            } catch (error) {
                if (error.name !== "AbortError") {
                    setAlbums([]);
                    setStatus("error");
                }
            }
        }

        fetchCatalogAlbums();

        return () => controller.abort();
    }, [limit]);

    return (
        <aside className="featured-catalog" aria-labelledby="featured-catalog-title">
            <div className="featured-catalog-heading">
                <p id="featured-catalog-title">Album catalog</p>
                <span>{albums.length ? String(albums.length).padStart(2, "0") : "—"}</span>
            </div>

            <div className="featured-catalog-list">
                {status === "loading" && (
                    <div className="featured-catalog-message">Reading the catalog…</div>
                )}

                {status === "error" && (
                    <div className="featured-catalog-message">The catalog is temporarily unavailable.</div>
                )}

                {status === "empty" && (
                    <div className="featured-catalog-message">No albums have been cataloged yet.</div>
                )}

                {albums.map((album) => {
                    const isActive = album.id === activeAlbumId;

                    return (
                        <Link
                            className={`featured-catalog-row${isActive ? " is-active" : ""}`}
                            key={album.id}
                            to={`/album/${album.id}`}
                            onMouseEnter={() => setActiveAlbumId(album.id)}
                            onFocus={() => setActiveAlbumId(album.id)}
                        >
                            <span className="featured-catalog-copy">
                                <strong>{album.title}</strong>
                                <small>{album.artist}</small>
                            </span>
                            <span className="featured-catalog-year">{album.year || "—"}</span>
                            <span className="featured-catalog-arrow">
                                <ArrowIcon />
                            </span>
                        </Link>
                    );
                })}
            </div>
        </aside>
    );
}

export default FeaturedAlbums;
