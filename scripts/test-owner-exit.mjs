/**
 * Regression: an attached client must recover when the server owner exits.
 *
 * handoff supports several MCP hosts sharing one Chroma store. The first
 * process to start becomes the owner; others attach via server.json. In v0.3.0
 * the owner tore the Chroma server down on exit while attached processes kept a
 * cached, now-dead client and failed every later call until they were
 * themselves restarted — closing Claude Desktop silently broke a running Claude
 * Code session, and the reverse.
 *
 * A (owner) and B (attached) both work; A exits; B must still answer.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnMcp, gracefulStop, rmRetry } from "./_harness.mjs";

const storePath = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-owner-exit-"));

let failures = 0;
function check(ok, label) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures++;
}

const env = { ...process.env, HANDOFF_STORE_PATH: storePath };
delete env.CHROMA_HOST;
delete env.CHROMA_PORT;

let a, b;
try {
  // --- A starts and becomes the owner -------------------------------------
  a = spawnMcp(env, { inheritStderr: false });
  await a.init("owner-A");
  const aWrite = await a.callTool("write_strategist_finding", {
    finding: "Written by the owning process before it exits.",
    tags: ["owner"],
  });
  check(!aWrite.isError, "owner A writes successfully");
  check(
    fs.existsSync(path.join(storePath, "server.json")),
    "owner A published server.json",
  );

  // --- B attaches to A's server -------------------------------------------
  b = spawnMcp(env, { inheritStderr: false });
  await b.init("attached-B");
  const bBefore = await b.callTool("query_strategist_memory", {
    query: "owning process",
    limit: 3,
  });
  check(!bBefore.isError, "attached B reads through A's server");
  check(
    (bBefore.parsed?.count ?? 0) >= 1,
    "attached B sees the document A wrote",
  );

  // --- A exits the way a host stops a stdio server: close its stdin --------
  console.log("... stopping owner A");
  await gracefulStop(a.proc);
  a = null;
  // Give the OS a moment to actually release the port.
  await new Promise((r) => setTimeout(r, 2000));

  // --- B must recover rather than staying broken --------------------------
  const bAfter = await b.callTool("query_strategist_memory", {
    query: "owning process",
    limit: 3,
  });
  check(!bAfter.isError, "attached B still answers after the owner exited");
  if (bAfter.isError) console.log("   error was:", String(bAfter.text).slice(0, 300));
  check(
    (bAfter.parsed?.count ?? 0) >= 1,
    "attached B still returns the persisted document after recovery",
  );

  // And B should now be able to write through whatever server it re-resolved.
  const bWrite = await b.callTool("write_strategist_finding", {
    finding: "Written by the attached process after the owner exited.",
    tags: ["recovered"],
  });
  check(!bWrite.isError, "attached B can write after recovery");

  console.log(
    failures === 0
      ? "\nALL OWNER-EXIT TESTS PASSED"
      : `\n${failures} OWNER-EXIT TEST(S) FAILED`,
  );
} finally {
  if (b) await gracefulStop(b.proc);
  if (a) await gracefulStop(a.proc);
  rmRetry(storePath);
}

process.exit(failures === 0 ? 0 : 1);
