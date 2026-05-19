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

    router.get("/reviews", async(req, res) =>
    {
        try {
            const reviews = await Review.find();
            res.json(reviews);
        } catch (error) {
            console.log(error);
            res.status(500).json({ error: "Failed to fetch reviews" });
        }
    });

module.exports = router;