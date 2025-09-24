// server.js
import { WebSocketServer } from "ws";
import http from "http";
import express from "express";
import mongoose from "mongoose";

// ==== MongoDB Setup ====
const MONGO_URI = process.env.MONGO_URI || "mongodb://admin:admin@127.0.0.1:27017/admin?authSource=admin";
await mongoose.connect(MONGO_URI);

const deviceSchema = new mongoose.Schema({
  deviceId: String,
  secondsToRead: { type: Number, default: 1000 }, // ms
  threshold: { type: Number, default: 50 },
  enabled: { type: Boolean, default: true },
});

const DeviceConfig = mongoose.model("DeviceConfig", deviceSchema);

// ==== Express Setup ====
const app = express();
app.use(express.json());

// Basic HTTP handler
app.get("/", (req, res) => {
  res.send("✅ WebSocket + HTTP server running");
});

// API: Get device config
app.get("/config/:deviceId", async (req, res) => {
  try {
    const { deviceId } = req.params;
    let config = await DeviceConfig.findOne({ deviceId });

    // Auto-create with defaults if not found
    if (!config) {
      config = await DeviceConfig.create({ deviceId });
    }

    res.json({
      deviceId: config.deviceId,
      secondsToRead: config.secondsToRead,
      threshold: config.threshold,
      enabled: config.enabled,
    });
  } catch (err) {
    console.error("❌ Error fetching config:", err);
    res.status(500).json({ error: "Failed to fetch config" });
  }
});

// ==== Create HTTP server and attach WS ====
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  console.log("✅ New client connected");

  ws.on("message", (raw) => {
    const message = raw.toString();
    console.log("📩 Received:", message);

    // Broadcast to all clients
    wss.clients.forEach((client) => {
      if (client.readyState === ws.OPEN) {
        client.send(message);
      }
    });
  });

  ws.on("close", (code, reason) => {
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
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
