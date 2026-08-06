import { Client } from "@notionhq/client";
import { config, notionDb } from "./config.js";

const notion = new Client({ auth: config.notionToken });

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
    type: selName(page, "Type"),
    due: dateVal(page, "Due"),
    energy: selName(page, "Energy"),
    tags: tagVals(page, "Tags"),
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
export async function listTasks({ status, tag } = {}) {
  const filters = [];
  if (status) filters.push({ property: "Status", select: { equals: status } });
  if (tag) filters.push({ property: "Tags", multi_select: { contains: tag } });
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
    Status: sel(input.status || "Inbox"),
    Priority: sel(input.priority),
    Type: sel(input.type),
    Due: date(input.due),
    "Est (min)": num(input.est_min),
    Energy: sel(input.energy),
    Tags: multi(input.tags),
    Goal: relation(input.goal_id),
    Notes: input.notes ? { rich_text: rich(input.notes) } : undefined,
  });
  const page = await notion.pages.create({
    parent: { database_id: notionDb.tasks },
    properties: props,
  });
  return { ok: true, id: page.id, task: input.task };
}

export async function updateTask(input) {
  const props = clean({
    Status: sel(input.status),
    Priority: sel(input.priority),
    Type: sel(input.type),
    Due: date(input.due),
    Energy: sel(input.energy),
    Tags: multi(input.tags),
    Goal: relation(input.goal_id),
    Notes: input.notes ? { rich_text: rich(input.notes) } : undefined,
  });
  await notion.pages.update({ page_id: input.task_id, properties: props });
  return { ok: true, id: input.task_id };
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
    Time: date(input.time),
    Status: sel("Pending"),
    Repeat: sel(input.repeat || "One-time"),
    Notes: input.notes ? { rich_text: rich(input.notes) } : undefined,
  });
  const page = await notion.pages.create({
    parent: { database_id: notionDb.reminders },
    properties: props,
  });
  return { ok: true, id: page.id, reminder: input.reminder };
}

export async function updateReminder(input) {
  const props = clean({
    Status: sel(input.status),
    Time: date(input.time),
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

// Reminders whose time has passed, still Pending, not yet followed up.
export async function dueReminders() {
  const nowIso = new Date().toISOString();
  const res = await notion.databases.query({
    database_id: notionDb.reminders,
    filter: {
      and: [
        { property: "Status", select: { equals: "Pending" } },
        { property: "Follow-up asked", checkbox: { equals: false } },
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
      "List tasks from the Command Center. Filter by status (Inbox/Today/This Week/Doing/Waiting/Done) and/or tag (Wedding/Travel/Packing/Home/Errands/Admin/Finance/Health).",
    input_schema: {
      type: "object",
      properties: { status: { type: "string" }, tag: { type: "string" } },
    },
  },
  {
    name: "create_task",
    description: "Create a new to-do. Goal link is optional; many tasks (errands, wedding, packing) have no goal. When the task clearly serves one of her Active goals, first call list_goals to get that goal's id, then pass it as goal_id so the to-do ladders up to the goal.",
    input_schema: {
      type: "object",
      properties: {
        task: { type: "string" },
        status: { type: "string", enum: ["Inbox", "Today", "This Week", "Doing", "Waiting", "Done"] },
        priority: { type: "string", enum: ["🔥 Must", "⭐ Should", "💭 Nice"] },
        type: { type: "string", enum: ["Task", "Idea", "Reply", "Admin", "Errand", "Workout", "Reading"] },
        due: { type: "string", description: "ISO date YYYY-MM-DD" },
        est_min: { type: "number" },
        energy: { type: "string", enum: ["High", "Med", "Low"] },
        tags: { type: "array", items: { type: "string" } },
        goal_id: { type: "string", description: "Notion page id of the goal this task ladders up to (from list_goals). Optional — omit when no goal fits." },
        notes: { type: "string" },
      },
      required: ["task"],
    },
  },
  {
    name: "update_task",
    description: "Update a task by id. To mark done, set status to 'Done'. Pass goal_id to link it to a goal (from list_goals).",
    input_schema: {
      type: "object",
      properties: {
        task_id: { type: "string" },
        status: { type: "string" },
        priority: { type: "string" },
        type: { type: "string" },
        due: { type: "string" },
        energy: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        goal_id: { type: "string", description: "Notion page id of the goal to link (from list_goals)." },
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
        time: { type: "string", description: "ISO datetime with offset, e.g. 2026-08-06T14:00:00-04:00" },
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
];

export async function runNotionTool(name, input) {
  switch (name) {
    case "list_tasks": return listTasks(input);
    case "create_task": return createTask(input);
    case "update_task": return updateTask(input);
    case "list_goals": return listGoals(input);
    case "list_reminders": return listReminders(input);
    case "create_reminder": return createReminder(input);
    case "update_reminder": return updateReminder(input);
    case "log_daily_plan": return logDailyPlan(input);
    default: throw new Error(`Unknown tool: ${name}`);
  }
}
