/**
 * End-to-end test of the SHELL POLL-COMMAND path (the Codex client-timeout
 * fallback). It mixes the two interfaces exactly as an agent would:
 *   - instant operations via the MCP tools (initialize / request_review / submit_review / signal_complete)
 *   - the long blocking WAIT via the `dist/cli.js` poll commands (next-review / await-verdict),
 *     run as separate shell processes — proving they aren't bound by any MCP per-call timeout.
 *
 * Run with:  npm run build && npm run demo:cli
 */
import { spawn, execFile, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const execFileAsync = promisify(execFile);
const PORT = 8793;
const BASE = `http://127.0.0.1:${PORT}`;
const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

let failures = 0;
function check(label: string, cond: boolean, extra?: unknown): void {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.error(`  ✗ ${label}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  }
}
function git(repo: string, args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
}
async function mcp(path: string, name: string): Promise<Client> {
  const c = new Client({ name, version: "0.0.0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${BASE}${path}`)));
  return c;
}
async function call(c: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const r: any = await c.callTool({ name, arguments: args }, undefined, { timeout: 60_000 });
  return JSON.parse(r?.content?.[0]?.text ?? "{}");
}
/** Run a CLI poll command as a shell process; resolve with its parsed stdout JSON. */
function poll(sub: string): Promise<any> {
  return execFileAsync(process.execPath, [CLI, sub, "--port", String(PORT), "--timeout", "30"]).then(
    ({ stdout }) => JSON.parse(stdout),
  );
}
async function waitForHealth(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) return;
    } catch {}
    await sleep(100);
  }
  throw new Error("server not healthy");
}

async function main(): Promise<void> {
  const repo = mkdtempSync(join(tmpdir(), "auto-review-cli-"));
  let server: ChildProcess | undefined;
  try {
    git(repo, ["init", "-q", "-b", "main"]);
    git(repo, ["config", "user.name", "Demo"]);
    git(repo, ["config", "user.email", "demo@example.com"]);
    writeFileSync(join(repo, "README.md"), "# demo\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "initial"]);
    const head0 = git(repo, ["rev-parse", "HEAD"]).trim();

    // Short poll window so each internal re-poll is quick.
    server = spawn(process.execPath, ["dist/server.js", "--port", String(PORT), "--host", "127.0.0.1", "--poll-seconds", "2"], { stdio: ["ignore", "inherit", "inherit"] });
    await waitForHealth();

    const dev = await mcp("/developer/mcp", "demo-dev");
    const rev = await mcp("/reviewer/mcp", "demo-rev");

    console.log("\n[1] developer init + submit a batch via MCP; let request_review return keep_waiting");
    check("init ok", (await call(dev, "initialize_review_session", { repo_path: repo })).status === "ok");
    check("await-verdict before any batch → no_active_batch", (await poll("await-verdict")).status === "no_active_batch");
    writeFileSync(join(repo, "feature.txt"), "v1\n");
    const rr = await call(dev, "request_review", { summary: "add feature", commit_message: "feat: feature" });
    check("request_review returned keep_waiting (batch is now queued)", rr.status === "keep_waiting", rr);

    console.log("[2] reviewer waits via the SHELL poll command (next-review)");
    const reviewReady = await poll("next-review");
    check("next-review shell command returned review_ready", reviewReady.status === "review_ready", reviewReady);
    check("…with the diff", String(reviewReady.diff).includes("feature.txt"));

    console.log("[3] developer waits for the verdict via the SHELL poll command (await-verdict)");
    const verdictP = poll("await-verdict"); // blocks in a shell process
    await sleep(300);
    const sub1 = await call(rev, "submit_review", { batch_id: reviewReady.batch_id, verdict: "changes_requested", issue: "use v2", category: "code" });
    check("reviewer recorded changes_requested", sub1.status === "recorded");
    const verdict1 = await verdictP;
    check("await-verdict shell command returned changes_requested", verdict1.status === "changes_requested", verdict1);

    console.log("[4] fix → resubmit → approve, all with the shell waiters");
    writeFileSync(join(repo, "feature.txt"), "v2\n");
    const rr2 = await call(dev, "request_review", { summary: "fix", commit_message: "feat: feature v2" });
    check("resubmit keep_waiting", rr2.status === "keep_waiting", rr2);
    const review2 = await poll("next-review");
    check("next-review got the new batch", review2.status === "review_ready" && review2.batch_id !== reviewReady.batch_id, review2);
    const verdict2P = poll("await-verdict");
    await sleep(300);
    await call(rev, "submit_review", { batch_id: review2.batch_id, verdict: "approved" });
    const verdict2 = await verdict2P;
    check("await-verdict returned approved + commit_sha", verdict2.status === "approved" && !!verdict2.commit_sha, verdict2);
    check("commit landed in the repo", git(repo, ["rev-parse", "HEAD"]).trim() === verdict2.commit_sha && verdict2.commit_sha !== head0);

    console.log("[5] signal complete → next-review returns workflow_complete");
    await call(dev, "signal_complete", {});
    const done = await poll("next-review");
    check("next-review → workflow_complete", done.status === "workflow_complete", done);

    await dev.close();
    await rev.close();
  } finally {
    if (server) server.kill("SIGTERM");
    rmSync(repo, { recursive: true, force: true });
  }
  console.log(`\n${failures === 0 ? "ALL CLI CHECKS PASSED ✅" : `${failures} CHECK(S) FAILED ❌`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("cli demo crashed:", e);
  process.exit(1);
});
