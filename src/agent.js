import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { systemPrompt } from "./kara.js";
import { notionTools, runNotionTool, getAboutPilar, getCurrentSprint, overdueTasks } from "./notion.js";
import { calendarTools, runCalendarTool } from "./calendar.js";
import { gmailTools, runGmailTool } from "./gmail.js";
import { memoryTools, runMemoryTool } from "./memory.js";

const client = new Anthropic({ apiKey: config.anthropicKey });

// Anthropic-hosted server tools, executed on Anthropic's side — no key or client
// handler needed. web_search: research live info (prices, flights, vendors,
// facts). web_fetch: read the actual content of a URL Pilar pastes (article,
// newsletter, listing) and summarize it. She still never books/buys — a handoff.
const WEB_FETCH_BETA = "web-fetch-2025-09-10";
const serverTools = [
  { type: "web_search_20250305", name: "web_search", max_uses: 5 },
  { type: "web_fetch_20250910", name: "web_fetch", max_uses: 5, max_content_tokens: 50000 },
];

const clientTools = [...notionTools, ...calendarTools, ...gmailTools, ...memoryTools];
const allTools = [...clientTools, ...serverTools];
const calNames = new Set(calendarTools.map((t) => t.name));
const gmailNames = new Set(gmailTools.map((t) => t.name));
const memoryNames = new Set(memoryTools.map((t) => t.name));

const MAX_STEPS = 8;

/**
 * Heal a possibly-corrupted history before sending it to the API.
 * When old turns get trimmed off the front, a `tool_result` can be left with
 * no matching `tool_use` before it — which the API rejects with a 400. Drop any
 * leading assistant turns or orphaned tool_result turns so the conversation
 * always starts on a clean user message.
 */
function sanitizeHistory(msgs) {
  while (msgs.length) {
    const m = msgs[0];
    const hasToolResult =
      Array.isArray(m.content) && m.content.some((b) => b && b.type === "tool_result");
    if (m.role === "assistant" || (m.role === "user" && hasToolResult)) {
      msgs.shift();
    } else {
      break;
    }
  }
  return msgs;
}

/**
 * Run Kara over a message history. Executes Notion tool calls in a loop until
 * she produces a final text answer.
 * @param {Array} messages  Anthropic message array (mutated copy returned).
 * @returns {{ text: string, messages: Array }}
 */
export async function runAgent(messages) {
  const convo = sanitizeHistory([...messages]);

  // Pull shared memory (About Pilar page), the live current sprint, and any
  // overdue tasks once per run so Kara is always aware of what's slipping.
  const [about, sprint, overdue] = await Promise.all([
    getAboutPilar(),
    getCurrentSprint(),
    overdueTasks().catch(() => []),
  ]);
  const overdueText = (overdue || [])
    .slice(0, 20)
    .map((t) => `- ${t.task} (due ${t.due}${t.priority ? ", " + t.priority : ""}${t.area ? ", " + t.area : ""})`)
    .join("\n");

  for (let step = 0; step < MAX_STEPS; step++) {
    const res = await client.beta.messages.create({
      model: config.model,
      max_tokens: 4096,
      system: systemPrompt({ about, sprint, overdue: overdueText }),
      tools: allTools,
      messages: convo,
      betas: [WEB_FETCH_BETA],
    });

    convo.push({ role: "assistant", content: res.content });

    if (res.stop_reason !== "tool_use") {
      const text = res.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      return { text: text || "…", messages: convo };
    }

    const toolResults = [];
    for (const block of res.content) {
      if (block.type !== "tool_use") continue;
      try {
        const input = block.input || {};
        const out = calNames.has(block.name)
          ? await runCalendarTool(block.name, input)
          : gmailNames.has(block.name)
          ? await runGmailTool(block.name, input)
          : memoryNames.has(block.name)
          ? await runMemoryTool(block.name, input)
          : await runNotionTool(block.name, input);
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify(out).slice(0, 8000),
        });
      } catch (err) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: `Error: ${err.message}`,
          is_error: true,
        });
      }
    }
    convo.push({ role: "user", content: toolResults });
  }

  return {
    text: "I got stuck mid-task — mind rephrasing that?",
    messages: convo,
  };
}
