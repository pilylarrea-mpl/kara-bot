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

export async function createEvent({ title, start, end, description }) {
  if (!calendarEnabled) return NOT_READY;
  const endDt = end || new Date(new Date(start).getTime() + 30 * 60000).toISOString();
  const res = await calendar.events.insert({
    calendarId,
    requestBody: {
      summary: title,
      description: description || "",
      start: { dateTime: start, timeZone: TZ },
      end: { dateTime: endDt, timeZone: TZ },
    },
  });
  return { ok: true, id: res.data.id, link: res.data.htmlLink };
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
      "Add an event to Pilar's Google Calendar. Use for reminders (at their time) and for each block when planning her day.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        start: { type: "string", description: "ISO datetime with offset, e.g. 2026-08-06T16:00:00-04:00" },
        end: { type: "string", description: "ISO datetime with offset; optional, defaults to 30 min after start" },
        description: { type: "string" },
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
