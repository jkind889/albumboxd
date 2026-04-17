const express = require('express')
const app = express()
const cors = require("cors");
require("dotenv").config()

app.use(express.json())
app.use(cors())


app.get("/", (req,res) =>
{
    console.log("Here")
    res.send("Hey")
})


const authRoutes = require("./routes/auth");
const albumRoutes = require("./routes/album");
const searchRoutes = require("./routes/search");

app.use("/auth", authRoutes);
app.use("/search", searchRoutes);
app.use("/albums", albumRoutes);


app.listen(3000, () =>
{
    console.log("server running")
})