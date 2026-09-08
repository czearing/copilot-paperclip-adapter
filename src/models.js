import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const DEFAULT_COPILOT_LOCAL_MODEL = "auto";

export const models = [
  { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
  { id: "gpt-5.6-sol-fast", label: "GPT-5.6 Sol Fast" },
  { id: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
  { id: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
  { id: "gpt-5.5", label: "GPT-5.5" },
  { id: "gpt-5.4", label: "GPT-5.4" },
  { id: "gpt-5.4-mini", label: "GPT-5.4 mini" },
  { id: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
  { id: "gpt-5-mini", label: "GPT-5 mini" },
  { id: "gpt-6-astra", label: "GPT-6 Astra" },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
  { id: "claude-opus-5", label: "Claude Opus 5" },
  { id: "claude-opus-4.8", label: "Claude Opus 4.8" },
  { id: "claude-opus-4.7", label: "Claude Opus 4.7" },
  { id: "claude-opus-4.6", label: "Claude Opus 4.6" },
  { id: "claude-haiku-4.5", label: "Claude Haiku 4.5" },
  { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash" },
  { id: "gemini-3.7-flash", label: "Gemini 3.7 Flash" },
  { id: "gemini-3.6-flash", label: "Gemini 3.6 Flash" },
  { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash" },
  { id: "grok-4.5", label: "Grok 4.5" },
  { id: "grok-4.6", label: "Grok 4.6" },
  { id: "mai-code-1.1-flash", label: "MAI-Code-1.1 Flash" },
  { id: "mai-code-1-flash-picker", label: "MAI-Code-1 Flash" },
  { id: "gpt-4.1", label: "GPT-4.1" },
  { id: "gpt-4o", label: "GPT-4o" },
  { id: "gpt-4o-mini", label: "GPT-4o mini" },
  { id: "auto", label: "Auto" },
];

export const modelProfiles = [
  {
    key: "cheap",
    label: "Cheap",
    description: "Use GPT-5.4 mini as the lower-cost Copilot lane while preserving the agent's primary model.",
    adapterConfig: {
      model: "gpt-5.4-mini",
    },
    source: "adapter_default",
  },
];

export const COPILOT_MODEL_ALIASES = {
  "claude-opus-4-8": "claude-opus-4.8",
  "claude-opus-4-7": "claude-opus-4.7",
  "claude-opus-4-6": "claude-opus-4.6",
  "claude-haiku-4-5": "claude-haiku-4.5",
  "claude-sonnet-4-5": "claude-sonnet-4.5",
  "gemini-3-8-flash": "gemini-3.8-flash",
  "gemini-3-7-flash": "gemini-3.7-flash",
  "gemini-3-6-flash": "gemini-3.6-flash",
  "gemini-3-5-flash": "gemini-3.5-flash",
  "grok-4-5": "grok-4.5",
  "grok-4-6": "grok-4.6",
  "gpt-6-astra": "gpt-6-astra",
  "gpt-5-6-sol": "gpt-5.6-sol",
  "gpt-5-6-terra": "gpt-5.6-terra",
  "gpt-5-6-luna": "gpt-5.6-luna",
  "gpt-5-5": "gpt-5.5",
  "gpt-5-4": "gpt-5.4",
  "gpt-5-4-mini": "gpt-5.4-mini",
  "gpt-5-3-codex": "gpt-5.3-codex",
};

export function normalizeCopilotModel(model) {
  if (typeof model !== "string") return "";
  const trimmed = model.trim();
  return COPILOT_MODEL_ALIASES[trimmed] ?? trimmed;
}

const COPILOT_MODELS_ENDPOINT = "https://api.githubcopilot.com/models";
const MODELS_CACHE_TTL_MS = 60_000;
let cachedModels = null;

function dedupeModels(modelList) {
  const seen = new Set();
  const deduped = [];
  for (const m of modelList) {
    const id = normalizeCopilotModel(m.id || "");
    if (!id || seen.has(id)) continue;
    seen.add(id);
    deduped.push({ id, label: m.label || m.name || id });
  }
  return deduped;
}

export async function resolveCopilotToken(env = {}) {
  const explicit = env.GH_TOKEN || env.GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (typeof explicit === "string" && explicit.trim().length > 0) {
    return explicit.trim();
  }

  // Try gh auth token
  try {
    const { stdout } = await execFileAsync("gh", ["auth", "token"], { timeout: 3000, windowsHide: true });
    const token = stdout.trim();
    if (token) return token;
  } catch {
    // Ignore gh failure
  }

  return null;
}

export async function fetchCopilotApiModels(token) {
  if (!token) return [];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);

  try {
    const response = await fetch(COPILOT_MODELS_ENDPOINT, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
      signal: controller.signal,
    });
    if (!response.ok) return [];

    const payload = await response.json();
    const data = Array.isArray(payload.data) ? payload.data : [];
    const discovered = [];

    for (const item of data) {
      if (!item || typeof item !== "object") continue;
      const id = typeof item.id === "string" ? item.id.trim() : "";
      if (!id) continue;
      // Filter out non-chat tools / embeddings
      const capType = item.capabilities?.type;
      if (capType === "embeddings" || id.startsWith("text-embedding-") || id === "trajectory-compaction") {
        continue;
      }
      const label = typeof item.name === "string" && item.name.trim() ? item.name.trim() : id;
      discovered.push({ id, label });
    }

    return discovered;
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

export async function loadCopilotModels(options = {}) {
  const now = Date.now();
  if (options.forceRefresh !== true && cachedModels && cachedModels.expiresAt > now) {
    return cachedModels.models;
  }

  const token = await resolveCopilotToken(options.env);
  const fetched = await fetchCopilotApiModels(token);

  const fallback = dedupeModels(models);
  if (fetched.length > 0) {
    const merged = dedupeModels([...fetched, ...fallback]);
    cachedModels = {
      expiresAt: now + MODELS_CACHE_TTL_MS,
      models: merged,
    };
    return merged;
  }

  if (cachedModels && cachedModels.models.length > 0) {
    return cachedModels.models;
  }

  return fallback;
}

export async function listModels(ctx = {}) {
  return loadCopilotModels({ env: ctx.config?.env });
}

export async function refreshModels(ctx = {}) {
  return loadCopilotModels({ forceRefresh: true, env: ctx.config?.env });
}

export async function detectModel(ctx = {}) {
  const copilotHome = ctx.config?.copilotHome || process.env.COPILOT_HOME || path.join(os.homedir(), ".copilot");

  // Check settings.json first
  try {
    const settingsPath = path.join(copilotHome, "settings.json");
    const raw = await fs.readFile(settingsPath, "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed.model === "string" && parsed.model.trim()) {
      return {
        model: normalizeCopilotModel(parsed.model.trim()),
        provider: "github-copilot",
        source: "settings.json",
      };
    }
  } catch {}

  // Check config.json recentModelIds
  try {
    const configPath = path.join(copilotHome, "config.json");
    const raw = await fs.readFile(configPath, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.recentModelIds) && parsed.recentModelIds.length > 0) {
      const first = parsed.recentModelIds[0];
      if (typeof first === "string" && first.trim()) {
        return {
          model: normalizeCopilotModel(first.trim()),
          provider: "github-copilot",
          source: "config.json",
        };
      }
    }
  } catch {}

  return null;
}
