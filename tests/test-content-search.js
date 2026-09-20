import { searchFileContents, getSearchRootFolders } from "../services/file-search-service.js";
import { classifyIntent, extractSearchKeyword } from "../services/gemini-service.js";

const colors = {
  reset: "\x1b[0m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  bold: "\x1b[1m",
};

async function runContentSearchTests() {
  console.log(`${colors.cyan}${colors.bold}=== Starting Content-Based File Search Tests (Phase 5) ===${colors.reset}\n`);

  // Test 1: Intent Classification for content search
  console.log(`${colors.yellow}${colors.bold}[TEST 1: classifyIntent & extractSearchKeyword]${colors.reset}`);
  const sampleMessage = "کس فائل میں مُسکراتا میدان لکھا ہے؟";
  console.log(`User Input: "${sampleMessage}"`);

  const intentResult = await classifyIntent(sampleMessage);
  console.log(`Intent Result: ${JSON.stringify(intentResult, null, 2)}`);
  const isContentIntent = intentResult.intent === "CONTENT_SEARCH_REQUEST";
  console.log(`Intent Status: ${isContentIntent ? `${colors.green}✓ PASS (CONTENT_SEARCH_REQUEST)` : `${colors.red}✗ FAIL (Got ${intentResult.intent})`}${colors.reset}\n`);

  await new Promise((r) => setTimeout(r, 3000));

  const extractedParams = await extractSearchKeyword(sampleMessage);
  console.log(`Extracted Parameters: ${JSON.stringify(extractedParams, null, 2)}\n`);

  await new Promise((r) => setTimeout(r, 2000));

  // Test 2: Deep content scan across roots
  console.log(`${colors.yellow}${colors.bold}[TEST 2: searchFileContents across drives]${colors.reset}`);
  const keyword = process.argv[2] || "مُسکراتا میدان";
  const preferredDrive = process.argv[3] || null;

  const roots = getSearchRootFolders();
  console.log(`Roots: [ ${roots.join(", ")} ]`);
  console.log(`Searching for keyword: "${keyword}" (Drive: ${preferredDrive || "All"})...`);

  const startTime = Date.now();
  const result = await searchFileContents(keyword, preferredDrive);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);

  console.log(`\nSearch completed in ${elapsed}s. Found: ${result.count} match(es).\n`);

  if (result.matches.length > 0) {
    result.matches.forEach((file, idx) => {
      console.log(`${colors.green}${idx + 1}. 📄 ${file.filename} (${file.sizeFormatted})${colors.reset}`);
      console.log(`   Path: ${file.path}`);
      console.log(`   Modified: ${file.modifiedDate}`);
      console.log(`   Snippet: "${file.snippet}"\n`);
    });
  } else {
    console.log(`${colors.yellow}No Word or text files containing "${keyword}" were found.${colors.reset}\n`);
  }

  console.log(`${colors.green}${colors.bold}=== Content Search Tests Completed ===${colors.reset}`);
}

runContentSearchTests().catch((err) => {
  console.error(`${colors.red}Test Failed:${colors.reset}`, err);
  process.exit(1);
});
