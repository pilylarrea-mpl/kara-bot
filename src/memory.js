import fs from "fs";
import path from "path";
import { appendSharedFact, removeSharedFact, listSharedFacts } from "./notion.js";

// Durable memory now lives in Notion (the 🧠 About Pilar page) so Kara AND the
// claude.ai projects share ONE memory — see notion.js. This module keeps only
// the LOCAL reminder-ping timestamps (so follow-ups repeat until done); that's
// bot-internal state that doesn't belong in the shared brain.
const DATA_DIR = path.resolve("data");
const MEM_FILE = path.join(DATA_DIR, "memory.json");

function ensure() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}
function read() {
  ensure();
  try {
    const d = JSON.parse(fs.readFileSync(MEM_FILE, "utf8"));
    return { reminderPings: d.reminderPings || {} };
  } catch {
    return { reminderPings: {} };
  }
}
function write(d) {
  ensure();
  fs.writeFileSync(MEM_FILE, JSON.stringify(d, null, 2));
}

// ---------- reminder-ping tracking (persistent follow-ups) ----------
export function shouldPingReminder(id, intervalMs) {
  const last = read().reminderPings[id];
  if (!last) return true;
  return Date.now() - new Date(last).getTime() >= intervalMs;
}
export function markReminderPinged(id) {
  const d = read();
  d.reminderPings[id] = new Date().toISOString();
  write(d);
}
export function clearReminderPing(id) {
  const d = read();
  if (d.reminderPings[id]) {
    delete d.reminderPings[id];
    write(d);
  }
}

// ---------- memory tools (Notion-backed shared memory) ----------
export const memoryTools = [
  {
    name: "remember",
    description:
      "Save a permanent fact about Pilar to shared memory (the 🧠 About Pilar page in Notion, which Kara and all her Claude projects read). Use for: things she's done (booked X, paid Y), standing preferences (sizes, brands, food, style), constraints, decisions, and how she likes to work. If she tells you the same kind of thing twice, it belongs here. One clear sentence each.",
    input_schema: {
      type: "object",
      properties: { text: { type: "string", description: "One clear factual sentence to remember." } },
      required: ["text"],
    },
  },
  {
    name: "forget",
    description: "Remove a stale/incorrect fact from shared memory. Pass a text snippet to match (or the block id from list_memory). Use when a saved fact is no longer true — then remember the corrected version.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        contains: { type: "string", description: "Text snippet; removes memory bullets containing it." },
      },
    },
  },
  {
    name: "list_memory",
    description: "List the saved facts in shared memory (with ids), to review before forgetting one.",
    input_schema: { type: "object", properties: {} },
  },
];

export async function runMemoryTool(name, input) {
  switch (name) {
    case "remember": return appendSharedFact(input);
    case "forget": return removeSharedFact(input);
    case "list_memory": return { facts: await listSharedFacts() };
    default: throw new Error(`Unknown memory tool: ${name}`);
  }
}
