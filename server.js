// server.js
import { WebSocketServer } from "ws";
import http from "http";

// Simple HTTP handler (optional, just to respond to GET requests)
const handle = (req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("WebSocket server is running\n");
};

const server = http.createServer(handle);

// Attach WebSocket to the HTTP server
const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  console.log("✅ New client connected");

  ws.on("message", (raw) => {
    const message = raw.toString();
    console.log("📩 Received:", message);

    // Broadcast to all connected clients
    wss.clients.forEach((client) => {
      if (client.readyState === ws.OPEN) {
        client.send(message);
      }
    });
  });

  ws.on("close", (code, reason) => {
    // Only log valid codes (1000–4999)
    if (code >= 1000 && code <= 4999) {
      console.log(`❌ Client disconnected (code: ${code}, reason: ${reason})`);
    } else {
      console.log(`⚠ Ignoring invalid close code: ${code}`);
    }
  });

  ws.on("error", (err) => {
    console.log("⚠ WebSocket error:", err.message);
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
