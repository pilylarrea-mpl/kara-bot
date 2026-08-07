// One-time Gmail OAuth for Kara.
//
// Run this ONCE on your laptop to mint a refresh token for Pilar's personal
// Gmail. It opens a browser, you click "Allow", and it prints the three values
// to put in .env (and Railway): GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET,
// GMAIL_REFRESH_TOKEN.
//
// Usage:
//   GMAIL_CLIENT_ID=xxx GMAIL_CLIENT_SECRET=yyy node scripts/gmail-auth.js
//
// Scope: gmail.modify (read, search, label, archive, draft). NOT send.

import http from "http";
import { google } from "googleapis";
import { exec } from "child_process";

const CLIENT_ID = process.env.GMAIL_CLIENT_ID;
const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;
const PORT = 5555;
const REDIRECT = `http://localhost:${PORT}`;
const SCOPES = ["https://www.googleapis.com/auth/gmail.modify"];

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error(
    "\nMissing credentials. Run like:\n" +
      "  GMAIL_CLIENT_ID=xxx GMAIL_CLIENT_SECRET=yyy node scripts/gmail-auth.js\n"
  );
  process.exit(1);
}

const oauth2 = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT);
const authUrl = oauth2.generateAuthUrl({
  access_type: "offline",
  prompt: "consent", // force a refresh_token every time
  scope: SCOPES,
});

const server = http.createServer(async (req, res) => {
  if (!req.url.startsWith("/?")) {
    res.end("Waiting for Google redirect…");
    return;
  }
  const code = new URL(req.url, REDIRECT).searchParams.get("code");
  if (!code) {
    res.end("No code received.");
    return;
  }
  try {
    const { tokens } = await oauth2.getToken(code);
    res.end("✅ Kara is authorized for Gmail. You can close this tab and return to the terminal.");
    console.log("\n===== COPY THESE INTO .env AND RAILWAY =====\n");
    console.log(`GMAIL_CLIENT_ID=${CLIENT_ID}`);
    console.log(`GMAIL_CLIENT_SECRET=${CLIENT_SECRET}`);
    console.log(`GMAIL_REFRESH_TOKEN=${tokens.refresh_token}`);
    console.log("\n============================================\n");
    if (!tokens.refresh_token) {
      console.log(
        "⚠️  No refresh_token returned. Revoke Kara's access at " +
          "https://myaccount.google.com/permissions and run this again.\n"
      );
    }
    server.close();
    process.exit(0);
  } catch (e) {
    res.end("Error exchanging code: " + e.message);
    console.error(e);
    process.exit(1);
  }
});

server.listen(PORT, () => {
  console.log(`\nOpen this URL to authorize Kara for Gmail:\n\n${authUrl}\n`);
  // Best-effort auto-open on macOS.
  exec(`open "${authUrl}"`, () => {});
});
