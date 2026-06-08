import { useState, useEffect } from "react";
import { useAuth } from "@clerk/react";

export function RecentlySaved() {
    const [savedAlbums, setSavedAlbums] = useState([]);
    const { getToken } = useAuth();
    useEffect(() => {
        async function fetchSavedAlbums() {
            const token = await getToken();
            const res = await fetch("http://localhost:3000/albums/collection", {
                headers: {
                    "Authorization": `Bearer ${token}`
                }
            });
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
                        <h3>{album.title}</h3>
                        <p>{album.artists?.[0]?.name || album.artist}</p>
                    </div>
                </div>
            ))}
        </div>
    );



 }

 export default RecentlySaved;
