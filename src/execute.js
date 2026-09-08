import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  asBoolean,
  asNumber,
  asString,
  asStringArray,
  buildInvocationEnvForLogs,
  buildPaperclipEnv,
  buildRuntimeToolsEnv,
  ensureAbsoluteDirectory,
  ensurePathInEnv,
  isForbiddenConfigEnvKey,
  isPaperclipRecoveryWakePayload,
  isPaperclipRuntimeEnvKey,
  joinPromptSections,
  parseObject,
  readPaperclipIssueWorkModeFromContext,
  refreshPaperclipWorkspaceEnvForExecution,
  renderPaperclipWakePrompt,
  renderTemplate,
  resolveCommandForLogs,
  runChildProcess,
  stringifyPaperclipWakePayload,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
} from "@paperclipai/adapter-utils/server-utils";
import { ADAPTER_TYPE, DEFAULT_COPILOT_COMMAND } from "./constants.js";
import { normalizeCopilotModel } from "./index.js";
import { resolveWindowsCopilotLauncher } from "./launcher.js";
import { isCopilotUnknownSessionError, parseCopilotJsonl, readCopilotUsageFile } from "./parse.js";

/**
 * Copilot's JSONL stream is extremely chatty. In a measured trivial run, 64 of
 * 91 lines (~70%) were incremental `*_delta` events plus MCP/background-task
 * status churn. Paperclip's `runChildProcess` pauses the child's stdout and
 * awaits a persistence round trip for *every* chunk, so forwarding this noise
 * applies backpressure to Copilot itself and delays visible output by minutes.
 *
 * Dropping these is lossless for the transcript: `assistant.message` carries
 * the complete text that `assistant.message_delta` streams piecewise, and
 * `assistant.tool_call_delta` is superseded by `tool.execution_start`.
 */
const NOISY_COPILOT_EVENT_TYPES = new Set([
  "assistant.message_delta",
  "assistant.message_start",
  "assistant.reasoning_delta",
  "assistant.tool_call_delta",
  "assistant.turn_start",
  "assistant.turn_end",
  "model.call_start",
  "model.call_finished",
  "tool.execution_partial_result",
  "session.background_tasks_changed",
  "session.mcp_server_added",
  "session.mcp_server_removed",
  "session.mcp_server_status_changed",
]);

function isNoisyCopilotEventLine(line) {
  if (!line.startsWith("{")) return false;
  try {
    return NOISY_COPILOT_EVENT_TYPES.has(JSON.parse(line).type);
  } catch {
    return false;
  }
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

/**
 * Paperclip only persists *metadata* for a run in flight (lastOutputAt, seq and
 * byte counts via flushOutputProgress); the agent's actual prose is surfaced
 * only once the adapter returns a parsed result at process exit. So while a run
 * is executing, the only thing a human can read is the run log itself. Raw
 * Copilot JSONL is unreadable there, which is why a live run appears to produce
 * no output for its entire duration.
 *
 * Rendering the meaningful events as plain text makes the run log readable in
 * real time. `runChildProcess` still accumulates the untouched raw stream, so
 * `parseCopilotJsonl` and terminal-result detection are unaffected.
 */
export function renderCopilotEventLine(line) {
  if (!line.startsWith("{")) return line;
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    // A Copilot event we cannot parse has no readable content to show, and
    // emitting the raw JSON puts unreadable noise back into the run log that
    // this renderer exists to remove. Drop it; the untouched raw stream is
    // still accumulated by runChildProcess for result parsing.
    return line.startsWith('{"type"') ? null : line;
  }
  const type = event?.type;
  const data = event?.data ?? {};
  switch (type) {
    case "assistant.message": {
      const text = firstNonEmptyString(data.message, data.text, data.content);
      return text ? `\n${text}\n` : null;
    }
    case "assistant.reasoning": {
      const text = firstNonEmptyString(data.reasoning, data.text, data.content);
      return text ? `[thinking] ${text}` : null;
    }
    case "tool.execution_start": {
      const name = firstNonEmptyString(data.toolName, data.name) ?? "tool";
      return `> ${name}`;
    }
    case "tool.execution_complete": {
      const name = firstNonEmptyString(data.toolName, data.name) ?? "tool";
      const failed = data.success === false || data.isError === true;
      return `${failed ? "x" : "+"} ${name}`;
    }
    case "user.message":
      return "[prompt delivered]";
    case "session.skills_loaded":
      return "[skills loaded]";
    case "session.mcp_servers_loaded":
      return "[mcp servers loaded]";
    default: {
      if (typeof type === "string" && type.includes("error")) return line;
      return null;
    }
  }
}

/**
 * Wraps `onLog` so only meaningful JSONL events reach Paperclip's log store,
 * rendered as human-readable text. Buffers partial trailing lines so a line is
 * never split mid-parse.
 */
function createFilteredStdoutLogger(onLog) {
  let carry = "";
  return async (stream, chunk) => {
    if (stream !== "stdout") {
      await onLog(stream, chunk);
      return;
    }
    const text = carry + chunk;
    const lastNewline = text.lastIndexOf("\n");
    if (lastNewline < 0) {
      carry = text;
      return;
    }
    carry = text.slice(lastNewline + 1);
    const kept = [];
    for (const line of text.slice(0, lastNewline).split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0 || isNoisyCopilotEventLine(trimmed)) continue;
      const rendered = renderCopilotEventLine(trimmed);
      if (rendered !== null && rendered !== undefined) kept.push(rendered);
    }
    if (kept.length === 0) return;
    await onLog(stream, `${kept.join("\n")}\n`);
  };
}

/**
 * Copilot CLI has no flag for "load this instructions file". It only discovers
 * AGENTS.md / .github/copilot-instructions.md relative to the working
 * directory, and a Paperclip-managed bundle lives outside the repo. Overwriting
 * the repo's own AGENTS.md would be destructive, so the managed bundle is
 * delivered as a leading prompt section instead. That keeps the repo untouched
 * and still guarantees the agent receives its execution contract every run.
 */
async function readInstructionsSection(instructionsFilePath, onLog) {
  if (!instructionsFilePath) return "";
  try {
    const content = await fs.readFile(instructionsFilePath, "utf8");
    if (!content.trim()) return "";
    return ["# Agent instructions (Paperclip managed)", "", content.trim()].join("\n");
  } catch (err) {
    await onLog(
      "stderr",
      `[paperclip] Could not read instructions file "${instructionsFilePath}": ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
    return "";
  }
}

function renderRuntimeAccessNote(env) {
  const hasApi =
    typeof env.PAPERCLIP_API_URL === "string" &&
    env.PAPERCLIP_API_URL.trim().length > 0 &&
    typeof env.PAPERCLIP_API_KEY === "string" &&
    env.PAPERCLIP_API_KEY.trim().length > 0;
  const paperclipKeys = Object.keys(env)
    .filter((key) => key.startsWith("PAPERCLIP_"))
    .sort();
  const lines = [];
  if (paperclipKeys.length > 0) {
    lines.push(
      "Paperclip runtime note:",
      `These environment variables are set for this run: ${paperclipKeys.join(", ")}`,
      "Read them from your shell environment rather than assuming they are missing.",
    );
  }
  if (hasApi) {
    lines.push(
      "",
      "Paperclip API access note:",
      "Use curl against $PAPERCLIP_API_URL with the bearer token in $PAPERCLIP_API_KEY.",
      "Include the X-Paperclip-Run-Id header on mutating requests.",
    );
  }
  return lines.join("\n");
}

function firstNonEmptyLine(text) {
  return (
    String(text ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

export async function execute(ctx) {
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn, authToken } = ctx;

  let command = asString(config.command, DEFAULT_COPILOT_COMMAND);
  // `copilot.cmd` mangles argv on Windows, so a launcher prefix (for example
  // `node <npm-loader.js>`) can be supplied and is always placed first.
  let commandPrefixArgs = asStringArray(config.commandPrefixArgs);

  // On Windows a bare `copilot` resolves to `copilot.cmd`, which Paperclip must
  // launch through cmd.exe. cmd.exe caps a command line at 8191 characters, so
  // any run whose prompt carries a normal wake context dies with "The command
  // line is too long." before Copilot ever starts. Spawning the loader with
  // node keeps the process off cmd.exe and raises the ceiling to 32767, so
  // resolve it automatically instead of relying on per-agent configuration.
  if (commandPrefixArgs.length === 0) {
    const launcher = await resolveWindowsCopilotLauncher(command);
    if (launcher) {
      command = launcher.command;
      commandPrefixArgs = launcher.prefixArgs;
    }
  }
  const rawModel = asString(config.model, "").trim();
  const model = normalizeCopilotModel(rawModel);
  const effort = asString(config.effort || config.reasoningEffort || config.modelReasoningEffort, "").trim();
  const promptTemplate = asString(config.promptTemplate, DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE);
  const timeoutSec = asNumber(config.timeoutSec, 0);
  const graceSec = asNumber(config.graceSec, 15);
  const allowAllTools = asBoolean(config.allowAllTools, true);
  const allowAllPaths = asBoolean(config.allowAllPaths, false);
  const allowAllUrls = asBoolean(config.allowAllUrls, true);
  const allowAll = asBoolean(config.allowAll, false);
  const persistSession = asBoolean(config.persistSession, false);
  const deliverInstructionsInPrompt = asBoolean(config.deliverInstructionsInPrompt, true);
  const copilotHome = asString(config.copilotHome, "").trim();
  const logDir = asString(config.logDir, "").trim();
  const addDirs = asStringArray(config.addDirs);
  const extraArgs = (() => {
    const explicit = asStringArray(config.extraArgs);
    return explicit.length > 0 ? explicit : asStringArray(config.args);
  })();

  // ---------------------------------------------------------------------------
  // Working directory: a Paperclip-managed workspace wins over static config.
  // ---------------------------------------------------------------------------
  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const workspaceId = asString(workspaceContext.workspaceId, "");
  const workspaceRepoUrl = asString(workspaceContext.repoUrl, "");
  const workspaceRepoRef = asString(workspaceContext.repoRef, "");
  const agentHome = asString(workspaceContext.agentHome, "");
  const workspaceHints = Array.isArray(context.paperclipWorkspaces)
    ? context.paperclipWorkspaces.filter((value) => typeof value === "object" && value !== null)
    : [];
  const configuredCwd = asString(config.cwd, "");
  const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

  // ---------------------------------------------------------------------------
  // Environment
  // ---------------------------------------------------------------------------
  const envConfig = parseObject(config.env);
  const env = {
    ...buildPaperclipEnv(agent),
    ...buildRuntimeToolsEnv(ctx.runtimeTools),
  };
  env.PAPERCLIP_RUN_ID = runId;

  const wakeTaskId =
    asString(context.taskId, "").trim() || asString(context.issueId, "").trim() || "";
  const wakeReason = asString(context.wakeReason, "").trim();
  const wakeCommentId =
    asString(context.wakeCommentId, "").trim() || asString(context.commentId, "").trim() || "";
  const approvalId = asString(context.approvalId, "").trim();
  const approvalStatus = asString(context.approvalStatus, "").trim();
  const linkedIssueIds = Array.isArray(context.issueIds)
    ? context.issueIds.filter((value) => typeof value === "string" && value.trim().length > 0)
    : [];
  const wakePayloadJson = stringifyPaperclipWakePayload(context.paperclipWake);
  const issueWorkMode = readPaperclipIssueWorkModeFromContext(context);

  if (wakeTaskId) env.PAPERCLIP_TASK_ID = wakeTaskId;
  if (issueWorkMode) env.PAPERCLIP_ISSUE_WORK_MODE = issueWorkMode;
  if (wakeReason) env.PAPERCLIP_WAKE_REASON = wakeReason;
  if (wakeCommentId) env.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
  if (approvalId) env.PAPERCLIP_APPROVAL_ID = approvalId;
  if (approvalStatus) env.PAPERCLIP_APPROVAL_STATUS = approvalStatus;
  if (linkedIssueIds.length > 0) env.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
  if (wakePayloadJson) env.PAPERCLIP_WAKE_PAYLOAD_JSON = wakePayloadJson;

  refreshPaperclipWorkspaceEnvForExecution({
    env,
    envConfig,
    workspaceCwd: effectiveWorkspaceCwd,
    workspaceSource,
    workspaceId,
    workspaceRepoUrl,
    workspaceRepoRef,
    workspaceHints,
    agentHome,
    executionTargetIsRemote: false,
    executionCwd: cwd,
  });

  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value !== "string") continue;
    if (isForbiddenConfigEnvKey(key)) continue;
    if (isPaperclipRuntimeEnvKey(key) && key in env) continue;
    env[key] = value;
  }

  // COPILOT_HOME scopes MCP servers, hooks, skills and trusted folders for this
  // agent only. It is the isolation boundary that keeps unrelated global tooling
  // (and its pre-tool-use gates) out of Paperclip runs.
  const resolvedCopilotHome = copilotHome || path.join(os.homedir(), ".paperclip", "copilot-home");
  if (resolvedCopilotHome) {
    await ensureAbsoluteDirectory(resolvedCopilotHome, { createIfMissing: true });
    env.COPILOT_HOME = resolvedCopilotHome;
  }
  if (authToken) env.PAPERCLIP_API_KEY = authToken;

  // Headless and non-interactive invariants to prevent child tools, git credential
  // managers, and test runners from creating GUI windows or stealing focus.
  env.CI = env.CI ?? "1";
  env.HEADLESS = env.HEADLESS ?? "true";
  env.PLAYWRIGHT_HEADLESS = env.PLAYWRIGHT_HEADLESS ?? "1";
  env.PUPPETEER_HEADLESS = env.PUPPETEER_HEADLESS ?? "true";
  env.GCM_INTERACTIVE = env.GCM_INTERACTIVE ?? "never";
  env.GIT_TERMINAL_PROMPT = env.GIT_TERMINAL_PROMPT ?? "0";

  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });
  const resolvedCommand = await resolveCommandForLogs(command, cwd, runtimeEnv);
  const loggedEnv = buildInvocationEnvForLogs(env, {
    runtimeEnv,
    includeRuntimeKeys: ["HOME", "COPILOT_HOME"],
    resolvedCommand,
  });

  // ---------------------------------------------------------------------------
  // Session continuity
  // ---------------------------------------------------------------------------
  const runtimeSessionParams = parseObject(runtime.sessionParams);
  const runtimeSessionId =
    asString(runtimeSessionParams.sessionId, "").trim() || asString(runtime.sessionId, "").trim() || "";
  const runtimeSessionCwd = asString(runtimeSessionParams.cwd, "").trim();
  const canResumeSession =
    persistSession && Boolean(runtimeSessionId) && (!runtimeSessionCwd || runtimeSessionCwd === cwd);
  if (persistSession && runtimeSessionId && !canResumeSession) {
    await onLog(
      "stdout",
      `[paperclip] Copilot session "${runtimeSessionId}" was saved for cwd "${runtimeSessionCwd}" and will not be resumed in "${cwd}".\n`,
    );
  }
  const resumeSessionId = canResumeSession ? runtimeSessionId : null;
  const newSessionId = resumeSessionId ? null : randomUUID();

  // ---------------------------------------------------------------------------
  // Prompt
  // ---------------------------------------------------------------------------
  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  const instructionsSection = deliverInstructionsInPrompt
    ? await readInstructionsSection(instructionsFilePath, onLog)
    : "";
  const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, {
    resumedSession: Boolean(resumeSessionId),
  });
  const shouldUseResumeDeltaPrompt = Boolean(resumeSessionId) && wakePrompt.length > 0;
  const renderedPrompt =
    shouldUseResumeDeltaPrompt || isPaperclipRecoveryWakePayload(context.paperclipWake)
      ? ""
      : renderTemplate(promptTemplate, {
          agentId: agent.id,
          companyId: agent.companyId,
          runId,
          company: { id: agent.companyId },
          agent,
          run: { id: runId, source: "on_demand" },
          context,
        });
  const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
  const runtimeAccessNote = renderRuntimeAccessNote(env);

  const prompt = joinPromptSections([
    // On a resumed session the contract is already in the transcript, so only a
    // fresh session pays the instructions cost.
    resumeSessionId ? "" : instructionsSection,
    wakePrompt,
    sessionHandoffNote,
    runtimeAccessNote,
    renderedPrompt,
  ]);
  const promptMetrics = {
    promptChars: prompt.length,
    instructionsChars: resumeSessionId ? 0 : instructionsSection.length,
    wakePromptChars: wakePrompt.length,
    sessionHandoffChars: sessionHandoffNote.length,
    runtimeNoteChars: runtimeAccessNote.length,
    heartbeatPromptChars: renderedPrompt.length,
  };

  // ---------------------------------------------------------------------------
  // Invocation
  // ---------------------------------------------------------------------------
  const usageFilePath = path.join(
    await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-copilot-")),
    "usage.json",
  );

  const buildArgs = (sessionArgs) => {
    const args = [...commandPrefixArgs, "--output-format", "json", "--no-color"];
    args.push("--usage-output-file", usageFilePath);
    if (model) args.push("--model", model);
    if (effort) args.push("--effort", effort);
    if (allowAll || (allowAllTools && allowAllPaths && allowAllUrls)) {
      args.push("--allow-all");
    } else {
      if (allowAllTools) args.push("--allow-all-tools");
      if (allowAllPaths) args.push("--allow-all-paths");
      if (allowAllUrls) args.push("--allow-all-urls");
    }
    if (logDir) args.push("--log-dir", logDir);
    for (const dir of addDirs) args.push("--add-dir", dir);
    args.push(...sessionArgs);
    if (extraArgs.length > 0) args.push(...extraArgs);
    args.push("--prompt", prompt);
    return args;
  };

  const commandNotes = [
    "Prompt is passed to Copilot via --prompt in headless mode.",
    persistSession
      ? "Session continuity is enabled: the Copilot session id is persisted and resumed across runs."
      : "Session continuity is disabled: every run starts a fresh Copilot session.",
  ];
  if (instructionsSection && !resumeSessionId) {
    commandNotes.push(
      `Delivered managed instructions (${instructionsSection.length} chars) as a leading prompt section.`,
    );
  }
  if (copilotHome) commandNotes.push(`Scoped the run to COPILOT_HOME=${copilotHome}.`);

  const streamOnLog = createFilteredStdoutLogger(onLog);

  const runAttempt = async (sessionArgs) => {
    const args = buildArgs(sessionArgs);
    if (onMeta) {
      await onMeta({
        adapterType: ADAPTER_TYPE,
        command: resolvedCommand,
        cwd,
        commandNotes,
        commandArgs: args.map((value, index) =>
          index === args.length - 1 ? `<prompt ${prompt.length} chars>` : value,
        ),
        env: loggedEnv,
        prompt,
        promptMetrics,
        context,
      });
    }

    const proc = await runChildProcess(runId, command, args, {
      cwd,
      env,
      timeoutSec,
      graceSec,
      onLog: streamOnLog,
      onSpawn,
    });
    return { proc, parsed: parseCopilotJsonl(proc.stdout) };
  };

  const sessionArgsFor = (resumeId, freshId) => {
    if (resumeId) return ["--resume", resumeId];
    if (freshId) return ["--session-id", freshId];
    return [];
  };

  let attempt = await runAttempt(sessionArgsFor(resumeSessionId, newSessionId));
  let clearSession = false;

  // A resumed session id can go missing when Copilot's local session store is
  // pruned. Retry once from a clean session instead of failing the run.
  if (
    resumeSessionId &&
    (attempt.proc.exitCode ?? 0) !== 0 &&
    isCopilotUnknownSessionError(attempt.proc.stdout, attempt.proc.stderr)
  ) {
    await onLog(
      "stdout",
      `[paperclip] Copilot session "${resumeSessionId}" could not be resumed. Retrying with a fresh session.\n`,
    );
    clearSession = true;
    attempt = await runAttempt(sessionArgsFor(null, randomUUID()));
  }

  const usage = await readCopilotUsageFile(usageFilePath);
  await fs.rm(path.dirname(usageFilePath), { recursive: true, force: true }).catch(() => {});

  if (attempt.proc.timedOut) {
    return {
      exitCode: attempt.proc.exitCode,
      signal: attempt.proc.signal,
      timedOut: true,
      errorMessage: `Timed out after ${timeoutSec}s`,
      clearSession,
    };
  }

  const failed = (attempt.proc.exitCode ?? 0) !== 0;
  const resolvedSessionId = attempt.parsed.sessionId || (clearSession ? null : resumeSessionId || newSessionId);
  const sessionParams =
    persistSession && resolvedSessionId ? { sessionId: resolvedSessionId, cwd } : null;

  return {
    exitCode: attempt.proc.exitCode,
    signal: attempt.proc.signal,
    timedOut: false,
    errorMessage: failed
      ? attempt.parsed.errorMessage ||
        firstNonEmptyLine(attempt.proc.stderr) ||
        `Copilot exited with code ${attempt.proc.exitCode ?? -1}`
      : null,
    usage: usage
      ? {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cachedInputTokens: usage.cachedInputTokens,
        }
      : undefined,
    usageBasis: "per_run",
    sessionId: sessionParams ? resolvedSessionId : null,
    sessionParams,
    sessionDisplayId: sessionParams ? resolvedSessionId : null,
    clearSession,
    provider: "github-copilot",
    biller: "github-copilot",
    billingType: "metered_api",
    costUsd: usage?.costUsd ?? null,
    model: attempt.parsed.model || usage?.model || model || null,
    resultJson: {
      summary: attempt.parsed.summary,
      premiumRequests: usage?.premiumRequests ?? attempt.parsed.premiumRequests ?? null,
      totalNanoAiu: usage?.totalNanoAiu ?? null,
      costUsd: usage?.costUsd ?? null,
      filesModified: usage?.filesModified ?? [],
      linesAdded: usage?.linesAdded ?? 0,
      linesRemoved: usage?.linesRemoved ?? 0,
      stderr: attempt.proc.stderr,
    },
  };
}
