import { google } from "googleapis";

// Gmail via OAuth2 (personal account — a service account can't access personal
// Gmail). Optional: if the GMAIL_* env vars aren't set the tools no-op so the
// rest of the bot still runs. Scope is gmail.modify: read, search, label,
// archive, and create drafts. There is deliberately NO send capability — Kara
// drafts replies for Pilar to review and send herself.
let gmail = null;
export let gmailEnabled = false;

(function init() {
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) return;
  try {
    const auth = new google.auth.OAuth2(clientId, clientSecret);
    auth.setCredentials({ refresh_token: refreshToken });
    gmail = google.gmail({ version: "v1", auth });
    gmailEnabled = true;
    console.log("Gmail enabled (read + label + draft, no send).");
  } catch (e) {
    console.error("Gmail init failed:", e.message);
  }
})();

const NOT_READY = { ok: false, note: "Gmail not configured yet." };

// ---- helpers ----------------------------------------------------------------

function headerMap(headers = []) {
  const m = {};
  for (const h of headers) m[h.name.toLowerCase()] = h.value;
  return m;
}

// Walk a MIME payload and pull the best-effort plain-text body.
function extractText(payload) {
  if (!payload) return "";
  const decode = (data) => Buffer.from(data, "base64").toString("utf8");
  if (payload.body?.data && (!payload.mimeType || payload.mimeType.startsWith("text/"))) {
    const t = decode(payload.body.data);
    if (payload.mimeType === "text/html") return stripHtml(t);
    return t;
  }
  const parts = payload.parts || [];
  // Prefer text/plain, fall back to text/html, then recurse.
  const plain = parts.find((p) => p.mimeType === "text/plain");
  if (plain?.body?.data) return decode(plain.body.data);
  const html = parts.find((p) => p.mimeType === "text/html");
  if (html?.body?.data) return stripHtml(decode(html.body.data));
  for (const p of parts) {
    const t = extractText(p);
    if (t) return t;
  }
  return "";
}

function stripHtml(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Build a raw RFC-2822 message, base64url-encoded for the Gmail API.
function buildRaw({ to, from, subject, body, inReplyTo, references }) {
  const lines = [
    `To: ${to}`,
    from ? `From: ${from}` : null,
    `Subject: ${subject}`,
    inReplyTo ? `In-Reply-To: ${inReplyTo}` : null,
    references ? `References: ${references}` : null,
    "Content-Type: text/plain; charset=utf-8",
    "MIME-Version: 1.0",
    "",
    body,
  ].filter((l) => l !== null);
  return Buffer.from(lines.join("\r\n"))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// ---- tools ------------------------------------------------------------------

// Search the inbox. `query` is Gmail search syntax (e.g. "is:unread newer_than:2d",
// "from:mom", "label:important"). Returns light summaries — call read_email for a body.
export async function searchInbox({ query, max = 15 }) {
  if (!gmailEnabled) return NOT_READY;
  const res = await gmail.users.messages.list({
    userId: "me",
    q: query || "in:inbox newer_than:7d",
    maxResults: Math.min(max || 15, 25),
  });
  const ids = (res.data.messages || []).map((m) => m.id);
  const out = [];
  for (const id of ids) {
    const msg = await gmail.users.messages.get({
      userId: "me",
      id,
      format: "metadata",
      metadataHeaders: ["From", "Subject", "Date"],
    });
    const h = headerMap(msg.data.payload?.headers);
    out.push({
      id: msg.data.id,
      thread_id: msg.data.threadId,
      from: h.from || "",
      subject: h.subject || "(no subject)",
      date: h.date || "",
      snippet: msg.data.snippet || "",
      unread: (msg.data.labelIds || []).includes("UNREAD"),
      labels: msg.data.labelIds || [],
    });
  }
  return { ok: true, count: out.length, emails: out };
}

// Full body + headers for one message. Pass the message id from searchInbox.
export async function readEmail({ id }) {
  if (!gmailEnabled) return NOT_READY;
  const msg = await gmail.users.messages.get({ userId: "me", id, format: "full" });
  const h = headerMap(msg.data.payload?.headers);
  const body = extractText(msg.data.payload).slice(0, 6000);
  return {
    ok: true,
    id: msg.data.id,
    thread_id: msg.data.threadId,
    from: h.from || "",
    to: h.to || "",
    cc: h.cc || "",
    subject: h.subject || "(no subject)",
    date: h.date || "",
    message_id_header: h["message-id"] || "",
    references: h.references || "",
    body,
  };
}

// Create a DRAFT reply on a thread. Never sends — it lands in Gmail Drafts for
// Pilar to review, edit, and send. Threads correctly via In-Reply-To/References.
export async function draftReply({ message_id, body, to, subject }) {
  if (!gmailEnabled) return NOT_READY;
  // Pull the source message to thread the reply and infer recipient/subject.
  const src = await gmail.users.messages.get({
    userId: "me",
    id: message_id,
    format: "metadata",
    metadataHeaders: ["From", "Subject", "Message-ID", "References", "Reply-To"],
  });
  const h = headerMap(src.data.payload?.headers);
  const replyTo = to || h["reply-to"] || h.from;
  let subj = subject || h.subject || "";
  if (subj && !/^re:/i.test(subj)) subj = `Re: ${subj}`;
  const msgIdHeader = h["message-id"] || "";
  const references = [h.references, msgIdHeader].filter(Boolean).join(" ");
  const raw = buildRaw({
    to: replyTo,
    subject: subj,
    body,
    inReplyTo: msgIdHeader,
    references,
  });
  const res = await gmail.users.drafts.create({
    userId: "me",
    requestBody: { message: { raw, threadId: src.data.threadId } },
  });
  return {
    ok: true,
    draft_id: res.data.id,
    thread_id: src.data.threadId,
    to: replyTo,
    subject: subj,
    note: "Draft saved to Gmail — Pilar reviews & sends it herself.",
  };
}

// Create a fresh DRAFT (not a reply). Never sends.
export async function draftEmail({ to, subject, body }) {
  if (!gmailEnabled) return NOT_READY;
  const raw = buildRaw({ to, subject, body });
  const res = await gmail.users.drafts.create({
    userId: "me",
    requestBody: { message: { raw } },
  });
  return { ok: true, draft_id: res.data.id, to, subject, note: "Draft saved to Gmail." };
}

// Triage: add/remove labels, archive (remove INBOX), mark read (remove UNREAD).
// Pass label NAMES; unknown names are created on the fly.
export async function labelEmail({ message_id, add = [], remove = [], archive, mark_read }) {
  if (!gmailEnabled) return NOT_READY;
  const addIds = [];
  const removeIds = [];
  for (const name of add) addIds.push(await resolveLabelId(name));
  for (const name of remove) {
    const id = await resolveLabelId(name, { create: false });
    if (id) removeIds.push(id);
  }
  if (archive) removeIds.push("INBOX");
  if (mark_read) removeIds.push("UNREAD");
  await gmail.users.messages.modify({
    userId: "me",
    id: message_id,
    requestBody: { addLabelIds: addIds, removeLabelIds: removeIds },
  });
  return { ok: true, id: message_id, added: add, removed: [...remove, ...(archive ? ["INBOX"] : []), ...(mark_read ? ["UNREAD"] : [])] };
}

let labelCache = null;
async function loadLabels() {
  const res = await gmail.users.labels.list({ userId: "me" });
  labelCache = res.data.labels || [];
  return labelCache;
}
async function resolveLabelId(name, { create = true } = {}) {
  const builtin = name.toUpperCase();
  if (["INBOX", "UNREAD", "STARRED", "IMPORTANT", "SPAM", "TRASH"].includes(builtin)) return builtin;
  if (!labelCache) await loadLabels();
  let found = labelCache.find((l) => l.name.toLowerCase() === name.toLowerCase());
  if (found) return found.id;
  if (!create) return null;
  const res = await gmail.users.labels.create({
    userId: "me",
    requestBody: { name, labelListVisibility: "labelShow", messageListVisibility: "show" },
  });
  labelCache.push(res.data);
  return res.data.id;
}

export const gmailTools = [
  {
    name: "search_inbox",
    description:
      "Search Pilar's personal Gmail. `query` uses Gmail search syntax — e.g. 'is:unread newer_than:2d', 'in:inbox', 'from:someone@x.com', 'has:attachment'. Defaults to inbox mail from the last 7 days. Returns light summaries (from, subject, date, snippet, unread). Use read_email for a full body. Use this to triage: scan what's unread/important, then summarize for Pilar.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Gmail search query. Omit for recent inbox." },
        max: { type: "number", description: "Max results (default 15, cap 25)." },
      },
    },
  },
  {
    name: "read_email",
    description: "Read the full body + headers of one email by its message id (from search_inbox). Use before drafting a reply or summarizing a specific message.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string", description: "Gmail message id." } },
      required: ["id"],
    },
  },
  {
    name: "draft_reply",
    description:
      "Write a DRAFT reply to an email. It is saved to Gmail Drafts for Pilar to review, edit, and send HERSELF — you never send. Threads correctly. Recipient/subject are inferred from the source message unless you override. After drafting, tell Pilar it's in her drafts and give her the gist so she can approve.",
    input_schema: {
      type: "object",
      properties: {
        message_id: { type: "string", description: "Message id you're replying to (from search_inbox/read_email)." },
        body: { type: "string", description: "The reply text, in Pilar's voice — warm, concise." },
        to: { type: "string", description: "Override recipient (optional; defaults to sender / Reply-To)." },
        subject: { type: "string", description: "Override subject (optional; defaults to 'Re: <original>')." },
      },
      required: ["message_id", "body"],
    },
  },
  {
    name: "draft_email",
    description: "Write a brand-new DRAFT email (not a reply), saved to Gmail Drafts for Pilar to review and send. You never send.",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string" },
        subject: { type: "string" },
        body: { type: "string" },
      },
      required: ["to", "subject", "body"],
    },
  },
  {
    name: "label_email",
    description:
      "Triage an email: add/remove labels, archive it (removes from inbox), and/or mark it read. Label names you pass are created if they don't exist (e.g. 'Kara/Needs reply', 'Kara/Read later'). Use to clear noise (archive newsletters/receipts) and flag what needs Pilar. Only archive low-value mail — never archive something that needs a reply.",
    input_schema: {
      type: "object",
      properties: {
        message_id: { type: "string" },
        add: { type: "array", items: { type: "string" }, description: "Label names to add." },
        remove: { type: "array", items: { type: "string" }, description: "Label names to remove." },
        archive: { type: "boolean", description: "Remove from inbox." },
        mark_read: { type: "boolean", description: "Mark as read." },
      },
      required: ["message_id"],
    },
  },
];

export async function runGmailTool(name, input) {
  switch (name) {
    case "search_inbox": return searchInbox(input);
    case "read_email": return readEmail(input);
    case "draft_reply": return draftReply(input);
    case "draft_email": return draftEmail(input);
    case "label_email": return labelEmail(input);
    default: throw new Error(`Unknown gmail tool: ${name}`);
  }
}
