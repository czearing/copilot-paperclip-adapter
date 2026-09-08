import fs from "node:fs/promises";
import path from "node:path";

/**
 * Resolve a Windows-safe launcher for the Copilot CLI.
 *
 * Returns `node <npm-loader.js>` when the configured command is the bare
 * `copilot` shim on Windows, so the child is spawned directly rather than
 * through cmd.exe. Returns null when it cannot be resolved, leaving the
 * caller's original command untouched.
 */
export async function resolveWindowsCopilotLauncher(command) {
  if (process.platform !== "win32") return null;

  const normalized = String(command || "").trim().toLowerCase();
  const isBareShim =
    normalized === "" || normalized === "copilot" || normalized === "copilot.cmd" || normalized === "copilot.bat";
  if (!isBareShim) return null;

  const loaderSuffix = path.join("node_modules", "@github", "copilot", "npm-loader.js");
  const candidates = [];

  const explicit = String(process.env.COPILOT_NPM_LOADER || "").trim();
  if (explicit) candidates.push(explicit);

  // Walk PATH looking for the copilot shim; the loader ships alongside it.
  const rawPath = process.env.PATH || process.env.Path || "";
  for (const dir of rawPath.split(path.delimiter)) {
    const trimmed = dir.trim();
    if (!trimmed) continue;
    candidates.push(path.join(trimmed, loaderSuffix));
    candidates.push(path.join(trimmed, "..", loaderSuffix));
  }

  const prefix = String(process.env.npm_config_prefix || "").trim();
  if (prefix) candidates.push(path.join(prefix, loaderSuffix));
  if (process.env.APPDATA) candidates.push(path.join(process.env.APPDATA, "npm", loaderSuffix));

  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return { command: process.execPath, prefixArgs: [path.resolve(candidate)] };
    } catch {
      // Try the next candidate.
    }
  }

  return null;
}

/**
 * Resolve an absolute path to the Copilot CLI when running under minimal
 * service environments (e.g. launchd / systemd where PATH may be restricted).
 */
export async function resolveCopilotLauncher(command) {
  if (process.platform === "win32") {
    return resolveWindowsCopilotLauncher(command);
  }

  const normalized = String(command || "").trim();
  if (normalized !== "" && normalized !== "copilot") return null;

  const home = process.env.HOME || "";
  const candidates = [
    path.join(path.dirname(process.execPath), "copilot"),
    path.join(home, ".local", "bin", "copilot"),
    "/opt/homebrew/bin/copilot",
    "/usr/local/bin/copilot",
  ];

  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return { command: candidate, prefixArgs: [] };
    } catch {
      // Try next candidate.
    }
  }

  return null;
}
