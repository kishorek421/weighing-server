// server.js
import { WebSocketServer } from "ws";
import http from "http";
import express from "express";
import mongoose from "mongoose";
import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

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
      firmwareUrl: config.firmwareUrl || null,
      firmwareVersion: config.firmwareVersion || null,
      firmwareUploadedAt: config.firmwareUploadedAt || null,
    });
  } catch (err) {
    console.error("❌ Error fetching config:", err);
    res.status(500).json({ error: "Failed to fetch config" });
  }
});

// ==== Multer upload for firmware binaries ====
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, FIRMWARE_DIR),
  filename: (req, file, cb) => {
    // keep original or use timestamped unique name
    const timestamp = Date.now();
    // sanitize filename
    const base = path.basename(file.originalname).replace(/\s+/g, "_");
    const name = `${timestamp}-${base}`;
    cb(null, name);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB limit (adjust)
});

// Upload firmware file => returns accessible URL
app.post("/firmware/upload", upload.single("firmware"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded under 'firmware'" });

    // Build a URL for download. Use request host/protocol when available.
    const protocol = req.protocol;
    const host = req.get("host"); // may include port
    // const url = `${protocol}://${host}/firmwares/${encodeURIComponent(req.file.filename)}`;

    // res.json({
    //   filename: req.file.filename,
    //   size: req.file.size,
    //   url,
    // });
    const url = `https://${host}/firmwares/${encodeURIComponent(req.file.filename)}`;
    res.json({ filename: req.file.filename, size: req.file.size, url });
  } catch (err) {
    console.error("❌ Firmware upload error:", err);
    res.status(500).json({ error: "Upload failed" });
  }
});

// ==== Set firmware for a device and optionally broadcast OTA command ====
/*
 Request body example:
 {
   "firmwareUrl": "https://your-domain/firmwares/1234-abcd.bin",
   "firmwareVersion": "v1.2.3",
   "broadcast": "all"         // "all" or "device" (default: "device")
 }
 If broadcast === "all", server will send {"event":"ota","url": firmwareUrl} to all ws clients.
 If broadcast === "device", server will send to clients whose deviceId matches.
*/
app.post("/config/:deviceId/firmware", async (req, res) => {
  try {
    const { deviceId } = req.params;
    const { firmwareUrl, firmwareVersion, broadcast } = req.body;

    if (!firmwareUrl) {
      return res.status(400).json({ error: "firmwareUrl required in body" });
    }

    let config = await DeviceConfig.findOne({ deviceId });
    if (!config) config = await DeviceConfig.create({ deviceId });

    config.firmwareUrl = firmwareUrl;
    if (firmwareVersion) config.firmwareVersion = firmwareVersion;
    config.firmwareUploadedAt = new Date();
    await config.save();

    // broadcast OTA message via WebSocket server
    const otaMsg = JSON.stringify({ event: "ota", url: firmwareUrl, version: firmwareVersion || null, deviceId });

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
          // We expect each client to send a hello with deviceId after connect.
          // We store deviceId on the ws object in 'connection' handler below.
          if (client.deviceId && client.deviceId === deviceId) {
            client.send(otaMsg);
            console.log(`🔔 Sent OTA to ${deviceId}`);
          }
        } catch (e) {
          console.warn("⚠ Could not send OTA to a client:", e.message);
        }
      });
    }

    return res.json({ ok: true, firmwareUrl, firmwareVersion });
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
