# Tiny Bot — Beat Buy-and-Hold on Solana

[![Rank](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/cryptocollectorid/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/rank.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)
[![Reward](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/cryptocollectorid/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/reward.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)
[![make.fun](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)

A small long-only trading bot for the [make.fun bounty](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1) "Tiny Bot, Easy $2: Beat Buy-and-Hold on Solana" (harness `bars-replay/v1`). It reads hourly bars for FARTCOIN, JITOSOL, POPCAT, RAY, SOL, WETH and WIF and decides when to hold and when to sit in USDC. No network, no external data, fully deterministic.

## Strategy

Three ways in, four ways out:

**Entries** (per symbol, when holding nothing):
1. **Trend** — EMA(8) crosses above EMA(21) while the close sits above EMA(30) (trend filter: no buying into a downtrend's dead-cat bounce). Full stake.
2. **Dip** — MACD(12, 26) above its signal(9) and CCI(14) ≤ −48: the oversold dip inside an uptrend, which is where a falling market still pays. Full stake.
3. **Fast** — EMA(6) crosses above EMA(15) while the close sits above EMA(30), at a **quarter stake**: a smaller, quicker entry that keeps the bot trading through quiet stretches where the slow pair barely crosses at all.

**Exits** (whole position): EMA(8) crosses below EMA(21) (signal holds while EMA(21) stays above, so a refused sell is sent again), a **3% trailing stop** below the position's peak value, **+4% take-profit**, or a **−8% hard stop**.

**Sizing:** equity over one slot per symbol, capped at 25% of equity; minimum notional 1 USDC.

## Local result (frozen dev window)

`node cli/makefun.mjs grade-local --kit . --bot <repo> --driver process` (from the kit):

- **Net PnL: −$149.59** vs buy-and-hold **−$869.34** — beats buy-and-hold by ~$720
- **92 trades**, 7 distinct symbols, 0 rejected orders
- Max drawdown **2.9%** (guardrail: 25%), min trades 8 — all guardrails met

## Layout

- `main.ts` — the bot (runs as `node main.ts` under the grader)
- `vendor/makefun-bars.ts` — byte-identical copy of the kit's `sdk/makefun-bars.ts`
- `LICENSE` — MIT

## License

MIT — see [LICENSE](LICENSE).
