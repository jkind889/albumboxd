require("dotenv").config();

if (!process.env.CLERK_PUBLISHABLE_KEY && process.env.VITE_CLERK_PUBLISHABLE_KEY) {
  process.env.CLERK_PUBLISHABLE_KEY = process.env.VITE_CLERK_PUBLISHABLE_KEY;
}

const express = require("express");
const app = express();
const cors = require("cors");
const mongoose = require("mongoose");
const { clerkMiddleware } = require("@clerk/express");

if (!process.env.CLERK_SECRET_KEY) {
  throw new Error("Missing CLERK_SECRET_KEY in the server environment.");
}

if (!process.env.CLERK_PUBLISHABLE_KEY) {
  throw new Error(
    "Missing CLERK_PUBLISHABLE_KEY in the server environment. Set CLERK_PUBLISHABLE_KEY or VITE_CLERK_PUBLISHABLE_KEY in .env.",
  );
}


app.use(express.json())
app.use(cors())
app.use(clerkMiddleware());


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
