/**
 * End-to-end smoke test for handoff-mcp.
 *
 * Launches the compiled MCP server over stdio against a TEMP store + dedicated
 * Chroma port, then drives all five tools and asserts each returns a real data
 * shape (structured JSON) rather than a "[stub]" string.
 *
 * Run after `npm run build`:  node scripts/smoke.mjs
 */
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gracefulStop, rmRetry } from "./_harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

// Read the expected version from package.json so a release bump can't leave a
// stale hardcoded assertion behind.
const PKG_VERSION = JSON.parse(
  fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
).version;

const storePath = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-smoke-"));
const PORT = "8973"; // unusual port to avoid clashing with a real server
const env = {
  ...process.env,
  HANDOFF_STORE_PATH: storePath,
  CHROMA_PORT: PORT,
  CHROMA_HOST: "localhost",
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
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id != null && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

let nextId = 1;
function rpc(method, params, timeoutMs = 60000) {
  const id = nextId++;
  const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timeout waiting for ${method}`)),
      timeoutMs,
    );
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    proc.stdin.write(payload);
  });
}

function notify(method, params) {
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

function parseToolResult(resp, label) {
  if (resp.error) throw new Error(`${label}: RPC error ${JSON.stringify(resp.error)}`);
  const text = resp.result?.content?.[0]?.text;
  if (typeof text !== "string") throw new Error(`${label}: no text content`);
  if (text.includes("[stub]")) throw new Error(`${label}: STILL A STUB -> ${text}`);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${label}: content is not JSON -> ${text}`);
  }
  return { parsed, isError: resp.result?.isError === true };
}

const failures = [];
function check(cond, msg) {
  if (!cond) failures.push(msg);
  console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`);
}

async function main() {
  // 1) initialize handshake
  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke", version: "0" },
  });
  check(
    init.result?.serverInfo?.version === PKG_VERSION,
    `server reports v${PKG_VERSION} (package.json version)`,
  );
  notify("notifications/initialized", {});

  // 2) tools/list shows all five
  const list = await rpc("tools/list", {});
  const names = (list.result?.tools ?? []).map((t) => t.name).sort();
  const expected = [
    "get_cross_product_brief",
    "get_recent_code_context",
    "get_recent_cowork_context",
    "query_strategist_memory",
    "write_strategist_finding",
  ];
  check(
    JSON.stringify(names) === JSON.stringify(expected),
    `tools/list = ${names.join(", ")}`,
  );

  // 3) write_strategist_finding (this also boots the local Chroma server)
  console.log("\n... first tool call boots Chroma + loads embed model (~slow)\n");
  const writeResp = await rpc("tools/call", {
    name: "write_strategist_finding",
    arguments: {
      finding: "Cross-product memory bridge ties Cowork and Code via a local store.",
      tags: ["architecture", "memory"],
    },
  });
  const { parsed: writeOut } = parseToolResult(writeResp, "write_strategist_finding");
  check(writeOut.status === "written" && typeof writeOut.id === "string", "write returns {status,id}");

  // 3b) seed cowork + code collections against the SAME server so the read
  //     tools have real data to surface.
  const { Store } = await import(
    pathToFileURL(path.join(ROOT, "dist", "store.js")).href
  );
  const store = new Store({ host: "localhost", port: Number(PORT) });
  await store.addDocument("cowork_sessions", "Cowork: drafted the Handoff launch post for r/ClaudeAI.", {
    source: "cowork", type: "cowork", filename: "launch-post.md",
  });
  await store.addDocument("code_sessions", "Code: implemented store.ts ChromaDB adapter and wired tool handlers.", {
    source: "code", type: "code", repo: "handoff-mcp", filename: "store.ts",
  });

  // 4) query_strategist_memory
  const qResp = await rpc("tools/call", {
    name: "query_strategist_memory",
    arguments: { query: "memory bridge architecture", limit: 3 },
  });
  const { parsed: qOut } = parseToolResult(qResp, "query_strategist_memory");
  check(Array.isArray(qOut.results) && qOut.results.length >= 1, "query returns >=1 result");
  check(
    qOut.results.some((r) => Array.isArray(r.tags) && r.tags.includes("architecture")),
    "query result decodes tags array",
  );

  // 5) get_recent_cowork_context
  const cwResp = await rpc("tools/call", {
    name: "get_recent_cowork_context",
    arguments: { limit: 5 },
  });
  const { parsed: cwOut } = parseToolResult(cwResp, "get_recent_cowork_context");
  check(cwOut.collection === "cowork_sessions" && cwOut.count >= 1, "cowork context returns seeded item");

  // 6) get_recent_code_context
  const cdResp = await rpc("tools/call", {
    name: "get_recent_code_context",
    arguments: { limit: 5, repo: "handoff-mcp" },
  });
  const { parsed: cdOut } = parseToolResult(cdResp, "get_recent_code_context");
  check(cdOut.collection === "code_sessions" && cdOut.count >= 1, "code context returns seeded item (repo filtered)");

  // 7) get_cross_product_brief
  const brResp = await rpc("tools/call", {
    name: "get_cross_product_brief",
    arguments: { topic: "handoff memory" },
  });
  const { parsed: brOut } = parseToolResult(brResp, "get_cross_product_brief");
  check(
    brOut.sources &&
      "cowork_sessions" in brOut.sources &&
      "code_sessions" in brOut.sources &&
      "strategist_memory" in brOut.sources,
    "brief returns all three source buckets",
  );

  console.log("\n--- sample brief output ---");
  console.log(JSON.stringify(brOut, null, 2).slice(0, 800));
}

main()
  .then(async () => {
    await gracefulStop(proc);
    rmRetry(storePath);
    if (failures.length) {
      console.error(`\n${failures.length} CHECK(S) FAILED`);
      process.exit(1);
    }
    console.log("\nALL SMOKE CHECKS PASSED");
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("\nSMOKE TEST ERROR:", err);
    await gracefulStop(proc);
    rmRetry(storePath);
    process.exit(1);
  });
