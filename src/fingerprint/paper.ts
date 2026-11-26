// Phase 3: paper trading the Crowd Fingerprint strategy on live data. No real
// orders: each trade is logged as if filled at the ask and settled at the
// official result. Run with "npm start -- fingerprint".

import { appendFileSync, existsSync, readFileSync } from "node:fs";

import {
  BANKROLL,
  BTC_SERIES,
  DAILY_LOSS_LIMIT,
  DEFAULT_FEED_BIAS,
  DEFAULT_FEED_NOISE,
  FEED_GAP_NOISE_MULTIPLE,
  JUMP_COOLDOWN_MS,
  MAX_DRAWDOWN,
  MAX_PER_TRADE,
  NO_TRADE_FIRST_SECONDS,
  PAPER_TRADES_FILE,
  REFIT_EVERY_MS,
  SIGNALS_FILE,
  STALE_PRICE_MS,
  STALE_QUOTE_MS,
  TWAP_WINDOW_SECONDS,
} from "../config.js";
import {
  findCurrentMarket,
  getExactTwap,
  getLastTickReceivedAt,
  getLiveBtcPrice,
  getPricesBetween,
  getStartPrice,
  getUpDownTokens,
  liveQuotes,
  onPriceTick,
  runExactTwapPoller,
  sleep,
  sleepRestOf,
  startBtcFeed,
  startOrderBookFeed,
  twapAt,
} from "../feeds.js";
import { fetchOutcomeWhenReady, isSkippedWindow } from "./data.js";
import { buildFingerprint, readFingerprint } from "./fit.js";
import {
  VolatilityTracker,
  computeD,
  effectiveVariance,
  evaluateSignal,
  kellyFraction,
  takerFeePerShare,
  trueProbabilityUp,
  type Fingerprint,
  type Signal,
} from "./model.js";

type Position = Signal & { slug: string; shares: number; time: string; fp: Fingerprint };

// ========================================
// PROFIT AND LOSS (rebuilt from the trades file, so limits survive restarts)
// ========================================

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

const pnl = { total: 0, today: 0, day: utcDay(Date.now()), trades: 0, edgeSum: 0 };

function loadPnl() {
  if (!existsSync(PAPER_TRADES_FILE)) return;
  const lines = readFileSync(PAPER_TRADES_FILE, "utf8").trim().split("\n");
  const header = lines[0]?.split(",") ?? [];
  const col = (name: string) => header.indexOf(name);

  for (const line of lines.slice(1)) {
    const cells = line.split(",");
    const profit = Number(cells[col("pnl")]);
    if (!Number.isFinite(profit)) continue;
    pnl.total += profit;
    pnl.trades += 1;
    pnl.edgeSum += Number(cells[col("edgePerShare")]) || 0;
    if ((cells[col("time")] ?? "").startsWith(pnl.day)) pnl.today += profit;
  }
}

function addPnl(profit: number, edgePerShare: number) {
  const day = utcDay(Date.now());
  if (day !== pnl.day) {
    pnl.day = day;
    pnl.today = 0;
  }
  pnl.total += profit;
  pnl.today += profit;
  pnl.trades += 1;
  pnl.edgeSum += edgePerShare;
}

function todayLoss(): number {
  return utcDay(Date.now()) === pnl.day ? -pnl.today : 0;
}

// ========================================
// LOG FILES
// ========================================

function writeHeaders() {
  if (!existsSync(SIGNALS_FILE)) {
    appendFileSync(
      SIGNALS_FILE,
      "time,market,secondsLeft,bucket,d,sigma,pTrueUp,upMid,zGap,side,ask,pUsed,edge," +
        "quoteAgeSec,action\n",
    );
  }
  if (!existsSync(PAPER_TRADES_FILE)) {
    appendFileSync(
      PAPER_TRADES_FILE,
      "time,market,bucket,side,zGap,pTrue,pUsed,fillPrice,feePerShare,shares,cost," +
        "kEarly,alphaEarly,kLate,alphaLate,outcome,pnl,edgePerShare\n",
    );
  }
}

// ========================================
// SETTLEMENT
// ========================================

async function settle(position: Position) {
  const outcome = await fetchOutcomeWhenReady(position.slug);
  if (!outcome) {
    console.log(`  Could not get the result of ${position.slug}; trade not counted.`);
    return;
  }

  const won = (position.side === "UP") === outcome.up;
  const edgePerShare = (won ? 1 : 0) - position.cost;
  const profit = position.shares * edgePerShare;
  addPnl(profit, edgePerShare);

  const { fp } = position;
  appendFileSync(
    PAPER_TRADES_FILE,
    [
      position.time,
      position.slug,
      position.bucket,
      position.side,
      position.zGap.toFixed(4),
      position.modelProbability.toFixed(4),
      position.probability.toFixed(4),
      position.ask,
      takerFeePerShare(position.ask).toFixed(5),
      position.shares.toFixed(4),
      (position.shares * position.cost).toFixed(4),
      fp.early.crowd?.k ?? "",
      fp.early.crowd?.alpha ?? "",
      fp.late.crowd?.k ?? "",
      fp.late.crowd?.alpha ?? "",
      outcome.up ? "UP" : "DOWN",
      profit.toFixed(4),
      edgePerShare.toFixed(4),
    ].join(",") + "\n",
  );

  console.log(
    `  SETTLED ${position.slug}: ${won ? "WON" : "LOST"} ${profit >= 0 ? "+" : ""}$${profit.toFixed(2)} | ` +
      `trades ${pnl.trades}, mean edge ${(pnl.edgeSum / pnl.trades).toFixed(4)}/share, ` +
      `today $${pnl.today.toFixed(2)}, total $${pnl.total.toFixed(2)}`,
  );

  if (-pnl.total >= MAX_DRAWDOWN) {
    console.log(
      `\nKILL SWITCH: total drawdown $${(-pnl.total).toFixed(2)}. Experiment over, review it.`,
    );
    process.exit(0);
  }
}

// ========================================
// MAIN LOOP
// ========================================

export async function runFingerprintPaper() {
  console.log("Crowd Fingerprint paper trader started (no real orders). Press Ctrl+C to stop.");

  loadPnl();
  writeHeaders();
  if (-pnl.total >= MAX_DRAWDOWN) {
    console.log(
      `Total drawdown $${(-pnl.total).toFixed(2)} hit the limit. Review before restarting.`,
    );
    return;
  }
  console.log(`Paper P&L so far: ${pnl.trades} trades, total $${pnl.total.toFixed(2)}`);

  // Live volatility and jumps from every Chainlink price
  const vol = new VolatilityTracker();
  let lastJumpAt = -Infinity;
  onPriceTick((tick) => {
    if (vol.update(tick.timestamp, tick.value)) lastJumpAt = tick.timestamp;
  });

  startBtcFeed();
  runExactTwapPoller(); // official TWAP, used to check our feed

  // The fingerprint: refit in the background once it is a day old
  let fingerprint = readFingerprint();
  let refitting = false;
  const refitIfOld = () => {
    const age = fingerprint ? Date.now() - Date.parse(fingerprint.fittedAt) : Infinity;
    if (age < REFIT_EVERY_MS || refitting) return;
    refitting = true;
    console.log("Refitting the fingerprint on the last days of recorded data...");
    buildFingerprint()
      .then((fp) => {
        fingerprint = fp;
        console.log(
          `Fingerprint updated: bias early=${fp.bias.early}, late=${fp.bias.late}, converged=${fp.converged}`,
        );
      })
      .catch((error) => console.error("Refit failed:", error))
      .finally(() => (refitting = false));
  };

  while (true) {
    let orderBookFeed: { stop: () => void } | undefined;

    try {
      const market = await findCurrentMarket(BTC_SERIES[0]); // 5-min markets
      if (!market?.eventStartTime) {
        await sleep(5000);
        continue;
      }

      refitIfOld();

      const start = Date.parse(market.eventStartTime);
      const end = Date.parse(market.endDate);
      const { upToken, downToken } = getUpDownTokens(market);
      const skipWindow = isSkippedWindow(start);

      console.log(`\nWatching: ${market.question}${skipWindow ? " (skipped: 8:30/9:30 ET)" : ""}`);
      orderBookFeed = startOrderBookFeed([upToken, downToken]);

      // Opening TWAP, fetched in the background until we have it
      let openTwap: number | undefined;
      (async () => {
        while (openTwap === undefined && Date.now() < end) {
          openTwap = await getStartPrice(market).catch(() => undefined);
          if (openTwap === undefined) await sleep(1000);
        }
      })();

      let position: Position | undefined;
      let lastStatusAt = 0;

      // Rule 2: compute P_true and z_gap once per second
      while (Date.now() < end) {
        const now = Date.now();
        const secondsLeft = (end - now) / 1000;
        const spot = getLiveBtcPrice();
        const sigma = vol.sigma;
        const up = liveQuotes.get(upToken);
        const down = liveQuotes.get(downToken);

        if (
          openTwap === undefined ||
          spot === undefined ||
          sigma === undefined ||
          up?.bid === undefined ||
          up.ask === undefined ||
          down?.bid === undefined ||
          down.ask === undefined
        ) {
          await sleepRestOf(1000, now);
          continue;
        }

        const fp = fingerprint;
        const b = fp?.b ?? DEFAULT_FEED_BIAS;
        const s = fp?.s ?? DEFAULT_FEED_NOISE;

        // Closing window: blend the average so far with the current price
        let closingAverage: number | undefined;
        if (secondsLeft <= TWAP_WINDOW_SECONDS) {
          const prices = getPricesBetween(end - TWAP_WINDOW_SECONDS * 1000, now);
          if (prices.length) closingAverage = prices.reduce((sum, p) => sum + p, 0) / prices.length;
        }
        const d = computeD(openTwap, spot, secondsLeft, closingAverage);
        const pTrueUp = trueProbabilityUp(d, effectiveVariance(sigma, secondsLeft), b, s);
        const upMid = (up.bid + up.ask) / 2;

        const signal = evaluateSignal({
          secondsLeft,
          pTrueUp,
          upBid: up.bid,
          upAsk: up.ask,
          downBid: down.bid,
          downAsk: down.ask,
          bias: fp?.bias,
        });

        if (now - lastStatusAt >= 15_000) {
          lastStatusAt = now;
          console.log(
            `  [${Math.round(secondsLeft)}s left] P_true(Up) ${pTrueUp.toFixed(3)} vs market ${upMid.toFixed(3)}` +
              (signal
                ? ` → signal ${signal.side} z=${signal.zGap.toFixed(2)} edge=${signal.edge.toFixed(3)}`
                : ""),
          );
        }

        if (signal) {
          // Checks in order; the first that fails is logged as the action
          const exact = getExactTwap();
          const ours = exact && now - exact.at < 15_000 ? twapAt(exact.at) : undefined;
          const feedGap = exact && ours ? Math.abs(Math.log(ours / exact.value)) : 0;
          // The book feed sends every change, so a long silence on either
          // side means the prices we see may no longer be there
          const quoteAge = now - Math.min(up.at ?? 0, down.at ?? 0);

          let action: string;
          if (position) action = "ALREADY_IN";
          else if (now - start < NO_TRADE_FIRST_SECONDS * 1000) action = "FIRST_60S";
          else if (skipWindow) action = "SKIP_WINDOW";
          else if (now - lastJumpAt < JUMP_COOLDOWN_MS) action = "JUMP";
          else if (now - getLastTickReceivedAt() > STALE_PRICE_MS) action = "STALE";
          else if (quoteAge > STALE_QUOTE_MS) action = "STALE_QUOTE";
          else if (feedGap > FEED_GAP_NOISE_MULTIPLE * s) action = "FEED_GAP";
          else if (!fp) action = "NO_FIT";
          else if (fp.converged) action = "CONVERGED";
          else if (todayLoss() >= DAILY_LOSS_LIMIT) action = "DAILY_LOSS";
          else if (!signal.biasMatches) action = "NO_BIAS";
          else action = "TRADE";

          let shares = 0;
          if (action === "TRADE" && fp) {
            // Rule 5: 1/8 Kelly of the current bankroll, capped at $5
            const stake = Math.min(
              kellyFraction(signal.probability, signal.cost) * (BANKROLL + pnl.total),
              MAX_PER_TRADE,
            );
            shares = stake / signal.cost;
            if (shares > 0) {
              position = {
                ...signal,
                slug: market.slug,
                shares,
                time: new Date(now).toISOString(),
                fp,
              };
              console.log(
                `  [${Math.round(secondsLeft)}s left] PAPER BUY ${signal.side} ${shares.toFixed(2)} shares ` +
                  `at ${signal.ask} ($${stake.toFixed(2)}), P_true ${signal.modelProbability.toFixed(3)}, ` +
                  `blended ${signal.probability.toFixed(3)}, ` +
                  `z_gap ${signal.zGap.toFixed(2)}, edge ${signal.edge.toFixed(3)}`,
              );
            } else {
              action = "SIZE_ZERO";
            }
          }

          appendFileSync(
            SIGNALS_FILE,
            [
              new Date(now).toISOString(),
              market.slug,
              Math.round(secondsLeft),
              signal.bucket,
              d.toExponential(4),
              sigma.toExponential(4),
              pTrueUp.toFixed(4),
              upMid.toFixed(4),
              signal.zGap.toFixed(4),
              signal.side,
              signal.ask,
              signal.probability.toFixed(4),
              signal.edge.toFixed(4),
              (quoteAge / 1000).toFixed(1),
              action,
            ].join(",") + "\n",
          );
        }

        await sleepRestOf(1000, now);
      }

      // Rule 6: hold to settlement. Settle in the background.
      if (position) settle(position);
      else {
        console.log("  No trade this window.");
        // Save the result anyway, so signals we did not trade can be checked later
        fetchOutcomeWhenReady(market.slug).catch(() => undefined);
      }
    } catch (error) {
      console.error("Error, retrying in 5 seconds:", error);
      await sleep(5000);
    } finally {
      orderBookFeed?.stop();
    }
  }
}
