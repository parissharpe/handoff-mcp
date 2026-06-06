/**
 * handoff-mcp demo seed — for the README demo GIF.
 *
 * Starts the MCP server against a throwaway store, seeds 3 mock Cowork outputs
 * and 3 mock Code outputs (as the watchers would), then calls the real MCP tools
 * — culminating in get_cross_product_brief — to show context surfacing across
 * both products without copy-paste.
 *
 * Run after `npm run build`:  node demo/seed.mjs   (or: npm run demo)
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { spawnMcp, gracefulStop, rmRetry, ROOT } from "../scripts/_harness.mjs";

const storePath = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-demo-"));
const PORT = "8090";
const env = { ...process.env, HANDOFF_STORE_PATH: storePath, CHROMA_PORT: PORT, CHROMA_HOST: "localhost" };

const COWORK_DOCS = [
  "Cowork: drafted the SkyVoyance prior-art memo — three QueueVoyance references need attorney review before the filing deadline.",
  "Cowork: built the CLT strategic-performance one-pager and the Airtable rollup for the quarterly review.",
  "Cowork: wrote the Oreb.AI pitch narrative and the demo script for the investor call.",
];
const CODE_DOCS = [
  "Code: implemented the USPTO docket-monitoring script and wired it to the SkyVoyance tracking sheet.",
  "Code: shipped the Airtable sync job feeding the CLT performance dashboard.",
  "Code: built the Oreb.AI onboarding API and the Stripe webhook handler.",
];

function bullet(items) {
  return items.length
    ? items.map((r) => `    - ${(r.content || "").slice(0, 90)}${(r.content || "").length > 90 ? "…" : ""}`).join("\n")
    : "    (none)";
}

async function main() {
  const mcp = spawnMcp(env);
  await mcp.init("demo");
  // First call boots the shared Chroma server (and writes server.json).
  await mcp.callTool("get_recent_cowork_context", { limit: 1 });

  // Seed both collections via a direct Store connection to the same server,
  // exactly as the cowork/code watchers would over HTTP.
  const { Store } = await import(pathToFileURL(path.join(ROOT, "dist", "store.js")).href);
  const store = new Store({ host: "localhost", port: Number(PORT) });
  for (const [i, text] of COWORK_DOCS.entries()) {
    await store.addDocument("cowork_sessions", text, { source: "cowork", type: "cowork", filename: `cowork-${i + 1}.md` });
  }
  for (const [i, text] of CODE_DOCS.entries()) {
    await store.addDocument("code_sessions", text, { source: "code", type: "code", repo: "demo-project", filename: `code-${i + 1}.md` });
  }

  console.log("\n================= handoff demo =================\n");

  const cowork = (await mcp.callTool("get_recent_cowork_context", { limit: 3 })).parsed;
  console.log("get_recent_cowork_context (last 3):\n" + bullet(cowork.items.map((x) => ({ content: x.content }))));

  const code = (await mcp.callTool("get_recent_code_context", { limit: 3, repo: "demo-project" })).parsed;
  console.log("\nget_recent_code_context (repo=demo-project):\n" + bullet(code.items.map((x) => ({ content: x.content }))));

  const finding = await mcp.callTool("write_strategist_finding", {
    finding: "SkyVoyance patent work spans Cowork (prior-art memo) and Code (USPTO docket script) — keep claim language and tracking in sync.",
    tags: ["synthesis", "skyvoyance"],
  });
  console.log(`\nwrite_strategist_finding -> ${finding.parsed.status} (id ${finding.parsed.id.slice(0, 8)}…)`);

  const brief = (await mcp.callTool("get_cross_product_brief", { topic: "SkyVoyance patent sprint" })).parsed;
  console.log("\nget_cross_product_brief(topic='SkyVoyance patent sprint'):");
  console.log("  cowork_sessions:\n" + bullet(brief.sources.cowork_sessions));
  console.log("  code_sessions:\n" + bullet(brief.sources.code_sessions));
  console.log("  strategist_memory:\n" + bullet(brief.sources.strategist_memory));
  console.log(`\n  totals: ${JSON.stringify(brief.totals)}`);
  console.log("\n===============================================\n");

  await gracefulStop(mcp.proc);
}

main()
  .then(() => { rmRetry(storePath); process.exit(0); })
  .catch((err) => { console.error("DEMO ERROR:", err); rmRetry(storePath); process.exit(1); });
