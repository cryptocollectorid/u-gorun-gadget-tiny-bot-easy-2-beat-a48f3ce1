// Tiny Bot: three ways in, four ways out. Long only, no network, no clock, no
// randomness — every decision comes from the bars the harness hands it.
//
// Entries, per symbol, when it holds nothing:
//   1. Trend: EMA(8) crosses above EMA(21) while the close sits above EMA(30)
//      (the trend filter: no buying into a downtrend's dead-cat bounce).
//   2. Dip: MACD(12, 26) above its signal(9) and CCI(14) at or under -48 — the
//      oversold dip inside an uptrend, which is where a falling market still pays.
//   3. Fast: EMA(6) crosses above EMA(15) while the close sits above EMA(30),
//      at a quarter stake — a smaller, quicker entry that keeps the bot trading
//      through quiet stretches where the slow pair barely crosses at all.
//
// Exits, the whole position: EMA(8) crosses below EMA(21) (the sell signal
// holds while EMA(21) stays above, so a refused sell is sent again), or a 3%
// trailing stop below the position's peak value, or +4% take-profit, or a -8%
// hard stop. Sizing is equity over one slot per symbol, capped at 25% of equity.
//
// Indicators follow the kit baselines' conventions: each EMA starts as the mean
// of its first span of closes, then moves 2 / (span + 1) of the way to each new
// close; MACD is EMA(12) - EMA(26) with EMA(26) seeded on the mean of the first
// 26 closes and EMA(12) on the mean of the 12 closes up to that bar, its signal
// the mean of the first 9 MACD values; CCI(14) is over the typical price
// (h + l + c) / 3. A bar whose volume is 0 signals nothing. All arithmetic is
// float64 on the raw bar values (one scale per symbol, so every comparison is
// scale-free), and the exit thresholds are exact bigint ratios on value/cost.

import { BPS, runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const FAST_BARS = 8;
const SLOW_BARS = 21;
const TREND_BARS = 30;
const QUICK_BARS = 6;
const QUICK_SLOW_BARS = 15;
const MACD_FAST = 12;
const MACD_SLOW = 26;
const MACD_SIGNAL = 9;
const CCI_BARS = 14;
/** CCI at or under this is an oversold dip worth buying. */
const DIP_CCI = -48;
/** Take-profit: worth 104/100 of its cost. */
const TP = [104n, 100n] as const;
/** Hard stop: worth 92/100 of its cost. */
const STOP = [92n, 100n] as const;
/** Trailing stop: worth 97/100 of the position's peak value. */
const TRAIL = [97n, 100n] as const;
/** A fast entry risks a quarter of a full stake. */
const QUICK_STAKE_DIV = 4n;
const MAX_SLIPPAGE_BPS = 100;

/** One EMA: the closes it has seen until it starts, then its value. */
interface Ema {
  span: number;
  warm: number[];
  value: number | null;
}

/** Everything tracked for one symbol. */
interface Series {
  fast: Ema;
  slow: Ema;
  trend: Ema;
  quick: Ema;
  quickSlow: Ema;
  /** fast - slow after the symbol's bar before this one, once both are set. */
  gap: number | null;
  /** The same after this bar. */
  now: number | null;
  /** quick - quickSlow after the bar before, once both are set. */
  quickGap: number | null;
  /** The same after this bar. */
  quickNow: number | null;
  /** The sell signal: set on a cross of EMA(21) above EMA(8), held while it stays above. */
  down: boolean;
  /** Highest value a held position has reached, for the trailing stop. */
  peak: bigint;
  /** MACD warm-up closes, then its two EMAs. */
  macdWarm: number[];
  macdFast: number | null;
  macdSlow: number | null;
  macdValues: number[];
  macdSignal: number | null;
  /** Last CCI_BARS typical prices, oldest first. */
  typical: number[];
}

const series = new Map<string, Series>();

function newEma(span: number): Ema {
  return { span, warm: [], value: null };
}

function step(e: Ema, close: number): void {
  if (e.value !== null) {
    e.value += (2 / (e.span + 1)) * (close - e.value);
    return;
  }
  e.warm.push(close);
  if (e.warm.length === e.span) e.value = e.warm.reduce((a, x) => a + x, 0) / e.span;
}

function push(bar: Bar): Series {
  let s = series.get(bar.symbol);
  if (s === undefined) {
    s = {
      fast: newEma(FAST_BARS), slow: newEma(SLOW_BARS), trend: newEma(TREND_BARS),
      quick: newEma(QUICK_BARS), quickSlow: newEma(QUICK_SLOW_BARS),
      gap: null, now: null, quickGap: null, quickNow: null, down: false, peak: 0n,
      macdWarm: [], macdFast: null, macdSlow: null, macdValues: [], macdSignal: null,
      typical: [],
    };
    series.set(bar.symbol, s);
  }
  const c = Number(bar.c);
  step(s.fast, c);
  step(s.slow, c);
  step(s.trend, c);
  step(s.quick, c);
  step(s.quickSlow, c);
  s.gap = s.now;
  s.now = s.fast.value !== null && s.slow.value !== null ? s.fast.value - s.slow.value : null;
  if (s.now === null || s.now >= 0) s.down = false;
  s.quickGap = s.quickNow;
  s.quickNow = s.quick.value !== null && s.quickSlow.value !== null ? s.quick.value - s.quickSlow.value : null;
  // MACD, seeded the way TA-Lib does: slow on the mean of the first 26 closes,
  // fast on the mean of the 12 closes up to that bar, signal on the mean of the
  // first 9 MACD values.
  if (s.macdSlow === null || s.macdFast === null) {
    s.macdWarm.push(c);
    if (s.macdWarm.length === MACD_SLOW) {
      s.macdSlow = s.macdWarm.reduce((a, x) => a + x, 0) / MACD_SLOW;
      s.macdFast = s.macdWarm.slice(MACD_SLOW - MACD_FAST).reduce((a, x) => a + x, 0) / MACD_FAST;
    }
  } else {
    s.macdFast = s.macdFast + (2 / (MACD_FAST + 1)) * (c - s.macdFast);
    s.macdSlow = s.macdSlow + (2 / (MACD_SLOW + 1)) * (c - s.macdSlow);
  }
  if (s.macdSlow !== null && s.macdFast !== null) {
    const macd = s.macdFast - s.macdSlow;
    if (s.macdSignal !== null) {
      s.macdSignal = s.macdSignal + (2 / (MACD_SIGNAL + 1)) * (macd - s.macdSignal);
    } else {
      s.macdValues.push(macd);
      if (s.macdValues.length === MACD_SIGNAL) {
        s.macdSignal = s.macdValues.reduce((a, x) => a + x, 0) / MACD_SIGNAL;
      }
    }
  }
  const typical = (Number(bar.h) + Number(bar.l) + c) / 3;
  s.typical.push(typical);
  if (s.typical.length > CCI_BARS) s.typical.shift();
  return s;
}

/** Whether a held position exits on this close: the sell signal holding, the
 * trailing stop, the take-profit, or the hard stop. Exact bigint ratios, so a
 * position that should leave keeps signalling until its sell actually fills. */
function shouldExit(state: BarsState, symbol: string, held: { qty: bigint; cost: bigint }, s: Series): boolean {
  const value = state.value(symbol, held.qty);
  if (value > s.peak) s.peak = value;
  if (s.down) return true;
  if (value * TRAIL[1] <= s.peak * TRAIL[0]) return true;
  if (value * TP[1] >= held.cost * TP[0]) return true;
  return value * STOP[1] <= held.cost * STOP[0];
}
/** CCI(14) of the symbol's latest bar, or null while it has fewer than 14 typicals. */
function cci(s: Series): number | null {
  if (s.typical.length < CCI_BARS) return null;
  const mean = s.typical.reduce((a, x) => a + x, 0) / CCI_BARS;
  const spread = s.typical.reduce((a, x) => a + Math.abs(x - mean), 0);
  const dev = s.typical[s.typical.length - 1] - mean;
  if (dev === 0 || spread === 0) return 0;
  return dev / (0.015 * (spread / CCI_BARS));
}

await runBars({
  onBatch(state, batch) {
    const crossUp = new Set<string>();
    const dipUp = new Set<string>();
    const quickUp = new Set<string>();
    const fresh = new Set<string>();
    for (const bar of batch.bars) {
      const s = push(bar);
      fresh.add(bar.symbol);
      if (bar.v === '0') continue;
      if (s.gap !== null && s.now !== null) {
        if (s.now > 0 && s.gap <= 0) crossUp.add(bar.symbol);
        if (s.now < 0 && s.gap >= 0) s.down = true;
      }
      if (s.quickGap !== null && s.quickNow !== null && s.quickNow > 0 && s.quickGap <= 0) {
        quickUp.add(bar.symbol);
      }
      const macd = s.macdFast !== null && s.macdSlow !== null ? s.macdFast - s.macdSlow : null;
      const c = cci(s);
      if (macd !== null && s.macdSignal !== null && c !== null && macd > s.macdSignal && c <= DIP_CCI) {
        dipUp.add(bar.symbol);
      }
    }
    if (state.warmingUp) return [];
    const { caps, fees } = state.hello;
    const sells: SellInput[] = [];
    const entries: { symbol: string; quick: boolean }[] = [];
    for (const { symbol } of state.hello.symbols) {
      if (!fresh.has(symbol)) continue;
      const s = series.get(symbol)!;
      const held = state.positions.get(symbol);
      if (held !== undefined) {
        if (shouldExit(state, symbol, held, s)) {
          sells.push({ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
        }
      } else {
        const close = state.close(symbol);
        const aboveTrend = close !== null && s.trend.value !== null && Number(close) > s.trend.value;
        if (crossUp.has(symbol) && aboveTrend) entries.push({ symbol, quick: false });
        else if (dipUp.has(symbol)) entries.push({ symbol, quick: false });
        else if (quickUp.has(symbol) && aboveTrend) entries.push({ symbol, quick: true });
      }
    }

    const orders: (SellInput | BuyInput)[] = sells.slice(0, caps.max_orders_per_bar);
    const slots = Math.min(state.hello.symbols.length, caps.max_open_positions);
    const stake = state.equity / BigInt(slots);
    const byWeight = (BigInt(caps.max_weight_bps) * state.equity) / BPS;
    let room = slots - state.positions.size;
    let cash = state.cash;
    for (const { symbol, quick } of entries) {
      if (room <= 0 || orders.length >= caps.max_orders_per_bar) break;
      let slice = quick ? stake / QUICK_STAKE_DIV : stake;
      if (slice > byWeight) slice = byWeight;
      if (cash < slice) slice = cash;
      if (slice === 0n || slice < BigInt(fees.min_notional_quote_units)) break;
      orders.push({ side: 'buy', symbol, notional_quote_units: slice, max_slippage_bps: MAX_SLIPPAGE_BPS });
      series.get(symbol)!.peak = 0n;
      cash -= slice;
      room--;
    }
    return orders;
  },
});
