/**
 * Regression: listRecent must order by when content HAPPENED, not when it was
 * indexed, and the repo filter must be applied by Chroma rather than after
 * truncation.
 *
 * Before this test, listRecent sorted on `created_at` — index time. A bulk
 * backfill stamps every row within seconds of every other, so "recent" returned
 * an arbitrary slice; worse, a document indexed today outranked a conversation
 * from last week purely because it was written later. Transcript chunks carry
 * `turn_timestamp`; watcher-indexed files carry `modified_at`; strategist
 * findings have only `created_at`, which for them IS content time.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
function check(cond, msg) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`);
  if (!cond) failures++;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-recency-"));
process.env.HANDOFF_STORE_PATH = tmp;
const port = 8000 + Math.floor(Math.random() * 1000);
process.env.CHROMA_HOST = "localhost";
process.env.CHROMA_PORT = String(port);

const { Store, startLocalServer } = await import("../dist/store.js");

let server;
try {
  server = await startLocalServer({ storePath: tmp, port, timeoutMs: 60_000 });
  const store = new Store({ host: "localhost", port });
  const COL = "recency_test";

  // All four written in ONE batch, so created_at is effectively identical.
  // turn_timestamp is deliberately in the OPPOSITE order to insertion.
  await store.addDocument(COL, "oldest conversation about widgets", {
    repo: "alpha", turn_timestamp: "2026-01-01T00:00:00.000Z",
  });
  await store.addDocument(COL, "newest conversation about widgets", {
    repo: "alpha", turn_timestamp: "2026-06-01T00:00:00.000Z",
  });
  await store.addDocument(COL, "middle conversation about widgets", {
    repo: "alpha", turn_timestamp: "2026-03-01T00:00:00.000Z",
  });
  await store.addDocument(COL, "a different project entirely", {
    repo: "beta", turn_timestamp: "2026-05-01T00:00:00.000Z",
  });

  // --- 1. ordering follows turn_timestamp, not insertion / created_at ---
  const recent = await store.listRecent(COL, 10);
  const order = recent.map((r) => String(r.metadata?.turn_timestamp ?? ""));
  const sorted = [...order].sort().reverse();
  check(
    JSON.stringify(order) === JSON.stringify(sorted),
    `documents come back in turn_timestamp order (${order.map((s) => s.slice(0, 10)).join(" > ")})`,
  );
  check(
    String(recent[0].document).startsWith("newest"),
    "newest turn_timestamp is first despite being inserted second",
  );

  const createdAts = new Set(recent.map((r) => String(r.metadata?.created_at ?? "").slice(0, 16)));
  check(
    createdAts.size <= 2,
    `all rows share ~one created_at, so created_at could not have produced this order (${createdAts.size} distinct)`,
  );

  // --- 2. limit is a real limit ---
  const two = await store.listRecent(COL, 2);
  check(two.length === 2, "listRecent honors n");
  check(
    String(two[0].metadata?.turn_timestamp) === "2026-06-01T00:00:00.000Z" &&
      String(two[1].metadata?.turn_timestamp) === "2026-05-01T00:00:00.000Z",
    "a truncated page still returns the globally newest rows",
  );

  // --- 3. where clause is applied server-side, before truncation ---
  const alpha = await store.listRecent(COL, 2, { where: { repo: "alpha" } });
  check(alpha.length === 2, "filtered listRecent returns n rows from that repo");
  check(
    alpha.every((r) => r.metadata?.repo === "alpha"),
    "filtered listRecent returns only the requested repo",
  );
  check(
    String(alpha[0].metadata?.turn_timestamp) === "2026-06-01T00:00:00.000Z",
    "filtered results are still newest-first",
  );
  // beta's row is newer than alpha's 2nd and 3rd. Filtering after truncation
  // would have dropped an alpha row to make room for it.
  check(
    alpha.some((r) => String(r.document).startsWith("middle")),
    "filtering happens before truncation, not after",
  );

  // --- 4. fallback for documents with no turn_timestamp ---
  const FB = "fallback_test";
  await store.addDocument(FB, "file indexed now but modified long ago", {
    modified_at: "2026-02-01T00:00:00.000Z",
  });
  await store.addDocument(FB, "file indexed now and modified recently", {
    modified_at: "2026-07-01T00:00:00.000Z",
  });
  const fb = await store.listRecent(FB, 5);
  check(
    String(fb[0].document).includes("modified recently"),
    "with no turn_timestamp, modified_at orders the results",
  );

  // Strategist-style rows: created_at only. Must not throw or mis-sort.
  const SM = "created_only_test";
  await store.write(SM, "an earlier finding", ["a"]);
  await new Promise((r) => setTimeout(r, 1100));
  await store.write(SM, "a later finding", ["b"]);
  const sm = await store.listRecent(SM, 5);
  check(sm.length === 2, "created_at-only collection still lists");
  check(
    String(sm[0].document) === "a later finding",
    "created_at is used cleanly when nothing better exists",
  );

  console.log(
    failures === 0 ? "\nALL RECENCY TESTS PASSED" : `\n${failures} RECENCY TEST(S) FAILED`,
  );
} finally {
  if (server) await server.stop();
  const { rmRetry } = await import("./_harness.mjs");
  rmRetry(tmp);
}

process.exit(failures === 0 ? 0 : 1);
