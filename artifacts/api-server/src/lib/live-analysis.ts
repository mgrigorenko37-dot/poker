import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "http";
import { logger } from "./logger";

export interface LiveAnalysis {
  holeCards: string[];
  boardCards: string[];
  action: string;
  displayText: string;
  color: string;
  details: string[];
  equity: number;
  potOdds: number | null;
  mdf: number | null;
  handCategory: string;
  handName: string | null;
  draws: {
    flushDraw: boolean;
    oesd: boolean;
    gutshot: boolean;
    totalOuts: number;
    equityTurn: number;
    equityRiver: number;
  } | null;
  bluffRead: { label: string; score: number; reasons: string[] } | null;
  potSize: number | null;
  betToCall: number | null;
  players: number;
  position: string;
  ts: number;
}

let latestAnalysis: LiveAnalysis | null = null;
const clients = new Set<WebSocket>();

export function initWebSocketServer(server: Server): void {
  const wss = new WebSocketServer({ server, path: "/api/ws" });

  wss.on("connection", (ws, req) => {
    clients.add(ws);
    logger.info({ clients: clients.size }, "WS client connected");

    // Send current analysis immediately on connect
    if (latestAnalysis) {
      ws.send(JSON.stringify({ type: "analysis", data: latestAnalysis }));
    } else {
      ws.send(JSON.stringify({ type: "waiting" }));
    }

    ws.on("close", () => {
      clients.delete(ws);
      logger.info({ clients: clients.size }, "WS client disconnected");
    });
    ws.on("error", () => clients.delete(ws));
  });

  logger.info("WebSocket server initialized at /api/ws");
}

export function broadcastAnalysis(analysis: LiveAnalysis): void {
  latestAnalysis = { ...analysis, ts: Date.now() };
  const msg = JSON.stringify({ type: "analysis", data: latestAnalysis });
  let sent = 0;
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
      sent++;
    }
  }
  logger.debug({ sent, clients: clients.size }, "Broadcast analysis");
}

export function getLatestAnalysis(): LiveAnalysis | null {
  return latestAnalysis;
}
