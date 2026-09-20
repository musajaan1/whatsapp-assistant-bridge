import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import dotenv from "dotenv";

dotenv.config();

/**
 * Validates and retrieves the Gemini API client.
 * @returns {GoogleGenerativeAI}
 */
function getClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey.trim() === "" || apiKey === "your_gemini_api_key_here") {
    throw new Error(
      "GEMINI_API_KEY is not set or invalid in your .env file. Please add your key to proceed."
    );
  }
  return new GoogleGenerativeAI(apiKey.trim());
}

/**
 * Checks if an error is caused by Gemini rate-limits, quota exhaustion, or API unavailability.
 * @param {Error | any} err 
 * @returns {boolean}
 */
export function isGeminiQuotaError(err) {
  if (!err) return false;
  const msg = (err.message || "").toLowerCase();
  const status = err.status || err.statusCode;
  return (
    status === 429 ||
    status === 503 ||
    msg.includes("429") ||
    msg.includes("quota") ||
    msg.includes("resource_exhausted") ||
    msg.includes("rate limit") ||
    msg.includes("too many requests") ||
    msg.includes("perday") ||
    msg.includes("daily") ||
    msg.includes("service unavailable")
  );
}

/**
 * Executes an async Gemini API call with exponential backoff on 429 (rate-limit) errors.
 * @template T
 * @param {() => Promise<T>} fn 
 * @param {number} [maxRetries=3] 
 * @param {number} [baseDelayMs=3000] 
 * @returns {Promise<T>}
 */
async function callWithRetry(fn, maxRetries = 3, baseDelayMs = 4000) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const isRateLimit = isGeminiQuotaError(err);
      const isDailyQuota =
        err?.message?.includes("PerDay") ||
        err?.message?.includes("per day") ||
        err?.message?.includes("Daily");

      if (isDailyQuota) {
        // Daily quota limit cannot be resolved by backoff, throw immediately
        throw err;
      }

      if (isRateLimit && attempt < maxRetries) {
        const delay = Math.max(baseDelayMs * Math.pow(1.5, attempt), 5000);
        console.warn(`[GeminiService] Rate limit hit. Waiting ${(delay / 1000).toFixed(1)}s before retry (attempt ${attempt + 1}/${maxRetries})...`);
        await new Promise((res) => setTimeout(res, delay));
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

/**
 * Gets the model name from environment or defaults to gemini-2.5-flash.
 * @returns {string}
 */
function getModelName() {
  return process.env.GEMINI_MODEL || "gemini-2.5-flash";
}

/**
 * Classifies an incoming message into one of:
 * - "GENERAL_CHAT"
 * - "FILE_REQUEST"
 * - "SUMMARIZE_REQUEST"
 * - "CONTENT_SEARCH_REQUEST"
 * 
 * @param {string} messageText 
 * @returns {Promise<{intent: "GENERAL_CHAT" | "FILE_REQUEST" | "SUMMARIZE_REQUEST" | "CONTENT_SEARCH_REQUEST", confidence: number, reasoning: string}>}
 */
export async function classifyIntent(messageText) {
  if (!messageText || typeof messageText !== "string") {
    throw new Error("Message text must be a non-empty string");
  }

  const ai = getClient();
  const model = ai.getGenerativeModel({
    model: getModelName(),
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: {
        type: SchemaType.OBJECT,
        properties: {
          intent: {
            type: SchemaType.STRING,
            enum: ["GENERAL_CHAT", "FILE_REQUEST", "SUMMARIZE_REQUEST", "CONTENT_SEARCH_REQUEST"],
            description: "The classified user intent",
          },
          confidence: {
            type: SchemaType.NUMBER,
            description: "Confidence score between 0 and 1",
          },
          reasoning: {
            type: SchemaType.STRING,
            description: "Brief reason for classification",
          },
        },
        required: ["intent", "confidence", "reasoning"],
      },
    },
    systemInstruction:
      "You are an intent classification engine for a WhatsApp Personal Assistant. " +
      "Analyze the user's message (which may be in Urdu, English, or Roman Urdu) and classify it into:\n" +
      "- 'CONTENT_SEARCH_REQUEST': The user asks to search INSIDE the text/content of Word documents or text files for a specific word, phrase, sentence, or topic (e.g. 'کس فائل میں فلاں لفظ ہے', 'فلاں لفظ والی فائل ڈھونڈو', 'find files containing this text').\n" +
      "- 'FILE_REQUEST': The user is asking to find, search, or send a specific file by its file name, extension, or title from their computer drives.\n" +
      "- 'SUMMARIZE_REQUEST': The user asks to summarize, explain, or condense a provided text, article, or document content.\n" +
      "- 'GENERAL_CHAT': Greetings, small talk, questions, general knowledge, asking for advice, translation, or any other general assistance.",
  });

  const prompt = `Classify this message:\n"${messageText}"`;
  const result = await callWithRetry(() => model.generateContent(prompt));
  const responseText = result.response.text();
  
  return JSON.parse(responseText);
}

/**
 * Generates a natural, fluent Urdu reply for general chat or summarization queries.
 * 
 * @param {string} messageText 
 * @param {string} [context=""] Optional background context or conversation history
 * @returns {Promise<string>} Natural Urdu text reply
 */
export async function generateReply(messageText, context = "") {
  if (!messageText || typeof messageText !== "string") {
    throw new Error("Message text must be a non-empty string");
  }

  const ai = getClient();
  const model = ai.getGenerativeModel({
    model: getModelName(),
    systemInstruction:
      "آپ ایک مددگار اور شائستہ واٹس ایپ پرسنل اسسٹنٹ ہیں۔ " +
      "آپ کے تمام جوابات لازمی طور پر شستہ، روانی سے بھرپور اور قدرتی اردو رسم الخط (Urdu script) میں ہونے چاہئیں۔ " +
      "صارف کے سوال یا خلاصہ کے تقاضے کا تسلی بخش، جامع اور پرخلوص جواب دیں۔ رومن اردو یا انگریزی استعمال نہ کریں، صرف معیاری اردو لکھیں۔",
  });

  const fullPrompt = context
    ? `سیاق و سباق (Context):\n${context}\n\nصارف کا پیغام:\n${messageText}`
    : messageText;

  const result = await callWithRetry(() => model.generateContent(fullPrompt));
  return result.response.text().trim();
}

/**
 * Extracts target search keyword/filename and mentioned drive/folder from a file request.
 * 
 * @param {string} messageText 
 * @returns {Promise<{keyword: string, drive: string | null, fileExtension: string | null}>}
 */
export async function extractFileNameFromRequest(messageText) {
  if (!messageText || typeof messageText !== "string") {
    throw new Error("Message text must be a non-empty string");
  }

  const ai = getClient();
  const model = ai.getGenerativeModel({
    model: getModelName(),
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: {
        type: SchemaType.OBJECT,
        properties: {
          keyword: {
            type: SchemaType.STRING,
            description: "The extracted target file name or search keyword (cleaned of file command phrases)",
          },
          drive: {
            type: SchemaType.STRING,
            nullable: true,
            description: "The drive letter mentioned (e.g. 'D:\\' or 'C:\\'), or null if no drive mentioned",
          },
          fileExtension: {
            type: SchemaType.STRING,
            nullable: true,
            description: "File extension if specified (e.g. '.pdf', '.docx', '.xlsx'), or null",
          },
        },
        required: ["keyword"],
      },
    },
    systemInstruction:
      "You are a file query parser for a Windows desktop assistant. " +
      "The user will ask in Urdu, English, or mixed language to retrieve or find a file. " +
      "Your task is to extract:\n" +
      "1. 'keyword': The actual name or search query for the file, stripping away request phrases like 'مجھے فائل بھیجو', 'send me', 'ڈھونڈیں', 'تلاش کریں'. Keep the filename in its original script (Urdu or English).\n" +
      "2. 'drive': If the user explicitly mentions a drive like 'D drive', 'سی ڈرائیو', 'D:', format it as 'D:\\' or 'C:\\'. If not specified, set to null.\n" +
      "3. 'fileExtension': If the user specifies an extension (like pdf, word, excel, txt, etc.), format it as '.pdf', '.docx', etc. Otherwise null.",
  });

  const prompt = `Extract file parameters from this request:\n"${messageText}"`;
  const result = await callWithRetry(() => model.generateContent(prompt));
  const responseText = result.response.text();
  
  return JSON.parse(responseText);
}

/**
 * Extracts target keyword/phrase and mentioned drive from a content search request.
 * 
 * @param {string} messageText 
 * @returns {Promise<{keyword: string, drive: string | null}>}
 */
export async function extractSearchKeyword(messageText) {
  if (!messageText || typeof messageText !== "string") {
    throw new Error("Message text must be a non-empty string");
  }

  const ai = getClient();
  const model = ai.getGenerativeModel({
    model: getModelName(),
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: {
        type: SchemaType.OBJECT,
        properties: {
          keyword: {
            type: SchemaType.STRING,
            description: "The specific word, phrase, sentence, or text to search for inside document contents",
          },
          drive: {
            type: SchemaType.STRING,
            nullable: true,
            description: "The drive letter mentioned (e.g. 'D:\\' or 'C:\\'), or null if no drive mentioned",
          },
        },
        required: ["keyword"],
      },
    },
    systemInstruction:
      "You are a text-content query extractor for a WhatsApp Personal Assistant. " +
      "The user will ask in Urdu, English, or mixed language to find Word or text files that contain a specific word or phrase. " +
      "Extract:\n" +
      "1. 'keyword': The exact word or text phrase to search for inside documents (strip away command words like 'کس فائل میں ہے', 'ڈھونڈو', 'تلاش کریں', 'والی فائل'). Keep the original script.\n" +
      "2. 'drive': The drive letter mentioned (e.g. 'D:\\' or 'C:\\') or null.",
  });

  const prompt = `Extract the content search keyword from this request:\n"${messageText}"`;
  const result = await callWithRetry(() => model.generateContent(prompt));
  const responseText = result.response.text();
  
  return JSON.parse(responseText);
}
