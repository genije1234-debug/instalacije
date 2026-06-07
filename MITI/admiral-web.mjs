/**
 * Admiral GT+eFoot – Web prikaz
 *
 * Arhitektura:
 *  1. Puppeteer otvori Chrome → navigira na admiralbet.rs/sport-live
 *  2. CDP presreće mrežne odgovore (livetree, GetLiveResults)
 *  3. Flatten-uje tree strukturu, filtrira GT+eFoot mečeve
 *  4. Lokalni HTTP server na :3000 servira lepi web prikaz
 *  5. Browser se automatski otvara na localhost:3000
 */

import http from "http";
import https from "https";
import { exec } from "child_process";
import fs from "fs";
import puppeteer from "puppeteer-core";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3000;
const SLOT_MAX = 20;

const CHROME_PATHS = [
  process.env.LOCALAPPDATA + "\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
].filter(p => p && fs.existsSync(p));

// ── helpers ─────────────────────────────────────────────────────────────────

function norm(s) {
  return String(s || "").toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
}

/**
 * Pretvori livetree strukturu (sport → regions → competitions → events) u flat listu.
 * Svaki meč dobija sportName, competitionName, regionName.
 */
function flattenTree(treeItems) {
  const flat = [];
  for (const sport of treeItems) {
    const sportName = sport.name ?? "";
    for (const region of (sport.regions ?? [])) {
      const regionName = region.regionName ?? "";
      for (const comp of (region.competitions ?? [])) {
        const competitionName = comp.competitionName ?? "";
        const competitionId = comp.id ?? comp.competitionId ?? null;
        for (const ev of (comp.events ?? [])) {
          const evFlat = { ...ev, sportName, regionName, competitionName, competitionId,
            sportId: sport.id ?? null, regionId: region.id ?? region.regionId ?? null };
          // LOG i registruj GT event ID za request praćenje
          if (isTarget(evFlat)) {
            if (ev.id) _gtIds.add(ev.id);
            if (!evFlat._treeLogged) {
              evFlat._treeLogged = true;
              const hasBets = Array.isArray(ev.bets) ? ev.bets.length : "nema";
              const betsCount = ev.betsCount ?? "?";
              const betNames = Array.isArray(ev.bets) ? ev.bets.map(b=>`${b.betTypeName}(offer=${b.isInOffer},active=${b.isActive})`).join(" | ") : "";
              console.log(`  [TREE-GT] ev=${ev.id} betsInTree=${hasBets} betsCount=${betsCount} | ${betNames.slice(0,400)}`);
            }
          }
          flat.push(evFlat);
        }
      }
    }
  }
  return flat;
}

function eventText(ev) {
  return [ev.sportName, ev.competitionName, ev.regionName, ev.name]
    .filter(Boolean).map(norm).join(" ");
}

function isTarget(ev) {
  if (!ev) return false;
  const compN = (ev.competitionName ?? "").toLowerCase();
  return /\bgt\b|\bgts\b/.test(compN) || compN.includes("gt sports");
}

const SUSPENDED_STATUSES = new Set(["suspended", "locked", "closed", "inactive", "notinplay"]);

function isSuspended(obj) {
  if (!obj || typeof obj !== "object") return false;
  if (obj.suspended === true) return true;
  if (obj.isInOffer === false) return true;
  if (obj.isActive === false) return true;
  if (obj.isPlayable === false) return true;
  const st = String(obj.betStatus ?? obj.status ?? obj.state ?? "").toLowerCase().replace(/\s/g,"");
  return SUSPENDED_STATUSES.has(st);
}

function extractOdds(ev) {
  const out = [];
  // Trenutni score za filtriranje nemogucih sBV tržišta
  const ls = liveState.get(ev.id);
  let curHome = null, curAway = null;
  const scoreStr = ls?.score ?? ev.score ?? ev.currentScore ?? null;
  if (scoreStr) {
    const sp = String(scoreStr).match(/(\d+)\D+(\d+)/);
    if (sp) { curHome = parseInt(sp[1]); curAway = parseInt(sp[2]); }
  }
  let sbvFiltered = 0;
  for (const bet of (ev.bets ?? [])) {
    if (isSuspended(bet)) continue;
    // Preskoči tržišta čiji sBV score je nemoguć (manji od trenutnog)
    if (bet.sBV != null && curHome != null) {
      const sbvM = String(bet.sBV).match(/^(\d+)\s*[:\-]\s*(\d+)$/);
      if (sbvM) {
        const sh = parseInt(sbvM[1]), sa = parseInt(sbvM[2]);
        if (sh < curHome || sa < curAway) { sbvFiltered++; continue; }
      }
    }
    // Preskoči resolved tržišta ukupnih golova (Admiral ih sklanja)
    if (curHome !== null && curAway !== null && bet.sBV != null) {
      const thr = parseFloat(String(bet.sBV).replace(",", "."));
      if (!isNaN(thr)) {
        const bName = (bet.betTypeName ?? "").toLowerCase();
        const total = curHome + curAway;
        // Ukupno golova X — rešeno kad total > X
        if (/ukupno\s*gol/i.test(bName) && total > thr) { sbvFiltered++; continue; }
        // Domaćin ukupno X — rešeno kad home > X
        if (/doma[cć]in\s*ukupno/i.test(bName) && curHome > thr) { sbvFiltered++; continue; }
        // Gost ukupno X — rešeno kad away > X
        if (/gost\s*ukupno/i.test(bName) && curAway > thr) { sbvFiltered++; continue; }
      }
    }
    const sbv = bet.sBV != null ? ` ${bet.sBV}` : "";
    const marketName = `${bet.betTypeName ?? bet.betTypeId ?? "market"}${sbv}`;
    for (const outcome of (bet.betOutcomes ?? bet.outcomes ?? [])) {
      if (isSuspended(outcome)) continue;
      const odd = outcome.odd ?? outcome.price ?? outcome.coefficient ?? outcome.value;
      if (typeof odd === "number" && odd > 1.01 && odd < 99) {
        out.push({
          market: String(marketName).slice(0, 30),
          outcome: String(outcome.name ?? outcome.outcomeName ?? outcome.outcomeId ?? ""),
          odd,
        });
      }
    }
  }
  if (isTarget(ev)) {
    const betNames = (ev.bets ?? []).map(b => b.betTypeName ?? "?").join(", ");
    console.log(`  extractOdds GT [${ev.id}] score="${ls?.score}" bets=${(ev.bets??[]).length} sbvFiltered=${sbvFiltered} prikazano=${out.length} | tipovi: ${betNames.slice(0,200)}`);
  }
  return out;
}

// ── periodično osvežavanje bets putem browser fetch (sa session cookie) ──────

async function refreshBetsForGT(eventId) {
  const ev = eventCache.get(eventId);
  if (!ev || !isTarget(ev)) return;
  const compId = ev.competitionId;
  if (!compId || !_cdp) return;
  try {
    const url = `https://srboffer.admiralbet.rs/offer/${compId}/${eventId}`;
    // Koristimo CDP Network.loadNetworkResource — šalje zahtev sa browser cookie
    const res = await _cdp.send("Network.loadNetworkResource", {
      frameId: _mainFrameId,
      url,
      options: { disableCache: false, includeCredentials: true }
    });
    if (!res?.resource?.success || !res.resource.httpStatusCode || res.resource.httpStatusCode !== 200) return;
    // Pročitaj body iz stream-a
    const streamHandle = res.resource.stream;
    if (!streamHandle) return;
    let body = "";
    while (true) {
      const chunk = await _cdp.send("IO.read", { handle: streamHandle, size: 65536 });
      body += chunk.data ?? "";
      if (chunk.eof) break;
    }
    await _cdp.send("IO.close", { handle: streamHandle }).catch(() => {});
    const data = JSON.parse(body);
    let bets = null;
    if (data && Array.isArray(data.bets)) bets = data.bets;
    else if (Array.isArray(data)) bets = data;
    if (bets !== null && bets.length > 0) {
      const cached = eventCache.get(eventId);
      if (cached && isTarget(cached)) {
        cached.bets = bets;
        const tipovi = [...new Set(bets.map(b => b.betTypeName ?? b.betTypeId ?? "?"))].slice(0, 6).join(", ");
        console.log(`  [REFRESH] Bete ${eventId}: ${bets.length} | ${tipovi}`);
        rebuildSlots();
      }
    }
  } catch (e) { console.log(`  [REFRESH ERR] ${eventId}: ${e.message?.slice(0,80)}`); }
}

const _gtIds = new Set(); // Global set GT event ID-eva za request praćenje

// ── stanje ──────────────────────────────────────────────────────────────────

let state = {
  ts: "--", totalLive: 0, totalGT: 0, slots: [], allNames: [], error: null, status: "Pokretanje..."
};

const activeIds = new Set();
let _loggedUrls = null;
let _betFieldsLogged = false;
let _statusLogged = false;
let _onScoreChange = null;
let _fetchBets = null;
let _mainPage = null;
let _cdp = null; // CDP session — za Network.loadNetworkResource sa session cookie
let _mainFrameId = null;
let _ccKeysLogged = false;
let _gwbLogged = false; // callback: (eventId) => void — poziva se kad se rezultat promeni
let _rawSample = null;

// Keš punih event objekata po ID-u (za ažuriranje kvota)
const eventCache = new Map();

// Live state po eventId: { score, minute, period }
const liveState = new Map();

// Watchdog — prati kad je zadnji put stigao podatak
let _lastDataAt = Date.now();
function touchData() { _lastDataAt = Date.now(); }

// Mapa competitionId → competitionName (gradi se iz punog tree-a)
const competitionMap = new Map();

function parseLiveStateResponse(data) {
  // Format: { "eventId": { homeScore, awayScore, minute, ... } }
  if (typeof data !== "object" || Array.isArray(data)) return;
  for (const [key, val] of Object.entries(data)) {
    const id = parseInt(key);
    if (isNaN(id) || !val || typeof val !== "object") continue;
    const score = val.result ?? val.currentResult ?? val.score ?? null;
    const homeScore = val.homeScore ?? val.home ?? val.homeGoals ?? null;
    const awayScore = val.awayScore ?? val.away ?? val.guestScore ?? val.awayGoals ?? null;
    const minute = val.extMatchTime ?? val.matchTime ?? val.minute ?? val.time ?? null;
    // period iz status polja: "1p"→"1. pol.", "2p"→"2. pol.", "HT"/"Ht"→"Poluvreme", itd.
    const statusRaw = val.status ?? "";
    let period = null;
    if (/^1p$/i.test(statusRaw))        period = "1. pol.";
    else if (/^2p$/i.test(statusRaw))   period = "2. pol.";
    else if (/^ht$/i.test(statusRaw))   period = "⏸ Poluvreme";
    else if (/^et$/i.test(statusRaw))   period = "Produžeci";
    else if (statusRaw)                  period = statusRaw;
    const betStatus = val.betStatus ?? "";
    const isEnded   = betStatus === "Ended" || betStatus === "Finished" || betStatus === "Completed" ||
                      betStatus === "STOPPED" ||
                      /^(end|fin|finished|completed|over|ft|fulltime)$/i.test(statusRaw);
    const isHT      = betStatus === "Halftime" || /^ht$/i.test(statusRaw);
    // Loguj status za GT mečeve jednom
    if (!_statusLogged && (eventCache.size > 0)) {
      _statusLogged = true;
      console.log(`  liveState status sample: betStatus="${betStatus}" status="${statusRaw}" id=${id}`);
    }
    const isLive    = betStatus === "Live" && !isHT;
    // Detektuj promenu rezultata → pozovi re-fetch
    const prev = liveState.get(id);
    const scoreChanged = prev && (prev.homeScore !== homeScore || prev.awayScore !== awayScore ||
                                  (score != null && prev.score !== score));
    if (scoreChanged && isTarget(eventCache.get(id))) {
      if (_onScoreChange) _onScoreChange(id);
    }
    // Loguj betStatus za sve mečeve jednom — da uhvatimo kraj
    if (betStatus && betStatus !== "Live") {
      console.log(`  [status] id=${id} betStatus="${betStatus}" status="${statusRaw}"`);
    }
    liveState.set(id, { score, homeScore, awayScore, minute, period, isEnded, isHT, raw: val,
                        receivedAt: (!isEnded && !isHT) ? Date.now() : null });
  }
}

function rebuildSlots() {
  touchData();
  // Prikazuj samo mečeve koji imaju bete (aktivni runovi)
  const targets = [...eventCache.values()].filter(ev => isTarget(ev) && ev.bets && ev.bets.length > 0);
  const liveIds = new Set(targets.map(e => e.id));
  for (const id of activeIds) { if (!liveIds.has(id)) activeIds.delete(id); }
  for (const ev of targets) {
    if (activeIds.size >= SLOT_MAX) break;
    activeIds.add(ev.id);
  }
  const slots = [...activeIds].map(id => {
    const ev = eventCache.get(id);
    if (!ev) return null;
    const ls = liveState.get(id);
    const score = ls?.score ?? ev.score ?? ev.currentScore ?? null;
    const matchEnded = ls?.isEnded ?? false;
    const isHT       = ls?.isHT ?? false;
    return {
      id: ev.id,
      name: ev.name ?? `#${ev.id}`,
      sport: ev.sportName ?? "",
      league: ev.competitionName ?? ev.regionName ?? "",
      status: ev.status ?? "LIVE",
      score,
      ended: matchEnded,
      halftime: isHT,
      minute: (() => {
        if (matchEnded) return ls?.minute ?? ev.minute ?? null;
        const raw = ls?.minute ?? ev.minute ?? null;
        if (raw == null || ls?.receivedAt == null) return raw;
        const parts = String(raw).split(":");
        let totalSec = parts.length === 2
          ? parseInt(parts[0]) * 60 + parseInt(parts[1])
          : parseInt(parts[0]) * 60;
        totalSec += Math.floor((Date.now() - ls.receivedAt) / 1000);
        const m = Math.floor(totalSec / 60);
        const s = totalSec % 60;
        return `${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
      })(),
      period: ls?.period ?? null,
      betsCount: ev.betsCount ?? ev.bets?.length ?? 0,
      odds: matchEnded ? [] : extractOdds(ev).slice(0, 50),
    };
  }).filter(slot => {
    if (!slot) return false;
    if (!slot.ended && slot.minute != null) {
      const mNum = parseInt(String(slot.minute).split(":")[0]);
      if (!isNaN(mNum) && mNum >= 29) return false;
    }
    return true;
  });

  const allNames = [...new Set([...eventCache.values()].map(e =>
    `${e.sportName ?? "?"} / ${e.competitionName ?? "?"}`
  ))].slice(0, 30);

  state = {
    ts: new Date().toLocaleTimeString("sr"),
    totalLive: eventCache.size,
    totalGT: targets.length,
    slots,
    allNames,
    error: null,
    status: `OK – ${new Date().toLocaleTimeString("sr")}`,
  };
}

function applyOutcomeUpdate(outcomes) {
  // Minifikovani format: iD=[outcomeId,?,?,?,eventId,betId], n=[?,?,odd,...], b=[isInOffer,...], t=[betTypeName,outcomeName,sBV]
  let changed = 0;
  for (const ou of outcomes) {
    const ids = ou.iD;
    if (!Array.isArray(ids) || ids.length < 6) continue;
    const outcomeId = ids[0];
    const eventId   = ids[4];
    const betId     = ids[5];
    const odd       = Array.isArray(ou.n) ? ou.n[2] : null;
    const isInOffer = Array.isArray(ou.b) ? (ou.b[0] === 1 || ou.b[0] === true) : null;
    const isActive  = Array.isArray(ou.b) ? ((ou.b[1] === 1 || ou.b[1] === true) && (ou.b[2] === 1 || ou.b[2] === true)) : null; // b[1]*b[2] = isActive

    const ev = eventCache.get(eventId);
    if (!ev) continue;
    if (!ev.bets) {
      if (isTarget(ev)) {
        ev.bets = [];
        if (_fetchBets && !ev._fetchedBets) { ev._fetchedBets = true; _fetchBets(eventId); }
      }
      continue;
    }
    let bet = ev.bets.find(b => b.id === betId);
    if (!bet) {
      if (isTarget(ev)) {
        // Admiral dodao novu bet grupu tokom meča — kreiraj je iz CacheChanges podataka
        const betTypeName = Array.isArray(ou.t) ? ou.t[0] : null;
        const sBV         = Array.isArray(ou.t) ? (ou.t[2] ?? null) : null;
        if (betTypeName && isInOffer !== false) {
          bet = { id: betId, betTypeName, sBV, isInOffer: true, betOutcomes: [] };
          ev.bets.push(bet);
          console.log(`  CC-GT new bet: ev=${eventId} bet=${betId} "${betTypeName}${sBV?' '+sBV:''}" `);
        } else {
          continue;
        }
      } else {
        continue;
      }
    }
    if (!bet.betOutcomes) bet.betOutcomes = [];
    const outcome = bet.betOutcomes.find(o => o.id === outcomeId);
    if (outcome) {
      if (odd != null && odd > 1.0) { outcome.odd = odd; changed++; }
      if (isInOffer != null && outcome.isInOffer !== isInOffer) {
        outcome.isInOffer = isInOffer;
        changed++;
        if (isTarget(ev) && isInOffer === false) {
          console.log(`  CC-GT SKLONJEN (isInOffer): ev=${eventId} "${bet.betTypeName}${bet.sBV?' '+bet.sBV:''}" ishod="${outcome.name}" b=${JSON.stringify(ou.b)}`);
        }
      }
      if (isActive != null && outcome.isActive !== isActive) {
        outcome.isActive = isActive;
        changed++;
        if (isTarget(ev) && isActive === false) {
          console.log(`  CC-GT SKLONJEN (isActive): ev=${eventId} "${bet.betTypeName}${bet.sBV?' '+bet.sBV:''}" ishod="${outcome.name}" b=${JSON.stringify(ou.b)}`);
        }
      }
    } else if (isInOffer !== false) {
      // Novi outcome za postojeći ili tek kreiran bet
      const outcomeName = Array.isArray(ou.t) ? (ou.t[1] ?? null) : null;
      if (outcomeName && odd != null && odd > 1.0) {
        bet.betOutcomes.push({ id: outcomeId, name: outcomeName, odd, isInOffer: true, isActive: isActive ?? true });
        changed++;
      }
    }
  }
  if (changed > 0) {
    console.log(`  CC: ažurirano ${changed} kvota`);
    rebuildSlots();
  }
}

function applyResultsUpdate(results) {
  // Format minifikovan: {iD:[eventId,...], t:[betStatus, extMatchTime, null, minute, score, details, period, ...]}
  // ili normalan: {eventId, result, homeScore, awayScore}
  let changed = 0;
  for (const r of results) {
    let eid, score, minute, period, betSt, isEnded;
    if (Array.isArray(r.iD)) {
      // Minifikovani format
      eid     = r.iD[0];
      betSt   = Array.isArray(r.t) ? (r.t[0] ?? "") : "";
      minute  = Array.isArray(r.t) ? (r.t[1] ?? r.t[3] ?? null) : null;
      score   = Array.isArray(r.t) ? (r.t[4] ?? null) : null;
      period  = Array.isArray(r.t) ? (r.t[6] ?? null) : null;
      isEnded = betSt === "STOPPED" || /^(ft|fulltime|end|finished)$/i.test(betSt) ||
                /^(ft|fulltime|end|finished)$/i.test(period ?? "");
    } else {
      // Normalni format
      eid     = r.eventId ?? r.eI ?? r.id ?? null;
      score   = r.result ?? r.currentResult ?? r.score ?? null;
      minute  = null;
      period  = null;
      betSt   = r.betStatus ?? "";
      isEnded = betSt === "STOPPED" || betSt === "Ended";
    }
    if (!eid || !eventCache.has(eid)) continue;
    const prev = liveState.get(eid) ?? {};
    const newScore = score ?? prev.score;
    const scoreChanged = newScore != null && prev.score !== newScore;
    const now2 = (!isEnded && betSt !== "STOPPED") ? Date.now() : (prev.receivedAt ?? null);
    liveState.set(eid, { ...prev, score: newScore,
      minute: minute ?? prev.minute,
      period: period ?? prev.period,
      isEnded: isEnded || (prev.isEnded ?? false),
      receivedAt: now2 });
    if (scoreChanged) {
      console.log(`  Score ${eid}: "${prev.score}" → "${newScore}" betSt="${betSt}"`);
      const evSC = eventCache.get(eid);
      if (isTarget(evSC)) {
        if (_onScoreChange) _onScoreChange(eid);
      }
      changed++;
    }
    // Kada meč završi ili pređe u HT — odmah skloni sve bets za GT mečeve
    const evNow = eventCache.get(eid);
    if (isTarget(evNow)) {
      const isHT2 = /^(ht|halftime|poluvreme)$/i.test(period ?? "") || /^(ht|halftime)$/i.test(betSt ?? "");
      if (isEnded) {
        console.log(`  KRAJ GT ${eid}: betSt="${betSt}" period="${period}" — sklanjam igre odmah`);
        if (evNow.bets) { evNow.bets = []; }
        setTimeout(() => { eventCache.delete(eid); rebuildSlots(); }, 20000);
        changed++;
      } else if (isHT2 && evNow.bets && evNow.bets.length > 0) {
        // Poluvreme — Admiral sklanja sve igre osim Konačan ishod
        console.log(`  HT GT ${eid}: period="${period}" — sklanjam sve osim konačnog ishoda`);
        evNow.bets = evNow.bets.filter(b => /konacan|konacni|final|fulltime|1x2/i.test(b.betTypeName ?? ""));
        changed++;
      }
    }
    if (isEnded) rebuildSlots();
  }
  if (changed > 0) rebuildSlots();
}

function applyOddsUpdate(bets) {
  // CacheChanges format: [{id, eventId, betOutcomes:[{id,odd}]}]
  let changed = 0;
  for (const betUpdate of bets) {
    const ev = eventCache.get(betUpdate.eventId);
    if (!ev || !ev.bets) continue;
    const bet = ev.bets.find(b => b.id === betUpdate.id);
    if (!bet) continue;
    for (const outcomeUpdate of (betUpdate.betOutcomes ?? [])) {
      const outcome = bet.betOutcomes?.find(o => o.id === outcomeUpdate.id);
      if (outcome && outcomeUpdate.odd != null) {
        outcome.odd = outcomeUpdate.odd;
        changed++;
      }
    }
    // ažuriraj i isInOffer
    if (betUpdate.isInOffer != null) {
      if (isTarget(ev) && betUpdate.isInOffer === false && bet.isInOffer !== false) {
        console.log(`  CC-GT BET SKLONJEN: ev=${betUpdate.eventId} "${bet.betTypeName}${bet.sBV?' '+bet.sBV:''}"`);
      }
      bet.isInOffer = betUpdate.isInOffer;
    }
  }
  if (changed > 0) {
    console.log(`  CacheChanges: ažurirano ${changed} kvota`);
    rebuildSlots();
  }
}

function applyBetSuspension(bets) {
  // changedBets minified format: iD[4]=eventId, b[2]*b[3]*b[4]=playable, n[0]=betTypeId, t[1]=sBV
  let changed = 0;
  for (const bet of bets) {
    if (!Array.isArray(bet.iD) || bet.iD.length < 5) continue;
    const eventId = bet.iD[4];
    const ev = eventCache.get(eventId);
    if (!ev || !ev.bets) continue;
    const b = bet.b ?? [];
    const playable = (b[2] ?? 0) * (b[3] ?? 0) * (b[4] ?? 0);
    const suspended = !playable;
    const betTypeId = Array.isArray(bet.n) ? bet.n[0] : null;
    if (betTypeId == null) continue;
    const matchedBet = ev.bets.find(bObj => bObj.id === betTypeId || bObj.betTypeId === betTypeId);
    if (matchedBet && matchedBet.suspended !== suspended) {
      matchedBet.suspended = suspended;
      changed++;
    }
  }
  if (changed > 0) rebuildSlots();
}

function processEvents(raw) {
  if (!raw || raw.length === 0) return;

  // Ako je tree struktura (ima "regions"), flatten-uj
  const isTree = raw[0] && Array.isArray(raw[0].regions);
  const all = isTree ? flattenTree(raw) : raw;

  if (all.length === 0) return;

  if (!_rawSample) {
    _rawSample = raw[0];
    if (isTree) {
      console.log("Tree: sportovi:", raw.map(s => s.name).join(", "));
      // Nađi E/Fudbal sport čvor
      const efSport = raw.find(s => norm(s.name ?? "").includes("efudbal") || norm(s.name ?? "").includes("e/fudbal") || norm(s.name ?? "").includes("e fudbal"));
      if (efSport) {
        const efAll = flattenTree([efSport]);
        console.log(`  E/Fudbal node="${efSport.name}" events=${efAll.length}:`, efAll.slice(0,10).map(e => `[${e.id}] "${e.name}" comp="${e.competitionName}"`).join(" | "));
      } else {
        // Loguj sve sportove i njihove prve 2 eventa
        for (const sp of raw) {
          const evs = flattenTree([sp]);
          if (evs.length > 0) console.log(`  Sport "${sp.name}" (${evs.length}): ${evs.slice(0,2).map(e => `[${e.id}]"${e.name}" comp="${e.competitionName}"`).join(" | ")}`);
        }
      }
    }
  }

  // Puni competitionMap iz tree podataka
  if (isTree) {
    for (const ev of all) {
      if (ev.competitionId != null && ev.competitionName) {
        competitionMap.set(ev.competitionId, ev.competitionName);
      }
    }
  }

  // Novi skup live ID-eva iz ovog odgovora
  const freshIds = new Set(all.map(e => e.id).filter(Boolean));
  const now = Date.now();

  // Ukloni iz keša sve NON-GT događaje koji više nisu live
  // GT mečeve NE brišemo ovde — brišu se samo via mergeEvents (parcijalni GT tree) ili END detekcija
  for (const id of eventCache.keys()) {
    const cached = eventCache.get(id);
    if (!freshIds.has(id) && !isTarget(cached)) eventCache.delete(id);
  }

  // Popuni / ažuriraj keš svežim podacima (čuva odds iz CacheChanges)
  for (const ev of all) {
    if (!ev.id) continue;
    const existing = eventCache.get(ev.id);
    if (existing) {
      const savedBets = existing.bets;
      Object.assign(existing, ev);
      // Uvek čuvaj stare bets — CacheChanges isActive/isInOffer imaju prioritet nad tree-om
      if (savedBets != null) existing.bets = savedBets;
      existing._lastSeen = now;
    } else {
      ev._lastSeen = now;
      eventCache.set(ev.id, ev);
      // Novi GT meč iz tree-a — ucitaj bete jednom
      if (isTarget(ev) && !ev.bets && _fetchBets && !ev._fetchedBets) {
        ev._fetchedBets = true;
        _fetchBets(ev.id);
      }
    }
    // Popuni/ažuriraj liveState iz tree podataka za interpolaciju minuta/sekundi
    if (ev.minute != null || ev.score != null) {
      const minute   = ev.minute ?? null;
      const score    = ev.score ?? ev.currentScore ?? null;
      const prevLS   = liveState.get(ev.id);
      liveState.set(ev.id, {
        // changedResults score ima prioritet nad starim tree score-om
        score: prevLS?.score ?? score,
        homeScore: null, awayScore: null,
        minute,
        period: prevLS?.period ?? null,
        isEnded: prevLS?.isEnded ?? false,
        isHT: prevLS?.isHT ?? false,
        raw: prevLS?.raw ?? {},
        receivedAt: minute != null ? now : null,
      });
    }
  }

  rebuildSlots();
}

// Dodaje/ažurira mečeve bez brisanja ostalih (za parcijalne tree odgovore)
function mergeEvents(raw) {
  if (!raw || raw.length === 0) return;
  const isTree = raw[0] && Array.isArray(raw[0].regions);
  const all = isTree ? flattenTree(raw) : raw;
  if (all.length === 0) return;
  if (isTree) {
    for (const ev of all) {
      if (ev.competitionId != null && ev.competitionName) {
        competitionMap.set(ev.competitionId, ev.competitionName);
      }
    }
  }
  const now = Date.now();
  const freshIds = new Set(all.map(e => e.id).filter(Boolean));
  // Ako su svi mečevi u tree-u GT mečevi, briši stare GT mečeve koji više nisu tu
  const allGT = all.length > 0 && all.every(e => isTarget(e));
  if (allGT) {
    for (const [id, ev] of eventCache.entries()) {
      if (isTarget(ev) && !freshIds.has(id)) {
        console.log(`  Brišem stari GT meč [${id}] "${ev.name}"`);
        eventCache.delete(id);
      }
    }
  }
  for (const ev of all) {
    if (!ev.id) continue;
    const existing = eventCache.get(ev.id);
    if (existing) {
      const savedBets = existing.bets;
      Object.assign(existing, ev);
      if (savedBets != null && ev.bets == null) existing.bets = savedBets;
      existing._lastSeen = now;
    } else {
      ev._lastSeen = now;
      eventCache.set(ev.id, ev);
    }
    // Ažuriraj liveState za meč iz tree podataka
    if (ev.minute != null || ev.score != null) {
      const prevLS2 = liveState.get(ev.id);
      liveState.set(ev.id, {
        score: prevLS2?.score ?? ev.score ?? null,
        homeScore: prevLS2?.homeScore ?? null,
        awayScore: prevLS2?.awayScore ?? null,
        minute: ev.minute ?? prevLS2?.minute ?? null,
        period: prevLS2?.period ?? null,
        isEnded: prevLS2?.isEnded ?? false,
        isHT: prevLS2?.isHT ?? false,
        raw: prevLS2?.raw ?? {},
        receivedAt: (ev.minute != null && !(prevLS2?.isEnded)) ? now : (prevLS2?.receivedAt ?? null),
      });
    }
  }
  rebuildSlots();
}

// ── puppeteer ────────────────────────────────────────────────────────────────

async function startBrowser() {
  if (!CHROME_PATHS.length) throw new Error("Chrome nije pronađen");

  console.log("Otvaram Chrome...");
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATHS[0],
    headless: false,
    args: ["--no-first-run", "--no-default-browser-check", "--disable-infobars",
           "--window-size=1000,700", "--start-minimized",
           "--hide-crash-restore-bubble", "--disable-restore-session-state"],
    defaultViewport: null,
  });

  const [page] = await browser.pages();
  _mainPage = page;


  // CDP – presretanje mrežnih odgovora
  const cdp = await page.createCDPSession();
  _cdp = cdp;
  await cdp.send("Network.enable");

  // Minimiziraj Chrome prozor
  cdp.send("Browser.getWindowForTarget").then(({ windowId }) =>
    cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "minimized" } })
  ).catch(() => {});
  const frameTree = await cdp.send("Page.getFrameTree").catch(() => null);
  _mainFrameId = frameTree?.frameTree?.frame?.id ?? null;
  console.log(`  CDP frameId: ${_mainFrameId}`);

  const LIVE_ENDPOINTS = ["getwebevents", "getliveresults", "livetree", "getlivevents", "getliveeventbyid", "liveeventbyid", "betsandgroups", "getwebbets"];
  const STATE_ENDPOINTS = ["getlivestate", "livestate", "liveeventstate"];
  const ODDS_ENDPOINTS = ["cachechanges"];

  // Mapa requestId → url za relevantne endpointe
  const tracked = new Map();

  // WebSocket detekcija
  cdp.on("Network.webSocketCreated", (evt) => {
    console.log(`  [WS-CREATED] url=${evt.url}`);
  });
  cdp.on("Network.webSocketFrameReceived", (evt) => {
    const payload = evt.response?.payloadData ?? "";
    if (payload.length > 0) console.log(`  [WS-FRAME] len=${payload.length} sample=${payload.slice(0,100)}`);
  });

  // Loguj SVE srboffer zahteve jednom (da nađemo sve endpointe)
  const _seenReqUrls = new Set();
  cdp.on("Network.requestWillBeSent", (evt) => {
    const url = evt.request?.url ?? "";
    if (!url.includes("srboffer.admiralbet.rs")) return;
    // Uvek loguj getWebBets sa body + headerima
    if (url.toLowerCase().includes("getwebbets")) {
      const body = evt.request.postData ?? "";
      const hdrs = JSON.stringify(evt.request.headers ?? {}).slice(0, 300);
      console.log(`  [GWB-REQ] body=${body.slice(0,200)} | headers=${hdrs}`);
    }
    const ep = url.replace(/\?.*/, "").split("/").slice(-3).join("/");
    if (!_seenReqUrls.has(ep)) {
      _seenReqUrls.add(ep);
      const body = evt.request.postData ?? "";
      console.log(`  [ALL-REQ] ${evt.request.method} ${url.replace(/\?.*/, "")}${body ? ` body=${body.slice(0,100)}` : ""}`);
    }
  });

  cdp.on("Network.responseReceived", (evt) => {
    const url = evt.response.url ?? "";
    if (!url.includes("srboffer.admiralbet.rs")) return;
    if (evt.response.status !== 200) return;
    touchData(); // svaki odgovor sa admiralbet.rs resetuje watchdog sat
    const urlLow = url.toLowerCase();
    const isLive  = LIVE_ENDPOINTS.some(e => urlLow.includes(e));
    const isState = STATE_ENDPOINTS.some(e => urlLow.includes(e));
    const isOdds  = ODDS_ENDPOINTS.some(e => urlLow.includes(e));
    if (!isLive && !isState && !isOdds) {
      // Loguj puni URL jednom da vidimo sve endpointe koje Admiral zove
      if (!_loggedUrls) _loggedUrls = new Set();
      const ep = url.split("/").slice(-2).join("/").split("?")[0];
      if (!_loggedUrls.has(ep)) {
        _loggedUrls.add(ep);
        console.log("  [new-url]", url.replace(/\?.*/, ""));
      }
      // Loguj svaki unknown endpoint koji sadrži "bets", "event", "live"
      const epLow = ep.toLowerCase();
      if (epLow.includes("bet") || epLow.includes("event") || epLow.includes("live")) {
        const body = evt.request?.postData ?? "";
        console.log(`  [watch-url] ${evt.request?.method} ${url.replace(/\?.*/, "")} body=${body.slice(0,100)}`);
      }
      tracked.set(evt.requestId, { url, type: "unknown" });
      return;
    }
    const ep = url.split("/").pop().split("?")[0];
    if (isOdds) console.log("  CacheChanges →", evt.response.status);
    else {
      if (urlLow.includes("getwebbets")) console.log("  [getWebBets intercept] →", evt.response.status, url.slice(-50));
      else if (urlLow.includes("betsandgroups")) console.log("  BETSANDGROUPS URL:", url);
      else console.log("  API:", ep.slice(0, 35), "→", evt.response.status);
    }
    tracked.set(evt.requestId, { url, type: isLive ? "live" : isOdds ? "odds" : "state" });
  });

  cdp.on("Network.loadingFinished", async (evt) => {
    if (!tracked.has(evt.requestId)) return;
    const { url, type } = tracked.get(evt.requestId);
    tracked.delete(evt.requestId);
    try {
      const body = await cdp.send("Network.getResponseBody", { requestId: evt.requestId });
      const raw = body?.body;
      // Za getWebBets — loguj svaki odgovor
      if (url.toLowerCase().includes("getwebbets")) {
        console.log(`  [getWebBets raw] len=${raw?.length} preview=${(raw??'').slice(0,250)}`);
      }
      if (!raw || raw.length < 10) return;
      if (!raw.startsWith("[") && !raw.startsWith("{")) return;
      const data = JSON.parse(raw);

      if (type === "unknown") {
        // offer/getWebBets: [{eventId, bets:[...]}] — bete za GT mečeve
        if (Array.isArray(data) && data.length > 0 && data[0]?.bets != null) {
          console.log(`  getWebBets: ${data.length} eventova, ids=${data.slice(0,3).map(x=>x.eventId).join(",")}`);
          let updated = 0;
          for (const item of data) {
            const cached = eventCache.get(item.eventId);
            if (cached && isTarget(cached)) {
              cached.bets = Array.isArray(item.bets) ? item.bets : [];
              cached._betsLoaded = true;
              console.log(`  getWebBets GT ${item.eventId}: ${cached.bets.length} bets`);
              updated++;
            }
          }
          if (updated > 0) rebuildSlots();
          return;
        }
      }

      // getWebBets intercept (live tip) — poseban parser
      if (type === "live" && url.toLowerCase().includes("getwebbets")) {
        console.log(`  [getWebBets live] format: ${JSON.stringify(data).slice(0,300)}`);
        let items = Array.isArray(data) ? data : (Array.isArray(data?.data) ? data.data : []);
        for (const item of items) {
          const eid = item.eventId ?? item.id ?? null;
          if (!eid) continue;
          const cached = eventCache.get(eid);
          if (cached && isTarget(cached) && Array.isArray(item.bets) && item.bets.length > 0) {
            cached.bets = item.bets;
            console.log(`  getWebBets GT ${eid}: ${item.bets.length} bets`);
            rebuildSlots();
          }
        }
        return;
      }

      // Parcijalni tree (npr. 47176/4) — samo dodaj, ne briši ostale
      if (type === "unknown") {
        if (Array.isArray(data) && data[0]?.regions) {
          console.log(`  [tree] ${url.split("/").slice(-2).join("/").split("?")[0]} → ${data.length} sportova`);
          mergeEvents(data);
        } else if (data.regions) {
          console.log(`  [tree obj] ${url.split("/").slice(-2).join("/").split("?")[0]}`);
          mergeEvents([data]);
        }
        return;
      }

      // CacheChanges – real-time ažuriranje kvota (pre liveState provere)
      if (type === "odds") {
        if (!_ccKeysLogged) {
          _ccKeysLogged = true;
          console.log("  CC keys:", Object.keys(data).join(","));
          const cr = data.changedResults ?? data.changedEventResults ?? [];
          if (cr.length > 0) console.log("  changedResults[0]:", JSON.stringify(cr[0]).slice(0,200));
          else console.log("  changedResults: prazan");
        }
        const bets = Array.isArray(data.changedBets)       ? data.changedBets       :
                     Array.isArray(data.bets)              ? data.bets              :
                     Array.isArray(data)                   ? data                   : [];
        const outcomes = Array.isArray(data.changedBetOutcomes) ? data.changedBetOutcomes : [];
        // LOG: svi bet tipovi za GT mečeve
        const gtOutcomes = outcomes.filter(ou => isTarget(eventCache.get(ou.iD?.[4])));
        if (gtOutcomes.length > 0) {
          const byEv = {};
          for (const ou of gtOutcomes) {
            const eid = ou.iD?.[4];
            if (!byEv[eid]) byEv[eid] = new Set();
            const tipNaziv = Array.isArray(ou.t) ? `${ou.t[0]}${ou.t[2]?' '+ou.t[2]:''}` : "?";
            byEv[eid].add(`${tipNaziv}(b=${JSON.stringify(ou.b)})`);
          }
          for (const [eid, tipovi] of Object.entries(byEv)) {
            console.log(`  [CC-GT] ev=${eid}: ${[...tipovi].join(" | ")}`);
          }
        }
        if (bets.length > 0 || outcomes.length > 0) {
          if (bets.length > 0) applyOddsUpdate(bets);
          if (bets.length > 0) applyBetSuspension(bets);
          if (outcomes.length > 0) applyOutcomeUpdate(outcomes);
        }
        // Ažuriraj score iz changedResults / changedEventResults
        const results = Array.isArray(data.changedResults) ? data.changedResults
          : Array.isArray(data.changedEventResults)        ? data.changedEventResults : [];
        if (results.length > 0) applyResultsUpdate(results);
        // Novi mečevi iz changedEvents — direktno dodaj, bez brisanja ostalih
        const newEvents = Array.isArray(data.changedEvents) ? data.changedEvents : [];
        if (newEvents.length > 0) {
          console.log(`  changedEvents[0]:`, JSON.stringify(newEvents[0]).slice(0, 200));
          let added = 0;
          for (const ev of newEvents) {
            const evId = ev.id ?? ev.iD?.[0] ?? null;
            if (!evId) continue;
            // Ažuriraj event-level suspension za postojeće mečeve: b[2] = playable
            const existing = eventCache.get(evId);
            if (existing && Array.isArray(ev.b)) {
              const evPlayable = ev.b[2] ?? 1;
              existing.suspended = !evPlayable;
            }
            if (eventCache.has(evId)) continue;
            if (!ev.id) ev.id = evId;
            // Parsiraj minifikovan format: t[2]=competitionName, t[3]=name, iD[2]=competitionId
            if (!ev.competitionName) ev.competitionName = ev.t?.[2] ?? null;
            if (!ev.name) ev.name = ev.t?.[3] ?? null;
            if (!ev.competitionId) ev.competitionId = ev.iD?.[2] ?? null;
            // Ako nema competitionName, pokušaj iz competitionMap
            if (!ev.competitionName && ev.competitionId != null) {
              ev.competitionName = competitionMap.get(ev.competitionId) ?? null;
            }
            console.log(`  changedEvents novi: [${ev.id}] "${ev.name}" comp="${ev.competitionName}"`);
            if (!isTarget(ev)) continue;
            eventCache.set(ev.id, ev);
            added++;
            console.log(`    → DODAT GT meč [${ev.id}]`);
            ev._fetchedBets = true;
            if (_fetchBets) _fetchBets(ev.id);
          }
          if (added > 0) rebuildSlots();
        }
        return;
      }

      // Provjeri da li su ključevi event ID-evi (live state format)
      const keys = Object.keys(data);
      const firstKey = parseInt(keys[0]);
      if (!Array.isArray(data) && !isNaN(firstKey) && firstKey > 100000) {
        parseLiveStateResponse(data);
        console.log(`    → liveState za ${keys.length} mečeva`);
        rebuildSlots();
        return;
      }

      let all = [];
      if (Array.isArray(data) && data.length > 0)                      all = data;
      else if (Array.isArray(data.events)  && data.events.length > 0)  all = data.events;
      else if (Array.isArray(data.data)    && data.data.length > 0)    all = data.data;
      else if (Array.isArray(data.results) && data.results.length > 0) all = data.results;
      else if (data.regions) all = [data];

      if (all.length > 0) {
        const ep = url.split("/").pop().split("?")[0];
        const withBets = all.filter(ev => Array.isArray(ev.bets) && ev.bets.length > 0);
        if (withBets.length > 0) {
          console.log(`  [LIVE-BETS] ${url.replace(/\?.*/, "").split("/").slice(-3).join("/")} → ${withBets.length}/${all.length} eventa ima bets`);
          for (const ev of withBets) {
            if (isTarget(ev)) console.log(`    GT ev=${ev.id} "${ev.name}": ${ev.bets.length} bets`);
          }
        } else {
          console.log(`    → ${all.length} stavki | ${Object.keys(all[0]).slice(0,5).join(",")}`);
        }
        processEvents(all);
        state.status = `OK – ${new Date().toLocaleTimeString("sr")}`;
      }
      // Detektuj odgovore sa bets array — trazimo izvor bete za GT
      const hasBets = Array.isArray(data.bets) && data.bets.length > 0;
      const hasBetsArr = Array.isArray(data) && data.length > 0 && data[0]?.betOutcomes;
      if (hasBets || hasBetsArr) {
        const ep3 = url.split("/").slice(-2).join("/").split("?")[0];
        const betsArr = hasBets ? data.bets : data;
        const eventIdInData = data.eventId ?? data.id ?? betsArr[0]?.eventId ?? null;
        console.log(`  [BETS] ${ep3} → ${betsArr.length} bets, eventId=${eventIdInData}`);
        // Ako postoji eventId i meč je GT, sačuvaj bete
        if (eventIdInData && isTarget(eventCache.get(eventIdInData))) {
          const cached = eventCache.get(eventIdInData);
          if (cached) { cached.bets = betsArr; console.log(`    → sačuvano za GT ${eventIdInData}`); rebuildSlots(); }
        }
      }
    } catch (e) { console.log("    → parse greška:", e.message.slice(0,60)); }
  });

  state.status = "Učitavam Admiral...";
  try {
    await page.goto("https://admiralbet.rs/sport-live", {
      waitUntil: "domcontentloaded", timeout: 20000,
    });
  } catch { /* ignorisi */ }

  // Auto-klik "Prihvati sve" – pokušavaj svakih 500ms do 15s
  console.log("Tražim 'Prihvati sve'...");
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 500));
    try {
      const clicked = await page.evaluate(() => {
        const btns = [...document.querySelectorAll("button, a, div[role='button']")];
        const btn = btns.find(b =>
          /prihvati\s*sve|prihvati\s*i|accept\s*all|prihvati|accept|agree|dozvoli/i
            .test((b.textContent || "").trim())
        );
        if (btn) { btn.click(); return btn.textContent.trim(); }
        return null;
      });
      if (clicked) {
        console.log("Kliknuto:", clicked);
        await new Promise(r => setTimeout(r, 1000));
        break;
      }
    } catch {}
  }

  state.status = "Čekam live podatke...";
  console.log("Chrome aktivan, čeka podatke...");

  // CDP Fetch Interception: kad Admiral šalje getWebBets za bilo koji meč,
  // DODAJEMO naše GT event ID-eve u taj zahtev da server vrati bets za sve GT mečeve.
  // Ovo NE otvara novi tab i NE menja navigaciju.
  const GWB_URL = "https://srboffer.admiralbet.rs/api/offer/getWebBets";
  let _fetchInterceptEnabled = false;
  const enableFetchIntercept = async () => {
    if (_fetchInterceptEnabled) return;
    _fetchInterceptEnabled = true;
    try {
      await _cdp.send("Fetch.enable", {
        patterns: [{ urlPattern: "*getWebBets*", requestStage: "Request" }],
      });
      console.log("  Fetch intercept aktivan za getWebBets");
    } catch(e) {
      console.log("  Fetch intercept err:", e.message);
    }
  };

  _cdp.on("Fetch.requestPaused", async (evt) => {
    const url = evt.request?.url ?? "";
    if (!url.toLowerCase().includes("getwebbets")) {
      await _cdp.send("Fetch.continueRequest", { requestId: evt.requestId }).catch(() => {});
      return;
    }
    // Parsiraj body, dodaj GT event IDs
    try {
      const origBody = evt.request.postData ?? "{}";
      const bodyObj = JSON.parse(origBody);
      const origIds = Array.isArray(bodyObj.eventIds) ? bodyObj.eventIds : [];
      const gtIds = [...eventCache.values()]
        .filter(e => isTarget(e) && !e._betsLoaded)
        .map(e => e.id)
        .filter(id => !origIds.includes(id));
      if (gtIds.length > 0) {
        bodyObj.eventIds = [...origIds, ...gtIds];
        const newBody = JSON.stringify(bodyObj);
        console.log(`  GWB intercept: dodajem ${gtIds.length} GT IDs: ${gtIds.join(",")}`);
        await _cdp.send("Fetch.continueRequest", {
          requestId: evt.requestId,
          postData: Buffer.from(newBody).toString("base64"),
        }).catch(() => {
          _cdp.send("Fetch.continueRequest", { requestId: evt.requestId }).catch(() => {});
        });
      } else {
        await _cdp.send("Fetch.continueRequest", { requestId: evt.requestId }).catch(() => {});
      }
    } catch(e) {
      await _cdp.send("Fetch.continueRequest", { requestId: evt.requestId }).catch(() => {});
    }
  });

  // _fetchBets: Node.js server-side fetch sa kolačićima iz Chrome sesije
  // (bez CORS ograničenja, bez novog taba, autentificirani kao Admiral korisnik)
  let _gwbHeaders = null; // Čuvamo headere iz prvog uspešnog Admiral getWebBets zahteva
  let _gwbBodyTemplate = null; // Čuvamo template body za kreiranje novih zahteva

  // Uhvati headere iz Admiral-ovog getWebBets zahteva
  cdp.on("Network.requestWillBeSent", (evt2) => {
    const u2 = evt2.request?.url ?? "";
    if (!u2.toLowerCase().includes("getwebbets")) return;
    if (_gwbHeaders) return; // Već imamo
    const h = evt2.request.headers ?? {};
    _gwbHeaders = {
      "Content-Type": h["Content-Type"] ?? h["content-type"] ?? "application/json",
      "Origin": h["Origin"] ?? h["origin"] ?? "https://admiralbet.rs",
      "Referer": h["Referer"] ?? h["referer"] ?? "https://admiralbet.rs/sport-live",
      "User-Agent": h["User-Agent"] ?? h["user-agent"] ?? "",
      "Accept": h["Accept"] ?? h["accept"] ?? "application/json",
      "Accept-Language": h["Accept-Language"] ?? h["accept-language"] ?? "sr,en;q=0.9",
    };
    if (evt2.request.postData) {
      try { _gwbBodyTemplate = JSON.parse(evt2.request.postData); } catch {}
    }
    console.log(`  [GWB headers uhvaćeni] origin=${_gwbHeaders.Origin}`);
  });

  _fetchBets = async (eventId) => {
    const ev = eventCache.get(eventId);
    if (!ev) return;
    ev.bets = ev.bets ?? [];
    await enableFetchIntercept(); // Aktiviraj intercept kao backup
    try {
      // Uzmi kolačiće iz Chrome sesije
      const cookies = await _mainPage.cookies("https://srboffer.admiralbet.rs");
      const mainCookies = await _mainPage.cookies("https://admiralbet.rs");
      const allCookies = [...cookies, ...mainCookies];
      const cookieStr = allCookies.map(c => `${c.name}=${c.value}`).join("; ");
      // Napravi body — koristimo isti format koji Admiral šalje
      const bodyObj = {
        sportId: ev.sportId ?? (_gwbBodyTemplate?.sportId ?? 1),
        regionId: ev.regionId ?? (_gwbBodyTemplate?.regionId ?? null),
        competitionId: ev.competitionId ?? (_gwbBodyTemplate?.competitionId ?? null),
        betTypeGroupId: null,
        eventIds: [eventId],
        pageId: 4,
      };
      const body = JSON.stringify(bodyObj);
      // Uhvaćeni headeri od Admiral-a + obavezni OfficeId i Language
      const realHeaders = _gwbHeaders ?? {};
      const headers = {
        "Content-Type": "application/json",
        "Accept": "application/utf8+json, application/json;q=0.9, text/plain;q=0.8, */*;q=0.5",
        "Accept-Language": "sr,en;q=0.9",
        "Language": realHeaders["Language"] ?? "sr-Latn",
        "OfficeId": realHeaders["OfficeId"] ?? "138",
        "Origin": "https://admiralbet.rs",
        "Referer": "https://admiralbet.rs/sport-live",
        "User-Agent": realHeaders["User-Agent"] ?? "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
        "sec-ch-ua": realHeaders["sec-ch-ua"] ?? `"Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"`,
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
        "Sec-Fetch-Site": "same-site",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Dest": "empty",
        "Cookie": cookieStr,
      };
      console.log(`  nodeFetch GWB ev=${eventId} cookies=${allCookies.length}`);
      const resp = await fetch("https://srboffer.admiralbet.rs/api/offer/getWebBets", {
        method: "POST",
        headers,
        body,
      });
      console.log(`  nodeFetch GWB status=${resp.status} ev=${eventId}`);
      if (!resp.ok) return;
      const rawText = await resp.text();
      const bNames = (() => { try { return JSON.parse(rawText)?.[0]?.bets?.map(b=>b.betTypeName).join("|") ?? ""; } catch { return ""; } })();
      console.log(`  nodeFetch GWB raw[${eventId}]: betTypes=${bNames || rawText.slice(0,200)}`);
      let data; try { data = JSON.parse(rawText); } catch { return; }
      if (!Array.isArray(data) || data.length === 0) {
        console.log(`  nodeFetch GWB: prazan odgovor za ev=${eventId}`);
        return;
      }
      const item = data.find(x => x.eventId === eventId) ?? data[0];
      if (item?.bets?.length > 0) {
        ev.bets = item.bets;
        ev._betsLoaded = true;
        console.log(`  nodeFetch GWB GT ${eventId}: ${ev.bets.length} bets → ${ev.bets.map(b=>b.betTypeName??b.betTypeId??'?').join(" | ")}`);
        rebuildSlots();
      }
    } catch(e) {
      console.log(`  nodeFetch GWB err ev=${eventId}: ${e.message}`);
    }
  };

  _onScoreChange = (eventId) => {};

  // Fetchuj bets za sve GT mečeve — pokreće se posle svakog tree odgovora i periodično
  const fetchAllGT = async (reason) => {
    const gtEvs = [...eventCache.values()].filter(ev => isTarget(ev));
    const todo = gtEvs; // Uvek refetchuj sve GT mečeve
    console.log(`  fetchAllGT(${reason}): ${gtEvs.length} GT mečeva, ${todo.length} treba fetch`);
    for (const ev of todo) {
      ev._fetchedBets = true;
      await _fetchBets(ev.id);
      await new Promise(r => setTimeout(r, 600));
    }
  };

  // Pokušaj posle 5s i 15s (cache se popuni za ~2-3s)
  setTimeout(() => fetchAllGT("5s"), 5000);
  setTimeout(() => fetchAllGT("15s"), 15000);
  // Svakih 10s refetchuj SVE GT mečeve — uklanja stare bet tipove koje Admiral skloni
  setInterval(() => fetchAllGT("10s"), 10000);

  return browser;
}

// ── HTML ─────────────────────────────────────────────────────────────────────

const HTML = `<!DOCTYPE html>
<html lang="sr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Admiral – GT+eFoot Live</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0a0d14;color:#e0e0e0;font-family:'Segoe UI',sans-serif;padding:16px}
h1{font-size:1.25rem;color:#00c8ff;margin-bottom:4px}
#bar{font-size:.78rem;color:#888;margin-bottom:14px;display:flex;gap:14px;flex-wrap:wrap;align-items:center}
#bar .val{color:#00e676;font-weight:600}
#bar .st{color:#aaa}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:12px}
.card{background:#141720;border:1px solid #252840;border-radius:10px;padding:14px}
.cname{font-size:1rem;font-weight:700;color:#fff;margin-bottom:3px}
.cmeta{font-size:.72rem;color:#556;margin-bottom:8px}
.scoreline{display:flex;align-items:center;justify-content:center;gap:12px;padding:6px 0 10px}
.score{font-size:1.6rem;font-weight:700;color:#00e676;letter-spacing:3px}
.min{font-size:.78rem;color:#ff9800;background:#1a1200;border-radius:4px;padding:2px 6px}
table{width:100%;border-collapse:collapse;font-size:.76rem}
th{color:#445;font-weight:500;text-align:left;padding:2px 6px 5px;border-bottom:1px solid #1e2130}
td{padding:3px 6px;border-bottom:1px solid #171a27}
td.ov{color:#ffd740;font-weight:700;text-align:right;width:54px}
.empty{text-align:center;color:#333;padding:40px;font-size:.9rem;grid-column:1/-1}
#dbg{margin-top:12px;font-size:.68rem;color:#333;word-break:break-all;line-height:1.6}
@keyframes flash{0%{background:#ff0}100%{background:transparent}}
.changed{animation:flash .6s ease-out}
</style>
</head>
<body>
<h1>⚽ Admiral – GT Sports + eFoot – LIVE</h1>
<div id="bar">
  <span><span class="val" id="ts">--</span></span>
  <span>Ukupno live: <span class="val" id="tl">0</span></span>
  <span>GT+eFoot: <span class="val" id="tg">0</span></span>
  <span>Prikazano: <span class="val" id="ts2">0</span></span>
  <span class="st" id="sts">Pokretanje...</span>
</div>
<div class="grid" id="grid"></div>
<div id="dbg"></div>
<script>
const prevOdds={};
async function refresh(){
  try{
    const d=await(await fetch('/api/data')).json();
    document.getElementById('ts').textContent=d.ts;
    document.getElementById('tl').textContent=d.totalLive;
    document.getElementById('tg').textContent=d.totalGT;
    document.getElementById('ts2').textContent=d.slots.length;
    document.getElementById('sts').textContent=(d.status||'');
    const grid=document.getElementById('grid');
    if(!d.slots.length){
      grid.innerHTML='<div class="empty">Nema GT+eFoot mečeva trenutno</div>';
    }else{
      grid.innerHTML=d.slots.map(s=>{
        const sc=s.score?(typeof s.score==='object'?JSON.stringify(s.score):s.score):null;
        const minTxt=s.minute!=null?String(s.minute):'';
        const perTxt=s.period?(' · '+s.period):'';
        const min=(minTxt||perTxt)?'<span class="min">'+minTxt+perTxt+'</span>':'';
        const scoreline=sc?'<div class="scoreline"><span class="score">'+sc+'</span>'+min+'</div>'
          :(min?'<div class="scoreline">'+min+'</div>':'');
        const odds=s.odds&&s.odds.length
          ?'<table><tr><th>Tržište</th><th>Ishod</th><th>Kvota</th></tr>'+
            s.odds.map((o,i)=>{
              const key=s.id+'-'+i;
              const changed=prevOdds[key]!=null&&prevOdds[key]!==o.odd;
              prevOdds[key]=o.odd;
              return '<tr'+(changed?' class="changed"':'')+'><td>'+o.market+'</td><td>'+o.outcome+'</td><td class="ov">'+o.odd.toFixed(2)+'</td></tr>';
            }).join('')+'</table>'
          :(s.betsCount?'<div style="color:#445;font-size:.72rem">Tržišta se učitavaju...</div>':'<div style="color:#333;font-size:.72rem">Nema kvota</div>');
        const badge=s.ended
          ?'<span style="background:#f44;color:#fff;font-size:.68rem;padding:1px 6px;border-radius:3px;margin-left:6px">KRAJ</span>'
          :s.halftime
          ?'<span style="background:#ff9800;color:#000;font-size:.68rem;padding:1px 6px;border-radius:3px;margin-left:6px">⏸ POLUVREME</span>'
          :'';
        return '<div class="card"><div class="cname">'+s.name+badge+'</div>'+
               '<div class="cmeta">'+s.sport+' · '+s.league+'</div>'+
               scoreline+odds+'</div>';
      }).join('');
    }
    if(d.totalLive>0&&d.totalGT===0&&d.allNames&&d.allNames.length){
      document.getElementById('dbg').textContent='DEBUG nazivi: '+d.allNames.join(' | ');
    }else{
      document.getElementById('dbg').textContent='';
    }
  }catch(e){document.getElementById('sts').textContent='Greška: '+e;}
}
refresh();setInterval(refresh,500);
</script>
</body>
</html>`;

// ── HTTP server ───────────────────────────────────────────────────────────────

const HEADERS_JSON = { "Content-Type": "application/json; charset=utf-8", "Connection": "keep-alive" };
const HEADERS_HTML = { "Content-Type": "text/html; charset=utf-8", "Connection": "keep-alive" };

const server = http.createServer((req, res) => {
  if (req.url.startsWith("/api/data")) {
    res.writeHead(200, HEADERS_JSON);
    res.end(JSON.stringify(state));
  } else if (req.url === "/api/raw") {
    res.writeHead(200, HEADERS_JSON);
    res.end(JSON.stringify(_rawSample, null, 2));
  } else if (req.url.startsWith("/api/comps")) {
    res.writeHead(200, HEADERS_JSON);
    const comps = [...new Set([...eventCache.values()].map(e => `${e.sportName ?? "?"}|${e.competitionName ?? "?"}`))].sort();
    res.end(JSON.stringify(comps));
  } else if (req.url.startsWith("/api/livestate")) {
    res.writeHead(200, HEADERS_JSON);
    const sample = [...liveState.entries()].slice(0, 3).map(([id, v]) => ({ id, ...v }));
    res.end(JSON.stringify(sample, null, 2));
  } else {
    res.writeHead(200, HEADERS_HTML);
    res.end(HTML);
  }
});

server.listen(PORT, "127.0.0.1", async () => {
  console.log(`Web UI: http://localhost:${PORT}`);

  const chromePath = CHROME_PATHS[0];
  if (chromePath) exec(`"${chromePath}" --new-window http://localhost:${PORT}`);
  else exec(`start http://localhost:${PORT}`);

  try {
    await startBrowser();
  } catch (e) {
    state.error = e.message;
    state.status = "Greška: " + e.message;
    console.error("Puppeteer greška:", e.message);
  }

  // ── Watchdog: ako nema novih podataka 3 minute → reload stranice ─────────
  const WATCHDOG_MS   = 3 * 60 * 1000; // 3 minute bez podataka
  const WATCHDOG_TICK = 30 * 1000;     // provjera svakih 30s

  setInterval(async () => {
    const stale = Date.now() - _lastDataAt;
    if (stale < WATCHDOG_MS) return;
    console.log(`  [WATCHDOG] Nema podataka ${Math.round(stale/1000)}s — reload stranice...`);
    try {
      if (_mainPage && !_mainPage.isClosed()) {
        _lastDataAt = Date.now(); // reset da ne bi trigerirao opet odmah
        await _mainPage.reload({ waitUntil: "domcontentloaded", timeout: 20000 });
        console.log("  [WATCHDOG] Reload završen — čekam podatke...");
      }
    } catch (e) {
      console.warn("  [WATCHDOG] Reload greška:", e.message);
    }
  }, WATCHDOG_TICK);
});
