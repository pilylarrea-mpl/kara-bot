import { google } from "googleapis";

// Google Calendar via a service account. Optional: if GOOGLE_CREDENTIALS_JSON
// isn't set, the tools no-op gracefully so the rest of the bot still runs.
const calendarId = process.env.GOOGLE_CALENDAR_ID || "primary";
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

export async function createEvent({ title, start, end, description }) {
  if (!calendarEnabled) return { ok: false, note: "Google Calendar not configured yet." };
  const endDt = end || new Date(new Date(start).getTime() + 30 * 60000).toISOString();
  const res = await calendar.events.insert({
    calendarId,
    requestBody: {
      summary: title,
      description: description || "",
      start: { dateTime: start, timeZone: "America/New_York" },
      end: { dateTime: endDt, timeZone: "America/New_York" },
    },
  });
  return { ok: true, id: res.data.id, link: res.data.htmlLink };
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
];

export async function runCalendarTool(name, input) {
  if (name === "create_calendar_event") return createEvent(input);
  throw new Error(`Unknown calendar tool: ${name}`);
}
