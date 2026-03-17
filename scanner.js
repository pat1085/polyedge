/**
 * POLY // EDGE - Automated Scanner v2
 * Runs via GitHub Actions every 30 minutes.
 * Sends Telegram alerts AND auto-logs every signal to trades.json
 * for paper trading validation.
 */

import fetch from "node-fetch";
import fs from "fs";
import { loadTrades, logTrade, logCorrelationTrade, getStats } from "./logger.js";

// ─── CONFIG ────────────────────────────────────────────────────────────────
const TELEGRAM_BOT_TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID     = process.env.TELEGRAM_CHAT_ID;

const MIN_EDGE_RETURN_PCT  = 20;
const MIN_LIQUIDITY = 10000;   // lowered -- Gamma API returns floats
const VOL_LIQ_RATIO_THRESH = 3.0;
const MAX_DAYS_TO_RESOLVE  = 180;   // widened -- some markets have no endDate
const CORR_GAP_THRESH      = 20;

const STATE_FILE = "./alerted.json";
const DRY_RUN    = process.argv.includes("--dry-run");

// ─── HELPERS ───────────────────────────────────────────────────────────────
function parsePrice(priceStr) {
  try { return parseFloat(JSON.parse(priceStr)[0]); }
  catch { return 0.5; }
}

function daysUntil(dateStr) {
  if (!dateStr) return 60; // default if missing
  return (new Date(dateStr) - new Date()) / 86400000;
}

function formatVolume(n) {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n}`;
}

function calcEdge(price, liquidity, volume, endDate) {
  const betPrice    = price <= 0.5 ? price : 1 - price;
  const returnPct   = (1 / betPrice - 1) * 100;
  const daysLeft    = daysUntil(endDate);
  const urgency     = daysLeft < 30 ? 1.3 : daysLeft < 60 ? 1.15 : 1.0;
  const liqScore    = Math.min(liquidity / 200_000, 1);
  const edgeScore   = Math.min((returnPct * urgency * (1 + liqScore * 0.4)) / 10, 99);
  const volLiqRatio = volume / Math.max(liquidity, 1);
  const direction   = price <= 0.5 ? "YES" : "NO";
  return { betPrice, returnPct, edgeScore, daysLeft, volLiqRatio, direction };
}

// Normalize field names -- Gamma API has multiple variants
function normalizeMarket(m) {
  return {
    ...m,
    id:            m.id || m.condition_id || String(Math.random()),
    question:      m.question || m.title || "Unknown market",
    slug:          m.slug || m.market_slug || "",
    category:      m.category || m.tags?.[0]?.label || "General",
    active:        m.active ?? true,
    outcomePrices: m.outcomePrices || m.outcome_prices || null,
    liquidity:     parseFloat(m.liquidity || 0),
    volume:        parseFloat(m.volume || 0),
    endDate:       m.endDate || m.end_date_iso || m.endDateIso || m.game_start_time || null,
  };
}

function processMarkets(raw) {
  const normalized = raw.map(normalizeMarket);

  // Debug: log first market shape to diagnose field names
  if (normalized.length > 0) {
    const sample = normalized[0];
    console.log(`Sample market fields: active=${sample.active}, liquidity=${sample.liquidity}, endDate=${sample.endDate}, outcomePrices=${sample.outcomePrices ? "present" : "null"}`);
  }

  return normalized.filter(m => {
    if (!m.outcomePrices) return false;
    const p = parsePrice(m.outcomePrices);
if (p <= 0.01 || p >= 0.99) return false;  // filter resolved/broken markets
    if (m.liquidity < MIN_LIQUIDITY) return false;
    if (m.endDate) {
      const days = daysUntil(m.endDate);
      if (days > MAX_DAYS_TO_RESOLVE) return false;
      if (days < 0) return false;
    }
    return true;
  }).map(m => {
    const price   = parsePrice(m.outcomePrices);
    const metrics = calcEdge(price, m.liquidity, m.volume, m.endDate);
    return { ...m, price, ...metrics };
  });
}

// ─── STATE ─────────────────────────────────────────────────────────────────
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); }
  catch { return { alerted: {} }; }
}

function saveState(state) {
  const cutoff = Date.now() - 7 * 86400000;
  for (const [id, ts] of Object.entries(state.alerted)) {
    if (ts < cutoff) delete state.alerted[id];
  }
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function alreadyAlerted(state, key) { return !!state.alerted[key]; }
function markAlerted(state, key)    { state.alerted[key] = Date.now(); }

// ─── TELEGRAM ──────────────────────────────────────────────────────────────
async function sendTelegram(message) {
  if (DRY_RUN) {
    console.log("\n[DRY RUN] Telegram:\n" + message + "\n");
    return true;
  }
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error("Missing Telegram credentials");
    return false;
  }
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id:                  TELEGRAM_CHAT_ID,
          text:                     message,
          parse_mode:               "HTML",
          disable_web_page_preview: true,
        }),
      }
    );
    const data = await res.json();
    if (!data.ok) { console.error("Telegram error:", data.description); return false; }
    return true;
  } catch (err) {
    console.error("Telegram failed:", err.message);
    return false;
  }
}

// ─── ALERT FORMATTERS ──────────────────────────────────────────────────────
function edgeAlert(m, tradeId) {
  const emoji = m.returnPct >= 50 ? "🔥" : m.returnPct >= 30 ? "⚡" : "📈";
  return (
    `${emoji} <b>EDGE ALERT — +${m.returnPct.toFixed(0)}% if correct</b>\n\n` +
    `<b>${m.question}</b>\n\n` +
    `Direction: Bet <b>${m.direction}</b> @ $${m.betPrice.toFixed(3)}\n` +
    `Return: <b>+${m.returnPct.toFixed(1)}%</b> on correct call\n` +
    `Edge Score: ${m.edgeScore.toFixed(0)}/99\n` +
    `Liquidity: ${formatVolume(m.liquidity)}\n` +
    `Volume: ${formatVolume(m.volume)}\n` +
    `Days to resolve: ${Math.round(m.daysLeft)}\n\n` +
    `📋 Paper trade logged: <code>${tradeId}</code>\n` +
    `🔗 polymarket.com/event/${m.slug}`
  );
}

function newsLagAlert(m, tradeId) {
  return (
    `⚡ <b>NEWS LAG SIGNAL — ${m.volLiqRatio.toFixed(1)}x vol spike</b>\n\n` +
    `<b>${m.question}</b>\n\n` +
    `Vol / Liq ratio: <b>${m.volLiqRatio.toFixed(1)}x</b>\n` +
    `Current price: $${m.price.toFixed(3)}\n` +
    `Volume: ${formatVolume(m.volume)}\n` +
    `Days to resolve: ${Math.round(m.daysLeft)}\n\n` +
    `⏱ Act within 5-30 min window.\n\n` +
    `📋 Paper trade logged: <code>${tradeId}</code>\n` +
    `🔗 polymarket.com/event/${m.slug}`
  );
}

function correlationAlert(pair, tradeId) {
  return (
    `🔀 <b>CORRELATION GAP — ${pair.gap.toFixed(0)}pt inconsistency</b>\n\n` +
    `Category: <b>${pair.category}</b>\n\n` +
    `A: ${pair.a.question.slice(0, 75)}\n` +
    `   → $${pair.a.price.toFixed(3)}\n\n` +
    `B: ${pair.b.question.slice(0, 75)}\n` +
    `   → $${pair.b.price.toFixed(3)}\n\n` +
    `📋 Observation logged: <code>${tradeId}</code>`
  );
}

function summaryAlert(edgeCount, lagCount, corrCount, topReturn, stats) {
  const hitLine = stats.hitRate !== null
    ? `\n📊 Paper hit rate: <b>${stats.hitRate.toFixed(1)}%</b> (${stats.resolved} resolved)`
    : `\n📊 Paper trades logged: <b>${stats.total}</b> (awaiting resolution)`;

  const needed    = Math.max(0, 40 - stats.resolved);
  const readyLine = stats.readyForLive
    ? `\n\n✅ <b>System validated. Ready to evaluate live capital.</b>`
    : `\n⏳ ${needed} more resolved trades needed before live eval.`;

  return (
    `📊 <b>POLY // EDGE — Scan Complete</b>\n\n` +
    `🟢 Edge opportunities: <b>${edgeCount}</b>\n` +
    `⚡ News lag signals: <b>${lagCount}</b>\n` +
    `🔀 Correlation gaps: <b>${corrCount}</b>\n` +
    (topReturn > 0 ? `🔥 Best return available: <b>+${topReturn.toFixed(0)}%</b>` : "") +
    hitLine +
    readyLine +
    `\n\n${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`
  );
}

// ─── SCANNERS ──────────────────────────────────────────────────────────────
function scanEdge(markets, state) {
  const hits    = markets.filter(m => m.returnPct >= MIN_EDGE_RETURN_PCT).sort((a, b) => b.edgeScore - a.edgeScore);
  const newHits = hits.filter(m => !alreadyAlerted(state, `edge_${m.id}`));
  newHits.forEach(m => markAlerted(state, `edge_${m.id}`));
  return { all: hits, newHits };
}

function scanNewsLag(markets, state) {
  const hits    = markets.filter(m => m.volLiqRatio >= VOL_LIQ_RATIO_THRESH && m.daysLeft <= 60).sort((a, b) => b.volLiqRatio - a.volLiqRatio).slice(0, 5);
  const newHits = hits.filter(m => !alreadyAlerted(state, `lag_${m.id}`));
  newHits.forEach(m => markAlerted(state, `lag_${m.id}`));
  return { all: hits, newHits };
}

function scanCorrelations(markets, state) {
  const pairs = [];
  for (let i = 0; i < markets.length; i++) {
    for (let j = i + 1; j < markets.length; j++) {
      const a = markets[i], b = markets[j];
      if (a.category === b.category) {
        const gap = Math.abs(a.price - b.price) * 100;
        if (gap >= CORR_GAP_THRESH) pairs.push({ a, b, gap, category: a.category });
      }
    }
  }
  pairs.sort((x, y) => y.gap - x.gap);
  const top     = pairs.slice(0, 4);
  const newHits = top.filter(p => !alreadyAlerted(state, `corr_${p.a.id}_${p.b.id}`));
  newHits.forEach(p => markAlerted(state, `corr_${p.a.id}_${p.b.id}`));
  return { all: top, newHits };
}

// ─── MAIN ──────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n============================`);
  console.log(`POLY // EDGE SCANNER v2`);
  console.log(`${new Date().toISOString()}`);
  console.log(`DRY RUN: ${DRY_RUN}`);
  console.log(`============================\n`);

  // 1. Fetch
  console.log("Fetching markets...");
  let rawMarkets = [];
  try {
    const res = await fetch(
      "https://gamma-api.polymarket.com/markets?active=true&limit=100&order=volume&ascending=false",
      { headers: { "User-Agent": "polyedge-scanner/2.0" } }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    rawMarkets = await res.json();
    console.log(`Fetched ${rawMarkets.length} markets`);

    // Log raw field names from first market for debugging
    if (rawMarkets.length > 0) {
      const keys = Object.keys(rawMarkets[0]);
      console.log(`Raw market keys: ${keys.join(", ")}`);
    }
  } catch (err) {
    console.error("Fetch failed:", err.message);
    await sendTelegram(`⚠️ <b>POLY // EDGE — Fetch Error</b>\n\n${err.message}`);
    process.exit(1);
  }

  const markets = processMarkets(rawMarkets);
  console.log(`After filtering: ${markets.length} markets\n`);

  // 2. Load state + trades
  const state     = loadState();
  const tradeData = loadTrades();

  // 3. Scan
  const edge = scanEdge(markets, state);
  const lag  = scanNewsLag(markets, state);
  const corr = scanCorrelations(markets, state);

  const topReturn = edge.all[0]?.returnPct ?? 0;

  console.log(`Edge (20%+): ${edge.all.length} total, ${edge.newHits.length} new`);
  console.log(`News Lag:    ${lag.all.length} total, ${lag.newHits.length} new`);
  console.log(`Correlation: ${corr.all.length} total, ${corr.newHits.length} new\n`);

  let sent = 0;

  // 4. Alert + log each new signal
  for (const m of edge.newHits) {
    console.log(`  Edge: ${m.question.slice(0, 55)}`);
    const tradeId = DRY_RUN ? `dry_edge_${m.id}` : logTrade(tradeData, m, "edge");
    await sendTelegram(edgeAlert(m, tradeId));
    sent++;
    await new Promise(r => setTimeout(r, 500));
  }

  for (const m of lag.newHits) {
    console.log(`  Lag: ${m.question.slice(0, 55)}`);
    const tradeId = DRY_RUN ? `dry_lag_${m.id}` : logTrade(tradeData, m, "newslag");
    await sendTelegram(newsLagAlert(m, tradeId));
    sent++;
    await new Promise(r => setTimeout(r, 500));
  }

  for (const pair of corr.newHits) {
    console.log(`  Corr: ${pair.category} — ${pair.gap.toFixed(0)}pts`);
    const tradeId = DRY_RUN ? `dry_corr_${pair.a.id}` : logCorrelationTrade(tradeData, pair);
    await sendTelegram(correlationAlert(pair, tradeId));
    sent++;
    await new Promise(r => setTimeout(r, 500));
  }

  // 5. Daily summary
  const stats    = getStats(tradeData);
  const todayKey = `summary_${new Date().toISOString().slice(0, 10)}`;

  if (sent > 0 || !alreadyAlerted(state, todayKey)) {
    await sendTelegram(summaryAlert(edge.all.length, lag.all.length, corr.all.length, topReturn, stats));
    markAlerted(state, todayKey);
  }

  // 6. Persist
  saveState(state);

  console.log(`\nDone. ${sent} alert(s). ${tradeData.trades.length} total paper trades logged.`);
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
