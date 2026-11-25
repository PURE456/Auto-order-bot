// Shared data sources: Polymarket market list, Chainlink BTC prices and order books.
// Used by the scanner, the watcher, the recorder and the fingerprint strategy.

import {
  CHAINLINK_URL,
  CLOB_WS_URL,
  PRICE_HISTORY_MS,
  TWAP_DELAY_MS,
  type DurationConfig,
  type Market,
  type Order,
  type OrderBook,
  type PolymarketEvent,
  type PriceTick,
  type Quote,
} from "./config.js";

// ========================================
// HELPERS
// ========================================

export async function fetchJson<T>(url: URL): Promise<T> {
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

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Sleeps only for what's left of the interval, so a loop runs on a steady
// schedule: a 300 ms request + 700 ms sleep = one row every 1 s.
export function sleepRestOf(intervalMs: number, startedAt: number): Promise<void> {
  return sleep(Math.max(0, intervalMs - (Date.now() - startedAt)));
}

// ========================================
// MARKETS (Gamma API)
// ========================================

export async function findCurrentMarket(config: DurationConfig): Promise<Market | undefined> {
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

// Finds the token IDs for the Up and Down outcomes.
export function getUpDownTokens(market: Market): { upToken: string; downToken: string } {
  const outcomes = parseStringArray(market.outcomes);
  const tokenIds = parseStringArray(market.clobTokenIds);

  const upIndex = outcomes.indexOf("Up");
  const downIndex = outcomes.indexOf("Down");

  if (upIndex === -1 || downIndex === -1 || !tokenIds[upIndex] || !tokenIds[downIndex]) {
    throw new Error("Could not identify Up/Down tokens.");
  }

  return { upToken: tokenIds[upIndex], downToken: tokenIds[downIndex] };
}

// ========================================
// ORDER BOOKS
// ========================================

export async function fetchOrderBook(tokenId: string): Promise<OrderBook> {
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

export function getQuote(book: OrderBook): Quote {
  return { bid: getBestBid(book.bids), ask: getBestAsk(book.asks) };
}

// ----- Live order book (WebSocket) -----
// Polymarket pushes every order book change the moment it happens, so we
// always know the current best bid/ask without asking for the book each time.
// Latest best bid/ask per token ID
export const liveQuotes = new Map<string, Quote>();

function toPrice(value: string | undefined): number | undefined {
  const price = Number(value);
  return value && Number.isFinite(price) && price > 0 ? price : undefined;
}

// Streams quotes for the given tokens until stop() is called.
export function startOrderBookFeed(tokenIds: string[]): { stop: () => void } {
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

// ========================================
// CHAINLINK BTC PRICE (WebSocket)
// ========================================

// Polymarket relays the Chainlink BTC/USD spot price, about one per second.
// Note: the markets resolve on Chainlink's BTC/USD TWAP-60s stream (average of
// the last 60 seconds), not on this spot price. See twapAt() below.
let liveBtcPrice: number | undefined;
let lastTickReceivedAt = 0; // our clock (ms) when the last new price arrived
let lastTickTimestamp = 0; // Chainlink's timestamp (ms) of the last price
// Recent spot prices by Chainlink timestamp (ms), used for the TWAP estimate.
const priceHistory = new Map<number, number>();
const tickListeners: Array<(tick: PriceTick) => void> = [];

export function getLiveBtcPrice(): number | undefined {
  return liveBtcPrice;
}

export function getLastTickReceivedAt(): number {
  return lastTickReceivedAt;
}

// Calls `listener` once for every new price, in time order.
export function onPriceTick(listener: (tick: PriceTick) => void) {
  tickListeners.push(listener);
}

// Prices with Chainlink timestamps in [fromMs, toMs].
export function getPricesBetween(fromMs: number, toMs: number): number[] {
  const prices: number[] = [];
  for (const [timestamp, value] of priceHistory) {
    if (timestamp >= fromMs && timestamp <= toMs) prices.push(value);
  }
  return prices;
}

function savePriceTick(tick: PriceTick) {
  if (!Number.isFinite(tick.value) || !Number.isFinite(tick.timestamp)) return;
  // The first message repeats the last minute; ignore prices we already have
  if (tick.timestamp <= lastTickTimestamp) return;

  lastTickTimestamp = tick.timestamp;
  lastTickReceivedAt = Date.now();
  priceHistory.set(tick.timestamp, tick.value);
  liveBtcPrice = tick.value;

  for (const listener of tickListeners) listener(tick);

  // Forget prices older than PRICE_HISTORY_MS (Map keeps insertion order)
  const cutoff = Date.now() - PRICE_HISTORY_MS;
  for (const timestamp of priceHistory.keys()) {
    if (timestamp >= cutoff) break;
    priceHistory.delete(timestamp);
  }
}

// Our TWAP-60s for second `atMs`: the average of the ticks from 61 s to 1 s
// before it. Tested against the official value: usually within $1.
export function twapAt(atMs: number): number | undefined {
  const prices = getPricesBetween(atMs - 61_000 + 1, atMs - 1000);
  // Not enough data yet (e.g. right after connecting)
  return prices.length >= 50 ? prices.reduce((sum, p) => sum + p, 0) / prices.length : undefined;
}

// Instant TWAP-60s as of the newest tick.
export function estimateTwap(): number | undefined {
  return lastTickTimestamp ? twapAt(lastTickTimestamp) : undefined;
}

export function startBtcFeed() {
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

// ========================================
// CHAINLINK TWAP-60s (exact, via Polymarket's website API)
// ========================================

// Polymarket's website uses this request for "Price To Beat". It returns the
// Chainlink TWAP-60s value at any given second, the same number shown on
// data.chain.link/streams/btc-usd-twap-60s-streams.
function toIsoSeconds(ms: number): string {
  return new Date(ms).toISOString().replace(".000Z", "Z");
}

type CryptoPriceResponse = {
  openPrice: number | null;
  closePrice: number | null;
  completed?: boolean;
};

async function fetchCryptoPrice(startMs: number, endMs: number): Promise<CryptoPriceResponse> {
  const url = new URL("https://polymarket.com/api/crypto/crypto-price");
  url.searchParams.set("symbol", "BTC");
  url.searchParams.set("eventStartTime", toIsoSeconds(startMs));
  url.searchParams.set("variant", "fiveminute");
  url.searchParams.set("endDate", toIsoSeconds(endMs));
  url.searchParams.set("twapEnabled", "true");
  url.searchParams.set("twapLookbackSeconds", "60");

  return fetchJson<CryptoPriceResponse>(url);
}

export async function getChainlinkTwap(atMs: number): Promise<number | undefined> {
  const at = Math.floor(atMs / 1000) * 1000; // the API works in whole seconds
  const data = await fetchCryptoPrice(at, at + 5 * 60 * 1000);
  return data.openPrice ?? undefined;
}

// Start price ("price to beat") = the TWAP at the moment the market started.
export async function getStartPrice(market: Market): Promise<number | undefined> {
  if (!market.eventStartTime) return undefined;
  return getChainlinkTwap(Date.parse(market.eventStartTime));
}

// Official opening and closing TWAP of a finished window, or undefined if it
// isn't settled yet. Up wins if close >= open. Only works for the last 30 days.
export async function getWindowResult(
  startMs: number,
  endMs: number,
): Promise<{ open: number; close: number } | undefined> {
  const data = await fetchCryptoPrice(startMs, endMs);
  if (!data.completed || data.openPrice === null || data.closePrice === null) return undefined;
  return { open: data.openPrice, close: data.closePrice };
}

// Latest exact TWAP from the API and the second it belongs to.
let exactTwap: { value: number; at: number } | undefined;
let exactPollerRunning = false;

export function getExactTwap(): { value: number; at: number } | undefined {
  return exactTwap;
}

// Keeps exactTwap fresh in the background, one request at a time (the API is
// slow, 0.4 s to several seconds, and gets slower if we send many at once).
export async function runExactTwapPoller() {
  if (exactPollerRunning) return;
  exactPollerRunning = true;

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
