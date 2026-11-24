// unit checks: the conservative ruling rules and the TDX quote reader
import path from "node:path"; import { fileURLToPath } from "node:url";
const d = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/phala/judge/src");
const { decide } = await import(d + "/ruling.js"), { readQuote } = await import(d + "/quote.js"), { simTee } = await import(d + "/tee.js");
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exit(1); } console.log("ok  ", m); };
const R = (side, clientBps, slash = false) => ({ side, clientBps, slash, reasons: [], model: "m", receipt: "r" });
const cap = 50n;
ok(decide(null, R("client", 10000, true), cap).clientBps === 5000, "a failed model → 50/50, no slash");
ok(decide(R("agent", 0), R("client", 9000, true), cap).clientBps === 5000, "disagreement → 50/50");
ok(decide(R("agent", 0), R("agent", 0), cap).clientBps === 0, "both agent → agent paid in full");
const c = decide(R("client", 9000, true), R("client", 7000, false), cap);
ok(c.clientBps === 7000 && c.slashAmount === 0n, "both client → lower refund; slash only if both ask");
ok(decide(R("client", 5000, true), R("client", 5000, true), cap).clientBps === 5100, "client win is always > 50% (deposit goes back)");
ok(decide(R("client", 10000, true), R("client", 10000, true), cap).slashAmount === cap, "slash never above the cap");
const t = simTee("x", "{}"), rd = new Uint8Array(64).fill(7), q = await t.getQuote(rd);
const f = readQuote(q.quote);
ok(f.version === 4 && f.teeType === 0x81 && f.reportData === "07".repeat(64), "quote reader finds report_data at the TDX v4 offset");
let threw = false; try { readQuote("00".repeat(700)); } catch { threw = true; }
ok(threw, "non-TDX quote rejected");
console.log("\nALL GOOD");
