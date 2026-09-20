import fs from "fs";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

const logDir = path.resolve(process.env.LOG_FOLDER || "./logs");

// Ensure log directory exists
if (!fs.existsSync(logDir)) {
  try {
    fs.mkdirSync(logDir, { recursive: true });
  } catch (err) {
    console.error("[LoggerService] Failed to create log folder:", err.message);
  }
}

/**
 * Gets the current daily log file path.
 * @returns {string}
 */
function getLogFilePath() {
  const dateStr = new Date().toISOString().split("T")[0];
  return path.join(logDir, `conversation-${dateStr}.jsonl`);
}

/**
 * Appends a structured log entry to the daily log file.
 * @param {string} eventType 
 * @param {Object} data 
 */
function appendLog(eventType, data) {
  const entry = {
    timestamp: new Date().toISOString(),
    event: eventType,
    ...data,
  };

  const line = JSON.stringify(entry) + "\n";
  try {
    fs.appendFileSync(getLogFilePath(), line, "utf8");
  } catch (err) {
    console.error("[LoggerService] Write error:", err.message);
  }
}

export const logger = {
  info(message, meta = {}) {
    console.log(`[INFO] ${message}`, Object.keys(meta).length ? meta : "");
    appendLog("SYSTEM_INFO", { message, ...meta });
  },

  warn(message, meta = {}) {
    console.warn(`\x1b[33m[WARN] ${message}\x1b[0m`, Object.keys(meta).length ? meta : "");
    appendLog("SYSTEM_WARN", { message, ...meta });
  },

  error(message, meta = {}) {
    console.error(`\x1b[31m[ERROR] ${message}\x1b[0m`, Object.keys(meta).length ? meta : "");
    appendLog("SYSTEM_ERROR", { message, ...meta });
  },

  logIncomingMessage({ from, messageId, type, text }) {
    console.log(`\x1b[36m[INCOMING] From: ${from} | Type: ${type} | ID: ${messageId}\x1b[0m`);
    if (text) console.log(`   Message: "${text}"`);
    appendLog("INCOMING_MESSAGE", { from, messageId, type, text });
  },

  logIntent({ messageId, from, text, intent, confidence, reasoning }) {
    console.log(`   Intent: \x1b[32m${intent}\x1b[0m (confidence: ${confidence})`);
    appendLog("INTENT_CLASSIFICATION", { messageId, from, text, intent, confidence, reasoning });
  },

  logSearch({ from, keyword, drive, resultCount, matches }) {
    console.log(`   File Search: "${keyword}" (Drive: ${drive || "Any"}) -> ${resultCount} match(es)`);
    appendLog("FILE_SEARCH", { from, keyword, drive, resultCount, matches });
  },

  logOutgoingResponse({ to, type, text, filePath, mediaId }) {
    console.log(`\x1b[32m[OUTGOING] To: ${to} | Type: ${type}\x1b[0m`);
    if (text) console.log(`   Reply: "${text.substring(0, 100)}${text.length > 100 ? "..." : ""}"`);
    if (filePath) console.log(`   File: ${filePath} (Media ID: ${mediaId})`);
    appendLog("OUTGOING_RESPONSE", { to, type, text, filePath, mediaId });
  },
};
