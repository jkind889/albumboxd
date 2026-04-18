import {useState, useEffect} from "react";
import { useNavigate } from "react-router-dom";


export function Collection() {

    const [savedAlbums, setSavedAlbums] = useState([]);
    const navigate = useNavigate();
    
    useEffect(() => {
        const saved = JSON.parse(localStorage.getItem("savedAlbums")) || [];
        setSavedAlbums(saved);
    }, [])


   function removeAlbum(id) {
        // filter out the album with the given id and update state and localStorage
        const updatedAlbums = savedAlbums.filter(album => album.id !== id);
        setSavedAlbums(updatedAlbums);
        localStorage.setItem("savedAlbums", JSON.stringify(updatedAlbums));
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
                        <article className="result-card" key={result.id} onClick={() => navigate(`/album/${result.id}`)}>
                        <img className="result-cover" src={result.imgs?.[0]?.url} alt={`${result.title} cover`} />
                        <h3>{result.title}</h3>
                        <p>{result.artist}</p>
                        <span className="result-year">{result.year || "Year unknown"} </span>
                        <button className="remove-button" onClick={(e) => { e.stopPropagation(); removeAlbum(result.id); }}>Remove</button>
                        </article>
                        
                    ))}

                    </div>
            )}
        </div>
    );




}


export default Collection;