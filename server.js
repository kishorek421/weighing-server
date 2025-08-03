// server.js
import { WebSocketServer } from "ws";
import http from "http";

const server = http.createServer((req, res) => {
  handle(req, res);
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  console.log("✅ New client connected");

  ws.on("message", (raw) => {
    console.log("📩 Received:", raw.toString());

    // Broadcast to all clients
    wss.clients.forEach((client) => {
      if (client.readyState === ws.OPEN) {
        client.send(raw.toString());
      }
    });
  });

  ws.on("close", (code, reason) => {
    // Ignore invalid codes (<1000 or >4999)
    if (code < 1000 || code > 4999) {
      console.log(`⚠ Ignoring invalid close code: ${code}`);
      return;
    }
    console.log(`❌ Client disconnected (code: ${code}, reason: ${reason})`);
  });

  ws.on("error", (err) => {
    console.log("⚠ WebSocket error:", err.message);
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
