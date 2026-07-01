/**
 * End-to-end test of PARALLEL review loops: one coordinator, two repos, two
 * developer/reviewer pairs running through the full cycle at the same time.
 *
 * Each pair binds to its loop via ?repo= on the endpoint URL (as the stdio
 * proxy does). Asserts full isolation: each reviewer only sees its own repo's
 * batches, verdicts and commits land in the right repo, one loop completing
 * does not disturb the other, and unbound sessions get actionable guidance
 * when several loops are active.
 *
 * Run with:  npm run build && npm run demo:parallel
 */
import { spawn, type ChildProcess, execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const PORT = 8797;
const BASE = `http://127.0.0.1:${PORT}`;
const CALL_TIMEOUT = 60_000;

let failures = 0;
function check(label: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.error(`  ✗ ${label}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  }
}

function git(repo: string, args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
}

function makeRepo(prefix: string): string {
  const repo = mkdtempSync(join(tmpdir(), prefix));
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.name", "Demo"]);
  git(repo, ["config", "user.email", "demo@example.com"]);
  writeFileSync(join(repo, "README.md"), "# demo\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "initial"]);
  return repo;
}

async function connect(path: string, name: string, repo?: string): Promise<Client> {
  const client = new Client({ name, version: "0.0.0" });
  const url = `${BASE}${path}${repo ? `?repo=${encodeURIComponent(repo)}` : ""}`;
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const res: any = await client.callTool({ name, arguments: args }, undefined, {
    timeout: CALL_TIMEOUT,
  });
  return JSON.parse(res?.content?.[0]?.text ?? "{}");
}

async function waitForHealth(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(100);
  }
  throw new Error("server did not become healthy in time");
}

async function main(): Promise<void> {
  const repoA = makeRepo("auto-review-par-a-");
  const repoB = makeRepo("auto-review-par-b-");
  const keyA = realpathSync(repoA);
  const keyB = realpathSync(repoB);
  let server: ChildProcess | undefined;
  try {
    server = spawn(
      process.execPath,
      ["dist/server.js", "--port", String(PORT), "--host", "127.0.0.1", "--poll-seconds", "2"],
      { stdio: ["ignore", "inherit", "inherit"] },
    );
    await waitForHealth();

    console.log("\n[1] two developer/reviewer pairs attach, each bound via ?repo=");
    const devA = await connect("/developer/mcp", "dev-a", repoA);
    const devB = await connect("/developer/mcp", "dev-b", repoB);
    const revA = await connect("/reviewer/mcp", "rev-a", repoA);
    const revB = await connect("/reviewer/mcp", "rev-b", repoB);

    const health = await (await fetch(`${BASE}/healthz`)).json();
    check(
      "healthz lists both loops",
      Array.isArray(health.loops) &&
        health.loops.length === 2 &&
        [keyA, keyB].every((k) => health.loops.some((l: any) => l.repo === k)),
      health.loops,
    );

    console.log("[2] both developers submit batches concurrently");
    writeFileSync(join(repoA, "alpha.txt"), "alpha v1\n");
    writeFileSync(join(repoB, "beta.txt"), "beta v1\n");
    const devAP1 = call(devA, "request_review", {
      summary: "Add alpha.txt.",
      commit_message: "feat: alpha",
    });
    const devBP1 = call(devB, "request_review", {
      summary: "Add beta.txt.",
      commit_message: "feat: beta",
    });

    console.log("[3] each reviewer receives only its own repo's batch");
    const ra = await call(revA, "get_next_review");
    const rb = await call(revB, "get_next_review");
    check("reviewer A got A's batch", ra.status === "review_ready" && ra.repo === keyA, ra);
    check(
      "A's diff has alpha.txt and not beta.txt",
      String(ra.diff).includes("alpha.txt") && !String(ra.diff).includes("beta.txt"),
      ra.diff_stat,
    );
    check("reviewer B got B's batch", rb.status === "review_ready" && rb.repo === keyB, rb);
    check(
      "B's diff has beta.txt and not alpha.txt",
      String(rb.diff).includes("beta.txt") && !String(rb.diff).includes("alpha.txt"),
      rb.diff_stat,
    );

    console.log("[4] interleaved verdicts: approve B while A gets changes requested");
    const subB = await call(revB, "submit_review", { batch_id: rb.batch_id, verdict: "approved" });
    check("B approved + committed", subB.status === "recorded" && !!subB.commit_sha, subB);
    const subA = await call(revA, "submit_review", {
      batch_id: ra.batch_id,
      verdict: "changes_requested",
      issue: "alpha.txt should say 'alpha v2'.",
      category: "code",
    });
    check("A changes requested", subA.status === "recorded", subA);

    const drB1 = await devBP1;
    check("developer B unblocked with approved", drB1.status === "approved", drB1);
    const drA1 = await devAP1;
    check("developer A unblocked with changes_requested", drA1.status === "changes_requested", drA1);

    check(
      "commit landed in B only",
      git(repoB, ["rev-parse", "HEAD"]).trim() === drB1.commit_sha &&
        git(repoA, ["log", "--oneline"]).trim().split("\n").length === 1,
    );

    console.log("[5] A fixes and gets approved; loops stay independent");
    writeFileSync(join(repoA, "alpha.txt"), "alpha v2\n");
    const devAP2 = call(devA, "request_review", {
      summary: "Address review: alpha v2.",
      commit_message: "feat: alpha (v2)",
    });
    const ra2 = await call(revA, "get_next_review");
    check("reviewer A got the fixed batch", ra2.status === "review_ready" && String(ra2.diff).includes("alpha v2"), ra2.status);
    await call(revA, "submit_review", { batch_id: ra2.batch_id, verdict: "approved" });
    const drA2 = await devAP2;
    check("developer A approved", drA2.status === "approved" && git(repoA, ["rev-parse", "HEAD"]).trim() === drA2.commit_sha, drA2);

    console.log("[6] A completes; B's loop is untouched");
    await call(devA, "signal_complete", { note: "A done" });
    const lastA = await call(revA, "get_next_review");
    check("reviewer A gets workflow_complete", lastA.status === "workflow_complete", lastA);
    const idleB = await call(revB, "get_next_review");
    check("reviewer B keeps waiting (not workflow_complete)", idleB.status === "keep_waiting", idleB);

    console.log("[7] unbound sessions get guidance while several loops are active");
    const unbound = await connect("/developer/mcp", "dev-unbound");
    const amb = await call(unbound, "request_review", { summary: "x", commit_message: "x" });
    check("unbound request_review → not_initialized", amb.status === "not_initialized", amb);
    const unboundReviewer = await connect("/reviewer/mcp", "rev-unbound");
    const ambSubmit = await call(unboundReviewer, "submit_review", {
      batch_id: "batch-1",
      verdict: "approved",
    });
    check("unbound submit_review → not_initialized", ambSubmit.status === "not_initialized", ambSubmit);
    const overview = await call(unbound, "workflow_status");
    check("unbound workflow_status → all loops", Array.isArray(overview.loops) && overview.loops.length === 2, overview);
    const bindB = await call(unbound, "initialize_review_session", { repo_path: repoB });
    check("initialize_review_session binds to B", bindB.status === "ok" && bindB.repo === keyB, bindB);
    const boundStatus = await call(unbound, "workflow_status");
    check("bound workflow_status → B's loop only", boundStatus.repo === keyB, boundStatus);

    await Promise.all([devA, devB, revA, revB, unbound, unboundReviewer].map((c) => c.close()));
  } finally {
    if (server) server.kill("SIGTERM");
    rmSync(repoA, { recursive: true, force: true });
    rmSync(repoB, { recursive: true, force: true });
  }

  console.log(`\n${failures === 0 ? "ALL PARALLEL CHECKS PASSED ✅" : `${failures} CHECK(S) FAILED ❌`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("parallel demo crashed:", err);
  process.exit(1);
});
