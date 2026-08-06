import "dotenv/config";

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const config = {
  telegramToken: required("TELEGRAM_BOT_TOKEN"),
  chatId: String(required("TELEGRAM_CHAT_ID")),
  anthropicKey: required("ANTHROPIC_API_KEY"),
  notionToken: required("NOTION_TOKEN"),
  tz: process.env.TZ || "America/New_York",
  model: "claude-opus-4-8",
};

// Notion Command Center IDs (database IDs, for the classic integration API).
export const notionDb = {
  goals: "2b6f49c1c2ad475e81691951268237cc",
  tasks: "abcbe4e27a7044a1a6601880038b8d36",
  dailyPlan: "a1b6523a90854ae69e7d86c4d4f12260",
  reminders: "37323a123d81448d918b9daa8c455e64",
  hubPage: "3b4a2f74deaa81cc9cf6d3a187d8d336",
};
