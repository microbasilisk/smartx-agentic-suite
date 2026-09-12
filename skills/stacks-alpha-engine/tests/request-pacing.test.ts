/**
 * Asking upstream without shutting ourselves out.
 *
 * Run it from a checkout that has the suite dependencies installed:
 *   bun run skills/stacks-alpha-engine/tests/request-pacing.test.ts
 * Exit code 0 means every case passed. There is no runner in this repo yet, so
 * this file is its own runner, matching `deploy-guards.test.ts`.
 *
 * ## What went wrong, measured 2026-09-12
 *
 * A 10 USDh deposit into Hermetica was refused three times running. Each time
 * the sBTC reserve check came back DATA_UNAVAILABLE on an HTTP 429 from Hiro,
 * with the slippage and gas gates failing beside it, and the engine's rule turns
 * an unreadable safety check into a refusal.
 *
 * Hiro was not throttling the machine. Direct calls answered 200 throughout and
 * the limit header read 20 a second with 18 remaining. The engine was shutting
 * itself out: it fans out across four protocols at once, each of those fans out
 * again, and one question becomes twenty-odd reads in the same instant.
 *
 * ## The property that matters most is the one about failure
 *
 * The file header records an audit where a 429 rendered a wallet holding $3.93
 * as "Wallet Total $0". That was fixed at the display, so a failed read now
 * renders UNKNOWN rather than zero, and the distinction rests entirely on the
 * read THROWING. A retry that swallowed a failure and returned something
 * plausible would put that defect back in the worst possible place.
 *
 * So the cases below are weighted toward what must still fail: a 404 must not be
 * retried, our own timeout must not be retried, and an exhausted retry must
 * throw rather than return.
 */
import { resetRequestPacing, retryWaitMs } from "../stacks-alpha-engine.ts";

let passed = 0;
let failed = 0;

function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  PASS  ${name}`); })
    .catch((e) => { failed++; console.log(`  FAIL  ${name}\n        ${(e as Error).message}`); });
}

function eq(actual: unknown, expected: unknown, what: string): void {
  if (actual !== expected) throw new Error(`${what}: expected ${String(expected)}, got ${String(actual)}`);
}

function ok(cond: boolean, what: string): void {
  if (!cond) throw new Error(what);
}

// == how long to wait ==========================================================

console.log("\nBF retryWaitMs");

await check("it backs off further on each attempt", () => {
  // No jitter, so the shape is readable: 400, 800, 1600.
  eq(retryWaitMs(1, null, 0), 400, "attempt 1");
  eq(retryWaitMs(2, null, 0), 800, "attempt 2");
  eq(retryWaitMs(3, null, 0), 1600, "attempt 3");
});

await check("the server's own Retry-After wins over our guess", () => {
  // It knows when its window resets and we do not.
  eq(retryWaitMs(1, "2", 0), 2000, "two seconds honoured");
  eq(retryWaitMs(3, "1", 0), 1000, "honoured even when our backoff would be longer");
});

await check("an absurd Retry-After refuses outright rather than capping", () => {
  // A review's call, and the better one. Silently capping at 4s then asking
  // twice more spends 8 seconds of a person's request to reach the same
  // refusal, later and with a vaguer reason. Null means stop now.
  eq(retryWaitMs(1, "120", 0), null, "two minutes: refuse");
  eq(retryWaitMs(1, "5", 0), null, "just over the ceiling: refuse");
  eq(retryWaitMs(1, "4", 0), 4000, "exactly the ceiling is still honoured");
});

await check("a nonsense Retry-After falls back to the backoff", () => {
  // Some servers send an HTTP date here rather than seconds, and some send junk.
  eq(retryWaitMs(2, "Wed, 21 Oct 2026 07:28:00 GMT", 0), 800, "unparseable");
  eq(retryWaitMs(2, "", 0), 800, "empty");
  eq(retryWaitMs(2, "-5", 0), 800, "negative");
});

await check("jitter is added, so gates that failed together do not return together", () => {
  // Four protocol gates fail in the same instant. Without jitter all four come
  // back in the same instant too, and reproduce the burst that caused this.
  eq(retryWaitMs(1, null, 0), 400, "no jitter");
  eq(retryWaitMs(1, null, 0.99), 499, "full jitter");
  // An exact figure, not a comparison. The comparison was the one caller in this
  // file that ignored the new `number | null` return: strict tsc rejects it, and
  // it asserted less besides. Review round two's note.
  eq(retryWaitMs(1, null, 0.5), 450, "half jitter");
});

await check("jitter never applies to a Retry-After the server asked for", () => {
  // Adding to a figure the server chose would overshoot its window for no gain.
  eq(retryWaitMs(1, "2", 0.99), 2000, "server figure is used exactly");
});

// == the pacing itself =========================================================

console.log("\nBF request pacing");

/**
 * Drives the real `fetchJson` through a stubbed `fetch`, which is the only way
 * to see the pacing and the retries. `resetRequestPacing` clears the clock the
 * module holds between cases.
 */
async function drive(
  handler: (url: string, call: number, init?: RequestInit) => Response | Promise<Response> | never,
  timeoutMs?: number,
): Promise<{ starts: number[]; calls: number; error: Error | null; body: unknown }> {
  const realFetch = globalThis.fetch;
  const starts: number[] = [];
  let calls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    starts.push(Date.now());
    calls++;
    return handler(String(input), calls, init);
  }) as unknown as typeof fetch;
  resetRequestPacing(timeoutMs);
  try {
    // `fetchJson` is not exported: it is reached through a caller that uses it.
    // `checkGuardian`'s live reads are the smallest door, but they carry their
    // own shape, so the request goes through the module's own fee reader.
    const mod = await import("../stacks-alpha-engine.ts");
    const body = await mod.liveGuardianReads.fetchFeeRate();
    return { starts, calls, error: null, body };
  } catch (e) {
    return { starts, calls, error: e as Error, body: null };
  } finally {
    globalThis.fetch = realFetch;
  }
}

const okJson = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
const status = (code: number, headers: Record<string, string> = {}) =>
  new Response("upstream said no", { status: code, headers });

await check("a request that succeeds first time is returned, and asked once", async () => {
  const r = await drive(() => okJson(1234));
  eq(r.error, null, "no error");
  eq(r.calls, 1, "asked once");
  eq(r.body, 1234, "the body came back");
});

await check("a 429 is asked again, and the second answer is used", async () => {
  // The measured failure. Before this change the first 429 threw and the gate
  // read DATA_UNAVAILABLE, which refuses the deposit.
  const r = await drive((_u, call) => (call === 1 ? status(429, { "retry-after": "0" }) : okJson(99)));
  eq(r.error, null, "recovered");
  eq(r.calls, 2, "asked twice");
  eq(r.body, 99, "the second answer is the one used");
});

await check("a 429 every time throws after the attempt limit, and does NOT return", async () => {
  // The property the whole file exists for. A caller wraps this in
  // `.catch(() => null)` and renders UNKNOWN. Returning anything here would
  // render a figure instead, which is how a real wallet was once shown as empty.
  const r = await drive(() => status(429, { "retry-after": "0" }));
  ok(r.error !== null, "it threw");
  ok(r.error!.message.includes("429"), `the reason names the status: ${r.error?.message}`);
  eq(r.calls, 3, "three attempts, not more");
  eq(r.body, null, "nothing was returned");
});

await check("the backoff is actually WAITED between attempts", async () => {
  // BLOCKER from review, and the sharpest finding on this change. Every retry
  // case here sent `retry-after: 0`, so deleting BOTH sleeps in fetchJson left
  // the suite green: a 429 would then be retried three times inside 210ms,
  // which is a smaller version of the burst this whole change exists to stop.
  // The pure retryWaitMs was tested; the WIRING from fetchJson into it was not.
  const r = await drive((_u, call) => (call === 1 ? status(429) : okJson(5)));
  eq(r.error, null, "recovered");
  eq(r.calls, 2, "asked twice");
  const gap = r.starts[1]! - r.starts[0]!;
  // First backoff is 400ms plus up to 100ms jitter, so 400 to 499. The 70ms slot
  // gap is ABSORBED, not added: the next slot was claimed 70ms after the first
  // start and the backoff already passes it. Measured 415 to 480.
  ok(gap >= 300, `waited ${gap}ms between attempts, expected the backoff`);
});

await check("the server's own Retry-After is waited, not just parsed", async () => {
  // The second surviving mutation: replacing the header read with null left the
  // suite green, so "the server's figure wins" was proved for the helper and
  // never for the request path.
  const r = await drive((_u, call) => (call === 1 ? status(429, { "retry-after": "1" }) : okJson(6)));
  eq(r.error, null, "recovered");
  const gap = r.starts[1]! - r.starts[0]!;
  ok(gap >= 900, `waited ${gap}ms, expected the server's one second`);
});

await check("a Retry-After longer than we can spend refuses at once", async () => {
  const r = await drive(() => status(429, { "retry-after": "120" }));
  ok(r.error !== null, "it threw");
  ok(r.error!.message.includes("120"), `the reason carries the server's figure: ${r.error?.message}`);
  eq(r.calls, 1, "did not ask again");
});

await check("a 404 is NOT retried: the request was wrong and will stay wrong", async () => {
  const r = await drive(() => status(404));
  ok(r.error !== null, "it threw");
  eq(r.calls, 1, "asked once only");
});

await check("a 400 is NOT retried either, and still fails", async () => {
  // The error assertion was missing, so a 400 swallowed into a body would have
  // passed this. Review's note.
  const r = await drive(() => status(400));
  ok(r.error !== null, "it threw");
  eq(r.calls, 1, "asked once only");
});

await check("a 503 IS retried, being transient by definition", async () => {
  const r = await drive((_u, call) => (call === 1 ? status(503) : okJson(7)));
  eq(r.error, null, "recovered");
  eq(r.calls, 2, "asked twice");
});

await check("a REAL timeout is not retried: the engine's own controller fires", async () => {
  // BLOCKER from review. The case below throws a lookalike error without any
  // controller aborting, so it only ever exercised the error NAME. The branch
  // that fires on an actual 30 second timeout had no test at all, and the test's
  // name claimed otherwise. This one hands the stub the real signal, hangs, and
  // lets the engine's own timer abort it. 40ms instead of 30s via the seam.
  const t0 = Date.now();
  const r = await drive(
    (_u, _call, init) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      ok(signal !== undefined && signal !== null, "the engine passed its signal down");
      signal!.addEventListener("abort", () => {
        const e = new Error("The operation was aborted.");
        e.name = "AbortError";
        reject(e);
      });
    }),
    40,
  );
  ok(r.error !== null, "it threw");
  eq(r.calls, 1, "asked once only, the timeout is not retried");
  // The elapsed check pins the SEAM, not just the branch. Round two pointed the
  // timer back at the 30 second constant and this suite did not go red, it went
  // slow: the branch still fires, just half a minute later. A future edit that
  // reconnects it should fail here rather than turn the suite into a stall.
  const took = Date.now() - t0;
  ok(took < 2000, `took ${took}ms, so the 40ms seam was not in use`);
});

await check("an abort arriving without our controller is not retried either", async () => {
  // The other half. The signal check alone would miss an abort raised any other
  // way, so the name is checked too. Deleting either half leaves one of these
  // two cases failing.
  const r = await drive(() => { const e = new Error("The operation was aborted."); e.name = "AbortError"; throw e; });
  ok(r.error !== null, "it threw");
  eq(r.calls, 1, "asked once only");
});

await check("a network error IS retried, and the backoff is waited before it is", async () => {
  // A surviving mutation: deleting the sleep on the CATCH path left the suite
  // green, because every network-error case here only counted calls. A dropped
  // connection would then be retried three times inside 210ms, which is the
  // burst again, arriving by the other door.
  const r = await drive((_u, call) => {
    if (call === 1) throw new TypeError("fetch failed");
    return okJson(11);
  });
  eq(r.error, null, "recovered");
  eq(r.calls, 2, "asked twice");
  const gap = r.starts[1]! - r.starts[0]!;
  ok(gap >= 300, `waited ${gap}ms after the network error, expected the backoff`);
});

await check("an aborted request is not retried even when the error is not named AbortError", async () => {
  // The other surviving mutation: dropping `controller.signal.aborted` left the
  // suite green, because Bun happens to name its abort rejection AbortError, so
  // the name half caught every case. A runtime that rejects with anything else
  // on abort would then retry a timeout three times. This aborts for real and
  // rejects with a plain Error, so ONLY the signal half can catch it.
  const t0 = Date.now();
  const r = await drive(
    (_u, _call, init) => new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(new Error("socket closed by us")));
    }),
    40,
  );
  ok(r.error !== null, "it threw");
  eq(r.calls, 1, "asked once only");
  const took = Date.now() - t0;
  ok(took < 2000, `took ${took}ms, so the 40ms seam was not in use`);
});

await check("requests are spaced apart rather than fired together", async () => {
  // The cause. Four protocols fanning out at once put twenty-odd reads into the
  // same instant against a limit of twenty a second.
  const realFetch = globalThis.fetch;
  const starts: number[] = [];
  globalThis.fetch = (async () => { starts.push(Date.now()); return okJson(1); }) as typeof fetch;
  resetRequestPacing();
  try {
    const mod = await import("../stacks-alpha-engine.ts");
    await Promise.all([
      mod.liveGuardianReads.fetchFeeRate(),
      mod.liveGuardianReads.fetchFeeRate(),
      mod.liveGuardianReads.fetchFeeRate(),
      mod.liveGuardianReads.fetchFeeRate(),
    ]);
  } finally {
    globalThis.fetch = realFetch;
  }
  eq(starts.length, 4, "all four ran");
  const span = starts[starts.length - 1]! - starts[0]!;
  // Four at 70ms apart is 210ms between first and last. Asserting "more than
  // 150" rather than an exact figure, because a loaded machine drifts, while
  // firing them together would be single digit milliseconds.
  ok(span >= 150, `four requests spanned ${span}ms, expected them spaced out`);
});

await check("pacing does not reorder or lose anybody", async () => {
  const realFetch = globalThis.fetch;
  let n = 0;
  globalThis.fetch = (async () => okJson(++n)) as typeof fetch;
  resetRequestPacing();
  try {
    const mod = await import("../stacks-alpha-engine.ts");
    const out = await Promise.all([
      mod.liveGuardianReads.fetchFeeRate(),
      mod.liveGuardianReads.fetchFeeRate(),
      mod.liveGuardianReads.fetchFeeRate(),
    ]);
    // Deep equality, not just non-null. The old version asserted neither order
    // nor identity, so its name was a claim the assertions did not make.
    eq(JSON.stringify(out), JSON.stringify([1, 2, 3]), "each caller got its own answer, in order");
  } finally {
    globalThis.fetch = realFetch;
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
