import fs from "fs";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

/**
 * System directories to strictly ignore during search to ensure high performance
 * and avoid permission errors on Windows drives.
 */
const IGNORED_DIRECTORIES = new Set([
  "$recycle.bin",
  "system volume information",
  "windows",
  "appdata",
  "program files",
  "program files (x86)",
  "node_modules",
  ".git",
  ".vscode",
  "temp",
  "tmp",
  "merged_partition_content",
  "softwears",
  "software",
  "softwares",
]);

/**
 * Parses and returns configured search root folders from environment.
 * @returns {string[]}
 */
export function getSearchRootFolders() {
  const rawFolders = process.env.SEARCH_ROOT_FOLDERS || "";
  const folders = rawFolders
    .split(",")
    .map((f) => f.trim())
    .filter(Boolean)
    .map((f) => path.resolve(f))
    .filter((f) => {
      try {
        return fs.existsSync(f) && fs.statSync(f).isDirectory();
      } catch {
        return false;
      }
    });

  return folders;
}

/**
 * Returns the configured maximum file size in megabytes.
 * @returns {number}
 */
export function getMaxFileSizeMb() {
  const val = parseFloat(process.env.MAX_FILE_SIZE_MB);
  return isNaN(val) || val <= 0 ? 95 : val;
}

/**
 * Formats byte size into human readable string.
 * @param {number} bytes 
 * @returns {string}
 */
function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Common stopwords in Urdu and English that should not trigger matches by themselves.
 */
const STOPWORDS = new Set([
  "کا", "کی", "کے", "کو", "میں", "سے", "پر", "تک", "اور", "یا", "یہ", "وہ", "فائل",
  "a", "an", "the", "in", "on", "at", "to", "for", "of", "and", "or", "is", "file",
]);

/**
 * Urdu and Arabic diacritics regex (harakat / aerab / tashkeel):
 * - \u064B-\u065F: Fathatan, Dammatan, Kasratan, Fatha (Zabar), Damma (Pesh), Kasra (Zer), Shaddah, Sukun, etc.
 * - \u0670: Superscript Alef (Khara Zabar)
 * - \u06D6-\u06ED: Quranic / additional Arabic diacritical marks
 */
export const DIACRITICS_REGEX = /[\u064B-\u065F\u0670\u06D6-\u06ED]/g;

/**
 * Strips Arabic and Urdu diacritics (zabar, zer, pesh, jazm, tashdeed) for reliable text matching.
 * @param {string} str 
 * @returns {string}
 */
export function stripDiacritics(str) {
  if (!str) return "";
  return str
    .normalize("NFD")
    .replace(DIACRITICS_REGEX, "")
    .normalize("NFC");
}

/**
 * Normalizes text for comparison (strips diacritics, lowercased, trimmed).
 * Crucial for Urdu, Arabic, and Unicode script matching across filenames and queries.
 * @param {string} str 
 * @returns {string}
 */
export function normalizeText(str) {
  return stripDiacritics(str).toLowerCase().trim();
}

/**
 * Builds a regular expression that matches a search query while ignoring diacritics in the target text.
 * @param {string} query 
 * @returns {RegExp}
 */
export function buildDiacriticRegex(query) {
  const diacriticClass = "[\\u064B-\\u065F\\u0670\\u06D6-\\u06ED]*";
  const clean = stripDiacritics(query);
  const pattern = clean
    .split("")
    .map((char) => {
      if (/\s/.test(char)) return "\\s+";
      const escaped = char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return escaped + diacriticClass;
    })
    .join("");
  return new RegExp(pattern, "i");
}

/**
 * Calculates a match score between a target filename and user search query.
 * Higher score means better match.
 * 
 * @param {string} filename 
 * @param {string} keyword 
 * @returns {number} 0 for no match, > 0 for match
 */
function scoreFilename(filename, keyword) {
  const normFilename = normalizeText(filename);
  const normKeyword = normalizeText(keyword);

  if (!normFilename || !normKeyword) return 0;

  const nameWithoutExt = normFilename.substring(0, normFilename.lastIndexOf(".")) || normFilename;

  // 1. Exact match on filename without extension
  if (nameWithoutExt === normKeyword) {
    return 100;
  }

  // 2. Exact match on full filename
  if (normFilename === normKeyword) {
    return 98;
  }

  // 3. Keyword is a direct substring of filename
  if (normFilename.includes(normKeyword)) {
    const ratio = normKeyword.length / normFilename.length;
    return 85 + Math.round(ratio * 10); // 85 to 95
  }

  // 4. Token-based matching (for multi-word queries like "خط جنوری")
  const allTokens = normKeyword.split(/\s+/).filter(Boolean);
  if (allTokens.length > 1) {
    // Separate content words from stopwords
    const contentTokens = allTokens.filter((t) => !STOPWORDS.has(t));
    const tokensToEvaluate = contentTokens.length > 0 ? contentTokens : allTokens;

    let matchedContentTokens = 0;
    for (const token of tokensToEvaluate) {
      if (normFilename.includes(token)) {
        matchedContentTokens++;
      }
    }

    if (matchedContentTokens === tokensToEvaluate.length) {
      return 75; // All meaningful content words present in filename
    } else if (matchedContentTokens > 0) {
      return Math.round((matchedContentTokens / tokensToEvaluate.length) * 50); // Partial content words present
    }
  }

  return 0;
}

/**
 * Inserts a match into the collector, keeping top candidates sorted by score.
 * 
 * @param {Array<Object>} collector 
 * @param {Object} item 
 * @param {number} maxCapacity 
 */
function addToCollector(collector, item, maxCapacity = 50) {
  collector.push(item);
  if (collector.length > maxCapacity * 2) {
    // Prune lowest scores
    collector.sort((a, b) => b.score - a.score);
    collector.splice(maxCapacity);
  }
}

/**
 * Recursively searches a directory for files matching the keyword.
 * Stops descending into system or ignored directories.
 * 
 * @param {string} dirPath 
 * @param {string} keyword 
 * @param {Array<Object>} resultsCollector 
 * @param {number} maxDepth 
 * @param {number} currentDepth 
 */
async function crawlDirectory(dirPath, keyword, resultsCollector, maxDepth = 10, currentDepth = 0) {
  // If we already have 5+ very high confidence matches (score >= 85), stop searching deeper
  if (currentDepth > maxDepth || resultsCollector.filter((m) => m.score >= 85).length >= 5) {
    return;
  }

  let entries;
  try {
    entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
  } catch {
    // Skip directories with EPERM, EACCES, or read errors
    return;
  }

  const subDirs = [];

  for (const entry of entries) {
    const entryName = entry.name;
    const lowerName = entryName.toLowerCase();

    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(lowerName) && !entryName.startsWith(".")) {
        subDirs.push(path.join(dirPath, entryName));
      }
    } else if (entry.isFile()) {
      const score = scoreFilename(entryName, keyword);
      if (score > 0) {
        try {
          const fullPath = path.join(dirPath, entryName);
          const stats = await fs.promises.stat(fullPath);
          const maxSizeBytes = getMaxFileSizeMb() * 1024 * 1024;
          const isTooLarge = stats.size > maxSizeBytes;

          addToCollector(resultsCollector, {
            path: fullPath,
            filename: entryName,
            score,
            sizeBytes: stats.size,
            sizeFormatted: formatFileSize(stats.size),
            modifiedDate: stats.mtime.toISOString(),
            isTooLarge,
            maxSizeMb: getMaxFileSizeMb(),
          });

          if (resultsCollector.filter((m) => m.score >= 85).length >= 5) {
            return;
          }
        } catch {
          // File stat failed, continue
        }
      }
    }
  }

  // Descend into subdirectories
  for (const subDir of subDirs) {
    if (resultsCollector.filter((m) => m.score >= 85).length >= 5) break;
    await crawlDirectory(subDir, keyword, resultsCollector, maxDepth, currentDepth + 1);
  }
}

/**
 * Searches for files across configured SEARCH_ROOT_FOLDERS.
 * 
 * @param {string} keyword - Search term/filename (Urdu or English)
 * @param {string} [preferredDrive] - Optional drive letter (e.g. "D:\\", "D:", "C:\\")
 * @returns {Promise<{
 *   success: boolean,
 *   keyword: string,
 *   count: number,
 *   matches: Array<{
 *     path: string,
 *     filename: string,
 *     score: number,
 *     sizeBytes: number,
 *     sizeFormatted: string,
 *     modifiedDate: string,
 *     isTooLarge: boolean,
 *     maxSizeMb: number
 *   }>
 * }>}
 */
export async function searchFiles(keyword, preferredDrive = null) {
  if (!keyword || typeof keyword !== "string" || keyword.trim() === "") {
    return { success: false, keyword: "", count: 0, matches: [], message: "Keyword must be a non-empty string." };
  }

  const rootFolders = getSearchRootFolders();
  if (rootFolders.length === 0) {
    return {
      success: false,
      keyword,
      count: 0,
      matches: [],
      message: "No valid SEARCH_ROOT_FOLDERS configured or found on disk. Please configure SEARCH_ROOT_FOLDERS in .env.",
    };
  }

  // Prioritize root folders matching preferredDrive if provided
  let orderedRoots = [...rootFolders];
  if (preferredDrive && typeof preferredDrive === "string") {
    const cleanDrive = preferredDrive.replace(/\\|\//g, "").toUpperCase();
    orderedRoots.sort((a, b) => {
      const aRoot = path.parse(a).root.replace(/\\|\//g, "").toUpperCase();
      const bRoot = path.parse(b).root.replace(/\\|\//g, "").toUpperCase();
      if (aRoot === cleanDrive && bRoot !== cleanDrive) return -1;
      if (bRoot === cleanDrive && aRoot !== cleanDrive) return 1;
      return 0;
    });
  }

  const collected = [];

  for (const root of orderedRoots) {
    await crawlDirectory(root, keyword, collected);
    // If we already have strong matches (score >= 90), we don't necessarily need to crawl all other drives
    if (collected.filter((m) => m.score >= 90).length >= 5) {
      break;
    }
  }

  // Sort matches by:
  // 1. Highest score
  // 2. Most recent modification date
  collected.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return new Date(b.modifiedDate).getTime() - new Date(a.modifiedDate).getTime();
  });

  // Return up to 5 best matches
  const topMatches = collected.slice(0, 5);

  return {
    success: true,
    keyword,
    count: topMatches.length,
    matches: topMatches,
  };
}

/**
 * Maximum file size in MB to read and parse for content search.
 */
const MAX_CONTENT_SCAN_SIZE_MB = 20;

/**
 * Supported file extensions for content scanning.
 */
const SUPPORTED_CONTENT_EXTENSIONS = new Set([".docx", ".doc", ".txt"]);

/**
 * Extracts a surrounding snippet of ~100 characters before and after the keyword.
 * Uses diacritic-insensitive matching.
 * 
 * @param {string} text 
 * @param {string} keyword 
 * @returns {{snippet: string, isExact: boolean} | null}
 */
export function extractSnippet(text, keyword) {
  if (!text || !keyword) return null;

  // 1. Primary: match exact phrase ignoring any diacritics
  try {
    const regex = buildDiacriticRegex(keyword);
    const match = regex.exec(text);

    if (match) {
      const idx = match.index;
      const matchLen = match[0].length;
      const start = Math.max(0, idx - 100);
      const end = Math.min(text.length, idx + matchLen + 100);
      let snippet = text.substring(start, end).replace(/\s+/g, " ").trim();
      if (start > 0) snippet = "..." + snippet;
      if (end < text.length) snippet = snippet + "...";
      return { snippet, isExact: true };
    }
  } catch {
    // Fallback if regex fails on unusual input
  }

  // 2. Multi-word fallback: ALL non-stopword tokens must be present in the document
  const normKeyword = normalizeText(keyword);
  const tokens = normKeyword.split(/\s+/).filter((t) => !STOPWORDS.has(t) && t.length > 1);
  if (tokens.length > 1) {
    const matches = [];
    for (const token of tokens) {
      try {
        const tokenRegex = buildDiacriticRegex(token);
        const tokenMatch = tokenRegex.exec(text);
        if (!tokenMatch) return null; // If ANY required token is missing, reject document
        matches.push(tokenMatch);
      } catch {
        return null;
      }
    }

    // All tokens are present! Build snippet around the first token found
    const firstMatch = matches[0];
    const idx = firstMatch.index;
    const matchLen = firstMatch[0].length;
    const start = Math.max(0, idx - 80);
    const end = Math.min(text.length, idx + matchLen + 80);
    let snippet = text.substring(start, end).replace(/\s+/g, " ").trim();
    if (start > 0) snippet = "..." + snippet;
    if (end < text.length) snippet = snippet + "...";
    return { snippet, isExact: false };
  }

  return null;
}

/**
 * Extracts plain text from .docx, .doc, or .txt file.
 * @param {string} filePath 
 * @param {string} ext 
 * @returns {Promise<string>}
 */
async function extractTextFromFile(filePath, ext) {
  try {
    if (ext === ".txt") {
      return await fs.promises.readFile(filePath, "utf8");
    }
    if (ext === ".docx") {
      const mammoth = (await import("mammoth")).default;
      const result = await mammoth.extractRawText({ path: filePath });
      return result.value || "";
    }
    if (ext === ".doc") {
      const WordExtractor = (await import("word-extractor")).default;
      const extractor = new WordExtractor();
      const extracted = await extractor.extract(filePath);
      return extracted.getBody() || "";
    }
  } catch (err) {
    // Corrupted, locked, or unreadable document
  }
  return "";
}

/**
 * Recursively crawls directory searching within the contents of Word and text files.
 * @param {string} dirPath 
 * @param {string} keyword 
 * @param {Array<Object>} resultsCollector 
 * @param {number} maxResults 
 * @param {number} maxDepth 
 * @param {number} currentDepth 
 * @param {number} startTime
 */
async function crawlDirectoryContents(
  dirPath,
  keyword,
  resultsCollector,
  maxResults = 5,
  maxDepth = 5,
  currentDepth = 0,
  startTime = Date.now()
) {
  // Stop if reached max depth, max exact results, or search timeout (15s)
  if (
    currentDepth > maxDepth ||
    resultsCollector.filter((m) => m.isExact).length >= maxResults ||
    Date.now() - startTime > 15000
  ) {
    return;
  }

  let entries;
  try {
    entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
  } catch {
    return;
  }

  const subDirs = [];

  for (const entry of entries) {
    if (resultsCollector.filter((m) => m.isExact).length >= maxResults) break;

    const entryName = entry.name;
    const lowerName = entryName.toLowerCase();

    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(lowerName) && !entryName.startsWith(".")) {
        subDirs.push(path.join(dirPath, entryName));
      }
    } else if (entry.isFile()) {
      const ext = path.extname(entryName).toLowerCase();
      if (SUPPORTED_CONTENT_EXTENSIONS.has(ext)) {
        try {
          const fullPath = path.join(dirPath, entryName);
          const stats = await fs.promises.stat(fullPath);

          // Skip files exceeding max content scan threshold
          if (stats.size > MAX_CONTENT_SCAN_SIZE_MB * 1024 * 1024) {
            continue;
          }

          const text = await extractTextFromFile(fullPath, ext);
          const matchResult = extractSnippet(text, keyword);

          if (matchResult) {
            const maxSizeBytes = getMaxFileSizeMb() * 1024 * 1024;
            resultsCollector.push({
              path: fullPath,
              filename: entryName,
              snippet: matchResult.snippet,
              isExact: matchResult.isExact,
              sizeBytes: stats.size,
              sizeFormatted: formatFileSize(stats.size),
              modifiedDate: stats.mtime.toISOString(),
              isTooLarge: stats.size > maxSizeBytes,
              maxSizeMb: getMaxFileSizeMb(),
            });

            if (resultsCollector.filter((m) => m.isExact).length >= maxResults) {
              return;
            }
          }
        } catch {
          // Skip on stat/read error
        }
      }
    }
  }

  // Sort subdirectories: prioritize folders by year number descending, then by modification time
  subDirs.sort((a, b) => {
    const nameA = path.basename(a);
    const nameB = path.basename(b);
    const matchA = nameA.match(/(20\d\d)/);
    const matchB = nameB.match(/(20\d\d)/);
    const yearA = matchA ? parseInt(matchA[1], 10) : 0;
    const yearB = matchB ? parseInt(matchB[1], 10) : 0;
    if (yearA !== yearB) return yearB - yearA;
    try {
      return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs;
    } catch {
      return 0;
    }
  });

  for (const subDir of subDirs) {
    if (
      resultsCollector.filter((m) => m.isExact).length >= maxResults ||
      Date.now() - startTime > 15000 ||
      (currentDepth === 0 && resultsCollector.filter((m) => m.isExact).length >= 2)
    ) {
      break;
    }
    await crawlDirectoryContents(
      subDir,
      keyword,
      resultsCollector,
      maxResults,
      maxDepth,
      currentDepth + 1,
      startTime
    );
  }
}

/**
 * Searches within the text contents of Word (.docx, .doc) and text (.txt) files.
 * 
 * @param {string} keyword - Word or phrase to find inside document contents
 * @param {string} [preferredDrive] - Optional drive to prioritize
 * @returns {Promise<{
 *   success: boolean,
 *   keyword: string,
 *   count: number,
 *   matches: Array<{
 *     path: string,
 *     filename: string,
 *     snippet: string,
 *     sizeBytes: number,
 *     sizeFormatted: string,
 *     modifiedDate: string,
 *     isTooLarge: boolean,
 *     maxSizeMb: number
 *   }>
 * }>}
 */
export async function searchFileContents(keyword, preferredDrive = null) {
  if (!keyword || typeof keyword !== "string" || keyword.trim() === "") {
    return { success: false, keyword: "", count: 0, matches: [], message: "Keyword must be a non-empty string." };
  }

  const rootFolders = getSearchRootFolders();
  if (rootFolders.length === 0) {
    return {
      success: false,
      keyword,
      count: 0,
      matches: [],
      message: "No valid SEARCH_ROOT_FOLDERS configured.",
    };
  }

  let orderedRoots = [...rootFolders];
  if (preferredDrive && typeof preferredDrive === "string") {
    const cleanDrive = preferredDrive.replace(/\\|\//g, "").toUpperCase();
    orderedRoots.sort((a, b) => {
      const aRoot = path.parse(a).root.replace(/\\|\//g, "").toUpperCase();
      const bRoot = path.parse(b).root.replace(/\\|\//g, "").toUpperCase();
      if (aRoot === cleanDrive && bRoot !== cleanDrive) return -1;
      if (bRoot === cleanDrive && aRoot !== cleanDrive) return 1;
      return 0;
    });
  }

  const collected = [];

  for (const root of orderedRoots) {
    await crawlDirectoryContents(root, keyword, collected, 5);
    if (collected.length >= 5) {
      break;
    }
  }

  // Sort matches:
  // 1. Exact phrase matches first
  // 2. Most recent modification date
  collected.sort((a, b) => {
    if (a.isExact && !b.isExact) return -1;
    if (!a.isExact && b.isExact) return 1;
    return new Date(b.modifiedDate).getTime() - new Date(a.modifiedDate).getTime();
  });

  const topMatches = collected.slice(0, 5);

  return {
    success: true,
    keyword,
    count: topMatches.length,
    matches: topMatches,
  };
}
