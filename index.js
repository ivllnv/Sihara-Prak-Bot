import "dotenv/config";

import express from "express";
import TelegramBot from "node-telegram-bot-api";
import OpenAI from "openai";
import axios from "axios";
import fs from "fs";

// 🔴 PROMPT VERSION — bump when instructions change
const PROMPT_VERSION = "1.2";

// Thread storage file
const THREADS_FILE = "./sihara_threads.json";

// 🔴 ONE-TIME RESET AFTER DEPLOY
if (fs.existsSync(THREADS_FILE)) {
  fs.unlinkSync(THREADS_FILE);
  console.log("✅ Old OpenAI threads cleared on startup");
}

// Load environment variables
const {
  TELEGRAM_TOKEN,
  OPENAI_API_KEY,
  ASSISTANT_ID,
  BOT_SECRET,
  BOT_USERNAME = "SiharaPrakBot",
  PORT = 3000,
  RENDER_EXTERNAL_URL,
} = process.env;

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

// Express app
const app = express();
app.use(express.json());

// Telegram bot
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });

// OpenAI client
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// Load threads
let threads = {};
if (fs.existsSync(THREADS_FILE)) {
  try {
    threads = JSON.parse(fs.readFileSync(THREADS_FILE, "utf8"));
  } catch {
    threads = {};
  }
}

// Save threads
function saveThreads() {
  fs.writeFileSync(THREADS_FILE, JSON.stringify(threads, null, 2));
}

// Thread key
function getThreadKey(chatId, userId) {
  return `${chatId}:${userId}`;
}

// Get or create thread (with versioning)
async function getOrCreateThread(chatId, userId) {
  const key = getThreadKey(chatId, userId);
  const existing = threads[key];

  if (
    existing &&
    existing.thread_id &&
    existing.prompt_version === PROMPT_VERSION
  ) {
    return existing.thread_id;
  }

  const thread = await openai.beta.threads.create();

  threads[key] = {
    thread_id: thread.id,
    prompt_version: PROMPT_VERSION,
  };

  saveThreads();
  return thread.id;
}

// Run assistant
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
    throw new Error(`Assistant run failed: ${run.status}`);
  }

  const messages = await openai.beta.threads.messages.list(threadId, {
    limit: 5,
  });

  const assistantMessage = messages.data.find(
    (m) => m.role === "assistant"
  );

  return assistantMessage?.content?.[0]?.text?.value || "No response.";
}

// Webhook
const WEBHOOK_URL = `${RENDER_EXTERNAL_URL}/webhook/${BOT_SECRET}`;

await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/setWebhook`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ url: WEBHOOK_URL }),
});

app.post(`/webhook/${BOT_SECRET}`, (req, res) => {
  res.sendStatus(200);

  (async () => {
    try {
      const message = req.body?.message;
      if (!message?.text) return;

      const chatId = message.chat.id;
      const userId = message.from?.id;
      const chatType = message.chat.type;
      let text = message.text.trim();

      const isPrivate = chatType === "private";
      const mention = `@${BOT_USERNAME}`;

      if (!isPrivate && !text.includes(mention)) return;
      if (!isPrivate) text = text.replace(mention, "").trim();

      const reply = await runAssistant(chatId, userId, text);

      await bot.sendMessage(chatId, reply, {
        reply_to_message_id: message.message_id,
      });
    } catch (err) {
      console.error("Webhook error:", err);
    }
  })();
});

// Health check
app.get("/", (req, res) => {
  res.send(`SiharaPrakBot running | prompt ${PROMPT_VERSION}`);
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

// Prevent Render sleep
setInterval(async () => {
  try {
    await axios.get(RENDER_EXTERNAL_URL);
  } catch {}
}, 180000);
