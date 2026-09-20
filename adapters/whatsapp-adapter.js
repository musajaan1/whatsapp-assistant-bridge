import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { logger } from "../services/logger-service.js";

dotenv.config();

/**
 * Common MIME type mapping.
 */
const MIME_TYPES = {
  ".pdf": "application/pdf",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".cdr": "application/octet-stream",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".zip": "application/zip",
};

/**
 * Gets MIME type for a given file path.
 * @param {string} filePath 
 * @returns {string}
 */
function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || "application/octet-stream";
}

export class WhatsAppAdapter {
  constructor() {
    this.baseUrl = (process.env.WHATSAPP_API_BASE_URL || "https://api.whatsapp.com/agent/v1").replace(/\/+$/, "");
    this.token = process.env.WHATSAPP_ACCESS_TOKEN || "";
    this.messageHandlers = [];
    this.isPolling = false;
    this.offset = null;
    this.offsetFilePath = path.resolve("./logs/last_offset.txt");

    // Outbound rate limiting: 12 requests / minute (5000ms safe spacing)
    this.outboundTimestamps = [];
    this.maxOutboundPerMinute = 12;

    // Polling rate limiting: 15 requests / minute
    this.pollTimestamps = [];
    this.maxPollsPerMinute = 15;

    this.loadOffset();
  }

  loadOffset() {
    try {
      if (fs.existsSync(this.offsetFilePath)) {
        const saved = fs.readFileSync(this.offsetFilePath, "utf8").trim();
        if (saved) {
          this.offset = saved;
          logger.info(`[WhatsAppAdapter] Resuming with saved offset: ${this.offset}`);
        }
      }
    } catch (err) {
      logger.warn(`[WhatsAppAdapter] Could not read offset file: ${err.message}`);
    }
  }

  saveOffset(newOffset) {
    if (!newOffset || newOffset === this.offset) return;
    this.offset = newOffset;
    try {
      fs.writeFileSync(this.offsetFilePath, String(newOffset), "utf8");
    } catch (err) {
      logger.warn(`[WhatsAppAdapter] Could not persist offset: ${err.message}`);
    }
  }

  getHeaders(isMultipart = false) {
    const token = process.env.WHATSAPP_ACCESS_TOKEN || this.token;
    if (!token) {
      throw new Error("WHATSAPP_ACCESS_TOKEN is not set in .env!");
    }
    const headers = {
      Authorization: `Bearer ${token.trim()}`,
    };
    if (!isMultipart) {
      headers["Content-Type"] = "application/json";
    }
    return headers;
  }

  /**
   * Enforces 12 outbound requests per minute limit.
   */
  async throttleOutbound() {
    const now = Date.now();
    // Remove timestamps older than 60s
    this.outboundTimestamps = this.outboundTimestamps.filter((t) => now - t < 60000);

    if (this.outboundTimestamps.length >= this.maxOutboundPerMinute) {
      const oldest = this.outboundTimestamps[0];
      const waitTime = 60000 - (now - oldest) + 500;
      logger.warn(`[WhatsAppAdapter] Outbound rate limit near (12/min). Throttling for ${(waitTime / 1000).toFixed(1)}s...`);
      await new Promise((res) => setTimeout(res, waitTime));
    }

    this.outboundTimestamps.push(Date.now());
  }

  /**
   * Enforces 15 poll requests per minute limit.
   */
  async throttlePolling() {
    const now = Date.now();
    this.pollTimestamps = this.pollTimestamps.filter((t) => now - t < 60000);

    if (this.pollTimestamps.length >= this.maxPollsPerMinute) {
      const oldest = this.pollTimestamps[0];
      const waitTime = 60000 - (now - oldest) + 500;
      logger.warn(`[WhatsAppAdapter] Poll rate limit (15/min). Waiting ${(waitTime / 1000).toFixed(1)}s before next poll...`);
      await new Promise((res) => setTimeout(res, waitTime));
    }

    this.pollTimestamps.push(Date.now());
  }

  /**
   * Registers a callback for incoming messages.
   * @param {(message: { from: string, id: string, type: string, text: string, timestamp: number, raw: Object }) => void} callback 
   */
  onIncomingMessage(callback) {
    this.messageHandlers.push(callback);
  }

  /**
   * Dispatches incoming message to registered handlers.
   * @param {Object} message 
   */
  async dispatchIncoming(message) {
    for (const handler of this.messageHandlers) {
      try {
        await handler(message);
      } catch (err) {
        logger.error(`[WhatsAppAdapter] Error in message handler: ${err.message}`);
      }
    }
  }

  /**
   * Starts the long-polling loop.
   */
  async startPolling() {
    if (this.isPolling) return;
    this.isPolling = true;

    logger.info(`[WhatsAppAdapter] Starting long-polling loop against ${this.baseUrl}...`);
    let consecutiveErrors = 0;

    while (this.isPolling) {
      try {
        await this.throttlePolling();

        const url = new URL(`${this.baseUrl}/updates`);
        if (this.offset) {
          url.searchParams.set("offset", this.offset);
        }
        url.searchParams.set("limit", "50");
        url.searchParams.set("timeout", "15");

        const response = await fetch(url.toString(), {
          method: "GET",
          headers: this.getHeaders(),
        });

        // HTTP 204: No new messages, immediately poll again
        if (response.status === 204) {
          consecutiveErrors = 0;
          continue;
        }

        // HTTP 409: Conflict (another poll active or replaced)
        if (response.status === 409) {
          logger.warn("[WhatsAppAdapter] Received 409 Conflict. Retrying poll in 1.5s...");
          await new Promise((res) => setTimeout(res, 1500));
          continue;
        }

        // HTTP 429: Rate limit or 5xx server error
        if (response.status === 429 || response.status >= 500) {
          consecutiveErrors++;
          const backoff = Math.min(3000 * Math.pow(2, consecutiveErrors - 1), 30000);
          logger.warn(`[WhatsAppAdapter] HTTP ${response.status}. Backing off for ${backoff / 1000}s...`);
          await new Promise((res) => setTimeout(res, backoff));
          continue;
        }

        if (!response.ok) {
          const errText = await response.text();
          logger.error(`[WhatsAppAdapter] HTTP ${response.status} from updates: ${errText}`);
          await new Promise((res) => setTimeout(res, 3000));
          continue;
        }

        consecutiveErrors = 0;
        const data = await response.json();

        // Update offset
        if (data.next_offset) {
          this.saveOffset(data.next_offset);
        }

        // Extract all messages across Meta entry changes structure or flat messages
        const incomingMessages = [];
        if (Array.isArray(data.messages)) {
          incomingMessages.push(...data.messages);
        }
        if (Array.isArray(data.entry)) {
          for (const entry of data.entry) {
            if (Array.isArray(entry.changes)) {
              for (const change of entry.changes) {
                if (Array.isArray(change.value?.messages)) {
                  incomingMessages.push(...change.value.messages);
                }
              }
            }
          }
        }

        for (const msg of incomingMessages) {
          await this.handleSingleIncomingMessage(msg);
        }
      } catch (err) {
        consecutiveErrors++;
        const backoff = Math.min(3000 * Math.pow(2, consecutiveErrors - 1), 30000);
        logger.error(`[WhatsAppAdapter] Polling exception: ${err.message}. Retrying in ${backoff / 1000}s...`);
        await new Promise((res) => setTimeout(res, backoff));
      }
    }
  }

  /**
   * Stops the polling loop.
   */
  stopPolling() {
    this.isPolling = false;
    logger.info("[WhatsAppAdapter] Stopped polling loop.");
  }

  /**
   * Processes a single inbound message.
   * @param {Object} msg 
   */
  async handleSingleIncomingMessage(msg) {
    const fromId = msg.from; // e.g. "user:<id>"
    const messageId = msg.id;
    const type = msg.type || "unknown";
    const text = msg.text?.body || "";

    logger.logIncomingMessage({ from: fromId, messageId, type, text });

    // Non-text types: reply in Urdu per official spec
    if (type !== "text") {
      logger.info(`[WhatsAppAdapter] Message ${messageId} is non-text (${type}). Sending standard Urdu notice.`);
      await this.sendTextMessage(fromId, "فی الحال میں صرف تحریری پیغام سمجھ سکتا ہوں۔");
      await this.markAsRead(messageId);
      return;
    }

    // Dispatch to registered message handlers
    await this.dispatchIncoming({
      from: fromId,
      id: messageId,
      type,
      text,
      timestamp: msg.timestamp ? Number(msg.timestamp) * 1000 : Date.now(),
      raw: msg,
    });

    // Mark as read
    await this.markAsRead(messageId);
  }

  /**
   * Marks a message as read.
   * @param {string} messageId 
   */
  async markAsRead(messageId) {
    if (!messageId) return;
    try {
      await this.throttleOutbound();
      const res = await fetch(`${this.baseUrl}/statuses`, {
        method: "POST",
        headers: this.getHeaders(),
        body: JSON.stringify({
          messaging_product: "whatsapp",
          status: "read",
          message_id: messageId,
        }),
      });

      if (!res.ok) {
        const text = await res.text();
        logger.warn(`[WhatsAppAdapter] Failed to mark message ${messageId} as read: ${text}`);
      }
    } catch (err) {
      logger.warn(`[WhatsAppAdapter] markAsRead error: ${err.message}`);
    }
  }

  /**
   * Sends a plain text message to a user.
   * @param {string} toId - User identifier (e.g. "user:<id>")
   * @param {string} text - Message text
   * @returns {Promise<{success: boolean, data?: Object, error?: string}>}
   */
  async sendTextMessage(toId, text) {
    await this.throttleOutbound();
    try {
      const res = await fetch(`${this.baseUrl}/messages`, {
        method: "POST",
        headers: this.getHeaders(),
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: toId,
          type: "text",
          text: {
            body: text,
          },
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        logger.error(`[WhatsAppAdapter] Failed to send text to ${toId}: ${errText}`);
        return { success: false, error: errText };
      }

      const data = await res.json();
      logger.logOutgoingResponse({ to: toId, type: "text", text });
      return { success: true, data };
    } catch (err) {
      logger.error(`[WhatsAppAdapter] sendTextMessage error: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  /**
   * Uploads and sends a file attachment to a user.
   * Respects size limits: Image 5MB, Document/Media 16MB.
   * 
   * @param {string} toId 
   * @param {string} filePath 
   * @returns {Promise<{success: boolean, mediaId?: string, isTooLarge?: boolean, error?: string}>}
   */
  async sendFileMessage(toId, filePath) {
    if (!fs.existsSync(filePath)) {
      return { success: false, error: "FILE_NOT_FOUND" };
    }

    const stats = fs.statSync(filePath);
    const sizeMb = stats.size / (1024 * 1024);
    const ext = path.extname(filePath).toLowerCase();
    const mimeType = getMimeType(filePath);
    const filename = path.basename(filePath);

    // Determine category and size limit:
    // Images (jpg, jpeg, png, webp): 5MB limit
    // Documents / others: 16MB limit
    const isImage = [".jpg", ".jpeg", ".png", ".webp"].includes(ext);
    const maxLimitMb = isImage ? 5 : 16;
    const category = isImage ? "image" : "document";

    if (sizeMb > maxLimitMb) {
      logger.warn(`[WhatsAppAdapter] File ${filename} (${sizeMb.toFixed(1)}MB) exceeds WhatsApp ${maxLimitMb}MB limit.`);
      return {
        success: false,
        isTooLarge: true,
        sizeMb: Number(sizeMb.toFixed(1)),
        maxLimitMb,
        category,
        filename,
      };
    }

    await this.throttleOutbound();

    try {
      // Step 1: Upload media via multipart/form-data
      logger.info(`[WhatsAppAdapter] Uploading media ${filename} (${(stats.size / 1024).toFixed(1)} KB, MIME: ${mimeType})...`);
      
      const fileBuffer = fs.readFileSync(filePath);
      const fileBlob = new Blob([fileBuffer], { type: mimeType });

      const formData = new FormData();
      formData.append("messaging_product", "whatsapp");
      formData.append("file", fileBlob, filename);
      formData.append("type", mimeType);

      const uploadRes = await fetch(`${this.baseUrl}/media`, {
        method: "POST",
        headers: this.getHeaders(true),
        body: formData,
      });

      if (!uploadRes.ok) {
        const errText = await uploadRes.text();
        logger.error(`[WhatsAppAdapter] Media upload failed: ${errText}`);
        return { success: false, error: `MEDIA_UPLOAD_FAILED: ${errText}` };
      }

      const uploadData = await uploadRes.json();
      const mediaId = uploadData.id;
      logger.info(`[WhatsAppAdapter] Media uploaded successfully. Media ID: ${mediaId}`);

      // Step 2: Send message with media attachment
      await this.throttleOutbound();

      const messagePayload = {
        messaging_product: "whatsapp",
        to: toId,
        type: category,
        [category]: {
          id: mediaId,
          filename: filename,
        },
      };

      const sendRes = await fetch(`${this.baseUrl}/messages`, {
        method: "POST",
        headers: this.getHeaders(),
        body: JSON.stringify(messagePayload),
      });

      if (!sendRes.ok) {
        const errText = await sendRes.text();
        logger.error(`[WhatsAppAdapter] Failed to send media message to ${toId}: ${errText}`);
        return { success: false, error: errText };
      }

      const sendData = await sendRes.json();
      logger.logOutgoingResponse({ to: toId, type: category, filePath, mediaId });
      return { success: true, mediaId, data: sendData };
    } catch (err) {
      logger.error(`[WhatsAppAdapter] sendFileMessage error: ${err.message}`);
      return { success: false, error: err.message };
    }
  }
}
