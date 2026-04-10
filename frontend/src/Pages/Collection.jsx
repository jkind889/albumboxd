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
                <ul>
                    {savedAlbums.map(album => (
                        <li key={album.id}
                            onClick={() => navigate(`/album/${album.id}`)}
                        >
                            {album.title} by {album.artist} ({album.year})

                            <button onClick={(e) => {
                                e.stopPropagation(); // prevent navigating to album detail when clicking remove
                                removeAlbum(album.id)
                               }}
                                
                                
                                > 
                                Remove
                            </button>
    
                        </li>
                        // Add remove button to each album in the collection, calling removeAlbum with the album's id when clicked
                    ))}
                </ul>
            )}
        </div>
    );




}


export default Collection;