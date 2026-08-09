import fs from "fs";
import path from "path";

// Durable, permanent memory for Kara — survives the rolling chat window so she
// never "forgets" facts Pilar told her days ago (booked flights, standing
// preferences, constraints, decisions). Stored on the Railway volume at
// data/memory.json. The facts are injected into EVERY system prompt, so they're
// always in front of her. Also tracks reminder-ping timestamps so follow-ups
// repeat until done instead of firing once.
const DATA_DIR = path.resolve("data");
const MEM_FILE = path.join(DATA_DIR, "memory.json");

// A few known-true facts to bootstrap a fresh memory (first boot on the volume),
// so Kara starts out already knowing the things Pilar is tired of repeating.
const SEED_FACTS = [
  "Pilar already booked her flights for the Smash wedding — do NOT ask her to book or re-check them.",
];

function ensure() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}
function read() {
  ensure();
  let d;
  try {
    d = JSON.parse(fs.readFileSync(MEM_FILE, "utf8"));
  } catch {
    // Fresh memory: seed it once so the bootstrap facts persist on the volume.
    const seeded = {
      facts: SEED_FACTS.map((text, i) => ({ id: `seed${i}`, text, at: new Date().toISOString() })),
      reminderPings: {},
    };
    try { write(seeded); } catch {}
    return seeded;
  }
  return { facts: d.facts || [], reminderPings: d.reminderPings || {} };
}
function write(d) {
  ensure();
  fs.writeFileSync(MEM_FILE, JSON.stringify(d, null, 2));
}

let seq = 0;
function nextId() {
  return Date.now().toString(36) + (seq++).toString(36);
}

// ---------- facts (durable memory) ----------
export function loadFacts() {
  return read().facts;
}

// Rendered into the system prompt every turn.
export function factsBlock() {
  const facts = loadFacts();
  if (!facts.length) return "";
  const lines = facts.map((f) => `- ${f.text}`).join("\n");
  return `## Durable memory — what you already KNOW about Pilar (never forget or re-ask these)
These are permanent facts you've saved. Treat them as true right now. If Pilar says something that updates one (e.g. a task is now done, a plan changed), call forget on the stale fact and remember the new one. NEVER tell her you don't know something that's here, and never re-ask about something already recorded here.
${lines}`;
}

export function rememberFact({ text }) {
  if (!text || !text.trim()) return { ok: false, note: "empty" };
  const d = read();
  const norm = text.trim();
  if (d.facts.some((f) => f.text.toLowerCase() === norm.toLowerCase())) {
    return { ok: true, note: "already known", count: d.facts.length };
  }
  d.facts.push({ id: nextId(), text: norm, at: new Date().toISOString() });
  write(d);
  return { ok: true, id: d.facts[d.facts.length - 1].id, count: d.facts.length };
}

export function forgetFact({ id, contains }) {
  const d = read();
  const before = d.facts.length;
  d.facts = d.facts.filter(
    (f) =>
      !(id && f.id === id) &&
      !(contains && f.text.toLowerCase().includes(contains.toLowerCase()))
  );
  write(d);
  return { ok: true, removed: before - d.facts.length, count: d.facts.length };
}

export function listFacts() {
  return loadFacts();
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

// ---------- tool schemas ----------
export const memoryTools = [
  {
    name: "remember",
    description:
      "Save a permanent fact about Pilar to durable memory so you NEVER forget it, even weeks later. Use for: things she's done (booked X flights, paid Y), standing preferences (sizes, brands, food, style), constraints (lives in PR until Dec, doesn't drink much), decisions, and recurring context. If she tells you the same kind of thing twice, that's a sign it belongs here. Keep each fact one clear sentence.",
    input_schema: {
      type: "object",
      properties: { text: { type: "string", description: "One clear factual sentence to remember." } },
      required: ["text"],
    },
  },
  {
    name: "forget",
    description:
      "Remove a stale/incorrect fact from durable memory. Pass the id (from list_memory) or a text snippet to match. Use when a saved fact is no longer true (a plan changed, a preference updated) — remove the old one and remember the new one.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        contains: { type: "string", description: "Text snippet; removes facts containing it." },
      },
    },
  },
  {
    name: "list_memory",
    description: "List everything you've saved in durable memory (with ids), to review or before forgetting one.",
    input_schema: { type: "object", properties: {} },
  },
];

export async function runMemoryTool(name, input) {
  switch (name) {
    case "remember": return rememberFact(input);
    case "forget": return forgetFact(input);
    case "list_memory": return { facts: listFacts() };
    default: throw new Error(`Unknown memory tool: ${name}`);
  }
}
