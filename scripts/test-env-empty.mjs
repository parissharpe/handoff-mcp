/**
 * Regression: empty-string environment variables must be treated as unset.
 *
 * MCP hosts commonly materialize optional config as "" rather than omitting the
 * key. v0.3.0 used `process.env.CHROMA_HOST ?? "localhost"`, and `??` only
 * guards undefined — so CHROMA_HOST="" produced an endpoint of "http://:8000"
 * and the server never became ready.
 *
 * Also covers the unit-level behaviour of envVar/envNum directly.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT, spawnMcp, gracefulStop, rmRetry } from "./_harness.mjs";

const { envVar, envNum } = await import(
  pathToFileURL(path.join(ROOT, "dist", "store.js")).href
);

const storePath = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-env-empty-"));

let failures = 0;
function check(ok, label) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures++;
}

// --- unit level -----------------------------------------------------------
const saved = { h: process.env.CHROMA_HOST, p: process.env.CHROMA_PORT };
try {
  process.env.CHROMA_HOST = "";
  check(envVar("CHROMA_HOST") === undefined, "envVar('') -> undefined");
  process.env.CHROMA_HOST = "   ";
  check(envVar("CHROMA_HOST") === undefined, "envVar('   ') -> undefined");
  process.env.CHROMA_HOST = " localhost ";
  check(envVar("CHROMA_HOST") === "localhost", "envVar trims surrounding space");
  delete process.env.CHROMA_HOST;
  check(envVar("CHROMA_HOST") === undefined, "envVar(unset) -> undefined");

  process.env.CHROMA_PORT = "";
  check(envNum("CHROMA_PORT") === undefined, "envNum('') -> undefined");
  process.env.CHROMA_PORT = "not-a-number";
  check(envNum("CHROMA_PORT") === undefined, "envNum(non-numeric) -> undefined");
  process.env.CHROMA_PORT = "8123";
  check(envNum("CHROMA_PORT") === 8123, "envNum('8123') -> 8123");
} finally {
  if (saved.h === undefined) delete process.env.CHROMA_HOST;
  else process.env.CHROMA_HOST = saved.h;
  if (saved.p === undefined) delete process.env.CHROMA_PORT;
  else process.env.CHROMA_PORT = saved.p;
}

// --- end to end: a real server booted with CHROMA_HOST="" -----------------
let mcp;
try {
  mcp = spawnMcp(
    { ...process.env, HANDOFF_STORE_PATH: storePath, CHROMA_HOST: "", CHROMA_PORT: "" },
    { inheritStderr: false },
  );
  await mcp.init("env-empty");

  const written = await mcp.callTool("write_strategist_finding", {
    finding: "Written by a server started with empty CHROMA_HOST and CHROMA_PORT.",
    tags: ["env"],
  });
  check(!written.isError, 'server starts with CHROMA_HOST="" and CHROMA_PORT=""');
  if (written.isError) console.log("   error was:", String(written.text).slice(0, 300));

  const read = await mcp.callTool("query_strategist_memory", {
    query: "empty CHROMA_HOST",
    limit: 3,
  });
  check(
    !read.isError && (read.parsed?.count ?? 0) >= 1,
    "the document is retrievable over the fallback endpoint",
  );

  const ep = JSON.parse(fs.readFileSync(path.join(storePath, "server.json"), "utf8"));
  check(ep.host === "localhost", `server.json host fell back to localhost (got ${ep.host})`);

  console.log(
    failures === 0
      ? "\nALL EMPTY-ENV TESTS PASSED"
      : `\n${failures} EMPTY-ENV TEST(S) FAILED`,
  );
} finally {
  if (mcp) await gracefulStop(mcp.proc);
  rmRetry(storePath);
}

process.exit(failures === 0 ? 0 : 1);
