import { ADAPTER_TYPE, DEFAULT_COPILOT_COMMAND } from "./constants.js";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";

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
  { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
  { id: "claude-opus-5", label: "Claude Opus 5" },
  { id: "claude-opus-4.8", label: "Claude Opus 4.8" },
  { id: "claude-opus-4.7", label: "Claude Opus 4.7" },
  { id: "claude-haiku-4.5", label: "Claude Haiku 4.5" },
  { id: "mai-code-1.1-flash", label: "MAI-Code-1.1 Flash" },
  { id: "mai-code-1-flash-picker", label: "MAI-Code-1 Flash" },
  { id: "gemini-3.7-flash", label: "Gemini 3.7 Flash" },
  { id: "gemini-3.6-flash", label: "Gemini 3.6 Flash" },
  { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash" },
  { id: "grok-4.5", label: "Grok 4.5" },
  { id: "grok-4.6", label: "Grok 4.6" },
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

const COPILOT_MODEL_ALIASES = {
  "claude-opus-4-8": "claude-opus-4.8",
  "claude-opus-4-7": "claude-opus-4.7",
  "claude-haiku-4-5": "claude-haiku-4.5",
  "claude-sonnet-4-5": "claude-sonnet-4.5",
  "gemini-3-7-flash": "gemini-3.7-flash",
  "gemini-3-6-flash": "gemini-3.6-flash",
  "gemini-3-5-flash": "gemini-3.5-flash",
  "grok-4-5": "grok-4.5",
  "grok-4-6": "grok-4.6",
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

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Copilot sessions are keyed by a UUID plus the directory they ran in. Resuming
 * a session in a different cwd would replay an unrelated transcript, so the cwd
 * is stored alongside the id and checked before a resume.
 */
export const sessionCodec = {
  deserialize(raw) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const sessionId = nonEmpty(raw.sessionId) ?? nonEmpty(raw.session_id);
    if (!sessionId) return null;
    const cwd = nonEmpty(raw.cwd) ?? nonEmpty(raw.workdir);
    return { sessionId, ...(cwd ? { cwd } : {}) };
  },
  serialize(params) {
    if (!params) return null;
    const sessionId = nonEmpty(params.sessionId) ?? nonEmpty(params.session_id);
    if (!sessionId) return null;
    const cwd = nonEmpty(params.cwd) ?? nonEmpty(params.workdir);
    return { sessionId, ...(cwd ? { cwd } : {}) };
  },
  getDisplayId(params) {
    if (!params) return null;
    return nonEmpty(params.sessionId) ?? nonEmpty(params.session_id);
  },
};

const configSchema = {
  fields: [
    {
      key: "command",
      label: "Command",
      type: "text",
      default: DEFAULT_COPILOT_COMMAND,
      group: "Runtime",
      hint: "Executable to launch. On Windows prefer `node` with commandPrefixArgs, because copilot.cmd rewrites argv.",
    },
    {
      key: "commandPrefixArgs",
      label: "Command prefix arguments",
      type: "textarea",
      group: "Runtime",
      hint: 'JSON array placed before every Copilot flag, e.g. ["C:/path/@github/copilot/npm-loader.js"].',
    },
    {
      key: "cwd",
      label: "Working directory",
      type: "text",
      group: "Runtime",
      hint: "Absolute path. A Paperclip workspace attached to the project overrides this.",
    },
    {
      key: "copilotHome",
      label: "COPILOT_HOME",
      type: "text",
      group: "Runtime",
      hint: "Dedicated Copilot home holding mcp-config.json, hooks/ and skills/ for this agent. Keeps global tooling out of Paperclip runs.",
    },
    {
      key: "model",
      label: "Model",
      type: "select",
      default: "",
      options: [
        { value: "", label: "Default (Copilot CLI auto/configured)" },
        ...models.map((m) => ({ value: m.id, label: m.label })),
      ],
      group: "Model",
      hint: "Passed to --model. Leave blank to use the Copilot CLI default.",
    },
    {
      key: "effort",
      label: "Reasoning effort",
      type: "select",
      default: "",
      options: [
        { value: "", label: "Default" },
        { value: "none", label: "None" },
        { value: "minimal", label: "Minimal" },
        { value: "low", label: "Low" },
        { value: "medium", label: "Medium" },
        { value: "high", label: "High" },
        { value: "xhigh", label: "X-High" },
        { value: "max", label: "Max" },
      ],
      group: "Model",
      hint: "Passed to --effort / --reasoning-effort.",
    },
    {
      key: "persistSession",
      label: "Persist session across runs",
      type: "toggle",
      default: false,
      group: "Session",
      hint: "Off (default) starts a fresh Copilot session per wake. On resumes the same session, which preserves context but can accumulate drift.",
    },
    {
      key: "deliverInstructionsInPrompt",
      label: "Deliver managed instructions in the prompt",
      type: "toggle",
      default: true,
      group: "Session",
      hint: "Copilot has no instructions-file flag, so the managed bundle is prepended to the prompt on fresh sessions.",
    },
    {
      key: "allowAllTools",
      label: "Allow all tools",
      type: "toggle",
      default: true,
      group: "Permissions",
      hint: "Required for unattended runs — otherwise tool calls block on approval.",
    },
    {
      key: "allowAllPaths",
      label: "Allow all paths",
      type: "toggle",
      default: false,
      group: "Permissions",
      hint: "Lets the agent read and write outside the working directory. Prefer addDirs.",
    },
    {
      key: "allowAllUrls",
      label: "Allow all URLs",
      type: "toggle",
      default: true,
      group: "Permissions",
      hint: "Allows URL and network tool calls without interactive confirmation.",
    },
    {
      key: "allowAll",
      label: "Allow all permissions (yolo)",
      type: "toggle",
      default: false,
      group: "Permissions",
      hint: "Passes --allow-all to Copilot CLI (all tools, paths, and URLs).",
    },
    {
      key: "addDirs",
      label: "Additional directories",
      type: "textarea",
      group: "Permissions",
      hint: "JSON array of extra absolute paths the agent may access (--add-dir).",
    },
    {
      key: "timeoutSec",
      label: "Timeout (seconds)",
      type: "number",
      default: 0,
      group: "Runtime",
      hint: "0 disables the timeout.",
    },
    {
      key: "logDir",
      label: "Log directory",
      type: "text",
      group: "Runtime",
      hint: "Optional directory for Copilot CLI debug logs (--log-dir).",
    },
  ],
};

export const agentConfigurationDoc = `# GitHub Copilot CLI (local)

Runs \`copilot\` headlessly for each Paperclip wake and streams its JSON event
log back as run output.

## How a run is assembled

1. **Working directory** — the workspace attached to the project wins; otherwise \`cwd\`.
2. **Environment** — Paperclip's \`PAPERCLIP_*\` variables, the runtime-tools MCP
   credentials, the wake payload, then your \`env\` overrides. \`COPILOT_HOME\` is
   set last so the run only sees the MCP servers, hooks and skills you chose.
3. **Prompt** — managed instructions (fresh sessions only), the wake prompt, any
   session-handoff note, a runtime access note, then the rendered prompt template.
4. **Invocation** — \`--prompt\`, \`--output-format json\`, \`--usage-output-file\`
   and the session flags.

## Notes

- **Windows:** set \`command\` to \`node\` and \`commandPrefixArgs\` to the path of
  \`@github/copilot/npm-loader.js\`. \`copilot.cmd\` rewrites argv and corrupts
  multi-line prompts.
- **Instructions:** Copilot has no flag to load an arbitrary instructions file and
  writing \`AGENTS.md\` into the repo would clobber the project's own file, so the
  managed bundle is delivered as the first prompt section instead.
- **Sessions:** disabled by default. Each wake is stateless, which is what keeps
  long-lived runs from rotting; enable \`persistSession\` only when an agent needs
  to carry context between wakes.
- **Billing:** Copilot bills premium requests against a subscription, so token
  counts are reported but no USD cost is.
`;

export function createServerAdapter() {
  return {
    type: ADAPTER_TYPE,
    execute,
    testEnvironment,
    sessionCodec,
    agentConfigurationDoc,
    getConfigSchema: () => configSchema,
    models,
    modelProfiles,
    listModels: () => models,
    listModelProfiles: () => modelProfiles,
    // Copilot reads MCP servers from COPILOT_HOME/mcp-config.json, which this
    // adapter never rewrites, so the run-scoped control tools are surfaced in
    // the invocation context and reached over the Paperclip HTTP API using the
    // PAPERCLIP_* credentials placed in the environment.
    runtimeToolDelivery: "invocation_context",
    supportsLocalAgentJwt: true,
    supportsInstructionsBundle: true,
    instructionsPathKey: "instructionsFilePath",
  };
}

export { ADAPTER_TYPE, execute, testEnvironment };
