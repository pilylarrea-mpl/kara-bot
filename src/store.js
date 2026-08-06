import fs from "fs";
import path from "path";

const DATA_DIR = path.resolve("data");
const HISTORY_FILE = path.join(DATA_DIR, "history.json");

// Keep the last N turns so context stays bounded and cheap.
const MAX_TURNS = 40;

function ensure() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

export function loadHistory() {
  ensure();
  try {
    return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
  } catch {
    return [];
  }
}

export function saveHistory(messages) {
  ensure();
  const trimmed = messages.slice(-MAX_TURNS);
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(trimmed, null, 2));
}
