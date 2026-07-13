import { Router, type IRouter } from "express";
import { broadcastAnalysis, getLatestAnalysis } from "../lib/live-analysis";

const router: IRouter = Router();

// PC posts analysis here → broadcasts to all connected phones
router.post("/analysis", (req, res) => {
  const body = req.body;
  if (!body || typeof body !== "object") {
    res.status(400).json({ error: "Invalid body" });
    return;
  }
  broadcastAnalysis(body);
  res.json({ ok: true, clients: "broadcast" });
});

// Phone can poll this if WebSocket isn't available
router.get("/analysis", (req, res) => {
  const latest = getLatestAnalysis();
  if (!latest) {
    res.status(404).json({ error: "No analysis yet — start screen scan on PC" });
    return;
  }
  res.json(latest);
});

export default router;
