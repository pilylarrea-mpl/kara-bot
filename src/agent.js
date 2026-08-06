import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { systemPrompt } from "./kara.js";
import { notionTools, runNotionTool } from "./notion.js";
import { calendarTools, runCalendarTool } from "./calendar.js";

const client = new Anthropic({ apiKey: config.anthropicKey });

const allTools = [...notionTools, ...calendarTools];
const calNames = new Set(calendarTools.map((t) => t.name));

const MAX_STEPS = 8;

/**
 * Run Kara over a message history. Executes Notion tool calls in a loop until
 * she produces a final text answer.
 * @param {Array} messages  Anthropic message array (mutated copy returned).
 * @returns {{ text: string, messages: Array }}
 */
export async function runAgent(messages) {
  const convo = [...messages];

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
