require("dotenv").config();

const express = require("express");
const app = express();
const cors = require("cors");
const mongoose = require("mongoose");
const { clerkMiddleware } = require("@clerk/express");
const healthRoutes = require("./routes/health");
const {
  getTrustProxyHops,
  globalApiRateLimit,
} = require("./routes/utils/rateLimit");
const {
  buildCorsOptions,
  parsePort,
  validateServerEnv,
} = require("./routes/utils/serverConfig");

validateServerEnv();

app.use(express.json())
app.use("/health", healthRoutes);
app.use(cors(buildCorsOptions()))
const trustProxyHops = getTrustProxyHops();
if (trustProxyHops > 0) {
  app.set("trust proxy", trustProxyHops);
}
app.use(globalApiRateLimit);
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

const port = parsePort();

app.listen(port, () =>
{
    console.log(`server running on port ${port}`)
})
