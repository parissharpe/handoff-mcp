/**
 * Standalone smoke test for src/store.ts (run against the compiled dist output).
 *
 * Usage:
 *   npm run build
 *   node scripts/test-store.mjs
 *
 * Exits 0 on success, non-zero on any assertion/connection failure.
 *
 * It points HANDOFF_STORE_PATH at a fresh temp dir, spawns a local Chroma
 * server backed by that dir on an ephemeral port, then:
 *   1. addDocument -> query, asserts the doc comes back as a hit.
 *   2. write (finding) -> listRecent, asserts the finding appears.
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

function assert(cond, msg) {
  if (!cond) {
    console.error("ASSERTION FAILED:", msg);
    process.exit(1);
  }
  console.log("ok -", msg);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-store-test-"));
process.env.HANDOFF_STORE_PATH = tmp;
const port = 8000 + Math.floor(Math.random() * 1000);
process.env.CHROMA_HOST = "localhost";
process.env.CHROMA_PORT = String(port);

console.log("temp store:", tmp);
console.log("chroma port:", port);

const { Store, startLocalServer, resolveStorePath } = await import(
  "../dist/store.js"
);

assert(resolveStorePath() === tmp, "resolveStorePath honors HANDOFF_STORE_PATH");

let server;
try {
  server = await startLocalServer({ storePath: tmp, port, timeoutMs: 60_000 });
  console.log("server ready on port", server.port);

  const store = new Store({ host: "localhost", port });
  const collection = "test_collection";

  // 1. addDocument + query
  const docId = await store.addDocument(
    collection,
    "Quarterly revenue grew because the onboarding funnel was simplified.",
    { source: "unit-test" },
  );
  assert(typeof docId === "string" && docId.length > 0, "addDocument returns an id");

  const hits = await store.query(collection, "why did revenue grow", 3);
  assert(Array.isArray(hits) && hits.length > 0, "query returns at least one hit");
  const found = hits.find((h) => h.id === docId);
  assert(found !== undefined, "query returns the added document by id");
  assert(
    typeof found.document === "string" && found.document.includes("revenue"),
    "queried document text round-trips",
  );
  assert(
    found.metadata && found.metadata.source === "unit-test",
    "queried document metadata round-trips",
  );
  assert(
    found.metadata && typeof found.metadata.created_at === "string",
    "addDocument injected created_at",
  );

  // 2. write (finding) + listRecent
  const findingId = await store.write(
    "strategist_memory",
    "Users churn most in week 2; intervene with a check-in email.",
    ["churn", "retention"],
  );
  assert(typeof findingId === "string" && findingId.length > 0, "write returns an id");

  const recent = await store.listRecent("strategist_memory", 10);
  assert(Array.isArray(recent) && recent.length > 0, "listRecent returns rows");
  const finding = recent.find((r) => r.id === findingId);
  assert(finding !== undefined, "listRecent includes the written finding");
  assert(finding.metadata.type === "finding", "finding metadata.type === 'finding'");
  assert(finding.metadata.tags === "churn,retention", "finding tags stored comma-joined");
  assert(
    typeof finding.metadata.created_at === "string",
    "finding has created_at timestamp",
  );

  // listRecent ordering: add a second, newer finding and confirm it sorts first.
  await new Promise((r) => setTimeout(r, 5));
  const newerId = await store.write("strategist_memory", "Newer finding.", ["x"]);
  const recent2 = await store.listRecent("strategist_memory", 10);
  assert(recent2[0].id === newerId, "listRecent sorts newest-first by created_at");

  console.log("\nALL STORE TESTS PASSED");
} finally {
  if (server) await server.stop(); // graceful: flush + release port before cleanup
  const { rmRetry } = await import("./_harness.mjs");
  rmRetry(tmp);
}
process.exit(0);
