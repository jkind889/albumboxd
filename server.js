require("dotenv").config();

if (!process.env.CLERK_PUBLISHABLE_KEY && process.env.VITE_CLERK_PUBLISHABLE_KEY) {
  process.env.CLERK_PUBLISHABLE_KEY = process.env.VITE_CLERK_PUBLISHABLE_KEY;
}

const express = require("express");
const app = express();
const cors = require("cors");
const mongoose = require("mongoose");
const { clerkMiddleware } = require("@clerk/express");
const healthRoutes = require("./routes/health");

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
app.use("/health", healthRoutes);
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
const collectionRoutes = require("./routes/collections")
const profileRoutes = require("./routes/profile")
const boardRoutes = require("./routes/boards")
const likeRoutes = require("./routes/likes")
const notificationRoutes = require("./routes/notifications")

app.use("/auth", authRoutes);
app.use("/search", searchRoutes);
app.use("/albums", albumRoutes);
app.use("/reviews", reviewRoutes);
app.use("/collections", collectionRoutes)
app.use("/profile", profileRoutes)
app.use("/boards", boardRoutes)
app.use("/likes", likeRoutes)
app.use("/notifications", notificationRoutes)

app.listen(3000, () =>
{
    console.log("server running")
})
