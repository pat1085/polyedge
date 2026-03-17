/**
 * POLY // EDGE - Performance Engine v1.0
 * Runs every Sunday at 09:00 UTC (2:30 PM IST).
 * Also manually triggerable anytime.
 *
 * Produces a full weekly performance breakdown:
 * - Hit rate per signal type (edge / newslag / correlation)
 * - Paper P&L per signal type
 * - Best and worst calls
 * - Capital readiness verdict
 * - Suggested position sizing if ready to go live
 */

import fetch from "node-fetch";
import { loadTrades, getStats } from "./logger.js";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
const DRY_RUN            = process.argv.includes("--dry-run");

// ─── TELEGRAM ──────────────────────────────────────────────────────────────
async function sendTelegram(message) {
  if (DRY_RUN) {
    console.log("\n[DRY RUN] Telegram:\n" + message + "\n---\n");
    return;
  }
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error("Missing Telegram credentials");
    return;
  }
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text: message,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        }),
      }
    );
    const data = await res.json();
    if (!data.ok) console.error("Telegram error:", data.description);
  } catch (err) {
    console.error("Telegram failed:", err.message);
  }
}

// ─── PERFORMANCE CALCULATIONS ──────────────────────────────────────────────
function calcPerformance(trades) {
  const resolved = trades.filter(t => t.status === "WIN" || t.status === "LOSS");
  const pending  = trades.filter(t => t.status === "PENDING");

  // ── Overall ──
  const overall = getOverallStats(resolved);

  // ── By signal type ──
  const byType = {};
  for (const type of ["edge", "newslag", "correlation"]) {
    const typeTrades = resolved.filter(t => t.signalType === type);
    byType[type] = getOverallStats(typeTrades);
  }

  // ── By category ──
  const byCategory = {};
  for (const t of resolved) {
    const cat = t.category || "General";
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(t);
  }
  const categoryStats = {};
  for (const [cat, catTrades] of Object.entries(byCategory)) {
    categoryStats[cat] = getOverallStats(catTrades);
  }

  // ── Best and worst calls ──
  const sorted  = [...resolved].sort((a, b) => (b.paperPnl || 0) - (a.paperPnl || 0));
  const best    = sorted.slice(0, 3);
  const worst   = sorted.slice(-3).reverse();

  // ── Weekly (last 7 days) ──
  const oneWeekAgo  = Date.now() - 7 * 86400000;
  const thisWeek    = resolved.filter(t => new Date(t.resolvedAt).getTime() > oneWeekAgo);
  const weeklyStats = getOverallStats(thisWeek);

  // ── Capital readiness ──
  const readiness = assessReadiness(overall, byType, resolved.length);

  return {
    overall, byType, categoryStats,
    best, worst, pending,
    resolved, weeklyStats, readiness,
  };
}

function getOverallStats(trades) {
  if (trades.length === 0) {
    return { total: 0, wins: 0, losses: 0, hitRate: null, pnl: 0, avgReturn: 0, avgLoss: 0 };
  }
  const wins   = trades.filter(t => t.status === "WIN");
  const losses = trades.filter(t => t.status === "LOSS");
  const pnl    = trades.reduce((s, t) => s + (t.paperPnl || 0), 0);
  const avgReturn = wins.length > 0
    ? wins.reduce((s, t) => s + (t.paperPnl || 0), 0) / wins.length
    : 0;
  return {
    total:     trades.length,
    wins:      wins.length,
    losses:    losses.length,
    hitRate:   (wins.length / trades.length) * 100,
    pnl:       pnl,
    avgReturn: avgReturn,
  };
}

// ─── CAPITAL READINESS ASSESSMENT ──────────────────────────────────────────
function assessReadiness(overall, byType, resolvedCount) {
  const MIN_SAMPLE    = 40;
  const MIN_HIT_RATE  = 55;   // % -- minimum to be profitable at 20% avg return
  const MIN_HIT_EDGE  = 55;
  const MIN_HIT_LAG   = 58;   // higher bar for news lag (time-sensitive)

  if (resolvedCount < MIN_SAMPLE) {
    return {
      verdict: "NOT_READY",
      reason:  `Need ${MIN_SAMPLE - resolvedCount} more resolved trades (have ${resolvedCount}/${MIN_SAMPLE})`,
      level:   0,
    };
  }

  if (overall.hitRate === null || overall.hitRate < MIN_HIT_RATE) {
    return {
      verdict: "NOT_READY",
      reason:  `Overall hit rate ${overall.hitRate?.toFixed(1) ?? "N/A"}% is below minimum ${MIN_HIT_RATE}%`,
      level:   0,
    };
  }

  // Find which signal types are validated
  const validTypes = [];
  if (byType.edge.total >= 15 && byType.edge.hitRate >= MIN_HIT_EDGE)   validTypes.push("edge");
  if (byType.newslag.total >= 10 && byType.newslag.hitRate >= MIN_HIT_LAG) validTypes.push("newslag");

  if (validTypes.length === 0) {
    return {
      verdict: "PARTIAL",
      reason:  `Overall hit rate passes but no individual signal type has enough data yet`,
      level:   1,
    };
  }

  return {
    verdict:    "READY",
    reason:     `${validTypes.join(" + ")} signals validated`,
    validTypes,
    level:      2,
    // Kelly criterion approximation for position sizing
    // f = (bp - q) / b  where b=avg return, p=hit rate, q=1-p
    suggestedUnit: calcKelly(overall),
  };
}

function calcKelly(stats) {
  if (!stats.hitRate) return 0;
  const p = stats.hitRate / 100;
  const q = 1 - p;
  const b = stats.avgReturn; // avg win as decimal
  const kelly = (b * p - q) / b;
  // Use quarter-Kelly for safety
  const quarterKelly = Math.max(0, kelly * 0.25);
  return Math.min(quarterKelly, 0.05); // cap at 5% of bankroll per bet
}

// ─── TELEGRAM REPORT ───────────────────────────────────────────────────────
function buildReport(perf) {
  const { overall, byType, weeklyStats, best, worst, pending, readiness } = perf;

  const week = new Date().toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });

  // ── Header ──
  let msg = `📊 <b>POLY // EDGE — Weekly Performance Report</b>\n`;
  msg    += `Week ending ${week}\n`;
  msg    += `─────────────────\n\n`;

  // ── This week ──
  if (weeklyStats.total > 0) {
    const wPnl = weeklyStats.pnl >= 0 ? `+$${weeklyStats.pnl.toFixed(2)}` : `-$${Math.abs(weeklyStats.pnl).toFixed(2)}`;
    msg += `📅 <b>This Week</b>\n`;
    msg += `${weeklyStats.wins}W / ${weeklyStats.losses}L | Hit rate: ${weeklyStats.hitRate?.toFixed(1) ?? "N/A"}% | P&L: ${wPnl}\n\n`;
  }

  // ── Overall ──
  const oPnl = overall.pnl >= 0 ? `+$${overall.pnl.toFixed(2)}` : `-$${Math.abs(overall.pnl).toFixed(2)}`;
  msg += `📈 <b>Overall (${overall.total} resolved)</b>\n`;
  msg += `${overall.wins}W / ${overall.losses}L | Hit rate: <b>${overall.hitRate?.toFixed(1) ?? "N/A"}%</b>\n`;
  msg += `Paper P&L per $1 unit: <b>${oPnl}</b>\n\n`;

  // ── By signal type ──
  msg += `🔬 <b>By Signal Type</b>\n`;
  const typeLabels = { edge: "📈 Edge", newslag: "⚡ News Lag", correlation: "🔀 Correlation" };
  for (const [type, label] of Object.entries(typeLabels)) {
    const s = byType[type];
    if (s.total === 0) {
      msg += `${label}: No data yet\n`;
    } else {
      const pnlStr = s.pnl >= 0 ? `+$${s.pnl.toFixed(2)}` : `-$${Math.abs(s.pnl).toFixed(2)}`;
      msg += `${label}: ${s.wins}W/${s.losses}L (${s.hitRate?.toFixed(0) ?? "N/A"}%) | P&L: ${pnlStr}\n`;
    }
  }
  msg += `\n`;

  // ── Best calls ──
  if (best.length > 0 && best[0].paperPnl > 0) {
    msg += `🏆 <b>Best Calls</b>\n`;
    for (const t of best.filter(t => t.paperPnl > 0)) {
      msg += `✅ ${t.question.slice(0, 48)} (+${(t.paperPnl * 100).toFixed(0)}%)\n`;
    }
    msg += `\n`;
  }

  // ── Worst calls ──
  if (worst.length > 0 && worst[0].paperPnl < 0) {
    msg += `📉 <b>Worst Calls</b>\n`;
    for (const t of worst.filter(t => t.paperPnl < 0).slice(0, 2)) {
      msg += `❌ ${t.question.slice(0, 48)} (${(t.paperPnl * 100).toFixed(0)}%)\n`;
    }
    msg += `\n`;
  }

  // ── Pipeline ──
  msg += `⏳ <b>Pipeline</b>\n`;
  msg += `Pending resolution: ${pending.length} trades\n\n`;

  // ── Capital readiness verdict ──
  msg += `─────────────────\n`;
  msg += `💰 <b>Capital Readiness</b>\n`;

  if (readiness.verdict === "READY") {
    const pct = (readiness.suggestedUnit * 100).toFixed(1);
    msg += `✅ <b>VALIDATED — Ready for live capital</b>\n`;
    msg += `Validated signals: ${readiness.validTypes.join(", ")}\n`;
    msg += `Suggested unit size: <b>${pct}% of bankroll per bet</b> (quarter-Kelly)\n`;
    msg += `Example: ₹50,000 bankroll → ₹${Math.round(50000 * readiness.suggestedUnit).toLocaleString("en-IN")} per bet\n`;
  } else if (readiness.verdict === "PARTIAL") {
    msg += `⚠️ <b>PARTIAL</b> — Overall rate OK, need more signal-level data\n`;
    msg += `${readiness.reason}\n`;
  } else {
    msg += `🔴 <b>NOT READY</b> — Continue paper trading\n`;
    msg += `${readiness.reason}\n`;
  }

  return msg;
}

// ─── MAIN ──────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n============================`);
  console.log(`POLY // EDGE PERFORMANCE ENGINE v1.0`);
  console.log(`${new Date().toISOString()}`);
  console.log(`DRY RUN: ${DRY_RUN}`);
  console.log(`============================\n`);

  const data = loadTrades();
  console.log(`Total trades loaded: ${data.trades.length}`);

  const perf   = calcPerformance(data.trades);
  const report = buildReport(perf);

  // Print to console
  console.log("\n--- PERFORMANCE SUMMARY ---");
  console.log(`Overall: ${perf.overall.wins}W / ${perf.overall.losses}L`);
  console.log(`Hit rate: ${perf.overall.hitRate?.toFixed(1) ?? "N/A"}%`);
  console.log(`Paper P&L: ${perf.overall.pnl >= 0 ? "+" : ""}${perf.overall.pnl.toFixed(2)} per $1 unit`);
  console.log(`Pending: ${perf.pending.length}`);
  console.log(`Verdict: ${perf.readiness.verdict}`);
  console.log(`Reason: ${perf.readiness.reason}`);

  console.log("\n--- Signal Type Breakdown ---");
  for (const [type, stats] of Object.entries(perf.byType)) {
    console.log(`${type}: ${stats.wins}W/${stats.losses}L (${stats.hitRate?.toFixed(1) ?? "N/A"}%) P&L: ${stats.pnl >= 0 ? "+" : ""}${stats.pnl.toFixed(2)}`);
  }

  await sendTelegram(report);
  console.log("\nReport sent. Done.");
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
