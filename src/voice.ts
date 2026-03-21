import path from "node:path";
import { readFile } from "node:fs/promises";

export interface TranscriptionResult {
  text: string;
  backend: "parakeet" | "openai";
  durationMs: number;
}

export type TranscriptionBackend = "parakeet" | "openai";

const NO_BACKEND_ERROR = `Voice messages require a transcription backend.

Option 1: Install Parakeet for local transcription (free, private, ~600MB download):
  npm install parakeet-node

Option 2: Set OPENAI_API_KEY for cloud transcription (~$0.006/min):
  Add OPENAI_API_KEY=sk-... to your .env file`;

let _importModule: (specifier: string) => Promise<any> = (specifier) => import(specifier);

export function _setImportHook(hook: (specifier: string) => Promise<any>): void {
  _importModule = hook;
}

export function _resetImportHook(): void {
  _importModule = (specifier) => import(specifier);
}

export async function transcribeAudio(filePath: string): Promise<TranscriptionResult> {
  try {
    return await transcribeWithParakeet(filePath);
  } catch (error) {
    if (!isModuleNotFoundError(error, "parakeet-node")) {
      throw error;
    }
  }

  if (hasOpenAIApiKey()) {
    return await transcribeWithOpenAI(filePath);
  }

  throw new Error(NO_BACKEND_ERROR);
}

export async function getAvailableBackends(): Promise<TranscriptionBackend[]> {
  const backends: TranscriptionBackend[] = [];

  try {
    await _importModule("parakeet-node");
    backends.push("parakeet");
  } catch {
    // Treat import failures as unavailable so /start can still work.
  }

  if (hasOpenAIApiKey()) {
    backends.push("openai");
  }

  return backends;
}

async function transcribeWithParakeet(filePath: string): Promise<TranscriptionResult> {
  const startedAt = Date.now();
  const parakeet = (await _importModule("parakeet-node")) as any;
  const transcribe =
    typeof parakeet?.transcribe === "function"
      ? parakeet.transcribe.bind(parakeet)
      : typeof parakeet?.default?.transcribe === "function"
        ? parakeet.default.transcribe.bind(parakeet.default)
        : undefined;

  if (!transcribe) {
    throw new Error("parakeet-node was loaded but does not expose a transcribe(filePath) function");
  }

  const result = await transcribe(filePath);
  const text = extractTranscribedText(result);
  if (text === undefined) {
    throw new Error("parakeet-node returned an unsupported transcription result");
  }

  return {
    text,
    backend: "parakeet",
    durationMs: Date.now() - startedAt,
  };
}

async function transcribeWithOpenAI(filePath: string): Promise<TranscriptionResult> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(NO_BACKEND_ERROR);
  }

  const startedAt = Date.now();
  const audioBuffer = await readFile(filePath);
  const ext = (path.extname(filePath) || ".ogg").slice(1).toLowerCase();
  const mimeTypes: Record<string, string> = {
    ogg: "audio/ogg", oga: "audio/ogg", mp3: "audio/mpeg",
    m4a: "audio/mp4", aac: "audio/aac", wav: "audio/wav",
    webm: "audio/webm", flac: "audio/flac",
  };
  const mimeType = mimeTypes[ext] ?? "audio/ogg";
  const form = new FormData();
  form.append("file", new Blob([audioBuffer], { type: mimeType }), path.basename(filePath) || "audio.ogg");
  form.append("model", "whisper-1");

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: form,
  });

  if (!response.ok) {
    const errorText = (await response.text().catch(() => "")).trim();
    throw new Error(
      `OpenAI transcription failed (${response.status}): ${errorText || response.statusText || "Unknown error"}`,
    );
  }

  const payload = (await response.json()) as { text?: unknown };
  if (typeof payload.text !== "string") {
    throw new Error("OpenAI transcription response did not include a text field");
  }

  return {
    text: payload.text,
    backend: "openai",
    durationMs: Date.now() - startedAt,
  };
}

function hasOpenAIApiKey(): boolean {
  return Boolean(process.env.OPENAI_API_KEY?.trim());
}

function extractTranscribedText(result: unknown): string | undefined {
  if (typeof result === "string") {
    return result;
  }

  if (typeof result === "object" && result !== null && typeof (result as { text?: unknown }).text === "string") {
    return (result as { text: string }).text;
  }

  return undefined;
}

function isModuleNotFoundError(error: unknown, specifier: string): boolean {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") {
    const message = error instanceof Error ? error.message : String(error);
    // Only treat as "not installed" if the message references the specific package.
    // A broken transitive dependency (e.g. missing native addon) should surface as a real error.
    return !message || message.includes(specifier);
  }

  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes(`Cannot find package '${specifier}'`) ||
    message.includes(`Cannot find module '${specifier}'`) ||
    message.includes(`Cannot resolve module '${specifier}'`)
  );
}
