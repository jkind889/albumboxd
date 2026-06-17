import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import AsyncState from "../Components/Loading/AsyncState";

const CATALOG_PAGE_LIMIT = 24;

export function Albums() {
  const [albums, setAlbums] = useState([]);
  const [totalAlbums, setTotalAlbums] = useState(0);
  const [hasNextPage, setHasNextPage] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const listRef = useRef(null);
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const query = searchParams.get("q") || "";
  const page = Math.max(Number.parseInt(searchParams.get("page") || "1", 10) || 1, 1);

  useEffect(() => {
    let shouldIgnore = false;

    async function fetchCatalog() {
      try {
        setLoading(true);
        setError("");

        const catalogParams = new URLSearchParams({
          page: String(page),
          limit: String(CATALOG_PAGE_LIMIT),
        });
        const trimmedQuery = query.trim();

        if (trimmedQuery) {
          catalogParams.set("q", trimmedQuery);
        }

        const response = await fetch(`http://localhost:3000/albums/catalog?${catalogParams.toString()}`);

        if (!response.ok) {
          throw new Error("Catalog request failed");
        }

        const data = await response.json();
        const results = Array.isArray(data) ? data : data.results;

        if (!shouldIgnore) {
          setAlbums(Array.isArray(results) ? results : []);
          setTotalAlbums(Number(data?.total) || 0);
          setHasNextPage(Boolean(data?.hasNextPage));
        }
      } catch {
        if (!shouldIgnore) {
          setError("Unable to load the album catalog.");
          setAlbums([]);
          setTotalAlbums(0);
          setHasNextPage(false);
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
  }, [page, query]);

  function updateQuery(nextQuery) {
    const nextParams = new URLSearchParams(searchParams);
    const trimmedQuery = nextQuery.trim();

    if (trimmedQuery) {
      nextParams.set("q", nextQuery);
    } else {
      nextParams.delete("q");
    }

    nextParams.set("page", "1");
    setSearchParams(nextParams);
  }

  function updatePage(nextPage) {
    const nextParams = new URLSearchParams(searchParams);

    nextParams.set("page", String(nextPage));
    setSearchParams(nextParams);
  }

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
  }, [albums]);

  const catalogSummary = loading
    ? "Loading albums..."
    : query.trim()
      ? `${totalAlbums} matching album${totalAlbums === 1 ? "" : "s"}`
      : `${albums.length} of ${totalAlbums} albums`;

  return (
    <section className="catalog-page">
      <div className="catalog-header">
        <p className="catalog-kicker">Album catalog</p>
        <h1>Albums</h1>
        <p>{catalogSummary} · Page {page}</p>
      </div>

      <div className="catalog-toolbar">
        <label className="catalog-search-label" htmlFor="catalog-search">
          Search album catalog
        </label>
        <div className="catalog-search-wrap">
          <input
            id="catalog-search"
            className="catalog-search-input"
            value={query}
            onChange={(event) => updateQuery(event.target.value)}
            placeholder="Search by album, artist, year, or label"
          />
          <span className="catalog-count">
            {loading ? "Loading" : `${albums.length} shown`}
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

        <AsyncState
          isLoading={loading}
          error={error}
          isEmpty={!loading && !error && albums.length === 0}
          loadingVariant="list"
          loadingMessage="Loading album catalog"
          errorTitle="Catalog unavailable"
          emptyTitle="No albums matched that search."
        >
          {albums.map((album, albumIndex) => (
            <button
              className="catalog-row"
              type="button"
              key={album.id}
              style={{ "--catalog-row-index": albumIndex }}
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
        </AsyncState>
      </div>

      {(page > 1 || hasNextPage) && (
        <div className="search-pagination catalog-pagination" aria-label="Album catalog pagination">
          <button
            type="button"
            disabled={loading || page <= 1}
            onClick={() => updatePage(page - 1)}
          >
            Previous
          </button>
          <span>Page {page}</span>
          <button
            type="button"
            disabled={loading || !hasNextPage}
            onClick={() => updatePage(page + 1)}
          >
            Next
          </button>
        </div>
      )}
    </section>
  );
}

export default Albums;
