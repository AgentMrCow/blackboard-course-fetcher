const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const base = String(process.env.BB_AUTH_BASE || "").trim().replace(/\/$/, "");
const stateFile = path.resolve(process.env.BB_AUTH_STATE_FILE || ".blackboard-state.json");
const profileDirectory = path.resolve(process.env.BB_AUTH_PROFILE || ".dashboard-data/login-profile");
let context = null;
let closed = false;

function send(type, payload = {}) {
  if (process.connected) process.send({ type, ...payload });
}

async function validateSession() {
  const response = await context.request.get(`${base}/learn/api/v1/users/me`, {
    headers: { Accept: "application/json" },
    timeout: 30_000,
    failOnStatusCode: false,
  });
  const contentType = response.headers()["content-type"] || "";
  let user = null;
  if (response.ok() && contentType.includes("json")) {
    try {
      user = await response.json();
    } catch {}
  }
  return {
    valid: Boolean(user?.id),
    status: response.status(),
    user: user
      ? {
          id: user.id,
          userName: user.userName || null,
          givenName: user.name?.given || null,
          familyName: user.name?.family || null,
        }
      : null,
  };
}

async function saveSession() {
  if (!context || closed) throw new Error("The sign-in browser is no longer open");
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  await context.storageState({ path: stateFile });
  const validation = await validateSession();
  send("saved", {
    stateFile,
    validation,
    message: validation.valid
      ? "The Blackboard session is valid and ready for inventory."
      : "The browser state was saved, but Blackboard still appears to require sign-in.",
  });
  if (validation.valid) await shutdown();
}

async function shutdown() {
  if (closed) return;
  closed = true;
  try {
    await context?.close();
  } catch {}
  setTimeout(() => process.exit(0), 20).unref();
}

async function main() {
  if (!base || !/^https?:\/\//i.test(base)) throw new Error("A valid Blackboard base URL is required");
  const executable = chromium.executablePath();
  if (!fs.existsSync(executable)) {
    throw new Error("Chromium is not installed. Run `npx playwright install chromium` in the fetcher directory.");
  }
  fs.mkdirSync(profileDirectory, { recursive: true });
  context = await chromium.launchPersistentContext(profileDirectory, {
    headless: false,
    viewport: null,
    acceptDownloads: false,
  });
  context.once("close", () => {
    if (!closed) {
      closed = true;
      send("closed", { message: "The sign-in browser was closed before the session was confirmed." });
      setTimeout(() => process.exit(0), 20).unref();
    }
  });
  const pages = context.pages();
  const page = pages[0] || (await context.newPage());
  await page.goto(base, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
  await page.bringToFront();
  send("ready", {
    message: "Complete sign-in and MFA in the Blackboard browser, then return to the dashboard and confirm the session.",
  });
}

process.on("message", (message) => {
  if (message?.type === "save") saveSession().catch((error) => send("error", { message: error.message }));
  if (message?.type === "cancel") shutdown().catch(() => process.exit(0));
});

process.on("SIGTERM", () => shutdown().catch(() => process.exit(0)));
process.on("SIGINT", () => shutdown().catch(() => process.exit(0)));

main().catch((error) => {
  send("error", { message: error.message });
  console.error(error.message);
  process.exit(1);
});
