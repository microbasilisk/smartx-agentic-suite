/**
 * Where the yield scout sends its Stacks reads, and that it can be told somewhere else.
 *
 * Run: bun test skills/zbg-yield-scout/tests/endpoint-override.test.ts
 *
 * SmartX runs this scout to put pool and Zest positions in a wallet's total. One scan is 24 to 42 Hiro reads, and
 * anonymous Hiro allows 50 a minute, shared with the app's own reads, so the scout must use the hop the app hands
 * it (`HIRO_API`). Drives the real CLI: the constant is fixed when the module loads, so importing proves nothing.
 */

import { describe, expect, test } from "bun:test";

const scout = new URL("../zbg-yield-scout.ts", import.meta.url).pathname;
const WALLET = "SP2RGCKAQH0ZZD0WEVB38H128DZ1M2S5V3ST871NF";

function stubChain() {
  const hits: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      hits.push(url.pathname);
      if (url.pathname.includes("/call-read/")) return Response.json({ okay: true, result: "0x0700000000000000000000000000000000" });
      return Response.json({});
    },
  });
  return { hits, server, base: `http://127.0.0.1:${server.port}` };
}

async function runScout(env: Record<string, string>): Promise<void> {
  // Tenero and Bitflow are still the real hosts; only where the Stacks reads land is under test.
  const p = Bun.spawn(["bun", "run", scout, "run", "--wallet", WALLET], { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  await Promise.race([p.exited, new Promise((r) => setTimeout(r, 60_000))]);
  try { p.kill(); } catch { /* already gone */ }
}

describe("the Stacks endpoint", () => {
  test("with HIRO_API set, the Stacks reads go there", async () => {
    const stub = stubChain();
    try {
      await runScout({ HIRO_API: stub.base });
      const stacksish = stub.hits.filter((h) => h.startsWith("/v2/") || h.startsWith("/extended/"));
      expect(stacksish.length).toBeGreaterThan(0);
      // The wallet's balances and at least one contract read, not a stray probe.
      expect(stub.hits.some((h) => h.includes(`/extended/v1/address/${WALLET}/balances`))).toBe(true);
      expect(stub.hits.some((h) => h.includes("/v2/contracts/call-read/"))).toBe(true);
    } finally {
      stub.server.stop(true);
    }
  }, 90_000);

  test("the override does not take the other hosts' reads", async () => {
    const stub = stubChain();
    try {
      await runScout({ HIRO_API: stub.base });
      expect(stub.hits.filter((h) => h.includes("/v1/stacks/tokens") || h.includes("/api/app/v1/pools"))).toEqual([]);
    } finally {
      stub.server.stop(true);
    }
  }, 90_000);

  test("unset, it is the public host, and nothing reaches Hiro around the constant", async () => {
    const src = await Bun.file(scout).text();
    expect(src).toContain('process.env.HIRO_API || "https://api.mainnet.hiro.so"');
    const strays = src.split("\n").filter((l) => l.includes("hiro.so") && !l.includes("process.env.HIRO_API"));
    expect(strays).toEqual([]);
  });
});
