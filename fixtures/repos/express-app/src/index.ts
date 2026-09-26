import express from "express";
import { apiRouter } from "./routes/api.js";
import { usersRouter } from "./routes/users.js";

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

// Mount routers
app.use("/api", apiRouter);
app.use("/users", usersRouter);

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

if (process.env.NODE_ENV !== "test") {
  app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
  });
}

export default app;
