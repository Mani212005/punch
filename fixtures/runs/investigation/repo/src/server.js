import express from "express";
import qs from "qs";

const app = express();
const port = process.env.PORT || 3000;

app.get("/search", (req, res) => {
  const raw = req.url.split("?")[1] || "";
  const query = qs.parse(raw);
  res.json({ q: query.q || null });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

if (process.env.NODE_ENV !== "test") {
  app.listen(port, () => {
    console.log(`vuln-shop listening on ${port}`);
  });
}

export default app;
