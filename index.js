import "dotenv/config";

import express from "express"; // Express server for webhook handling
import TelegramBot from "node-telegram-bot-api"; // Telegram Bot API client
import OpenAI from "openai"; // OpenAI SDK for Assistants API
import axios from "axios"; // HTTP client for keep-alive ping
import fs from "fs"; // File system for thread persistence

// Load required environment variables
const {
  TELEGRAM_TOKEN,
  OPENAI_API_KEY,
  ASSISTANT_ID,
  BOT_SECRET,
  BOT_USERNAME = "SiharaPrakBot",
  PORT = 3000,
  RENDER_EXTERNAL_URL,
} = process.env;

// Validate required environment variables
if (
  !TELEGRAM_TOKEN ||
  !OPENAI_API_KEY ||
  !ASSISTANT_ID ||
  !BOT_SECRET ||
  !RENDER_EXTERNAL_URL
) {
  console.error("Missing required environment variables.");
  process.exit(1);
}

// Initialize Express application
const app = express();
app.use(express.json());

// Initialize Telegram bot without polling
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });

// Initialize OpenAI client
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// Define thread storage file path
const THREADS_FILE = "./sihara_threads.json";

// Load persisted threads from disk
let threads = {};
if (fs.existsSync(THREADS_FILE)) {
  try {
    threads = JSON.parse(fs.readFileSync(THREADS_FILE, "utf8"));
  } catch {
    threads = {};
  }
}

// Persist threads to disk
function saveThreads() {
  fs.writeFileSync(THREADS_FILE, JSON.stringify(threads, null, 2));
}

// Generate a unique thread key per chat and user
function getThreadKey(chatId, userId) {
  return `${chatId}:${userId}`;
}

// Retrieve or create an OpenAI thread for a user
async function getOrCreateThread(chatId, userId) {
  const key = getThreadKey(chatId, userId);
  if (threads[key]) return threads[key];
  const thread = await openai.beta.threads.create();
  threads[key] = thread.id;
  saveThreads();
  return thread.id;
}

console.log("Processing message:", text);
// Send user input to the assistant and return the response
async function runAssistant(chatId, userId, userText) {
  const threadId = await getOrCreateThread(chatId, userId);
  await openai.beta.threads.messages.create(threadId, {
    role: "user",
    content: userText,
  });
  const run = await openai.beta.threads.runs.createAndPoll(threadId, {
    assistant_id: ASSISTANT_ID,
  });
  if (run.status !== "completed") {
    throw new Error(`Assistant run failed with status: ${run.status}`);
  }
  const messages = await openai.beta.threads.messages.list(threadId, {
    limit: 5,
  });
  const assistantMessage = messages.data.find(
    (m) => m.role === "assistant"
  );
  return assistantMessage?.content?.[0]?.text?.value || "No response generated.";
  console.log("Run status:", run.status);
}

// Construct Telegram webhook URL
const WEBHOOK_URL = `${RENDER_EXTERNAL_URL}/webhook/${BOT_SECRET}`;

// Register Telegram webhook on startup
await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/setWebhook`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ url: WEBHOOK_URL }),
});

app.use((req, res, next) => {
  console.log("Incoming request:", req.method, req.url);
  next();
}); 

// Handle incoming Telegram webhook updates
app.post(`/webhook/${BOT_SECRET}`, (req, res) => {
  res.sendStatus(200); // Immediately acknowledge Telegram to avoid webhook timeouts

  (async () => {
    try {
      const message = req.body?.message;
      if (!message || !message.text) return; // Ignore non-text updates

      const chatId = message.chat.id;
      const userId = message.from?.id;
      const chatType = message.chat.type;
      let text = message.text.trim();

      const isPrivate = chatType === "private";
      const mentionTag = `@${BOT_USERNAME}`;

      if (!isPrivate && !text.includes(mentionTag)) return; // Only respond in groups when mentioned

      if (!isPrivate) {
        text = text.replace(mentionTag, "").trim(); // Strip mention before sending to assistant
      }

      const reply = await runAssistant(chatId, userId, text); // Process message through OpenAI Assistant

      await bot.sendMessage(chatId, reply, {
        reply_to_message_id: message.message_id,
      });
    } catch (err) {
      console.error("Webhook processing error:", err.message); // Log async processing errors
    }
  })();
});

// Health check endpoint for Render
app.get("/", (req, res) => {
  res.send("SiharaPrakBot is running.");
});

// Start HTTP server
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

// Periodic self-ping to prevent Render sleep
setInterval(async () => {
  try {
    await axios.get(RENDER_EXTERNAL_URL);
  } catch (err) {
    console.error("Self-ping failed:", err.message);
  }
}, 180000);
