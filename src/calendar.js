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

export async function createEvent({ title, start, end, description, is_block, task_id }) {
  if (!calendarEnabled) return NOT_READY;
  const endDt = end || new Date(new Date(start).getTime() + 30 * 60000).toISOString();
  const requestBody = {
    summary: title,
    description: description || "",
    start: { dateTime: start, timeZone: TZ },
    end: { dateTime: endDt, timeZone: TZ },
  };
  // Tag focus/work blocks so the accountability loop can follow up when they end.
  if (is_block) {
    requestBody.extendedProperties = {
      private: { karaBlock: "1", followUpAsked: "0", ...(task_id ? { taskId: String(task_id) } : {}) },
    };
  }
  const res = await calendar.events.insert({ calendarId, requestBody });
  return { ok: true, id: res.data.id, link: res.data.htmlLink };
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

export const calendarTools = [
  {
    name: "create_calendar_event",
    description:
      "Add an event to Pilar's Google Calendar. Use for reminders (at their time) and for each block when planning her day. For a FOCUS/WORK/TASK block you scheduled (not an external meeting/appointment), set is_block:true so Kara checks in when the block ends — and pass task_id if the block is for a specific to-do, so she can mark it done.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        start: { type: "string", description: "ISO datetime with offset, e.g. 2026-08-06T16:00:00-04:00" },
        end: { type: "string", description: "ISO datetime with offset; optional, defaults to 30 min after start" },
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
        start: { type: "string", description: "New ISO datetime with offset" },
        end: { type: "string", description: "New ISO datetime with offset" },
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
    case "create_calendar_event": return createEvent(input);
    case "list_calendar_events": return listEvents(input);
    case "update_calendar_event": return updateEvent(input);
    case "delete_calendar_event": return deleteEvent(input);
    default: throw new Error(`Unknown calendar tool: ${name}`);
  }
}
