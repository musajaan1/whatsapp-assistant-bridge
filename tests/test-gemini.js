import { classifyIntent, generateReply, extractFileNameFromRequest } from "../services/gemini-service.js";

const colors = {
  reset: "\x1b[0m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  bold: "\x1b[1m",
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runGeminiTests() {
  console.log(`${colors.cyan}${colors.bold}=== Starting Gemini Service Tests (Phase 1) ===${colors.reset}\n`);

  try {
    // -------------------------------------------------------------
    // Test 1: Intent Classification
    // -------------------------------------------------------------
    console.log(`${colors.yellow}${colors.bold}[TEST 1: classifyIntent]${colors.reset}`);
    const classificationSamples = [
      { text: "السلام علیکم، کیا حال ہے؟ آپ میری کیا مدد کر سکتے ہیں؟", expected: "GENERAL_CHAT" },
      { text: "D ڈرائیو میں خط جنوری فائل بھیجیں", expected: "FILE_REQUEST" },
      { text: "اس تحریر کا مختصر خلاصہ بیان کریں: جدید ٹیکنالوجی نے مواصلات کو بہت تیز اور آسان بنا دیا ہے، جس سے دنیا سمٹ کر ایک گاؤں بن گئی ہے۔", expected: "SUMMARIZE_REQUEST" },
    ];

    for (const sample of classificationSamples) {
      console.log(`\nInput: "${sample.text}"`);
      const result = await classifyIntent(sample.text);
      console.log(`Result: ${JSON.stringify(result, null, 2)}`);
      const isMatch = result.intent === sample.expected;
      console.log(`Status: ${isMatch ? `${colors.green}✓ PASS` : `${colors.red}✗ FAIL (Expected ${sample.expected})`}${colors.reset}`);
      await delay(1200);
    }

    // -------------------------------------------------------------
    // Test 2: Reply Generation in Urdu
    // -------------------------------------------------------------
    console.log(`\n${colors.yellow}${colors.bold}[TEST 2: generateReply (Urdu Output)]${colors.reset}`);
    const chatPrompt = "آپ کس طرح میری روزمرہ فائلوں اور کاموں میں مدد کر سکتے ہیں؟";
    console.log(`\nUser Query: "${chatPrompt}"`);
    const reply = await generateReply(chatPrompt);
    console.log(`${colors.green}Assistant Reply (Urdu):${colors.reset}\n${reply}`);
    await delay(1200);

    // -------------------------------------------------------------
    // Test 3: File Parameter Extraction
    // -------------------------------------------------------------
    console.log(`\n${colors.yellow}${colors.bold}[TEST 3: extractFileNameFromRequest]${colors.reset}`);
    const fileRequests = [
      "D ڈرائیو میں خط جنوری فائل بھیجیں",
      "C ڈرائیو سے budget 2024.xlsx فائل تلاش کر کے دیں",
      "مجھے آفس کی سالانہ رپورٹ پی ڈی ایف بھیجیں",
    ];

    for (const req of fileRequests) {
      console.log(`\nRequest: "${req}"`);
      const extracted = await extractFileNameFromRequest(req);
      console.log(`Extracted: ${JSON.stringify(extracted, null, 2)}`);
      await delay(1200);
    }

    console.log(`\n${colors.green}${colors.bold}=== All Phase 1 Tests Completed Successfully ===${colors.reset}\n`);
  } catch (error) {
    console.error(`\n${colors.red}${colors.bold}Test Failed with Error:${colors.reset}`, error.message);
    if (error.message.includes("GEMINI_API_KEY")) {
      console.log(`\n${colors.yellow}Please ensure your valid GEMINI_API_KEY is placed in .env and try again.${colors.reset}`);
    }
    process.exit(1);
  }
}

runGeminiTests();
