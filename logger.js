/**
 * POLY // EDGE — Trade Logger
 * Every alert that fires gets recorded here automatically.
 * This is the audit trail for the paper trading validation phase.
 */

import fs from "fs";

const TRADES_FILE = "./trades.json";

// ─── LOAD / SAVE ────────────────────────────────────────────────────────────
export function loadTrades() {
  try {
    return JSON.parse(fs.readFileSync(TRADES_FILE, "utf8"));
  } catch {
    return { trades: [], meta: { created: new Date().toISOString(), version: "1.0" } };
  }
}

export function saveTrades(data) {
  fs.writeFileSync(TRADES_FILE, JSON.stringify(data, null, 2));
}

// ─── LOG A NEW PAPER TRADE ──────────────────────────────────────────────────
// Called every time the scanner fires an alert.
// Returns the trade ID so it can be referenced later.
export function logTrade(data, market, signalType, extraFields = {}) {
  const tradeId = `${signalType}_${market.id}_${Date.now()}`;

  const trade = {
    id:            tradeId,
    marketId:      market.id,
    question:      market.question,
    slug:          market.slug || "",
    category:      market.category || "Unknown",
    signalType,                           // "edge" | "newslag" | "correlation"
    direction:     market.direction,      // "YES" | "NO"
    entryPrice:    market.betPrice,       // Price at alert time
    impliedReturn: market.returnPct,      // % return if correct
    edgeScore:     market.edgeScore || 0,
    endDate:       market.endDate,
    daysLeft:      market.daysLeft,
    volume:        market.volume,
    liquidity:     market.liquidity,
    alertedAt:     new Date().toISOString(),
    status:        "PENDING",             // PENDING | WIN | LOSS | VOID
    outcome:       null,                  // "YES" | "NO" (filled on resolution)
    resolvedAt:    null,
    paperPnl:      null,                  // +1.0 = full win, 0 = full loss on $1 unit
    notes:         "",
    ...extraFields,
  };

  data.trades.push(trade);
  saveTrades(data);

  console.log(`  [LOG] Trade logged: ${tradeId}`);
  return tradeId;
}

// ─── LOG A CORRELATION PAIR ─────────────────────────────────────────────────
// Correlations involve two markets -- logged as a single observation.
export function logCorrelationTrade(data, pair) {
  const tradeId = `corr_${pair.a.id}_${pair.b.id}_${Date.now()}`;

  const trade = {
    id:          tradeId,
    marketId:    `${pair.a.id}+${pair.b.id}`,
    question:    `[CORR] ${pair.a.question.slice(0, 60)} vs ${pair.b.question.slice(0, 60)}`,
    category:    pair.category,
    signalType:  "correlation",
    direction:   "OBSERVE",              // Correlation is an observation flag, not a directional bet
    entryPriceA: pair.a.price,
    entryPriceB: pair.b.price,
    pricingGap:  pair.gap,
    alertedAt:   new Date().toISOString(),
    status:      "PENDING",
    outcome:     null,
    resolvedAt:  null,
    paperPnl:    null,
    notes:       `${pair.category} gap of ${pair.gap.toFixed(1)}pts at alert time`,
  };

  data.trades.push(trade);
  saveTrades(data);

  console.log(`  [LOG] Correlation trade logged: ${tradeId}`);
  return tradeId;
}

// ─── STATS SNAPSHOT ─────────────────────────────────────────────────────────
// Quick summary of current paper trading state.
export function getStats(data) {
  const all      = data.trades;
  const resolved = all.filter(t => t.status === "WIN" || t.status === "LOSS");
  const wins     = resolved.filter(t => t.status === "WIN");
  const pending  = all.filter(t => t.status === "PENDING");

  const hitRate  = resolved.length > 0
    ? (wins.length / resolved.length) * 100
    : null;

  const paperPnl = resolved.reduce((sum, t) => sum + (t.paperPnl || 0), 0);

  // Per signal type
  const byType = {};
  for (const t of resolved) {
    if (!byType[t.signalType]) byType[t.signalType] = { wins: 0, total: 0, pnl: 0 };
    byType[t.signalType].total++;
    byType[t.signalType].pnl += (t.paperPnl || 0);
    if (t.status === "WIN") byType[t.signalType].wins++;
  }

  return {
    total:     all.length,
    resolved:  resolved.length,
    pending:   pending.length,
    wins:      wins.length,
    losses:    resolved.length - wins.length,
    hitRate,
    paperPnl,
    byType,
    readyForLive: resolved.length >= 40 && hitRate !== null && hitRate >= 55,
  };
}
