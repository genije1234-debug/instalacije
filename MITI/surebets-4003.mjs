/**
 * Sure Bet kalkulator + Simulator klađenja – GT liga
 * Port: 4003
 *
 * Pravila simulacije:
 * - Kandidat: Admiral prob > Bet365 prob za ≥ 6% (jedan ishod)
 * - Mora biti stabilan 8 sekundi
 * - Ne igrati posle 10:00 minuta
 * - Ulog 1 dinar, samo Admiral
 */

import http from "http";
import fs   from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Telegram ──────────────────────────────────────────────────────────────────

const TG_TOKEN   = "8667978657:AAEwD1EdnzRxtAWcWvJKKJUyLJDdQty490Y";
const TG_CHAT_ID = "-5181441932";
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

function tgHourlyReport() {
  const stanje = totalReturn - totalStaked;
  const pending = bets.filter(b => b.status === "pending");
  const znak = stanje >= 0 ? "+" : "";
  const now = new Date().toLocaleTimeString("sr", { hour: "2-digit", minute: "2-digit" });
  let msg = `📊 <b>STANJE — ${now}</b>\n`;
  msg += `Odigrano: ${bets.length} | Ulog: ${totalStaked} din\n`;
  msg += `Povrat: ${totalReturn.toFixed(2)} din | Stanje: <b>${znak}${stanje.toFixed(2)} din</b>\n`;
  if (pending.length > 0) {
    msg += `\n⏳ Čeka razrješenje: ${pending.length}\n`;
    for (const b of pending) {
      msg += `  • ${b.matchName.slice(0,22)} — ${b.outcome} (${b.admOdd.toFixed(2)})\n`;
    }
  } else {
    msg += `✅ Nema oklada koje čekaju`;
  }
  sendTelegram(msg);
}

// Hourly report — šalje na puni sat (XX:00)
function scheduleHourlyReport() {
  const now = new Date();
  const msToNextHour = (60 - now.getMinutes()) * 60000 - now.getSeconds() * 1000 - now.getMilliseconds();
  setTimeout(() => {
    tgHourlyReport();
    setInterval(tgHourlyReport, 60 * 60 * 1000);
  }, msToNextHour);
}

scheduleHourlyReport();

const PORT         = 4003;
const MIN_DIFF_PCT = 6.5;
const STABLE_SEC   = 8;
const MAX_MINUTE   = 10;
const STAKE        = 1;
const GT_DURATION  = 12; // minuta trajanje GT meča

const HISTORY_FILE = path.join(__dirname, "bets-history-4003.json");

// ── Perzistentna historija ────────────────────────────────────────────────────

function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const raw = fs.readFileSync(HISTORY_FILE, "utf8");
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
// key = `${admId}_${outcome}`
const candidates         = new Map();
const lastSeenScore      = new Map(); // admId → zadnji viđeni Admiral score
const lastB365Data       = new Map(); // b365Id → "score|o1|oX|o2" fingerprint
const lastB365Change     = new Map(); // b365Id → ms timestamp zadnje promene
const lastB365ScoreCache = new Map(); // b365Id → zadnji poznati Bet365 score

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
    const url = port === 3000
      ? `http://localhost:3000/api/data`
      : `http://localhost:4001/state`;
    const res = await fetch(url, { cache: "no-store" });
    return await res.json();
  } catch {
    return null;
  }
}

// ── Izvuci 1X2 kvote iz Admiral slota ────────────────────────────────────────

function admiral1x2(slot) {
  const odds = slot.odds ?? [];

  // Samo tačan market "Konačan ishod" — ništa drugo
  const pool = odds.filter(o =>
    (o.market ?? "").toLowerCase().includes("konačan ishod") ||
    (o.market ?? "").toLowerCase().includes("konacan ishod")
  );

  if (pool.length < 3) return null;

  const find = (names) => pool.find(o =>
    names.some(n => String(o.outcome ?? "").toLowerCase().trim() === n)
  );

  const o1 = find(["1", "domaćin", "domacin", "home", "1 (domacin)"]);
  const oX = find(["x", "nerešeno", "nereseno", "draw", "remi"]);
  const o2 = find(["2", "gost", "away"]);

  if (!o1 || !oX || !o2) return null;
  return { "1": o1.odd, "X": oX.odd, "2": o2.odd };
}

// ── Izvuci 1X2 kvote iz Bet365 slota (port 4001 format: odds=[n1,nX,n2]) ──────

function bet3651x2(slot) {
  const o = slot.odds;
  if (!Array.isArray(o) || o.length < 3) return null;
  if (!o[0] || !o[1] || !o[2]) return null;
  return { "1": o[0], "X": o[1], "2": o[2] };
}

// ── Fuzzy match imena mečeva ──────────────────────────────────────────────────

function normName(n) {
  return (n ?? "").toLowerCase()
    .replace(/[^a-z0-9]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Razdvoji ime meča na home i away dio (split na " v " ili " - ")
function splitSides(name) {
  const n = name ?? "";
  const sep = n.includes(" v ") ? " v " : " - ";
  const idx = n.indexOf(sep);
  if (idx === -1) return { home: n, away: "" };
  return { home: n.slice(0, idx), away: n.slice(idx + sep.length) };
}

// Iz "Real Madrid (Lucas)" izvuci { team: "real madrid", player: "lucas" }
function extractParts(side) {
  const m = side.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  if (m) return { team: normName(m[1]), player: normName(m[2]) };
  return { team: normName(side), player: null };
}

// Loose poređenje: isti string ili jedan sadrži drugog (Man City ⊂ Manchester City)
function looseEq(a, b) {
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

// Svaki dio meča = 1 token: ime domaćina, igrač domaćina, ime gosta, igrač gosta
// Treba ≥ 3 poklapanja od 4 mogućih
function matchScore(nameA, nameB) {
  const sA = splitSides(nameA);
  const sB = splitSides(nameB);
  const hA = extractParts(sA.home);
  const hB = extractParts(sB.home);
  const aA = extractParts(sA.away);
  const aB = extractParts(sB.away);

  return (looseEq(hA.team,   hB.team)   ? 1 : 0)
       + (looseEq(hA.player, hB.player) ? 1 : 0)
       + (looseEq(aA.team,   aB.team)   ? 1 : 0)
       + (looseEq(aA.player, aB.player) ? 1 : 0);
}

// ── Kalkulator sure bet ───────────────────────────────────────────────────────

function calcSureBet(adm, b365) {
  const best = {
    "1": { odd: Math.max(adm["1"], b365["1"]), src: adm["1"] >= b365["1"] ? "Admiral" : "Bet365" },
    "X": { odd: Math.max(adm["X"], b365["X"]), src: adm["X"] >= b365["X"] ? "Admiral" : "Bet365" },
    "2": { odd: Math.max(adm["2"], b365["2"]), src: adm["2"] >= b365["2"] ? "Admiral" : "Bet365" },
  };
  const margin = 1 / best["1"].odd + 1 / best["X"].odd + 1 / best["2"].odd;
  const profit = (1 - margin) * 100;
  const isSure = margin < 1.0;

  let bestAdmiral = null;
  if (isSure) {
    let maxDiff = -Infinity;
    for (const key of ["1", "X", "2"]) {
      const probAdm  = (1 / adm[key])  * 100;
      const probB365 = (1 / b365[key]) * 100;
      const diff = probAdm - probB365;
      if (diff > maxDiff) { maxDiff = diff; bestAdmiral = { key, diff }; }
    }
  }

  return { best, margin, profit, isSure, bestAdmiral };
}

// ── Parsiranje minute ─────────────────────────────────────────────────────────

function parseMinute(min) {
  if (min == null) return null;
  const s = String(min);
  const m = s.match(/^(\d+)/);
  return m ? parseInt(m[1]) : null;
}

// ── Normalizacija score-a za poređenje ────────────────────────────────────────
// Izvlači "H:A" iz bilo kog formata: "1 : 0", "1-0", "1:0", "1 - 0"

function normalizeScore(s) {
  if (!s || s === "--") return null;
  const m = String(s).match(/(\d+)\D+(\d+)/);
  if (!m) return null;
  return `${m[1]}:${m[2]}`;
}

function scoresMatch(admScore, b365Score) {
  const a = normalizeScore(admScore);
  const b = normalizeScore(b365Score);
  if (!a || !b) return true; // ako jedan nema score, ne blokiramo
  return a === b;
}

// ── Razrješenje klađenja po finalnom score-u ──────────────────────────────────

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
    const payout = parseFloat((bet.admOdd * STAKE).toFixed(2));
    bet.payout   = payout;
    totalReturn += payout;
  } else {
    bet.payout = 0;
  }
  console.log(`RESULT: ${bet.matchName} | ${bet.outcome} | ${bet.status} | score=${score}`);
  saveHistory();
}

// ── Provjeri završene mečeve i razriješi klađenja ─────────────────────────────
// Logika (bez Bet365):
//  1. Ažuriraj lastSeenScore za sve aktivne Admiral slotove
//  2. Ako meč postoji na Admiralu i ended=true → razriješi odmah
//  3. Ako meč nestao sa Admirala → čekaj (14 - betMinute) minuta od klađenja → razriješi

function checkResolutions(admSlots, b365slots, now) {
  // Ukloni okladu ako je pending duže od 25 minuta — brišemo je bez računanja
  const EXPIRE_MS = 25 * 60 * 1000;
  for (let i = bets.length - 1; i >= 0; i--) {
    const bet = bets[i];
    if (bet.status === "pending" && (now - (bet.placedAt ?? 0)) > EXPIRE_MS) {
      bets.splice(i, 1);
      saveHistory();
      console.log(`EXPIRED (obrisana): ${bet.matchName} | ${bet.outcome}`);
    }
  }

  // Ažuriraj zadnji viđeni score za sve aktivne Admiral slotove
  for (const slot of admSlots) {
    if (slot.score && slot.score !== "--") {
      lastSeenScore.set(slot.id, slot.score);
    }
  }

  for (const bet of bets) {
    if (bet.status !== "pending") continue;

    const admSlot = admSlots.find(s => s.id === bet.admId);

    if (admSlot) {
      // Scenario 1: meč još na Admiralu — čekaj ended signal
      if (!admSlot.ended) continue;
      const scoreToUse = (admSlot.score && admSlot.score !== "--")
        ? admSlot.score
        : lastSeenScore.get(bet.admId) ?? null;
      if (!scoreToUse) continue;
      const result = resolveOutcome(scoreToUse, bet.outcome);
      if (!result) continue;
      applyResult(bet, result, scoreToUse);
    } else {
      // Scenario 2: Admiral nije dao ended — koristimo Bet365 score
      const b365Id = bet.b365Id ?? null;
      if (!b365Id) continue;

      const lastChg   = lastB365Change.get(b365Id) ?? null;
      const b365Score = lastB365ScoreCache.get(b365Id) ?? null;
      if (!lastChg || !b365Score) continue;

      // Živá Bet365 minuta (null = meč nestao sa feeda)
      const b365slot   = b365slots.find(s => s.id === b365Id);
      const b365Minute = b365slot ? parseMinute(b365slot.time) : null;

      if (b365Minute != null) {
        // Meč još na Bet365 fedu — čekaj min >= 11 i 5 min bez promene
        if (b365Minute < 11) continue;
        if (now - lastChg < 5 * 60 * 1000) continue;
      } else {
        // Meč nestao sa Bet365 feeda — razriješi ako je prošlo 8 minuta od zadnje promene
        if (now - lastChg < 8 * 60 * 1000) continue;
      }

      const result = resolveOutcome(b365Score, bet.outcome);
      if (!result) continue;
      applyResult(bet, result, b365Score);
    }
  }
}

// ── Generiši state ────────────────────────────────────────────────────────────

let cached = {
  ts: "--", pairs: [], status: "Pokretanje...",
  bets: [], totalStaked: 0, totalReturn: 0, candidates: {},
};

async function refresh() {
  const [b365, adm] = await Promise.all([fetchState(3001), fetchState(3000)]);
  if (!b365 || !adm) {
    cached.status = `Greška: ${!b365 ? "Bet365" : ""} ${!adm ? "Admiral" : ""} nedostupan`;
    return;
  }

  const b365slots = b365.slots ?? b365.matches ?? [];
  const admSlots  = adm.slots ?? [];

  const now = Date.now();

  // Prati promene na Bet365 slotovima (score ili kvote)
  for (const bs of b365slots) {
    if (!bs.id) continue;
    const o   = bs.odds;
    const sig = `${bs.score ?? ""}|${Array.isArray(o) ? o.join(",") : ""}`;
    if (lastB365Data.get(bs.id) !== sig) {
      lastB365Data.set(bs.id, sig);
      lastB365Change.set(bs.id, now);
    }
    if (bs.score && bs.score !== "--") {
      lastB365ScoreCache.set(bs.id, bs.score);
    }
  }

  // Razriješi završena klađenja
  checkResolutions(admSlots, b365slots, now);
  const pairs = [];
  const activeCandidateKeys = new Set();

  for (const bs of b365slots) {
    const b3 = bet3651x2(bs);
    if (!b3) continue;

    // Nađi najbliži Admiral meč
    let bestAdmSlot = null, bestMatchScore = 0;
    for (const as of admSlots) {
      const sc = matchScore(bs.name, as.name);
      if (sc > bestMatchScore) { bestMatchScore = sc; bestAdmSlot = as; }
    }
    if (!bestAdmSlot || bestMatchScore < 3) continue;

    const adm1 = admiral1x2(bestAdmSlot);
    if (!adm1) continue;

    const calc = calcSureBet(adm1, b3);

    // Vjerovatnoće i diff za simulaciju
    const minute = parseMinute(bestAdmSlot.minute ?? bs.minute);
    const scoreOk = scoresMatch(bestAdmSlot.score, bs.score);
    const canBet  = !bestAdmSlot.ended && minute != null && minute < MAX_MINUTE && scoreOk && !bs.suspend;

    const probRows = {};
    for (const k of ["1", "X", "2"]) {
      const pAdm  = (1 / adm1[k]) * 100;
      const pB365 = (1 / b3[k])   * 100;
      const diff  = pB365 - pAdm;   // pozitivno = Admiral daje bolje odds
      const admOddOk = adm1[k] >= 1.50 && adm1[k] <= 5.00;
      const isCandidate = canBet && diff >= MIN_DIFF_PCT && admOddOk && !(diff >= 20 && minute > 0);
      probRows[k] = { pAdm, pB365, diff, isCandidate };

      if (isCandidate) {
        const key = `${bestAdmSlot.id}_${k}`;
        activeCandidateKeys.add(key);
        if (!candidates.has(key)) {
          candidates.set(key, {
            since: now,
            matchName: bs.name,
            admId: bestAdmSlot.id,
            b365Id: bs.id,
            outcome: k,
            admOdd: adm1[k],
            b365Odd: b3[k],
            diff,
            minute,
          });
          sendTelegram(`🔴🔴🔴 <b>IGRAJ</b> 🔴🔴🔴\nMeč: ${bs.name}\nIshod: <b>${k}</b> | Min: ${minute != null ? minute + "'" : "--"}\nAdmiral: ${adm1[k].toFixed(2)} | Razlika: +${diff.toFixed(1)}%`);
        } else {
          const c = candidates.get(key);
          c.admOdd  = adm1[k];
          c.b365Odd = b3[k];
          c.diff    = diff;
          c.minute  = minute;
        }
      }
    }

    pairs.push({
      name:    bs.name,
      admName: bestAdmSlot.name,
      admId:   bestAdmSlot.id,
      score:   bs.score ?? bestAdmSlot.score ?? "--",
      minute,
      ended:   bestAdmSlot.ended ?? false,
      adm:     adm1,
      b365:    b3,
      calc,
      probRows,
    });
  }

  // Sortiraj: sure betovi prvo, zatim po profitu
  pairs.sort((a, b) => {
    if (a.calc.isSure && !b.calc.isSure) return -1;
    if (!a.calc.isSure && b.calc.isSure) return 1;
    return b.calc.profit - a.calc.profit;
  });

  // Ukloni kandidate koji više nisu aktivni
  for (const key of [...candidates.keys()]) {
    if (!activeCandidateKeys.has(key)) candidates.delete(key);
  }

  // Provjeri kandidate za klađenje (stabilni ≥ 8s)
  for (const [key, c] of candidates) {
    const elapsed = (now - c.since) / 1000;
    if (elapsed >= STABLE_SEC) {
      const alreadyBet = bets.some(b =>
        b.admId === c.admId && b.outcome === c.outcome && b.status === "pending"
      );
      if (!alreadyBet) {
        bets.unshift({
          time:       new Date().toLocaleTimeString("sr"),
          placedAt:   now,
          matchName:  c.matchName,
          admId:      c.admId,
          b365Id:     c.b365Id ?? null,
          outcome:    c.outcome,
          admOdd:     parseFloat(c.admOdd.toFixed(2)),
          b365Odd:    parseFloat(c.b365Odd.toFixed(2)),
          diff:       parseFloat(c.diff.toFixed(1)),
          betMinute:  c.minute ?? null,
          stake:      STAKE,
          status:     "pending",
          finalScore: null,
          payout:     null,
        });
        totalStaked += STAKE;
        saveHistory();
        candidates.delete(key);
        console.log(`BET: ${c.matchName} | ${c.outcome} | adm=${c.admOdd.toFixed(2)} diff=${c.diff.toFixed(1)}% min=${c.minute}`);
        sendTelegram(`🎯 <b>NOVA OKLADA</b>\nMeč: ${c.matchName}\nIshod: <b>${c.outcome}</b> | Min: ${c.minute != null ? c.minute + "'" : "--"}\nAdmiral: ${c.admOdd.toFixed(2)} | Razlika: +${c.diff.toFixed(1)}%`);
      }
    }
  }

  // Preostalo vrijeme za svakog kandidata
  const candInfo = {};
  for (const [key, c] of candidates) {
    const elapsed  = (now - c.since) / 1000;
    const remaining = Math.max(0, STABLE_SEC - elapsed);
    candInfo[key] = parseFloat(remaining.toFixed(1));
  }

  cached = {
    ts: new Date().toLocaleTimeString("sr"),
    pairs,
    status: `${pairs.length} mečeva uparen — ${new Date().toLocaleTimeString("sr")}`,
    bets,
    candidates: candInfo,
    totalStaked,
    totalReturn,
  };
}

setInterval(refresh, 500);
refresh();

// ── HTML UI ───────────────────────────────────────────────────────────────────

const HTML = `<!DOCTYPE html>
<html lang="sr">
<head>
<meta charset="UTF-8">
<title>Sure Bet + Simulator – GT Liga</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0f1923; color: #cfd8e3; font-family: 'Segoe UI', sans-serif; font-size: 13px; padding: 12px; }
  h1 { color: #f0c040; font-size: 17px; margin-bottom: 4px; }
  #ts { color: #556; font-size: 11px; margin-bottom: 10px; }

  /* Statistika */
  #stats { display:flex; gap:16px; margin-bottom:14px; background:#1a2634; padding:10px 14px; border-radius:8px; flex-wrap:wrap; }
  .stat { display:flex; flex-direction:column; align-items:center; }
  .stat-label { color:#778899; font-size:11px; }
  .stat-val { font-size:17px; font-weight:700; margin-top:2px; }
  .pos{color:#27ae60} .neg{color:#e74c3c} .neu{color:#f0c040}

  /* Parovi */
  .pair { background: #1a2634; border-radius: 8px; padding: 12px 14px; margin-bottom: 10px; border-left: 4px solid #2c3e50; }
  .pair.sure { border-left-color: #27ae60; background: #1a2e1e; }
  .pair.has-cand { border-left-color: #f39c12; }
  .pair.sure.has-cand { border-left-color: #27ae60; }
  .pair-name { font-size: 14px; font-weight: 600; color: #e0e8f0; margin-bottom: 4px; }
  .pair-meta { color: #667; font-size: 11px; margin-bottom: 8px; }
  .sure-badge { display:inline-block; background:#27ae60; color:#fff; font-size:11px; font-weight:700; padding:2px 7px; border-radius:4px; margin-left:6px; }
  .lock { color:#e74c3c; font-size:11px; margin-left:4px; }

  table { width:100%; border-collapse:collapse; font-size:12px; }
  th { color:#556; font-weight:500; padding:2px 5px; text-align:center; border-bottom:1px solid #243040; }
  td { padding:3px 5px; text-align:center; border-bottom:1px solid #1a2330; }
  td:first-child { text-align:left; color:#9ab; }
  .best { color:#f0c040; font-weight:700; }
  .star { color:#f0c040; margin-left:3px; }
  .margin-row td { color:#556; font-size:11px; border-bottom:none; }
  .profit { color:#27ae60; font-weight:700; }
  .loss { color:#e74c3c; }

  /* Kandidat red */
  .cand-row td { color:#f39c12 !important; background:#2d1f00; font-weight:700; }
  .timer { display:inline-block; background:#c0392b; color:#fff; font-size:10px; padding:1px 5px; border-radius:3px; margin-left:5px; }

  /* Historia */
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
<h1>SURE BET + SIMULATOR – GT Liga</h1>
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
    <div class="bet-row bet-head"><span>Vrijeme</span><span>Meč</span><span>I.</span><span>Min.</span><span>Adm.</span><span>B365</span><span>Razl.</span><span>Rezultat</span></div>
    <div id="hist-rows"><div id="no-bets">Nema klađenja</div></div>
  </div>
</div>
<div id="status2"></div>

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
    return '<div class="bet-row"><span>' + b.time + '</span><span title="' + b.matchName + '">' + b.matchName.slice(0,24) + '</span><span>' + b.outcome + '</span><span>' + minStr + '</span><span>' + b.admOdd.toFixed(2) + '</span><span>' + b.b365Odd.toFixed(2) + '</span><span>+' + b.diff.toFixed(1) + '%</span><span>' + res + sc + '</span></div>';
  }).join('');
}

async function upd() {
  const d = await fetch('/data?t='+Date.now(),{cache:'no-store'}).then(r=>r.json()).catch(()=>null);
  if (!d) return;
  window._lastData = d;

  document.getElementById('ts').textContent = 'Ažurirano: ' + d.ts;
  document.getElementById('status').textContent = d.status;

  // Stats
  const stanje = d.totalReturn - d.totalStaked;
  document.getElementById('s-ulog').textContent   = d.totalStaked.toFixed(0) + ' din';
  document.getElementById('s-povrat').textContent = d.totalReturn.toFixed(2) + ' din';
  const el = document.getElementById('s-stanje');
  el.textContent = (stanje >= 0 ? '+' : '') + stanje.toFixed(2) + ' din';
  el.className = 'stat-val ' + (stanje > 0 ? 'pos' : stanje < 0 ? 'neg' : 'neu');
  document.getElementById('s-br').textContent = d.bets.length;

  // Parovi
  const c = document.getElementById('content');
  if (!d.pairs.length) {
    c.innerHTML = '<div style="color:#556;padding:20px 0;text-align:center">Nema uparenih mečeva — čekam GT rundu...</div>';
  } else {
    c.innerHTML = d.pairs.map(p => {
      const cl = (p.calc.isSure ? ' sure' : '') + (Object.values(p.probRows).some(r => r.isCandidate) ? ' has-cand' : '');
      const badge = p.calc.isSure ? '<span class="sure-badge">SURE BET +' + p.calc.profit.toFixed(2) + '%</span>' : '';
      const overLimit = p.minute != null && p.minute >= 10;
      const minStr = overLimit ? '<span class="lock">🔒 ' + p.minute + "'" + '</span>' : (p.minute != null ? p.minute + "'" : '--');
      const rows = ['1','X','2'].map(k => {
        const aOdd   = p.adm[k].toFixed(2);
        const bOdd   = p.b365[k].toFixed(2);
        const bestSrc = p.calc.best[k].src;
        const aCls   = bestSrc === 'Admiral' ? ' class="best"' : '';
        const bCls   = bestSrc === 'Bet365'  ? ' class="best"' : '';
        const star   = (p.calc.isSure && p.calc.bestAdmiral?.key === k) ? '<span class="star">★</span>' : '';
        const pr     = p.probRows[k];
        const diffStr = (pr.diff > 0 ? 'B365-Adm +' : '') + pr.diff.toFixed(1) + '%';
        const secLeft = d.candidates[p.admId + '_' + k];
        const timerHtml = (pr.isCandidate && secLeft != null) ? '<span class="timer">' + secLeft + 's</span>' : '';
        const candCls = pr.isCandidate ? ' class="cand-row"' : '';
        return '<tr' + candCls + '><td>' + k + timerHtml + '</td><td' + aCls + '>' + aOdd + star + '</td><td' + bCls + '>' + bOdd + '</td><td>' + bestSrc.slice(0,3) + '</td><td>' + pr.pAdm.toFixed(1) + '%</td><td>' + pr.pB365.toFixed(1) + '%</td><td>' + diffStr + (pr.isCandidate ? ' ★' : '') + '</td></tr>';
      }).join('');
      const marginCls = p.calc.isSure ? 'profit' : 'loss';
      const profitStr = p.calc.isSure ? '+' + p.calc.profit.toFixed(3) + '%' : '-' + Math.abs(p.calc.profit).toFixed(3) + '%';
      return '<div class="pair' + cl + '">' +
        '<div class="pair-name">' + p.name + badge + '</div>' +
        '<div class="pair-meta">Score: ' + p.score + ' | Min: ' + minStr + ' | Admiral: ' + p.admName + '</div>' +
        '<table><tr><th>I.</th><th>Admiral</th><th>Bet365</th><th>Koristiti</th><th>Adm.%</th><th>B365.%</th><th>Razlika</th></tr>' +
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
  console.log(`Sure Bet + Simulator: http://localhost:${PORT}`);
});
