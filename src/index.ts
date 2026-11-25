import { appendFileSync, existsSync } from "node:fs";

type Market = {
  question: string;
  slug: string;
  active: boolean;
  closed: boolean;
  acceptingOrders: boolean;
  outcomes: string;
  clobTokenIds: string;
  eventStartTime?: string;
  endDate: string;
};

type PolymarketEvent = {
  title: string;
  slug: string;
  active: boolean;
  closed: boolean;
  startTime?: string;
  endDate: string;
  markets: Market[];
};

type Order = {
  price: string;
  size: string;
};

type OrderBook = {
  bids: Order[];
  asks: Order[];
};

// Best prices of one order book, computed once and reused.
type Quote = {
  bid: number | undefined;
  ask: number | undefined;
};

type DurationConfig = {
  name: string;
  seriesSlug: string;
};

const BTC_SERIES = [
  {
    name: "5 Minutes",
    seriesSlug: "btc-up-or-down-5m",
  },
  {
    name: "15 Minutes",
    seriesSlug: "btc-up-or-down-15m",
  },
  {
    name: "1 Hour",
    seriesSlug: "btc-up-or-down-hourly",
  },
] as const satisfies readonly DurationConfig[];

async function fetchJson<T>(url: URL): Promise<T> {
  // Abort if the API doesn't respond within 10 seconds.
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });

  if (!response.ok) {
    throw new Error(`API Error ${response.status}: ${url}`);
  }

  return (await response.json()) as T;
}

function parseStringArray(value: string): string[] {
  return JSON.parse(value) as string[];
}

async function findCurrentMarket(config: DurationConfig): Promise<Market | undefined> {
  const url = new URL("https://gamma-api.polymarket.com/events");

  url.searchParams.set("series_slug", config.seriesSlug);
  url.searchParams.set("closed", "false");
  url.searchParams.set("limit", "100");
  url.searchParams.set("order", "endDate");
  url.searchParams.set("ascending", "true");

  const events = await fetchJson<PolymarketEvent[]>(url);

  const now = Date.now();

  for (const event of events) {
    if (!event.active || event.closed) {
      continue;
    }

    for (const market of event.markets ?? []) {
      if (!market.active || market.closed || !market.acceptingOrders) {
        continue;
      }

      const startTime = market.eventStartTime ?? event.startTime;

      const endTime = market.endDate ?? event.endDate;

      if (!startTime || !endTime) {
        continue;
      }

      const start = Date.parse(startTime);
      const end = Date.parse(endTime);

      // Select the market whose trading window is active now.
      if (start <= now && now < end) {
        return market;
      }
    }
  }

  return undefined;
}

async function fetchOrderBook(tokenId: string): Promise<OrderBook> {
  const url = new URL("https://clob.polymarket.com/book");

  url.searchParams.set("token_id", tokenId);

  return fetchJson<OrderBook>(url);
}

// Single pass, no temporary arrays (faster than Math.max(...orders.map(...))).
function getBestBid(orders: Order[]): number | undefined {
  let best: number | undefined;

  for (const order of orders) {
    const price = Number(order.price);
    if (best === undefined || price > best) best = price;
  }

  return best;
}

function getBestAsk(orders: Order[]): number | undefined {
  let best: number | undefined;

  for (const order of orders) {
    const price = Number(order.price);
    if (best === undefined || price < best) best = price;
  }

  return best;
}

function getQuote(book: OrderBook): Quote {
  return { bid: getBestBid(book.bids), ask: getBestAsk(book.asks) };
}

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

// Finds the token IDs for the Up and Down outcomes.
function getUpDownTokens(market: Market): { upToken: string; downToken: string } {
  const outcomes = parseStringArray(market.outcomes);
  const tokenIds = parseStringArray(market.clobTokenIds);

  const upIndex = outcomes.indexOf("Up");
  const downIndex = outcomes.indexOf("Down");

  if (upIndex === -1 || downIndex === -1 || !tokenIds[upIndex] || !tokenIds[downIndex]) {
    throw new Error("Could not identify Up/Down tokens.");
  }

  return { upToken: tokenIds[upIndex], downToken: tokenIds[downIndex] };
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

const ENTRY_PRICE = 0.45; // buy leg 1 when a side costs this much or less
const TARGET_PROFIT = 0.02; // profit we want after buying both legs
const STOP_LOSS = 0.1; // sell leg 1 if its price drops this much
const OBSERVE_FIRST_MS = 30_000; // just watch the market this long before any entry
const CONFIRM_ENTRY_MS = 3000; // a side must stay cheap this long before we buy it
// Prices are pushed to us by the order book WebSocket, so a check only reads
// memory and can run often without sending any requests.
const CHECK_EVERY_MS = 250;

type Leg = { side: "UP" | "DOWN"; price: number };
type Result = "LOCKED" | "STOP LOSS" | "TIME UP" | "NO ENTRY";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Sleeps only for what's left of the interval, so a loop runs on a steady
// schedule: a 300 ms request + 700 ms sleep = one row every 1 s.
function sleepRestOf(intervalMs: number, startedAt: number): Promise<void> {
  return sleep(Math.max(0, intervalMs - (Date.now() - startedAt)));
}

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

// New file name: the columns changed, so don't mix with older rows.
const RECORD_FILE = "prices-recorder-v3.csv";
const RECORD_EVERY_MS = 1000; // save one row every second

// ----- Live BTC price (WebSocket) -----
// Polymarket relays the Chainlink BTC/USD spot price, about one per second.
// Note: the markets resolve on Chainlink's BTC/USD TWAP-60s stream (average of
// the last 60 seconds), not on this spot price. See estimateTwap() below.
const CHAINLINK_URL = "wss://ws-live-data.polymarket.com";
const PRICE_HISTORY_MS = 2 * 60 * 1000; // keep the last 2 minutes of prices

type PriceTick = { timestamp: number; value: number };

let liveBtcPrice: number | undefined;
// Recent spot prices by Chainlink timestamp (ms), used for the TWAP estimate.
const priceHistory = new Map<number, number>();

function savePriceTick(tick: PriceTick) {
  if (!Number.isFinite(tick.value) || !Number.isFinite(tick.timestamp)) return;

  priceHistory.set(tick.timestamp, tick.value);
  liveBtcPrice = tick.value;

  // Forget prices older than PRICE_HISTORY_MS (Map keeps insertion order)
  const cutoff = Date.now() - PRICE_HISTORY_MS;
  for (const timestamp of priceHistory.keys()) {
    if (timestamp >= cutoff) break;
    priceHistory.delete(timestamp);
  }
}

// Instant TWAP-60s, computed from the spot ticks we already have.
// Tested against the official value: averaging the ticks from 61 s to 1 s
// before the newest one matches best, usually within $1 (worst seen ~$3).
function estimateTwap(): number | undefined {
  const latest = [...priceHistory.keys()].at(-1);
  if (latest === undefined) return undefined;

  let sum = 0;
  let count = 0;
  for (const [timestamp, value] of priceHistory) {
    if (timestamp > latest - 61_000 && timestamp <= latest - 1000) {
      sum += value;
      count += 1;
    }
  }

  // Not enough data yet (e.g. right after connecting)
  return count >= 50 ? sum / count : undefined;
}

function startBtcFeed() {
  const socket = new WebSocket(CHAINLINK_URL);
  let pingTimer: ReturnType<typeof setInterval> | undefined;

  socket.onopen = () => {
    console.log("BTC feed connected (Chainlink)");
    socket.send(
      JSON.stringify({
        action: "subscribe",
        subscriptions: [
          {
            topic: "crypto_prices_chainlink",
            type: "*",
            filters: JSON.stringify({ symbol: "btc/usd" }),
          },
        ],
      }),
    );
    // The server drops quiet connections, so ping every 5 seconds
    pingTimer = setInterval(() => socket.send("PING"), 5000);
  };

  // First message: { payload: { data: [ticks...] } } with the last ~minute.
  // After that, one message per price: { payload: { timestamp, value } }.
  socket.onmessage = (event) => {
    const text = String(event.data);
    if (!text.startsWith("{")) return; // empty messages and "PONG"

    const message = JSON.parse(text) as {
      payload?: { data?: PriceTick[]; timestamp?: number; value?: number };
    };
    const payload = message.payload;
    if (!payload) return;

    if (payload.data) {
      for (const tick of payload.data) savePriceTick(tick);
    } else if (payload.timestamp !== undefined && payload.value !== undefined) {
      savePriceTick({ timestamp: payload.timestamp, value: payload.value });
    }
  };

  // If the connection drops, forget the old price and reconnect after 3 seconds
  socket.onclose = () => {
    console.log("BTC feed disconnected, reconnecting in 3 seconds...");
    clearInterval(pingTimer);
    liveBtcPrice = undefined;
    setTimeout(startBtcFeed, 3000);
  };
}

// ----- Chainlink TWAP-60s (exact) -----
// Polymarket's website uses this request for "Price To Beat". It returns the
// Chainlink TWAP-60s value at any given second, the same number shown on
// data.chain.link/streams/btc-usd-twap-60s-streams.
function toIsoSeconds(ms: number): string {
  return new Date(ms).toISOString().replace(".000Z", "Z");
}

async function getChainlinkTwap(atMs: number): Promise<number | undefined> {
  const at = Math.floor(atMs / 1000) * 1000; // the API works in whole seconds

  const url = new URL("https://polymarket.com/api/crypto/crypto-price");
  url.searchParams.set("symbol", "BTC");
  url.searchParams.set("eventStartTime", toIsoSeconds(at));
  url.searchParams.set("variant", "fiveminute");
  url.searchParams.set("endDate", toIsoSeconds(at + 5 * 60 * 1000));
  url.searchParams.set("twapEnabled", "true");
  url.searchParams.set("twapLookbackSeconds", "60");

  const data = await fetchJson<{ openPrice: number | null }>(url);
  return data.openPrice ?? undefined;
}

// Start price ("price to beat") = the TWAP at the moment the market started.
async function getStartPrice(market: Market): Promise<number | undefined> {
  if (!market.eventStartTime) return undefined;
  return getChainlinkTwap(Date.parse(market.eventStartTime));
}

// The current second isn't always ready yet, so ask for 1 second ago.
const TWAP_DELAY_MS = 1000;

// Latest exact TWAP from the API and the second it belongs to.
let exactTwap: { value: number; at: number } | undefined;

// Keeps exactTwap fresh in the background, one request at a time (the API is
// slow, 0.4 s to several seconds, and gets slower if we send many at once).
async function runExactTwapPoller() {
  while (true) {
    const startedAt = Date.now();
    const at = Math.floor((startedAt - TWAP_DELAY_MS) / 1000) * 1000;

    try {
      const value = await getChainlinkTwap(at);
      if (value !== undefined) exactTwap = { value, at };
    } catch {
      // Ignore and try again next round
    }

    await sleepRestOf(1000, startedAt);
  }
}

// ----- Live order book (WebSocket) -----
// Polymarket pushes every order book change the moment it happens, so we
// always know the current best bid/ask without asking for the book each time.
const CLOB_WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";

// Latest best bid/ask per token ID
const liveQuotes = new Map<string, Quote>();

function toPrice(value: string | undefined): number | undefined {
  const price = Number(value);
  return value && Number.isFinite(price) && price > 0 ? price : undefined;
}

// Streams quotes for the given tokens until stop() is called.
function startOrderBookFeed(tokenIds: string[]): { stop: () => void } {
  let socket: WebSocket | undefined;
  let pingTimer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;

  const connect = () => {
    socket = new WebSocket(CLOB_WS_URL);

    socket.onopen = () => {
      socket?.send(JSON.stringify({ assets_ids: tokenIds, type: "market" }));
      // Keep the connection alive
      pingTimer = setInterval(() => socket?.send("PING"), 10_000);
    };

    // "book": full order book (sent on connect and after trades)
    // "price_change": one or more levels changed, includes the new best bid/ask
    socket.onmessage = (event) => {
      const text = String(event.data);
      if (!text.startsWith("{") && !text.startsWith("[")) return; // "PONG"

      const messages = [JSON.parse(text)].flat() as Array<{
        event_type?: string;
        asset_id?: string;
        bids?: Order[];
        asks?: Order[];
        price_changes?: Array<{ asset_id: string; best_bid?: string; best_ask?: string }>;
      }>;

      for (const message of messages) {
        if (message.event_type === "book" && message.asset_id) {
          liveQuotes.set(
            message.asset_id,
            getQuote({ bids: message.bids ?? [], asks: message.asks ?? [] }),
          );
        } else if (message.event_type === "price_change") {
          for (const change of message.price_changes ?? []) {
            liveQuotes.set(change.asset_id, {
              bid: toPrice(change.best_bid),
              ask: toPrice(change.best_ask),
            });
          }
        }
      }
    };

    // Reconnect unless we were told to stop. Old quotes are dropped meanwhile.
    socket.onclose = () => {
      clearInterval(pingTimer);
      for (const tokenId of tokenIds) liveQuotes.delete(tokenId);
      if (!stopped) setTimeout(connect, 1000);
    };
  };

  connect();

  return {
    stop: () => {
      stopped = true;
      socket?.close();
    },
  };
}

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
        const btcPrice = liveBtcPrice; // latest Chainlink spot price
        const twapFast = estimateTwap(); // instant, about +/- $1
        const twapExact = exactTwap; // official, a few seconds old
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
// "npm start -- record"   runs the recorder
const mode = process.argv[2];

if (mode === "watch") {
  runWatcher();
} else if (mode === "record") {
  runRecorder();
} else {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
