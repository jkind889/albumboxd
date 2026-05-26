const express = require("express");
const Review = require("../models/Reviews");
const router = express.Router();

router.post("/review", async(req, res) =>
    {
        try {
            const review = await Review.create(req.body);
            res.status(201).json(review);
        } catch (error) {
            console.log(error);
            res.status(500).json({ error: "Failed to create review" });
        }
    });

 router.get("/review/user/:userId", async(req, res) =>
    {
        try {
            const reviews = await Review.find({ userId: req.params.userId });
            res.json(reviews);
        } catch (error) {
            console.log(error);
            res.status(500).json({ error: "Failed to fetch reviews" });
        }
    });

router.delete("/review/:id", async(req, res) => {
    try {
        await Review.findOneAndDelete({ _id: req.params.id });
        res.json({ message: "Review deleted" });
    } catch (error) {
        console.log(error);
        res.status(500).json({ error: "Failed to delete review" });
    }
});

router.get("/review/album/:albumId", async(req, res) => {
    try {
        const review = await Review.find({ albumId: req.params.id });
        if (!review) {
            return res.status(404).json({ error: "Review not found" });
        }
        res.json(review);
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