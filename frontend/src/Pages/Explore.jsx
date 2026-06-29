import { ReactFlow, Background, Controls, Handle, Position } from "@xyflow/react";
import { memo, useState, useCallback, useEffect } from 'react';
import { applyEdgeChanges, applyNodeChanges } from '@xyflow/react';
import { API_BASE_URL } from "../config/api";
import { useSearchParams } from "react-router-dom";     
import AsyncState from "../Components/Loading/AsyncState";
import { getApiErrorMessage } from "../utils/apiErrors";
import { Link } from "react-router-dom";
import "@xyflow/react/dist/style.css";

const AlbumNode = memo(function AlbumNode({ data }) {
  const title = data.title || "Untitled album";
  const artist = data.artist || "Unknown artist";

  return (
    <article className="explore-album-node">
      <Link to={`/album/${data.id}`}>
        <Handle className="explore-node-handle" type="target" position={Position.Top} />
        {data.cover ? (
          <img className="explore-album-cover" src={data.cover} alt={`${title} cover`} />
        ) : (
          <div className="explore-album-cover explore-album-cover-fallback" aria-hidden="true">
            {title.slice(0, 1)}
          </div>
        )}
        <div className="explore-album-copy">
          <strong>{title}</strong>
          <span>{artist}</span>
        </div>
      </Link>
    </article>
  );
});

const ArtistNode = memo(function ArtistNode({ data }) {
  return (
    <div className="explore-artist-node">
      <span>{data.label}</span>
      <Handle className="explore-node-handle" type="source" position={Position.Bottom} />
    </div>
  );
});

const nodeTypes = {
  albumNode: AlbumNode,
  artistNode: ArtistNode,
};

export default function Explore() {
  const [searchresults, setResults] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [hasNextPage, setHasNextPage] = useState(false)
  const [nodes, setNodes] = useState([])
  const [edges, setEdges] = useState([])
  const [searchParams,setSearchParams] = useSearchParams();
  const query = searchParams.get("q") || "";
  const page = Math.max(Number.parseInt(searchParams.get("page") || "1", 10) || 1, 1);
    useEffect(() =>{
      let shouldIgnore = false;

      async function fetchResults() {
        if (!query) {
          setResults([])
          setError("")
          setHasNextPage(false)
          setLoading(false);
          return;
        }

        setLoading(true)
        setError("")

        try {
          const res = await fetch(`${API_BASE_URL}/search/search?q=${encodeURIComponent(query)}&page=${page}`)

          if (!res.ok) {
            throw new Error(await getApiErrorMessage(res, "Search request failed"));
          }

          const data = await res.json()

          if (shouldIgnore) {
            return;
          }

          const results = Array.isArray(data) ? data : data.results;
          setResults(Array.isArray(results) ? results : [])
          setHasNextPage(Boolean(data?.hasNextPage))
        } catch (searchError) {
          if (shouldIgnore) {
            return;
          }

          setResults([])
          setHasNextPage(false)
          setError(searchError.message || "Unable to load search results.")
        } finally {
          if (!shouldIgnore) {
            setLoading(false)
          }
        }
      }

      fetchResults();

      return () => {
        shouldIgnore = true;
      };
    }, [query,page])
  
  function updatePage(nextPage) {
    const nextParams = new URLSearchParams(searchParams);

    nextParams.set("page", String(nextPage));
    setSearchParams(nextParams);
  }
  
  function getArtistLabel(album) {
    return album.artist || "Unknown artist";
  }

  function getArtistNodeId(artistLabel) {
    return `artist:${artistLabel}`;
  } 


    useEffect(() =>{
    const uniqueArtists = [...new Set(searchresults.map((album) => getArtistLabel(album)))]

    const albumNodes = searchresults.map((album,index) => {
      const artistIndex = uniqueArtists.indexOf(album.artist);
      const column = index % 6;
      const row = Math.floor(index / 6);
      const artistLabel = getArtistLabel(album)

      return {
        id: album.id,
        position: {
            x: 90 + (column * 190),
            y: 260 + (row * 230) + ((artistIndex % 2) * 28),
        },
        data: {
            title: album.title,
            artist: artistLabel,
            cover: album.cover,
            id: album.id
        },
        type: 'albumNode'
      };
    })

    const artistNode = uniqueArtists.map((artistLabel,index) => ({
        id: getArtistNodeId(artistLabel),
        position: {
            x: 95+(index*190),
            y: 110,
        },
        data: {
            label: artistLabel,
        },
        type: 'artistNode'

    }))
    
    const initNodes = [...artistNode,...albumNodes]

    const initEdges = searchresults.map((album) => {
     const artistLabel = getArtistLabel(album);

    return {
      id: `${getArtistNodeId(artistLabel)}-${album.id}`,
      source: getArtistNodeId(artistLabel),
      target: album.id,
    };
});

    setNodes(initNodes)
    setEdges(initEdges)
 }, [searchresults])
    
    const onNodesChange = useCallback(
        (changes) => setNodes((nodesSnapshot) => applyNodeChanges(changes,nodesSnapshot)),
        []
    );
    const onEdgesChange = useCallback(
        (changes) => setEdges((edgesSnapshot) => applyEdgeChanges(changes,edgesSnapshot)),
        []
    );

  return(
    <section className="explore-page">

     <AsyncState
              isLoading={loading && Boolean(query)}
              error={error}
              isEmpty={!loading && !error && Boolean(query) && searchresults.length === 0}
              loadingVariant="grid"
              loadingMessage="Loading search results"
              errorTitle="Search unavailable"
              emptyTitle="No albums matched that search.">

     </AsyncState>








      <div className="explore-flow-shell">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange = {onNodesChange}
          onEdgesChange = {onEdgesChange}
          colorMode = "dark"
          fitView
        >
          <Background color="#2f3035" gap={28} />
          <Controls />
        </ReactFlow>
      </div>

      {query && (page > 1 || hasNextPage) && (
        <div className="search-pagination explore-pagination" aria-label="Explore pagination">
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
  )

}
