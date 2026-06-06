/**
 * Restart regression test for handoff-mcp.
 *
 * Reproduces and guards against the bug found during Phase 1: after stopping the
 * MCP server (which owns the Chroma server) and starting it again against the
 * SAME store, reads must still return the data — no empty-read race.
 *
 * Flow: start MCP -> write a finding -> graceful stop -> restart -> read back.
 *
 * Run after `npm run build`:  node scripts/test-restart.mjs
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawnMcp, gracefulStop, rmRetry } from "./_harness.mjs";

const storePath = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-restart-"));
const PORT = "8131";
const env = { ...process.env, HANDOFF_STORE_PATH: storePath, CHROMA_PORT: PORT, CHROMA_HOST: "localhost" };

const failures = [];
const check = (cond, msg) => { if (!cond) failures.push(msg); console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`); };

const MARKER = "restart-regression marker " + PORT;

async function run() {
  // --- Session 1: write data, then stop gracefully ---
  const s1 = spawnMcp(env);
  await s1.init("restart-1");
  const w = await s1.callTool("write_strategist_finding", { finding: MARKER, tags: ["restart", "regression"] });
  check(w.parsed?.status === "written", "session 1: write_strategist_finding succeeded");
  const q1 = await s1.callTool("query_strategist_memory", { query: "restart regression", limit: 5 });
  check((q1.parsed?.count ?? 0) >= 1, "session 1: data readable before restart");
  await gracefulStop(s1.proc);
  check(s1.proc.exitCode === 0, `session 1: graceful exit (code=${s1.proc.exitCode})`);

  // server.json should be gone after graceful shutdown
  check(!fs.existsSync(path.join(storePath, "server.json")), "session 1: server.json removed on stop");

  // --- Session 2: restart against the SAME store, data must persist & read ---
  const s2 = spawnMcp(env);
  await s2.init("restart-2");
  // first read on a freshly restarted server — this is exactly where the 1->0 bug hit
  const r = await s2.callTool("query_strategist_memory", { query: "restart regression", limit: 5 });
  check((r.parsed?.count ?? 0) >= 1, "session 2: data still readable after restart (no empty-read race)");
  const found = (r.parsed?.results ?? []).some((x) => x.content === MARKER);
  check(found, "session 2: the exact written finding round-trips after restart");
  // also verify recent-list path
  const recent = await s2.callTool("query_strategist_memory", { query: "marker", limit: 5 });
  check(!recent.isError, "session 2: second query does not error");
  await gracefulStop(s2.proc);
}

run()
  .catch((e) => { console.error("ERROR:", e.message); failures.push(e.message); })
  .finally(() => {
    rmRetry(storePath);
    if (failures.length) { console.error(`\n${failures.length} CHECK(S) FAILED`); process.exit(1); }
    console.log("\nALL RESTART CHECKS PASSED");
    process.exit(0);
  });
