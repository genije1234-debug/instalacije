# KASNJENJE

Tri servisa za praćenje uživo (Bwin + Admiral) i poređenje kašnjenja gola:

- `bwin-live.mjs` → port `3200` (Bwin live, hvatanje gola preko WebSocket-a)
- `admiral-football.mjs` → port `3201` (Admiral live)
- `compare-3202.mjs` → port `3202` (poređenje + Telegram alert)

## Preduslovi

- **Windows 10/11** + PowerShell
- **Node.js 18+** (proveri sa `node -v`) — https://nodejs.org
- **Google Chrome** (instaliran normalno; `bwin-live.mjs` i `admiral-football.mjs` ga koriste preko `puppeteer-core`)
- Internet konekcija

## 1) Skidanje sa gita

```powershell
git clone https://github.com/genije1234-debug/instalacije.git
cd instalacije\KASNJENJE
```

## 2) Instalacija (prvi put)

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

Ovo proverava Node i radi `npm install` (skida `puppeteer-core`).

## 3) Pokretanje

```powershell
powershell -ExecutionPolicy Bypass -File .\start.ps1
```

ili dupli klik na `POKRENI-KASNJENJE.bat`.

Šta `start` radi:
1. Traži admin (UAC) — klikni **Da/Yes**.
2. Prvo očisti stare procese i sačeka da se portovi oslobode.
3. Pokrene sva 3 servisa redom i sačeka da svaki proradi.
4. Otvori **jedan prozor sa 3 taba** (3200, 3201, 3202).

## 4) Gašenje

```powershell
powershell -ExecutionPolicy Bypass -File .\stop.ps1
```

ili dupli klik na `STOP-KASNJENJE.bat`.

`stop` gasi sve servise, prozor i automation Chrome — ne dira tvoj obični browser.

## Adrese

- http://localhost:3200/ — Bwin live
- http://localhost:3201/api — Admiral
- http://localhost:3202/ — poređenje

## Telegram (opciono)

`compare-3202.mjs` šalje alert na Telegram. Podesi svoj bot token i chat ID
u tom fajlu (sekcija `// ── Telegram ──` na vrhu) ili ostavi prazno ako ti ne treba.
