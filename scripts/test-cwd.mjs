/**
 * Regression: the server must work when launched from OUTSIDE the repo root.
 *
 * v0.3.0 resolved the Windows x64 Chroma native binding with
 * createRequire(path.join(process.cwd(), "package.json")). Any MCP host that
 * spawns the server with its own working directory — which is every normal
 * registration — failed to start Chroma, and every store-backed tool returned
 * "Chroma server did not become ready" after a 30s timeout.
 *
 * This spawns dist/index.js with cwd set to an unrelated temp directory and
 * asserts that a store-backed tool actually succeeds.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT, spawnMcp, gracefulStop, rmRetry } from "./_harness.mjs";

const storePath = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-cwd-store-"));
const foreignCwd = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-cwd-elsewhere-"));

let failures = 0;
function check(ok, label) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures++;
}

console.log("repo root :", ROOT);
console.log("spawn cwd :", foreignCwd, "(deliberately not the repo)");

const env = { ...process.env, HANDOFF_STORE_PATH: storePath };
delete env.CHROMA_HOST;
delete env.CHROMA_PORT;

let mcp;
try {
  mcp = spawnMcp(env, { cwd: foreignCwd });
  await mcp.init("cwd-test");

  const written = await mcp.callTool("write_strategist_finding", {
    finding: "Written by a server launched from a foreign working directory.",
    tags: ["cwd"],
  });
  check(!written.isError, "write succeeds with cwd outside the repo");
  if (written.isError) console.log("   error was:", String(written.text).slice(0, 300));

  const read = await mcp.callTool("query_strategist_memory", {
    query: "foreign working directory",
    limit: 3,
  });
  check(!read.isError, "query succeeds with cwd outside the repo");
  check(
    (read.parsed?.count ?? 0) >= 1,
    "the finding written from a foreign cwd is retrievable",
  );

  // The store must land where HANDOFF_STORE_PATH pointed, not beside the cwd.
  check(
    fs.existsSync(path.join(storePath, "server.json")),
    "server.json is written under HANDOFF_STORE_PATH",
  );
  check(
    !fs.existsSync(path.join(foreignCwd, "server.json")),
    "nothing is written into the spawn cwd",
  );

  console.log(
    failures === 0 ? "\nALL CWD TESTS PASSED" : `\n${failures} CWD TEST(S) FAILED`,
  );
} finally {
  if (mcp) await gracefulStop(mcp.proc);
  rmRetry(storePath);
  rmRetry(foreignCwd);
}

process.exit(failures === 0 ? 0 : 1);
