// ========================================
// TYPES
// ========================================

export type Market = {
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

export type PolymarketEvent = {
  title: string;
  slug: string;
  active: boolean;
  closed: boolean;
  startTime?: string;
  endDate: string;
  markets: Market[];
};

export type Order = {
  price: string;
  size: string;
};

export type OrderBook = {
  bids: Order[];
  asks: Order[];
};

// Best prices of one order book, computed once and reused.
export type Quote = {
  bid: number | undefined;
  ask: number | undefined;
};

export type DurationConfig = {
  name: string;
  seriesSlug: string;
};

export type Leg = { side: "UP" | "DOWN"; price: number };
export type Result = "LOCKED" | "STOP LOSS" | "TIME UP" | "NO ENTRY";

export type PriceTick = { timestamp: number; value: number };

// ========================================
// MARKETS
// ========================================

export const BTC_SERIES = [
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

// ========================================
// LEGGING-IN WATCHER (paper trading, no real money)
// ========================================

export const ENTRY_PRICE = 0.45; // buy leg 1 when a side costs this much or less
export const TARGET_PROFIT = 0.02; // profit we want after buying both legs
export const STOP_LOSS = 0.1; // sell leg 1 if its price drops this much
export const OBSERVE_FIRST_MS = 30_000; // just watch the market this long before any entry
export const CONFIRM_ENTRY_MS = 3000; // a side must stay cheap this long before we buy it
// Prices are pushed to us by the order book WebSocket, so a check only reads
// memory and can run often without sending any requests.
export const CHECK_EVERY_MS = 250;

// ========================================
// PRICE RECORDER
// ========================================

// New file name: the columns changed, so don't mix with older rows.
export const RECORD_FILE = "prices-recorder-v3.csv";
export const RECORD_EVERY_MS = 1000; // save one row every second

// ========================================
// LIVE FEEDS
// ========================================

// Polymarket relays the Chainlink BTC/USD spot price, about one per second.
// Note: the markets resolve on Chainlink's BTC/USD TWAP-60s stream (average of
// the last 60 seconds), not on this spot price.
export const CHAINLINK_URL = "wss://ws-live-data.polymarket.com";
export const PRICE_HISTORY_MS = 2 * 60 * 1000; // keep the last 2 minutes of prices

// The exact TWAP for the current second isn't always ready yet, so ask for 1 second ago.
export const TWAP_DELAY_MS = 1000;

// Polymarket pushes every order book change the moment it happens, so we
// always know the current best bid/ask without asking for the book each time.
export const CLOB_WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";

// ========================================
// CROWD FINGERPRINT STRATEGY (see "Poly5mBTC Bot — Crowd Fingerprint Strategy")
// ========================================

// Files
export const OUTCOMES_FILE = "window-outcomes.csv"; // official open/close TWAP per window
export const FINGERPRINT_FILE = "fingerprint.json"; // latest fit, read by the paper trader
export const SIGNALS_FILE = "fingerprint-signals.csv"; // every second that passed the signal test
export const PAPER_TRADES_FILE = "fingerprint-trades.csv"; // paper trades and their results

// Market mechanics
export const WINDOW_SECONDS = 300; // 5-minute markets
export const TWAP_WINDOW_SECONDS = 60; // w: the closing (and opening) average covers 60 s
export const FEE_RATE = 0.05; // taker fee = shares × FEE_RATE × p × (1 − p); re-check before live

// Fair value model
export const EWMA_LAMBDA = 0.97; // volatility from an EWMA of 1-second log returns
export const DEFAULT_FEED_BIAS = 0; // b, used until the first fit measures it
export const DEFAULT_FEED_NOISE = 2e-5; // s (log units, ≈ $1.2 at $60k), used until measured

// Crowd fingerprint fit
export const FIT_DAYS = 7; // refit on the last 7 days
export const REFIT_EVERY_MS = 24 * 60 * 60 * 1000; // refit once a day
export const MIN_ABS_D_OVER_SIGMA = 2; // skip snapshots where d/σ is near zero (my choice)
export const FIT_MIN_PRICE = 0.03; // only fit prices between 0.03 and 0.97
export const FIT_MAX_PRICE = 0.97;
export const MIN_FIT_POINTS = 50; // fewer points than this = no fit for that bucket
export const CONVERGED_TOLERANCE = 0.1; // k and α within 10% of truth = edge gone

// Trading rules
export const NO_TRADE_FIRST_SECONDS = 60; // rule 1: no trades in the first 60 s
export const MIN_Z_GAP = 0.25;
export const MIN_EDGE = 0.01; // per share, after fees
export const KELLY_FRACTION = 1 / 8;
export const MAX_PER_TRADE = 5; // dollars
export const SKIP_WINDOWS_ET = ["08:30", "09:30"]; // windows starting at these ET times
export const JUMP_SIGMAS = 4; // a 1-second move above 4σ is a jump...
export const JUMP_COOLDOWN_MS = 30_000; // ...and blocks entries for 30 s

// Risk limits (paper money for now)
export const BANKROLL = 200;
export const DAILY_LOSS_LIMIT = 20; // stop for the rest of the UTC day
export const MAX_DRAWDOWN = 100; // end the experiment
export const STALE_PRICE_MS = 2000; // no BTC price for 2 s = pause
export const FEED_GAP_NOISE_MULTIPLE = 3; // our TWAP vs Chainlink's off by > 3 × s = pause

// Experiment gates
export const PHASE1_MIN_WINDOWS = 8000;
export const PHASE3_MIN_SIGNALS = 300;
