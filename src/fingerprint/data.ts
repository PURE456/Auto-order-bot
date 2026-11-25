// Data for the Crowd Fingerprint strategy: window results (outcomes), the
// recorder's CSV, and turning recorded rows into model inputs (snapshots).

import { appendFileSync, createReadStream, existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

import {
  DEFAULT_FEED_BIAS,
  DEFAULT_FEED_NOISE,
  JUMP_COOLDOWN_MS,
  OUTCOMES_FILE,
  SKIP_WINDOWS_ET,
  TWAP_WINDOW_SECONDS,
  WINDOW_SECONDS,
} from "../config.js";
import { getWindowResult, sleep } from "../feeds.js";
import { VolatilityTracker, computeD, effectiveVariance } from "./model.js";

// ========================================
// WINDOWS
// ========================================

// Slugs look like "btc-updown-5m-1795178700": the number is the start (Unix s).
export function windowFromSlug(slug: string): { start: number; end: number } | undefined {
  const seconds = Number(slug.split("-").at(-1));
  if (!Number.isFinite(seconds)) return undefined;
  return { start: seconds * 1000, end: (seconds + WINDOW_SECONDS) * 1000 };
}

const etTime = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

// Rule 7: skip windows that contain 8:30 or 9:30 AM ET (US data releases and
// the stock market open). Windows are 5-minute aligned, so we check the start.
export function isSkippedWindow(startMs: number): boolean {
  return SKIP_WINDOWS_ET.includes(etTime.format(new Date(startMs)));
}

// ========================================
// OUTCOMES (official opening/closing TWAP per window)
// ========================================

export type Outcome = { slug: string; open: number; close: number; up: boolean };

let outcomesCache: Map<string, Outcome> | undefined;

export function readOutcomes(): Map<string, Outcome> {
  if (outcomesCache) return outcomesCache;
  outcomesCache = new Map();
  if (!existsSync(OUTCOMES_FILE)) return outcomesCache;

  for (const line of readFileSync(OUTCOMES_FILE, "utf8").split("\n").slice(1)) {
    const [slug, , , open, close] = line.split(",");
    if (!slug || !open || !close) continue;
    const o = Number(open);
    const c = Number(close);
    outcomesCache.set(slug, { slug, open: o, close: c, up: c >= o });
  }
  return outcomesCache;
}

function saveOutcome(slug: string, result: { open: number; close: number }) {
  const outcomes = readOutcomes();
  if (outcomes.has(slug)) return;

  if (!existsSync(OUTCOMES_FILE)) {
    appendFileSync(OUTCOMES_FILE, "slug,start,end,openTwap,closeTwap,outcome\n");
  }
  const window = windowFromSlug(slug);
  const up = result.close >= result.open;
  appendFileSync(
    OUTCOMES_FILE,
    [
      slug,
      window ? new Date(window.start).toISOString() : "",
      window ? new Date(window.end).toISOString() : "",
      result.open,
      result.close,
      up ? "UP" : "DOWN",
    ].join(",") + "\n",
  );
  outcomes.set(slug, { slug, ...result, up });
}

// Waits for a window to settle and saves its result. Retries for 10 minutes.
export async function fetchOutcomeWhenReady(slug: string): Promise<Outcome | undefined> {
  const window = windowFromSlug(slug);
  if (!window) return undefined;

  const giveUpAt = window.end + 10 * 60 * 1000;
  while (Date.now() < giveUpAt) {
    const known = readOutcomes().get(slug);
    if (known) return known;

    if (Date.now() >= window.end) {
      const result = await getWindowResult(window.start, window.end).catch(() => undefined);
      if (result) {
        saveOutcome(slug, result);
        return readOutcomes().get(slug);
      }
    }
    await sleep(5000);
  }
  return undefined;
}

// Fetches results we don't have yet, one request at a time. The API only
// serves the last 30 days, so older windows are skipped.
export async function backfillOutcomes(slugs: string[]) {
  const oldest = Date.now() - 29 * 24 * 60 * 60 * 1000;
  const missing = slugs.filter((slug) => {
    const window = windowFromSlug(slug);
    return window && window.start > oldest && window.end < Date.now() && !readOutcomes().has(slug);
  });
  if (missing.length === 0) return;

  console.log(`Fetching results for ${missing.length} windows (saved to ${OUTCOMES_FILE})...`);
  let done = 0;
  for (const slug of missing) {
    const window = windowFromSlug(slug)!;
    const result = await getWindowResult(window.start, window.end).catch(() => undefined);
    if (result) saveOutcome(slug, result);
    done += 1;
    if (done % 100 === 0) console.log(`  ${done} / ${missing.length}`);
  }
}

// ========================================
// RECORDER CSV
// ========================================

export type RecordedRow = {
  t: number;
  slug: string;
  openTwap: number | undefined;
  btc: number | undefined;
  upBid: number | undefined;
  upAsk: number | undefined;
};

function toNumber(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

// Reads the recorder's CSV line by line (it can be hundreds of MB).
export async function readRecorderRows(file: string, sinceMs = 0): Promise<RecordedRow[]> {
  if (!existsSync(file)) return [];

  const rows: RecordedRow[] = [];
  const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  let columns: Record<string, number> | undefined;

  for await (const line of lines) {
    const cells = line.split(",");
    if (!columns) {
      columns = Object.fromEntries(cells.map((name, i) => [name, i]));
      continue;
    }
    const cell = (name: string) =>
      columns![name] === undefined ? undefined : cells[columns![name]!];

    const t = Date.parse(cell("time") ?? "");
    const slug = cell("market");
    if (!Number.isFinite(t) || t < sinceMs || !slug) continue;

    rows.push({
      t,
      slug,
      openTwap: toNumber(cell("startPrice")),
      btc: toNumber(cell("btcPrice")),
      upBid: toNumber(cell("upBid")),
      upAsk: toNumber(cell("upAsk")),
    });
  }
  return rows;
}

// ========================================
// SNAPSHOTS (one per recorded second, ready for the model)
// ========================================

export type Snapshot = {
  t: number;
  slug: string;
  start: number;
  secondsLeft: number;
  d: number;
  sigma: number;
  varianceEff: number;
  upBid: number;
  upAsk: number;
  jumpRecently: boolean;
  outcomeUp: boolean;
};

export type SnapshotSet = {
  snapshots: Snapshot[];
  windows: number; // windows with a known result
  completeWindows: number; // ... and at least 250 recorded seconds
  b: number;
  s: number;
  feedErrors: number; // windows used to measure b and s
};

// Turns recorder rows into snapshots. Also measures b and s: how far our own
// closing average (from the spot prices) is from Chainlink's official one.
export function buildSnapshots(rows: RecordedRow[], outcomes: Map<string, Outcome>): SnapshotSet {
  const sorted = [...rows].sort((a, b) => a.t - b.t);
  const vol = new VolatilityTracker();
  const snapshots: Snapshot[] = [];
  const rowsPerWindow = new Map<string, number>();
  const closingSums = new Map<string, { sum: number; count: number }>();
  let lastJumpAt = -Infinity;

  for (const row of sorted) {
    rowsPerWindow.set(row.slug, (rowsPerWindow.get(row.slug) ?? 0) + 1);
    if (row.btc === undefined) continue;

    // Volatility and jumps, from consecutive prices across all windows
    if (vol.update(row.t, row.btc)) lastJumpAt = row.t;

    const window = windowFromSlug(row.slug);
    if (!window) continue;
    const secondsLeft = (window.end - row.t) / 1000;
    if (secondsLeft <= 0) continue;

    // Running average of the spot price inside the closing window
    let closing = closingSums.get(row.slug);
    if (secondsLeft <= TWAP_WINDOW_SECONDS) {
      closing ??= { sum: 0, count: 0 };
      closing.sum += row.btc;
      closing.count += 1;
      closingSums.set(row.slug, closing);
    }

    const outcome = outcomes.get(row.slug);
    const sigma = vol.sigma;
    const openTwap = outcome?.open ?? row.openTwap;
    if (!outcome || sigma === undefined || openTwap === undefined) continue;
    if (row.upBid === undefined || row.upAsk === undefined) continue;

    snapshots.push({
      t: row.t,
      slug: row.slug,
      start: window.start,
      secondsLeft,
      d: computeD(
        openTwap,
        row.btc,
        secondsLeft,
        closing ? closing.sum / closing.count : undefined,
      ),
      sigma,
      varianceEff: effectiveVariance(sigma, secondsLeft),
      upBid: row.upBid,
      upAsk: row.upAsk,
      jumpRecently: row.t - lastJumpAt < JUMP_COOLDOWN_MS,
      outcomeUp: outcome.up,
    });
  }

  // b, s: mean and spread of ln(our closing average / official closing TWAP)
  const errors: number[] = [];
  for (const [slug, closing] of closingSums) {
    const outcome = outcomes.get(slug);
    if (outcome && closing.count >= 50)
      errors.push(Math.log(closing.sum / closing.count / outcome.close));
  }
  let b = DEFAULT_FEED_BIAS;
  let s = DEFAULT_FEED_NOISE;
  if (errors.length >= 20) {
    b = errors.reduce((sum, e) => sum + e, 0) / errors.length;
    s = Math.sqrt(errors.reduce((sum, e) => sum + (e - b) ** 2, 0) / (errors.length - 1));
  }

  const windowsWithOutcome = [...rowsPerWindow.keys()].filter((slug) => outcomes.has(slug));
  return {
    snapshots,
    windows: windowsWithOutcome.length,
    completeWindows: windowsWithOutcome.filter((slug) => (rowsPerWindow.get(slug) ?? 0) >= 250)
      .length,
    b,
    s,
    feedErrors: errors.length,
  };
}
