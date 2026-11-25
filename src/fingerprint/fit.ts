// Phase 2: fit the crowd's model, check calibration, backtest, and save the
// fingerprint that the paper trader uses. Run with "npm start -- fit".

import { existsSync, readFileSync, writeFileSync } from "node:fs";

import {
  FINGERPRINT_FILE,
  FIT_DAYS,
  NO_TRADE_FIRST_SECONDS,
  PAPER_TRADES_FILE,
  PHASE1_MIN_WINDOWS,
  PHASE3_MIN_SIGNALS,
  RECORD_FILE,
  TWAP_WINDOW_SECONDS,
} from "../config.js";
import {
  backfillOutcomes,
  buildSnapshots,
  isSkippedWindow,
  readOutcomes,
  readRecorderRows,
  type Snapshot,
} from "./data.js";
import {
  evaluateSignal,
  fitPowerModel,
  judgeFit,
  trueProbabilityUp,
  type BucketFit,
  type FitPoint,
  type Fingerprint,
} from "./model.js";

const DAY_MS = 24 * 60 * 60 * 1000;

// ========================================
// FIT
// ========================================

function pTrueOf(snapshot: Snapshot, b: number, s: number): number {
  return trueProbabilityUp(snapshot.d, snapshot.varianceEff, b, s);
}

// Fits the crowd (market prices) and the truth (our P_true) with the same
// model, separately for early (τ > 60 s) and late (τ ≤ 60 s) snapshots.
function fitBuckets(
  snapshots: Snapshot[],
  b: number,
  s: number,
): { early: BucketFit; late: BucketFit } {
  const points = {
    early: { crowd: [] as FitPoint[], truth: [] as FitPoint[] },
    late: { crowd: [] as FitPoint[], truth: [] as FitPoint[] },
  };

  for (const snapshot of snapshots) {
    const bucket = snapshot.secondsLeft > TWAP_WINDOW_SECONDS ? points.early : points.late;
    const base = { tau: snapshot.secondsLeft, dOverSigma: snapshot.d / snapshot.sigma };
    bucket.crowd.push({ ...base, probability: (snapshot.upBid + snapshot.upAsk) / 2 });
    bucket.truth.push({ ...base, probability: pTrueOf(snapshot, b, s) });
  }

  return {
    early: { crowd: fitPowerModel(points.early.crowd), truth: fitPowerModel(points.early.truth) },
    late: { crowd: fitPowerModel(points.late.crowd), truth: fitPowerModel(points.late.truth) },
  };
}

function makeFingerprint(
  snapshots: Snapshot[],
  windows: number,
  b: number,
  s: number,
): Fingerprint {
  const { early, late } = fitBuckets(snapshots, b, s);
  const { converged, ...bias } = judgeFit(early, late);
  // A loop, not Math.min(...array): millions of values would overflow the stack
  let from = Infinity;
  let to = -Infinity;
  for (const snapshot of snapshots) {
    from = Math.min(from, snapshot.t);
    to = Math.max(to, snapshot.t);
  }
  return {
    fittedAt: new Date().toISOString(),
    fromTime: snapshots.length ? new Date(from).toISOString() : "",
    toTime: snapshots.length ? new Date(to).toISOString() : "",
    windows,
    b,
    s,
    early,
    late,
    bias,
    converged,
  };
}

async function loadSnapshots(sinceMs: number) {
  const rows = await readRecorderRows(RECORD_FILE, sinceMs);
  await backfillOutcomes([...new Set(rows.map((row) => row.slug))]);
  return buildSnapshots(rows, readOutcomes());
}

// Refits on the last FIT_DAYS days and saves fingerprint.json.
export async function buildFingerprint(): Promise<Fingerprint> {
  const set = await loadSnapshots(Date.now() - FIT_DAYS * DAY_MS);
  const fingerprint = makeFingerprint(set.snapshots, set.windows, set.b, set.s);
  writeFileSync(FINGERPRINT_FILE, JSON.stringify(fingerprint, null, 2));
  return fingerprint;
}

export function readFingerprint(): Fingerprint | undefined {
  if (!existsSync(FINGERPRINT_FILE)) return undefined;
  return JSON.parse(readFileSync(FINGERPRINT_FILE, "utf8")) as Fingerprint;
}

// ========================================
// BACKTEST
// ========================================

type BacktestTrade = { slug: string; bucket: string; side: string; edgePerShare: number };

// Replays the trading rules: one trade per window, first qualifying second,
// held to settlement. Down quotes mirror Up: Down ask = 1 − Up bid.
function backtest(snapshots: Snapshot[], fingerprint: Fingerprint): BacktestTrade[] {
  const trades: BacktestTrade[] = [];
  const tradedWindows = new Set<string>();

  for (const snapshot of [...snapshots].sort((a, b) => a.t - b.t)) {
    if (tradedWindows.has(snapshot.slug)) continue;
    if (snapshot.t < snapshot.start + NO_TRADE_FIRST_SECONDS * 1000) continue;
    if (isSkippedWindow(snapshot.start) || snapshot.jumpRecently) continue;

    const signal = evaluateSignal({
      secondsLeft: snapshot.secondsLeft,
      pTrueUp: pTrueOf(snapshot, fingerprint.b, fingerprint.s),
      upBid: snapshot.upBid,
      upAsk: snapshot.upAsk,
      downBid: 1 - snapshot.upAsk,
      downAsk: 1 - snapshot.upBid,
      bias: fingerprint.bias,
    });
    if (!signal?.biasMatches) continue;

    const won = (signal.side === "UP") === snapshot.outcomeUp;
    trades.push({
      slug: snapshot.slug,
      bucket: signal.bucket,
      side: signal.side,
      edgePerShare: (won ? 1 : 0) - signal.cost,
    });
    tradedWindows.add(snapshot.slug);
  }
  return trades;
}

function mean(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

// 95% bootstrap interval of the mean
function bootstrapInterval(values: number[], rounds = 2000): [number, number] {
  const means: number[] = [];
  for (let i = 0; i < rounds; i++) {
    let sum = 0;
    for (let j = 0; j < values.length; j++) {
      sum += values[Math.floor(Math.random() * values.length)] ?? 0;
    }
    means.push(sum / values.length);
  }
  means.sort((a, b) => a - b);
  return [means[Math.floor(rounds * 0.025)] ?? NaN, means[Math.floor(rounds * 0.975)] ?? NaN];
}

// ========================================
// REPORT
// ========================================

const fmt = (n: number | undefined, digits = 3) => (n === undefined ? "-" : n.toFixed(digits));

function printFingerprint(label: string, fp: Fingerprint) {
  console.log(`\n${label}`);
  for (const name of ["early", "late"] as const) {
    const bucket = fp[name];
    console.log(
      `  ${name.padEnd(5)}  crowd k=${fmt(bucket.crowd?.k)} α=${fmt(bucket.crowd?.alpha)} ` +
        `(n=${bucket.crowd?.n ?? 0})   truth k=${fmt(bucket.truth?.k)} α=${fmt(bucket.truth?.alpha)}`,
    );
  }
  console.log(
    `  bias: early=${fp.bias.early ? "YES (buy cheaper side)" : "no"}, ` +
      `late=${fp.bias.late ? "YES (buy leading side)" : "no"}` +
      (fp.converged ? "   CONVERGED: crowd matches truth, edge gone" : ""),
  );
}

function printCalibration(snapshots: Snapshot[], b: number, s: number) {
  console.log("\nCalibration of P_true (does a 70% prediction win 70% of the time?)");
  for (const name of ["early", "late"] as const) {
    const bins = Array.from({ length: 10 }, () => ({ n: 0, p: 0, up: 0 }));
    for (const snapshot of snapshots) {
      const isLate = snapshot.secondsLeft <= TWAP_WINDOW_SECONDS;
      if ((name === "late") !== isLate) continue;
      const p = pTrueOf(snapshot, b, s);
      const bin = bins[Math.min(9, Math.floor(p * 10))]!;
      bin.n += 1;
      bin.p += p;
      bin.up += snapshot.outcomeUp ? 1 : 0;
    }
    console.log(`  ${name}:  P_true range   predicted   actual Up   seconds`);
    bins.forEach((bin, i) => {
      if (bin.n === 0) return;
      console.log(
        `          ${(i / 10).toFixed(1)}-${((i + 1) / 10).toFixed(1)}        ` +
          `${(bin.p / bin.n).toFixed(3)}       ${(bin.up / bin.n).toFixed(3)}       ${bin.n}`,
      );
    });
  }
}

function printPaperStats() {
  if (!existsSync(PAPER_TRADES_FILE)) return;
  const lines = readFileSync(PAPER_TRADES_FILE, "utf8").trim().split("\n");
  const header = lines[0]?.split(",") ?? [];
  const edgeColumn = header.indexOf("edgePerShare");
  const edges = lines
    .slice(1)
    .map((line) => Number(line.split(",")[edgeColumn]))
    .filter(Number.isFinite);
  if (edges.length === 0) return;

  const passed = edges.length >= PHASE3_MIN_SIGNALS && mean(edges) > 0;
  console.log(
    `\nPhase 3 (paper): ${edges.length} trades, mean edge ${fmt(mean(edges), 4)} per share ` +
      `→ gate ${passed ? "PASSED" : `not yet (needs ≥ ${PHASE3_MIN_SIGNALS} trades and edge > 0)`}`,
  );
}

export async function runFit() {
  console.log(`Fitting the crowd fingerprint from ${RECORD_FILE}...`);

  const set = await loadSnapshots(0);
  const { snapshots, b, s } = set;
  if (snapshots.length === 0) {
    console.log("No usable data yet. Run the recorder (npm start -- record) first.");
    return;
  }

  // Phase 1 gate
  console.log(
    `\nPhase 1 (data): ${set.completeWindows} complete windows of ${PHASE1_MIN_WINDOWS} needed ` +
      `→ gate ${set.completeWindows >= PHASE1_MIN_WINDOWS ? "PASSED" : "not yet"}`,
  );
  console.log(
    `Feed error vs Chainlink (from ${set.feedErrors} windows): ` +
      `b=${b.toExponential(2)}, s=${s.toExponential(2)} (log units)`,
  );

  printCalibration(snapshots, b, s);

  // Phase 2: train on the earlier data, test on the last week (or last 25%)
  const starts = [...new Set(snapshots.map((snapshot) => snapshot.start))].sort((x, y) => x - y);
  const first = starts[0]!;
  const last = starts.at(-1)!;
  const splitAt =
    last - first >= 14 * DAY_MS
      ? last - 7 * DAY_MS
      : (starts[Math.floor(starts.length * 0.75)] ?? last);
  const train = snapshots.filter((snapshot) => snapshot.start < splitAt);
  const test = snapshots.filter((snapshot) => snapshot.start >= splitAt);
  console.log(
    `\nPhase 2 split: train ${new Set(train.map((x) => x.slug)).size} windows, ` +
      `test ${new Set(test.map((x) => x.slug)).size} windows (from ${new Date(splitAt).toISOString()})`,
  );

  const trainFit = makeFingerprint(train, set.windows, b, s);
  printFingerprint("Fit on training data:", trainFit);

  const trades = backtest(test, trainFit);
  if (trades.length === 0) {
    console.log("\nBacktest: no trades on the test data (no bias found, or no signal passed).");
  } else {
    const edges = trades.map((trade) => trade.edgePerShare);
    const [low, high] = bootstrapInterval(edges);
    console.log(
      `\nBacktest on test data: ${trades.length} trades, mean edge ${fmt(mean(edges), 4)} per share, ` +
        `95% interval [${fmt(low, 4)}, ${fmt(high, 4)}] → gate ${low > 0 ? "PASSED" : "not passed"}`,
    );
    for (const bucket of ["early", "late"]) {
      const inBucket = trades.filter((trade) => trade.bucket === bucket);
      if (inBucket.length) {
        console.log(
          `  ${bucket}: ${inBucket.length} trades, mean ${fmt(mean(inBucket.map((t) => t.edgePerShare)), 4)}`,
        );
      }
    }
  }

  // The fingerprint for paper trading: last FIT_DAYS days
  const live = await buildFingerprint();
  printFingerprint(`Saved to ${FINGERPRINT_FILE} (last ${FIT_DAYS} days):`, live);

  printPaperStats();
}
