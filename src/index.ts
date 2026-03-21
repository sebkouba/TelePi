import type { UserFromGetMe } from "grammy/types";

import { createBot, registerCommands } from "./bot.js";
import { loadConfig } from "./config.js";
import type { PiSessionInfo } from "./pi-session.js";
import { PiSessionService } from "./pi-session.js";

const STARTUP_CHECK_FLAG = "--check";
const isStartupCheck = process.argv.includes(STARTUP_CHECK_FLAG);

let piSession: PiSessionService | undefined;
let bot: ReturnType<typeof createBot> | undefined;
let hasLoggedStartup = false;

try {
  const config = loadConfig();
  piSession = await PiSessionService.create(config);
  bot = createBot(config, piSession);
  await registerCommands(bot);

  if (isStartupCheck) {
    const botInfo = await bot.api.getMe();
    console.log(`TelePi startup check passed (${formatBotIdentity(botInfo)})`);
    logSessionInfo(piSession.getInfo());
    piSession.dispose();
    process.exit(0);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to start TelePi: ${message}`);
  piSession?.dispose();
  process.exit(1);
}

let shuttingDown = false;
const shutdown = (signal: NodeJS.Signals) => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  console.log(`Received ${signal}, shutting down TelePi...`);
  if (bot) bot.stop();

  // Give grammy a moment to finish in-flight dispatches before disposing the Pi session
  setTimeout(() => {
    piSession?.dispose();
    console.log("TelePi stopped.");
    process.exit(0);
  }, 500);
};

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

// Polling loop with auto-restart on transient errors (e.g. 409 conflicts)
const MAX_RESTART_ATTEMPTS = 5;
const RESTART_DELAY_MS = 3000;
let restartAttempts = 0;

async function startPolling(): Promise<void> {
  try {
    // Drop pending updates to clear stale getUpdates offsets and avoid 409 conflicts
    await bot!.start({
      drop_pending_updates: true,
      onStart: () => {
        restartAttempts = 0;
        if (!hasLoggedStartup && piSession) {
          hasLoggedStartup = true;
          console.log("TelePi running");
          logSessionInfo(piSession.getInfo());
        }
      },
    });
  } catch (error) {
    if (shuttingDown) return;

    const message = error instanceof Error ? error.message : String(error);
    const is409 = message.includes("409") || message.includes("Conflict");

    if (is409 && restartAttempts < MAX_RESTART_ATTEMPTS) {
      restartAttempts++;
      console.warn(`Polling error (attempt ${restartAttempts}/${MAX_RESTART_ATTEMPTS}): ${message}`);
      console.warn(`Restarting polling in ${RESTART_DELAY_MS / 1000}s...`);
      await new Promise((resolve) => setTimeout(resolve, RESTART_DELAY_MS));
      return startPolling();
    }

    console.error(`Fatal polling error: ${message}`);
    piSession?.dispose();
    process.exit(1);
  }
}

function logSessionInfo(sessionInfo: PiSessionInfo): void {
  console.log(`Session ID: ${sessionInfo.sessionId}`);
  console.log(`Session file: ${sessionInfo.sessionFile ?? "(in-memory)"}`);
  console.log(`Workspace: ${sessionInfo.workspace}`);
}

function formatBotIdentity(botInfo: UserFromGetMe): string {
  if (botInfo.username) {
    return `@${botInfo.username}`;
  }

  return botInfo.first_name || `bot ${botInfo.id}`;
}

await startPolling();
