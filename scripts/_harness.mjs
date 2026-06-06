/**
 * Shared test harness for handoff-mcp scripts.
 *
 * Provides:
 *  - findPython(): CI-portable Python discovery (HANDOFF_PYTHON > PATH > known).
 *  - spawnMcp(env): start the compiled MCP server with JSON-RPC plumbing.
 *  - gracefulStop(proc): close stdin (the production shutdown trigger) and wait
 *    for clean exit, force-killing the process tree only as a fallback.
 *  - rmRetry(dir): best-effort recursive delete that tolerates Windows file locks.
 */
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Locate a Python interpreter in a CI-portable way. */
export function findPython() {
  if (process.env.HANDOFF_PYTHON) return process.env.HANDOFF_PYTHON;
  const candidates =
    process.platform === "win32" ? ["python.exe", "python3.exe", "py.exe"] : ["python3", "python"];
  for (const c of candidates) {
    const r = spawnSync(c, ["--version"], { stdio: "ignore" });
    if (r.status === 0) return c;
  }
  // Last resort: the per-user install location used during development.
  const fallback = path.join(
    process.env.LOCALAPPDATA || "",
    "Programs",
    "Python",
    "Python312",
    "python.exe",
  );
  if (process.platform === "win32" && fs.existsSync(fallback)) return fallback;
  throw new Error(
    "No Python interpreter found. Set HANDOFF_PYTHON or add python to PATH.",
  );
}

/** Spawn the compiled MCP server and return a small JSON-RPC client + control. */
export function spawnMcp(env, { inheritStderr = true } = {}) {
  const proc = spawn(process.execPath, [path.join(ROOT, "dist", "index.js")], {
    env,
    stdio: ["pipe", "pipe", inheritStderr ? "inherit" : "ignore"],
  });
  let buffer = "";
  const pending = new Map();
  proc.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    let i;
    while ((i = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (!line) continue;
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      if (m.id != null && pending.has(m.id)) {
        pending.get(m.id)(m);
        pending.delete(m.id);
      }
    }
  });

  let id = 1;
  const rpc = (method, params, timeoutMs = 120000) =>
    new Promise((resolve, reject) => {
      const i = id++;
      const t = setTimeout(() => reject(new Error("timeout " + method)), timeoutMs);
      pending.set(i, (m) => { clearTimeout(t); resolve(m); });
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, method, params }) + "\n");
    });
  const notify = (method, params) =>
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");

  async function init(clientName = "harness") {
    await rpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: clientName, version: "0" },
    });
    notify("notifications/initialized", {});
  }

  const callTool = async (name, args) => {
    const r = await rpc("tools/call", { name, arguments: args });
    if (r.error) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
    const text = r.result?.content?.[0]?.text;
    return { text, isError: r.result?.isError === true, parsed: safeJSON(text) };
  };

  return { proc, rpc, notify, init, callTool };
}

function safeJSON(text) {
  try { return JSON.parse(text); } catch { return undefined; }
}

/** Close stdin (graceful shutdown trigger) and await clean exit; force-kill as fallback. */
export function gracefulStop(proc, timeoutMs = 10000) {
  return new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    proc.once("exit", finish);
    try { proc.stdin.end(); } catch { /* already closed */ }
    setTimeout(() => {
      if (!done && proc.pid) {
        if (process.platform === "win32") {
          spawnSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
        } else {
          try { proc.kill("SIGKILL"); } catch { /* gone */ }
        }
      }
      finish();
    }, timeoutMs);
  });
}

/** Recursive delete that retries through transient Windows file locks. */
export function rmRetry(dir) {
  for (let i = 0; i < 12; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      return;
    } catch {
      const until = Date.now() + 300;
      while (Date.now() < until) { /* brief spin */ }
    }
  }
}
