import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

export function Albums() {
  const [albums, setAlbums] = useState([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const listRef = useRef(null);
  const navigate = useNavigate();

  useEffect(() => {
    let shouldIgnore = false;

    async function fetchCatalog() {
      try {
        const response = await fetch("http://localhost:3000/albums/catalog");

        if (!response.ok) {
          throw new Error("Catalog request failed");
        }

        const data = await response.json();

        if (!shouldIgnore) {
          setAlbums(Array.isArray(data) ? data : []);
        }
      } catch {
        if (!shouldIgnore) {
          setError("Unable to load the album catalog.");
          setAlbums([]);
        }
      } finally {
        if (!shouldIgnore) {
          setLoading(false);
        }
      }
    }

    fetchCatalog();

    return () => {
      shouldIgnore = true;
    };
  }, []);

  const filteredAlbums = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    if (!normalizedQuery) {
      return albums;
    }

    return albums.filter((album) => {
      const searchableText = [
        album.title,
        album.artist,
        ...(album.artists || []),
        album.year,
        album.label,
      ].join(" ").toLowerCase();

      return searchableText.includes(normalizedQuery);
    });
  }, [albums, query]);

  useEffect(() => {
    const rows = listRef.current?.querySelectorAll(".catalog-row");

    if (!rows?.length) {
      return undefined;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
            observer.unobserve(entry.target);
          }
        });
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.08 },
    );

    rows.forEach((row) => observer.observe(row));

    return () => observer.disconnect();
  }, [filteredAlbums]);

  return (
    <section className="catalog-page">
      <div className="catalog-toolbar">
        <label className="catalog-search-label" htmlFor="catalog-search">
          Search album catalog
        </label>
        <div className="catalog-search-wrap">
          <input
            id="catalog-search"
            className="catalog-search-input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search by album, artist, year, or label"
          />
          <span className="catalog-count">
            {loading
              ? "Loading"
              : `${filteredAlbums.length} / ${albums.length}`}
          </span>
        </div>
      </div>

      <div className="catalog-list" ref={listRef}>
        <div className="catalog-header-row" aria-hidden="true">
          <span>Album</span>
          <span>Artist</span>
          <span>Year</span>
          <span>Tracks</span>
        </div>

        {filteredAlbums.map((album) => (
          <button
            className="catalog-row"
            type="button"
            key={album.id}
            onClick={() => navigate(`/album/${album.id}`)}
          >
            <span className="catalog-cell catalog-album-cell">
              <img
                className="catalog-cover"
                src={album.cover || album.imgs?.[0]?.url || "/favicon.svg"}
                alt=""
              />
              <span className="catalog-title-wrap">
                <span className="catalog-title">{album.title}</span>
                <span className="catalog-label">{album.label || album.albumType}</span>
              </span>
            </span>
            <span className="catalog-cell">{album.artist}</span>
            <span className="catalog-cell">{album.year || "unknown"}</span>
            <span className="catalog-cell">{album.totalTracks || album.tracks?.length || 0}</span>
          </button>
        ))}

        {!loading && !error && filteredAlbums.length === 0 && (
          <div className="catalog-empty">No albums matched that search.</div>
        )}

        {error && <div className="catalog-empty">{error}</div>}
      </div>
    </section>
  );
}

export default Albums;
