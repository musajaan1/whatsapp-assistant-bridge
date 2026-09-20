import { classifyIntent, generateReply, extractFileNameFromRequest, extractSearchKeyword } from "../services/gemini-service.js";
import { searchFiles, searchFileContents } from "../services/file-search-service.js";
import { logger } from "../services/logger-service.js";

// Multi-turn session state for pending file selections keyed by user ID
const userSessions = new Map();

/**
 * Checks if incoming user is authorized.
 * If ALLOWED_WHATSAPP_SENDER is not configured, allows all and prints discovery guidance.
 * 
 * @param {string} fromId 
 * @returns {boolean}
 */
function isSenderAllowed(fromId) {
  const allowed = (process.env.ALLOWED_WHATSAPP_SENDER || "").trim();
  if (!allowed) {
    console.log(
      `\x1b[35m\x1b[1m[DISCOVERED SENDER ID]: "${fromId}"\x1b[0m\n` +
      `\x1b[35mTo restrict access to only your number, set ALLOWED_WHATSAPP_SENDER=${fromId} in .env\x1b[0m`
    );
    return true;
  }

  // Exact match or sanitized digits match
  if (fromId === allowed || fromId === `user:${allowed}`) {
    return true;
  }

  const cleanAllowed = allowed.replace(/\D/g, "");
  const cleanFrom = fromId.replace(/\D/g, "");
  return cleanAllowed && cleanFrom && cleanFrom.endsWith(cleanAllowed);
}

/**
 * Parses user input to determine if it is a number selection for multi-file results.
 * @param {string} text 
 * @param {number} maxRange 
 * @returns {number | null} 1-based index or null
 */
function parseNumberedSelection(text, maxRange) {
  const cleaned = text.trim();
  // Check direct digit: "1", "2", "3"
  const digitMatch = cleaned.match(/^(\d+)$/);
  if (digitMatch) {
    const num = parseInt(digitMatch[1], 10);
    if (num >= 1 && num <= maxRange) return num;
  }

  // Check Urdu numbers or phrases: "نمبر 1", "پہلی", etc.
  const urduNumberMap = {
    "پہلی": 1,
    "دوسری": 2,
    "تیسری": 3,
    "چوتھی": 4,
    "پانچویں": 5,
    "ایک": 1,
    "دو": 2,
    "تین": 3,
    "چار": 4,
    "پانچ": 5,
  };

  for (const [key, val] of Object.entries(urduNumberMap)) {
    if (cleaned.includes(key) && val <= maxRange) {
      return val;
    }
  }

  const phraseMatch = cleaned.match(/(?:نمبر|option|choice)\s*(\d+)/i);
  if (phraseMatch) {
    const num = parseInt(phraseMatch[1], 10);
    if (num >= 1 && num <= maxRange) return num;
  }

  return null;
}

/**
 * Main message orchestrator.
 * 
 * @param {Object} message - Incoming message object
 * @param {import('../adapters/whatsapp-adapter.js').WhatsAppAdapter} adapter - WhatsApp adapter instance
 */
export async function routeIncomingMessage(message, adapter) {
  const { from: fromId, text, id: messageId } = message;

  // 1. Authorization check
  if (!isSenderAllowed(fromId)) {
    logger.warn(`[MessageRouter] Unauthorized message from ${fromId} ignored.`);
    return;
  }

  // 2. Check for pending multi-file selection state
  if (userSessions.has(fromId)) {
    const session = userSessions.get(fromId);
    // Expire session after 10 minutes
    if (Date.now() - session.timestamp < 10 * 60 * 1000) {
      const selectedIndex = parseNumberedSelection(text, session.pendingMatches.length);
      if (selectedIndex !== null) {
        const chosenFile = session.pendingMatches[selectedIndex - 1];
        userSessions.delete(fromId);

        logger.info(`[MessageRouter] User ${fromId} selected file #${selectedIndex}: ${chosenFile.filename}`);
        await adapter.sendTextMessage(
          fromId,
          `آپ نے منتخب کیا: "${chosenFile.filename}"\nفائل ارسال کی جا رہی ہے...`
        );

        const result = await adapter.sendFileMessage(fromId, chosenFile.path);
        if (!result.success) {
          if (result.isTooLarge) {
            await adapter.sendTextMessage(
              fromId,
              `معذرت، منتخب کردہ فائل "${chosenFile.filename}" کا سائز (${chosenFile.sizeFormatted}) واٹس ایپ کی زیادہ سے زیادہ حد (${result.maxLimitMb} MB) سے زیادہ ہے۔`
            );
          } else {
            await adapter.sendTextMessage(
              fromId,
              `فائل بھیجنے میں خرابی پیش آئی: ${result.error || "نامعلوم خرابی"}`
            );
          }
        }
        return;
      }
    } else {
      userSessions.delete(fromId);
    }
  }

  // 3. Classify intent with Gemini
  let classification;
  try {
    classification = await classifyIntent(text);
  } catch (err) {
    logger.error(`[MessageRouter] Intent classification error: ${err.message}`);
    // Fallback: treat as general chat
    classification = { intent: "GENERAL_CHAT", confidence: 0.5, reasoning: "Fallback due to classification error" };
  }

  logger.logIntent({
    messageId,
    from: fromId,
    text,
    intent: classification.intent,
    confidence: classification.confidence,
    reasoning: classification.reasoning,
  });

  // 4. Route by Intent
  if (classification.intent === "FILE_REQUEST") {
    // Extract file search parameters
    let params;
    try {
      params = await extractFileNameFromRequest(text);
    } catch (err) {
      logger.error(`[MessageRouter] Extraction error: ${err.message}`);
      params = { keyword: text, drive: null, fileExtension: null };
    }

    const keyword = params.keyword || text;
    const drive = params.drive || null;

    logger.info(`[MessageRouter] Searching for keyword: "${keyword}" (Drive: ${drive || "All"})...`);
    const searchResult = await searchFiles(keyword, drive);

    logger.logSearch({
      from: fromId,
      keyword,
      drive,
      resultCount: searchResult.count,
      matches: searchResult.matches.map((m) => ({ name: m.filename, size: m.sizeFormatted })),
    });

    // 4a. No files found
    if (searchResult.count === 0) {
      await adapter.sendTextMessage(
        fromId,
        `معذرت، آپ کی تلاش کردہ فائل "${keyword}" کمپیوٹر کی ڈرائیوز میں نہیں مل سکی۔ براہ کرم فائل کا نام یا ہجے چیک کر کے دوبارہ بتائیں۔`
      );
      return;
    }

    // 4b. Exactly 1 file found
    if (searchResult.count === 1) {
      const file = searchResult.matches[0];
      await adapter.sendTextMessage(
        fromId,
        `فائل مل گئی ہے:\n📄 *${file.filename}*\nسائز: ${file.sizeFormatted}\nارسال کی جا رہی ہے...`
      );

      const sendResult = await adapter.sendFileMessage(fromId, file.path);
      if (!sendResult.success) {
        if (sendResult.isTooLarge) {
          await adapter.sendTextMessage(
            fromId,
            `معذرت، فائل "${file.filename}" کا سائز (${file.sizeFormatted}) واٹس ایپ کی زیادہ سے زیادہ حد (${sendResult.maxLimitMb} MB) سے زیادہ ہے، اس لیے اسے منسلک نہیں کیا جا سکا۔`
          );
        } else {
          await adapter.sendTextMessage(
            fromId,
            `فائل بھیجنے میں خرابی پیش آئی: ${sendResult.error || "نامعلوم خرابی"}`
          );
        }
      }
      return;
    }

    // 4c. Multiple files found (2 to 5)
    // Store in session and prompt user to pick one
    userSessions.set(fromId, {
      pendingMatches: searchResult.matches,
      timestamp: Date.now(),
    });

    let listPrompt = `آپ کے مطلوبہ نام سے ${searchResult.count} فائلیں ملی ہیں۔ براہ کرم جس فائل کو حاصل کرنا چاہتے ہیں، اس کا *نمبر* لکھ کر بھیجیں:\n\n`;
    searchResult.matches.forEach((file, idx) => {
      listPrompt += `*${idx + 1}.* ${file.filename}\n   سائز: ${file.sizeFormatted} | راستہ: \`${file.path}\`\n\n`;
    });

    await adapter.sendTextMessage(fromId, listPrompt.trim());
    return;
  }

  // 5. CONTENT_SEARCH_REQUEST -> Deep search inside Word (.docx, .doc) and text (.txt) files
  if (classification.intent === "CONTENT_SEARCH_REQUEST") {
    // Send immediate intermediate notification
    await adapter.sendTextMessage(fromId, "تلاش جاری ہے، براہ کرم انتظار کریں...");

    let params;
    try {
      params = await extractSearchKeyword(text);
    } catch (err) {
      logger.error(`[MessageRouter] Keyword extraction error: ${err.message}`);
      params = { keyword: text, drive: null };
    }

    const keyword = params.keyword || text;
    const drive = params.drive || null;

    logger.info(`[MessageRouter] Searching file contents for: "${keyword}" (Drive: ${drive || "All"})...`);
    const searchResult = await searchFileContents(keyword, drive);

    logger.logSearch({
      from: fromId,
      keyword,
      drive,
      resultCount: searchResult.count,
      matches: searchResult.matches.map((m) => ({ name: m.filename, size: m.sizeFormatted })),
    });

    if (searchResult.count === 0) {
      await adapter.sendTextMessage(
        fromId,
        `معذرت، کمپیوٹر کی ورڈ یا ٹیکسٹ فائلوں میں "${keyword}" کا متن نہیں مل سکا۔`
      );
      return;
    }

    // Save matches in session so user can reply with number to fetch file
    userSessions.set(fromId, {
      pendingMatches: searchResult.matches,
      timestamp: Date.now(),
    });

    let listPrompt = `آپ کے مطلوبہ متن کے حامل ${searchResult.count} دستاویزات مل گئے ہیں:\n\n`;
    searchResult.matches.forEach((file, idx) => {
      listPrompt += `*${idx + 1}.* 📄 ${file.filename} (${file.sizeFormatted})\n`;
      listPrompt += `   *اقتباس:* "${file.snippet}"\n`;
      listPrompt += `   *راستہ:* \`${file.path}\`\n\n`;
    });

    listPrompt += `جس فائل کو حاصل کرنا چاہتے ہیں، اس کا *نمبر* لکھ کر بھیجیں۔`;
    await adapter.sendTextMessage(fromId, listPrompt.trim());
    return;
  }

  // 6. GENERAL_CHAT or SUMMARIZE_REQUEST -> Natural Urdu reply from Gemini
  try {
    const reply = await generateReply(text);
    await adapter.sendTextMessage(fromId, reply);
  } catch (err) {
    logger.error(`[MessageRouter] Error generating reply: ${err.message}`);
    await adapter.sendTextMessage(
      fromId,
      "معذرت، اس وقت جواب تیار کرنے میں دشواری پیش آ رہی ہے۔ براہ کرم کچھ دیر بعد دوبارہ کوشش کریں۔"
    );
  }
}
