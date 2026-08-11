import { Client } from "@notionhq/client";
import { config, notionDb } from "./config.js";
import { createEvent } from "./calendar.js";

const notion = new Client({ auth: config.notionToken });

// Turn a plain local wall-clock datetime ("YYYY-MM-DDTHH:MM[:SS]", no offset) in
// Pilar's timezone into the correct absolute UTC ISO, so reminders fire at the
// right moment (the follow-up loop compares against UTC now). DST-safe via a
// two-pass offset solve. If the input already has an offset/Z or is date-only,
// it's returned unchanged.
function localToUtcIso(value) {
  if (!value) return value;
  const m = String(value).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return value; // has offset/Z, or is a date-only string — leave as-is
  const y = +m[1], mo = +m[2], d = +m[3], h = +m[4], mi = +m[5], s = +(m[6] || 0);
  let ts = Date.UTC(y, mo - 1, d, h, mi, s);
  for (let i = 0; i < 2; i++) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: config.tz,
      hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(new Date(ts));
    const gv = (t) => +parts.find((p) => p.type === t).value;
    const etAsUtc = Date.UTC(gv("year"), gv("month") - 1, gv("day"), gv("hour") % 24, gv("minute"), gv("second"));
    ts += Date.UTC(y, mo - 1, d, h, mi, s) - etAsUtc;
  }
  return new Date(ts).toISOString();
}

// ---------- shared memory + live sprint (read from Notion, cached ~5 min) ----------
// The 🧠 About Pilar page is the ONE shared memory that Kara + the claude.ai
// projects all read/write. The 🏃 Current Sprint page is the live source of
// truth for the current sprint. Both are injected into Kara's system prompt.
const ABOUT_PAGE = "3b7a2f74deaa8177a2f5d2815f3bc53e";
const SPRINT_PAGE = "3b8a2f74deaa8141a499ea9e4cae8c6e";
const PAGE_TTL = 5 * 60 * 1000;
const _pageCache = {};

async function readPageText(pageId) {
  const c = _pageCache[pageId];
  if (c && Date.now() - c.at < PAGE_TTL) return c.text;
  try {
    let text = "";
    let cursor;
    do {
      const res = await notion.blocks.children.list({ block_id: pageId, start_cursor: cursor, page_size: 100 });
      for (const b of res.results) {
        const rt = (b[b.type]?.rich_text || []).map((t) => t.plain_text).join("");
        if (rt) text += rt + "\n";
      }
      cursor = res.has_more ? res.next_cursor : undefined;
    } while (cursor);
    _pageCache[pageId] = { text: text.trim(), at: Date.now() };
    return _pageCache[pageId].text;
  } catch (e) {
    console.error("readPageText failed", pageId, e.message);
    return c ? c.text : "";
  }
}
export const getAboutPilar = () => readPageText(ABOUT_PAGE);
export const getCurrentSprint = () => readPageText(SPRINT_PAGE);
const invalidate = (id) => { if (_pageCache[id]) _pageCache[id].at = 0; };

// remember/forget/list are backed by the About Pilar page so memory is shared.
export async function appendSharedFact({ text }) {
  if (!text || !text.trim()) return { ok: false, note: "empty" };
  await notion.blocks.children.append({
    block_id: ABOUT_PAGE,
    children: [{ object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: rich(text) } }],
  });
  invalidate(ABOUT_PAGE);
  return { ok: true };
}
export async function removeSharedFact({ id, contains }) {
  let cursor;
  let removed = 0;
  do {
    const res = await notion.blocks.children.list({ block_id: ABOUT_PAGE, start_cursor: cursor, page_size: 100 });
    for (const b of res.results) {
      if (b.type !== "bulleted_list_item") continue; // never touch headings/structure
      const t = (b.bulleted_list_item?.rich_text || []).map((x) => x.plain_text).join("");
      if (/^\s*\(Kara /.test(t)) continue; // keep the placeholder bullets
      if ((id && b.id === id) || (contains && t.toLowerCase().includes(contains.toLowerCase()))) {
        await notion.blocks.delete({ block_id: b.id });
        removed++;
      }
    }
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  invalidate(ABOUT_PAGE);
  return { ok: true, removed };
}
export async function listSharedFacts() {
  const res = await notion.blocks.children.list({ block_id: ABOUT_PAGE, page_size: 100 });
  return (res.results || [])
    .filter((b) => b.type === "bulleted_list_item")
    .map((b) => ({ id: b.id, text: (b.bulleted_list_item?.rich_text || []).map((x) => x.plain_text).join("") }));
}

// ---------- helpers ----------
const title = (t) => (t ? [{ text: { content: String(t).slice(0, 1900) } }] : []);
const rich = (t) => (t ? [{ text: { content: String(t).slice(0, 1900) } }] : []);
const sel = (v) => (v ? { select: { name: v } } : undefined);
const multi = (arr) =>
  arr && arr.length ? { multi_select: arr.map((name) => ({ name })) } : undefined;
const relation = (id) => (id ? { relation: [{ id }] } : undefined);
const date = (d) => (d ? { date: { start: d } } : undefined);
const num = (n) => (n === 0 || n ? { number: Number(n) } : undefined);
const clean = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));

function plainTitle(page, prop) {
  const p = page.properties[prop];
  return (p?.title || []).map((t) => t.plain_text).join("") || "(untitled)";
}
function plainText(page, prop) {
  const p = page.properties[prop];
  return (p?.rich_text || []).map((t) => t.plain_text).join("");
}
function selName(page, prop) {
  return page.properties[prop]?.select?.name || null;
}
function dateVal(page, prop) {
  return page.properties[prop]?.date?.start || null;
}
function tagVals(page, prop) {
  return (page.properties[prop]?.multi_select || []).map((t) => t.name);
}

function relationIds(page, prop) {
  return (page.properties[prop]?.relation || []).map((r) => r.id);
}

function taskSummary(page) {
  return {
    id: page.id,
    task: plainTitle(page, "Task"),
    status: selName(page, "Status"),
    priority: selName(page, "Priority"),
    due: dateVal(page, "Due"),
    area: selName(page, "Area"),
    goalIds: relationIds(page, "Goal"),
    notes: plainText(page, "Notes"),
  };
}
function reminderSummary(page) {
  return {
    id: page.id,
    reminder: plainTitle(page, "Reminder"),
    time: dateVal(page, "Time"),
    status: selName(page, "Status"),
    repeat: selName(page, "Repeat"),
    followUpAsked: page.properties["Follow-up asked"]?.checkbox || false,
  };
}
function goalSummary(page) {
  return {
    id: page.id,
    goal: plainTitle(page, "Goal"),
    status: selName(page, "Status"),
    area: selName(page, "Area"),
    why: plainText(page, "Why it matters"),
    target: dateVal(page, "Target date"),
  };
}

// ---------- tool implementations ----------
export async function listTasks({ status, area } = {}) {
  const filters = [];
  if (status) filters.push({ property: "Status", select: { equals: status } });
  if (area) filters.push({ property: "Area", select: { equals: area } });
  const res = await notion.databases.query({
    database_id: notionDb.tasks,
    filter: filters.length ? { and: filters } : undefined,
    page_size: 50,
  });
  return res.results.map(taskSummary);
}

export async function createTask(input) {
  const props = clean({
    Task: { title: title(input.task) },
    Status: sel(input.status || "Not started"),
    Priority: sel(input.priority),
    Due: date(input.due),
    Area: sel(input.area),
    Goal: relation(input.goal_id),
    Notes: input.notes ? { rich_text: rich(input.notes) } : undefined,
  });
  const page = await notion.pages.create({
    parent: { database_id: notionDb.tasks },
    properties: props,
  });
  // Every task with a due date automatically goes on the calendar (all-day if
  // the due is a plain date, timed if it includes a time). Non-fatal if it fails.
  let calendar_event_id = null;
  if (input.due) {
    try {
      const ev = await createEvent({
        title: `📋 ${input.task}`,
        start: input.due,
        is_block: /T\d{2}:\d{2}/.test(String(input.due)), // only timed dues become follow-up blocks
        task_id: page.id,
      });
      if (ev && ev.ok) calendar_event_id = ev.id;
    } catch (e) {
      console.error("task→calendar failed:", e.message);
    }
  }
  return { ok: true, id: page.id, task: input.task, calendar_event_id };
}

export async function updateTask(input) {
  const props = clean({
    Status: sel(input.status),
    Priority: sel(input.priority),
    Due: date(input.due),
    Area: sel(input.area),
    Goal: relation(input.goal_id),
    Notes: input.notes ? { rich_text: rich(input.notes) } : undefined,
  });
  await notion.pages.update({ page_id: input.task_id, properties: props });
  return { ok: true, id: input.task_id };
}

// Open tasks that are due today or overdue (Status not Done), for the overdue
// chase. Sorted by due date so the most-overdue surface first.
export async function overdueTasks() {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: config.tz }); // YYYY-MM-DD in ET
  const res = await notion.databases.query({
    database_id: notionDb.tasks,
    filter: {
      and: [
        { property: "Status", select: { does_not_equal: "Done" } },
        { property: "Due", date: { on_or_before: today } },
      ],
    },
    sorts: [{ property: "Due", direction: "ascending" }],
    page_size: 50,
  });
  return res.results.map(taskSummary);
}

export async function listGoals({ status } = {}) {
  const res = await notion.databases.query({
    database_id: notionDb.goals,
    filter: status ? { property: "Status", select: { equals: status } } : undefined,
    page_size: 50,
  });
  return res.results.map(goalSummary);
}

export async function listReminders({ status } = {}) {
  const res = await notion.databases.query({
    database_id: notionDb.reminders,
    filter: status ? { property: "Status", select: { equals: status } } : undefined,
    sorts: [{ property: "Time", direction: "ascending" }],
    page_size: 50,
  });
  return res.results.map(reminderSummary);
}

export async function createReminder(input) {
  const props = clean({
    Reminder: { title: title(input.reminder) },
    Time: date(localToUtcIso(input.time)),
    Status: sel("Pending"),
    Repeat: sel(input.repeat || "One-time"),
    Notes: input.notes ? { rich_text: rich(input.notes) } : undefined,
  });
  const page = await notion.pages.create({
    parent: { database_id: notionDb.reminders },
    properties: props,
  });
  // A reminder also gets a matching calendar event at its time (~30 min).
  let calendar_event_id = null;
  if (input.time) {
    try {
      const ev = await createEvent({ title: `⏰ ${input.reminder}`, start: input.time, task_id: page.id });
      if (ev && ev.ok) calendar_event_id = ev.id;
    } catch (e) {
      console.error("reminder→calendar failed:", e.message);
    }
  }
  return { ok: true, id: page.id, reminder: input.reminder, calendar_event_id };
}

export async function updateReminder(input) {
  const props = clean({
    Status: sel(input.status),
    Time: date(localToUtcIso(input.time)),
  });
  await notion.pages.update({ page_id: input.reminder_id, properties: props });
  return { ok: true, id: input.reminder_id };
}

export async function logDailyPlan(input) {
  const children = String(input.plan_markdown || "")
    .split("\n")
    .filter((l) => l.trim())
    .slice(0, 90)
    .map((line) => ({
      object: "block",
      type: "paragraph",
      paragraph: { rich_text: [{ text: { content: line.slice(0, 1900) } }] },
    }));
  const props = clean({
    Day: { title: title(input.day) },
    Date: date(input.date),
    "Top focus": input.top_focus ? { rich_text: rich(input.top_focus) } : undefined,
    Adherence: sel("— Not reviewed"),
  });
  const page = await notion.pages.create({
    parent: { database_id: notionDb.dailyPlan },
    properties: props,
    children,
  });
  return { ok: true, id: page.id };
}

// ---------- Shared brain: 📓 Log ----------
function logSummary(page) {
  return {
    id: page.id,
    title: plainTitle(page, "Title"),
    date: dateVal(page, "Date"),
    type: selName(page, "Type"),
    area: selName(page, "Area"),
    project: plainText(page, "Project"),
    source: plainText(page, "Source"),
    processing: selName(page, "Processing"),
    goalIds: relationIds(page, "Goal"),
  };
}

function bodyBlocks(text) {
  return String(text || "")
    .split("\n")
    .filter((l) => l.trim())
    .slice(0, 95)
    .map((line) => ({
      object: "block",
      type: "paragraph",
      paragraph: { rich_text: [{ text: { content: line.slice(0, 1900) } }] },
    }));
}

export async function createLogEntry(input) {
  const props = clean({
    Title: { title: title(input.title) },
    Date: date(input.date),
    Type: sel(input.type),
    Area: sel(input.area),
    Project: input.project ? { rich_text: rich(input.project) } : undefined,
    Source: input.source ? { rich_text: rich(input.source) } : undefined,
    Goal: relation(input.goal_id),
  });
  const page = await notion.pages.create({
    parent: { database_id: notionDb.log },
    properties: props,
    children: bodyBlocks(input.body),
  });
  return { ok: true, id: page.id, title: input.title };
}

export async function searchLogs({ query, type, area, project } = {}) {
  const filters = [];
  if (type) filters.push({ property: "Type", select: { equals: type } });
  if (area) filters.push({ property: "Area", select: { equals: area } });
  if (project) filters.push({ property: "Project", rich_text: { contains: project } });
  if (query) filters.push({ property: "Title", title: { contains: query } });
  const res = await notion.databases.query({
    database_id: notionDb.log,
    filter: filters.length ? { and: filters } : undefined,
    sorts: [{ property: "Date", direction: "descending" }],
    page_size: 25,
  });
  return res.results.map(logSummary);
}

export async function getLogEntry({ entry_id }) {
  const page = await notion.pages.retrieve({ page_id: entry_id });
  const blocks = await notion.blocks.children.list({ block_id: entry_id, page_size: 100 });
  const body = (blocks.results || [])
    .map((b) => (b[b.type]?.rich_text || []).map((t) => t.plain_text).join(""))
    .filter((l) => l !== undefined)
    .join("\n");
  return { ...logSummary(page), body };
}

export async function appendToLog({ entry_id, text }) {
  await notion.blocks.children.append({ block_id: entry_id, children: bodyBlocks(text) });
  return { ok: true, id: entry_id };
}

// Meeting entries the claude.ai routine filed that still need Pilar to confirm
// their proposed to-dos. status defaults to "Needs review".
export async function listPendingMeetings({ status = "Needs review" } = {}) {
  const res = await notion.databases.query({
    database_id: notionDb.log,
    filter: {
      and: [
        { property: "Type", select: { equals: "Meeting" } },
        { property: "Processing", select: { equals: status } },
      ],
    },
    sorts: [{ property: "Date", direction: "descending" }],
    page_size: 25,
  });
  return res.results.map(logSummary);
}

export async function setLogProcessing({ entry_id, status }) {
  await notion.pages.update({
    page_id: entry_id,
    properties: { Processing: status ? { select: { name: status } } : { select: null } },
  });
  return { ok: true, id: entry_id, status };
}

// Reminders whose time has passed and are STILL Pending. We return them every
// time (no one-shot "Follow-up asked" gate) — the caller decides how often to
// re-ping using per-reminder ping timestamps, so Kara keeps nudging until Pilar
// marks the reminder Done (which flips it off Pending and out of this list).
export async function dueReminders() {
  const nowIso = new Date().toISOString();
  const res = await notion.databases.query({
    database_id: notionDb.reminders,
    filter: {
      and: [
        { property: "Status", select: { equals: "Pending" } },
        { property: "Time", date: { on_or_before: nowIso } },
      ],
    },
    page_size: 25,
  });
  return res.results.map(reminderSummary);
}

export async function markFollowUpAsked(reminderId) {
  await notion.pages.update({
    page_id: reminderId,
    properties: { "Follow-up asked": { checkbox: true } },
  });
}

// ---------- tool schemas for Claude ----------
export const notionTools = [
  {
    name: "list_tasks",
    description:
      "List tasks. Filter by status (Not started / In progress / Done) and/or area (Founder / Money / Health / Personal / Relationships / Learning). Omit both to see everything.",
    input_schema: {
      type: "object",
      properties: { status: { type: "string" }, area: { type: "string" } },
    },
  },
  {
    name: "list_overdue_tasks",
    description:
      "List tasks that are due today or overdue and NOT Done, most-overdue first. Call this at every check-in to chase what's slipping — push Pilar to finish or reschedule each one. Nothing past-due should just sit there.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "create_task",
    description:
      "Create a to-do. ALWAYS set a Due date — tasks without dates get dropped, and a dated task is AUTOMATICALLY added to Pilar's Google Calendar (so do NOT also call create_calendar_event for it). Set Priority by how it serves her goals/current sprint: High = directly moves a sprint/goal priority · Medium = matters but not top · Low = admin/personal/errand. Set Area. Link goal_id (from list_goals) when it ladders to a goal — many admin/errand/wedding tasks won't, and that's fine.",
    input_schema: {
      type: "object",
      properties: {
        task: { type: "string" },
        due: { type: "string", description: "Plain local date YYYY-MM-DD (add a time as YYYY-MM-DDTHH:MM:SS only if it's time-specific). Auto-added to the calendar." },
        priority: { type: "string", enum: ["High", "Medium", "Low"], description: "By goal-alignment (High serves a sprint/goal priority; Low is admin/personal)." },
        status: { type: "string", enum: ["Not started", "In progress", "Done"] },
        area: { type: "string", enum: ["Founder", "Money", "Health", "Personal", "Relationships", "Learning"] },
        goal_id: { type: "string", description: "Notion goal id (from list_goals) when the task ladders to a goal. Optional." },
        notes: { type: "string" },
      },
      required: ["task", "due"],
    },
  },
  {
    name: "update_task",
    description: "Update a task by id. Mark done → status 'Done'. Reschedule → set a new due. Also change priority/area, link a goal, or edit notes.",
    input_schema: {
      type: "object",
      properties: {
        task_id: { type: "string" },
        status: { type: "string", enum: ["Not started", "In progress", "Done"] },
        priority: { type: "string", enum: ["High", "Medium", "Low"] },
        due: { type: "string", description: "New due date YYYY-MM-DD (or with a time)." },
        area: { type: "string", enum: ["Founder", "Money", "Health", "Personal", "Relationships", "Learning"] },
        goal_id: { type: "string", description: "Notion goal id to link (from list_goals)." },
        notes: { type: "string" },
      },
      required: ["task_id"],
    },
  },
  {
    name: "list_goals",
    description: "List goals. Filter by status (Active/Someday/Done/Dropped).",
    input_schema: { type: "object", properties: { status: { type: "string" } } },
  },
  {
    name: "list_reminders",
    description: "List reminders (time-anchored pings). Filter by status (Pending/Done/Missed/Snoozed).",
    input_schema: { type: "object", properties: { status: { type: "string" } } },
  },
  {
    name: "create_reminder",
    description: "Create a time-anchored reminder. Kara will ping at the time and follow up.",
    input_schema: {
      type: "object",
      properties: {
        reminder: { type: "string" },
        time: { type: "string", description: "PLAIN local wall-clock time, NO offset and NO Z, e.g. 2026-08-14T14:00:00 for 2pm ET. Use resolve_date / the date table for the date — don't compute it." },
        repeat: { type: "string", enum: ["One-time", "Daily", "Weekdays", "Weekly"] },
        notes: { type: "string" },
      },
      required: ["reminder", "time"],
    },
  },
  {
    name: "update_reminder",
    description: "Update a reminder by id (e.g. set status Done/Missed/Snoozed, or reschedule Time).",
    input_schema: {
      type: "object",
      properties: {
        reminder_id: { type: "string" },
        status: { type: "string" },
        time: { type: "string" },
      },
      required: ["reminder_id"],
    },
  },
  {
    name: "log_daily_plan",
    description: "Create today's Daily Plan page with the time-blocked schedule in the body.",
    input_schema: {
      type: "object",
      properties: {
        day: { type: "string", description: "e.g. 'Wed Aug 6'" },
        date: { type: "string", description: "ISO date YYYY-MM-DD" },
        top_focus: { type: "string" },
        plan_markdown: { type: "string", description: "The time-blocked plan, one block per line." },
      },
      required: ["day", "date"],
    },
  },
  {
    name: "create_log_entry",
    description:
      "Save a note into the 📓 Log — the shared brain Pilar's other Claude assistants also read/write. Use for meeting notes, next-steps, decisions, ideas, research (e.g. notes on the health-assessment centers she's evaluating), or journal entries. Put the full content in body; classify with type & area; use project to cluster related entries (e.g. 'Health-Assessment', 'Fundraise', 'Spain-trip').",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        type: { type: "string", enum: ["Note", "Meeting", "Idea", "Decision", "Research", "Journal", "Next-steps"] },
        area: { type: "string", enum: ["Founder", "Health", "Money", "Self", "Relationships", "Learning", "Admin"] },
        project: { type: "string", description: "Free-text cluster tag to group related entries." },
        source: { type: "string", description: "Where it came from, e.g. 'Fireflies', a person, or a URL." },
        goal_id: { type: "string", description: "Optional goal to link (from list_goals)." },
        date: { type: "string", description: "ISO date YYYY-MM-DD (defaults to today if omitted)." },
        body: { type: "string", description: "The full note content, one line per paragraph." },
      },
      required: ["title"],
    },
  },
  {
    name: "search_logs",
    description:
      "Search the 📓 Log (shared brain). Filter by query (matches title), type, area, and/or project. Returns matching entries newest-first with their ids — use get_log_entry to read the full body of one.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string" },
        type: { type: "string" },
        area: { type: "string" },
        project: { type: "string" },
      },
    },
  },
  {
    name: "get_log_entry",
    description: "Read the full body of a single Log entry by id (from search_logs).",
    input_schema: {
      type: "object",
      properties: { entry_id: { type: "string" } },
      required: ["entry_id"],
    },
  },
  {
    name: "append_to_log",
    description: "Append text to an existing Log entry's body (for running notes on an ongoing project or meeting).",
    input_schema: {
      type: "object",
      properties: {
        entry_id: { type: "string" },
        text: { type: "string", description: "Text to append, one line per paragraph." },
      },
      required: ["entry_id", "text"],
    },
  },
  {
    name: "list_pending_meetings",
    description: "List meeting Log entries awaiting Pilar's review of their proposed to-dos. status: 'Needs review' (not yet pinged) or 'Awaiting confirm' (pinged, waiting on her).",
    input_schema: {
      type: "object",
      properties: { status: { type: "string", enum: ["Needs review", "Awaiting confirm"] } },
    },
  },
  {
    name: "set_log_processing",
    description: "Set a meeting Log entry's Processing status. Set to 'Filed' once you've created the confirmed to-dos as tasks/reminders. Use 'Awaiting confirm' after you've pinged her.",
    input_schema: {
      type: "object",
      properties: {
        entry_id: { type: "string" },
        status: { type: "string", enum: ["Needs review", "Awaiting confirm", "Filed"] },
      },
      required: ["entry_id", "status"],
    },
  },
];

export async function runNotionTool(name, input) {
  switch (name) {
    case "list_tasks": return listTasks(input);
    case "list_overdue_tasks": return overdueTasks(input);
    case "create_task": return createTask(input);
    case "update_task": return updateTask(input);
    case "list_goals": return listGoals(input);
    case "list_reminders": return listReminders(input);
    case "create_reminder": return createReminder(input);
    case "update_reminder": return updateReminder(input);
    case "log_daily_plan": return logDailyPlan(input);
    case "create_log_entry": return createLogEntry(input);
    case "search_logs": return searchLogs(input);
    case "get_log_entry": return getLogEntry(input);
    case "append_to_log": return appendToLog(input);
    case "list_pending_meetings": return listPendingMeetings(input);
    case "set_log_processing": return setLogProcessing(input);
    default: throw new Error(`Unknown tool: ${name}`);
  }
}
