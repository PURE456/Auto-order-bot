import { appendFileSync, existsSync } from "node:fs";

import {
  BTC_SERIES,
  CHECK_EVERY_MS,
  CONFIRM_ENTRY_MS,
  ENTRY_PRICE,
  OBSERVE_FIRST_MS,
  RECORD_EVERY_MS,
  RECORD_FILE,
  STOP_LOSS,
  TARGET_PROFIT,
  type DurationConfig,
  type Leg,
  type Market,
  type Quote,
  type Result,
} from "./config.js";
import {
  estimateTwap,
  fetchOrderBook,
  findCurrentMarket,
  getExactTwap,
  getLiveBtcPrice,
  getQuote,
  getStartPrice,
  getUpDownTokens,
  liveQuotes,
  runExactTwapPoller,
  sleep,
  sleepRestOf,
  startBtcFeed,
  startOrderBookFeed,
} from "./feeds.js";
import { fetchOutcomeWhenReady } from "./fingerprint/data.js";
import { runFit } from "./fingerprint/fit.js";
import { runFingerprintPaper } from "./fingerprint/paper.js";

function printOrderBook(outcome: string, quote: Quote) {
  const { bid: bestBid, ask: bestAsk } = quote;

  console.log(`\n${outcome}`);

  console.log(`Best Bid: ${bestBid !== undefined ? bestBid.toFixed(4) : "N/A"}`);

  console.log(`Best Ask: ${bestAsk !== undefined ? bestAsk.toFixed(4) : "N/A"}`);

  if (bestBid !== undefined && bestAsk !== undefined) {
    console.log(`Spread: ${(bestAsk - bestBid).toFixed(4)}`);
  }
}

// Checks if a market is safe to trade.
// Returns a list of problems. Empty list = OK to trade.
function checkMarket(up: Quote, down: Quote): string[] {
  const { bid: upBid, ask: upAsk } = up;
  const { bid: downBid, ask: downAsk } = down;

  // Check 1: we need buyers and sellers on both books
  if (
    upBid === undefined ||
    upAsk === undefined ||
    downBid === undefined ||
    downAsk === undefined
  ) {
    return ["Missing buyers or sellers"];
  }

  const problems: string[] = [];

  // Check 2: the spread must be 5 cents or less
  if (upAsk - upBid > 0.05) {
    problems.push("Spread too wide");
  }

  // Check 3: UP bid + DOWN ask should add up to $1
  if (Math.abs(upBid + downAsk - 1) > 0.01) {
    problems.push("UP and DOWN don't add up to $1, check token IDs");
  }

  // Check 4: skip if the market is 98% or more sure of either answer
  const upPrice = (upBid + upAsk) / 2;

  if (upPrice >= 0.98 || upPrice <= 0.02) {
    problems.push("Market is 98%+ sure, nearly decided");
  }

  return problems;
}

async function analyzeDuration(config: DurationConfig) {
  console.log("\n========================================");
  console.log(`BTC UP/DOWN - ${config.name}`);
  console.log("========================================");

  const market = await findCurrentMarket(config);

  if (!market) {
    console.log("No currently active market found.");
    return;
  }

  console.log(`Market: ${market.question}`);
  console.log(`Slug: ${market.slug}`);
  console.log(`Starts: ${market.eventStartTime ?? "N/A"}`);
  console.log(`Ends: ${market.endDate}`);

  const { upToken, downToken } = getUpDownTokens(market);

  const [upBook, downBook] = await Promise.all([
    fetchOrderBook(upToken),
    fetchOrderBook(downToken),
  ]);

  const up = getQuote(upBook);
  const down = getQuote(downBook);

  printOrderBook("UP ORDER BOOK", up);
  printOrderBook("DOWN ORDER BOOK", down);

  const problems = checkMarket(up, down);

  if (problems.length === 0) {
    console.log("\nRESULT: OK to trade");
  } else {
    console.log(`\nRESULT: SKIP (${problems.join(", ")})`);
  }

  // Arbitrage check: can we buy both sides for less than $1?
  if (up.ask !== undefined && down.ask !== undefined) {
    const totalCost = up.ask + down.ask;
    console.log(`Cost to buy both sides: ${totalCost.toFixed(4)}`);

    if (totalCost < 1) {
      console.log(`ARBITRAGE! Guaranteed profit: ${(1 - totalCost).toFixed(4)} per pair`);
    } else {
      console.log("No arbitrage");
    }
  }
}

async function main() {
  console.log("Connecting to Polymarket...");
  console.log("Scanning BTC Up/Down markets...");

  // One market at a time, in order
  for (const config of BTC_SERIES) {
    try {
      await analyzeDuration(config);
    } catch (error) {
      console.error(`Failed to analyze ${config.name}:`, error);
      process.exitCode = 1;
    }
  }

  console.log("\nBTC market scan completed.");
}

// ========================================
// LEGGING-IN WATCHER (paper trading, no real money)
// ========================================

// Watches one 5-min market from now until it ends.
async function watchOneMarket(market: Market): Promise<{ result: Result; profit: number }> {
  const { upToken, downToken } = getUpDownTokens(market);
  const end = Date.parse(market.endDate);

  console.log(`\nWatching: ${market.question}`);

  // Live best bid/ask for both sides, same source as the recorder
  const orderBookFeed = startOrderBookFeed([upToken, downToken]);
  try {
    return await watchWithLiveQuotes(upToken, downToken, end);
  } finally {
    orderBookFeed.stop();
  }
}

async function watchWithLiveQuotes(
  upToken: string,
  downToken: string,
  end: number,
): Promise<{ result: Result; profit: number }> {
  let leg1: Leg | undefined;
  // Which side is currently at or below ENTRY_PRICE, and since when
  let cheapSince: { side: Leg["side"]; since: number } | undefined;
  const watchStartedAt = Date.now();

  console.log(`  Observing for ${OBSERVE_FIRST_MS / 1000}s before any entry...`);

  while (Date.now() < end) {
    const startedAt = Date.now();

    const { bid: upBid, ask: upAsk } = liveQuotes.get(upToken) ?? {};
    const { bid: downBid, ask: downAsk } = liveQuotes.get(downToken) ?? {};
    const secondsLeft = Math.round((end - Date.now()) / 1000);

    // Skip this round if any price is missing
    if (
      upBid === undefined ||
      upAsk === undefined ||
      downBid === undefined ||
      downAsk === undefined
    ) {
      await sleepRestOf(CHECK_EVERY_MS, startedAt);
      continue;
    }

    if (!leg1) {
      // STEP 1: wait for a side that stays cheap, then buy it.
      const cheapSide = upAsk <= ENTRY_PRICE ? "UP" : downAsk <= ENTRY_PRICE ? "DOWN" : undefined;

      // Restart the timer whenever the cheap side changes or the dip ends,
      // so a short spike down never triggers a buy.
      if (cheapSide !== cheapSince?.side) {
        cheapSince = cheapSide ? { side: cheapSide, since: startedAt } : undefined;
      }

      const observedEnough = startedAt - watchStartedAt >= OBSERVE_FIRST_MS;
      const confirmed =
        cheapSince !== undefined && startedAt - cheapSince.since >= CONFIRM_ENTRY_MS;

      // Don't start a new trade in the last minute.
      if (observedEnough && confirmed && cheapSince && secondsLeft > 60) {
        const price = cheapSince.side === "UP" ? upAsk : downAsk;
        leg1 = { side: cheapSince.side, price };
        console.log(
          `  [${secondsLeft}s left] BUY leg 1: ${leg1.side} at ${leg1.price} ` +
            `(cheap for ${((startedAt - cheapSince.since) / 1000).toFixed(1)}s)`,
        );
      }
    } else {
      // STEP 2: we hold leg 1. Watch the other side.
      const otherAsk = leg1.side === "UP" ? downAsk : upAsk;
      const myBid = leg1.side === "UP" ? upBid : downBid;
      const maxOtherPrice = 1 - leg1.price - TARGET_PROFIT;

      // Win: the other side got cheap enough
      if (otherAsk <= maxOtherPrice) {
        const profit = 1 - leg1.price - otherAsk;
        console.log(
          `  [${secondsLeft}s left] BUY leg 2 at ${otherAsk}. LOCKED profit: ${profit.toFixed(4)}`,
        );
        return { result: "LOCKED", profit };
      }

      // Small loss: leg 1 dropped too much, so sell it
      if (myBid <= leg1.price - STOP_LOSS) {
        const profit = myBid - leg1.price;
        console.log(
          `  [${secondsLeft}s left] STOP LOSS: sell leg 1 at ${myBid}. Profit: ${profit.toFixed(4)}`,
        );
        return { result: "STOP LOSS", profit };
      }

      // Market almost over: sell leg 1 at whatever price we can get
      if (secondsLeft <= 15) {
        const profit = myBid - leg1.price;
        console.log(
          `  [${secondsLeft}s left] TIME UP: sell leg 1 at ${myBid}. Profit: ${profit.toFixed(4)}`,
        );
        return { result: "TIME UP", profit };
      }
    }

    await sleepRestOf(CHECK_EVERY_MS, startedAt);
  }

  if (leg1) {
    console.log("  Market ended before we could sell leg 1. Not counted.");
  } else {
    console.log("  No entry this market.");
  }
  return { result: "NO ENTRY", profit: 0 };
}

async function runWatcher() {
  console.log("Legging-in watcher started (paper trading). Press Ctrl+C to stop.");

  const counts = { LOCKED: 0, "STOP LOSS": 0, "TIME UP": 0, "NO ENTRY": 0 };
  let totalProfit = 0;

  while (true) {
    try {
      const market = await findCurrentMarket(BTC_SERIES[0]); // 5-min markets

      if (!market) {
        await sleep(5000);
        continue;
      }

      const { result, profit } = await watchOneMarket(market);
      counts[result] += 1;
      totalProfit += profit;

      console.log(
        `  SCORE: locked ${counts.LOCKED}, stop loss ${counts["STOP LOSS"]}, ` +
          `time up ${counts["TIME UP"]}, no entry ${counts["NO ENTRY"]}, ` +
          `total profit ${totalProfit.toFixed(4)} per share`,
      );

      // Wait for this market to end before looking for the next one
      const msLeft = Date.parse(market.endDate) - Date.now();
      if (msLeft > 0) {
        await sleep(msLeft + 1000);
      }
    } catch (error) {
      console.error("Error, retrying in 5 seconds:", error);
      await sleep(5000);
    }
  }
}

// ========================================
// PRICE RECORDER (saves prices to a CSV file)
// ========================================

async function runRecorder() {
  console.log(`Recorder started. Saving to ${RECORD_FILE}. Press Ctrl+C to stop.`);

  // All live data arrives in the background; the loop below only reads it.
  startBtcFeed();
  runExactTwapPoller();

  // Write the column names once, when the file is new
  if (!existsSync(RECORD_FILE)) {
    appendFileSync(
      RECORD_FILE,
      "time,market,secondsLeft,startPrice,btcPrice,btcTwapFast,btcTwapExact,exactAgeSec," +
        "priceChange,upBid,upAsk\n",
    );
  }

  while (true) {
    let orderBookFeed: { stop: () => void } | undefined;

    try {
      const market = await findCurrentMarket(BTC_SERIES[0]); // 5-min markets

      if (!market) {
        await sleep(5000);
        continue;
      }

      const { upToken } = getUpDownTokens(market);
      const end = Date.parse(market.endDate);

      console.log(`\nRecording: ${market.question}`);

      orderBookFeed = startOrderBookFeed([upToken]);

      // Fetch the start price in the background, retrying until we have it
      let startPrice: number | undefined;
      (async () => {
        while (startPrice === undefined && Date.now() < end) {
          startPrice = await getStartPrice(market).catch(() => undefined);
          if (startPrice === undefined) await sleep(1000);
        }
        if (startPrice !== undefined) console.log(`  Start price: ${startPrice.toFixed(2)}`);
      })();

      while (Date.now() < end) {
        const startedAt = Date.now();

        const { bid: upBid, ask: upAsk } = liveQuotes.get(upToken) ?? {};
        const btcPrice = getLiveBtcPrice(); // latest Chainlink spot price
        const twapFast = estimateTwap(); // instant, about +/- $1
        const twapExact = getExactTwap(); // official, a few seconds old
        const exactAge =
          twapExact !== undefined ? Math.round((startedAt - twapExact.at) / 1000) : undefined;
        const secondsLeft = Math.round((end - startedAt) / 1000);
        // Positive = TWAP is above the start price, so UP is currently winning
        const priceChange =
          twapFast !== undefined && startPrice !== undefined ? twapFast - startPrice : undefined;

        // Save one row. A missing price becomes an empty cell.
        const row = [
          new Date(startedAt).toISOString(),
          market.slug,
          secondsLeft,
          startPrice ?? "",
          btcPrice ?? "",
          twapFast?.toFixed(2) ?? "",
          twapExact?.value.toFixed(2) ?? "",
          exactAge ?? "",
          priceChange?.toFixed(2) ?? "",
          upBid ?? "",
          upAsk ?? "",
        ];
        appendFileSync(RECORD_FILE, row.join(",") + "\n");

        console.log(
          `  [${secondsLeft}s left] BTC ${btcPrice?.toFixed(2) ?? "N/A"} ` +
            `TWAP ${twapFast?.toFixed(2) ?? "N/A"} ` +
            `(exact ${twapExact?.value.toFixed(2) ?? "N/A"}, ${exactAge ?? "?"}s old) ` +
            `start ${startPrice?.toFixed(2) ?? "N/A"} change ${priceChange?.toFixed(2) ?? "N/A"} ` +
            `| UP ${upBid ?? "N/A"} / ${upAsk ?? "N/A"}`,
        );

        await sleepRestOf(RECORD_EVERY_MS, startedAt);
      }

      // Save the window's official result (open/close TWAP) for the
      // fingerprint fit. Runs in the background; the next market starts now.
      fetchOutcomeWhenReady(market.slug).catch(() => undefined);
    } catch (error) {
      // Network problem: wait a bit, then continue with the current market
      console.error("Error, retrying in 5 seconds:", error);
      await sleep(5000);
    } finally {
      // Market over (or error): close its order book connection
      orderBookFeed?.stop();
    }
  }
}

// "npm start"             runs the scanner
// "npm start -- watch"    runs the watcher
// "npm start -- record"   runs the recorder (phase 1: collect data)
// "npm start -- fit"      fits the crowd fingerprint and backtests (phase 2)
// "npm start -- fingerprint"  paper trades the fingerprint strategy (phase 3)
const mode = process.argv[2];

if (mode === "watch") {
  runWatcher();
} else if (mode === "record") {
  runRecorder();
} else if (mode === "fit") {
  runFit().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
} else if (mode === "fingerprint") {
  runFingerprintPaper();
} else {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
