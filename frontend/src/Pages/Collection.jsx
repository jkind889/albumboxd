import {useState, useEffect} from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@clerk/react";
export function Collection() {

    const [savedAlbums, setSavedAlbums] = useState([]);
    const navigate = useNavigate();
    const { getToken } = useAuth();
    useEffect(() => {
        async function fetchSavedAlbums() {
            const token = await getToken();
            const res = await fetch(`http://localhost:3000/collections/collection`, {
                headers: {
                    "Authorization": `Bearer ${token}`
                }
            });
            if (!res.ok) {
                setSavedAlbums([]);
                return;
            }

            const saved = await res.json();

            setSavedAlbums(Array.isArray(saved) ? saved : []);
        }
        fetchSavedAlbums();
    }, [getToken]);


   async function removeAlbum(id) {
        const token = await getToken();
        const res = await fetch(`http://localhost:3000/collections/collection/album/${id}`, {
            method: "DELETE",
            headers: {
                "Authorization": `Bearer ${token}`,
                "Content-Type": "application/json"
            }
        });
        if (!res.ok) {
            console.error("Failed to remove album from collection");
            return;
        }
        const updatedAlbums = savedAlbums.filter(album => album.spotifyId !== id);
        setSavedAlbums(updatedAlbums);
    }

    return (
        <div>
            <h1>My Collection</h1>
            {savedAlbums.length === 0 ? (
                <p>No albums saved in collection.</p>
            ) : (
                
                    <div className="results-grid">
                    {Array.isArray(savedAlbums) && savedAlbums.map((result) => (
                        // When a result is clicked, navigate to the album detail page using the album's ID
                        <article className="result-card" key={result.spotifyId} onClick={() => navigate(`/album/${result.spotifyId}`)}>
                        <img className="result-cover" src={result.cover} alt={`${result.title} cover`} />
                        <h3>{result.title}</h3>
                        <p>{result.artist}</p>
                        <span className="result-year">{result.year || "Year unknown"} </span>
                        <button className="remove-button" onClick={(e) => { e.stopPropagation(); removeAlbum(result.spotifyId); }}>Remove</button>
                        </article>
                        
                    ))}

                    </div>
            )}
        </div>
    );




}


export default Collection;
