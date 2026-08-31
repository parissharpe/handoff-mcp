/**
 * Regression: hybrid retrieval (keyword pre-filter + vector search).
 *
 * all-MiniLM-L6-v2 will not rank an exact rare identifier above a topical
 * summary — measured on real data, `get_building_demand` appeared in 35
 * documents and still lost to a memory index. store.query therefore detects
 * symbol-like tokens and runs a second, substring-filtered vector pass, fusing
 * the two ranked lists by Reciprocal Rank Fusion.
 *
 * The load-bearing guarantee is that ORDINARY PROSE IS UNAFFECTED: no token,
 * no second query, byte-identical results.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
function check(cond, msg, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${msg}${detail ? "  ::  " + detail : ""}`);
  if (!cond) failures++;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-hybrid-"));
process.env.HANDOFF_STORE_PATH = tmp;
const port = 8000 + Math.floor(Math.random() * 1000);
process.env.CHROMA_HOST = "localhost";
process.env.CHROMA_PORT = String(port);

const { Store, startLocalServer, rareTokens } = await import("../dist/store.js");

// ---------------------------------------------------------------------------
// 1. Rare-token detection (pure unit checks, no server needed)
// ---------------------------------------------------------------------------
console.log("--- rare-token detection: positive cases ---");
const POSITIVE = [
  ["snake_case", "why does get_building_demand return null", "get_building_demand"],
  ["SCREAMING_SNAKE", "is VITE_SUPABASE_URL set in prod", "VITE_SUPABASE_URL"],
  ["trailing underscore prefix", "which VITE_ vars are baked in", "VITE_"],
  ["camelCase", "where is getRatingLabel defined", "getRatingLabel"],
  ["dotted filename", "what changed in package.json", "package.json"],
  ["dotted identifier", "trace the store.query call path", "store.query"],
];
for (const [label, query, expected] of POSITIVE) {
  const tokens = rareTokens(query);
  check(tokens.includes(expected), `detects ${label}`, `${JSON.stringify(tokens)}`);
}

console.log("\n--- rare-token detection: negative cases (must find nothing) ---");
const NEGATIVE = [
  "what did we decide about the launch checklist",
  "how was the mobile layout verified on a real phone",
  "QA triage before launch: what was verified and what blocked going live",
  "summarize the decisions from last week",
  "e.g. the usual caveats apply",
];
for (const query of NEGATIVE) {
  const tokens = rareTokens(query);
  check(tokens.length === 0, `prose finds no token: "${query.slice(0, 44)}..."`, JSON.stringify(tokens));
}

// ---------------------------------------------------------------------------
// 2. Retrieval behaviour (needs a server)
// ---------------------------------------------------------------------------
let server;
try {
  server = await startLocalServer({ storePath: tmp, port, timeoutMs: 60_000 });
  const store = new Store({ host: "localhost", port });
  const COL = "hybrid_test";

  // Filler documents that dominate vector ranking for the credential topic.
  for (let i = 0; i < 12; i++) {
    await store.addDocument(
      COL,
      `Rotating credentials and secrets: step ${i}. We rotate the service keys, ` +
        `update the environment, and redeploy so the new credentials take effect.`,
      { kind: "filler" },
    );
  }
  // One document containing the identifier but about an unrelated topic, so
  // vector search alone will not surface it for the query below.
  await store.addDocument(
    COL,
    "The alpha_beta_gamma flag toggles the legacy CSV exporter for archived rows.",
    { kind: "needle" },
  );

  const NEEDLE_QUERY =
    "how do we handle alpha_beta_gamma when rotating credentials and secrets";

  // --- vector-only must MISS the identifier document ---
  const pure = await store.query(COL, NEEDLE_QUERY, 3, { hybrid: false });
  const pureHasNeedle = pure.some((r) => r.metadata?.kind === "needle");
  check(!pureHasNeedle, "vector-only search misses the rare-identifier document",
        "this is the failure hybrid exists to fix");

  // --- hybrid must SURFACE it ---
  const hybrid = await store.query(COL, NEEDLE_QUERY, 3);
  const at = hybrid.findIndex((r) => r.metadata?.kind === "needle");
  check(at >= 0, "hybrid surfaces the rare-identifier document", at >= 0 ? `rank #${at + 1}` : "absent");
  check(hybrid.length === 3, "hybrid respects the caller's limit", `${hybrid.length}`);
  check(
    new Set(hybrid.map((r) => r.id)).size === hybrid.length,
    "hybrid results are deduplicated by document id",
  );
  check(
    hybrid.some((r) => r.metadata?.kind === "filler"),
    "vector hits are preserved alongside keyword hits (not replaced by them)",
  );
  check(
    hybrid.every((r) => typeof r.distance === "number"),
    "fused results still carry their vector distance",
  );

  // --- prose queries must be untouched ---
  console.log("");
  for (const prose of [
    "how do we rotate credentials and secrets before a redeploy",
    "what happens to the environment after the keys change",
  ]) {
    check(rareTokens(prose).length === 0, `prose query has no rare token`, `"${prose.slice(0, 40)}..."`);
    const a = await store.query(COL, prose, 5);
    const b = await store.query(COL, prose, 5, { hybrid: false });
    check(
      JSON.stringify(a.map((r) => r.id)) === JSON.stringify(b.map((r) => r.id)),
      "prose query is byte-identical to vector-only",
    );
  }

  // --- a token present in NO document must degrade, not empty out ---
  const ghost = "what about zzz_no_such_symbol_zzz during a rotation";
  check(rareTokens(ghost).includes("zzz_no_such_symbol_zzz"), "ghost token is detected");
  const gh = await store.query(COL, ghost, 5);
  const gp = await store.query(COL, ghost, 5, { hybrid: false });
  check(gh.length > 0, "absent token falls back to vector results rather than returning empty",
        `${gh.length} results`);
  check(
    JSON.stringify(gh.map((r) => r.id)) === JSON.stringify(gp.map((r) => r.id)),
    "absent-token fallback matches vector-only exactly",
  );

  // --- filters still compose with the keyword pass ---
  const filtered = await store.query(COL, NEEDLE_QUERY, 5, { where: { kind: "filler" } });
  check(
    filtered.length > 0 && filtered.every((r) => r.metadata?.kind === "filler"),
    "metadata where clause still applies on the hybrid path",
  );

  console.log(
    failures === 0 ? "\nALL HYBRID TESTS PASSED" : `\n${failures} HYBRID TEST(S) FAILED`,
  );
} finally {
  if (server) await server.stop();
  const { rmRetry } = await import("./_harness.mjs");
  rmRetry(tmp);
}

process.exit(failures === 0 ? 0 : 1);
