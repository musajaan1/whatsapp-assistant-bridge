import { searchFiles, getSearchRootFolders, getMaxFileSizeMb } from "../services/file-search-service.js";

const colors = {
  reset: "\x1b[0m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  bold: "\x1b[1m",
};

async function runFileSearchTests() {
  console.log(`${colors.cyan}${colors.bold}=== Starting File Search Service Tests (Phase 2) ===${colors.reset}\n`);

  const configuredRoots = getSearchRootFolders();
  const maxMb = getMaxFileSizeMb();

  console.log(`${colors.yellow}Configured Root Folders:${colors.reset}`, configuredRoots.length > 0 ? configuredRoots : "[None configured in SEARCH_ROOT_FOLDERS]");
  console.log(`${colors.yellow}Max File Size Allowed:${colors.reset} ${maxMb} MB\n`);

  if (configuredRoots.length === 0) {
    console.log(`${colors.red}${colors.bold}No SEARCH_ROOT_FOLDERS found or valid in .env!${colors.reset}`);
    console.log(`Please add your drive or folder paths to .env (e.g. SEARCH_ROOT_FOLDERS=D:\\,C:\\Users\\YourName\\Documents)\n`);
    process.exit(1);
  }

  // Get search keyword from command line arguments or environment or default to test query
  const keywordToTest = process.env.TEST_KEYWORD || process.argv[2] || "شوگر کا مجرب عمل";
  const preferredDriveToTest = process.argv[3] || null;

  console.log(`Searching for keyword: "${keywordToTest}" (preferred drive: ${preferredDriveToTest || "None"})...`);
  const startTime = Date.now();
  const result = await searchFiles(keywordToTest, preferredDriveToTest);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);

  console.log(`Search completed in ${elapsed}s. Found: ${result.count} match(es).\n`);

  if (result.matches.length > 0) {
    result.matches.forEach((file, index) => {
      console.log(`${colors.green}${index + 1}. [Score: ${file.score}] ${file.filename}${colors.reset}`);
      console.log(`   Path: ${file.path}`);
      console.log(`   Size: ${file.sizeFormatted} ${file.isTooLarge ? `${colors.red}(EXCEEDS ${file.maxSizeMb}MB LIMIT)${colors.reset}` : `${colors.green}(OK to send)${colors.reset}`}`);
      console.log(`   Modified: ${file.modifiedDate}\n`);
    });
  } else {
    console.log(`${colors.yellow}No files matching "${keywordToTest}" were found in the configured folders.${colors.reset}\n`);
  }

  console.log(`${colors.green}${colors.bold}=== File Search Test Run Finished ===${colors.reset}`);
}

runFileSearchTests().catch((err) => {
  console.error(`${colors.red}Error:${colors.reset}`, err);
  process.exit(1);
});
