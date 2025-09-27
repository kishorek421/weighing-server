// server.js (ES module) - complete minimal server with multer upload and ws
import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import mongoose from "mongoose";
import multer from "multer";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { fileURLToPath } from "url";

// basic setup for __dirname in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FIRMWARE_DIR = path.join(__dirname, "firmwares");
if (!fs.existsSync(FIRMWARE_DIR)) fs.mkdirSync(FIRMWARE_DIR, { recursive: true });

// ------ MongoDB connect (adjust MONGO_URI) ------
const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/weighing";
await mongoose.connect(MONGO_URI);

// ------ Mongoose schema ------
const deviceSchema = new mongoose.Schema({
  deviceId: { type: String, unique: true, required: true },
  secondsToRead: { type: Number, default: 1000 },
  threshold: { type: Number, default: 50 },
  enabled: { type: Boolean, default: true },
  firmwareUrl: { type: String, default: "" },
  firmwareVersion: { type: String, default: "" },
  firmwareUploadedAt: { type: Date },
  firmwareSha256: { type: String, default: "" },
  firmwareSize: { type: Number, default: 0 },
}, { timestamps: true });
const DeviceConfig = mongoose.model("DeviceConfig", deviceSchema);

// ------ Express + middleware ------
const app = express();
app.use(express.json());

// If behind proxy (nginx) and you want req.protocol to reflect forwarded proto:
// app.set('trust proxy', true);

// ------ Multer storage & upload (MUST be defined before using `upload` in routes) ------
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, FIRMWARE_DIR),
  filename: (req, file, cb) => {
    const timestamp = Date.now();
    const base = path.basename(file.originalname).replace(/\s+/g, "_");
    const name = `${timestamp}-${base}`;
    cb(null, name);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 } // 50 MB limit
});

// ------ Serve firmware files statically ------
app.use("/firmwares", express.static(FIRMWARE_DIR, {
  // optional caching etc
}));

// ------ Basic health route ------
app.get("/", (req, res) => res.send("✅ WebSocket + HTTP server running"));

// ------ Upload route (uses upload middleware) ------
app.post("/firmware/upload", upload.single("firmware"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded under 'firmware'" });

    const filePath = path.join(FIRMWARE_DIR, req.file.filename);
    // compute SHA256
    const hash = crypto.createHash("sha256");
    const rs = fs.createReadStream(filePath);
    await new Promise((resolve, reject) => {
      rs.on("data", (chunk) => hash.update(chunk));
      rs.on("end", resolve);
      rs.on("error", reject);
    });
    const sha256 = hash.digest("hex");

    const protocol = req.protocol;
    const host = req.get("host");
    const url = `${protocol}://${host}/firmwares/${encodeURIComponent(req.file.filename)}`;

    // return url + sha
    return res.json({
      filename: req.file.filename,
      size: req.file.size,
      url,
      sha256
    });
  } catch (err) {
    console.error("Firmware upload error:", err);
    return res.status(500).json({ error: "Upload failed" });
  }
});

// ------ Config endpoints ------
app.get("/config/:deviceId", async (req, res) => {
  try {
    const { deviceId } = req.params;
    let config = await DeviceConfig.findOne({ deviceId });
    if (!config) config = await DeviceConfig.create({ deviceId });

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
    console.error("Error fetching config:", err);
    res.status(500).json({ error: "Failed to fetch config" });
  }
});

app.post("/config/:deviceId/firmware", async (req, res) => {
  try {
    const { deviceId } = req.params;
    const { firmwareUrl, firmwareVersion, broadcast, firmwareSha256, firmwareSize } = req.body;
    if (!firmwareUrl) return res.status(400).json({ error: "firmwareUrl required" });

    let config = await DeviceConfig.findOne({ deviceId });
    if (!config) config = await DeviceConfig.create({ deviceId });

    config.firmwareUrl = firmwareUrl;
    if (firmwareVersion) config.firmwareVersion = firmwareVersion;
    if (firmwareSha256) config.firmwareSha256 = firmwareSha256;
    if (firmwareSize) config.firmwareSize = firmwareSize;
    config.firmwareUploadedAt = new Date();
    await config.save();

    // broadcast OTA message (see wss created below)
    const otaMsg = JSON.stringify({
      event: "ota",
      url: firmwareUrl,
      version: firmwareVersion || null,
      firmwareSha256: firmwareSha256 || null,
      deviceId
    });

    if (broadcast === "all") {
      wss.clients.forEach((client) => {
        if (client.readyState === client.OPEN) client.send(otaMsg);
      });
      console.log("Broadcasted OTA to all:", firmwareUrl);
    } else {
      wss.clients.forEach((client) => {
        try {
          if (client.readyState !== client.OPEN) return;
          if (client.deviceId && client.deviceId === deviceId) {
            client.send(otaMsg);
            console.log(`Sent OTA to ${deviceId}`);
          }
        } catch (e) {
          console.warn("Could not send OTA to a client:", e.message);
        }
      });
    }

    res.json({ ok: true, firmwareUrl, firmwareVersion, firmwareSha256 });
  } catch (err) {
    console.error("Error setting firmware:", err);
    res.status(500).json({ error: "Failed to set firmware" });
  }
});

// ------ Create HTTP server and websocket server ------
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on("connection", (ws, req) => {
  console.log("New WS client");

  ws.on("message", async (raw) => {
    const message = raw.toString();
    // try parse hello with deviceId
    try {
      const parsed = JSON.parse(message);
      if (parsed.event === "hello" && parsed.deviceId) {
        ws.deviceId = parsed.deviceId;
        console.log("Registered ws.deviceId =", ws.deviceId);

        // if DB has firmware for this device, notify
        const cfg = await DeviceConfig.findOne({ deviceId: ws.deviceId });
        if (cfg && cfg.firmwareUrl) {
          const otaMsg = { event: "ota", url: cfg.firmwareUrl, version: cfg.firmwareVersion || null, firmwareSha256: cfg.firmwareSha256 || null };
          ws.send(JSON.stringify(otaMsg));
          console.log(`Notified ${ws.deviceId} about firmware: ${cfg.firmwareUrl}`);
        }
      }
    } catch (e) {
      // ignore non-json
    }

    // Example behavior: broadcast incoming messages to all clients
    wss.clients.forEach((client) => {
      if (client.readyState === client.OPEN) client.send(message);
    });
  });

  ws.on("close", (code, reason) => {
    console.log(`Client disconnected (code ${code})`);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
