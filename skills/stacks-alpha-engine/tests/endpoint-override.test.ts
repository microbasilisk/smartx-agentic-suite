/**
 * Where the engine sends its Stacks reads, and that it can be told somewhere else.
 *
 * Run it from a checkout that has the suite dependencies installed:
 *   bun run skills/stacks-alpha-engine/tests/endpoint-override.test.ts
 * Exit code 0 means every case passed. This file is its own runner, matching its
 * two siblings.
 *
 * ## Why this exists
 *
 * Measured 2026-09-12: one deposit makes 46 requests to Hiro, counted with a
 * tally on every outbound call. Hiro allows 50 a minute without an API key and
 * 500 with one, so a single deposit spends 92% of the anonymous budget before
 * the app has made any of its own reads. The deposit failed by a hair, three
 * times running, deterministically.
 *
 * The quick repair would be to hand this skill a key. The app refuses to, on
 * purpose: its runner gives every skill a scrubbed environment because a skill
 * is somebody else's code and everything it can read it can also print, and it
 * names a credential it deliberately withholds. That rule does not carve out
 * this repo's own skills, and spending it to save an afternoon is how a rule
 * stops meaning anything.
 *
 * So the skill takes an ADDRESS, which is not a credential. Whoever runs it can
 * put an authenticated hop in front of Hiro and keep the key on their own side.
 *
 * ## Why it drives the CLI rather than importing
 *
 * `HIRO_API` is read once when the module loads, so a test that imports the
 * engine and then sets the variable proves nothing: the constant is already
 * fixed. Spawning the real command with the variable set is the only way to see
 * what a real run does, and it also covers the thing that actually matters,
 * which is whether the requests LAND somewhere else rather than whether a
 * constant holds a different string.
 */

const engine = new URL("../stacks-alpha-engine.ts", import.meta.url).pathname;

let passed = 0;
let failed = 0;

async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL  ${name}\n        ${(e as Error).message}`);
  }
}

function ok(cond: boolean, what: string): void {
  if (!cond) throw new Error(what);
}

/**
 * A stand-in for the Stacks API that records what it was asked for.
 *
 * It answers everything with a shape the engine can parse but no useful content,
 * because the point is WHERE the requests went, not what came back. The run is
 * expected to fail on the content; that failure is not what is asserted.
 */
function stubChain() {
  const hits: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      hits.push(url.pathname);
      if (url.pathname.includes("/call-read/")) {
        return Response.json({ okay: true, result: "0x0700000000000000000000000000000000" });
      }
      if (url.pathname.endsWith("/v2/fees/transfer")) return Response.json(400);
      return Response.json({});
    },
  });
  return { hits, server, base: `http://127.0.0.1:${server.port}` };
}

async function runEngine(args: string[], env: Record<string, string>): Promise<void> {
  const p = Bun.spawn(["bun", "run", engine, ...args], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  // The exit code is deliberately not asserted. A stub chain returns nothing
  // real, so the engine is entitled to refuse; what is under test is the
  // destination of its reads.
  await Promise.race([
    p.exited,
    new Promise((r) => setTimeout(r, 60_000)),
  ]);
  try { p.kill(); } catch { /* already gone */ }
}

console.log("\nBF the Stacks endpoint");

await check("with HIRO_API set, the reads go THERE and not to Hiro", async () => {
  const stub = stubChain();
  try {
    await runEngine(["doctor"], { HIRO_API: stub.base });
    ok(stub.hits.length > 0, "the stub received nothing, so the override did not take effect");
    // Not just "something arrived": the paths must be the engine's own Stacks
    // reads, so a stray health probe cannot pass this.
    const stacksish = stub.hits.filter((h) => h.startsWith("/v2/") || h.startsWith("/extended/"));
    ok(stacksish.length > 0, `nothing that looks like a Stacks read: ${stub.hits.slice(0, 5).join(", ")}`);
  } finally {
    stub.server.stop(true);
  }
});

await check("the override does not leak into the other three hosts", async () => {
  // Bitflow, Tenero and mempool.space have their own limits and their own
  // addresses. Redirecting Stacks reads must not redirect theirs, or a stub
  // would silently swallow a price and the engine would refuse for the wrong
  // reason.
  const stub = stubChain();
  try {
    await runEngine(["doctor"], { HIRO_API: stub.base });
    const foreign = stub.hits.filter((h) =>
      h.includes("/api/app/v1/pools") || h.includes("/v1/stacks/tokens") || h.includes("/v1/fees/recommended"));
    ok(foreign.length === 0, `the stub received another host's paths: ${foreign.join(", ")}`);
  } finally {
    stub.server.stop(true);
  }
});

await check("unset, it still points at the public Stacks API", async () => {
  // The default has to be exactly what it always was, or every caller that sets
  // nothing changes behaviour on upgrade. Read from the source rather than run,
  // because proving a negative over the network is slow and flaky.
  const src = await Bun.file(engine).text();
  ok(
    src.includes('process.env.HIRO_API || "https://api.mainnet.hiro.so"'),
    "the default is no longer the public host",
  );
  // And nothing may reach Hiro around the constant.
  const strays = src.split("\n").filter((l) => l.includes("hiro.so") && !l.includes("process.env.HIRO_API"));
  ok(strays.length === 0, `a Stacks URL bypasses the constant: ${strays.join(" | ")}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
