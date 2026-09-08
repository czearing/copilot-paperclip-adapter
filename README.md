# copilot-paperclip-adapter

A Paperclip adapter that runs the **GitHub Copilot CLI** (`@github/copilot`) as a
local agent runtime. Adapter type: `copilot_local`.

Paperclip ships adapters for Claude, Codex, Cursor, Gemini, Grok, Kimi, OpenCode
and Pi, but not for Copilot. The generic `process` adapter can launch Copilot,
but it only forwards `command`, `args` and `env` — it never delivers the wake
prompt, the managed instructions bundle, session continuity, or usage accounting, so those
must be hardcoded into a static argv. This adapter closes that gap.

## Features

- 🤖 **Full Model Catalog**: Supports all 22+ Copilot CLI models including Claude (Opus 5/4.8/4.7, Sonnet 5, Haiku 4.5), GPT-5 (5.6 Sol/Terra/Luna, 5.5, 5.4, 5.4-mini, 5.3 Codex), Gemini Flash (3.7, 3.6, 3.5), Grok (4.5, 4.6), and Auto.
- ⚡ **Reasoning Effort Control**: Configurable reasoning levels (`minimal`, `low`, `medium`, `high`, `xhigh`, `max`).
- 💰 **Precise Token & Cost Tracking**: Live token counting (input, output, cache read/write) and USD cost calculation with per-model pricing tiers and nano-AIU conversion.
- 🛡️ **Headless & Window Isolation**: Built-in environment invariants (`CI=1`, `HEADLESS=true`, `GCM_INTERACTIVE=never`, etc.) preventing rogue GUI windows and terminal focus stealing.
- 📺 **Filtered Live Logs**: Filters out noisy delta streams and renders structured plain text (thinking, tool starts, tool outcomes) in real time.
- 📦 **Included Paperclip Skill**: Bundles the `skills/paperclip` skill for Copilot CLI, equipping agents with full heartbeat checkout, comment, status update, and artifact workflow capabilities.

## Install

### Register in Paperclip

```powershell
curl.exe -s -X POST http://127.0.0.1:3400/api/adapters/install `
  -H 'Content-Type: application/json' `
  --data '{"packageName":"C:\\Code\\copilot-paperclip-adapter","isLocalPath":true}'
```

The registration persists in `~/.paperclip/adapter-plugins.json` and reloads on
server start. The package resolves `@paperclipai/adapter-utils` from the
Paperclip checkout or dependencies.

### Install Copilot Skill

To give Copilot agents full Paperclip control plane capabilities, copy or symlink the included skill:

```powershell
# In your global Copilot home or dedicated agent COPILOT_HOME:
Copy-Item -Recurse -Force "skills/paperclip" "$env:USERPROFILE\.copilot\skills\"
```

## What a run does

1. **Working directory** — a Paperclip-managed workspace wins over `cwd`.
2. **Environment** — `PAPERCLIP_*` identity/credentials, runtime-tool access,
   wake payload, then your `env` overrides, then `COPILOT_HOME`.
3. **Prompt** — managed instructions (fresh sessions only) + wake prompt +
   session-handoff note + runtime access note + rendered prompt template.
4. **Invocation** — `--prompt`, `--output-format json`, `--usage-output-file`,
   plus model/permission/session flags.
5. **Result** — parses the JSONL stream for the assistant messages, session id
   and errors, and the usage file for token counts, premium requests, and cost USD.

## Configuration

| Key | Default | Notes |
| --- | --- | --- |
| `command` | `copilot` | On Windows automatically resolves `node <npm-loader.js>` to avoid cmd.exe length limits. |
| `commandPrefixArgs` | `[]` | Args placed before every Copilot flag. |
| `cwd` | `process.cwd()` | Absolute path. A project workspace overrides it. |
| `copilotHome` | — | Dedicated Copilot home for this agent (`COPILOT_HOME`). |
| `model` | CLI default | Passed to `--model` (e.g. `gpt-5.6-sol`, `claude-opus-5`, `claude-sonnet-5`). |
| `effort` | CLI default | Reasoning effort (`minimal`, `low`, `medium`, `high`, `xhigh`, `max`). |
| `persistSession` | `false` | Resume the same Copilot session across wakes. |
| `deliverInstructionsInPrompt` | `true` | Prepend the managed bundle to prompt. |
| `allowAllTools` | `true` | Required for unattended runs. |
| `allowAllPaths` | `false` | Lets agent access files outside working directory. |
| `allowAllUrls` | `true` | Allows URL and network tool calls without prompts. |
| `allowAll` | `false` | Passes `--allow-all` (yolo mode). |
| `addDirs` | `[]` | Extra accessible paths (`--add-dir`). |
| `timeoutSec` | `0` | `0` disables timeout. |
| `logDir` | — | Copilot CLI debug logs. |

## Design notes

**Windows argv.** `copilot.cmd` rewrites its arguments and corrupts multi-line
prompts, while `cmd.exe` limits command line length to 8191 chars. The adapter
automatically detects Windows environments and launches via Node directly
(`node <npm-loader.js>`), raising the limit to 32,767 chars.

**Instructions delivery.** Copilot has no flag for "load this instructions
file"; it only discovers `AGENTS.md` / `.github/copilot-instructions.md`
relative to the working directory. Writing the managed bundle into the repo
would clobber the project's own `AGENTS.md`, so the bundle is delivered as the
first prompt section instead. The repo is left untouched and the agent still
receives its execution contract on every fresh session. `supportsInstructionsBundle`
is declared so the Paperclip UI still offers the bundle editor.

**COPILOT_HOME isolation.** `COPILOT_HOME` scopes `mcp-config.json`, `hooks/`,
`skills/`, `config.json` and `permissions-config.json`. Pointing each agent at a
purpose-built home keeps unrelated global MCP servers and pre-tool-use hooks out
of Paperclip runs.

**Sessions are off by default.** Every wake starts a fresh Copilot session. That
is deliberate: long-lived sessions accumulate context rot and eventually stall
mid-turn. Enable `persistSession` only for agents that genuinely need to carry
state between wakes; the session id is stored with its `cwd` and is never
resumed in a different directory. If a stored session has been pruned, the run
retries once from a clean session rather than failing.

**Cost and Token Accounting.** Calculates exact USD costs from token counts (input,
cached read, cache write, output) and AI credits / nano-AIU metrics across all
supported models.

## License

MIT © Caleb Zearing
