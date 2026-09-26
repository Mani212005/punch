import { Router } from "express";
import qs from "qs";
import _ from "lodash";

export const apiRouter = Router();

// GET /api/search
apiRouter.get("/search", (req, res) => {
  const queryStr = (req.query.q as string) || "";
  // Call site: qs.parse
  const parsed = qs.parse(queryStr);
  res.json({ result: parsed });
});

// POST /api/merge
apiRouter.post("/merge", (req, res) => {
  const defaults = { status: "active", version: 1 };
  const payload = req.body || {};
  // Call site: _.merge
  const merged = _.merge({}, defaults, payload);
  res.json({ data: merged });
});
