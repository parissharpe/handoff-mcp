/**
 * Coexistence integration test for handoff-mcp v0.3.0.
 *
 * Proves the reconciled architecture: the Node MCP server owns ONE Chroma
 * server, and the Python cowork watcher writes into that SAME server over HTTP
 * (no embedded PersistentClient, no SQLite lock conflict). A file indexed by the
 * Python watcher must then be visible through the MCP server's
 * get_recent_cowork_context tool.
 *
 * Run after `npm run build`:  node scripts/integration.mjs
 */
import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { findPython, gracefulStop, rmRetry } from "./_harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const PORT = "8977";

// Locate Python (the watcher install) in a CI-portable way.
const PYTHON = findPython();

const storePath = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-int-store-"));
const coworkDir = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-int-cowork-"));
const env = {
  ...process.env,
  HANDOFF_STORE_PATH: storePath,
  COWORK_OUTPUT_FOLDER: coworkDir,
  CHROMA_HOST: "localhost",
  CHROMA_PORT: PORT,
};

const proc = spawn(process.execPath, [path.join(ROOT, "dist", "index.js")], {
  env,
  stdio: ["pipe", "pipe", "inherit"],
});

let buffer = "";
const pending = new Map();
proc.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id != null && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

let nextId = 1;
function rpc(method, params, timeoutMs = 90000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), timeoutMs);
    pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
function notify(method, params) {
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}
function toolJSON(resp, label) {
  if (resp.error) throw new Error(`${label}: ${JSON.stringify(resp.error)}`);
  return JSON.parse(resp.result.content[0].text);
}

const failures = [];
function check(cond, msg) {
  if (!cond) failures.push(msg);
  console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`);
}

async function cleanup() {
  // Graceful stop: closing stdin lets the MCP server stop its Chroma child
  // cleanly (flush + release port), so the store dir is unlocked for removal.
  await gracefulStop(proc);
  rmRetry(storePath);
  rmRetry(coworkDir);
}

async function main() {
  await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "integration", version: "0" },
  });
  notify("notifications/initialized", {});

  // First call boots the single Chroma server (owned by the MCP process).
  console.log("\n... booting Chroma via MCP server (first call)\n");
  const before = toolJSON(
    await rpc("tools/call", { name: "get_recent_cowork_context", arguments: { limit: 10 } }),
    "cowork(before)",
  );
  check(before.count === 0, "cowork context starts empty");

  // Write a real file into the watched folder, then have the PYTHON watcher
  // index it into the SAME server over HTTP (the coexistence path).
  const fileName = "handoff-integration-note.md";
  const filePath = path.join(coworkDir, fileName);
  const content = "# Integration Note\n\nThe watcher and MCP server share one Chroma server.";
  fs.writeFileSync(filePath, content, "utf-8");

  console.log("... Python watcher indexing the file over HTTP\n");
  const py = spawnSync(
    PYTHON,
    [
      "-c",
      "import sys,os; sys.path.insert(0, os.path.join(os.getcwd(),'watchers')); import cowork; print('INDEXED', cowork.index_file(os.environ['HANDOFF_TEST_FILE']))",
    ],
    {
      cwd: ROOT,
      env: { ...env, HANDOFF_TEST_FILE: filePath },
      encoding: "utf-8",
    },
  );
  if (py.status !== 0) {
    console.error("python watcher stderr:\n", py.stderr);
    throw new Error(`python watcher exited ${py.status}`);
  }
  check(/INDEXED True/.test(py.stdout), `watcher indexed file (py: ${py.stdout.trim()})`);

  // Now the MCP server must SEE the watcher's file.
  const after = toolJSON(
    await rpc("tools/call", { name: "get_recent_cowork_context", arguments: { limit: 10 } }),
    "cowork(after)",
  );
  check(after.count >= 1, "MCP server sees the watcher-indexed file");
  const item = (after.items || [])[0];
  check(
    item && item.metadata && item.metadata.filename === fileName,
    `cross-process doc has correct filename (${item?.metadata?.filename})`,
  );
  check(
    item && item.metadata && item.metadata.source === "cowork" && typeof item.metadata.created_at === "string",
    "cross-process doc honors shared metadata contract",
  );

  // And semantic surfacing via the brief works across the shared store.
  const brief = toolJSON(
    await rpc("tools/call", { name: "get_cross_product_brief", arguments: { topic: "shared chroma server" } }),
    "brief",
  );
  check(brief.totals.cowork >= 1, "brief surfaces the watcher's cowork doc");
}

main()
  .then(async () => {
    await cleanup();
    if (failures.length) {
      console.error(`\n${failures.length} CHECK(S) FAILED`);
      process.exit(1);
    }
    console.log("\nALL INTEGRATION CHECKS PASSED (MCP + watcher share one server)");
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("\nINTEGRATION ERROR:", err);
    await cleanup();
    process.exit(1);
  });
