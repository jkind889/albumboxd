const express = require("express");
const Review = require("../models/Reviews");
const { getAuth } = require("@clerk/express");

const router = express.Router();

function ensureAuthenticated(req, res, next) {
    const { userId } = getAuth(req);

    if (!userId) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    req.userId = userId;
    next();
}

router.post("/review", ensureAuthenticated, async(req, res) =>
    {
        const userId = req.userId;


        try {
            const review = await Review.create(
                { ...req.body, userId }
            );
            res.status(201).json(review);
        } catch (error) {
            console.log(error);
            res.status(500).json({ error: "Failed to create review" });
        }
    });

 router.get("/review/user/", ensureAuthenticated, async(req, res) =>
    {
        const userId = req.userId;

        try {
            const reviews = await Review.find({ userId });
            res.json(reviews);
        } catch (error) {
            console.log(error);
            res.status(500).json({ error: "Failed to fetch reviews" });
        }
    });

router.delete("/review/user/:id", ensureAuthenticated, async(req, res) => {
    try {
        await Review.findOneAndDelete({ _id: req.params.id, userId: req.userId });
        res.json({ message: "Review deleted" });
    } catch (error) {
        console.log(error);
        res.status(500).json({ error: "Failed to delete review" });
    }
});

router.get("/review/album/:albumId", async(req, res) => {
    try {
        const reviews = await Review.find({ spotifyId: req.params.albumId }).sort({ date: -1 });
        res.json(reviews);
    } catch (error) {
        console.log(error);
        res.status(500).json({ error: "Failed to fetch review" });
    }
});

router.get("/popular", async(req, res) => {
    try {
        const reviews = await Review.find();
        res.json(reviews);
    } catch (error) {
        console.log(error);
        res.status(500).json({ error: "Failed to fetch reviews" });
    }
});



module.exports = router;
