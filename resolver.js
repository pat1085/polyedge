/**
 * POLY // EDGE - Resolution Fetcher v1.0
 * Runs daily via GitHub Actions.
 * Checks all PENDING paper trades against Polymarket API.
 * Marks each trade WIN / LOSS and calculates paper P&L.
 */

import fetch from "node-fetch";
import fs from "fs";
import { loadTrades, saveTrades, getStats } from "./logger.js";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
const DRY_RUN            = process.argv.includes("--dry-run");

// ─── TELEGRAM ──────────────────────────────────────────────────────────────
async function sendTelegram(message) {
  if (DRY_RUN) {
    console.log("\n[DRY RUN] Telegram:\n" + message + "\n");
    return;
  }
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
  } catch (err) {
    console.error("Telegram failed:", err.message);
  }
}

// ─── FETCH MARKET STATUS ───────────────────────────────────────────────────
async function fetchMarketStatus(marketId) {
  try {
    // Try by conditionId first, then by id
    const url = `https://gamma-api.polymarket.com/markets?id=${marketId}`;
    const res = await fetch(url, { headers: { "User-Agent": "polyedge-resolver/1.0" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) return null;
    return data[0];
  } catch (err) {
    console.error(`  Failed to fetch market ${marketId}: ${err.message}`);
    return null;
  }
}

// ─── DETERMINE OUTCOME ─────────────────────────────────────────────────────
// Returns: { resolved: bool, outcome: "YES"|"NO"|null, winningPrice: number }
function determineOutcome(market) {
  if (!market) return { resolved: false, outcome: null };

  const closed   = market.closed || false;
  const resolved = market.resolutionSource || market.resolvedBy || null;

  // Check if market is closed/resolved
  if (!closed && !market.umaResolutionStatus) {
    return { resolved: false, outcome: null };
  }

  // Parse outcome prices to find winner
  let outcomePrices = null;
  try {
    outcomePrices = JSON.parse(market.outcomePrices || "[]");
  } catch {
    return { resolved: false, outcome: null };
  }

  if (!outcomePrices || outcomePrices.length < 2) {
    return { resolved: false, outcome: null };
  }

  const yesPrice = parseFloat(outcomePrices[0]);
  const noPrice  = parseFloat(outcomePrices[1]);

  // Resolved: one price is 1.0 (winner) and other is 0.0 (loser)
  if (yesPrice >= 0.99 && noPrice <= 0.01) {
    return { resolved: true, outcome: "YES", winningPrice: 1.0 };
  }
  if (noPrice >= 0.99 && yesPrice <= 0.01) {
    return { resolved: true, outcome: "NO", winningPrice: 1.0 };
  }

  // Not yet fully resolved
  return { resolved: false, outcome: null };
}

// ─── CALCULATE P&L ─────────────────────────────────────────────────────────
// Paper P&L on a $1 unit bet.
// WIN:  profit = (1 / entryPrice) - 1
// LOSS: profit = -1 (lost the full unit)
function calcPaperPnl(trade, won) {
  if (trade.direction === "OBSERVE") return 0; // correlation observations
  if (won) {
    return parseFloat(((1 / trade.entryPrice) - 1).toFixed(4));
  }
  return -1;
}

// ─── RESOLUTION REPORT ─────────────────────────────────────────────────────
function resolutionAlert(resolved, stats) {
  if (resolved.length === 0) return null;

  const lines = resolved.map(r => {
    const icon = r.won ? "✅" : "❌";
    const pnl  = r.won
      ? `+${(r.pnl * 100).toFixed(0)}% ($${(r.pnl).toFixed(2)} per $1)`
      : `-100% (-$1.00 per $1)`;
    return `${icon} <b>${r.question.slice(0, 55)}</b>\nBet ${r.direction} | ${pnl}`;
  }).join("\n\n");

  const hitRate = stats.hitRate !== null ? `${stats.hitRate.toFixed(1)}%` : "N/A";
  const pnlStr  = stats.paperPnl >= 0
    ? `+$${stats.paperPnl.toFixed(2)}`
    : `-$${Math.abs(stats.paperPnl).toFixed(2)}`;

  return (
    `🎯 <b>POLY // EDGE — Resolutions (${resolved.length} new)</b>\n\n` +
    lines +
    `\n\n─────────────────\n` +
    `📊 <b>Overall Paper Performance</b>\n` +
    `Hit rate: <b>${hitRate}</b> (${stats.wins}W / ${stats.losses}L of ${stats.resolved} resolved)\n` +
    `Paper P&L per $1 unit: <b>${pnlStr}</b>\n` +
    `Still pending: <b>${stats.pending}</b> trades\n` +
    (stats.readyForLive
      ? `\n✅ <b>40+ resolved with 55%+ hit rate. Consider live capital.</b>`
      : `\n⏳ ${Math.max(0, 40 - stats.resolved)} more resolutions needed before live eval.`)
  );
}

// ─── MAIN ──────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n============================`);
  console.log(`POLY // EDGE RESOLVER v1.0`);
  console.log(`${new Date().toISOString()}`);
  console.log(`DRY RUN: ${DRY_RUN}`);
  console.log(`============================\n`);

  const data    = loadTrades();
  const pending = data.trades.filter(t => t.status === "PENDING");

  console.log(`Total trades: ${data.trades.length}`);
  console.log(`Pending resolution: ${pending.length}\n`);

  if (pending.length === 0) {
    console.log("No pending trades to resolve.");
    return;
  }

  const newlyResolved = [];

  for (const trade of pending) {
    // Skip correlation observations -- manual resolution
    if (trade.direction === "OBSERVE") {
      console.log(`  SKIP (observation): ${trade.question.slice(0, 50)}`);
      continue;
    }

    // Extract the base market ID (strip composite IDs)
    const marketId = trade.marketId.split("+")[0];
    console.log(`  Checking: ${trade.question.slice(0, 50)}...`);

    const market = await fetchMarketStatus(marketId);
    const { resolved, outcome } = determineOutcome(market);

    if (!resolved) {
      console.log(`    → Still pending`);
      await new Promise(r => setTimeout(r, 300)); // rate limit
      continue;
    }

    const won    = outcome === trade.direction;
    const pnl    = calcPaperPnl(trade, won);
    const status = won ? "WIN" : "LOSS";

    console.log(`    → RESOLVED: ${outcome} | Trade was ${trade.direction} | ${status} | P&L: ${pnl > 0 ? "+" : ""}${pnl.toFixed(2)}`);

    // Update trade record
    trade.status     = status;
    trade.outcome    = outcome;
    trade.resolvedAt = new Date().toISOString();
    trade.paperPnl   = pnl;

    newlyResolved.push({
      question:  trade.question,
      direction: trade.direction,
      won,
      pnl,
      outcome,
    });

    await new Promise(r => setTimeout(r, 300));
  }

  // Save updated trades
  if (!DRY_RUN) {
    saveTrades(data);
    console.log(`\nSaved ${newlyResolved.length} newly resolved trade(s).`);
  }

  // Send Telegram report if anything resolved
  const stats = getStats(data);
  console.log(`\nCurrent stats:`);
  console.log(`  Resolved: ${stats.resolved} | Wins: ${stats.wins} | Losses: ${stats.losses}`);
  console.log(`  Hit rate: ${stats.hitRate !== null ? stats.hitRate.toFixed(1) + "%" : "N/A"}`);
  console.log(`  Paper P&L: ${stats.paperPnl >= 0 ? "+" : ""}${stats.paperPnl.toFixed(2)} per $1 unit`);
  console.log(`  Ready for live: ${stats.readyForLive}`);

  const alert = resolutionAlert(newlyResolved, stats);
  if (alert) {
    await sendTelegram(alert);
  } else {
    console.log("\nNo new resolutions -- no Telegram message sent.");
  }

  console.log("\nDone.");
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
