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


// ------ Create HTTP server and websocket server ------
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

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

// POST /api/reset-offset  { deviceId: "XYID-..." }
app.post("/api/reset-offset", async (req, res) => {
  try {
    const { deviceId } = req.body;
    if (!deviceId) return res.status(400).json({ error: "deviceId required" });

    // Find the WS client for this deviceId
    let found = false;
    wss.clients.forEach((client) => {
      try {
        if (client.readyState === client.OPEN && client.deviceId === deviceId) {
          // Send tare command
          const cmd = { event: "cmd", cmd: "tare", ts: Date.now() };
          client.send(JSON.stringify(cmd));
          found = true;
        }
      } catch (e) {
        console.warn("Failed sending tare to client", e && e.message);
      }
    });

    if (!found) {
      return res.status(404).json({ error: "Device not connected" });
    }

    // return success (device should respond via WS ack; front-end can poll or show toast)
    return res.json({ ok: true, message: "Tare command sent" });
  } catch (err) {
    console.error("Error in /api/reset-offset:", err);
    return res.status(500).json({ error: "Server error" });
  }
});


wss.on("connection", (ws, req) => {
  console.log("New WS client");

  ws.isAlive = true;

  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.on("message", async (raw) => {
    const message = raw.toString();

    // Try parse JSON
    let parsed;
    try {
      parsed = JSON.parse(message);
    } catch (e) {
      // Not JSON – ignore or handle as plain text if you want
      console.warn("Received non-JSON WS message, ignoring.");
      return;
    }

    try {
      // ----- HELLO from device (register deviceId + version) -----
      if (parsed.event === "hello" && parsed.deviceId) {
        const deviceId = String(parsed.deviceId).trim();
        const deviceVersion = parsed.version ? String(parsed.version).trim() : null;
        ws.deviceId = deviceId;
        console.log("Registered ws.deviceId =", deviceId, "version:", deviceVersion);

        // Look up DB config for this device
        const cfg = await DeviceConfig.findOne({ deviceId });

        // If device already running the assigned version, clear assignment
        if (cfg && cfg.firmwareVersion && deviceVersion) {
          if (cfg.firmwareVersion === deviceVersion) {
            await DeviceConfig.findOneAndUpdate(
              { deviceId, firmwareVersion: cfg.firmwareVersion },
              { $set: { firmwareUrl: "", firmwareSha256: "" } }
            );
            console.log(`Cleared assigned firmware for ${deviceId} (version ${deviceVersion})`);
            // acknowledge to device
            if (ws.readyState === ws.OPEN) {
              ws.send(JSON.stringify({ event: "ota_ack", deviceId, version: deviceVersion }));
            }
          }
        }

        // If DB has a firmwareUrl assigned (and it's not the same version), notify the device about OTA
        if (cfg && cfg.firmwareUrl && cfg.firmwareUrl.length > 0) {
          // Only send ota message if device is not already running that version (defensive)
          if (!cfg.firmwareVersion || cfg.firmwareVersion !== deviceVersion) {
            const otaMsg = {
              event: "ota",
              url: cfg.firmwareUrl,
              version: cfg.firmwareVersion || null,
              firmwareSha256: cfg.firmwareSha256 || null,
              deviceId
            };
            try {
              ws.send(JSON.stringify(otaMsg));
              console.log(`Notified ${deviceId} about firmware: ${cfg.firmwareUrl}`);
            } catch (e) {
              console.warn("Failed to send ota message to device:", e && e.message);
            }
          }
        }

        // Optionally: send current config to device
        if (cfg) {
          const cfgMsg = {
            event: "config",
            deviceId,
            secondsToRead: cfg.secondsToRead,
            threshold: cfg.threshold,
            enabled: cfg.enabled,
          };
          try {
            ws.send(JSON.stringify(cfgMsg));
          } catch (e) { /* ignore send errors */ }
        }

        return; // done with hello handling
      }

      // ----- OTA acknowledgement from device -----
      if (parsed.event === "ota_ack" && parsed.deviceId && parsed.version) {
        const deviceId = String(parsed.deviceId).trim();
        const ver = String(parsed.version).trim();
        console.log(`Received ota_ack from ${deviceId} version ${ver}`);

        // Record that device applied the firmware: clear the fw_url and set firmwareVersion (and appliedAt if needed)
        await DeviceConfig.findOneAndUpdate({ deviceId }, {
          $set: {
            firmwareVersion: ver,
            firmwareSha256: parsed.sha || parsed.firmwareSha256 || "",
            firmwareUploadedAt: new Date()
          },
          $unset: { firmwareUrl: "" }
        });

        return;
      }

      // ----- Telemetry: device sends JSON containing deviceId and numeric weight (weight/kg/grams) -----
      const hasDeviceId = parsed.deviceId && typeof parsed.deviceId === "string";
      const hasWeight =
        typeof parsed.weight === "number" ||
        typeof parsed.kg === "number" ||
        typeof parsed.grams === "number";

      if (hasDeviceId && hasWeight) {
        // Normalize shape to keep consistent broadcasts
        const deviceId = String(parsed.deviceId).trim();
        let weightVal;
        if (typeof parsed.weight === "number") weightVal = parsed.weight;
        else if (typeof parsed.kg === "number") weightVal = parsed.kg;
        else weightVal = parsed.grams / 1000.0;

        const telemetry = {
          event: "telemetry",
          deviceId,
          weight: Number(weightVal),
          timestamp: parsed.timestamp || Date.now()
        };

        // Broadcast telemetry to all other clients (dashboards) — do not send back to origin
        wss.clients.forEach((client) => {
          try {
            if (client !== ws && client.readyState === client.OPEN) {
              client.send(JSON.stringify(telemetry));
            }
          } catch (e) {
            // ignore send errors per-client
          }
        });

        // Optionally: you can store last-seen time in DB, but keep it lightweight here
        console.log(`Telem from ${deviceId}: ${telemetry.weight} kg`);

        return;
      }

      // ----- Other events (cfg request, ping, etc.) -----
      if (parsed.event === "cfg" && parsed.deviceId) {
        // client asked for config refresh for a deviceId
        const cfg = await DeviceConfig.findOne({ deviceId: parsed.deviceId });
        if (cfg && ws.readyState === ws.OPEN) {
          const cfgMsg = {
            event: "config",
            deviceId: cfg.deviceId,
            secondsToRead: cfg.secondsToRead,
            threshold: cfg.threshold,
            enabled: cfg.enabled,
            firmwareUrl: cfg.firmwareUrl || null,
            firmwareVersion: cfg.firmwareVersion || null,
            firmwareSha256: cfg.firmwareSha256 || null
          };
          ws.send(JSON.stringify(cfgMsg));
        }
        return;
      }

      // Other unhandled JSON events fall-through (you could broadcast or ignore)
    } catch (err) {
      console.error("WS message handler error:", err);
    }
  });

  ws.on("close", (code, reason) => {
    console.log(`Client disconnected (code ${code})`);
  });

  ws.on("error", (err) => {
    console.warn("WS client error:", err && err.message);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
