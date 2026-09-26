import { Router } from "express";

export const usersRouter = Router();

usersRouter.get("/:id", (req, res) => {
  res.json({ id: req.params.id, name: "Test User" });
});

usersRouter.post("/", (req, res) => {
  res.status(201).json({ created: true });
});
