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
  ].filter(Boolean).join(" ");

  return (
    <article
      className={nodeClassName}
      style={{ "--relationship-strength": data.weight }}
      aria-label={isSeed
        ? `${data.label}, current seed artist`
        : `${data.label}, ${formatSimilarity(data.weight)} similarity`}
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
          <button className="nodrag nopan" type="button">
            Explore
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

const nodeTypes = {
  relatedArtistNode: RelatedArtistNode,
};

export function RelatedArtistGraph({ payload, onExploreArtist }) {
  const compact = useCompactGraph();
  const graph = useMemo(
    () => buildRelatedArtistGraph(payload, { compact }),
    [compact, payload],
  );
  const seedName = payload?.seed?.name || "Unknown artist";
  const neighborCount = Math.max(graph.nodes.length - 1, 0);
  const compactRowCount = Math.max(Math.ceil(neighborCount / 2), 1);
  const compactHeight = Math.max(430, 334 + ((compactRowCount - 1) * 130));
  const graphKey = `${payload?.seed?.musicBrainzId || payload?.seed?.spotifyId || "seed"}:${compact ? "compact" : "radial"}`;
  const handleNodeClick = useCallback((event, node) => {
    if (event.button !== 0 || node.data.kind !== "neighbor" || !node.data.spotifyId) {
      return;
    }

    onExploreArtist?.({
      spotifyId: node.data.spotifyId,
      name: node.data.label,
    });
  }, [onExploreArtist]);

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
          <span><b />Spotify-mapped</span>
          <span><b className="explore-legend-mbid" />MBID only</span>
        </div>
      </header>

      <p className="explore-graph-summary" aria-live="polite">
        {neighborCount} related artist{neighborCount === 1 ? "" : "s"}. Select Explore on a Spotify-mapped node to make it the new seed.
      </p>

      <div
        className={`explore-relationship-flow${compact ? " explore-relationship-flow-compact" : ""}`}
        style={compact ? { "--compact-graph-height": `${compactHeight}px` } : undefined}
      >
        <ReactFlow
          key={graphKey}
          nodes={graph.nodes}
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
