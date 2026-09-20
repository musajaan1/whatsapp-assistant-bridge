import dotenv from "dotenv";
import { WhatsAppAdapter } from "./adapters/whatsapp-adapter.js";
import { routeIncomingMessage } from "./core/message-router.js";
import { logger } from "./services/logger-service.js";

dotenv.config();

console.log("\n=======================================================");
console.log("   WhatsApp Personal Assistant Bridge (Windows)");
console.log("=======================================================\n");

// Validate configuration
const geminiKey = process.env.GEMINI_API_KEY;
if (!geminiKey || geminiKey === "your_gemini_api_key_here") {
  logger.error("GEMINI_API_KEY is missing or invalid in .env! Please add it before starting.");
  process.exit(1);
}

const whatsappToken = process.env.WHATSAPP_ACCESS_TOKEN;
if (!whatsappToken || whatsappToken === "your_whatsapp_access_token_here") {
  logger.warn("WHATSAPP_ACCESS_TOKEN is missing in .env! Long-polling requires a valid access token.");
}

const adapter = new WhatsAppAdapter();

// Wire incoming message router
adapter.onIncomingMessage(async (message) => {
  try {
    await routeIncomingMessage(message, adapter);
  } catch (err) {
    logger.error(`[Main] Unhandled error while routing message: ${err.message}`);
  }
});

// Start long-polling
adapter.startPolling().catch((err) => {
  logger.error(`[Main] Fatal error in polling loop: ${err.message}`);
});

logger.info("Application is running. Waiting for incoming WhatsApp messages...");

// Handle graceful shutdown
function handleShutdown(signal) {
  logger.info(`Received ${signal}. Shutting down WhatsApp Assistant Bridge gracefully...`);
  adapter.stopPolling();
  setTimeout(() => process.exit(0), 1000);
}

process.on("SIGINT", () => handleShutdown("SIGINT"));
process.on("SIGTERM", () => handleShutdown("SIGTERM"));
