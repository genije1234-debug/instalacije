/**
 * Bwin Live Football – Scraper
 * Port: 3200
 *
 * Arhitektura:
 *  1. Puppeteer Chrome → bwin.com/en/sports/football-4/live
 *  2. CDP HTTP intercept: /cds-api/bettingoffer/fixtures (lista svih live mečeva)
 *                         /cds-api/bettingoffer/fixture-view (detalji + kvote)
 *  3. CDP WebSocket intercept: real-time score + odds promjene
 *  4. HTTP :3200 → /data JSON, / web UI (20ms smart diff)
 */

import http   from "http";
import fs     from "fs";
import puppeteer from "puppeteer-core";
import path   from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT      = 3200;
const BWIN_URL  = "https://www.bwin.com/en/sports/live/football-4";
const EXPIRE_MS = 20 * 60 * 1000; // izbaci meč koji nije vidjen 20 min

const CHROME_PATHS = [
  process.env.LOCALAPPDATA + "\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
].filter(p => p && fs.existsSync(p));

const PROFILE_DIR = path.join(__dirname, "chrome-bwin-live");

// ── State ─────────────────────────────────────────────────────────────────────

const matches    = new Map(); // id → matchObj
let   lastUpdate = null;
let   stateHash  = "";        // za smart diff

function mkMatch(id) {
  return {
    id, name: "?", competition: null, region: null,
    score: "--", period: null, minute: null, second: null,
    odds: null, isInPlay: true,
    _seen: Date.now(),
    _lastInStreams: 0, // kad je zadnji put viđen u /live/streams listi
    _goalTs: 0,        // tačan trenutak (ms) kad WS detektuje gol (porast total score-a)
  };
}

function scoreTotal(s) {
  const mm = String(s ?? "").match(/(\d+)\D+(\d+)/);
  return mm ? (+mm[1] + +mm[2]) : null;
}

// Periodicno čisti mečeve koji nisu viđeni dugo
setInterval(() => {
  const cutoff = Date.now() - EXPIRE_MS;
  for (const [id, m] of matches) {
    if (m._seen < cutoff) { matches.delete(id); console.log(`[EXP] uklonjen ${m.name}`); }
  }
}, 60 * 1000);

// ── Helpers ───────────────────────────────────────────────────────────────────

function val(field) {
  if (!field) return null;
  if (typeof field === "string") return field;
  if (Array.isArray(field)) return field[0]?.value ?? field[0] ?? null;
  return field.value ?? field.text ?? null;
}

// ── Završeni periodi (meč gotov) ──────────────────────────────────────────────
const FINISHED_PERIODS = new Set([
  "finished", "ended", "fulltime", "full time", "ft",
  "afterextratime", "after extra time", "aet",
  "afterpenalties", "after penalties", "ap",
  "abandoned", "cancelled", "canceled", "awarded", "walkover", "postponed",
]);
function isFinishedPeriod(period) {
  if (!period) return false;
  return FINISHED_PERIODS.has(String(period).toLowerCase().trim());
}

// ── Scoreboard parser ─────────────────────────────────────────────────────────

function applyScoreboard(m, sb) {
  if (!sb) return;

  if (typeof sb.score === "string" && sb.score.includes(":")) m.score = sb.score;
  else {
    const home = sb.homeScore ?? sb.score?.homeScore ?? null;
    const away = sb.awayScore ?? sb.score?.awayScore ?? null;
    if (home != null && away != null) m.score = `${home}:${away}`;
  }

  const rawPeriod = sb.period ?? null;
  if (rawPeriod && String(rawPeriod) !== "Not Started") m.period = String(rawPeriod);

  // Timer direktno na scoreboard
  if (sb.timer) {
    const tm = String(sb.timer).match(/^(\d+):(\d+)/);
    if (tm) { m.minute = parseInt(tm[1]); m.second = parseInt(tm[2]); }
  }

  // Fallback: iz messages uzmi najnoviji event s timerom
  if (m.minute == null && sb.messages) {
    let maxOrder = -1, bestTimer = null;
    const msgs = Array.isArray(sb.messages) ? sb.messages : Object.values(sb.messages);
    for (const msg of msgs) {
      if (msg.timer && (msg.order ?? 0) > maxOrder) {
        maxOrder = msg.order ?? 0;
        bestTimer = msg.timer;
      }
    }
    if (bestTimer) {
      const tm = String(bestTimer).match(/^(\d+):(\d+)/);
      if (tm) { m.minute = parseInt(tm[1]); m.second = parseInt(tm[2]); }
    }
  }
}

// ── Tržišta (kvote) parser ────────────────────────────────────────────────────

function applyMarkets(m, optionMarkets) {
  if (!Array.isArray(optionMarkets) || !optionMarkets.length) return;

  // Traži samo pravi 1X2 market — bez fallbacka
  const mk = optionMarkets.find(mk => {
    const params = mk.parameters ?? [];
    const marketType = params.find(p => p.key === "MarketType")?.value?.toLowerCase() ?? "";
    const name = val(mk.name)?.toLowerCase() ?? "";
    return name.includes("match result") || name === "result" ||
           marketType === "matchresultsimple" || marketType === "matchresult" ||
           marketType === "1x2" || marketType === "3way";
  });
  if (!mk) return;

  const opts = mk.options ?? [];
  if (!opts.length) return;

  // Home i away iz naziva meča (format: "HomeTeam - AwayTeam")
  const parts = (m.name ?? "").split(" - ");
  const homeName = parts[0]?.trim().toLowerCase() ?? "";
  const awayName = parts[parts.length - 1]?.trim().toLowerCase() ?? "";

  const odds = {};

  for (const o of opts) {
    const nLow = (val(o.name) ?? "").toLowerCase();
    const susp = (o.status ?? "").toLowerCase() === "suspended";
    const price = o.price?.odds ?? o.price?.[0]?.odds ?? null;
    const sn = o.sourceName?.value ?? "";

    if (sn === "1") {
      odds["1"] = susp ? null : price;
    } else if (sn === "2") {
      odds["2"] = susp ? null : price;
    } else if (nLow === "x" || nLow === "draw" || nLow === "tie") {
      odds["X"] = susp ? null : price;
    }
  }

  if (odds["1"] !== undefined || odds["X"] !== undefined || odds["2"] !== undefined) m.odds = odds;
}

// ── Parsiranje jednog fixture objekta ─────────────────────────────────────────

function applyFixture(f, forceAdd = false) {
  if (!f) return;
  const id = String(f.id ?? "");
  if (!id) return;

  // Preskoči mečeve koji su završeni
  const stage = String(f.stage ?? "").toLowerCase();
  if (stage === "resulted" || stage === "finished") {
    matches.delete(id);
    return;
  }

  // Dodaj novi meč samo ako ga stranica eksplicitno pošalje (forceAdd) ili već postoji
  if (!matches.has(id)) {
    if (!forceAdd) return;
    matches.set(id, mkMatch(id));
  }

  const m = matches.get(id);
  m._seen       = Date.now();
  m.name        = val(f.name) ?? m.name;
  m.competition = val(f.competition?.name) ?? m.competition;
  m.region      = val(f.region?.name) ?? m.region;

  // Score dolazi samo iz WS ScoreboardSlim — HTTP ne piše score
}

// ── Parsiranje API odgovora ───────────────────────────────────────────────────

function isActuallyLive(f) {
  const sbPeriod = String(f.scoreboard?.period ?? "").trim();
  if (isFinishedPeriod(sbPeriod)) return false; // završen → nije živ
  if (sbPeriod && sbPeriod !== "Not Started" && sbPeriod !== "") return true;

  const stage = String(f.stage ?? "").toLowerCase();
  if (stage === "live" || stage === "inprogress" || stage === "in_progress" || stage === "running") return true;

  if (stage === "resulted" || stage === "finished") return false;

  // Loguj sve odbačene da nađemo problem
  const name = String(f.name?.value ?? f.name ?? "?");
  if (!_seenCds.has(`ial_${name}`)) {
    _seenCds.add(`ial_${name}`);
    console.log(`[NOT LIVE] name="${name}" stage="${f.stage}" period="${sbPeriod}"`);
  }

  return false;
}

function parseFixturesList(data) {
  const list = data?.fixtures ?? [];

  // Sve što Bwin vrati na live football stranici — prihvatamo, bez filtera
  for (const f of list) {
    const stage = String(f.stage ?? "").toLowerCase();
    if (stage === "resulted" || stage === "finished") continue; // samo završene preskočimo
    applyFixture(f, true);
  }

  console.log(`[HTTP] fixtures: ${matches.size} live mečeva (od ${list.length} ukupno)`);
}

function parseFixtureView(data) {
  if (data?.fixture) applyFixture(data.fixture, false);
  if (Array.isArray(data?.splitFixtures)) {
    for (const f of data.splitFixtures) applyFixture(f, false);
  }
}

// ── /live/streams parser ──────────────────────────────────────────────────────
// Struktura: { sportOffers: [{ sport:{}, fixtures:[...] }] }
// ili:       { sportOffers: [{ type:"Sport", id:5, fixtures:[...] }] }

const STREAM_GONE_MS = 15000; // skini meč koji 15s nije u live listi (= završen)

function parseStreams(data) {
  if (!data) return;

  // Struktura: { sportsOffer: [ { sport, fixtures, totalCount }, ... ] }
  const sportsOffer = data.sportsOffer ?? data.sportOffers ?? (Array.isArray(data) ? data : []);
  if (!sportsOffer.length) return;

  const freshIds = new Set();
  let liveFound = 0;
  let updated = 0;
  for (const so of sportsOffer) {
    const fixtures = so.fixtures ?? so.offers ?? null;
    if (!Array.isArray(fixtures)) continue;
    for (const f of fixtures) {
      if (isActuallyLive(f)) {
        liveFound++;
        const id = String(f.id ?? "");
        const forceAdd = !isEsoccer({ competition: val(f.competition?.name), name: val(f.name) });
        applyFixture(f, forceAdd);
        if (id && matches.has(id)) {
          matches.get(id)._lastInStreams = Date.now();
          freshIds.add(id);
        }
        updated++;
      }
    }
  }

  // Skini završene: meč kojeg nema u live listi 15s+ je gotov.
  // Zaštita: prune samo ako je snapshot uspješan (našli bar 1 live meč).
  if (liveFound > 0) {
    const now = Date.now();
    for (const [id, m] of matches) {
      if (freshIds.has(id)) continue;
      const last = m._lastInStreams ?? 0;
      if (last && now - last > STREAM_GONE_MS) {
        matches.delete(id);
        console.log(`[GOTOV] ${m.name} — nestao iz live liste, skinut`);
      }
    }
  }

  if (updated > 0)
    console.log(`[STREAM] ${updated} update-a, ukupno: ${matches.size} live`);
}

// ── WebSocket parser (real-time updates) ─────────────────────────────────────

let _wsLogCount = 0;
let _oddsLogCount = 0;
const ODDS_LOG_PATH = path.join(__dirname, "bwin-odds-log.txt");

let _wsMsgTypes = new Set(); // za discovery novih tipova poruka

function handleWsFrame(payload) {
  if (!payload || payload.length < 5) return;

  lastWsTs = Date.now(); // WS je živ

  // SignalR može poslati više poruka u jednom frame-u, odvojenih sa \x1e
  const parts = payload.split("\x1e").filter(s => s.trim().length > 0);

  for (const part of parts) {
    let data;
    try { data = JSON.parse(part.trim()); } catch {
      if (_wsLogCount < 3) {
        _wsLogCount++;
        console.log(`[WS ERR] nije JSON: ${part.slice(0,100)}`);
      }
      continue;
    }

    // SignalR format: { type:1, target:"Receive", arguments:[{messageType, payload, ...}] }
    if (data?.type === 1 && data?.target === "Receive" && Array.isArray(data?.arguments)) {
      for (const arg of data.arguments) {
        const msgType = arg?.messageType ?? "";

        if (!_wsMsgTypes.has(msgType)) {
          _wsMsgTypes.add(msgType);
          if (msgType && msgType !== "ConnectionAck") {
            const ts = new Date().toISOString().slice(11,23);
            const known = ["ScoreboardSlim","OptionMarketUpdate","OddsChange","Fixture","FixtureUpdate","FixtureSlim","MarketUpdate"];
            if (!known.includes(msgType)) {
              console.log(`[WS NEW] ${ts} msgType=${msgType} sample=${JSON.stringify(arg).slice(0,500)}`);
            } else {
              console.log(`[WS] ${ts} msgType=${msgType}`);
            }
          }
        }

        parseSignalRMessage(msgType, arg);
      }
      continue;
    }

    parseWsData(data);
  }
}

function parseSignalRMessage(msgType, arg) {
  const ts = new Date().toISOString().slice(11,23);
  const p = arg?.payload;
  if (!p) return;

  // ── ScoreboardSlim: push score update za 1 meč ─────────────────────────────
  if (msgType === "ScoreboardSlim") {
    const fixtureId = p.fixtureId ?? p.id ?? arg?.fixtureId ?? arg?.id;
    const sb = p.scoreboard ?? p;
    if (!fixtureId || !sb) return;

    const m = matches.get(String(fixtureId));
    if (!m) return;

    const oldScore = m.score;
    applyScoreboard(m, sb);
    m._seen = Date.now();

    // Meč završen → skini ga odmah
    if (isFinishedPeriod(m.period)) {
      matches.delete(String(fixtureId));
      console.log(`[GOTOV WS] ${ts} | ${m.name} | period=${m.period}`);
      return;
    }

    if (m.score !== "--" && m.score !== oldScore) {
      const oldT = scoreTotal(oldScore), newT = scoreTotal(m.score);
      if (oldT != null && newT != null && newT > oldT) m._goalTs = Date.now(); // pravi gol
      console.log(`[GOL! WS] ${ts} | ${m.name} | ${oldScore} → ${m.score}`);
    }
    prevScores.set(String(fixtureId), m.score);
    return;
  }

  // ── OptionMarketUpdate: push odds za 1 market ───────────────────────────────
  if (msgType === "OptionMarketUpdate" || msgType === "OddsChange" || msgType === "MarketUpdate") {
    let fixtureId = p.fixtureId ?? p.id ?? arg?.fixtureId ?? arg?.id;
    if (!fixtureId && arg?.topic) {
      const m2 = String(arg.topic).match(/fixture[\/:](\d+:\d+)/i);
      if (m2) fixtureId = m2[1];
    }

    if (!fixtureId) return;
    const m = matches.get(String(fixtureId));
    if (!m) return;

    const mk = p.optionMarket ?? null;

    // Log prvih 10 OptionMarketUpdate poruka u fajl
    if (_oddsLogCount < 10) {
      _oddsLogCount++;
      const entry = `\n--- #${_oddsLogCount} fixtureId=${fixtureId} match="${m.name}" ---\n${JSON.stringify(mk ?? p, null, 2)}\n`;
      fs.appendFileSync(ODDS_LOG_PATH, entry);
    }

    if (mk) applyMarkets(m, [mk]);
    else if (p.optionMarkets) applyMarkets(m, p.optionMarkets);
    return;
  }

  // ── OptionMarketDelete: market uklonjen — kvote na null ─────────────────────
  if (msgType === "OptionMarketDelete") {
    let fixtureId = p.fixtureId ?? p.id ?? arg?.fixtureId ?? arg?.id;
    if (!fixtureId && arg?.topic) {
      const m2 = String(arg.topic).match(/fixture[\/:](\d+:\d+)/i);
      if (m2) fixtureId = m2[1];
    }
    if (!fixtureId) return;
    const m = matches.get(String(fixtureId));
    if (m) m.odds = null;
    return;
  }

  // ── Fixture/FixtureUpdate: puni fixture push ─────────────────────────────────
  if (msgType === "Fixture" || msgType === "FixtureUpdate" || msgType === "FixtureSlim") {
    if (p.fixture) { applyFixture(p.fixture, false); return; }
    if (p.id && isActuallyLive(p)) { applyFixture(p, false); return; }
    return;
  }
}

// ── Discovery odlaznih WS poruka (subscribe format) ──────────────────────────
const OUT_WS_LOG = path.join(__dirname, "bwin-ws-out-log.txt");
const _seenOutTargets = new Set();
let _outWsCount = 0;

function logOutgoingWsFrame(payload) {
  const parts = payload.split("\x1e").filter(s => s.trim().length > 0);
  for (const part of parts) {
    const txt = part.trim();
    let data;
    try { data = JSON.parse(txt); } catch {
      // SignalR handshake je goli JSON bez \x1e ponekad — loguj prvih par sirovo
      if (_outWsCount < 5) {
        _outWsCount++;
        fs.appendFileSync(OUT_WS_LOG, `\n[RAW OUT #${_outWsCount}] ${txt.slice(0,300)}\n`);
        console.log(`[WS OUT RAW] ${txt.slice(0,150)}`);
      }
      continue;
    }

    // SignalR invocation: { type:1, target:"...", arguments:[...] }
    const target = data?.target ?? data?.M ?? null;
    if (data?.type === 1 && target) {
      // Discovery gotov — loguj samo NOVE targete jednom (ne svaki subscribe)
      if (!_seenOutTargets.has(target)) {
        _seenOutTargets.add(target);
        const ts = new Date().toISOString().slice(11,23);
        const entry = `\n--- [WS OUT ${ts}] target="${target}" ---\n${JSON.stringify(data, null, 2)}\n`;
        fs.appendFileSync(OUT_WS_LOG, entry);
        console.log(`[WS OUT] ${ts} target="${target}" args=${JSON.stringify(data.arguments ?? data.A ?? []).slice(0,300)}`);
      }
      continue;
    }

    // Handshake ili drugi tipovi — loguj prvih par
    if (_outWsCount < 8) {
      _outWsCount++;
      fs.appendFileSync(OUT_WS_LOG, `\n[OUT OTHER #${_outWsCount}] ${txt.slice(0,400)}\n`);
      console.log(`[WS OUT OTHER] ${txt.slice(0,150)}`);
    }
  }
}

function parseWsData(data) {
  if (!data) return;

  // Format 1: { fixtures: [...] } — ista struktura kao HTTP
  if (data.fixtures) { parseFixturesList(data); return; }

  // Format 2: { fixture: {...} } — fixture-view update
  if (data.fixture) { parseFixtureView(data); return; }

  // Format 3: array of updates
  if (Array.isArray(data)) {
    for (const item of data) parseWsData(item);
    return;
  }

  // Format 4: { type, payload } envelope
  if (data.type && data.payload) { parseWsData(data.payload); return; }
  if (data.type && data.data)    { parseWsData(data.data);    return; }

  // Format 5: Bwin push update — { id, scoreboard } ili { id, optionMarkets }
  const id = String(data.id ?? data.fixtureId ?? "");
  if (id && matches.has(id)) {
    const m = matches.get(id);
    m._seen = Date.now();
    if (data.scoreboard)    applyScoreboard(m, data.scoreboard);
    if (data.optionMarkets) applyMarkets(m, data.optionMarkets);
    if (data.score)         applyScoreboard(m, { score: data.score, period: data.period, timer: data.timer });
    lastUpdate = new Date().toLocaleTimeString("sr");
  }
}

// ── CDP presretanje ───────────────────────────────────────────────────────────

const tracked      = new Map();
const _seenCds     = new Set();
let   streamsUrl   = null;
let   fixtureViewUrlTemplate = null; // template za fixture-view polling
let   bwinPage_    = null;

// Čuvamo prethodni score za detekciju promjene
const prevScores = new Map();

// WS watchdog — prati kad je zadnja WS poruka stigla
let lastWsTs = Date.now();

setInterval(async () => {
  const silentMs = Date.now() - lastWsTs;
  if (silentMs > 5 * 60 * 1000 && bwinPage_) {
    const ts = new Date().toISOString().slice(11,23);
    console.log(`[WS WATCHDOG] ${ts} WS tih ${Math.round(silentMs/1000)}s — relodujem stranicu`);
    try {
      await bwinPage_.reload({ waitUntil: "domcontentloaded" });
      lastWsTs = Date.now(); // reset da ne triggeruje odmah ponovo
    } catch(e) { console.warn(`[WS WATCHDOG] reload greška: ${e.message}`); }
  }
}, 60 * 1000);

function checkScoreChanges() {
  for (const [id, m] of matches) {
    const prev = prevScores.get(id);
    if (prev !== undefined && prev !== m.score && m.score !== "--") {
      const ts = new Date().toISOString().slice(11,23);
      console.log(`[GOL!] ${ts} | ${m.name} | ${prev} → ${m.score}`);
    }
    prevScores.set(id, m.score);
  }
}

function setupCDP(cdp) {
  // HTTP presretanje — loguj SVE bwin.com API requestove s timestampom
  cdp.on("Network.responseReceived", (evt) => {
    const url = evt.response.url ?? "";
    if (!url.includes("bwin.com")) return;
    if (evt.response.status !== 200) return;

    const urlLow = url.toLowerCase();

    // Loguj sve cds-api requestove s timestampom (za discovery kad padne gol)
    if (urlLow.includes("cds-api") || urlLow.includes("/live/")) {
      const ep = url.replace(/\?.*/, "").split("bwin.com")[1] ?? url;
      const ts = new Date().toISOString().slice(11,23);
      console.log(`[REQ ${ts}] ${ep}`);
    }

    const isStreams     = urlLow.includes("/live/streams");
    const isFixtures    = !isStreams && urlLow.includes("/fixtures") && !urlLow.includes("fixture-view");
    const isFixtureView = urlLow.includes("fixture-view");
    if (!isStreams && !isFixtures && !isFixtureView) return;

    // Snimi streams URL za periodični polling
    if (isStreams && !streamsUrl) {
      streamsUrl = url;
      console.log(`[STREAM URL] snimljen, počinjem polling...`);
      startStreamPolling();
    }

    // Snimi fixture-view URL template
    if (isFixtureView) {
      if (!fixtureViewUrlTemplate) {
        // Pronađi ID parametar — može biti fixtureId, fixtureIds, fixture, id, ids, s-sportid
        const idParam = url.match(/[?&](fixtureIds?|fixture|ids?)[=]([^&]+)/i);
        if (idParam) {
          fixtureViewUrlTemplate = url.replace(new RegExp(`([?&])${idParam[1]}=[^&]+`), `$1${idParam[1]}=FIXTURE_ID`);
          console.log(`[FV URL] template snimljen, param=${idParam[1]}`);
          startFixtureViewPolling();
        } else {
          console.log(`[FV URL] nema ID param! URL: ${url.slice(0,200)}`);
        }
      }
    }

    const type = isStreams ? "streams" : isFixtures ? "fixtures" : "fixture-view";
    tracked.set(evt.requestId, { url, type });
  });

  cdp.on("Network.loadingFinished", async (evt) => {
    if (!tracked.has(evt.requestId)) return;
    const { url, type } = tracked.get(evt.requestId);
    tracked.delete(evt.requestId);
    try {
      const body = await cdp.send("Network.getResponseBody", { requestId: evt.requestId });
      const raw  = body?.body;
      if (!raw || raw.length < 20 || (!raw.startsWith("{") && !raw.startsWith("["))) return;
      const data = JSON.parse(raw);
      if (type === "streams")      parseStreams(data);
      if (type === "fixtures")     parseFixturesList(data);
      if (type === "fixture-view") parseFixtureView(data);
      lastUpdate = new Date().toLocaleTimeString("sr");
      checkScoreChanges();
    } catch(e) { console.warn(`[CDP ERR] ${type}: ${e.message}`); }
  });

  // WebSocket presretanje — real-time score/odds
  cdp.on("Network.webSocketFrameReceived", (evt) => {
    try {
      const payload = evt.response?.payloadData ?? "";
      if (!payload || payload.length < 5) return;
      handleWsFrame(payload);
    } catch {}
  });

  // ODLAZNE WS poruke — discovery subscribe formata (browser → Bwin server)
  cdp.on("Network.webSocketFrameSent", (evt) => {
    try {
      const payload = evt.response?.payloadData ?? "";
      if (!payload || payload.length < 3) return;
      logOutgoingWsFrame(payload);
    } catch {}
  });
}

// ── Pokretanje Puppeteer ──────────────────────────────────────────────────────

// Periodično pozivaj fixture-view za SVE live mečeve svake 3s (=2s gol detekcija)
let _fvPollActive = false;

function startFixtureViewPolling() {
  if (_fvPollActive || !bwinPage_) return;
  _fvPollActive = true;
  const INTERVAL = 3000;

  setInterval(async () => {
    if (!bwinPage_ || !fixtureViewUrlTemplate) return;
    const ids = [...matches.keys()];
    if (!ids.length) return;
    try {
      await bwinPage_.evaluate(async (template, ids) => {
        // Pošalji sve paralelno — ne čekaj, CDP hvata sve odgovore
        for (const id of ids) {
          const url = template.replace("FIXTURE_ID", encodeURIComponent(id));
          fetch(url, { cache: "no-store", credentials: "include" }).catch(() => {});
        }
      }, fixtureViewUrlTemplate, ids);
    } catch {}
  }, INTERVAL);

  console.log(`[FV POLL] startovan, sve mečeve svake ${INTERVAL}ms`);
}

// Periodično pozivaj /live/streams iz browser konteksta (ima session/cookie)
// CDP uhvati svaki odgovor → parseStreams
let _streamPollActive = false;
function startStreamPolling() {
  if (_streamPollActive || !streamsUrl || !bwinPage_) return;
  _streamPollActive = true;
  const INTERVAL = 3000; // svake 3 sekunde

  setInterval(async () => {
    if (!bwinPage_ || !streamsUrl) return;
    try {
      await bwinPage_.evaluate(async (url) => {
        await fetch(url, { cache: "no-store", credentials: "include" });
      }, streamsUrl);
    } catch {}
  }, INTERVAL);

  console.log(`[STREAM POLL] startovan, interval=${INTERVAL}ms`);
}

// Ručni Subscribe na SVE poznate mečeve preko Bwinovog WS-a (bez skrolanja)
let _subLoopActive = false;
function startSubscribeLoop() {
  if (_subLoopActive) return;
  _subLoopActive = true;
  const INTERVAL = 4000;

  setInterval(async () => {
    if (!bwinPage_) return;
    const ids = [...matches.keys()];
    if (!ids.length) return;
    // Topic format: v2|en|<id>_1_any|grd   (id je npr. "2:7816503")
    const topics = ids.map(id => `v2|en|${id}_1_any|grd`);
    try {
      const ok = await bwinPage_.evaluate((topics) => {
        if (typeof window.__bwinSubscribe !== "function") return -1;
        return window.__bwinSubscribe(topics) ? 1 : 0;
      }, topics);
      if (ok === 1) console.log(`[SUB] subscribed ${topics.length} topija`);
      else if (ok === 0) console.log(`[SUB] WS još nije spreman (${topics.length} čeka)`);
    } catch {}
  }, INTERVAL);

  console.log(`[SUB] subscribe loop startovan (svake ${INTERVAL}ms)`);
}

async function autoScroll(page) {
  try {
    const height = await page.evaluate(() => document.body.scrollHeight);
    const step = 600;
    let pos = 0;
    while (pos < height + 2000) {
      pos += step;
      await page.evaluate(y => window.scrollTo(0, y), pos);
      await new Promise(r => setTimeout(r, 150));
    }
    // Scroll nazad gore
    await page.evaluate(() => window.scrollTo(0, 0));
    console.log(`[Scroll] završen, fixture-view requests: ${matches.size} live mečeva`);
    // Ponovi scroll svakih 30s da uhvati nove mečeve
    setTimeout(() => autoScroll(page), 30000);
  } catch(e) { console.warn("[Scroll ERR]", e.message); }
}

async function startBrowser() {
  if (!CHROME_PATHS.length) { console.error("Chrome nije pronađen!"); process.exit(1); }

  // Obrisi session fajlove da Chrome ne pita za "Restore pages?"
  const sessionFiles = [
    path.join(PROFILE_DIR, "Default", "Sessions"),
    path.join(PROFILE_DIR, "Default", "Last Session"),
    path.join(PROFILE_DIR, "Default", "Last Tabs"),
  ];
  for (const f of sessionFiles) {
    try {
      if (fs.existsSync(f)) {
        const stat = fs.statSync(f);
        if (stat.isDirectory()) fs.rmSync(f, { recursive: true, force: true });
        else fs.unlinkSync(f);
      }
    } catch {}
  }

  console.log("Pokrećem Chrome:", CHROME_PATHS[0]);
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATHS[0],
    headless: false,
    userDataDir: PROFILE_DIR,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--no-first-run",
      "--disable-session-crashed-bubble",
      "--disable-infobars",
      "--no-restore-session-state",
      "--disable-restore-session-state",
      "--hide-crash-restore-bubble",
    ],
    defaultViewport: null,
  });

  const page = await browser.newPage();
  bwinPage_  = page;

  // Hook WebSocket PRIJE Bwinovog JS-a — uhvati SignalR socket za ručni Subscribe
  await page.evaluateOnNewDocument(() => {
    window.__bwinWS = null;
    window.__bwinSubOK = 0;
    const OrigWS = window.WebSocket;
    function Patched(...args) {
      const ws = new OrigWS(...args);
      const origSend = ws.send.bind(ws);
      ws.send = function (d) {
        try {
          const s = typeof d === "string" ? d : "";
          // SignalR socket sam šalje handshake i Subscribe — tako ga prepoznajemo
          if (s.includes('"protocol":"json"') || s.includes('"target":"Subscribe"')) {
            window.__bwinWS = ws;
          }
        } catch {}
        return origSend(d);
      };
      return ws;
    }
    Patched.prototype = OrigWS.prototype;
    try { Object.assign(Patched, OrigWS); } catch {}
    window.WebSocket = Patched;

    // Ručni Subscribe na sve topije
    window.__bwinSubscribe = function (topics) {
      try {
        const ws = window.__bwinWS;
        if (!ws || ws.readyState !== 1) return false;
        const msg = JSON.stringify({
          arguments: [{ topics }],
          invocationId: String(Date.now() % 1000000),
          target: "Subscribe",
          type: 1,
        }) + "\u001e";
        ws.send(msg);
        window.__bwinSubOK++;
        return true;
      } catch { return false; }
    };
  });

  const cdp  = await page.target().createCDPSession();
  await cdp.send("Network.enable");
  setupCDP(cdp);

  console.log("Navigiram:", BWIN_URL);
  await page.goto(BWIN_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  console.log("Stranica učitana.");

  // Pokreni ručni subscribe loop — svake 4s subscribe sve poznate mečeve
  startSubscribeLoop();

  // Klikni "ALL LIVE FOOTBALL" da se prikažu svi mečevi
  (async () => {
    try {
      await page.waitForFunction(
        () => [...document.querySelectorAll("a, button, ms-link, span")].some(el => /all\s+live\s+football/i.test(el.textContent.trim())),
        { timeout: 15000 }
      );
      await page.evaluate(() => {
        const el = [...document.querySelectorAll("a, button, ms-link, span")].find(el => /all\s+live\s+football/i.test(el.textContent.trim()));
        if (el) { el.click(); console.log("[CLICK] ALL LIVE FOOTBALL kliknut"); }
      });
      console.log("[CLICK] ALL LIVE FOOTBALL OK");
    } catch(e) { console.warn("[CLICK ERR] ALL LIVE FOOTBALL:", e.message); }
  })();

  // Auto-scroll ISKLJUČEN — skrolanje tjera Bwin da odjavi topije koje mi ručno
  // subscribe-ujemo. Sada koristimo startSubscribeLoop() za sve mečeve direktno.
  // setTimeout(() => autoScroll(page), 6000);

  // Watchdog — reload ako nema podataka 3 minute
  let noDataCount = 0;
  setInterval(async () => {
    if (matches.size === 0) {
      if (++noDataCount >= 3) {
        noDataCount = 0;
        console.log("[Watchdog] Nema live mečeva — reload...");
        try { await page.reload({ waitUntil: "domcontentloaded", timeout: 15000 }); } catch{}
      }
    } else { noDataCount = 0; }
  }, 60 * 1000);
}

// ── HTTP server ───────────────────────────────────────────────────────────────

function isEsoccer(m) {
  const comp = (m.competition ?? "").toLowerCase().replace(/-/g, "");
  // eSoccer competition sadrži "esoccer", "esport", "virtual", "cyber"
  if (comp.includes("esoccer") || comp.includes("esport") || comp.includes("virtual") || comp.includes("cyber")) return true;
  // Tenis
  if (comp.includes(" atp ") || comp.includes(" wta ") || comp.includes("challenger") || comp.includes("itf ") ||
      comp.startsWith("atp") || comp.startsWith("wta")) return true;
  // eSoccer format: "Germany (player1) - Argentina (player2)" — oba tima imaju igrača u zagradi
  // Isključi poznate kvalifikatore koji nisu igrači
  const qualifiers = /^(women|reserves|youth|u\d+|ii|iii|b|ladies|girls|boys|juniors|seniors)$/i;
  const bracketMatches = [...(m.name ?? "").matchAll(/\((\w[\w_\s]*)\)/g)].map(x => x[1].trim());
  const playerBrackets = bracketMatches.filter(b => !qualifiers.test(b));
  if (playerBrackets.length >= 2) return true;
  return false;
}

function isActuallyInPlay(m) {
  if (isFinishedPeriod(m.period)) return false; // završen → ne prikazuj
  // Prikazuj samo mečeve koji su zaista u toku — imaju period ili score nije "--"
  if (m.period && m.period !== "Not Started") return true;
  if (m.score && m.score !== "--") return true;
  return false;
}

function getState() {
  const slots = [...matches.values()]
    .filter(m => !isEsoccer(m) && isActuallyInPlay(m))
    .map(m => ({
      id: m.id, name: m.name, competition: m.competition, region: m.region,
      score: m.score, period: m.period, minute: m.minute, second: m.second,
      odds: m.odds,
      goalTs: m._goalTs, // tačan trenutak (ms) zadnjeg gola po WS-u
    }));
  return { ts: lastUpdate ?? "--", count: slots.length, slots };
}

// ── HTML + 20ms smart diff ────────────────────────────────────────────────────

const HTML = `<!DOCTYPE html>
<html lang="sr">
<head>
<meta charset="UTF-8">
<title>Bwin Live Football</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
* { box-sizing:border-box; margin:0; padding:0; }
body { background:#0f1923; color:#cfd8e3; font-family:'Segoe UI',sans-serif; font-size:13px; padding:12px; }
h1 { color:#1e90ff; font-size:18px; margin-bottom:4px; }
#ts { color:#667; font-size:11px; margin-bottom:12px; }
.match { background:#1a2634; border-radius:8px; padding:10px 14px; margin-bottom:8px; border-left:4px solid #1e90ff; }
.match-name { font-size:14px; font-weight:600; color:#e0e8f0; }
.match-meta { color:#667; font-size:11px; margin:3px 0 5px; }
.score { font-size:28px; font-weight:700; color:#f0c040; margin:3px 0; }
.score .goal-side { color:#ff0000; font-size:34px; }
.match.goal-flash { border-left-color:#00e676; background:#1a2e20; animation:gflash 2s ease-out forwards; }
@keyframes gflash { 0%{background:#1e4a28} 100%{background:#1a2e20} }
.odds { display:flex; gap:10px; margin-top:6px; }
.odd-box { background:#243040; border-radius:5px; padding:4px 14px; text-align:center; min-width:60px; }
.odd-label { font-size:10px; color:#778899; }
.odd-val { font-size:16px; font-weight:700; color:#e0e8f0; }
.odd-val.susp { color:#556; font-size:12px; }
#empty { color:#667; padding:30px; text-align:center; font-size:14px; }
</style>
</head>
<body>
<h1>&#9917; BWIN LIVE FOOTBALL</h1>
<div id="ts">Učitavam...</div>
<div id="content"><div id="empty">Čekam live mečeve...</div></div>
<script>
let prev = "";
let prevScores = {};

async function upd(){
  const d = await fetch('/data?t='+Date.now(),{cache:'no-store'}).then(r=>r.json()).catch(()=>null);
  if(!d) return;

  document.getElementById('ts').textContent = 'Ažurirano: '+d.ts+' | Live: '+d.count;

  const json = JSON.stringify(d.slots);
  if(json === prev) return; // ništa se nije promijenilo — ne crtaj
  prev = json;

  const c = document.getElementById('content');
  if(!d.slots.length){ c.innerHTML='<div id="empty">Nema live fudbalskih mečeva trenutno...</div>'; return; }

  c.innerHTML = d.slots.map(m => {
    const comp = [m.region, m.competition].filter(Boolean).join(' \u203a ');
    const min  = m.minute != null ? (m.minute + (m.second != null ? ':'+String(m.second).padStart(2,'0') : "") + "'") : '--';

    // Odredi koji tim je dao gol (home ili away)
    const prev = prevScores[m.id] || null;
    const cur  = m.score || "--";
    let goalHome = false, goalAway = false;
    if (prev && prev !== cur && cur !== "--") {
      const [ph, pa] = prev.split(":").map(Number);
      const [ch, ca] = cur.split(":").map(Number);
      if (!isNaN(ch) && !isNaN(ca)) {
        goalHome = ch > ph;
        goalAway = ca > pa;
      }
    }
    prevScores[m.id] = cur;

    // Prikaži score sa obeleženim golom: HOME:AWAY — goler dobija zelenu boju
    let scoreHtml;
    if (cur === "--") {
      scoreHtml = '<span>--</span>';
    } else {
      const [h, a] = cur.split(":");
      scoreHtml = '<span class="'+(goalHome?'goal-side':'')+'">'+h+'</span>'
                + '<span style="color:#667">:</span>'
                + '<span class="'+(goalAway?'goal-side':'')+'">'+a+'</span>';
    }

    const oddsHtml = m.odds
      ? '<div class="odds">'+['1','X','2'].map(k => {
          const v = m.odds[k];
          return '<div class="odd-box"><div class="odd-label">'+k+'</div>'
               + '<div class="odd-val'+(v==null?' susp':'')+'">'+( v!=null ? parseFloat(v).toFixed(2) : 'SUSP' )+'</div></div>';
        }).join('')+'</div>'
      : '<div style="color:#445;font-size:11px;margin-top:4px;">kvote suspendirane</div>';

    const matchClass = 'match'+(goalHome||goalAway?' goal-flash':'');
    return '<div class="'+matchClass+'">'
      + '<div class="match-name">'+m.name+'</div>'
      + '<div class="match-meta">'+comp+(m.period?' | '+m.period:'')+' | '+min+'</div>'
      + '<div class="score">'+scoreHtml+'</div>'
      + oddsHtml
      + '</div>';
  }).join('');
}

upd();
setInterval(upd, 20);
</script>
</body>
</html>`;

const server = http.createServer((req, res) => {
  if (req.url.startsWith("/data") || req.url.startsWith("/state")) {
    res.writeHead(200, { "Content-Type":"application/json", "Cache-Control":"no-store", "Access-Control-Allow-Origin":"*" });
    res.end(JSON.stringify(getState()));
    return;
  }
  res.writeHead(200, { "Content-Type":"text/html;charset=utf-8", "Cache-Control":"no-cache" });
  res.end(HTML);
});

server.listen(PORT, () => console.log(`Bwin Live Football: http://localhost:${PORT}`));
startBrowser().catch(e => { console.error("Browser greška:", e.message); process.exit(1); });
