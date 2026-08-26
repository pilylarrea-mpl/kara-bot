import { config } from "./config.js";
import { tasksDueOn, getTaskById, overdueTasks, updateTask } from "./notion.js";
import { listDay, createEvent, deleteEvent, calendarEnabled } from "./calendar.js";

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
const MAX_TASKS_PER_DAY = 7; // don't cram a day — overflow rolls forward

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
// Next weekday strictly after ymd (skips Sat/Sun) — tasks roll to a workday.
const nextWeekdayYmd = (ymd) => {
  let n = addDaysYmd(ymd, 1);
  while (!isWeekday(n)) n = addDaysYmd(n, 1);
  return n;
};
export function etTodayYmd() {
  return new Date().toLocaleDateString("en-CA", { timeZone: config.tz });
}
function etNowMin() {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: config.tz, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date());
  return (+p.find((x) => x.type === "hour").value % 24) * 60 + +p.find((x) => x.type === "minute").value;
}

// Find the earliest open slot of `dur` minutes within [dayStart, DAY_END]
// that doesn't overlap any busy interval; returns start-minute or null.
function findSlot(busy, dur, dayStart) {
  const sorted = [...busy].sort((a, b) => a.startMin - b.startMin);
  let cursor = dayStart;
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
  let events = await listDay(ymd);
  // Only the ✈️ Away/travel block marks an out-of-office day — NOT task markers
  // that happen to contain words like "wedding" or "travel".
  if (events.some((e) => e.allDay && (e.summary.includes("✈️") || /\baway\b/i.test(e.summary)))) {
    return { ymd, skipped: "away", placed: [], removed: [] };
  }
  // Classify what's on the day. FIXED = real meetings/appointments we must never
  // overlap (anything timed that ISN'T one of our own blocks or a reminder).
  const isTaskBlock = (e) => e.timed && e.summary.startsWith("📋") && e.taskId;
  const isReqBlock = (e) => e.timed && /🏋️|🚀|workout|founder/i.test(e.summary);
  const isReminder = (e) => e.timed && e.summary.startsWith("⏰");
  const fixed = events
    .filter((e) => e.timed && !isTaskBlock(e) && !isReqBlock(e) && !isReminder(e))
    .map((e) => ({ startMin: e.startMin, endMin: e.endMin }));
  const overlapsFixed = (a) => fixed.some((f) => a.startMin < f.endMin && f.startMin < a.endMin);
  const weekend = !isWeekday(ymd);

  // RECONCILE: remove our own blocks that shouldn't be here so they get re-placed:
  //  - a task block that's stale (task Done/deleted/moved) OR on a weekend (rolls
  //    to a weekday) OR overlapping a real appointment
  //  - a founder block on a weekend, or any of our blocks overlapping an appointment
  // Reminders and the fixed appointments themselves are never touched.
  const removed = [];
  const kept = [];
  for (const e of events) {
    if (isTaskBlock(e)) {
      let drop = overlapsFixed(e);
      if (!drop && weekend) {
        drop = true;
        if (!dryRun) await updateTask({ task_id: e.taskId, due: nextWeekdayYmd(ymd) }).catch(() => {});
      }
      if (!drop) {
        const t = await getTaskById(e.taskId);
        drop = !t || t.status === "Done" || (t.due && t.due.slice(0, 10) !== ymd);
      }
      if (drop) {
        if (!dryRun) await deleteEvent({ event_id: e.id }).catch(() => {});
        removed.push(e.summary);
        continue;
      }
    } else if (isReqBlock(e)) {
      if (overlapsFixed(e) || (weekend && /🚀|founder/i.test(e.summary))) {
        if (!dryRun) await deleteEvent({ event_id: e.id }).catch(() => {});
        removed.push(e.summary);
        continue;
      }
    }
    kept.push(e);
  }
  events = kept;
  const busy = events.filter((e) => e.timed).map((e) => ({ startMin: e.startMin, endMin: e.endMin }));
  const summaries = events.filter((e) => e.timed).map((e) => e.summary.toLowerCase());
  const blockedTaskIds = new Set(events.filter((e) => isTaskBlock(e)).map((e) => e.taskId));
  const dayStart = ymd === etTodayYmd() ? Math.max(DAY_START, etNowMin() + 15) : DAY_START;

  const toPlace = [];
  if (!summaries.some((s) => s.includes("workout"))) toPlace.push({ title: "🏋️ Workout", dur: 90 });
  if (isWeekday(ymd) && !summaries.some((s) => s.includes("founder"))) {
    toPlace.push({ title: "🚀 Founder deep work", dur: 120 });
  }
  const placed = [];
  const unplaced = [];
  const due = await tasksDueOn(ymd);
  for (const t of due) {
    if (blockedTaskIds.has(t.id)) continue; // already has a timed block
    const item = { title: `📋 ${t.task}`, dur: DUR[t.priority] || 45, task_id: t.id, prio: t.priority };
    if (weekend) unplaced.push(item); // no task-work on weekends → rolls to a weekday
    else toPlace.push(item);
  }
  // requirements first, then tasks by priority (High → Low)
  const order = { High: 0, Medium: 1, Low: 2 };
  toPlace.sort((a, b) => (a.task_id ? 1 : 0) - (b.task_id ? 1 : 0) || (order[a.prio] ?? 1) - (order[b.prio] ?? 1));

  let taskCount = 0;
  for (const item of toPlace) {
    if (item.task_id && taskCount >= MAX_TASKS_PER_DAY) { unplaced.push(item); continue; }
    const startMin = findSlot(busy, item.dur, dayStart);
    if (startMin == null) { unplaced.push(item); continue; }
    if (item.task_id) taskCount++;
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
  // AUTO-ROLL: any task that didn't fit rolls to the next WEEKDAY (Motion-style)
  // — its due date moves forward so it's re-scheduled instead of sitting stuck.
  const nxt = nextWeekdayYmd(ymd);
  for (const item of unplaced) {
    if (item.task_id && !dryRun) await updateTask({ task_id: item.task_id, due: nxt }).catch(() => {});
  }
  return { ymd, placed, unplaced: unplaced.map((i) => i.title), removed };
}

// Pull every overdue (past-due, not-done) task onto today so it re-enters the
// schedule — nothing is left rotting in the past. Overflow then auto-rolls
// forward day by day via planDay. Motion-style: incomplete work keeps moving.
export async function absorbOverdue({ dryRun = false } = {}) {
  if (!calendarEnabled) return 0;
  const today = etTodayYmd();
  const od = await overdueTasks();
  let moved = 0;
  for (const t of od) {
    if (t.due && t.due.slice(0, 10) < today) {
      if (!dryRun) await updateTask({ task_id: t.id, due: today }).catch(() => {});
      moved++;
    }
  }
  return moved;
}

// Plan the next `days` days starting today. First absorbs overdue work, then
// packs each day (rolling overflow forward). This is the continuous engine.
export async function planAhead(days = 7, { dryRun = false } = {}) {
  await absorbOverdue({ dryRun });
  const out = [];
  let ymd = etTodayYmd();
  for (let i = 0; i < days; i++) {
    out.push(await planDay(ymd, { dryRun }));
    ymd = addDaysYmd(ymd, 1);
  }
  return out;
}
