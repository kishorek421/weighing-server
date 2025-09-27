// server.js
import { WebSocketServer } from "ws";
import http from "http";
import express from "express";
import mongoose from "mongoose";
import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import crypto from "crypto";

// ==== Basic setup ====
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIRMWARE_DIR = path.join(__dirname, "firmwares");

// ensure firmware directory exists
if (!fs.existsSync(FIRMWARE_DIR)) {
  fs.mkdirSync(FIRMWARE_DIR, { recursive: true });
}

// ==== MongoDB Setup ====
const MONGO_URI = process.env.MONGO_URI || "mongodb+srv://bellwethersriram_db_user:Hrcf79M3WUAjjp0I@weighingmachine.agebd8s.mongodb.net/";
await mongoose.connect(MONGO_URI, {
  // useNewUrlParser, useUnifiedTopology are default in modern mongoose
});

const deviceSchema = new mongoose.Schema({
  deviceId: { type: String, unique: true, required: true },
  secondsToRead: { type: Number, default: 1000 }, // ms
  threshold: { type: Number, default: 50 },
  enabled: { type: Boolean, default: true },

  // OTA-related fields
  firmwareUrl: { type: String, default: "" },       // full URL for device to download
  firmwareVersion: { type: String, default: "" },   // semantic version or build id
  firmwareUploadedAt: { type: Date },
}, { timestamps: true });

const DeviceConfig = mongoose.model("DeviceConfig", deviceSchema);

// ==== Express Setup ====
const app = express();
app.use(express.json());

// Serve firmware static files
app.use("/firmwares", express.static(FIRMWARE_DIR, {
  // optional: set cache headers, range support is automatic
}));

// Basic HTTP handler
app.get("/", (req, res) => {
  res.send("✅ WebSocket + HTTP server running");
});

// In upload handler change to compute sha256:
app.post("/firmware/upload", upload.single("firmware"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded under 'firmware'" });

    // compute SHA256 of uploaded file
    const filePath = path.join(FIRMWARE_DIR, req.file.filename);
    const hash = crypto.createHash("sha256");
    const rs = fs.createReadStream(filePath);
    await new Promise((resolve, reject) => {
      rs.on("data", (chunk) => hash.update(chunk));
      rs.on("end", resolve);
      rs.on("error", reject);
    });
    const sha256 = hash.digest("hex");

    // Build a URL for download using request protocol & host
    const protocol = req.protocol; // will be http in dev, https behind proxy if configured
    const host = req.get("host");
    const url = `${protocol}://${host}/firmwares/${encodeURIComponent(req.file.filename)}`;

    // Optionally store a global record or return the sha to caller
    res.json({
      filename: req.file.filename,
      size: req.file.size,
      url,
      sha256
    });
  } catch (err) {
    console.error("❌ Firmware upload error:", err);
    res.status(500).json({ error: "Upload failed" });
  }
});

// In GET /config/:deviceId, include firmwareSha256 and firmwareSize fields
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
      firmwareUrl: config.firmwareUrl || null,
      firmwareVersion: config.firmwareVersion || null,
      firmwareUploadedAt: config.firmwareUploadedAt || null,
      firmwareSha256: config.firmwareSha256 || null,
      firmwareSize: config.firmwareSize || null
    });
  } catch (err) {
    console.error("❌ Error fetching config:", err);
    res.status(500).json({ error: "Failed to fetch config" });
  }
});

// Update the /config/:deviceId/firmware endpoint to accept sha and size (optional)
app.post("/config/:deviceId/firmware", async (req, res) => {
  try {
    const { deviceId } = req.params;
    const { firmwareUrl, firmwareVersion, broadcast, firmwareSha256, firmwareSize } = req.body;

    if (!firmwareUrl) {
      return res.status(400).json({ error: "firmwareUrl required in body" });
    }

    let config = await DeviceConfig.findOne({ deviceId });
    if (!config) config = await DeviceConfig.create({ deviceId });

    config.firmwareUrl = firmwareUrl;
    if (firmwareVersion) config.firmwareVersion = firmwareVersion;
    if (firmwareSha256) config.firmwareSha256 = firmwareSha256;
    if (firmwareSize) config.firmwareSize = firmwareSize;
    config.firmwareUploadedAt = new Date();
    await config.save();

    // broadcast OTA message via WebSocket server
    const otaMsg = JSON.stringify({
      event: "ota",
      url: firmwareUrl,
      version: firmwareVersion || null,
      firmwareSha256: firmwareSha256 || null,
      deviceId
    });

    if (broadcast === "all") {
      // send to all connected clients
      wss.clients.forEach((client) => {
        if (client.readyState === client.OPEN) client.send(otaMsg);
      });
      console.log("🔔 Broadcasted OTA to all clients:", firmwareUrl);
    } else {
      // send only to matching deviceId
      wss.clients.forEach((client) => {
        try {
          if (client.readyState !== client.OPEN) return;
          if (client.deviceId && client.deviceId === deviceId) {
            client.send(otaMsg);
            console.log(`🔔 Sent OTA to ${deviceId}`);
          }
        } catch (e) {
          console.warn("⚠ Could not send OTA to a client:", e.message);
        }
      });
    }

    return res.json({ ok: true, firmwareUrl, firmwareVersion, firmwareSha256 });
  } catch (err) {
    console.error("❌ Error setting firmware:", err);
    res.status(500).json({ error: "Failed to set firmware" });
  }
});

// ==== Create HTTP server and attach WS ====
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// helper to broadcast JSON to all / to specific device
function broadcastJson(obj, targetDeviceId = null) {
  const msg = JSON.stringify(obj);
  wss.clients.forEach((client) => {
    if (client.readyState !== client.OPEN) return;
    if (!targetDeviceId) {
      client.send(msg);
    } else {
      if (client.deviceId && client.deviceId === targetDeviceId) {
        client.send(msg);
      }
    }
  });
}

wss.on("connection", (ws, req) => {
  console.log("✅ New client connected");

  // Optional: set a short timeout for the client to announce itself
  ws.isAlive = true;

  ws.on("message", async (raw) => {
    const message = raw.toString();
    console.log("📩 Received:", message);

    // If client sends a JSON hello with deviceId, attach it to ws for targeted pushes
    try {
      const parsed = JSON.parse(message);
      if (parsed.event === "hello" && parsed.deviceId) {
        ws.deviceId = parsed.deviceId;
        console.log("🔖 Registered ws.deviceId =", ws.deviceId);

        // Optionally: when device connects, check DB for firmwareUrl and notify if present
        const cfg = await DeviceConfig.findOne({ deviceId: ws.deviceId });
        if (cfg && cfg.firmwareUrl) {
          // notify device about stored firmware (only to that device)
          const otaMsg = { event: "ota", url: cfg.firmwareUrl, version: cfg.firmwareVersion || null };
          ws.send(JSON.stringify(otaMsg));
          console.log(`🔔 Notified ${ws.deviceId} about firmware: ${cfg.firmwareUrl}`);
        }
      }
    } catch (e) {
      // not JSON or not hello - ignore
    }

    // Broadcast incoming message to all clients (preserve your behavior)
    wss.clients.forEach((client) => {
      if (client.readyState === client.OPEN) {
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

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
