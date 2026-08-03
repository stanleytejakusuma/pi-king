import { createJiti } from "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";
// Point at a directory of call logs. A frozen copy is strongly preferred:
// live logs gain entries between two reads, and the resulting off-by-one-call
// deltas look exactly like a real bug. That happened while writing this.
process.env.PI_KING_CALL_LOGS = process.env.PI_KING_CALL_LOGS || process.env.HOME + "/.omniroute/call_logs";
process.env.PI_KING_STATUS_DIR = process.env.PI_KING_STATUS_DIR || "/tmp/pi-king-verify-status";
const jiti = createJiti(import.meta.url, { interopDefault: true });
const d = await jiti.import("/Users/stanz/codebase/pi-king/src/data.ts");
let bad = 0;
const chk = (name, ok, detail="") => { if(!ok) bad++; console.log(`  ${ok?"PASS":"FAIL"}  ${name}${detail?"  "+detail:""}`); };

// 0. ps lstart parsing. This regex decides whether a session is alive; a bug
// in it reports every live session as exited. It broke on single-digit days
// (ps pads the day to two columns: "Mon Aug  3"), which meant it was correct
// for 22 days a month and wrong for 9.
{
  const rx = /^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/;
  const samples = [
    ["  94771 Mon Aug  3 11:34:46 2026 pi", "single-digit day (two spaces)"],
    ["  18749 Fri Jul 31 12:06:14 2026 pi", "two-digit day (one space)"],
    ["      1 Wed Jan  1 00:00:00 2026 pi", "new year, single digit"],
  ];
  for (const [line, label] of samples) {
    const m = rx.exec(line);
    chk(`ps lstart parses: ${label}`, !!m && Number.isFinite(Date.parse(m[2])), m ? m[2] : "NO MATCH");
  }
  // And against this machine's real ps, which must find this very process.
  const { spawnSync } = await import("node:child_process");
  const out = spawnSync("/bin/ps", ["-eo", "pid=,lstart=,command="], { encoding: "utf8" }).stdout || "";
  const parsed = out.split("\n").filter((l) => rx.test(l)).length;
  const total = out.split("\n").filter((l) => l.trim()).length;
  chk("ps lstart parses every real line", parsed === total, `${parsed}/${total}`);
}

// 0b. Unknown status strings must never break a reader. FORMAT.md says the
// status set is additive and readers tolerate unknown values; a session
// running an older writer sent "trust" after that state was retired, and the
// dashboard rendered the literal text "undefined trust" while its missing sort
// priority made the comparator return NaN.
{
  const idx = await jiti.import("/Users/stanz/codebase/pi-king/src/index.ts");
  for (const s of ["working", "idle", "background", "attention", "error", "exited", "trust", "not-a-state", ""]) {
    const icon = idx.iconFor(s);
    chk(`iconFor(${JSON.stringify(s)}) is a real glyph`, typeof icon === "string" && icon.length > 0, icon);
  }
  chk("known states are recognised", ["working","idle","background","attention","error","exited"].every((s) => idx.isKnownState(s)));
  chk("retired/unknown states are not", !idx.isKnownState("trust") && !idx.isKnownState("nope"));
}

// 1. cache round-trip must not change any number
const cold = await d.readDailyTokens();
const warm = await d.readDailyTokens();
chk("cache round-trip identical", JSON.stringify(cold)===JSON.stringify(warm));

chk("every served day is complete", cold.every(x => ["tokensIn","tokensOut","tokensCacheRead","tokensCacheWrite","tokensReasoning","calls"].every(f => typeof x[f] === "number")));
// 2. lifetime totals equal the sum of the per-day rows
const life = await d.readLifetimeStats();
const sumIn = cold.reduce((a,x)=>a+x.tokensIn,0);
const sumCalls = cold.reduce((a,x)=>a+x.calls,0);
chk("lifetime in == sum(days)", life.tokensIn===sumIn, `${life.tokensIn} vs ${sumIn}`);
chk("lifetime calls == sum(days)", life.calls===sumCalls, `${life.calls} vs ${sumCalls}`);

// 3. today's row in the daily series must equal readUsageStats
const s = await d.readUsageStats();
const todayRow = cold[cold.length-1];
chk("today's daily row == usage stats", todayRow.calls===s.calls && todayRow.tokensIn===s.tokensIn,
    `daily(${todayRow.calls},${todayRow.tokensIn}) vs usage(${s.calls},${s.tokensIn})`);

// 3b. today's net tokens
const netToday = Math.max(0, s.tokensIn - s.tokensCacheRead);
chk("today's cacheRead subset of in", s.tokensCacheRead <= s.tokensIn, `${s.tokensCacheRead} <= ${s.tokensIn}`);
chk("today's net = in - cacheRead", netToday === s.tokensIn - s.tokensCacheRead, `${netToday}`);
chk("today's net <= in", netToday <= s.tokensIn);

// 3c. last-hour window is a subset of today
chk("last-hour calls subset of today's", s.lastHour.calls >= 0 && s.lastHour.calls <= s.calls, `${s.lastHour.calls} <= ${s.calls}`);
chk("last-hour tokens subset of today's", s.lastHour.tokensIn >= 0 && s.lastHour.tokensIn <= s.tokensIn, `${s.lastHour.tokensIn} <= ${s.tokensIn}`);

// 3d. per-model and error-taxonomy partitions must sum to their totals
chk("per-model calls partition today", s.perModel.reduce((n,m)=>n+m.calls,0) === s.calls, `${s.perModel.reduce((n,m)=>n+m.calls,0)} === ${s.calls}`);
chk("per-model tokens partition today", s.perModel.reduce((n,m)=>n+m.tokensIn,0) === s.tokensIn);
chk("status-code counts partition errors", s.errorsByStatus.reduce((n,[,c])=>n+c,0) === s.errors, `${s.errorsByStatus.reduce((n,[,c])=>n+c,0)} === ${s.errors}`);
chk("slowest >= p95 sample", !s.slowest || s.durations.length === 0 || s.slowest.duration >= s.durations[s.durations.length-1] || s.slowest.duration === Math.max(...s.durations), `${s.slowest?.duration}`);

// 4. derived percentages
const errPct = (s.errors/s.calls)*100;
const cachePct = Math.round((s.tokensCacheRead/s.tokensIn)*100);
const outPct = (s.tokensOut/s.tokensIn)*100;
chk("cache share within 0..100", cachePct>=0 && cachePct<=100, `${cachePct}%`);
chk("out share plausible (<100)", outPct>0 && outPct<100, `${outPct.toFixed(3)}%`);
chk("error rate matches counts", Math.abs(errPct-(s.errors/s.calls*100))<1e-9, `${errPct.toFixed(2)}%`);

// 5. p95 is nearest-rank and lies inside the sample
const n=s.durations.length, idx=Math.min(n-1,Math.floor(n*0.95)), p95=s.durations[idx];
const below = s.durations.filter(x=>x<=p95).length;
chk("p95 inside sample", p95>=s.durations[0] && p95<=s.durations[n-1]);
chk("p95 covers >=95% of samples", below/n>=0.95, `${(below/n*100).toFixed(1)}% <= p95`);

// 6. model percentages sum sanely
const sum=s.topModels.reduce((a,m)=>a+m.pct,0);
chk("top-3 model shares <= 100", sum<=100, `${sum}%`);

// 7. peakPeriod share consistent
if (s.peakPeriod) chk("busiest share 0..100", s.peakPeriod.pct>=0 && s.peakPeriod.pct<=100, `${s.peakPeriod.pct}%`);

// 8. hourly buckets sum to calls
const hourSum = s.hourly.reduce((a,x)=>a+x,0);
chk("hourly buckets sum == calls", hourSum===s.calls, `${hourSum} vs ${s.calls}`);

// 9. comparison arithmetic, against DISTINCT tokens
const distinct=Math.max(0,life.tokensIn-life.tokensCacheRead)+life.tokensOut;
const total=life.tokensIn+life.tokensOut;
chk("cache reads are a subset of input", life.tokensCacheRead<=life.tokensIn,
    `${life.tokensCacheRead} <= ${life.tokensIn}`);
chk("distinct excludes cache reads", distinct<total || life.tokensCacheRead===0,
    `distinct ${d.compactNum(distinct)} < total ${d.compactNum(total)}`);
chk("lifetime cacheWrite == sum(days)", life.tokensCacheWrite===cold.reduce((a,x)=>a+x.tokensCacheWrite,0));
chk("lifetime reasoning == sum(days)", life.tokensReasoning===cold.reduce((a,x)=>a+x.tokensReasoning,0));
chk("lifetime cacheRead == sum(days)", life.tokensCacheRead===cold.reduce((a,x)=>a+x.tokensCacheRead,0));
const cmp=d.tokenComparison(distinct);
const m=cmp.match(/~([\d,]+)x the text of (.+)/);
const times=Number(m[1].replace(/,/g,""));
const HP=1084170*1.33;
chk("comparison multiple correct", Math.abs(times-Math.round(distinct/HP))<=0, `${times} vs ${Math.round(distinct/HP)}`);

// 10. edge cases
chk("empty comparison for 0 tokens", d.tokenComparison(0)===undefined);
chk("comparison undefined below smallest work", d.tokenComparison(1000)===undefined);
chk("compactNum boundaries", d.compactNum(999)==="999" && d.compactNum(1000)==="1k" && d.compactNum(1e6)==="1.0M" && d.compactNum(1e9)==="1.0B");
chk("sparkline of empty is falsy", !d.sparkline([]));
chk("sparkline of flat series", typeof d.sparkline([5,5,5])==="string");
// A day with no activity must not draw the same mark as a day with a trace of
// it: that day is the one that breaks a streak.
chk("zero renders as a gap", d.sparkline([100,0,100])[1] === " ", JSON.stringify(d.sparkline([100,0,100])));
chk("non-zero never renders as a gap", !d.sparkline([100,1,100]).includes(" "), JSON.stringify(d.sparkline([100,1,100])));
process.exit(bad?1:0);
