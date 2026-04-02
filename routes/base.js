const express = require("express")
const router = express.Router()


router.get("/album", async (req, res) => {
    const query = req.query.q;

    const response = await fetch(
        `https://musicbrainz.org/ws/2/release/?query=${query}&fmt=json`,
        {
            headers:{
                "User-Agent": "album-boxd/1.0.0 (jkind889@gmail.com)"
            }
        }
    );

    const data = await response.json()
    console.log(data)

    res.json(data)
})

router.get("/search", async (req,res) => {
    const query = req.query.q

    const response = await fetch(
        `https://musicbrainz.org/ws/2/release/?query=${query}&fmt=json`,
        {
            headers:{
                "User-Agent": "album-boxd/1.0.0 (jkind889@gmail.com)"
            }
        }
    );

    const data = await response.json()
    const albums = data.releases.slice(0,10)

    const results = albums.map(album => ({
        id: album.id,
        title: album.title,
        artist: album["artist-credit"]?.[0]?.name || "Unknown"
    }));


    res.json(results)



})







module.exports = router