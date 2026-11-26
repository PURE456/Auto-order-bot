// The math of the Crowd Fingerprint strategy: fair value, the crowd's model,
// the fit, fees, sizing and the entry signal. No network or files here.

import {
  CONVERGED_TOLERANCE,
  EWMA_LAMBDA,
  FEE_RATE,
  FIT_MAX_PRICE,
  FIT_MIN_PRICE,
  JUMP_LOOKBACK_SECONDS,
  JUMP_SIGMAS,
  KELLY_FRACTION,
  MIN_ABS_D_OVER_SIGMA,
  MIN_EDGE,
  MIN_FIT_POINTS,
  MIN_Z_GAP,
  MODEL_WEIGHT,
  TWAP_WINDOW_SECONDS,
} from "../config.js";

// ========================================
// NORMAL DISTRIBUTION
// ========================================

// Φ(x): standard normal CDF (Abramowitz & Stegun 7.1.26, error < 1.5e-7)
export function normCdf(x: number): number {
  const t = 1 / (1 + (0.3275911 * Math.abs(x)) / Math.SQRT2);
  const poly =
    t *
    (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-(x * x) / 2);
  return x >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

// Φ⁻¹(p): inverse normal CDF (Acklam's algorithm, relative error < 1.2e-9)
export function normInv(p: number): number {
  const q = Math.min(Math.max(p, 1e-9), 1 - 1e-9); // avoid ±infinity at 0 and 1
  const a = [
    -39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716,
    2.506628277459239,
  ];
  const b = [
    -54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972,
    -13.28068155288572,
  ];
  const c = [
    -0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734,
    4.374664141464968, 2.938163982698783,
  ];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const [a0, a1, a2, a3, a4, a5] = a as [number, number, number, number, number, number];
  const [b0, b1, b2, b3, b4] = b as [number, number, number, number, number];
  const [c0, c1, c2, c3, c4, c5] = c as [number, number, number, number, number, number];
  const [d0, d1, d2, d3] = d as [number, number, number, number];

  if (q < 0.02425) {
    const r = Math.sqrt(-2 * Math.log(q));
    return (
      (((((c0 * r + c1) * r + c2) * r + c3) * r + c4) * r + c5) /
      ((((d0 * r + d1) * r + d2) * r + d3) * r + 1)
    );
  }
  if (q > 1 - 0.02425) {
    const r = Math.sqrt(-2 * Math.log(1 - q));
    return (
      -(((((c0 * r + c1) * r + c2) * r + c3) * r + c4) * r + c5) /
      ((((d0 * r + d1) * r + d2) * r + d3) * r + 1)
    );
  }
  const r = q - 0.5;
  const r2 = r * r;
  return (
    ((((((a0 * r2 + a1) * r2 + a2) * r2 + a3) * r2 + a4) * r2 + a5) * r) /
    (((((b0 * r2 + b1) * r2 + b2) * r2 + b3) * r2 + b4) * r2 + 1)
  );
}

// ========================================
// FEES AND SIZING
// ========================================

// Taker fee per share: 0.05 × p × (1 − p)
export function takerFeePerShare(price: number): number {
  return FEE_RATE * price * (1 - price);
}

// c = ask + fee: what one share really costs
export function costPerShare(ask: number): number {
  return ask + takerFeePerShare(ask);
}

// f = 1/8 × (P − c) / (1 − c): share of the bankroll to bet
export function kellyFraction(probability: number, cost: number): number {
  return Math.max(0, (KELLY_FRACTION * (probability - cost)) / (1 - cost));
}

// ========================================
// VOLATILITY (EWMA of 1-second log returns)
// ========================================

export class VolatilityTracker {
  private variance: number | undefined; // per second, in log units
  private warmup: number[] = [];
  private last: { t: number; price: number } | undefined;
  private recent: { t: number; price: number }[] = []; // last few seconds, for jumps

  // σ per √second, or undefined until 30 returns have been seen
  get sigma(): number | undefined {
    return this.variance === undefined ? undefined : Math.sqrt(this.variance);
  }

  // Feeds one price. Returns true if the move over any of the last few
  // seconds was a jump (> 4σ√dt). One price to the next is not enough: a fast
  // move spread over several prices would pass unnoticed.
  update(t: number, price: number): boolean {
    const last = this.last;
    this.last = { t, price };
    if (!last) {
      this.recent = [{ t, price }];
      return false;
    }

    const dt = (t - last.t) / 1000;
    // A long gap (reconnect, missing data) breaks the series: start over
    if (dt <= 0 || dt > 10) {
      this.variance = undefined;
      this.warmup = [];
      this.recent = [{ t, price }];
      return false;
    }

    const r = Math.log(price / last.price);
    const perSecond = (r * r) / dt;
    const sigmaBefore = this.sigma;

    this.recent = this.recent.filter((old) => t - old.t <= JUMP_LOOKBACK_SECONDS * 1000);
    const isJump =
      sigmaBefore !== undefined &&
      this.recent.some(
        (old) =>
          Math.abs(Math.log(price / old.price)) >
          JUMP_SIGMAS * sigmaBefore * Math.sqrt((t - old.t) / 1000),
      );
    this.recent.push({ t, price });

    if (this.variance === undefined) {
      // Plain average of the first 30 returns, then switch to EWMA
      this.warmup.push(perSecond);
      if (this.warmup.length >= 30) {
        this.variance = this.warmup.reduce((sum, v) => sum + v, 0) / this.warmup.length;
      }
    } else {
      this.variance = EWMA_LAMBDA * this.variance + (1 - EWMA_LAMBDA) * perSecond;
    }

    return isJump;
  }
}

// ========================================
// FAIR VALUE
// ========================================

const W = TWAP_WINDOW_SECONDS;

// d = ln(price now / opening TWAP). In the closing window, "price now" is the
// expected closing average: the average so far blended with the current price.
export function computeD(
  openTwap: number,
  spot: number,
  secondsLeft: number,
  closingAverageSoFar: number | undefined,
): number {
  if (secondsLeft > W || closingAverageSoFar === undefined) {
    return Math.log(spot / openTwap);
  }
  const r = Math.max(0, secondsLeft);
  const expectedClose = ((W - r) * closingAverageSoFar + r * spot) / W;
  return Math.log(expectedClose / openTwap);
}

// σ_eff²: before the closing window σ²(t₁ + w/3); inside it σ²(r/w)²(r/3)
export function effectiveVariance(sigma: number, secondsLeft: number): number {
  if (secondsLeft > W) {
    const t1 = secondsLeft - W;
    return sigma * sigma * (t1 + W / 3);
  }
  const r = Math.max(0, secondsLeft);
  return sigma * sigma * (r / W) ** 2 * (r / 3);
}

// P_true(Up) = Φ((d − b) / √(σ_eff² + s²))
export function trueProbabilityUp(d: number, varianceEff: number, b: number, s: number): number {
  return normCdf((d - b) / Math.sqrt(varianceEff + s * s));
}

// ========================================
// CROWD FINGERPRINT FIT
// ========================================

export type PowerFit = { k: number; alpha: number; n: number };

export type BucketFit = { crowd: PowerFit | undefined; truth: PowerFit | undefined };

export type Fingerprint = {
  fittedAt: string;
  fromTime: string;
  toTime: string;
  windows: number;
  b: number;
  s: number;
  early: BucketFit; // τ > 60 s
  late: BucketFit; // τ ≤ 60 s
  bias: { early: boolean; late: boolean };
  converged: boolean;
};

export type FitPoint = { tau: number; dOverSigma: number; probability: number };

// Fits p = Φ(k · (d/σ) / τ^α) as a straight line:
// ln(Φ⁻¹(p) / (d/σ)) = ln k − α ln τ
export function fitPowerModel(points: FitPoint[]): PowerFit | undefined {
  const xs: number[] = [];
  const ys: number[] = [];

  for (const { tau, dOverSigma, probability } of points) {
    if (tau <= 0) continue;
    if (Math.abs(dOverSigma) < MIN_ABS_D_OVER_SIGMA) continue;
    if (probability < FIT_MIN_PRICE || probability > FIT_MAX_PRICE) continue;
    const ratio = normInv(probability) / dOverSigma;
    if (!(ratio > 0)) continue; // price and d point opposite ways: log undefined
    xs.push(Math.log(tau));
    ys.push(Math.log(ratio));
  }

  const n = xs.length;
  if (n < MIN_FIT_POINTS) return undefined;

  const meanX = xs.reduce((s, x) => s + x, 0) / n;
  const meanY = ys.reduce((s, y) => s + y, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    const dx = (xs[i] ?? 0) - meanX;
    sxy += dx * ((ys[i] ?? 0) - meanY);
    sxx += dx * dx;
  }
  if (sxx === 0) return undefined;

  const slope = sxy / sxx; // = −α
  return { k: Math.exp(meanY - slope * meanX), alpha: -slope, n };
}

function within(value: number, target: number): boolean {
  return Math.abs(value / target - 1) <= CONVERGED_TOLERANCE;
}

// Reads the fit: where does the crowd differ from the truth?
export function judgeFit(
  early: BucketFit,
  late: BucketFit,
): Fingerprint["bias"] & { converged: boolean } {
  // Late: crowd thinks uncertainty shrinks slower than it does (α too small)
  const lateBias =
    !!late.crowd && !!late.truth && late.crowd.alpha < late.truth.alpha * (1 - CONVERGED_TOLERANCE);
  // Early: crowd is more confident than the truth (k too large)
  const earlyBias =
    !!early.crowd && !!early.truth && early.crowd.k > early.truth.k * (1 + CONVERGED_TOLERANCE);

  // Death detector: every fitted bucket has k and α within 10% of the truth
  const fitted = [early, late].filter((bucket) => bucket.crowd && bucket.truth);
  const converged =
    fitted.length > 0 &&
    fitted.every(
      (bucket) =>
        within(bucket.crowd!.k, bucket.truth!.k) &&
        within(bucket.crowd!.alpha, bucket.truth!.alpha),
    );

  return { early: earlyBias, late: lateBias, converged };
}

// ========================================
// SIGNAL
// ========================================

export type Side = "UP" | "DOWN";

export type Signal = {
  bucket: "early" | "late";
  zGap: number;
  side: Side;
  modelProbability: number; // P_true of the side we'd buy, from the model alone
  probability: number; // model blended with the market: used for edge and size
  ask: number;
  cost: number; // ask + fee
  edge: number; // P − c
  biasMatches: boolean; // the latest fit found a bias that calls for this side
};

// Compares truth with the market. Returns a signal only when |z_gap| and the
// edge after fees are both large enough (rule 3, minus the bias check, which is
// reported in `biasMatches`).
export function evaluateSignal(input: {
  secondsLeft: number;
  pTrueUp: number;
  upBid: number;
  upAsk: number;
  downBid: number;
  downAsk: number;
  bias: Fingerprint["bias"] | undefined;
}): Signal | undefined {
  const { secondsLeft, pTrueUp, upBid, upAsk, downBid, downAsk, bias } = input;

  const upMid = (upBid + upAsk) / 2;
  const zMarket = normInv(upMid);
  const zGap = normInv(pTrueUp) - zMarket;
  if (Math.abs(zGap) < MIN_Z_GAP) return undefined;

  const bucket = secondsLeft > TWAP_WINDOW_SECONDS ? "early" : "late";

  // The model is right on average, but not when it disagrees with the market:
  // there the truth is in between. So only part of the gap counts as edge.
  const blendedUp = normCdf(zMarket + MODEL_WEIGHT[bucket] * zGap);

  // Truth above the market: Up is too cheap. Below: Down is too cheap.
  const side: Side = zGap > 0 ? "UP" : "DOWN";
  const modelProbability = side === "UP" ? pTrueUp : 1 - pTrueUp;
  const probability = side === "UP" ? blendedUp : 1 - blendedUp;
  const ask = side === "UP" ? upAsk : downAsk;
  const sideMid = side === "UP" ? upMid : (downBid + downAsk) / 2;
  const cost = costPerShare(ask);
  const edge = probability - cost;
  if (edge < MIN_EDGE) return undefined;

  const biasMatches =
    bucket === "late"
      ? !!bias?.late && sideMid > 0.5 // late bias → buy the leading side
      : !!bias?.early && sideMid < 0.5; // early bias → buy the cheaper side

  return { bucket, zGap, side, modelProbability, probability, ask, cost, edge, biasMatches };
}
