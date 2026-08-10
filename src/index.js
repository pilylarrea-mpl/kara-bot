import { Bot } from "grammy";
import cron from "node-cron";
import { config } from "./config.js";
import { runAgent } from "./agent.js";
import { loadHistory, saveHistory } from "./store.js";
import { proactivePrompts } from "./kara.js";
import { dueReminders, listPendingMeetings, setLogProcessing } from "./notion.js";
import { endedBlocks, markBlockFollowedUp } from "./calendar.js";
import { transcribeAudio, transcribeEnabled } from "./transcribe.js";
import { shouldPingReminder, markReminderPinged } from "./memory.js";

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

// Human-readable current time in Pilar's timezone, stamped on every incoming
// message so Kara always knows the real "now" and how much time passed between
// messages — she can't mistake this morning's message for last night's.
function nowStamp() {
  return (
    new Date().toLocaleString("en-US", {
      timeZone: config.tz,
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }) + " ET"
  );
}

// Shared, continuous thread so Kara remembers across chat + proactive slots.
// allowSkip: for quiet proactive scans — if Kara outputs the SKIP sentinel
// (nothing new to report), don't message Pilar and don't persist the exchange.
async function runTurn(userText, { allowSkip = false } = {}) {
  const history = loadHistory();
  history.push({ role: "user", content: `[${nowStamp()}] ${userText}` });
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
// Kara re-pings each due reminder on an interval until Pilar marks it Done — she
// never drops one after a single ask. Quiet hours (10pm–7am ET) are skipped so
// she isn't buzzed overnight; a still-open reminder resumes in the morning.
const REPING_MS = 60 * 60 * 1000; // re-ask at most once an hour
function wakingHourET() {
  const h = Number(
    new Intl.DateTimeFormat("en-US", { timeZone: config.tz, hour: "2-digit", hour12: false }).format(new Date())
  );
  return h >= 7 && h < 22;
}
cron.schedule("* * * * *", () =>
  enqueue(async () => {
    if (!wakingHourET()) return;
    let due = [];
    try {
      due = await dueReminders();
    } catch (e) {
      console.error("reminder check failed:", e);
      return;
    }
    // Only the ones it's actually time to (re-)ask about, and batch them into a
    // SINGLE conversational turn so Kara follows up in her own voice — checking
    // what she already knows, marking off what's done — instead of firing a
    // robotic "reply done/not yet/snooze" template per reminder.
    const toAsk = due.filter((r) => shouldPingReminder(r.id, REPING_MS));
    if (!toAsk.length) return;
    const list = toAsk.map((r, i) => `${i + 1}. "${r.reminder}" (id ${r.id}, was due ${r.time})`).join("\n");
    await runTurn(
      `[Reminder follow-up — compose in YOUR OWN voice, this is not a template] These reminders are past due and still marked Pending in Notion:\n${list}\n\n` +
        `Before you message her: check your durable memory AND the recent conversation. If she already told you any of these are done (or clearly did them), call update_reminder to mark those Done and do NOT ask about them again. For anything genuinely still open, follow up in ONE short, warm, human message — group them naturally, no numbered checklist, no "reply done/not yet/snooze" boilerplate, don't sound like a cron job. If several are stale morning-routine items, acknowledge that lightly rather than interrogating each. If nothing is actually still open, mark them done and send nothing more than a light note (or stay quiet). Keep it to a few lines.`
    );
    for (const r of toAsk) markReminderPinged(r.id);
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
      // Route through Kara's brain so the check-in is in her own voice, not a
      // canned template.
      await runTurn(
        `[Focus block ended — compose in YOUR OWN voice] Pilar's calendar block "${b.title}"${b.taskId ? ` (task id ${b.taskId})` : ""} just ended at its scheduled time. Check in warmly and briefly: did she finish? If she confirms done and it's linked to a task, mark that task Done. If not done, offer to extend or move it, then help her stop and transition to the next thing. A couple of lines, human — no boilerplate.`
      );
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
