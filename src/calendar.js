import { google } from "googleapis";

// Google Calendar via a service account. Optional: if GOOGLE_CREDENTIALS_JSON
// isn't set, the tools no-op gracefully so the rest of the bot still runs.
const calendarId = process.env.GOOGLE_CALENDAR_ID || "primary";
const TZ = "America/New_York";
let calendar = null;
export let calendarEnabled = false;

(function init() {
  const b64 = process.env.GOOGLE_CREDENTIALS_JSON;
  if (!b64) return;
  try {
    const creds = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
    const auth = new google.auth.JWT({
      email: creds.client_email,
      key: creds.private_key,
      scopes: ["https://www.googleapis.com/auth/calendar.events"],
    });
    calendar = google.calendar({ version: "v3", auth });
    calendarEnabled = true;
    console.log(`Google Calendar enabled (${calendarId}).`);
  } catch (e) {
    console.error("Calendar init failed:", e.message);
  }
})();

const NOT_READY = { ok: false, note: "Google Calendar not configured yet." };

// Add minutes to a naive wall-clock string ("YYYY-MM-DDTHH:MM:SS", no offset)
// staying in wall-clock terms, so a naive start yields a naive end (both get
// interpreted in TZ by Google — no offset math, no day/hour drift).
function addMinutesNaive(naive, mins) {
  const m = String(naive).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return naive;
  const dt = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)));
  dt.setUTCMinutes(dt.getUTCMinutes() + mins);
  const p = (n) => String(n).padStart(2, "0");
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}T${p(dt.getUTCHours())}:${p(dt.getUTCMinutes())}:${p(dt.getUTCSeconds())}`;
}

function nextDayYmd(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + 1, 12));
  const p = (n) => String(n).padStart(2, "0");
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}

export async function createEvent({ title, start, end, description, is_block, task_id }) {
  if (!calendarEnabled) return NOT_READY;
  const requestBody = { summary: title, description: description || "" };
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(String(start));
  if (dateOnly) {
    // All-day event — used for a dated to-do that has no specific time.
    requestBody.start = { date: start };
    requestBody.end = { date: end && /^\d{4}-\d{2}-\d{2}$/.test(end) ? nextDayYmd(end) : nextDayYmd(start) };
  } else {
    // Timed event. Default end matches start's form (absolute if it carries a
    // tz offset/Z, naive wall-clock otherwise) so nothing drifts a day/hour.
    const startHasTz = /[Zz]$|[+-]\d{2}:?\d{2}$/.test(String(start));
    const endDt =
      end || (startHasTz ? new Date(new Date(start).getTime() + 30 * 60000).toISOString() : addMinutesNaive(start, 30));
    requestBody.start = { dateTime: start, timeZone: TZ };
    requestBody.end = { dateTime: endDt, timeZone: TZ };
  }
  // Tag focus/work blocks (timed) so the accountability loop follows up when they
  // end; always record the linked task id so completing the task can find it.
  const priv = {};
  if (is_block && !dateOnly) {
    priv.karaBlock = "1";
    priv.followUpAsked = "0";
  }
  if (task_id) priv.taskId = String(task_id);
  if (Object.keys(priv).length) requestBody.extendedProperties = { private: priv };
  const res = await calendar.events.insert({ calendarId, requestBody });
  return { ok: true, id: res.data.id, link: res.data.htmlLink };
}

// Move (or create) the calendar event linked to a task — so rescheduling a task
// also moves its block instead of leaving a stale one on the old day. Finds the
// event by its taskId, deletes it, and recreates it on the new date.
export async function upsertTaskEvent({ task_id, start, title }) {
  if (!calendarEnabled) return NOT_READY;
  try {
    const found = await calendar.events.list({
      calendarId,
      privateExtendedProperty: `taskId=${task_id}`,
      singleEvents: true,
      maxResults: 5,
    });
    for (const ev of found.data.items || []) {
      await calendar.events.delete({ calendarId, eventId: ev.id }).catch(() => {});
    }
  } catch (e) {
    /* ignore lookup errors — we'll just create a fresh one */
  }
  if (!start) return { ok: true, removed: true }; // done/cleared — just remove the block
  return createEvent({
    title: title || "📋 task",
    start,
    task_id,
    is_block: /T\d{2}:\d{2}/.test(String(start)),
  });
}

// Kara-tagged focus blocks whose end time just passed and that haven't been
// followed up yet. Mirrors dueReminders() for the accountability loop.
export async function endedBlocks({ windowMs = 90 * 1000 } = {}) {
  if (!calendarEnabled) return [];
  const now = Date.now();
  const res = await calendar.events.list({
    calendarId,
    // timeMin filters on event END time; timeMax on START time. This returns
    // events that started before now and end after (now - window) — i.e. blocks
    // ending around now plus any still ongoing (we drop the ongoing ones below).
    timeMin: new Date(now - windowMs).toISOString(),
    timeMax: new Date(now).toISOString(),
    privateExtendedProperty: "karaBlock=1",
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 25,
  });
  return (res.data.items || [])
    .filter((e) => {
      const endMs = new Date(e.end?.dateTime || e.end?.date).getTime();
      const asked = e.extendedProperties?.private?.followUpAsked === "1";
      return !asked && endMs <= now && endMs >= now - windowMs;
    })
    .map((e) => ({
      id: e.id,
      title: e.summary || "(untitled block)",
      end: e.end?.dateTime || e.end?.date,
      taskId: e.extendedProperties?.private?.taskId || null,
    }));
}

// Mark a block's follow-up as asked so we don't ping it again.
export async function markBlockFollowedUp(eventId) {
  if (!calendarEnabled) return;
  await calendar.events.patch({
    calendarId,
    eventId,
    requestBody: { extendedProperties: { private: { followUpAsked: "1" } } },
  });
}

export async function listEvents({ time_min, time_max, query } = {}) {
  if (!calendarEnabled) return NOT_READY;
  const now = new Date();
  const res = await calendar.events.list({
    calendarId,
    timeMin: time_min || now.toISOString(),
    timeMax: time_max || new Date(now.getTime() + 7 * 24 * 3600 * 1000).toISOString(),
    q: query || undefined,
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 50,
  });
  return (res.data.items || []).map((e) => ({
    id: e.id,
    title: e.summary || "(no title)",
    start: e.start?.dateTime || e.start?.date,
    end: e.end?.dateTime || e.end?.date,
  }));
}

export async function updateEvent({ event_id, title, start, end }) {
  if (!calendarEnabled) return NOT_READY;
  const body = {};
  if (title) body.summary = title;
  if (start) body.start = { dateTime: start, timeZone: TZ };
  if (end) body.end = { dateTime: end, timeZone: TZ };
  const res = await calendar.events.patch({ calendarId, eventId: event_id, requestBody: body });
  return { ok: true, id: res.data.id, link: res.data.htmlLink };
}

export async function deleteEvent({ event_id }) {
  if (!calendarEnabled) return NOT_READY;
  await calendar.events.delete({ calendarId, eventId: event_id });
  return { ok: true, deleted: event_id };
}

// Deterministic date resolver so Kara never does date math in her head (the
// source of off-by-one scheduling). Returns the exact ISO date + weekday for a
// given date, an offset in days, or the next/this occurrence of a weekday — all
// computed in Pilar's timezone.
function etTodayParts() {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  return {
    y: +p.find((x) => x.type === "year").value,
    m: +p.find((x) => x.type === "month").value,
    d: +p.find((x) => x.type === "day").value,
  };
}
function fmtYmd(y, m, d) {
  // Noon UTC avoids any DST/tz edge when we only care about the calendar date.
  const dt = new Date(Date.UTC(y, m - 1, d, 12));
  return {
    iso_date: `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(
      dt.getUTCDate()
    ).padStart(2, "0")}`,
    weekday: dt.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" }),
    pretty: dt.toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    }),
  };
}
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
export function resolveDate({ date, in_days, weekday, occurrence = "next" } = {}) {
  const t = etTodayParts();
  if (date) {
    const [y, m, d] = date.split("-").map(Number);
    return { ...fmtYmd(y, m, d), input: date };
  }
  if (typeof in_days === "number") {
    const base = new Date(Date.UTC(t.y, t.m - 1, t.d + in_days, 12));
    return { ...fmtYmd(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate()), in_days };
  }
  if (weekday) {
    const target = WEEKDAYS.indexOf(String(weekday).toLowerCase());
    if (target < 0) return { error: `Unknown weekday: ${weekday}` };
    const today = new Date(Date.UTC(t.y, t.m - 1, t.d, 12));
    const todayDow = today.getUTCDay();
    let delta = (target - todayDow + 7) % 7;
    if (delta === 0 && occurrence === "next") delta = 7; // "next Friday" when today is Friday → 7 days out
    const base = new Date(Date.UTC(t.y, t.m - 1, t.d + delta, 12));
    return {
      ...fmtYmd(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate()),
      weekday_requested: weekday,
      occurrence,
    };
  }
  // default: today
  return { ...fmtYmd(t.y, t.m, t.d), note: "today" };
}

export const calendarTools = [
  {
    name: "resolve_date",
    description:
      "Get the EXACT calendar date + weekday without doing date math yourself (you get this wrong). Use before scheduling anything whose date isn't already an obvious YYYY-MM-DD. Pass ONE of: date (YYYY-MM-DD, to confirm its weekday), in_days (0=today, 1=tomorrow, 7=a week out), or weekday+occurrence ('this'/'next'). Returns iso_date, weekday, and a pretty label. Always use the returned iso_date when creating the event/task/reminder.",
    input_schema: {
      type: "object",
      properties: {
        date: { type: "string", description: "YYYY-MM-DD to look up the weekday for." },
        in_days: { type: "number", description: "Days from today (0=today, 1=tomorrow)." },
        weekday: { type: "string", description: "e.g. 'Thursday'." },
        occurrence: { type: "string", enum: ["this", "next"], description: "For weekday: this week's or next." },
      },
    },
  },
  {
    name: "create_calendar_event",
    description:
      "Add an event to Pilar's Google Calendar. Use for reminders (at their time) and for each block when planning her day. For a FOCUS/WORK/TASK block you scheduled (not an external meeting/appointment), set is_block:true so Kara checks in when the block ends — and pass task_id if the block is for a specific to-do, so she can mark it done.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        start: { type: "string", description: "PLAIN local wall-clock time, NO offset and NO Z, e.g. 2026-08-14T15:00:00 for 3pm ET. Get the date from resolve_date / the date table — don't compute it." },
        end: { type: "string", description: "Plain local wall-clock time, no offset; optional, defaults to 30 min after start." },
        description: { type: "string" },
        is_block: { type: "boolean", description: "True for a focus/work/task time block you scheduled — enables an end-of-block accountability check-in. False/omit for external meetings & appointments." },
        task_id: { type: "string", description: "Notion task id this block is for (optional). Lets Kara mark the task done when the block ends." },
      },
      required: ["title", "start"],
    },
  },
  {
    name: "list_calendar_events",
    description:
      "List Pilar's Google Calendar events in a time range (defaults to the next 7 days). Use this to FIND an event's id before rescheduling or deleting it, or to answer 'what's on my calendar'.",
    input_schema: {
      type: "object",
      properties: {
        time_min: { type: "string", description: "ISO datetime, start of range (optional, defaults to now)" },
        time_max: { type: "string", description: "ISO datetime, end of range (optional, defaults to +7 days)" },
        query: { type: "string", description: "Optional text to match in event titles" },
      },
    },
  },
  {
    name: "update_calendar_event",
    description:
      "Reschedule or rename an existing calendar event. First use list_calendar_events to get the event_id.",
    input_schema: {
      type: "object",
      properties: {
        event_id: { type: "string" },
        title: { type: "string" },
        start: { type: "string", description: "New plain local wall-clock time, no offset (e.g. 2026-08-14T15:00:00)." },
        end: { type: "string", description: "New plain local wall-clock time, no offset." },
      },
      required: ["event_id"],
    },
  },
  {
    name: "delete_calendar_event",
    description:
      "Delete a calendar event. First use list_calendar_events to get the event_id, then delete it.",
    input_schema: {
      type: "object",
      properties: {
        event_id: { type: "string" },
      },
      required: ["event_id"],
    },
  },
];

export async function runCalendarTool(name, input) {
  switch (name) {
    case "resolve_date": return resolveDate(input);
    case "create_calendar_event": return createEvent(input);
    case "list_calendar_events": return listEvents(input);
    case "update_calendar_event": return updateEvent(input);
    case "delete_calendar_event": return deleteEvent(input);
    default: throw new Error(`Unknown calendar tool: ${name}`);
  }
}
