export function FeaturedAlbums() {
    const albums =
    [
        {
            id: 1,
            artist: "LOONA",
            cover: "https://i.scdn.co/image/ab67616d0000b27316caa9e546f536939373fb26",
            title: "[X X]",
            year: "2019"
        },
        {
            id: 2,
            artist: "LOOΠΔ / ODD EYE CIRCLE",
            cover: "https://i.scdn.co/image/ab67616d0000b273fb3c690920c69107439c2866",
            title: "Max & Match",
            year: "2017"
        },
        {
            id: 3,
            artist: "LOONA",
            cover: "https://i.scdn.co/image/ab67616d0000b2735545c6ac0c2b24cda7b6ad50",
            title: "[+ +]",
            year: "2018"
        },
        {
            id: 4,
            artist: "LOONA",
            cover: "https://i.scdn.co/image/ab67616d0000b273f0f22b06444fce291092dfcc",
            title: "[&]",
            year: "2021"
        },
        {
          id: 5,
          artist: "LOONA",
          cover: "https://i.scdn.co/image/ab67616d0000b273c985aeaeccb1db38dddf2986",
          title: "[#]",
          year: "2020"
        },
        {
            id: 6,
            artist: "Summrs",
            cover: "https://i.scdn.co/image/ab67616d0000b273b820efc3a28c379873b48765",
            title: "Revived",
            year: "2018"
        },
        {
            id: 7,
            artist: "IVE",
            cover: "https://i.scdn.co/image/ab67616d0000b273ad80a9aabc17535c5eeb5317",
            title: "REVIVE+",
            year: "2026"
        },
        {
            id: 8,
            artist: "LOOΠΔ / ODD EYE CIRCLE",
            cover: "https://i.scdn.co/image/ab67616d0000b273b0c77e44c80049787308057f",
            title: "LOONATIC",
            year: "2017"
        },
        {
            id: 9,
            artist: "LOONA",
            cover: "https://i.scdn.co/image/ab67616d0000b273b6ab7be3b4eeb27e1af65cdb",
            title: "Chuu",
            year: "2017"
        },
        {
            id: 10,
            artist: "LOONA",
            cover: "https://i.scdn.co/image/ab67616d0000b273e793fee8af5d01b0187c8a5f",
            title: "Kim Lip",
            year: "2017"
        }
    ]

    const shuffledAlbums = albums.sort(() => 0.5 - Math.random());
    const selectedAlbums = shuffledAlbums.slice(0,5);


    return (
        <div className="featured-albums">
            {selectedAlbums.map(album => (
                <div key={album.id} className="featured-album">
                    <img src={album.cover} alt={`${album.artist} - ${album.title}`} className="featured-album-cover" />
        </div>
            ))}
        </div>
    );

}

export default FeaturedAlbums