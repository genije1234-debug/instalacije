import { chromium } from "playwright";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";

const DEFAULT_SELECTORS = {
  match:
    '[data-fi], [data-fid], [data-fixture], [data-fixture-id], [data-ev], [data-event], [data-event-id], [data-oid], [data-oi], [data-qa*="event"], [class*="fixture"], [class*="Fixture"], [class*="match"], [class*="Match"], [class*="event"]',
  teams: '[data-qa*="team"], [class*="team"], [class*="competitor"]',
  time: '[data-qa*="time"], [class*="time"], [class*="clock"]',
  score: '[data-qa*="score"], [class*="score"]',
  odds: '[data-qa*="odds"], [class*="odds"], [class*="price"]'
};

function readSelectors() {
  return {
    match: process.env.MATCH_SELECTOR || DEFAULT_SELECTORS.match,
    teams: process.env.TEAMS_SELECTOR || DEFAULT_SELECTORS.teams,
    time: process.env.TIME_SELECTOR || DEFAULT_SELECTORS.time,
    score: process.env.SCORE_SELECTOR || DEFAULT_SELECTORS.score,
    odds: process.env.ODDS_SELECTOR || DEFAULT_SELECTORS.odds
  };
}

function normalizeText(value) {
  return value.replace(/\s+/g, " ").trim();
}

function parseOdd(text) {
  const cleaned = text.replace(",", ".");
  const number = Number.parseFloat(cleaned);
  if (Number.isFinite(number)) {
    return number;
  }
  return null;
}

function isTime(text) {
  return /^\d{1,2}:\d{2}$/.test(text);
}

function isInteger(text) {
  return /^\d{1,2}$/.test(text);
}

function isOddText(text) {
  return /^\d{1,3}([.,]\d{1,2})$/.test(text);
}

function isHeaderMarker(lines, index) {
  return lines[index + 1] === "1" && lines[index + 2] === "X" && lines[index + 3] === "2";
}

function isEsoccerMatch(match) {
  const excludeEsoccer =
    (process.env.EXCLUDE_ESOCCER || "true").toLowerCase() === "true";
  if (!excludeEsoccer) {
    return false;
  }
  const keywordsRaw =
    process.env.ESOCCER_KEYWORDS || "esoccer,e-soccer,e soccer";
  const keywords = keywordsRaw
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  const tag = (match?.tag || match?.TA || "").toString();
  const haystack = [
    match?.competition || "",
    ...(match?.teams || []),
    match?.name || "",
    tag
  ]
    .join(" ")
    .toLowerCase();
  return keywords.some((keyword) => haystack.includes(keyword));
}

function parseFromBodyText(bodyText) {
  const lines = bodyText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const matches = [];
  let i = 0;
  while (i < lines.length - 3) {
    if (!isHeaderMarker(lines, i)) {
      i += 1;
      continue;
    }
    const competition = lines[i];
    i += 4;
    while (i < lines.length) {
      if (i + 3 < lines.length && isHeaderMarker(lines, i)) {
        break;
      }
      const team1 = lines[i];
      const team2 = lines[i + 1];
      if (!team1 || !team2) {
        i += 1;
        continue;
      }
      if (
        team1 === "1" ||
        team1 === "X" ||
        team1 === "2" ||
        isOddText(team1) ||
        isInteger(team1)
      ) {
        i += 1;
        continue;
      }
      i += 2;
      let time = "";
      if (i < lines.length && isTime(lines[i])) {
        time = lines[i];
        i += 1;
      }
      let score = "";
      if (i + 1 < lines.length && isInteger(lines[i]) && isInteger(lines[i + 1])) {
        score = `${lines[i]}-${lines[i + 1]}`;
        i += 2;
      }
      const odds = [];
      while (i < lines.length && odds.length < 3) {
        if (isOddText(lines[i])) {
          odds.push(parseOdd(lines[i]));
          i += 1;
        } else {
          break;
        }
      }
      if (odds.length === 3) {
        const match = {
          teams: [team1, team2],
          time,
          score,
          odds,
          competition,
          suspend: false
        };
        if (!isEsoccerMatch(match)) {
          matches.push(match);
        }
      }
    }
  }
  return matches;
}

function makeMatchId(match) {
  if (match.fixtureId) {
    return `fi:${match.fixtureId}`;
  }
  const teams = match.teams.join(" vs ");
  return `${teams}|${match.time || "?"}|${match.competition || "?"}`;
}

function diffSnapshots(prev, next) {
  const prevMap = new Map(prev.map((item) => [item.id, item]));
  const nextMap = new Map(next.map((item) => [item.id, item]));

  const added = [];
  const removed = [];
  const changed = [];

  for (const [id, item] of nextMap.entries()) {
    if (!prevMap.has(id)) {
      added.push(item);
      continue;
    }
    const previous = prevMap.get(id);
    const scoreChanged = previous.score !== item.score && item.score;
    const oddsChanged =
      JSON.stringify(previous.odds || []) !== JSON.stringify(item.odds || []);
    const suspendChanged = previous.suspend !== item.suspend;
    if (scoreChanged || oddsChanged || suspendChanged) {
      changed.push({
        before: previous,
        after: item,
        changes: {
          score: scoreChanged,
          odds: oddsChanged,
          suspend: suspendChanged
        }
      });
    }
  }

  return { added, removed, changed };
}

export async function startScraper({
  url,
  intervalMs,
  realtimeOnly,
  onSnapshot,
  onChanges,
  onLog,
  onLag,
  onRawWs,
  onRawXhr,
  onDomRaw,
  onDomMatches,
  onFixtureMap,
  onWsTeams,
  onWsUpdates
}) {
  const selectors = readSelectors();
  const debugDir = path.join(process.cwd(), "debug");
  const reloadEachPoll =
    (process.env.RELOAD_EACH_POLL || "false").toLowerCase() === "true";
  const minBodyTextLength = Number(process.env.MIN_BODY_TEXT_LENGTH || 4000);
  const persistentContext =
    (process.env.PERSISTENT_CONTEXT || "true").toLowerCase() === "true";
  const attachToCdp =
    (process.env.ATTACH_CDP || "false").toLowerCase() === "true";
  const cdpEndpoint = process.env.CDP_ENDPOINT || "http://localhost:9222";
  const autoLaunchChrome =
    (process.env.AUTO_LAUNCH_CHROME || "false").toLowerCase() === "true";
  const navigateOnAttach =
    (process.env.NAVIGATE_ON_ATTACH || "true").toLowerCase() === "true";
  const chromePath = process.env.CHROME_PATH || "";
  const chromeUserDataDir =
    process.env.CHROME_USER_DATA_DIR ||
    path.join(process.cwd(), "profile-cdp");
  const chromeArgsRaw = process.env.CHROME_ARGS || "";
  const enableNetworkCapture =
    (process.env.ENABLE_NETWORK_CAPTURE || "false").toLowerCase() === "true";
  const useNetworkSnapshot =
    (process.env.USE_NETWORK_SNAPSHOT || "true").toLowerCase() === "true";
  const forceNetworkOnly =
    (process.env.FORCE_NETWORK_ONLY || "false").toLowerCase() === "true";
  const websocketOnly =
    (process.env.WEBSOCKET_ONLY || "false").toLowerCase() === "true";
  const allowDomSeed =
    (process.env.ALLOW_DOM_SEED || "true").toLowerCase() === "true";
  const domCapture =
    (process.env.DOM_CAPTURE || "false").toLowerCase() === "true";
  const domCaptureIntervalMs = Number(
    process.env.DOM_CAPTURE_INTERVAL_MS || 5000
  );
  const domMatchCapture =
    (process.env.DOM_MATCH_CAPTURE || "true").toLowerCase() === "true";
  const domMatchLimit = Number(process.env.DOM_MATCH_LIMIT || 60);
  const networkSnapshotTtlMs = Number(
    process.env.NETWORK_SNAPSHOT_TTL_MS || 6000
  );
  const networkMaxBody = Number(process.env.NETWORK_MAX_BODY || 200000);
  const logNetworkToFile =
    (process.env.LOG_NETWORK_TO_FILE || "false").toLowerCase() === "true";
  let browser;
  let page;
  let hasNavigated = false;
  let previousSnapshot = [];
  let isRunning = false;
  let networkCaptureStarted = false;
  let latestNetworkSnapshot = null;
  let latestNetworkTimestamp = 0;
  let chromeProcess = null;
  let domMatchIndexByFi = new Map();
  let domMatchTextByFi = new Map();
  let lastDomMatches = [];

  function normalizeMatchText(value) {
    if (!value) return "";
    return value
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  function applySnapshot(snapshot, source, receivedAt) {
    if (!Array.isArray(snapshot)) return;
    if (domMatchIndexByFi.size > 0) {
      for (const item of snapshot) {
        if (!item.fixtureId) continue;
        if (domMatchIndexByFi.has(item.fixtureId)) {
          item.domMatchIndex = domMatchIndexByFi.get(item.fixtureId);
          item.domMatchText = domMatchTextByFi.get(item.fixtureId) || "";
        }
      }
    }
    if (lastDomMatches.length > 0) {
      for (const item of snapshot) {
        if (!item.fixtureId) continue;
        if (item.domMatchIndex != null) continue;
        const teams = (item.teams || []).map(normalizeMatchText).filter(Boolean);
        if (teams.length < 2) continue;
        const [teamA, teamB] = teams;
        const match = lastDomMatches.find((entry) => {
          if (entry.teams.length >= 2) {
            return entry.teams.includes(teamA) && entry.teams.includes(teamB);
          }
          return (
            entry.normalized.includes(teamA) &&
            entry.normalized.includes(teamB)
          );
        });
        if (match) {
          item.domMatchIndex = match.index;
          item.domMatchText = match.text || "";
          domMatchIndexByFi.set(item.fixtureId, match.index);
          domMatchTextByFi.set(item.fixtureId, match.text || "");
        }
      }
    }
    onSnapshot(snapshot);
    if (typeof onFixtureMap === "function") {
      const unique = new Map();
      for (const item of snapshot) {
        if (!item.fixtureId) continue;
        if (!unique.has(item.fixtureId)) {
          unique.set(item.fixtureId, {
            fixtureId: item.fixtureId,
            teams: item.teams,
            time: item.time,
            domMatchIndex: item.domMatchIndex ?? null,
            domMatchText: item.domMatchText ?? ""
          });
        }
      }
      const mapped = Array.from(unique.values());
      onFixtureMap({ source, mapped });
    }
    if (previousSnapshot.length > 0) {
      const changes = diffSnapshots(previousSnapshot, snapshot);
      if (
        changes.changed.length > 0 ||
        changes.added.length > 0 ||
        changes.removed.length > 0
      ) {
        onChanges(changes);
      }
    }
    if (lastStaleRemoval && Date.now() - lastStaleRemoval.at < 2000) {
      log(
        "info",
        `Removed stale fixtures: ${lastStaleRemoval.count} (no updates for ${Math.round(
          STALE_FIXTURE_MS / 60000
        )}m)`
      );
      lastStaleRemoval = null;
    }
    previousSnapshot = snapshot;
    if (source) {
      log("info", `Snapshot applied from ${source}.`);
    }
    if (receivedAt && onLag) {
      const lagMs = Math.max(0, Date.now() - receivedAt);
      onLag({ ms: lagMs, source });
    }
  }

  function log(level, message) {
    onLog({ level, message, timestamp: new Date().toISOString() });
  }

  function resolveChromePath() {
    if (chromePath) return chromePath;
    const candidates = [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
    return "";
  }

  function launchChrome() {
    const resolved = resolveChromePath();
    if (!resolved) {
      log("warn", "Chrome path not found. Set CHROME_PATH to launch.");
      return false;
    }
    const baseArgs = [
      `--remote-debugging-port=${new URL(cdpEndpoint).port || "9222"}`,
      `--user-data-dir=${chromeUserDataDir}`,
      "--no-first-run",
      "--no-default-browser-check"
    ];
    const extraArgs = chromeArgsRaw
      ? chromeArgsRaw.split(/\s+/).filter(Boolean)
      : [];
    const args = [...baseArgs, ...extraArgs, url];
    chromeProcess = spawn(resolved, args, {
      stdio: "ignore",
      detached: true
    });
    chromeProcess.unref();
    log("info", `Launched Chrome for CDP at ${cdpEndpoint}`);
    log("info", `Chrome args: ${args.join(" ")}`);
    return true;
  }

  async function connectToCdp() {
    try {
      return await chromium.connectOverCDP(cdpEndpoint);
    } catch (error) {
      if (!autoLaunchChrome) {
        throw error;
      }
      const launched = launchChrome();
      if (!launched) {
        throw error;
      }
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 750));
        try {
          return await chromium.connectOverCDP(cdpEndpoint);
        } catch {
          // retry
        }
      }
      throw error;
    }
  }

  async function ensurePage() {
    if (browser && page) {
      return;
    }
    const headless = (process.env.HEADLESS || "true").toLowerCase() !== "false";
    const userAgent =
      process.env.BROWSER_USER_AGENT ||
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";
    const contextOptions = {
      locale: "sr-RS",
      userAgent,
      viewport: { width: 1366, height: 768 },
      timezoneId: "Europe/Belgrade"
    };
    const launchOptions = {
      headless,
      args: [
        "--disable-blink-features=AutomationControlled",
        "--disable-dev-shm-usage",
        "--no-default-browser-check",
        "--no-first-run"
      ]
    };

    if (attachToCdp) {
      const cdpBrowser = await connectToCdp();
      browser = cdpBrowser;
      const contexts = cdpBrowser.contexts();
      const context = contexts[0] || (await cdpBrowser.newContext());
      const pages = context.pages();
      page = pages[0] || (await context.newPage());
      log("info", `Attached to CDP: ${cdpEndpoint}`);
      if (enableNetworkCapture && !networkCaptureStarted) {
        await setupNetworkCapture(page, log, debugDir, {
          maxBody: networkMaxBody,
          wsOnly: websocketOnly,
          logNetworkToFile,
          onRawWs,
          onRawXhr,
          onWsTeams,
          onWsUpdates,
          onSnapshot: (snapshot, receivedAt) => {
            latestNetworkSnapshot = snapshot;
            latestNetworkTimestamp = Date.now();
            applySnapshot(snapshot, "network", receivedAt);
          }
        });
        networkCaptureStarted = true;
      }
      return;
    }

    if (persistentContext) {
      const userDataDir = path.join(process.cwd(), "profile");
      const context = await chromium.launchPersistentContext(userDataDir, {
        ...launchOptions,
        ...contextOptions
      });
      page = context.pages()[0] || (await context.newPage());
      browser = context.browser();
      await context.setExtraHTTPHeaders({
        "Accept-Language": "sr-RS,sr;q=0.9,en;q=0.8"
      });
      if (enableNetworkCapture && !networkCaptureStarted) {
        await setupNetworkCapture(page, log, debugDir, {
          maxBody: networkMaxBody,
          wsOnly: websocketOnly,
          logNetworkToFile,
          onRawWs,
          onRawXhr,
          onWsTeams,
          onWsUpdates,
          onSnapshot: (snapshot, receivedAt) => {
            latestNetworkSnapshot = snapshot;
            latestNetworkTimestamp = Date.now();
            applySnapshot(snapshot, "network", receivedAt);
          }
        });
        networkCaptureStarted = true;
      }
    } else {
      browser = await chromium.launch(launchOptions);
      const context = await browser.newContext(contextOptions);
      page = await context.newPage();
      await context.setExtraHTTPHeaders({
        "Accept-Language": "sr-RS,sr;q=0.9,en;q=0.8"
      });
      await context.addInitScript(() => {
        Object.defineProperty(navigator, "webdriver", { get: () => false });
        Object.defineProperty(navigator, "languages", {
          get: () => ["sr-RS", "sr", "en-US", "en"]
        });
        Object.defineProperty(navigator, "plugins", {
          get: () => [1, 2, 3]
        });
        window.chrome = { runtime: {} };
      });
      if (enableNetworkCapture && !networkCaptureStarted) {
        await setupNetworkCapture(page, log, debugDir, {
          maxBody: networkMaxBody,
          wsOnly: websocketOnly,
          logNetworkToFile,
          onRawWs,
          onRawXhr,
          onWsTeams,
          onWsUpdates,
          onSnapshot: (snapshot, receivedAt) => {
            latestNetworkSnapshot = snapshot;
            latestNetworkTimestamp = Date.now();
            applySnapshot(snapshot, "network", receivedAt);
          }
        });
        networkCaptureStarted = true;
      }
    }
  }

  async function scrapeOnce() {
    if (isRunning) {
      log("warn", "Previous scrape still running, skipping.");
      return;
    }
    isRunning = true;
    try {
      await ensurePage();
      if (!hasNavigated || reloadEachPoll) {
        log("info", `Loading ${url}`);
        try {
          await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
          await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {
            return null;
          });
          await page.waitForTimeout(3000);
          hasNavigated = true;
        } catch (error) {
          log("error", `Navigation failed: ${error.message || error}`);
          return;
        }
      }

      await humanize(page, log);
      await handleConsent(page, log);
      await ensureInPlay(page, url, log);

      try {
        await page.waitForFunction(
          (minLength) => {
            const text = document.body ? document.body.innerText || "" : "";
            return text.length >= minLength;
          },
          minBodyTextLength,
          { timeout: 10000 }
        );
      } catch {
        log("warn", "Content still loading; continuing with current DOM.");
      }

    try {
      const meta = await page.evaluate(() => ({
        title: document.title,
        href: location.href
      }));
      log("info", `Page title: ${meta.title || "?"}`);
      log("info", `Final URL: ${meta.href || "?"}`);
    } catch (error) {
      log("warn", `Meta read failed: ${error.message || error}`);
    }

      let snapshot = [];
      const canUseNetwork =
        useNetworkSnapshot &&
        latestNetworkSnapshot &&
        Date.now() - latestNetworkTimestamp < networkSnapshotTtlMs;

      if (canUseNetwork) {
        snapshot = latestNetworkSnapshot;
      } else if (forceNetworkOnly && enableNetworkCapture) {
        log("warn", "Network-only mode: no fresh network snapshot yet.");
        return;
      } else {
        let raw;
        try {
          raw = await page.evaluate((selectors) => {
        const toText = (node) =>
          node ? node.textContent.replace(/\s+/g, " ").trim() : "";

        const queryAllDeep = (root, selector) => {
          const results = [];
          const visit = (node) => {
            if (!node) return;
            if (node.nodeType === Node.ELEMENT_NODE) {
              const el = node;
              if (el.matches && el.matches(selector)) {
                results.push(el);
              }
              if (el.shadowRoot) {
                visit(el.shadowRoot);
              }
            }
            const treeWalker = document.createTreeWalker(
              node,
              NodeFilter.SHOW_ELEMENT
            );
            let current = treeWalker.nextNode();
            while (current) {
              const el = current;
              if (el.matches && el.matches(selector)) {
                results.push(el);
              }
              if (el.shadowRoot) {
                visit(el.shadowRoot);
              }
              current = treeWalker.nextNode();
            }
          };
          visit(root);
          return results;
        };

        const queryAllDeepWithin = (root, selector) => {
          if (!root) return [];
          return queryAllDeep(root, selector);
        };

        const matchNodes = queryAllDeep(document, selectors.match);

          return matchNodes.map((node) => {
          const teams = queryAllDeepWithin(node, selectors.teams)
            .map((el) => toText(el))
            .filter(Boolean);

          const time = toText(queryAllDeepWithin(node, selectors.time)[0]);
          const score = toText(queryAllDeepWithin(node, selectors.score)[0]);
          const odds = queryAllDeepWithin(node, selectors.odds)
            .map((el) => toText(el))
            .filter(Boolean);

          return { teams, time, score, odds };
          });
        }, selectors);
        } catch (error) {
          log("error", `DOM extraction failed: ${error.message || error}`);
          return;
        }

        snapshot = raw
          .map((item) => {
            const teams = item.teams.map(normalizeText).filter(Boolean);
            const odds = item.odds
              .map(normalizeText)
              .map(parseOdd)
              .filter((value) => value !== null);
            const score = item.score ? normalizeText(item.score) : "";
            const time = item.time ? normalizeText(item.time) : "";
            return {
              id: makeMatchId({ teams, time }),
              teams,
              time,
              score,
              odds,
              competition: ""
            };
          })
          .filter((item) => item.teams.length >= 2 && !isEsoccerMatch(item));
      }

    if (snapshot.length === 0) {
      try {
        const stats = await page.evaluate(() => {
          const bodyText = document.body ? document.body.innerText || "" : "";
          const sample = bodyText.replace(/\s+/g, " ").trim().slice(0, 300);
          let shadowRoots = 0;
          const visit = (node) => {
            if (!node) return;
            if (node.nodeType === Node.ELEMENT_NODE) {
              const el = node;
              if (el.shadowRoot) {
                shadowRoots += 1;
                visit(el.shadowRoot);
              }
            }
            const treeWalker = document.createTreeWalker(
              node,
              NodeFilter.SHOW_ELEMENT
            );
            let current = treeWalker.nextNode();
            while (current) {
              const el = current;
              if (el.shadowRoot) {
                shadowRoots += 1;
                visit(el.shadowRoot);
              }
              current = treeWalker.nextNode();
            }
          };
          visit(document);
          return {
            bodyTextLength: bodyText.length,
            bodyTextSample: sample,
            shadowRoots
          };
        });
        log(
          "warn",
          `Body text length: ${stats.bodyTextLength}, shadow roots: ${stats.shadowRoots}`
        );
        if (stats.bodyTextSample) {
          log("warn", `Body sample: ${stats.bodyTextSample}`);
        }
        await fs.promises.mkdir(debugDir, { recursive: true });
        const html = await page.content();
        const htmlPath = path.join(debugDir, "debug.html");
        const pngPath = path.join(debugDir, "debug.png");
        const textPath = path.join(debugDir, "body.txt");
        await fs.promises.writeFile(htmlPath, html, "utf-8");
        const bodyText = await page.evaluate(
          () => document.body?.innerText || ""
        );
        await fs.promises.writeFile(textPath, bodyText, "utf-8");
        await page.screenshot({ path: pngPath, fullPage: true });
        log(
          "warn",
          `No matches parsed. Saved debug files to ${debugDir}`
        );
        const parsed = parseFromBodyText(bodyText);
        if (parsed.length > 0) {
          snapshot = parsed
            .filter((item) => !isEsoccerMatch(item))
            .map((item) => ({
              id: makeMatchId(item),
              teams: item.teams,
              time: item.time,
              score: item.score,
              odds: item.odds,
              competition: item.competition
            }));
          log("info", `Parsed ${snapshot.length} matches from body text.`);
        }
      } catch (error) {
        log("warn", `No matches parsed. Debug save failed: ${error.message || error}`);
      }
    }

      applySnapshot(snapshot, "poll");
    } finally {
      isRunning = false;
    }
  }

  async function initOnce() {
    await ensurePage();
    if ((!hasNavigated || reloadEachPoll) && (!attachToCdp || navigateOnAttach)) {
      try {
        if (attachToCdp) {
          log("info", "CDP attach: reloading page for fresh WS capture.");
          await page.reload({ waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => null);
          await page.waitForTimeout(2000);
        }
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
        await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {
          return null;
        });
        await page.waitForTimeout(2000);
        hasNavigated = true;
      } catch (error) {
        log("error", `Navigation failed: ${error.message || error}`);
        return;
      }
    }
    await humanize(page, log);
    await handleConsent(page, log);
    await ensureInPlay(page, url, log);
  }

  async function captureDomOnce() {
    try {
      await ensurePage();
      const payload = await page.evaluate(() => {
        const bodyText = document.body?.innerText || "";
        const sample = bodyText.replace(/\s+/g, " ").trim().slice(0, 4000);
        return {
          url: location.href,
          length: bodyText.length,
          sample
        };
      });
      if (typeof onDomRaw === "function") {
        onDomRaw(payload);
      }
    } catch (error) {
      log("warn", `DOM capture failed: ${error.message || error}`);
    }
  }

  async function captureDomMatchesOnce() {
    try {
      await ensurePage();
      const payload = await page.evaluate(
        ({ selectors, limit }) => {
          const toText = (node) =>
            node ? node.textContent.replace(/\s+/g, " ").trim() : "";

          const queryAllDeep = (root, selector) => {
            const results = [];
            const visit = (node) => {
              if (!node) return;
              if (node.nodeType === Node.ELEMENT_NODE) {
                const el = node;
                if (el.matches && el.matches(selector)) {
                  results.push(el);
                }
                if (el.shadowRoot) {
                  visit(el.shadowRoot);
                }
              }
              const treeWalker = document.createTreeWalker(
                node,
                NodeFilter.SHOW_ELEMENT
              );
              let current = treeWalker.nextNode();
              while (current) {
                const el = current;
                if (el.matches && el.matches(selector)) {
                  results.push(el);
                }
                if (el.shadowRoot) {
                  visit(el.shadowRoot);
                }
                current = treeWalker.nextNode();
              }
            };
            visit(root);
            return results;
          };

          const matchNodes = queryAllDeep(document, selectors.match);
          const matches = matchNodes.slice(0, limit).map((node, index) => {
            const attrs = {};
            for (const attr of node.attributes || []) {
              const name = attr.name.toLowerCase();
              if (
                name.startsWith("data-") ||
                name === "id" ||
                name === "class" ||
                name === "aria-label" ||
                name === "href"
              ) {
                attrs[name] = attr.value;
              }
            }
            const dataset = { ...node.dataset };
            const link = node.closest("a");
            const linkHref = link ? link.getAttribute("href") || "" : "";
            const textSample = toText(node).slice(0, 500);
            const teamNameSelectors = [
              ".ovm-FixtureDetailsTwoWay_TeamName",
              ".ovm-FixtureDetails_TeamName",
              "[data-qa*='team-name']",
              "[class*='TeamName']"
            ];
            const teamNames = teamNameSelectors
              .flatMap((selector) =>
                Array.from(node.querySelectorAll(selector)).map((el) =>
                  toText(el)
                )
              )
              .filter((value) => value && !/\d/.test(value))
              .filter((value, index, arr) => arr.indexOf(value) === index)
              .slice(0, 2);
            const extractIds = (str) => {
              const found = new Set();
              if (!str) return found;
              for (const match of str.matchAll(/OV(\d{5,})/g)) {
                found.add(match[1]);
              }
              for (const match of str.matchAll(/FI=(\d{5,})/g)) {
                found.add(match[1]);
              }
              for (const match of str.matchAll(/fixtureId[="':]*([0-9]{5,})/gi)) {
                found.add(match[1]);
              }
              for (const match of str.matchAll(/(?:^|[^0-9])(\d{6,})(?:[^0-9]|$)/g)) {
                found.add(match[1]);
              }
              for (const match of str.matchAll(/fixtureId[="':\s]*([0-9]{5,})/gi)) {
                found.add(match[1]);
              }
              for (const match of str.matchAll(/(?:FI|Fid|FID|fi|fid|oi|OI)[=:"'\s]+([0-9]{5,})/g)) {
                found.add(match[1]);
              }
              return found;
            };
            const idCandidates = new Set();
            const ancestorAttrs = [];
            let current = node.parentElement;
            let depth = 0;
            while (current && depth < 5) {
              const a = {};
              for (const attr of current.attributes || []) {
                const name = attr.name.toLowerCase();
                if (
                  name.startsWith("data-") ||
                  name === "id" ||
                  name === "class" ||
                  name === "aria-label" ||
                  name === "href"
                ) {
                  a[name] = attr.value;
                }
              }
              ancestorAttrs.push(a);
              current = current.parentElement;
              depth += 1;
            }
            const subtreeAttrNodes = Array.from(
              node.querySelectorAll(
                "[data-fi],[data-fid],[data-fixture],[data-fixture-id],[data-oi],[data-oid],[data-event],[data-event-id]"
              )
            ).slice(0, 20);
            const subtreeAttrs = subtreeAttrNodes.map((el) => {
              const a = {};
              for (const attr of el.attributes || []) {
                const name = attr.name.toLowerCase();
                if (name.startsWith("data-")) {
                  a[name] = attr.value;
                }
              }
              return a;
            });
            const linkHrefs = Array.from(
              new Set(
                Array.from(node.querySelectorAll("a"))
                  .map((anchor) => anchor.getAttribute("href") || "")
                  .filter(Boolean)
              )
            );
            const candidateInputs = [
              linkHref,
              ...linkHrefs,
              textSample,
              JSON.stringify(dataset),
              JSON.stringify(attrs),
              JSON.stringify(ancestorAttrs),
              JSON.stringify(subtreeAttrs)
            ];
            for (const value of candidateInputs) {
              for (const id of extractIds(String(value))) {
                idCandidates.add(id);
              }
            }
            const attrPairs = Object.entries(attrs);
            for (const [name, value] of attrPairs) {
              const n = name.toLowerCase();
              if (
                n.includes("fi") ||
                n.includes("fixture") ||
                n.includes("event") ||
                n.includes("match")
              ) {
                for (const id of extractIds(String(value))) {
                  idCandidates.add(id);
                }
              }
            }
            const dataPairs = Object.entries(dataset);
            for (const [name, value] of dataPairs) {
              const n = name.toLowerCase();
              if (
                n.includes("fi") ||
                n.includes("fixture") ||
                n.includes("event") ||
                n.includes("match")
              ) {
                for (const id of extractIds(String(value))) {
                  idCandidates.add(id);
                }
              }
            }
            const fiCandidates = Array.from(idCandidates);
            return {
              index,
              tagName: node.tagName,
              id: node.id || "",
              className: node.className || "",
              dataset,
              attributes: attrs,
              linkHref,
              textSample,
              teamNames,
              fiCandidates
            };
          });
          const candidateSelector =
            "[data-qa], [data-id], [data-fi], [data-fid], [data-fixture], [data-fixture-id], [data-event], [data-event-id], [data-ev], [data-match], [id*='OV'], [href*='OV'], [href*='FI=']";
          const candidateNodes = queryAllDeep(document, candidateSelector);
          const candidates = candidateNodes.slice(0, 30).map((node, index) => {
            const attrs = {};
            for (const attr of node.attributes || []) {
              const name = attr.name.toLowerCase();
              if (
                name.startsWith("data-") ||
                name === "id" ||
                name === "class" ||
                name === "aria-label" ||
                name === "href"
              ) {
                attrs[name] = attr.value;
              }
            }
            const dataset = { ...node.dataset };
            const textSample = toText(node).slice(0, 200);
            return {
              index,
              tagName: node.tagName,
              id: node.id || "",
              className: node.className || "",
              dataset,
              attributes: attrs,
              textSample
            };
          });
          return {
            url: location.href,
            title: document.title || "",
            selector: selectors.match,
            count: matchNodes.length,
            matches,
            candidateSelector,
            candidateCount: candidateNodes.length,
            candidates,
            iframeCount: document.querySelectorAll("iframe").length,
            bodyTextLength: document.body?.innerText?.length || 0
          };
        },
        { selectors, limit: domMatchLimit }
      );
      if (typeof onDomMatches === "function") {
        onDomMatches(payload);
      }
      domMatchIndexByFi = new Map();
      domMatchTextByFi = new Map();
      lastDomMatches = [];
      for (const match of payload.matches || []) {
        for (const fi of match.fiCandidates || []) {
          if (!domMatchIndexByFi.has(fi)) {
            domMatchIndexByFi.set(fi, match.index);
            domMatchTextByFi.set(fi, match.textSample || "");
          }
        }
        lastDomMatches.push({
          index: match.index,
          text: match.textSample || "",
          normalized: normalizeMatchText(match.textSample || ""),
          teams: (match.teamNames || []).map(normalizeMatchText).filter(Boolean)
        });
      }
    } catch (error) {
      log("warn", `DOM match capture failed: ${error.message || error}`);
    }
  }

  const domCaptureEnabled = domCapture && !forceNetworkOnly;

  await initOnce();
  if (!realtimeOnly) {
    await scrapeOnce();
    setInterval(scrapeOnce, intervalMs);
  } else {
    log("info", "Realtime-only mode enabled. Waiting for network updates.");
  }
  if (domCaptureEnabled) {
    await captureDomOnce();
    setInterval(captureDomOnce, domCaptureIntervalMs);
  }
  if (domCaptureEnabled && domMatchCapture) {
    await captureDomMatchesOnce();
    setInterval(captureDomMatchesOnce, domCaptureIntervalMs);
  }
}

async function humanize(page, log) {
  try {
    await page.mouse.move(200, 200);
    await page.waitForTimeout(300);
    await page.mouse.move(400, 300);
    await page.waitForTimeout(300);
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(600);
    await page.mouse.wheel(0, -300);
  } catch (error) {
    log("warn", `Humanize failed: ${error.message || error}`);
  }
}

async function setupNetworkCapture(page, log, debugDir, options) {
  const {
    maxBody,
    onSnapshot,
    wsOnly,
    logNetworkToFile = false,
    onRawWs,
    onRawXhr,
    onWsTeams,
    onWsUpdates
  } = options;
  const xhrLogPath = path.join(debugDir, "network-xhr.log");
  const wsLogPath = path.join(debugDir, "network-ws.log");
  if (logNetworkToFile) {
    await fs.promises.mkdir(debugDir, { recursive: true });
  }
  const appendLog = async (filePath, header, body) => {
    if (!logNetworkToFile) return;
    await fs.promises.appendFile(
      filePath,
      `\n---- ${new Date().toISOString()} ${header} ----\n${body}\n`
    );
  };

  const shouldCaptureXhr = !wsOnly || typeof onRawXhr === "function";
  if (shouldCaptureXhr) {
    page.on("response", async (response) => {
      try {
        const request = response.request();
        const resourceType = request.resourceType();
        if (resourceType !== "xhr" && resourceType !== "fetch") {
          return;
        }
        const headers = response.headers();
        const contentType = headers["content-type"] || "";
        if (!contentType.includes("json") && !contentType.includes("text")) {
          return;
        }
        let body = "";
        try {
          body = await response.text();
        } catch {
          return;
        }
        if (!body) {
          return;
        }
        if (body.length > maxBody) {
          body = body.slice(0, maxBody) + "\n...truncated";
        }
        await appendLog(xhrLogPath, `${request.url()} (${contentType})`, body);
        if (typeof onRawXhr === "function") {
          onRawXhr({ url: request.url(), payload: body });
        }
        catalogAddFromPayload(body, "xhr");
        if (!wsOnly) {
          const snapshot = extractFromNetworkPayload(body, {
            onCatalogUsed: (key, val) => catalogSetLabel(key, val, "xhr")
          });
          if (snapshot.length > 0) {
            onSnapshot(snapshot, Date.now());
            log("info", `Network snapshot parsed: ${snapshot.length}`);
          }
        }
      } catch (error) {
        log("warn", `Network capture error: ${error.message || error}`);
      }
    });
  }

  page.on("websocket", (ws) => {
    log("info", `PW WS connected: ${ws.url()}`);
    ws.on("framereceived", async (frame) => {
      if (!frame.payload || typeof frame.payload !== "string") {
        return;
      }
      log("info", `PW WS frame: ${frame.payload.length} bytes`);
      let payload = frame.payload;
      if (payload.length > maxBody) {
        payload = payload.slice(0, maxBody) + "\n...truncated";
      }
      await appendLog(wsLogPath, ws.url(), payload);
      if (typeof onRawWs === "function") {
        onRawWs({ url: ws.url(), payload });
      }
      if (typeof onWsTeams === "function") {
        const events = extractTeamsFromPayload(payload);
        if (events.length) {
          onWsTeams({ source: "ws", events });
        }
      }
      if (typeof onWsUpdates === "function") {
        const updates = extractWsUpdatesFromPayload(payload);
        if (updates.length) {
          onWsUpdates({ source: "ws", updates });
        }
      }
      catalogAddFromPayload(payload, "ws");
      const snapshot = extractFromNetworkPayload(payload, {
        onCatalogUsed: (key, val) => catalogSetLabel(key, val, "ws")
      });
      if (snapshot.length > 0) {
        onSnapshot(snapshot, Date.now());
        log("info", `WebSocket snapshot parsed: ${snapshot.length}`);
      }
    });
  });

  try {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Network.enable");
    if (shouldCaptureXhr) {
      cdp.on("Network.responseReceived", async (event) => {
        try {
          if (event.type !== "XHR" && event.type !== "Fetch") {
            return;
          }
          const response = event.response || {};
          const contentType = response.headers?.["content-type"] || "";
          if (!contentType.includes("json") && !contentType.includes("text")) {
            return;
          }
          const bodyResult = await cdp.send("Network.getResponseBody", {
            requestId: event.requestId
          });
          let body = bodyResult?.body || "";
          if (!body) return;
          if (body.length > maxBody) {
            body = body.slice(0, maxBody) + "\n...truncated";
          }
          await appendLog(xhrLogPath, `${response.url} (${contentType})`, body);
          if (typeof onRawXhr === "function") {
            onRawXhr({ url: response.url || "xhr", payload: body });
          }
          catalogAddFromPayload(body, "xhr");
          if (!wsOnly) {
            const snapshot = extractFromNetworkPayload(body, {
              onCatalogUsed: (key, val) => catalogSetLabel(key, val, "xhr")
            });
            if (snapshot.length > 0) {
              onSnapshot(snapshot, Date.now());
              log("info", `CDP network snapshot parsed: ${snapshot.length}`);
            }
          }
        } catch (error) {
          log("warn", `CDP response parse error: ${error.message || error}`);
        }
      });
    }

    cdp.on("Network.webSocketFrameReceived", async (event) => {
      try {
        const payloadData = event.response?.payloadData;
        if (payloadData && payloadData.length > 5000) {
          const naIdx = payloadData.indexOf("NA=");
          const naPreview = naIdx !== -1 ? payloadData.slice(naIdx, naIdx + 120) : "NO NA= FOUND";
          const msgTypeIdx = payloadData.indexOf("\u0001");
          const msgType = msgTypeIdx !== -1 ? payloadData.slice(msgTypeIdx + 1, msgTypeIdx + 5) : "?";
          log("info", `CDP WS frame: ${payloadData.length} bytes | msgType: ${msgType} | NA sample: ${JSON.stringify(naPreview)}`);
        } else {
          log("info", `CDP WS frame: ${payloadData ? payloadData.length + " bytes" : "empty"}`);
        }
        if (!payloadData || typeof payloadData !== "string") return;
        let payload = payloadData;
        if (payload.length > maxBody) {
          payload = payload.slice(0, maxBody) + "\n...truncated";
        }
        await appendLog(wsLogPath, event.response?.url || "ws", payload);
        if (typeof onRawWs === "function") {
          onRawWs({ url: event.response?.url || "ws", payload });
        }
        if (typeof onWsTeams === "function") {
          const events = extractTeamsFromPayload(payload);
          if (events.length) {
            onWsTeams({ source: "cdp", events });
          }
        }
        if (typeof onWsUpdates === "function") {
          const updates = extractWsUpdatesFromPayload(payload);
          if (updates.length) {
            onWsUpdates({ source: "cdp", updates });
          }
        }
        catalogAddFromPayload(payload, "ws");
        const snapshot = extractFromNetworkPayload(payload, {
          onCatalogUsed: (key, val) => catalogSetLabel(key, val, "ws")
        });
        if (snapshot.length > 0) {
          onSnapshot(snapshot, Date.now());
          log("info", `CDP websocket snapshot parsed: ${snapshot.length}`);
        }
      } catch (error) {
        log("warn", `CDP websocket parse error: ${error.message || error}`);
      }
    });
    log("info", "Network capture enabled (CDP + Playwright listeners).");
  } catch (error) {
    log("warn", `Network capture CDP init failed: ${error.message || error}`);
    log("info", "Network capture enabled (Playwright listeners only).");
  }
}

const networkState = {
  eventsByFi: new Map(),
  oddsByFi: new Map(),
  scoresByFi: new Map(),
  timeByFi: new Map(),
  selectionById: new Map(),
  suspendByFi: new Map(),
  sportByFi: new Map(),
  lastUpdateByFi: new Map(),
  lastValidOddsByFi: new Map(),
  oiByFi: new Map(),          // maps fixture FI -> market OI (for cross-lookup of odds)
  ftSelectionsByOi: new Map(), // maps OI -> Set of confirmed Fulltime Result selection IDs
  nonFtSelections: new Set()   // selection IDs from non-FT markets in F|CL (blacklist)
};

let lastStaleRemoval = null;

const STALE_FIXTURE_MS = Number(
  process.env.STALE_FIXTURE_MS || 15 * 60 * 1000
);

function markFixtureTouched(fi, now) {
  if (!fi) return;
  networkState.lastUpdateByFi.set(fi, now);
}

function removeFixtureFromState(fi) {
  // Find associated OI before deleting oiByFi
  const associatedOi = networkState.oiByFi.get(fi);
  networkState.eventsByFi.delete(fi);
  networkState.oddsByFi.delete(fi);
  networkState.scoresByFi.delete(fi);
  networkState.timeByFi.delete(fi);
  networkState.suspendByFi.delete(fi);
  networkState.sportByFi.delete(fi);
  networkState.lastUpdateByFi.delete(fi);
  networkState.lastValidOddsByFi.delete(fi);
  if (associatedOi) {
    networkState.oddsByFi.delete(associatedOi);
    networkState.lastValidOddsByFi.delete(associatedOi);
    networkState.ftSelectionsByOi.delete(associatedOi);
  }
  for (const [selectionId, selection] of networkState.selectionById.entries()) {
    if (selection?.fi === fi || selection?.fi === associatedOi) {
      networkState.selectionById.delete(selectionId);
    }
  }
  for (const [key, val] of networkState.oiByFi.entries()) {
    if (key === fi || val === fi) {
      networkState.oiByFi.delete(key);
    }
  }
}

function cleanupStaleFixtures(now) {
  const stale = [];
  for (const [fi, lastAt] of networkState.lastUpdateByFi.entries()) {
    if (now - lastAt > STALE_FIXTURE_MS) {
      stale.push(fi);
    }
  }
  if (!stale.length) return 0;
  for (const fi of stale) {
    removeFixtureFromState(fi);
  }
  return stale.length;
}

function parseBet365Odds(value) {
  if (!value) return null;
  if (value.includes("/")) {
    const [num, den] = value.split("/");
    const n = Number.parseFloat(num);
    const d = Number.parseFloat(den);
    if (Number.isFinite(n) && Number.isFinite(d) && d !== 0) {
      return Number((n / d + 1).toFixed(2));
    }
    return null;
  }
  return parseOdd(value);
}

function extractFixtureId(value) {
  if (!value) return "";
  const match = value.match(/OV(\d+)/);
  return match ? match[1] : "";
}

function extractSelectionId(value) {
  if (!value) return "";
  const match = value.match(/OV\d+-(\d+)_/);
  return match ? match[1] : "";
}

function ensureOddsMap(fi) {
  if (!networkState.oddsByFi.has(fi)) {
    networkState.oddsByFi.set(fi, new Map());
  }
  return networkState.oddsByFi.get(fi);
}

function splitEventName(name) {
  if (!name) return [];
  const separators = [" v ", " vs ", " @ ", " - "];
  for (const separator of separators) {
    if (name.includes(separator)) {
      return name.split(separator).map((part) => part.trim()).filter(Boolean);
    }
  }
  return [name.trim()].filter(Boolean);
}

function isDrawName(name) {
  const normalized = name.toLowerCase();
  return (
    normalized.includes("nereseno") ||
    normalized.includes("nereseno") ||
    normalized.includes("draw") ||
    normalized === "x"
  );
}

function isBasicOutcomeName(name) {
  if (!name) return false;
  const normalized = name.toLowerCase().trim();
  return (
    normalized === "1" ||
    normalized === "2" ||
    normalized === "x" ||
    normalized === "home" ||
    normalized === "away" ||
    normalized === "draw"
  );
}

function buildOdds(selections, teams) {
  if (!selections || selections.size === 0) return [];
  const [teamA, teamB] = teams.map((team) => team.toLowerCase());
  const picks = Array.from(selections.values());
  const matchesTeam = (name, team) =>
    name && team && name.toLowerCase().includes(team);
  const filtered = picks.filter(
    (item) =>
      matchesTeam(item.name, teamA) ||
      matchesTeam(item.name, teamB) ||
      isDrawName(item.name) ||
      isBasicOutcomeName(item.name)
  );
  const sorted = filtered
    .sort((a, b) => a.order - b.order)
    .map((item) => item.odd)
    .filter((value) => Number.isFinite(value));
  if (sorted.length < 3) {
    const fallback = picks
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((item) => item.odd)
      .filter((value) => Number.isFinite(value));
    return fallback.length >= 3 ? fallback.slice(0, 3) : null;
  }
  return sorted.slice(0, 3);
}

function parseFields(body) {
  const tokens = body.split(";").filter(Boolean);
  const kind = tokens[0] && !tokens[0].includes("=") ? tokens[0] : "";
  const fields = {};
  for (const token of tokens) {
    const index = token.indexOf("=");
    if (index === -1) continue;
    const key = token.slice(0, index);
    const value = token.slice(index + 1);
    fields[key] = value;
  }
  return { kind, fields };
}

/** Catalog: one entry per (pattern, source). Key = "pattern|source". */
const catalogState = {
  entriesByPatternSource: new Map(),
  lastUpdated: null
};

function extractAllValuesFromPayload(payload) {
  const values = [];
  const seen = new Set();
  const add = (value, pattern) => {
    if (value === undefined || value === null || String(value).trim() === "") return;
    const key = `${pattern}\t${String(value)}`;
    if (seen.has(key)) return;
    seen.add(key);
    values.push({ value: String(value).trim(), pattern, label: undefined });
  };

  const segments = payload
    .replace(/\r/g, "")
    .split("\n")
    .flatMap((line) => line.split("\u0008"));
  for (const raw of segments) {
    const cleaned = raw.replace(/^[\u0000-\u001f]+/g, "").trim();
    if (!cleaned) continue;
    const markerIndex = cleaned.indexOf("\u0001");
    if (markerIndex === -1) continue;
    const prefix = cleaned.slice(0, markerIndex);
    const remainder = cleaned.slice(markerIndex + 1);
    const firstPipe = remainder.indexOf("|");
    if (firstPipe === -1) continue;
    const fieldBodyRaw = remainder.slice(firstPipe + 1);
    const lastPipe = fieldBodyRaw.lastIndexOf("|");
    const fieldBody = lastPipe === -1 ? fieldBodyRaw : fieldBodyRaw.slice(0, lastPipe);
    const { kind, fields } = parseFields(fieldBody);
    if (kind) add(kind, "kind");
    for (const [k, v] of Object.entries(fields)) {
      if (v != null && v !== "") add(v, k);
    }
    const prefixFi = extractFixtureId(prefix);
    if (prefixFi) add(prefixFi, "prefixFi");
  }
  const nMatch = payload.match(/N:\d+/g);
  if (nMatch) {
    nMatch.forEach((m) => add(m, "N:nnn"));
  }
  if (payload.includes("\u0009")) add("\\u0009", "ctrl");
  if (payload.includes("\u0007")) add("\\u0007", "ctrl");
  return values;
}

/** Za prikaz u katalogu: šta koristimo tu vrednost u finalnom ishodu (čitljivo ime). */
const CATALOG_LABEL_NAMES = {
  NA: "Ime meča",
  CT: "Takmičenje",
  CL: "Sport (ID)",
  TA: "Tag",
  FI: "Fixture ID",
  OI: "Fixture ID (OI)",
  SS: "Rezultat",
  TU: "Vreme",
  TM: "Vreme (minuta)",
  SU: "Suspend",
  OD: "Kvota",
  OR: "Redosled kvote",
  IT: "Selekcija (prefix)",
  ID: "ID selekcije"
};

/** Add all (pattern, value) from payload to catalog; one entry per (pattern, source), first example kept. */
function catalogAddFromPayload(payload, source) {
  const extracted = extractAllValuesFromPayload(payload);
  for (const { pattern, value } of extracted) {
    const key = pattern + "|" + source;
    if (!catalogState.entriesByPatternSource.has(key)) {
      catalogState.entriesByPatternSource.set(key, {
        pattern,
        source,
        exampleValue: value,
        label: undefined
      });
    }
  }
  catalogState.lastUpdated = new Date().toISOString();
}

function catalogSetLabel(pattern, value, source) {
  const key = pattern + "|" + source;
  const entry = catalogState.entriesByPatternSource.get(key);
  if (!entry) return;
  if (entry.label === undefined) {
    entry.label = CATALOG_LABEL_NAMES[pattern] ?? pattern;
  }
}

export function getCatalog() {
  const entries = [];
  for (const entry of catalogState.entriesByPatternSource.values()) {
    entries.push({
      pattern: entry.pattern,
      source: entry.source,
      exampleValue: entry.exampleValue,
      label: entry.label
    });
  }
  entries.sort((a, b) => (a.pattern + "|" + a.source).localeCompare(b.pattern + "|" + b.source));
  return { entries, lastUpdated: catalogState.lastUpdated };
}

const CATALOG_SAVE_DIR = process.env.CATALOG_SAVE_DIR || path.join(process.cwd(), "catalog-data");

export function saveCatalogToFile() {
  try {
    if (!fs.existsSync(CATALOG_SAVE_DIR)) fs.mkdirSync(CATALOG_SAVE_DIR, { recursive: true });
    const filePath = path.join(CATALOG_SAVE_DIR, "catalog.json");
    fs.writeFileSync(filePath, JSON.stringify(getCatalog(), null, 2), "utf8");
    return filePath;
  } catch (err) {
    return null;
  }
}

function parseBet365Payload(payload, options) {
  const onCatalogUsed = options?.onCatalogUsed;
  const segments = payload
    .replace(/\r/g, "")
    .split("\n")
    .flatMap((line) => line.split("\u0008"));

  const now = Date.now();
  let touched = false;
  for (const raw of segments) {
    const cleaned = raw.replace(/^[\u0000-\u001f]+/g, "").trim();
    if (!cleaned) continue;
    const markerIndex = cleaned.indexOf("\u0001");
    if (markerIndex === -1) continue;
    const prefix = cleaned.slice(0, markerIndex);
    const prefixFi = extractFixtureId(prefix);
    const prefixSelectionId = extractSelectionId(prefix);
    const remainder = cleaned.slice(markerIndex + 1);
    const firstPipe = remainder.indexOf("|");
    if (firstPipe === -1) continue;
    const messageType = remainder.slice(0, firstPipe);
    const fieldBodyRaw = remainder.slice(firstPipe + 1);
    const lastPipe = fieldBodyRaw.lastIndexOf("|");
    const fieldBody =
      lastPipe === -1 ? fieldBodyRaw : fieldBodyRaw.slice(0, lastPipe);
    const { kind, fields } = parseFields(fieldBody);
    const fi =
      fields.FI || prefixFi || extractFixtureId(fields.IT) || fields.OI || "";

    if ((messageType === "I" || messageType === "F") && kind === "EV" && fields.NA && fi) {
      onCatalogUsed?.("NA", fields.NA, { fi });
      onCatalogUsed?.("CT", fields.CT, { fi });
      onCatalogUsed?.("CL", fields.CL, { fi });
      onCatalogUsed?.("TA", fields.TA || fields.tag, { fi });
      onCatalogUsed?.("FI", fi, { fi });
      if (fields.OI) onCatalogUsed?.("OI", fields.OI, { fi });
      const event = {
        name: fields.NA,
        competition: fields.CT || "",
        sportId: fields.CL ? Number.parseInt(fields.CL, 10) : null,
        tag: fields.TA || fields.tag || ""
      };
      networkState.eventsByFi.set(fi, event);
      markFixtureTouched(fi, now);
      if (fields.OI) {
        networkState.oiByFi.set(fi, fields.OI);
        networkState.oiByFi.set(fields.OI, fi);
      }
      if (event.sportId !== null) {
        networkState.sportByFi.set(fi, event.sportId);
      }
      if (fields.SS) networkState.scoresByFi.set(fi, fields.SS);
      if (fields.TM) networkState.timeByFi.set(fi, fields.TM);
      else if (fields.TU) networkState.timeByFi.set(fi, fields.TU);
      if (fields.SU) networkState.suspendByFi.set(fi, fields.SU === "1");
      touched = true;
      continue;
    }

    // Handle F|CL messages: nested CT/EV sub-records separated by |
    if (messageType === "F" && kind === "CL") {
      let currentCompetition = fields.NA || "";
      let currentFi = "";
      let currentMarketName = "";
      let currentMarketId = "";
      const subRecords = fieldBodyRaw.split("|").filter(Boolean);
      // Diagnostic: log first 5 F|CL messages to fcl-debug.log
      if (!globalThis._fclDebugCount) globalThis._fclDebugCount = 0;
      const doFclLog = globalThis._fclDebugCount < 5;
      if (doFclLog) {
        globalThis._fclDebugCount++;
        const logLines = [`\n=== F|CL #${globalThis._fclDebugCount} @ ${new Date().toISOString()} ===`];
        for (const subRec of subRecords) {
          const { kind: sk2, fields: sf2 } = parseFields(subRec);
          if (["CT","EV","PA","MA"].includes(sk2)) {
            const allFields = Object.entries(sf2).map(([k,v]) => `${k}=${v}`).join(" | ");
            logLines.push(`  ${sk2}: ${allFields}`);
          }
        }
        fs.appendFileSync(path.join(process.cwd(), "fcl-debug.log"), logLines.join("\n") + "\n");
      }
      for (const subRec of subRecords) {
        const { kind: sk, fields: sf } = parseFields(subRec);
        if (sk === "CT" && sf.NA) {
          currentCompetition = sf.NA;
        }
        if (sk === "MA") {
          currentMarketName = sf.NA || sf.MN || currentMarketName;
          currentMarketId = sf.MA || sf.ID || "";
        }
        if (sk === "EV" && sf.NA) {
          currentMarketId = ""; // reset per match
          currentFi = sf.FI || extractFixtureId(sf.IT) || sf.OI || "";
          if (!currentFi) continue;
          const ev = {
            name: sf.NA,
            competition: sf.CT || currentCompetition,
            sportId: sf.CL ? Number.parseInt(sf.CL, 10) : null,
            tag: sf.TA || sf.tag || ""
          };
          networkState.eventsByFi.set(currentFi, ev);
          markFixtureTouched(currentFi, now);
          if (sf.OI) {
            networkState.oiByFi.set(currentFi, sf.OI);
            networkState.oiByFi.set(sf.OI, currentFi);
          }
          if (ev.sportId !== null) networkState.sportByFi.set(currentFi, ev.sportId);
          if (sf.SS) networkState.scoresByFi.set(currentFi, sf.SS);
          if (sf.TM) networkState.timeByFi.set(currentFi, sf.TM);
          else if (sf.TU) networkState.timeByFi.set(currentFi, sf.TU);
          if (sf.SU) networkState.suspendByFi.set(currentFi, sf.SU === "1");
          touched = true;
        }
        if (sk === "PA" && currentFi) {
          const selectionId = sf.ID || extractSelectionId(sf.IT || "");
          const isFtMarket = currentMarketId === "1777";
          if (!isFtMarket) {
            // Non-FT market (7th Goal, HT Result, etc.) — blacklist these selection IDs
            // so I|PA updates for them are ignored.
            if (selectionId) networkState.nonFtSelections.add(selectionId);
          } else if (sf.OD) {
            const odd = parseBet365Odds(sf.OD);
            if (odd !== null) {
              const order = Number.parseInt(sf.OR || "0", 10);
              const basicNames = ["1", "x", "2"];
              const selName = sf.NA || basicNames[order] || selectionId;
              // sf.FI in PA = OI (market FI). Store under OI so I|PA hits the same entry.
              const oddsKeyFi = sf.FI || currentFi;
              if (selectionId) {
                networkState.selectionById.set(selectionId, { fi: oddsKeyFi, name: selName, order });
                // Track FT selection IDs for whitelist
                if (!networkState.ftSelectionsByOi.has(oddsKeyFi)) {
                  networkState.ftSelectionsByOi.set(oddsKeyFi, new Set());
                }
                networkState.ftSelectionsByOi.get(oddsKeyFi).add(selectionId);
              }
              const oddsMap = ensureOddsMap(oddsKeyFi);
              const oddsKey = selectionId || selName;
              if (oddsKey) {
                oddsMap.set(oddsKey, { odd, order, name: selName });
                networkState.suspendByFi.set(currentFi, false);
              }
              touched = true;
            }
          }
        }
      }
      continue;
    }

    if (fields.SS && fi) {
      onCatalogUsed?.("SS", fields.SS, { fi });
      networkState.scoresByFi.set(fi, fields.SS);
      markFixtureTouched(fi, now);
      touched = true;
    }

    if (fields.TM && fi) {
      onCatalogUsed?.("TM", fields.TM, { fi });
      networkState.timeByFi.set(fi, fields.TM);
      markFixtureTouched(fi, now);
      touched = true;
    } else if (fields.TU && fi) {
      onCatalogUsed?.("TU", fields.TU, { fi });
      networkState.timeByFi.set(fi, fields.TU);
      markFixtureTouched(fi, now);
      touched = true;
    }

    if (fields.SU && fi) {
      onCatalogUsed?.("SU", fields.SU, { fi });
      networkState.suspendByFi.set(fi, fields.SU === "1");
      markFixtureTouched(fi, now);
      touched = true;
    }

    if (messageType === "I" && kind === "PA" && fields.OD && fi) {
      // Diagnostic: log I|PA for first 60 seconds
      // Extended trace: log ALL I|PA for tracked match for 5 minutes
      if (!globalThis._traceStart) globalThis._traceStart = Date.now();
      if (Date.now() - globalThis._traceStart < 300000) {
        const line = `${new Date().toISOString()} IPA fi=${fi} OD=${fields.OD} OR=${fields.OR||""} ID=${fields.ID||""} IT=${fields.IT||""} NA=${fields.NA||""}\n`;
        fs.appendFileSync(path.join(process.cwd(), "trace-all.log"), line);
      }
      const odd = parseBet365Odds(fields.OD);
      if (odd !== null) {
        const selectionId = fields.ID || extractSelectionId(fields.IT);
        const order = Number.parseInt(fields.OR || "0", 10);
        const itField = fields.IT || "";
        const isOves = itField.startsWith("OVES");

        // OVES = eSoccer Fulltime Result, carries real NA names.
        // Register its selection IDs in ftSelectionsByOi (whitelist).
        if (isOves && selectionId && order <= 2) {
          if (!networkState.ftSelectionsByOi.has(fi)) {
            networkState.ftSelectionsByOi.set(fi, new Set());
          }
          networkState.ftSelectionsByOi.get(fi).add(selectionId);
        }

        // Only accept if selection ID is in the confirmed FT whitelist.
        // No whitelist = no odds shown (wait for OVES or F|CL MA=1777).
        const knownFtSels = networkState.ftSelectionsByOi.get(fi);
        const isConfirmedFt = knownFtSels && knownFtSels.size > 0 && selectionId && knownFtSels.has(selectionId);
        if (isConfirmedFt) {
          const basicNames = ["1", "x", "2"];
          const selName = fields.NA || basicNames[order] || selectionId || String(order);
          if (selectionId) {
            networkState.selectionById.set(selectionId, { fi, name: selName, order });
          }
          const oddsMap = ensureOddsMap(fi);
          const oddsKey = selectionId || selName;
          oddsMap.set(oddsKey, { odd, order, name: selName });
          markFixtureTouched(fi, now);
          networkState.suspendByFi.set(fi, false);
          touched = true;
        }
      }
    }

    if (messageType === "U" && fields.OD && (fi || prefixSelectionId)) {
      const odd = parseBet365Odds(fields.OD);
      if (odd !== null) {
        onCatalogUsed?.("OD", fields.OD, { fi });
        onCatalogUsed?.("ID", fields.ID, { fi });
        const selectionId = prefixSelectionId || fields.ID || "";
        // Skip non-FT selections identified in F|CL
        if (selectionId && networkState.nonFtSelections.has(selectionId)) {
          continue;
        }
        const selectionInfo = selectionId
          ? networkState.selectionById.get(selectionId)
          : null;
        // Prefer selectionInfo.fi (canonical EV fixture ID) over raw prefix fi (market ID)
        const fixtureId = selectionInfo?.fi || fi || "";
        if (fixtureId) {
          const oddsMap = ensureOddsMap(fixtureId);
          const order = selectionInfo?.order ?? 999;
          const name = selectionInfo?.name || selectionId;
          const oddsKey = selectionId || name;
          oddsMap.set(oddsKey, { odd, order, name });
          markFixtureTouched(fixtureId, now);
          networkState.suspendByFi.set(fixtureId, false);
          touched = true;
        }
      }
    }
  }

  const removedStale = cleanupStaleFixtures(now);
  if (removedStale > 0) {
    touched = true;
    lastStaleRemoval = { count: removedStale, at: now };
  }

  if (!touched) {
    return [];
  }

  const snapshot = [];
  for (const [fi, event] of networkState.eventsByFi.entries()) {
    const teams = splitEventName(event.name);
    if (teams.length < 2) continue;
    if (!isEsoccerMatch({ competition: event.competition, teams, name: event.name, tag: event.tag })) {
      continue;
    }
    const oiFi = networkState.oiByFi.get(fi);
    const selections = networkState.oddsByFi.get(fi) || (oiFi ? networkState.oddsByFi.get(oiFi) : null);
    const nextOdds = buildOdds(selections, teams);
    const score = networkState.scoresByFi.get(fi) || "";
    // Reject "garbage" odds where all three values are identical (e.g. [1.91, 1.91, 1.91])
    const isValidOdds = (arr) =>
      arr && arr.length >= 3 && !(arr[0] === arr[1] && arr[1] === arr[2]);
    // Cache odds tied to score: if score changed, stale cached odds are discarded
    let odds;
    if (nextOdds && nextOdds.length === 3 && isValidOdds(nextOdds)) {
      networkState.lastValidOddsByFi.set(fi, { odds: nextOdds, score });
      odds = nextOdds;
    } else {
      const cached = networkState.lastValidOddsByFi.get(fi);
      odds = (cached && cached.score === score) ? cached.odds : [];
    }
    const rawTime = String(networkState.timeByFi.get(fi) || "").trim();
    let time = "";
    if (/^\d{1,3}$/.test(rawTime)) {
      time = `${rawTime}'`;
    } else if (rawTime && !/^\d{5,}$/.test(rawTime)) {
      time = rawTime;
    }
    const suspend = networkState.suspendByFi.get(fi) || false;
    const lastUpdate = networkState.lastUpdateByFi.get(fi) || 0;
    snapshot.push({
      id: makeMatchId({
        teams,
        time,
        competition: event.competition || "",
        fixtureId: fi
      }),
      teams,
      time,
      score,
      odds,
      competition: event.competition || "",
      suspend,
      sportId: event.sportId,
      fixtureId: fi,
      lastUpdate
    });
  }

  return snapshot;
}

function extractTeamsFromPayload(payload) {
  const segments = payload
    .replace(/\r/g, "")
    .split("\n")
    .flatMap((line) => line.split("\u0008"));
  const events = [];
  for (const raw of segments) {
    const cleaned = raw.replace(/^[\u0000-\u001f]+/g, "").trim();
    if (!cleaned) continue;
    const markerIndex = cleaned.indexOf("\u0001");
    if (markerIndex === -1) continue;
    const prefix = cleaned.slice(0, markerIndex);
    const remainder = cleaned.slice(markerIndex + 1);
    const firstPipe = remainder.indexOf("|");
    if (firstPipe === -1) continue;
    const messageType = remainder.slice(0, firstPipe);
    const fieldBodyRaw = remainder.slice(firstPipe + 1);
    const lastPipe = fieldBodyRaw.lastIndexOf("|");
    const fieldBody =
      lastPipe === -1 ? fieldBodyRaw : fieldBodyRaw.slice(0, lastPipe);
    const { kind, fields } = parseFields(fieldBody);
    if (messageType !== "I" || kind !== "EV" || !fields.NA) {
      continue;
    }
    const fi =
      fields.FI || extractFixtureId(prefix) || extractFixtureId(fields.IT) || "";
    const teams = splitEventName(fields.NA);
    if (teams.length < 2) continue;
    const tag = fields.TA || fields.tag || "";
    if (isEsoccerMatch({ competition: fields.CT || "", teams, name: fields.NA, tag })) continue;
    events.push({
      fixtureId: fi,
      competition: fields.CT || "",
      teams
    });
  }
  return events;
}

function extractWsUpdatesFromPayload(payload) {
  const segments = payload
    .replace(/\r/g, "")
    .split("\n")
    .flatMap((line) => line.split("\u0008"));
  const updates = [];
  for (const raw of segments) {
    const cleaned = raw.replace(/^[\u0000-\u001f]+/g, "").trim();
    if (!cleaned) continue;
    const markerIndex = cleaned.indexOf("\u0001");
    if (markerIndex === -1) continue;
    const prefix = cleaned.slice(0, markerIndex);
    const prefixFi = extractFixtureId(prefix);
    const remainder = cleaned.slice(markerIndex + 1);
    const firstPipe = remainder.indexOf("|");
    if (firstPipe === -1) continue;
    const messageType = remainder.slice(0, firstPipe);
    const fieldBodyRaw = remainder.slice(firstPipe + 1);
    const lastPipe = fieldBodyRaw.lastIndexOf("|");
    const fieldBody =
      lastPipe === -1 ? fieldBodyRaw : fieldBodyRaw.slice(0, lastPipe);
    const { kind, fields } = parseFields(fieldBody);
    const fi =
      fields.FI || prefixFi || extractFixtureId(fields.IT) || fields.OI || "";
    const relevant = {};
    for (const key of ["OD", "SS", "TU", "SU", "OR", "TS", "TM", "HA", "HD", "UC", "NA"]) {
      if (fields[key]) {
        relevant[key] = fields[key];
      }
    }
    if (Object.keys(relevant).length === 0) continue;
    updates.push({
      messageType,
      kind,
      fixtureId: fi,
      fields: relevant
    });
  }
  return updates;
}

function extractFromNetworkPayload(payload, options) {
  let data = null;
  try {
    data = JSON.parse(payload);
  } catch {
    return parseBet365Payload(payload, options);
  }
  const strings = [];
  collectStringsFromJson(data, strings, 20000);
  if (strings.length === 0) {
    return parseBet365Payload(payload, options);
  }
  const bodyText = strings.join("\n");
  return parseFromBodyText(bodyText).map((item) => ({
    id: makeMatchId(item),
    teams: item.teams,
    time: item.time,
    score: item.score,
    odds: item.odds,
    competition: item.competition
  }));
}

function collectStringsFromJson(value, out, limit) {
  if (out.length >= limit) return;
  if (typeof value === "string") {
    const normalized = value.trim();
    if (normalized) {
      out.push(normalized);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectStringsFromJson(item, out, limit);
      if (out.length >= limit) return;
    }
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) {
      collectStringsFromJson(item, out, limit);
      if (out.length >= limit) return;
    }
  }
}

async function handleConsent(page, log) {
  const selectors = [
    "button:has-text('Prihvati')",
    "button:has-text('Prihvatam')",
    "button:has-text('Slažem se')",
    "button:has-text('Accept')",
    "button:has-text('I Agree')",
    "button:has-text('OK')",
    "button:has-text('U redu')"
  ];
  try {
    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      if (await locator.isVisible().catch(() => false)) {
        await locator.click({ timeout: 2000 }).catch(() => null);
        log("info", `Clicked consent: ${selector}`);
        await page.waitForTimeout(1000);
        break;
      }
    }
  } catch (error) {
    log("warn", `Consent handler failed: ${error.message || error}`);
  }
}

async function ensureInPlay(page, url, log) {
  if (!url.includes("#/IP/")) {
    return;
  }
  try {
    if (!page.url().includes("#/IP/")) {
      await page.goto("https://www.bet365.rs/", {
        waitUntil: "domcontentloaded",
        timeout: 45000
      });
      await page.waitForTimeout(2000);
    }
    if (!page.url().includes("#/IP/")) {
      const link = page.locator("a:has-text('Uživo'), a:has-text('Uzivo'), a:has-text('In-Play'), a:has-text('Live')").first();
      if (await link.isVisible().catch(() => false)) {
        await link.click({ timeout: 3000 }).catch(() => null);
        log("info", "Clicked In-Play link.");
        await page.waitForTimeout(2000);
      }
    }
    if (page.url() !== url && !page.url().includes(url.replace("https://www.bet365.rs/", ""))) {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
      log("info", `Navigated to ${url}`);
      await page.waitForTimeout(2000);
    }
  } catch (error) {
    log("warn", `Ensure in-play failed: ${error.message || error}`);
  }
}
