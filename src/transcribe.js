import "dotenv/config";

// Voice-note transcription for Kara. Telegram voice notes arrive as OGG/Opus;
// we send the bytes to a Whisper endpoint and get text back. Optional: if no
// key is set, transcription is disabled and the bot asks Pilar to type instead.
//
// Provider is chosen by which key is present. Groq is the default (free tier,
// fast, no billing). OpenAI works too — both expose the same Whisper API shape.
const GROQ_KEY = process.env.GROQ_API_KEY;
const OPENAI_KEY = process.env.OPENAI_API_KEY;

const PROVIDERS = {
  groq: {
    url: "https://api.groq.com/openai/v1/audio/transcriptions",
    key: GROQ_KEY,
    model: "whisper-large-v3-turbo",
  },
  openai: {
    url: "https://api.openai.com/v1/audio/transcriptions",
    key: OPENAI_KEY,
    model: "whisper-1",
  },
};

const active = GROQ_KEY ? PROVIDERS.groq : OPENAI_KEY ? PROVIDERS.openai : null;
export const transcribeEnabled = !!active;
if (active) console.log(`Voice transcription enabled (${GROQ_KEY ? "groq" : "openai"}).`);

// Transcribe an audio Buffer. Returns { ok, text } or throws on a hard failure.
export async function transcribeAudio(buffer, filename = "voice.ogg") {
  if (!active) return { ok: false, note: "Transcription not configured." };
  const form = new FormData();
  form.append("file", new Blob([buffer]), filename);
  form.append("model", active.model);
  form.append("response_format", "json");
  const res = await fetch(active.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${active.key}` },
    body: form,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Transcription failed: ${res.status} ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  return { ok: true, text: (data.text || "").trim() };
}
