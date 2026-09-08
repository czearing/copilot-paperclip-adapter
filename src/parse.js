import fs from "node:fs/promises";

/**
 * Parses the JSONL stream emitted by `copilot --output-format json`.
 *
 * Event shapes were captured from a live run of @github/copilot:
 *   {"type":"assistant.message","data":{"content":"...","model":"claude-opus-5"}}
 *   {"type":"result","sessionId":"<uuid>","exitCode":0,"usage":{...}}
 */
export function parseCopilotJsonl(stdout) {
  const messages = [];
  let sessionId = null;
  let model = null;
  let resultExitCode = null;
  let errorMessage = null;
  let premiumRequests = null;
  let sawResult = false;

  for (const rawLine of String(stdout ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("{")) continue;

    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!event || typeof event !== "object") continue;

    const type = typeof event.type === "string" ? event.type : "";
    const data = event.data && typeof event.data === "object" ? event.data : {};

    if (typeof data.model === "string" && data.model.trim()) model = data.model.trim();

    if (type === "assistant.message") {
      const content = typeof data.content === "string" ? data.content : "";
      if (content.trim()) messages.push(content);
      continue;
    }

    if (type === "result") {
      sawResult = true;
      if (typeof event.sessionId === "string" && event.sessionId.trim()) {
        sessionId = event.sessionId.trim();
      }
      if (typeof event.exitCode === "number") resultExitCode = event.exitCode;
      const usage = event.usage && typeof event.usage === "object" ? event.usage : {};
      if (typeof usage.premiumRequests === "number") premiumRequests = usage.premiumRequests;
      continue;
    }

    if (type === "error" || type.endsWith(".error")) {
      const text =
        (typeof data.message === "string" && data.message) ||
        (typeof data.error === "string" && data.error) ||
        (typeof event.message === "string" && event.message) ||
        "";
      if (text.trim()) errorMessage = text.trim();
    }
  }

  return {
    sessionId,
    model,
    summary: messages.join("\n\n").trim(),
    errorMessage,
    resultExitCode,
    premiumRequests,
    sawResult,
  };
}

export const MODEL_RATES = {
  "claude-opus-5": { input: 15 / 1e6, output: 75 / 1e6, cacheRead: 1.5 / 1e6, cacheWrite: 18.75 / 1e6 },
  "claude-opus-4.8": { input: 15 / 1e6, output: 75 / 1e6, cacheRead: 1.5 / 1e6, cacheWrite: 18.75 / 1e6 },
  "claude-opus-4.7": { input: 15 / 1e6, output: 75 / 1e6, cacheRead: 1.5 / 1e6, cacheWrite: 18.75 / 1e6 },
  "claude-opus-4.6": { input: 15 / 1e6, output: 75 / 1e6, cacheRead: 1.5 / 1e6, cacheWrite: 18.75 / 1e6 },
  "claude-sonnet-5": { input: 3 / 1e6, output: 15 / 1e6, cacheRead: 0.3 / 1e6, cacheWrite: 3.75 / 1e6 },
  "claude-haiku-4.5": { input: 0.8 / 1e6, output: 4 / 1e6, cacheRead: 0.08 / 1e6, cacheWrite: 1 / 1e6 },
  "gpt-6-astra": { input: 2.5 / 1e6, output: 10 / 1e6, cacheRead: 1.25 / 1e6, cacheWrite: 2.5 / 1e6 },
  "gpt-5.6-sol": { input: 2.5 / 1e6, output: 10 / 1e6, cacheRead: 1.25 / 1e6, cacheWrite: 2.5 / 1e6 },
  "gpt-5.6-sol-fast": { input: 1.5 / 1e6, output: 6 / 1e6, cacheRead: 0.75 / 1e6, cacheWrite: 1.5 / 1e6 },
  "gpt-5.6-terra": { input: 2.5 / 1e6, output: 10 / 1e6, cacheRead: 1.25 / 1e6, cacheWrite: 2.5 / 1e6 },
  "gpt-5.6-luna": { input: 2.5 / 1e6, output: 10 / 1e6, cacheRead: 1.25 / 1e6, cacheWrite: 2.5 / 1e6 },
  "gpt-5.5": { input: 2.5 / 1e6, output: 10 / 1e6, cacheRead: 1.25 / 1e6, cacheWrite: 2.5 / 1e6 },
  "gpt-5.4": { input: 2.5 / 1e6, output: 10 / 1e6, cacheRead: 1.25 / 1e6, cacheWrite: 2.5 / 1e6 },
  "gpt-5.4-mini": { input: 0.15 / 1e6, output: 0.6 / 1e6, cacheRead: 0.075 / 1e6, cacheWrite: 0.15 / 1e6 },
  "gpt-5.3-codex": { input: 2.5 / 1e6, output: 10 / 1e6, cacheRead: 1.25 / 1e6, cacheWrite: 2.5 / 1e6 },
  "gpt-5-mini": { input: 0.15 / 1e6, output: 0.6 / 1e6, cacheRead: 0.075 / 1e6, cacheWrite: 0.15 / 1e6 },
  "gemini-3.8-flash": { input: 0.1 / 1e6, output: 0.4 / 1e6, cacheRead: 0.025 / 1e6, cacheWrite: 0.1 / 1e6 },
  "gemini-3.7-flash": { input: 0.1 / 1e6, output: 0.4 / 1e6, cacheRead: 0.025 / 1e6, cacheWrite: 0.1 / 1e6 },
  "gemini-3.6-flash": { input: 0.1 / 1e6, output: 0.4 / 1e6, cacheRead: 0.025 / 1e6, cacheWrite: 0.1 / 1e6 },
  "gemini-3.5-flash": { input: 0.1 / 1e6, output: 0.4 / 1e6, cacheRead: 0.025 / 1e6, cacheWrite: 0.1 / 1e6 },
  "grok-4.5": { input: 2.0 / 1e6, output: 10 / 1e6, cacheRead: 0.5 / 1e6, cacheWrite: 2.0 / 1e6 },
  "grok-4.6": { input: 2.0 / 1e6, output: 10 / 1e6, cacheRead: 0.5 / 1e6, cacheWrite: 2.0 / 1e6 },
  "mai-code-1.1-flash": { input: 0.2 / 1e6, output: 0.8 / 1e6, cacheRead: 0.05 / 1e6, cacheWrite: 0.2 / 1e6 },
  "mai-code-1-flash-picker": { input: 0.2 / 1e6, output: 0.8 / 1e6, cacheRead: 0.05 / 1e6, cacheWrite: 0.2 / 1e6 },
  "gpt-4.1": { input: 2.0 / 1e6, output: 8 / 1e6, cacheRead: 0.5 / 1e6, cacheWrite: 2.0 / 1e6 },
  "gpt-4o": { input: 2.5 / 1e6, output: 10 / 1e6, cacheRead: 1.25 / 1e6, cacheWrite: 2.5 / 1e6 },
  "gpt-4o-mini": { input: 0.15 / 1e6, output: 0.6 / 1e6, cacheRead: 0.075 / 1e6, cacheWrite: 0.15 / 1e6 },
  "default": { input: 3 / 1e6, output: 15 / 1e6, cacheRead: 0.3 / 1e6, cacheWrite: 3.75 / 1e6 },
};

export function calculateCostUsd(modelMetrics, fallbackModel = "default", totalNanoAiu = 0) {
  let totalCost = 0;
  let calculated = false;

  if (modelMetrics && typeof modelMetrics === "object" && Object.keys(modelMetrics).length > 0) {
    for (const [modelKey, metrics] of Object.entries(modelMetrics)) {
      const rate = MODEL_RATES[modelKey] || MODEL_RATES.default;
      const usage = metrics?.usage;
      if (usage && typeof usage === "object") {
        const inputTokens = (usage.inputTokens || 0) - (usage.cacheReadTokens || 0);
        const cacheReadTokens = usage.cacheReadTokens || 0;
        const cacheWriteTokens = usage.cacheWriteTokens || 0;
        const outputTokens = usage.outputTokens || 0;

        totalCost +=
          Math.max(0, inputTokens) * rate.input +
          cacheReadTokens * rate.cacheRead +
          cacheWriteTokens * rate.cacheWrite +
          outputTokens * rate.output;
        calculated = true;
      }
    }
  }

  if (!calculated && typeof totalNanoAiu === "number" && totalNanoAiu > 0) {
    // 1 AI Credit = $0.01 = 10^9 nano AIU
    totalCost = (totalNanoAiu / 1e9) * 0.01;
    calculated = true;
  }

  return calculated ? Math.round(totalCost * 1e6) / 1e6 : null;
}

/** Reads and normalizes the JSON written by `--usage-output-file`. */
export async function readCopilotUsageFile(filePath) {
  let raw;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;

  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;

  const modelMetrics =
    parsed.modelMetrics && typeof parsed.modelMetrics === "object" ? parsed.modelMetrics : {};
  for (const metrics of Object.values(modelMetrics)) {
    const usage = metrics && typeof metrics === "object" ? metrics.usage : null;
    if (!usage || typeof usage !== "object") continue;
    if (typeof usage.inputTokens === "number") inputTokens += usage.inputTokens;
    if (typeof usage.outputTokens === "number") outputTokens += usage.outputTokens;
    if (typeof usage.cacheReadTokens === "number") cachedInputTokens += usage.cacheReadTokens;
  }

  // Fall back to the flat last-call fields when modelMetrics is absent.
  if (inputTokens === 0 && typeof parsed.lastCallInputTokens === "number") {
    inputTokens = parsed.lastCallInputTokens;
  }
  if (outputTokens === 0 && typeof parsed.lastCallOutputTokens === "number") {
    outputTokens = parsed.lastCallOutputTokens;
  }

  const currentModel =
    typeof parsed.currentModel === "string" && parsed.currentModel.trim()
      ? parsed.currentModel.trim()
      : null;
  const codeChanges = parsed.codeChanges && typeof parsed.codeChanges === "object" ? parsed.codeChanges : {};
  const totalNanoAiu = typeof parsed.totalNanoAiu === "number" ? parsed.totalNanoAiu : 0;
  const costUsd = calculateCostUsd(modelMetrics, currentModel, totalNanoAiu);

  return {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    model: currentModel,
    costUsd,
    totalNanoAiu,
    premiumRequests:
      typeof parsed.totalPremiumRequestCost === "number" ? parsed.totalPremiumRequestCost : null,
    filesModified: Array.isArray(codeChanges.filesModified) ? codeChanges.filesModified : [],
    linesAdded: typeof codeChanges.linesAdded === "number" ? codeChanges.linesAdded : 0,
    linesRemoved: typeof codeChanges.linesRemoved === "number" ? codeChanges.linesRemoved : 0,
  };
}

/** True when stderr/stdout indicate the resumed session id no longer exists. */
export function isCopilotUnknownSessionError(stdout, stderr) {
  const haystack = `${stdout ?? ""}\n${stderr ?? ""}`;
  return /session\s+(?:.*\s+)?not\s+found|unknown\s+session|no\s+such\s+session|failed\s+to\s+resume/i.test(
    haystack,
  );
}
