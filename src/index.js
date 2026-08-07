import { Bot } from "grammy";
import cron from "node-cron";
import { config } from "./config.js";
import { runAgent } from "./agent.js";
import { loadHistory, saveHistory } from "./store.js";
import { proactivePrompts } from "./kara.js";
import { dueReminders, markFollowUpAsked, listPendingMeetings, setLogProcessing } from "./notion.js";
import { endedBlocks, markBlockFollowedUp } from "./calendar.js";
import { transcribeAudio, transcribeEnabled } from "./transcribe.js";

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
// allowSkip: for quiet proactive scans — if Kara outputs the SKIP sentinel
// (nothing new to report), don't message Pilar and don't persist the exchange.
async function runTurn(userText, { allowSkip = false } = {}) {
  const history = loadHistory();
  history.push({ role: "user", content: userText });
  const { text, messages } = await runAgent(history);
  if (allowSkip && /^\s*SKIP\b/i.test(text)) return;
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

// ---------- Telegram: voice notes → transcribe → treat like a text message ----------
// Pilar can talk at Kara (great for ADHD brain-dumps). We download the audio,
// transcribe it, and feed the text through the same agent turn as a typed message.
async function handleVoice(ctx) {
  if (String(ctx.chat.id) !== config.chatId) return;
  if (!transcribeEnabled) {
    await send("I can't hear voice notes yet — text me and I'll get right on it.");
    return;
  }
  await bot.api.sendChatAction(config.chatId, "typing").catch(() => {});
  try {
    const file = await ctx.getFile(); // works for voice, audio, and video notes
    const url = `https://api.telegram.org/file/bot${config.telegramToken}/${file.file_path}`;
    const resp = await fetch(url);
    const buf = Buffer.from(await resp.arrayBuffer());
    const { text, ok } = await transcribeAudio(buf, "voice.ogg");
    if (!ok || !text) {
      await send("Couldn't quite make that out — mind sending it again or typing it?");
      return;
    }
    // Mark it as spoken so Kara reflects it back and parses rambling dumps well.
    enqueue(() => runTurn(`[Voice note transcript] ${text}`));
  } catch (e) {
    console.error("voice handling failed:", e);
    await send("Had trouble with that voice note — try again in a sec, or type it.");
  }
}
bot.on("message:voice", handleVoice);
bot.on("message:audio", handleVoice);
bot.on("message:video_note", handleVoice);

// ---------- Proactive heartbeat ----------
function scheduleSlot(expr, key, opts = {}) {
  cron.schedule(expr, () => enqueue(() => runTurn(`[Scheduled ${key} slot] ${proactivePrompts[key]}`, opts)), {
    timezone: config.tz,
  });
}
scheduleSlot("0 7 * * *", "morning");
scheduleSlot("0 8 * * *", "lookahead", { allowSkip: true }); // daily prep scan — silent when nothing new
scheduleSlot("0 12 * * *", "midday");
scheduleSlot("0 15 * * *", "afternoon");
scheduleSlot("0 21 * * *", "evening");
scheduleSlot("0 18 * * 0", "weekly"); // Sunday 6pm ET — plan the week

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

// ---------- Time-block accountability (every minute) ----------
// When a focus/work block on the calendar ends, ping to check it got done and
// help her stop and move to the next thing (need #5 + #9).
cron.schedule("* * * * *", () =>
  enqueue(async () => {
    let blocks = [];
    try {
      blocks = await endedBlocks();
    } catch (e) {
      console.error("block check failed:", e);
      return;
    }
    for (const b of blocks) {
      const msg = `⏱️ Your "${b.title}" block just wrapped — did you finish it? (done / need more time / didn't get to it)`;
      const history = loadHistory();
      history.push({
        role: "user",
        content: `[system note: the calendar focus block "${b.title}"${b.taskId ? ` (task id ${b.taskId})` : ""} just ended at its scheduled time — you are pinging Pilar to check if she finished, mark the task done if she confirms, and help her transition to the next block. If she's not done, briefly offer to extend it or move it, then nudge her onward.]`,
      });
      history.push({ role: "assistant", content: msg });
      saveHistory(history);
      await send(msg);
      await markBlockFollowedUp(b.id).catch((e) => console.error("markBlock:", e));
    }
  })
);

// ---------- Meeting review (every 15 min) ----------
// New meeting notes filed by the claude.ai Plaud routine → Kara pings Pilar to
// confirm the proposed to-dos before filing them as tasks/reminders.
cron.schedule("*/15 * * * *", () =>
  enqueue(async () => {
    let pending = [];
    try {
      pending = await listPendingMeetings({ status: "Needs review" });
    } catch (e) {
      console.error("meeting review check failed:", e);
      return;
    }
    for (const m of pending) {
      // Let Kara compose the ping: read the entry, recap it, list proposed to-dos, ask to confirm.
      await runTurn(
        `[Meeting review] A new meeting entry "${m.title}" (id ${m.id}, area ${m.area || "unclassified"}) was just filed and needs Pilar's review. Use get_log_entry to read it, then message her: a one-line recap of what the meeting/call was, the concrete to-dos you extracted (numbered), and ask her to confirm which are real before you file them as tasks/reminders. If the area is unclear or wrong, also ask whether it was health, work, personal, etc. Do NOT create tasks yet — wait for her confirmation.`
      );
      // Mark as pinged so it isn't re-surfaced next cycle (she'll confirm in chat).
      await setLogProcessing({ entry_id: m.id, status: "Awaiting confirm" }).catch((e) =>
        console.error("setLogProcessing:", e)
      );
    }
  })
);

bot.catch((err) => console.error("bot error:", err));
bot.start({ onStart: () => console.log("Kara is live.") });
console.log(`Kara starting — tz=${config.tz}, model=${config.model}`);
