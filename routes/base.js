const express = require("express")
const router = express.Router()

router.get("/search", async(req, res) =>
{

    const query = req.query.q;

    const response = await fetch(
        `https://api.discogs.com/database/search?q=${query}&type=release`,
        {
            headers:
            {
                "User-Agent": "album-boxd/1.0"
            }
        }
    );

    const data = await response.json()

    const results = data.results.slice(0, 10).map(item => ({
      id: item.id,
      title: item.title,
      year: item.year,
      cover: item.cover_image
    }));

    res.json(results);






})


module.exports = router