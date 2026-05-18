import { useState, useEffect } from "react";


export function RecentlySaved() {
    const [savedAlbums, setSavedAlbums] = useState([]);
    
    useEffect(() => {
        const stored = JSON.parse(localStorage.getItem("savedAlbums")) || [];
        setSavedAlbums(stored.slice(0, 5)); // Show only the 5 most recently saved albums
    }, []);


    return (
        <div className="recently-saved">
            {savedAlbums.map((album) => (
                <div key={album.id} className="recent-saved-album">
                    <img src={album.imgs?.[0]?.url} alt={`${album.name} cover`} className="recent-saved-album-cover" />
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
