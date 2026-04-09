import {useParams} from "react-router-dom";
import { useState, useEffect } from "react";

export function AlbumDetail()
{
    const {id} = useParams();
    const [album, setAlbum] = useState(null);

    useEffect(() => {
        // Fetch album details from the backend API
        // Use the album ID from the URL parameters
        fetch(`http://localhost:3000/api/album/${id}`)
        .then(res => res.json())
        .then(data => setAlbum(data))
    }, [id])

    if (!album) return <p>Loading...</p>;

    return (
        <div>
            <h1>{album.title}</h1>
            <p>Artist: {album.artist}</p>
            <p>Year: {album.year}</p>
        </div>
        // Album Detail component rendered when user clicks on a search result, showing more information about the selected album
    );

}

export default AlbumDetail;