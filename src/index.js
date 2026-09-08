import { ADAPTER_TYPE, DEFAULT_COPILOT_COMMAND } from "./constants.js";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";
import {
  DEFAULT_COPILOT_LOCAL_MODEL,
  models,
  modelProfiles,
  COPILOT_MODEL_ALIASES,
  normalizeCopilotModel,
  listModels,
  refreshModels,
  detectModel,
} from "./models.js";

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
    listModels,
    refreshModels,
    detectModel,
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

export {
  ADAPTER_TYPE,
  DEFAULT_COPILOT_LOCAL_MODEL,
  execute,
  testEnvironment,
  models,
  modelProfiles,
  COPILOT_MODEL_ALIASES,
  normalizeCopilotModel,
  listModels,
  refreshModels,
  detectModel,
};
