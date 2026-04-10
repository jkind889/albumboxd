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


    const SaveAlbum = () => {
        // Save the album to localStorage for the collection page
        const saved = JSON.parse(localStorage.getItem("savedAlbums")) || [];

        // if the album exists we can alert the user and return early
        const exists= saved.some(a => a.id === album.id);
        if (exists) {
            alert("Album already saved in collection");
            return;
        }
        // push the album into the saved array and save it back to localStorage
        saved.push(album)
        console.log(saved);
        // Save the updated array back to localStorage
        localStorage.setItem("savedAlbums", JSON.stringify(saved));

    };

    return (
        <div>
            <h1>{album.title}</h1>
            <p>Artist: {album.artist}</p>
            <p>Year: {album.year}</p>
            <button onClick={SaveAlbum}>Save to Collection</button>
        </div>
        // Album Detail component rendered when user clicks on a search result, showing more information about the selected album
    );

}

export default AlbumDetail;