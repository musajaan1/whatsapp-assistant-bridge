# WhatsApp Personal Assistant Bridge (Windows)

An automated Windows desktop bridge connecting **WhatsApp's "Connect your own agents" platform** to **Google Gemini AI** and your local computer's drives.

---

## What This Assistant Does

1. **Intelligent Urdu AI Chat & Summaries**:
   - Responds to greetings, general questions, advice, and text summarization requests in fluent, polite, natural Urdu script.
2. **Local Windows Drive File Search (Filename & Content)**:
   - **Filename Search**: Searches across local drives using Urdu and English partial/fuzzy matching (e.g. `"شوگر کا مجرب عمل"`).
   - **Deep Content Search**: Reads inside Word documents (`.docx`, `.doc`) and plain text files (`.txt`) for specific phrases (e.g. `"کس فائل میں مُسکراتا میدان لکھا ہے"`), returning context preview snippets.
3. **Direct WhatsApp File Delivery**:
   - Uploads and sends found files directly to your WhatsApp chat as document or image attachments.
   - If multiple matching files are found, presents a clean numbered list and waits for your number choice before sending.
   - Enforces WhatsApp size thresholds (5 MB for images, 16 MB for documents/media) and politely informs you in Urdu if a file exceeds the limit.
4. **Restricted Access Security**:
   - Only processes requests from your authorized WhatsApp sender ID (`ALLOWED_WHATSAPP_SENDER`), ignoring anyone else.
5. **Continuous Windows Background Service**:
   - Runs 24/7 in the background via PM2, auto-restarting if interrupted and launching automatically on Windows boot.

---

## Architecture Overview

```text
[ WhatsApp User ] 
       │ (Long-Polling / GET /agent/v1/updates)
       ▼
[ adapters/whatsapp-adapter.js ] ──► [ core/message-router.js ]
                                            │
                    ┌───────────────────────┴───────────────────────┐
                    ▼                                               ▼
       [ services/gemini-service.js ]               [ services/file-search-service.js ]
        - classifyIntent()                           - searchFiles(keyword, drive)
        - generateReply() [Urdu]                     - Unicode NFC normalization
        - extractFileNameFromRequest()               - System directory exclusion
                    │                                               │
                    └───────────────────────┬───────────────────────┘
                                            ▼
                             [ adapters/whatsapp-adapter.js ]
                              - sendTextMessage()
                              - sendFileMessage() (POST /agent/v1/media)
```

- **`index.js`**: Core entry point initializing the long-poll listener and graceful shutdown handlers.
- **`adapters/whatsapp-adapter.js`**: Connects to `https://api.whatsapp.com/agent/v1` using long-polling (`/updates`), handles HTTP 204/409/429 with backoff, uploads multipart media, and enforces rate limits (12 req/min outbound, 15 req/min polling).
- **`core/message-router.js`**: Verifies sender authorization, maintains multi-turn session state for numbered file picks, and routes by intent.
- **`services/gemini-service.js`**: Wraps Google Generative AI (default: `gemini-2.5-flash`), with structured JSON classification and Urdu generation.
- **`services/file-search-service.js`**: High-performance recursive crawler across `SEARCH_ROOT_FOLDERS` skipping Windows system paths (`$RECYCLE.BIN`, `Windows`, `AppData`, `node_modules`).
- **`services/logger-service.js`**: Structured daily JSONL logs in `./logs/conversation-YYYY-MM-DD.jsonl`.

---

## Configuration (`.env`)

Create or update `.env` in the project root:

```env
# Google Gemini API Key
GEMINI_API_KEY=your_gemini_api_key_here
GEMINI_MODEL=gemini-2.5-flash

# WhatsApp Agent Platform Credentials
WHATSAPP_ACCESS_TOKEN=your_whatsapp_access_token_here
WHATSAPP_API_BASE_URL=https://api.whatsapp.com/agent/v1

# Allowed WhatsApp sender ID (e.g. user:147678793064690)
ALLOWED_WHATSAPP_SENDER=user:147678793064690

# Comma-separated list of drive or folder paths to search
SEARCH_ROOT_FOLDERS=D:\,F:\,G:\,H:\

# Maximum file size allowed to be sent over WhatsApp (in MB, default 16 for documents, 5 for images)
MAX_FILE_SIZE_MB=16

# Directory where application logs and conversation logs will be stored
LOG_FOLDER=./logs
```

---

## Windows Background Persistence (PM2)

To keep the application running 24/7 in the background without keeping a terminal open, and to make it automatically start whenever your Windows PC boots up, follow these steps in **PowerShell (Run as Administrator)**:

### Step 1: Install PM2 Globally
Installs PM2 (Node.js Process Manager) on your computer.
```powershell
npm install -g pm2
```

### Step 2: Install the Windows Startup Helper
Installs `pm2-windows-startup`, which configures PM2 to register as a Windows background task/service on boot.
```powershell
npm install -g pm2-windows-startup
```

### Step 3: Configure Windows Boot Registration
Registers PM2 with Windows Task Scheduler so it automatically runs on startup.
```powershell
pm2-startup install
```

### Step 4: Start the Application with PM2
Starts the bridge using the included [`ecosystem.config.cjs`](file:///f:/WhatsApp%20Personal%20Assistant%20Bridge/ecosystem.config.cjs) profile.
```powershell
pm2 start ecosystem.config.cjs
```

### Step 5: Save Current Process List
Saves the running application list so PM2 knows to restore and run it on system reboot.
```powershell
pm2 save
```

---

## How to Manage the Running Service

| Task | Command | Description |
| :--- | :--- | :--- |
| **Check Status** | `pm2 status` | Displays process health, uptime, CPU, and memory usage. |
| **View Live Logs** | `pm2 logs whatsapp-assistant-bridge` | Streams live console logs and incoming messages. |
| **Restart App** | `pm2 restart whatsapp-assistant-bridge` | Safely restarts the process (useful after modifying `.env`). |
| **Stop App** | `pm2 stop whatsapp-assistant-bridge` | Pauses the background listener. |
| **Start App** | `pm2 start whatsapp-assistant-bridge` | Resumes the background listener. |

---

## Testing & Diagnostics

```powershell
# Test Gemini AI classification and Urdu replies
npm run test:gemini

# Test local drive file search with custom keyword (by filename)
npm run test:file-search "شوگر کا مجرب عمل"

# Test deep content search inside Word (.docx, .doc) and text (.txt) files
npm run test:content-search "مُسکراتا میدان"
```
