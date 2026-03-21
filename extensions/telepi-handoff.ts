import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const DEFAULT_TMUX_SESSION = "telepi";
const STARTUP_MARKER = "TelePi running";
const STARTUP_TIMEOUT_MS = 20_000;
const STARTUP_POLL_INTERVAL_MS = 1_000;
const LOG_TAIL_LINES = 12;

export default function (pi: ExtensionAPI) {
  pi.registerCommand("handoff", {
    description: "Hand off this session to TelePi (Telegram)",
    handler: async (_args, ctx) => {
      const sessionFile = ctx.sessionManager.getSessionFile();

      if (!sessionFile) {
        ctx.ui.notify("Cannot hand off an in-memory session. Save the session first.", "error");
        return;
      }

      const telePiDir = process.env.TELEPI_DIR?.trim();
      if (!telePiDir) {
        ctx.ui.notify(
          "TELEPI_DIR is not set. Add it to your shell profile:\n" +
          "  export TELEPI_DIR=/path/to/TelePi",
          "error",
        );
        return;
      }

      const tmuxSession = process.env.TELEPI_TMUX_SESSION?.trim() || DEFAULT_TMUX_SESSION;

      ctx.ui.notify(
        `Handing off to TelePi...\nSession: ${sessionFile}\nTmux session: ${tmuxSession}`,
        "info",
      );

      try {
        await killTmuxSession(pi, tmuxSession);
        await pi.exec("tmux", ["new-session", "-d", "-s", tmuxSession, "-c", telePiDir], {
          timeout: 5_000,
        });
        await pi.exec(
          "tmux",
          [
            "send-keys",
            "-t",
            tmuxSession,
            `export PI_SESSION_PATH=${shellQuote(sessionFile)} && npm run dev`,
            "Enter",
          ],
          { timeout: 5_000 },
        );

        const startup = await waitForTelePiStartup(pi, tmuxSession);
        if (!startup.ok) {
          const tail = startup.logTail ? `\n\nRecent log output:\n${startup.logTail}` : "";
          ctx.ui.notify(
            `TelePi did not report a successful startup in tmux session \"${tmuxSession}\".${tail}\n\nInspect with: tmux attach -t ${tmuxSession}`,
            "error",
          );
          return;
        }

        ctx.ui.notify(
          `✅ TelePi started in tmux session \"${tmuxSession}\". Check Telegram!`,
          "info",
        );
        ctx.shutdown();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(
          `Could not auto-launch TelePi. Start it manually:\n` +
          `cd ${shellQuote(telePiDir)} && PI_SESSION_PATH=${shellQuote(sessionFile)} npm run dev\n\n` +
          `Error: ${message}`,
          "warning",
        );
      }
    },
  });
}

async function killTmuxSession(pi: ExtensionAPI, sessionName: string): Promise<void> {
  const exists = await pi.exec("tmux", ["has-session", "-t", sessionName], { timeout: 2_000 })
    .then(() => true)
    .catch(() => false);

  if (!exists) {
    return;
  }

  await pi.exec("tmux", ["kill-session", "-t", sessionName], { timeout: 2_000 });
}

async function waitForTelePiStartup(
  pi: ExtensionAPI,
  sessionName: string,
): Promise<{ ok: boolean; logTail: string }> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let latestLog = "";

  while (Date.now() < deadline) {
    await sleep(STARTUP_POLL_INTERVAL_MS);
    latestLog = await captureTmuxPane(pi, sessionName);

    if (latestLog.includes(STARTUP_MARKER)) {
      return { ok: true, logTail: tailLines(latestLog, LOG_TAIL_LINES) };
    }

    if (latestLog.includes("Failed to start TelePi:") || latestLog.includes("Fatal polling error:")) {
      return { ok: false, logTail: tailLines(latestLog, LOG_TAIL_LINES) };
    }
  }

  latestLog = await captureTmuxPane(pi, sessionName);
  return {
    ok: latestLog.includes(STARTUP_MARKER),
    logTail: tailLines(latestLog, LOG_TAIL_LINES),
  };
}

async function captureTmuxPane(pi: ExtensionAPI, sessionName: string): Promise<string> {
  const result = await pi.exec("tmux", ["capture-pane", "-p", "-t", sessionName], { timeout: 2_000 })
    .catch(() => ({ stdout: "", stderr: "" }));

  return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
}

function tailLines(text: string, count: number): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .slice(-count)
    .join("\n");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
