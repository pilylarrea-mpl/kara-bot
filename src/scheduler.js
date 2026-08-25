import { config } from "./config.js";
import { tasksDueOn } from "./notion.js";
import { listDay, createEvent, calendarEnabled } from "./calendar.js";

// Auto-scheduler: builds Pilar's calendar for her. For each upcoming day it
// places her daily requirements (workout, weekday founder block) + every task
// due that day into real timed blocks, fitting them into the open time around
// whatever's already fixed (meetings, travel, blocks she's set). NON-DESTRUCTIVE:
// it only ADDS blocks that are missing — it never moves or deletes anything she
// (or a meeting) already has, so it's safe to run repeatedly and it respects her
// manual changes. Rescheduling/among tasks moves their blocks elsewhere.

const DAY_START = 8 * 60 + 30; // 8:30am
const DAY_END = 21 * 60; // 9:00pm
const DUR = { High: 60, Medium: 45, Low: 30 };

const pad = (n) => String(n).padStart(2, "0");
const minToHHMM = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
const isWeekday = (ymd) => {
  const d = new Date(ymd + "T12:00:00Z").getUTCDay();
  return d >= 1 && d <= 5;
};
const addDaysYmd = (ymd, n) => {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n, 12));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
};
export function etTodayYmd() {
  return new Date().toLocaleDateString("en-CA", { timeZone: config.tz });
}

// Find the earliest open slot of `dur` minutes within [DAY_START, DAY_END]
// that doesn't overlap any busy interval; returns start-minute or null.
function findSlot(busy, dur) {
  const sorted = [...busy].sort((a, b) => a.startMin - b.startMin);
  let cursor = DAY_START;
  for (const b of sorted) {
    if (b.endMin <= cursor) continue;
    if (b.startMin - cursor >= dur) return cursor;
    cursor = Math.max(cursor, b.endMin);
  }
  return DAY_END - cursor >= dur ? cursor : null;
}

// Plan one day. { dryRun } to preview without creating events.
export async function planDay(ymd, { dryRun = false } = {}) {
  if (!calendarEnabled) return { ymd, skipped: "calendar-off" };
  const events = await listDay(ymd);
  // Only the ✈️ Away/travel block marks an out-of-office day — NOT task markers
  // that happen to contain words like "wedding" or "travel".
  if (events.some((e) => e.allDay && (e.summary.includes("✈️") || /\baway\b/i.test(e.summary)))) {
    return { ymd, skipped: "away", placed: [] };
  }
  const busy = events.filter((e) => e.timed).map((e) => ({ startMin: e.startMin, endMin: e.endMin }));
  const summaries = events.filter((e) => e.timed).map((e) => e.summary.toLowerCase());
  const blockedTaskIds = new Set(events.filter((e) => e.timed && e.taskId).map((e) => e.taskId));

  const toPlace = [];
  if (!summaries.some((s) => s.includes("workout"))) toPlace.push({ title: "🏋️ Workout", dur: 90 });
  if (isWeekday(ymd) && !summaries.some((s) => s.includes("founder"))) {
    toPlace.push({ title: "🚀 Founder deep work", dur: 120 });
  }
  const due = await tasksDueOn(ymd);
  for (const t of due) {
    if (blockedTaskIds.has(t.id)) continue; // already has a timed block
    toPlace.push({ title: `📋 ${t.task}`, dur: DUR[t.priority] || 45, task_id: t.id, prio: t.priority });
  }
  // requirements first, then tasks by priority (High → Low)
  const order = { High: 0, Medium: 1, Low: 2 };
  toPlace.sort((a, b) => (a.task_id ? 1 : 0) - (b.task_id ? 1 : 0) || (order[a.prio] ?? 1) - (order[b.prio] ?? 1));

  const placed = [];
  const unplaced = [];
  for (const item of toPlace) {
    const startMin = findSlot(busy, item.dur);
    if (startMin == null) { unplaced.push(item.title); continue; }
    const endMin = startMin + item.dur;
    busy.push({ startMin, endMin });
    const start = `${ymd}T${minToHHMM(startMin)}:00`;
    const end = `${ymd}T${minToHHMM(endMin)}:00`;
    if (!dryRun) {
      // Only task blocks get the end-of-block "did you finish?" ping; workout /
      // founder blocks are timed events without follow-ups (avoids flooding).
      await createEvent({ title: item.title, start, end, is_block: !!item.task_id, task_id: item.task_id });
    }
    placed.push(`${minToHHMM(startMin)}–${minToHHMM(endMin)} ${item.title}`);
  }
  return { ymd, placed, unplaced };
}

// Plan the next `days` days starting today (skips days already fully handled).
export async function planAhead(days = 7, { dryRun = false } = {}) {
  const out = [];
  let ymd = etTodayYmd();
  for (let i = 0; i < days; i++) {
    out.push(await planDay(ymd, { dryRun }));
    ymd = addDaysYmd(ymd, 1);
  }
  return out;
}
