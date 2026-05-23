import { useState, useEffect } from "react";


export function RecentlySaved() {
    const [savedAlbums, setSavedAlbums] = useState([]);
    
    useEffect(() => {
        async function fetchSavedAlbums() {
            const res = await fetch("http://localhost:3000/albums/album");
            const saved = await res.json();
            setSavedAlbums(saved.slice(0, 5)); // Show only the 5 most recently saved albums
        }
        fetchSavedAlbums();
    }, []);


    return (
        <div className="recently-saved">
            {savedAlbums.map((album) => (
                <div key={album.spotifyId} className="recent-saved-album">
                    <img src={album.cover} alt={`${album.name} cover`} className="recent-saved-album-cover" />
                    <div className="recent-saved-album-info">
                        <h3>{album.name}</h3>
                        <p>{album.artists?.[0]?.name || album.artist}</p>
                    </div>
                </div>
            ))}
        </div>
    );



 }

 export default RecentlySaved;
