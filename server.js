const express = require('express')
const app = express()
const cors = require("cors");

const mongoose = require("mongoose");
require("dotenv").config()

app.use(express.json())
app.use(cors())


app.get("/", (req,res) =>
{
    console.log("Here")
    res.send("Hey")
})

mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("MongoDB Connected"))
  .catch((err) => console.log(err));

const authRoutes = require("./routes/auth");
const albumRoutes = require("./routes/album");
const searchRoutes = require("./routes/search");
const reviewRoutes = require("./routes/reviews");

app.use("/auth", authRoutes);
app.use("/search", searchRoutes);
app.use("/albums", albumRoutes);
app.use("/reviews", reviewRoutes);

app.listen(3000, () =>
{
    console.log("server running")
})