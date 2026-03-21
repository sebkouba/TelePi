import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, describe, vi } from "vitest";

import {
  _resetImportHook,
  _setImportHook,
  getAvailableBackends,
  transcribeAudio,
} from "../src/voice.js";

describe("voice transcription", () => {
  const originalOpenAIKey = process.env.OPENAI_API_KEY;
  let tempDir: string;
  let audioPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "telepi-voice-"));
    audioPath = path.join(tempDir, "sample.ogg");
    writeFileSync(audioPath, Buffer.from("audio"));
    delete process.env.OPENAI_API_KEY;
    _resetImportHook();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    _resetImportHook();
    vi.unstubAllGlobals();
    rmSync(tempDir, { recursive: true, force: true });
    if (originalOpenAIKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalOpenAIKey;
    }
  });

  it("uses parakeet when available", async () => {
    _setImportHook(async (specifier) => {
      if (specifier === "parakeet-node") {
        return { transcribe: async () => ({ text: "hello world" }) };
      }
      throw new Error(`unexpected import: ${specifier}`);
    });

    const result = await transcribeAudio(audioPath);

    expect(result.text).toBe("hello world");
    expect(result.backend).toBe("parakeet");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("falls back to OpenAI when parakeet is unavailable", async () => {
    _setImportHook(async () => {
      const error = new Error("Cannot find package 'parakeet-node'") as Error & { code?: string };
      error.code = "ERR_MODULE_NOT_FOUND";
      throw error;
    });
    process.env.OPENAI_API_KEY = "sk-test";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ text: "cloud transcript" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await transcribeAudio(audioPath);

    expect(result).toMatchObject({
      text: "cloud transcript",
      backend: "openai",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.openai.com/v1/audio/transcriptions",
      expect.objectContaining({
        method: "POST",
        headers: { Authorization: "Bearer sk-test" },
        body: expect.any(FormData),
      }),
    );
  });

  it("throws a helpful error when no backend is available", async () => {
    _setImportHook(async () => {
      const error = new Error("Cannot find package 'parakeet-node'") as Error & { code?: string };
      error.code = "ERR_MODULE_NOT_FOUND";
      throw error;
    });

    await expect(transcribeAudio(audioPath)).rejects.toThrow("Voice messages require a transcription backend.");
    await expect(transcribeAudio(audioPath)).rejects.toThrow("npm install parakeet-node");
    await expect(transcribeAudio(audioPath)).rejects.toThrow("OPENAI_API_KEY=sk-");
  });

  it("surfaces OpenAI API errors", async () => {
    _setImportHook(async () => {
      const error = new Error("Cannot find package 'parakeet-node'") as Error & { code?: string };
      error.code = "ERR_MODULE_NOT_FOUND";
      throw error;
    });
    process.env.OPENAI_API_KEY = "sk-test";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        text: async () => "server exploded",
      }),
    );

    await expect(transcribeAudio(audioPath)).rejects.toThrow(
      "OpenAI transcription failed (500): server exploded",
    );
  });

  it("rethrows parakeet runtime errors instead of falling through", async () => {
    _setImportHook(async () => ({
      transcribe: async () => {
        throw new Error("GPU failure");
      },
    }));
    process.env.OPENAI_API_KEY = "sk-test";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(transcribeAudio(audioPath)).rejects.toThrow("GPU failure");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports available backends", async () => {
    _setImportHook(async (specifier) => {
      if (specifier === "parakeet-node") {
        return { default: { transcribe: async () => "ignored" } };
      }
      throw new Error(`unexpected import: ${specifier}`);
    });
    process.env.OPENAI_API_KEY = "sk-test";

    await expect(getAvailableBackends()).resolves.toEqual(["parakeet", "openai"]);

    _setImportHook(async () => {
      const error = new Error("Cannot find package 'parakeet-node'") as Error & { code?: string };
      error.code = "ERR_MODULE_NOT_FOUND";
      throw error;
    });
    delete process.env.OPENAI_API_KEY;

    await expect(getAvailableBackends()).resolves.toEqual([]);
  });

  it("allows empty transcripts without throwing", async () => {
    _setImportHook(async () => ({
      default: { transcribe: async () => ({ text: "" }) },
    }));

    const result = await transcribeAudio(audioPath);

    expect(result).toMatchObject({
      text: "",
      backend: "parakeet",
    });
  });

  it("resolves transcribe from parakeet default export", async () => {
    _setImportHook(async () => ({
      default: { transcribe: async () => "default export transcript" },
    }));

    const result = await transcribeAudio(audioPath);

    expect(result.text).toBe("default export transcript");
    expect(result.backend).toBe("parakeet");
  });

  it("throws when OpenAI response is missing text field", async () => {
    _setImportHook(async () => {
      const error = new Error("Cannot find package 'parakeet-node'") as Error & { code?: string };
      error.code = "ERR_MODULE_NOT_FOUND";
      throw error;
    });
    process.env.OPENAI_API_KEY = "sk-test";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ result: "ok" }),
      }),
    );

    await expect(transcribeAudio(audioPath)).rejects.toThrow(
      "OpenAI transcription response did not include a text field",
    );
  });

  it("throws when fetch rejects entirely (network failure)", async () => {
    _setImportHook(async () => {
      const error = new Error("Cannot find package 'parakeet-node'") as Error & { code?: string };
      error.code = "ERR_MODULE_NOT_FOUND";
      throw error;
    });
    process.env.OPENAI_API_KEY = "sk-test";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network unreachable")),
    );

    await expect(transcribeAudio(audioPath)).rejects.toThrow("network unreachable");
  });

  it("surfaces broken parakeet transitive dependency instead of falling through", async () => {
    _setImportHook(async () => {
      // Simulate a broken native addon — MODULE_NOT_FOUND for a sub-dependency unrelated to parakeet-node
      const error = new Error("Cannot find module '/usr/lib/node_modules/napi-bindings/build/Release/binding.node'") as Error & { code?: string };
      error.code = "MODULE_NOT_FOUND";
      throw error;
    });
    process.env.OPENAI_API_KEY = "sk-test";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    // Should throw the transitive error, NOT silently fall through to OpenAI
    await expect(transcribeAudio(audioPath)).rejects.toThrow("binding.node");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
