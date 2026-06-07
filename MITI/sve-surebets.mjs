/**
 * Sure Bet kalkulator + Simulator klađenja – SVE eSoccer lige
 * Port: 3008
 *
 * Pravila simulacije:
 * - Kandidat: Superbet prob > Bet365 prob za ≥ 6% (jedan ishod)
 * - Mora biti stabilan 8 sekundi
 * - Ne igrati posle (ukupno_trajanje - 2) minuta
 * - Ulog 1 dinar, samo Superbet
 * - Uparivanje: po nicknamovima igrača u zagradama
 *
 * Izvori:
 *   Bet365  → localhost:4001  (esoccer-skupljac)
 *   Superbet → localhost:3007 (esoccer-1x2.mjs)
 */

import http from "http";
import fs   from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Telegram — šalje samo GT takmičenja (Bet365 kompetition sadrži "GT") ──────
const TG_TOKEN   = "8667978657:AAEwD1EdnzRxtAWcWvJKKJUyLJDdQty490Y";
const TG_CHAT_ID = "-5090222659";
const TG_URL     = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`;

async function sendTelegram(text) {
  try {
    await fetch(TG_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text, parse_mode: "HTML" }),
    });
  } catch (e) {
    console.warn("Telegram greška:", e.message);
  }
}

function isGT(b365Competition) {
  return String(b365Competition ?? "").toLowerCase().includes("gt");
}

const PORT         = 3008;
const MIN_DIFF_PCT = 6;
const STABLE_SEC   = 8;
const STAKE        = 1;

// ── Superbet API za rezultate ─────────────────────────────────────────────────
const SB_API     = "https://production-superbet-offer-rs.freetls.fastly.net/sb-rs/api/v2/sr-Latn-RS";
const SB_HEADERS = { "Accept": "application/json", "User-Agent": "Mozilla/5.0" };
const SB_SPORT   = 75;

const HISTORY_FILE = path.join(__dirname, "sve-bets-history.json");

// ── Perzistentna historija ────────────────────────────────────────────────────

function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const raw  = fs.readFileSync(HISTORY_FILE, "utf8");
      const data = JSON.parse(raw);
      return {
        bets:        Array.isArray(data.bets) ? data.bets : [],
        totalStaked: typeof data.totalStaked === "number" ? data.totalStaked : 0,
        totalReturn: typeof data.totalReturn === "number" ? data.totalReturn : 0,
      };
    }
  } catch (e) {
    console.warn("Nije moguće učitati historiju:", e.message);
  }
  return { bets: [], totalStaked: 0, totalReturn: 0 };
}

function saveHistory() {
  try {
    const tmp = HISTORY_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ bets, totalStaked, totalReturn }, null, 2), "utf8");
    fs.renameSync(tmp, HISTORY_FILE);
  } catch (e) {
    console.warn("Nije moguće snimiti historiju:", e.message);
  }
}

// ── Simulacija state ──────────────────────────────────────────────────────────
const candidates        = new Map();
const lastSeenScore     = new Map(); // sbId → zadnji Superbet score dok je bio live
const lastSeenB365Score = new Map(); // sbId → zadnji Bet365 score dok je bio live
const b365GoneAt        = new Map(); // sbId → timestamp kada je meč nestao sa Bet365

const _loaded = loadHistory();
const bets = _loaded.bets;
let totalStaked = _loaded.totalStaked;
let totalReturn = _loaded.totalReturn;

if (bets.length > 0) {
  console.log(`Učitana historija: ${bets.length} klađenja, ulog=${totalStaked}, povrat=${totalReturn.toFixed(2)}`);
}

// ── Dohvat stanja ─────────────────────────────────────────────────────────────

async function fetchState(port) {
  try {
    const res = await fetch(`http://localhost:${port}/state`, { cache: "no-store" });
    return await res.json();
  } catch {
    return null;
  }
}

// ── Uparivanje po nicknamovima igrača ────────────────────────────────────────
// "Shakhtar (Fred) v Rayo (Sensei)" → ["fred", "sensei"]

function extractNicknames(name) {
  const matches = [...(name ?? "").matchAll(/\(([^)]+)\)/g)];
  return matches.map(m => m[1].toLowerCase().trim());
}

function matchByNicknames(nameA, nameB) {
  const nA = extractNicknames(nameA);
  const nB = extractNicknames(nameB);
  if (nA.length < 2 || nB.length < 2) return false;
  return nA[0] === nB[0] && nA[1] === nB[1];
}

// ── Parsiranje formata trajanja ───────────────────────────────────────────────
// "2x6minuta" → ukupno 12, max minuta = 10

function parseTotalDuration(format) {
  if (!format) return 12;
  const m = String(format).match(/(\d+)x(\d+)/i);
  if (!m) return 12;
  return parseInt(m[1]) * parseInt(m[2]);
}

function parseMaxMinute(format) {
  return parseTotalDuration(format) - 2;
}

// ── Kvote iz Superbet slota ───────────────────────────────────────────────────

function superbet1x2(slot) {
  const o = slot.odds;
  if (!o) return null;
  if (!o["1"] || !o["X"] || !o["2"]) return null;
  return { "1": o["1"], "X": o["X"], "2": o["2"] };
}

// ── Kvote iz Bet365 slota ─────────────────────────────────────────────────────

function bet3651x2(slot) {
  // 4001 format: odds = [odd1, oddX, odd2]
  if (Array.isArray(slot.odds) && slot.odds.length === 3) {
    const [o1, oX, o2] = slot.odds;
    if (o1 && oX && o2) return { "1": o1, "X": oX, "2": o2 };
  }
  return null;
}

// ── Parsiranje minute ─────────────────────────────────────────────────────────

function parseMinute(min) {
  if (min == null) return null;
  const m = String(min).match(/^(\d+)/);
  return m ? parseInt(m[1]) : null;
}

// ── Normalizacija score-a ─────────────────────────────────────────────────────

function normalizeScore(s) {
  if (!s || s === "--") return null;
  const m = String(s).match(/(\d+)\D+(\d+)/);
  if (!m) return null;
  return `${m[1]}:${m[2]}`;
}

function scoresMatch(scoreA, scoreB) {
  const a = normalizeScore(scoreA);
  const b = normalizeScore(scoreB);
  if (!a || !b) return true;
  return a === b;
}

// ── Ukupno golova iz score stringa ────────────────────────────────────────────

function totalGoals(score) {
  if (!score || score === "--") return -1;
  const m = String(score).match(/(\d+)\D+(\d+)/);
  if (!m) return -1;
  return parseInt(m[1]) + parseInt(m[2]);
}

function pickHigherGoals(scoreA, scoreB) {
  const ga = totalGoals(scoreA);
  const gb = totalGoals(scoreB);
  if (ga < 0 && gb < 0) return null;
  if (ga >= gb) return scoreA;
  return scoreB;
}

// ── Sure bet kalkulator ───────────────────────────────────────────────────────

function calcSureBet(sb, b365) {
  const best = {
    "1": { odd: Math.max(sb["1"], b365["1"]), src: sb["1"] >= b365["1"] ? "Superbet" : "Bet365" },
    "X": { odd: Math.max(sb["X"], b365["X"]), src: sb["X"] >= b365["X"] ? "Superbet" : "Bet365" },
    "2": { odd: Math.max(sb["2"], b365["2"]), src: sb["2"] >= b365["2"] ? "Superbet" : "Bet365" },
  };
  const margin = 1 / best["1"].odd + 1 / best["X"].odd + 1 / best["2"].odd;
  const profit = (1 - margin) * 100;
  const isSure = margin < 1.0;

  let bestSuperbet = null;
  if (isSure) {
    let maxDiff = -Infinity;
    for (const key of ["1", "X", "2"]) {
      const pSb  = (1 / sb[key])   * 100;
      const pB365 = (1 / b365[key]) * 100;
      const diff = pSb - pB365;
      if (diff > maxDiff) { maxDiff = diff; bestSuperbet = { key, diff }; }
    }
  }

  return { best, margin, profit, isSure, bestSuperbet };
}

// ── Razrješenje klađenja ──────────────────────────────────────────────────────

function resolveOutcome(score, outcome) {
  if (!score) return null;
  const m = String(score).match(/(\d+)\D+(\d+)/);
  if (!m) return null;
  const h = parseInt(m[1]), a = parseInt(m[2]);
  if (outcome === "1") return h > a ? "won" : "lost";
  if (outcome === "X") return h === a ? "won" : "lost";
  if (outcome === "2") return a > h ? "won" : "lost";
  return null;
}

function applyResult(bet, result, score) {
  bet.status     = result;
  bet.finalScore = score;
  if (result === "won") {
    const payout = parseFloat((bet.sbOdd * STAKE).toFixed(2));
    bet.payout   = payout;
    totalReturn += payout;
  } else {
    bet.payout = 0;
  }
  console.log(`RESULT: ${bet.matchName} | ${bet.outcome} | ${bet.status} | score=${score}`);
  saveHistory();
}

// ── Provjeri završene mečeve i razriješi klađenja ─────────────────────────────

function checkResolutions(sbSlots) {
  // Ažuriraj lastSeenScore za sve aktivne live slotove (fallback)
  for (const slot of sbSlots) {
    if (slot.score && slot.score !== "--") {
      lastSeenScore.set(slot.id, slot.score);
    }
  }

  for (const bet of bets) {
    if (bet.status !== "pending") continue;
    const slot = sbSlots.find(s => s.id === bet.sbId);
    if (slot) {
      if (slot.score && slot.score !== "--") {
        lastSeenScore.set(slot.id, slot.score);
      }
    }
  }
}

// ── Rezultiranje po Bet365 + Superbet poredjenju ─────────────────────────────
// Kad Bet365 meč nestane, čekamo 5 min, pa uzimamo score sa više golova.
const RESULT_WAIT_MS = 5 * 60 * 1000;

function checkResultedBets() {
  const now     = Date.now();
  const pending = bets.filter(b => b.status === "pending");
  if (pending.length === 0) return;

  for (const bet of pending) {
    const goneAt = b365GoneAt.get(bet.sbId);
    if (!goneAt) continue;                        // B365 još uvijek live ili nikad viđen
    if (now - goneAt < RESULT_WAIT_MS) continue;  // čekaj 5 min

    const b365Score = lastSeenB365Score.get(bet.sbId) ?? null;
    const sbScore   = lastSeenScore.get(bet.sbId)     ?? null;

    const finalScore = pickHigherGoals(b365Score, sbScore);
    if (!finalScore) continue;

    const result = resolveOutcome(finalScore, bet.outcome);
    if (!result) continue;

    console.log(`[RESULTED] ${bet.matchName} finalScore=${finalScore} (b365=${b365Score ?? "?"} sb=${sbScore ?? "?"})`);
    applyResult(bet, result, finalScore);
  }
}

// ── Generiši state ────────────────────────────────────────────────────────────

let cached = {
  ts: "--", pairs: [], status: "Pokretanje...",
  bets: [], totalStaked: 0, totalReturn: 0, candidates: {},
};

async function refresh() {
  const [b365data, sbData] = await Promise.all([fetchState(4001), fetchState(3007)]);
  if (!b365data || !sbData) {
    cached.status = `Greška:${!b365data ? " Bet365(4001)" : ""}${!sbData ? " Superbet(3007)" : ""} nedostupan`;
    return;
  }

  const b365slots = b365data.slots ?? b365data.matches ?? [];
  const sbSlots   = sbData.slots   ?? sbData.matches   ?? [];

  const now = Date.now();

  // Prati Bet365 score i nestajanje meča za svaki pending bet
  for (const bet of bets) {
    if (bet.status !== "pending") continue;
    const b365slot = b365slots.find(s => matchByNicknames(bet.matchName, s.name));
    if (b365slot) {
      if (b365slot.score && b365slot.score !== "--") {
        lastSeenB365Score.set(bet.sbId, b365slot.score);
      }
      b365GoneAt.delete(bet.sbId); // meč još live, resetuj timer
    } else {
      // Bet365 više ne vidi ovaj meč — zabilježi kada je nestao
      if (!b365GoneAt.has(bet.sbId)) {
        b365GoneAt.set(bet.sbId, now);
      }
    }
  }

  checkResolutions(sbSlots);
  checkResultedBets();

  const pairs = [];
  const activeCandidateKeys = new Set();

  for (const ss of sbSlots) {
    const sb1 = superbet1x2(ss);
    if (!sb1) continue;

    const maxMinute = parseMaxMinute(ss.format);
    const totalDur  = parseTotalDuration(ss.format);
    const minute    = parseMinute(ss.minute);

    // Nađi Bet365 meč po nicknamovima igrača
    const bs = b365slots.find(s => matchByNicknames(ss.name, s.name));
    if (!bs) continue;

    const b3 = bet3651x2(bs);
    if (!b3) continue;

    const calc    = calcSureBet(sb1, b3);
    const scoreOk = scoresMatch(ss.score, bs.score);
    const canBet  = minute != null && minute < maxMinute && scoreOk && !bs.suspend;

    const probRows = {};
    for (const k of ["1", "X", "2"]) {
      const pSb   = (1 / sb1[k]) * 100;
      const pB365 = (1 / b3[k])  * 100;
      const diff  = pB365 - pSb;   // pozitivno = Superbet daje bolje odds
      const sbOddOk     = sb1[k] >= 1.50 && sb1[k] <= 5.00;
      const isCandidate = canBet && diff >= MIN_DIFF_PCT && sbOddOk;
      probRows[k] = { pSb, pB365, diff, isCandidate };

      if (isCandidate) {
        const key = `${ss.id}_${k}`;
        activeCandidateKeys.add(key);
        if (!candidates.has(key)) {
          const alreadyBet = bets.some(b => b.sbId === ss.id && b.outcome === k && b.status === "pending");
          if (!alreadyBet) {
            const newCand = {
              since:           now,
              matchName:       ss.name,
              sbId:            ss.id,
              outcome:         k,
              sbOdd:           sb1[k],
              b365Odd:         b3[k],
              diff,
              minute,
              matchDuration:   totalDur,
              format:          ss.format,
              b365Competition: bs.competition ?? "",
            };
            candidates.set(key, newCand);
            if (isGT(newCand.b365Competition)) {
              sendTelegram(`👀 <b>GT KANDIDAT</b>\n${newCand.matchName}\nIshod: <b>${k}</b> | SB: ${newCand.sbOdd.toFixed(2)} | B365: ${newCand.b365Odd.toFixed(2)} | +${newCand.diff.toFixed(1)}%\nMin: ${newCand.minute ?? "?"} | ${newCand.b365Competition}`);
            }
          }
        } else {
          const c = candidates.get(key);
          c.sbOdd   = sb1[k];
          c.b365Odd = b3[k];
          c.diff    = diff;
          c.minute  = minute;
        }
      }
    }

    pairs.push({
      name:        ss.name,
      b365Name:    bs.name,
      sbId:        ss.id,
      score:       ss.score ?? bs.score ?? "--",
      minute,
      maxMinute,
      format:      ss.format ?? "",
      competition: ss.competition ?? "",
      sb:          sb1,
      b365:        b3,
      calc,
      probRows,
    });
  }

  pairs.sort((a, b) => {
    if (a.calc.isSure && !b.calc.isSure) return -1;
    if (!a.calc.isSure && b.calc.isSure) return 1;
    return b.calc.profit - a.calc.profit;
  });

  for (const key of [...candidates.keys()]) {
    if (!activeCandidateKeys.has(key)) candidates.delete(key);
  }

  for (const [key, c] of candidates) {
    const elapsed = (now - c.since) / 1000;
    if (elapsed >= STABLE_SEC) {
      const alreadyBet = bets.some(b =>
        b.sbId === c.sbId && b.outcome === c.outcome && b.status === "pending"
      );
      if (!alreadyBet) {
        bets.unshift({
          time:           new Date().toLocaleTimeString("sr"),
          placedAt:       now,
          matchName:      c.matchName,
          sbId:           c.sbId,
          outcome:        c.outcome,
          sbOdd:          parseFloat(c.sbOdd.toFixed(2)),
          b365Odd:        parseFloat(c.b365Odd.toFixed(2)),
          diff:           parseFloat(c.diff.toFixed(1)),
          betMinute:      c.minute ?? null,
          matchDuration:  c.matchDuration,
          format:         c.format,
          b365Competition: c.b365Competition ?? "",
          stake:          STAKE,
          status:         "pending",
          finalScore:     null,
          payout:         null,
        });
        totalStaked += STAKE;
        saveHistory();
        candidates.delete(key);
        console.log(`BET: ${c.matchName} | ${c.outcome} | sb=${c.sbOdd.toFixed(2)} diff=${c.diff.toFixed(1)}% min=${c.minute}`);
        if (isGT(c.b365Competition)) {
          sendTelegram(`🎯 <b>GT BET</b>\n${c.matchName}\nIshod: <b>${c.outcome}</b> | SB: ${c.sbOdd.toFixed(2)} | B365: ${c.b365Odd.toFixed(2)} | +${c.diff.toFixed(1)}%\nMin: ${c.minute ?? "?"} | ${c.b365Competition}`);
        }
      }
    }
  }

  const candInfo = {};
  for (const [key, c] of candidates) {
    const elapsed   = (now - c.since) / 1000;
    const remaining = Math.max(0, STABLE_SEC - elapsed);
    candInfo[key] = parseFloat(remaining.toFixed(1));
  }

  cached = {
    ts: new Date().toLocaleTimeString("sr"),
    pairs,
    status: `${pairs.length} mečeva upareno — ${new Date().toLocaleTimeString("sr")}`,
    bets,
    candidates: candInfo,
    totalStaked,
    totalReturn,
  };
}

async function loop() {
  await refresh();
  async function tick() {
    await new Promise(r => setTimeout(r, 500));
    await refresh();
    tick();
  }
  tick();
}
loop();

// ── HTML UI ───────────────────────────────────────────────────────────────────

const HTML = `<!DOCTYPE html>
<html lang="sr">
<head>
<meta charset="UTF-8">
<title>Sure Bet + Simulator – SVE eSoccer</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0f1923; color: #cfd8e3; font-family: 'Segoe UI', sans-serif; font-size: 13px; padding: 12px; }
  h1 { color: #f0c040; font-size: 17px; margin-bottom: 4px; }
  #ts { color: #556; font-size: 11px; margin-bottom: 10px; }

  #stats { display:flex; gap:16px; margin-bottom:14px; background:#1a2634; padding:10px 14px; border-radius:8px; flex-wrap:wrap; }
  .stat { display:flex; flex-direction:column; align-items:center; }
  .stat-label { color:#778899; font-size:11px; }
  .stat-val { font-size:17px; font-weight:700; margin-top:2px; }
  .pos{color:#27ae60} .neg{color:#e74c3c} .neu{color:#f0c040}

  .pair { background: #1a2634; border-radius: 8px; padding: 12px 14px; margin-bottom: 10px; border-left: 4px solid #2c3e50; }
  .pair.sure { border-left-color: #27ae60; background: #1a2e1e; }
  .pair.has-cand { border-left-color: #f39c12; }
  .pair.sure.has-cand { border-left-color: #27ae60; }
  .pair-name { font-size: 14px; font-weight: 600; color: #e0e8f0; margin-bottom: 4px; }
  .pair-meta { color: #667; font-size: 11px; margin-bottom: 8px; }
  .sure-badge { display:inline-block; background:#27ae60; color:#fff; font-size:11px; font-weight:700; padding:2px 7px; border-radius:4px; margin-left:6px; }
  .lock { color:#e74c3c; font-size:11px; margin-left:4px; }
  .fmt-badge { display:inline-block; background:#1e3a5f; color:#7eb8f7; font-size:10px; padding:1px 5px; border-radius:3px; margin-left:5px; }

  table { width:100%; border-collapse:collapse; font-size:12px; }
  th { color:#556; font-weight:500; padding:2px 5px; text-align:center; border-bottom:1px solid #243040; }
  td { padding:3px 5px; text-align:center; border-bottom:1px solid #1a2330; }
  td:first-child { text-align:left; color:#9ab; }
  .best { color:#f0c040; font-weight:700; }
  .star { color:#f0c040; margin-left:3px; }
  .margin-row td { color:#556; font-size:11px; border-bottom:none; }
  .profit { color:#27ae60; font-weight:700; }
  .loss { color:#e74c3c; }

  .cand-row td { color:#f39c12 !important; background:#2d1f00; font-weight:700; }
  .timer { display:inline-block; background:#c0392b; color:#fff; font-size:10px; padding:1px 5px; border-radius:3px; margin-left:5px; }

  #hist-wrap { margin-top:16px; }
  #hist-toggle { background:#1a2634; border:1px solid #2c3e50; color:#cfd8e3; padding:7px 14px; border-radius:6px; cursor:pointer; font-size:13px; width:100%; text-align:left; }
  #hist-body { display:none; margin-top:6px; background:#1a2634; border-radius:8px; overflow:hidden; }
  #hist-body.open { display:block; }
  .bet-row { display:grid; grid-template-columns:62px 1fr 28px 44px 52px 52px 48px 80px; gap:6px; padding:5px 10px; border-bottom:1px solid #1e2d3a; font-size:11px; align-items:center; }
  .bet-head { background:#1e2d3a; color:#556; font-weight:600; font-size:11px; }
  .bet-row:last-child { border-bottom:none; }
  .won  { color:#27ae60; font-weight:700; }
  .lost { color:#e74c3c; font-weight:700; }
  .pend { color:#f39c12; }
  #no-bets { padding:14px; color:#556; text-align:center; }
  #status { color:#334; font-size:11px; margin-top:10px; }
</style>
</head>
<body>
<h1>SURE BET + SIMULATOR – SVE eSoccer</h1>
<div id="ts">--</div>

<div id="stats">
  <div class="stat"><span class="stat-label">Ukupan ulog</span><span class="stat-val neu" id="s-ulog">0 din</span></div>
  <div class="stat"><span class="stat-label">Ukupan povrat</span><span class="stat-val neu" id="s-povrat">0.00 din</span></div>
  <div class="stat"><span class="stat-label">Stanje</span><span class="stat-val neu" id="s-stanje">0.00 din</span></div>
  <div class="stat"><span class="stat-label">Odigrano</span><span class="stat-val neu" id="s-br">0</span></div>
</div>

<div id="content"></div>
<div id="status">Učitavam...</div>

<div id="hist-wrap">
  <button id="hist-toggle" onclick="toggleHist()">▼ Historia klađenja (0)</button>
  <div id="hist-body">
    <div class="bet-row bet-head"><span>Vrijeme</span><span>Meč</span><span>I.</span><span>Min.</span><span>SB</span><span>B365</span><span>Razl.</span><span>Rezultat</span></div>
    <div id="hist-rows"><div id="no-bets">Nema klađenja</div></div>
  </div>
</div>

<script>
let histOpen = false;
function toggleHist() {
  histOpen = !histOpen;
  document.getElementById('hist-body').classList.toggle('open', histOpen);
  renderHist(window._lastData);
}

function renderHist(d) {
  if (!d) return;
  document.getElementById('hist-toggle').textContent = (histOpen ? '▲' : '▼') + ' Historia klađenja (' + d.bets.length + ')';
  const hr = document.getElementById('hist-rows');
  if (!d.bets.length) { hr.innerHTML = '<div id="no-bets">Nema klađenja</div>'; return; }
  hr.innerHTML = d.bets.map(b => {
    let res = '<span class="pend">čeka</span>';
    if (b.status === 'won')  res = '<span class="won">✅ +' + b.payout.toFixed(2) + '</span>';
    if (b.status === 'lost') res = '<span class="lost">❌ -1.00</span>';
    const sc = b.finalScore ? ' (' + b.finalScore + ')' : '';
    const minStr = b.betMinute != null ? b.betMinute + "'" : '--';
    return '<div class="bet-row"><span>' + b.time + '</span><span title="' + b.matchName + '">' + b.matchName.slice(0,24) + '</span><span>' + b.outcome + '</span><span>' + minStr + '</span><span>' + b.sbOdd.toFixed(2) + '</span><span>' + b.b365Odd.toFixed(2) + '</span><span>+' + b.diff.toFixed(1) + '%</span><span>' + res + sc + '</span></div>';
  }).join('');
}

async function upd() {
  const d = await fetch('/data?t='+Date.now(),{cache:'no-store'}).then(r=>r.json()).catch(()=>null);
  if (!d) return;
  window._lastData = d;

  document.getElementById('ts').textContent = 'Ažurirano: ' + d.ts;
  document.getElementById('status').textContent = d.status;

  const stanje = d.totalReturn - d.totalStaked;
  document.getElementById('s-ulog').textContent   = d.totalStaked.toFixed(0) + ' din';
  document.getElementById('s-povrat').textContent = d.totalReturn.toFixed(2) + ' din';
  const el = document.getElementById('s-stanje');
  el.textContent = (stanje >= 0 ? '+' : '') + stanje.toFixed(2) + ' din';
  el.className = 'stat-val ' + (stanje > 0 ? 'pos' : stanje < 0 ? 'neg' : 'neu');
  document.getElementById('s-br').textContent = d.bets.length;

  const c = document.getElementById('content');
  if (!d.pairs.length) {
    c.innerHTML = '<div style="color:#556;padding:20px 0;text-align:center">Nema uparenih mečeva — čekam eSoccer rundу...</div>';
  } else {
    c.innerHTML = d.pairs.map(p => {
      const cl = (p.calc.isSure ? ' sure' : '') + (Object.values(p.probRows).some(r => r.isCandidate) ? ' has-cand' : '');
      const badge = p.calc.isSure ? '<span class="sure-badge">SURE BET +' + p.calc.profit.toFixed(2) + '%</span>' : '';
      const overLimit = p.minute != null && p.minute >= p.maxMinute;
      const minStr = overLimit
        ? '<span class="lock">🔒 ' + p.minute + "'" + '</span>'
        : (p.minute != null ? p.minute + "'" : '--');
      const fmtBadge = p.format ? '<span class="fmt-badge">' + p.format + '</span>' : '';
      const rows = ['1','X','2'].map(k => {
        const sOdd   = p.sb[k].toFixed(2);
        const bOdd   = p.b365[k].toFixed(2);
        const bestSrc = p.calc.best[k].src;
        const sCls   = bestSrc === 'Superbet' ? ' class="best"' : '';
        const bCls   = bestSrc === 'Bet365'   ? ' class="best"' : '';
        const star   = (p.calc.isSure && p.calc.bestSuperbet?.key === k) ? '<span class="star">★</span>' : '';
        const pr     = p.probRows[k];
        const diffStr = (pr.diff > 0 ? 'B365-SB +' : '') + pr.diff.toFixed(1) + '%';
        const secLeft = d.candidates[p.sbId + '_' + k];
        const timerHtml = (pr.isCandidate && secLeft != null) ? '<span class="timer">' + secLeft + 's</span>' : '';
        const candCls = pr.isCandidate ? ' class="cand-row"' : '';
        return '<tr' + candCls + '><td>' + k + timerHtml + '</td><td' + sCls + '>' + sOdd + star + '</td><td' + bCls + '>' + bOdd + '</td><td>' + bestSrc.slice(0,3) + '</td><td>' + pr.pSb.toFixed(1) + '%</td><td>' + pr.pB365.toFixed(1) + '%</td><td>' + diffStr + (pr.isCandidate ? ' ★' : '') + '</td></tr>';
      }).join('');
      const marginCls = p.calc.isSure ? 'profit' : 'loss';
      const profitStr = p.calc.isSure ? '+' + p.calc.profit.toFixed(3) + '%' : '-' + Math.abs(p.calc.profit).toFixed(3) + '%';
      return '<div class="pair' + cl + '">' +
        '<div class="pair-name">' + p.name + badge + fmtBadge + '</div>' +
        '<div class="pair-meta">Score: ' + p.score + ' | Min: ' + minStr + ' / ' + p.maxMinute + ' | ' + p.competition + '</div>' +
        '<table><tr><th>I.</th><th>Superbet</th><th>Bet365</th><th>Koristiti</th><th>SB.%</th><th>B365.%</th><th>Razlika</th></tr>' +
        rows +
        '<tr class="margin-row"><td colspan="6">Margin:</td><td class="' + marginCls + '">' + p.calc.margin.toFixed(4) + ' (' + profitStr + ')</td></tr>' +
        '</table></div>';
    }).join('');
  }

  renderHist(d);
}

upd();
setInterval(upd, 500);
</script>
</body>
</html>`;

// ── HTTP server ───────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  if (req.url === "/data" || req.url.startsWith("/data?")) {
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(JSON.stringify(cached));
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
  res.end(HTML);
});

server.listen(PORT, () => {
  console.log(`SVE eSoccer Sure Bet + Simulator: http://localhost:${PORT}`);
});
