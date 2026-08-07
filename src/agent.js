import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { systemPrompt } from "./kara.js";
import { notionTools, runNotionTool } from "./notion.js";
import { calendarTools, runCalendarTool } from "./calendar.js";
import { gmailTools, runGmailTool } from "./gmail.js";

const client = new Anthropic({ apiKey: config.anthropicKey });

const allTools = [...notionTools, ...calendarTools, ...gmailTools];
const calNames = new Set(calendarTools.map((t) => t.name));
const gmailNames = new Set(gmailTools.map((t) => t.name));

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

  for (let step = 0; step < MAX_STEPS; step++) {
    const res = await client.messages.create({
      model: config.model,
      max_tokens: 4096,
      system: systemPrompt(),
      tools: allTools,
      messages: convo,
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
