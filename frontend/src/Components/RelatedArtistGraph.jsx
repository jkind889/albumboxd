import {
  memo,
  useCallback,
  useMemo,
  useSyncExternalStore,
} from "react";
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
} from "@xyflow/react";
import { Link } from "react-router-dom";
import { buildRelatedArtistGraph } from "../utils/relatedArtistGraph";
import "@xyflow/react/dist/style.css";

const COMPACT_GRAPH_QUERY = "(max-width: 980px)";

function formatSimilarity(value) {
  const weight = Number(value);

  if (!Number.isFinite(weight)) {
    return "--";
  }

  return `${Math.round(Math.min(Math.max(weight, 0), 1) * 100)}%`;
}

function formatEvidenceType(type) {
  if (type === "album_credit") {
    return "Album credit";
  }

  if (type === "same_track") {
    return "Shared track";
  }

  return String(type || "Collaboration").replaceAll("_", " ");
}

function subscribeToCompactGraph(onStoreChange) {
  const mediaQuery = window.matchMedia(COMPACT_GRAPH_QUERY);
  mediaQuery.addEventListener("change", onStoreChange);

  return () => mediaQuery.removeEventListener("change", onStoreChange);
}

function getCompactGraphSnapshot() {
  return window.matchMedia(COMPACT_GRAPH_QUERY).matches;
}

function getCompactGraphServerSnapshot() {
  return false;
}

function useCompactGraph() {
  return useSyncExternalStore(
    subscribeToCompactGraph,
    getCompactGraphSnapshot,
    getCompactGraphServerSnapshot,
  );
}

function ArtistHandles() {
  return (
    <>
      <Handle className="explore-related-handle" id="target-top" type="target" position={Position.Top} />
      <Handle className="explore-related-handle" id="target-right" type="target" position={Position.Right} />
      <Handle className="explore-related-handle" id="target-bottom" type="target" position={Position.Bottom} />
      <Handle className="explore-related-handle" id="target-left" type="target" position={Position.Left} />
      <Handle className="explore-related-handle" id="source-top" type="source" position={Position.Top} />
      <Handle className="explore-related-handle" id="source-right" type="source" position={Position.Right} />
      <Handle className="explore-related-handle" id="source-bottom" type="source" position={Position.Bottom} />
      <Handle className="explore-related-handle" id="source-left" type="source" position={Position.Left} />
    </>
  );
}

const RelatedArtistNode = memo(function RelatedArtistNode({ data }) {
  const isSeed = data.kind === "seed";
  const hasSpotifyMapping = Boolean(data.spotifyId);
  const spotifyUrl = data.spotifyUrl
    || (data.spotifyId ? `https://open.spotify.com/artist/${data.spotifyId}` : "");
  const musicBrainzUrl = data.musicBrainzId
    ? `https://musicbrainz.org/artist/${data.musicBrainzId}`
    : "";
  const nodeClassName = [
    "explore-related-artist-node",
    isSeed ? "explore-related-artist-node-seed" : "",
    !isSeed && hasSpotifyMapping ? "explore-related-artist-node-mapped" : "",
    !isSeed && !hasSpotifyMapping ? "explore-related-artist-node-mbid" : "",
    data.selected ? "explore-related-artist-node-selected" : "",
  ].filter(Boolean).join(" ");

  return (
    <article
      className={nodeClassName}
      style={{ "--relationship-strength": data.weight }}
      aria-label={isSeed
        ? `${data.label}, current seed artist`
        : `${data.label}, ${formatSimilarity(data.weight)} similarity${data.selected ? ", selected" : ""}`}
    >
      <ArtistHandles />
      <div className="explore-related-node-heading">
        <span>{isSeed ? "Seed" : `#${data.rank}`}</span>
        {!isSeed ? <em>{formatSimilarity(data.weight)}</em> : null}
      </div>
      <strong title={data.label}>{data.label}</strong>
      {!isSeed && data.comment ? <p title={data.comment}>{data.comment}</p> : null}
      <span className="explore-related-node-meter" aria-hidden="true">
        <i />
      </span>
      <div className="explore-related-node-actions">
        {!isSeed && hasSpotifyMapping ? (
          <button
            className="nodrag nopan"
            type="button"
            aria-label={data.selected
              ? `Collapse collaboration albums for ${data.label}`
              : `Inspect collaboration albums for ${data.label}`}
            aria-pressed={Boolean(data.selected)}
            onClick={(event) => {
              event.stopPropagation();
              data.onSelectArtist?.({
                spotifyId: data.spotifyId,
                name: data.label,
              });
            }}
          >
            Albums
          </button>
        ) : null}
        {!isSeed && hasSpotifyMapping ? (
          <button
            className="nodrag nopan"
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              data.onExploreArtist?.({
                spotifyId: data.spotifyId,
                name: data.label,
              });
            }}
          >
            Explore as seed
          </button>
        ) : null}
        {spotifyUrl ? (
          <a
            className="nodrag nopan"
            href={spotifyUrl}
            target="_blank"
            rel="noreferrer"
            onClick={(event) => event.stopPropagation()}
          >
            Spotify
          </a>
        ) : musicBrainzUrl ? (
          <a
            className="nodrag nopan"
            href={musicBrainzUrl}
            target="_blank"
            rel="noreferrer"
            onClick={(event) => event.stopPropagation()}
          >
            MusicBrainz
          </a>
        ) : null}
        {!isSeed && !hasSpotifyMapping ? <span>MBID only</span> : null}
      </div>
    </article>
  );
});

const CollaborationAlbumNode = memo(function CollaborationAlbumNode({ data }) {
  const evidenceTypes = Array.isArray(data.evidenceTypes) ? data.evidenceTypes : [];
  const sharedTracks = Array.isArray(data.sharedTracks) ? data.sharedTracks : [];
  const visibleTracks = sharedTracks.slice(0, 3);

  return (
    <article
      className="explore-collaboration-album-node"
      aria-label={`${data.title}, collaboration album`}
    >
      <ArtistHandles />
      <Link
        className="nodrag nopan"
        to={`/album/${data.spotifyId}`}
        onClick={(event) => event.stopPropagation()}
      >
        {data.cover ? (
          <img
            className="explore-collaboration-album-cover"
            src={data.cover}
            alt=""
          />
        ) : (
          <span className="explore-collaboration-album-cover-fallback" aria-hidden="true">
            ♪
          </span>
        )}

        <span className="explore-collaboration-album-heading">
          <small>Collaboration album</small>
          {data.year ? <time>{data.year}</time> : null}
        </span>
        <strong title={data.title}>{data.title}</strong>

        {evidenceTypes.length > 0 ? (
          <span className="explore-collaboration-album-badges" aria-label="Collaboration evidence">
            {evidenceTypes.map((type) => (
              <span className="explore-collaboration-album-badge" key={type}>
                {formatEvidenceType(type)}
              </span>
            ))}
          </span>
        ) : null}

        {visibleTracks.length > 0 ? (
          <ul className="explore-collaboration-album-tracks" aria-label="Matching tracks">
            {visibleTracks.map((track) => (
              <li key={track.spotifyId || `${track.discNumber || 0}:${track.trackNumber || 0}:${track.title}`}>
                {track.title}
              </li>
            ))}
            {sharedTracks.length > visibleTracks.length ? (
              <li>+{sharedTracks.length - visibleTracks.length} more</li>
            ) : null}
          </ul>
        ) : null}
      </Link>
    </article>
  );
});

const nodeTypes = {
  relatedArtistNode: RelatedArtistNode,
  collaborationAlbumNode: CollaborationAlbumNode,
};

function getGraphSummary({
  neighborCount,
  selectedArtistName,
  collaborationStatus,
  albumCount,
}) {
  if (!selectedArtistName) {
    return `${neighborCount} related artist${neighborCount === 1 ? "" : "s"}. Select a Spotify-mapped artist to inspect locally cached collaboration albums, or use Explore as seed to move through the graph.`;
  }

  if (collaborationStatus === "loading") {
    return `Checking the local album catalog for credits shared with ${selectedArtistName}…`;
  }

  if (collaborationStatus === "error") {
    return `Collaboration evidence for ${selectedArtistName} could not be loaded. The artist graph remains available.`;
  }

  if (collaborationStatus === "success") {
    return albumCount > 0
      ? `${albumCount} locally cached collaboration album${albumCount === 1 ? "" : "s"} shown for ${selectedArtistName}.`
      : `No local collaboration album is currently shown for ${selectedArtistName}. Local coverage is incomplete.`;
  }

  return `${selectedArtistName} is selected. Local collaboration evidence will appear when it is ready.`;
}

export function RelatedArtistGraph({
  payload,
  selectedSpotifyArtistId = "",
  collaborationAlbums = [],
  collaborationStatus = "idle",
  onSelectArtist,
  onExploreArtist,
}) {
  const compact = useCompactGraph();
  const graph = useMemo(
    () => buildRelatedArtistGraph(payload, {
      compact,
      selectedSpotifyArtistId,
      collaborationAlbums,
    }),
    [collaborationAlbums, compact, payload, selectedSpotifyArtistId],
  );
  const nodes = useMemo(
    () => graph.nodes.map((node) => (
      node.data.kind === "neighbor"
        ? {
            ...node,
            data: {
              ...node.data,
              onSelectArtist,
              onExploreArtist,
            },
          }
        : node
    )),
    [graph.nodes, onExploreArtist, onSelectArtist],
  );
  const seedName = payload?.seed?.name || "Unknown artist";
  const neighborCount = graph.nodes.filter((node) => node.data.kind === "neighbor").length;
  const albumCount = compact
    ? Math.min(new Set(
        collaborationAlbums
          .map((album) => String(album?.spotifyId || "").trim())
          .filter(Boolean),
      ).size, 3)
    : graph.nodes.filter((node) => node.data.kind === "collaborationAlbum").length;
  const selectedArtistName = graph.nodes.find((node) => node.data.selected)?.data.label || "";
  const compactRowCount = Math.max(Math.ceil(neighborCount / 2), 1);
  const compactHeight = Math.max(430, 334 + ((compactRowCount - 1) * 150));
  const albumNodeKey = graph.nodes
    .filter((node) => node.data.kind === "collaborationAlbum")
    .map((node) => node.id)
    .join(",");
  const graphKey = [
    payload?.seed?.musicBrainzId || payload?.seed?.spotifyId || "seed",
    compact ? "compact" : "radial",
    selectedSpotifyArtistId || "none",
    albumNodeKey,
  ].join(":");
  const handleNodeClick = useCallback((event, node) => {
    if (event.button !== 0 || node.data.kind !== "neighbor" || !node.data.spotifyId) {
      return;
    }

    onSelectArtist?.({
      spotifyId: node.data.spotifyId,
      name: node.data.label,
    });
  }, [onSelectArtist]);
  const graphSummary = getGraphSummary({
    neighborCount,
    selectedArtistName,
    collaborationStatus,
    albumCount,
  });

  return (
    <section className="explore-relationship-map" aria-labelledby="explore-relationship-map-title">
      <header className="explore-relationship-map-header">
        <div>
          <p>Relationship map</p>
          <h2 id="explore-relationship-map-title">{seedName}</h2>
        </div>
        <div className="explore-graph-legend" aria-label="Graph legend">
          <span><i className="explore-legend-line explore-legend-line-strong" />More similar</span>
          <span><i className="explore-legend-line explore-legend-line-light" />Less similar</span>
          {!compact ? (
            <span><i className="explore-legend-line explore-legend-line-collaboration" />Collaboration credit</span>
          ) : null}
          <span><b />Spotify-mapped</span>
          <span><b className="explore-legend-mbid" />MBID only</span>
        </div>
      </header>

      <p className="explore-graph-summary" aria-live="polite">
        {graphSummary}
      </p>

      <div
        className={`explore-relationship-flow${compact ? " explore-relationship-flow-compact" : ""}`}
        style={compact ? { "--compact-graph-height": `${compactHeight}px` } : undefined}
      >
        <ReactFlow
          key={graphKey}
          nodes={nodes}
          edges={graph.edges}
          nodeTypes={nodeTypes}
          colorMode="dark"
          fitView
          fitViewOptions={{ padding: compact ? 0.06 : 0.14, maxZoom: 1 }}
          minZoom={0.28}
          maxZoom={1.5}
          nodesDraggable={false}
          nodesConnectable={false}
          nodesFocusable={false}
          edgesFocusable={false}
          elementsSelectable={false}
          deleteKeyCode={null}
          disableKeyboardA11y
          onNodeClick={handleNodeClick}
          panOnDrag={!compact}
          panOnScroll={false}
          preventScrolling={false}
          zoomOnDoubleClick={!compact}
          zoomOnPinch={!compact}
          zoomOnScroll={false}
        >
          <Background color="#29242e" gap={28} size={1} />
          {!compact ? <Controls showInteractive={false} /> : null}
        </ReactFlow>
      </div>
    </section>
  );
}

export default RelatedArtistGraph;
