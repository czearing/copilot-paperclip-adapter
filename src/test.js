import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { asString, asStringArray, ensurePathInEnv, parseObject } from "@paperclipai/adapter-utils/server-utils";
import { ADAPTER_TYPE, DEFAULT_COPILOT_COMMAND } from "./constants.js";
import { resolveWindowsCopilotLauncher } from "./launcher.js";

const execFileAsync = promisify(execFile);

function check(code, level, message, detail = null, hint = null) {
  return { code, level, message, detail, hint };
}

async function isDirectory(candidate) {
  try {
    const stat = await fs.stat(candidate);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

export async function testEnvironment(ctx) {
  const config = parseObject(ctx.config);
  const checks = [];

  const command = asString(config.command, DEFAULT_COPILOT_COMMAND);
  const commandPrefixArgs = asStringArray(config.commandPrefixArgs);
  const cwd = asString(config.cwd, "").trim();
  const copilotHome = asString(config.copilotHome, "").trim();

  // --- working directory --------------------------------------------------
  if (!cwd) {
    checks.push(
      check(
        "cwd_missing",
        "warn",
        "No cwd configured",
        null,
        "Set cwd, or attach a workspace to the project so Paperclip supplies one.",
      ),
    );
  } else if (!path.isAbsolute(cwd)) {
    checks.push(check("cwd_relative", "error", `cwd must be an absolute path: "${cwd}"`));
  } else if (!(await isDirectory(cwd))) {
    checks.push(check("cwd_not_found", "error", `cwd does not exist: "${cwd}"`));
  } else {
    checks.push(check("cwd_ok", "info", `Working directory resolved: ${cwd}`));
  }

  // --- COPILOT_HOME -------------------------------------------------------
  const env = ensurePathInEnv({ ...process.env });
  if (copilotHome) {
    if (await isDirectory(copilotHome)) {
      env.COPILOT_HOME = copilotHome;
      const mcpConfig = path.join(copilotHome, "mcp-config.json");
      const hasMcp = await fs
        .access(mcpConfig)
        .then(() => true)
        .catch(() => false);
      checks.push(
        check(
          "copilot_home_ok",
          "info",
          `COPILOT_HOME resolved: ${copilotHome}`,
          hasMcp ? "mcp-config.json present" : "no mcp-config.json (no MCP servers will load)",
        ),
      );
    } else {
      checks.push(
        check(
          "copilot_home_missing",
          "error",
          `copilotHome does not exist: "${copilotHome}"`,
          null,
          "Create the directory, or clear copilotHome to use the default ~/.copilot home.",
        ),
      );
    }
  } else {
    checks.push(
      check(
        "copilot_home_default",
        "warn",
        "No copilotHome configured — the shared ~/.copilot home will be used",
        null,
        "Point copilotHome at a dedicated home so global MCP servers and hooks do not affect Paperclip runs.",
      ),
    );
  }

  // --- CLI reachable + authenticated --------------------------------------
  let effectiveCommand = command;
  let effectivePrefixArgs = commandPrefixArgs;
  if (effectivePrefixArgs.length === 0) {
    const launcher = await resolveWindowsCopilotLauncher(effectiveCommand);
    if (launcher) {
      effectiveCommand = launcher.command;
      effectivePrefixArgs = launcher.prefixArgs;
    }
  }

  try {
    const { stdout } = await execFileAsync(effectiveCommand, [...effectivePrefixArgs, "--version"], {
      env,
      timeout: 60_000,
      windowsHide: true,
    });
    checks.push(
      check("cli_ok", "info", "Copilot CLI is reachable", stdout.trim().split(/\r?\n/)[0] ?? null),
    );
  } catch (err) {
    checks.push(
      check(
        "cli_missing",
        "error",
        "Could not run the Copilot CLI",
        err instanceof Error ? err.message : String(err),
        "Install it with `npm i -g @github/copilot`, or set command/commandPrefixArgs to launch it directly.",
      ),
    );
    return { adapterType: ADAPTER_TYPE, status: "fail", checks, testedAt: new Date().toISOString() };
  }

  const token =
    asString(parseObject(config.env).GH_TOKEN, "") ||
    asString(parseObject(config.env).GITHUB_TOKEN, "") ||
    asString(process.env.GH_TOKEN, "") ||
    asString(process.env.GITHUB_TOKEN, "");
  const homeForAuth = copilotHome || path.join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".copilot");
  const hasStoredAuth = await fs
    .access(path.join(homeForAuth, "config.json"))
    .then(() => true)
    .catch(() => false);
  if (token) {
    checks.push(check("auth_token", "info", "Authenticating with a GitHub token from the environment"));
  } else if (hasStoredAuth) {
    checks.push(check("auth_stored", "info", `Using stored Copilot credentials in ${homeForAuth}`));
  } else {
    checks.push(
      check(
        "auth_missing",
        "error",
        "No Copilot credentials found",
        `Looked for config.json in ${homeForAuth}`,
        "Run `copilot` once interactively with COPILOT_HOME set, or provide GH_TOKEN in the adapter env.",
      ),
    );
  }

  const hasError = checks.some((entry) => entry.level === "error");
  const hasWarn = checks.some((entry) => entry.level === "warn");
  return {
    adapterType: ADAPTER_TYPE,
    status: hasError ? "fail" : hasWarn ? "warn" : "pass",
    checks,
    testedAt: new Date().toISOString(),
  };
}
