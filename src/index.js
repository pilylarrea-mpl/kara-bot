import { Bot } from "grammy";
import cron from "node-cron";
import { config } from "./config.js";
import { runAgent } from "./agent.js";
import { loadHistory, saveHistory } from "./store.js";
import { proactivePrompts } from "./kara.js";
import { dueReminders, markFollowUpAsked } from "./notion.js";

const bot = new Bot(config.telegramToken);

// Serialize agent runs so proactive ticks and chat replies don't corrupt history.
let chain = Promise.resolve();
function enqueue(fn) {
  chain = chain.then(fn).catch((e) => console.error("run error:", e));
  return chain;
}

async function send(text) {
  const chunks = text.match(/[\s\S]{1,3800}/g) || [text];
  for (const c of chunks) await bot.api.sendMessage(config.chatId, c);
}

// Shared, continuous thread so Kara remembers across chat + proactive slots.
async function runTurn(userText) {
  const history = loadHistory();
  history.push({ role: "user", content: userText });
  const { text, messages } = await runAgent(history);
  saveHistory(messages);
  await send(text);
}

// ---------- Telegram: reply to Pilar only ----------
bot.on("message:text", async (ctx) => {
  if (String(ctx.chat.id) !== config.chatId) return;
  const text = ctx.message.text;
  if (text.startsWith("/start")) {
    await send("👋 Kara's live and always on now. Text me anything — tasks, reminders, 'plan my day', 'what's on my plate'. I'll also check in at 7, 12, 3, and 9.");
    return;
  }
  await bot.api.sendChatAction(config.chatId, "typing").catch(() => {});
  enqueue(() => runTurn(text));
});

// ---------- Proactive heartbeat ----------
function scheduleSlot(expr, key) {
  cron.schedule(expr, () => enqueue(() => runTurn(`[Scheduled ${key} slot] ${proactivePrompts[key]}`)), {
    timezone: config.tz,
  });
}
scheduleSlot("0 7 * * *", "morning");
scheduleSlot("0 12 * * *", "midday");
scheduleSlot("0 15 * * *", "afternoon");
scheduleSlot("0 21 * * *", "evening");

// ---------- Reminder follow-ups (every minute) ----------
cron.schedule("* * * * *", () =>
  enqueue(async () => {
    let due = [];
    try {
      due = await dueReminders();
    } catch (e) {
      console.error("reminder check failed:", e);
      return;
    }
    for (const r of due) {
      const msg = `⏰ ${r.reminder} — did you get to it? (reply: done / not yet / snooze)`;
      // Record the ping in the shared conversation so her reply has full context
      // (which reminder, and its id — so she can update the right one).
      const history = loadHistory();
      history.push({
        role: "user",
        content: `[system note: your reminder "${r.reminder}" (id ${r.id}) just fired at its scheduled time — you are now pinging Pilar about it]`,
      });
      history.push({ role: "assistant", content: msg });
      saveHistory(history);
      await send(msg);
      await markFollowUpAsked(r.id).catch((e) => console.error("markFollowUp:", e));
    }
  })
);

bot.catch((err) => console.error("bot error:", err));
bot.start({ onStart: () => console.log("Kara is live.") });
console.log(`Kara starting — tz=${config.tz}, model=${config.model}`);
