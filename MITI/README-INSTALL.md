# MITI

Skup servisa za prikupljanje kvota i surebet/arbitražu. Pokreće 6 servisa i otvara
sve dashboard stranice u JEDNOM zasebnom browser prozoru (profil `miti-ui`).

Servisi:
- `4001` - `esoccer-skupljac/server.js` (bet365 eSoccer, koristi Playwright)
- `3000` - `admiral-web.mjs` (Admiral, koristi sistemski Chrome)
- `3007` - `esoccer-1x2.mjs`
- `3008` - `sve-surebets.mjs`
- `4003` - `surebets-4003.mjs`
- `4005` - `surebets-4005.mjs`

## Preduslovi

- Windows 10/11 + PowerShell
- Node.js (preporuka 18+). Provera: `node -v`
- Google Chrome (potreban za `admiral-web` i za UI prozor; ako nema Chrome-a,
  koristi se Edge / podrazumevani browser)

## 1) Skidanje sa gita

```powershell
git clone https://github.com/genije1234-debug/instalacije.git
cd instalacije\MITI
```

## 2) Instalacija

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

Skripta radi:
- `npm install` u MITI root (puppeteer-core za admiral-web)
- `npm install` u `esoccer-skupljac`
- `npx playwright install chromium` (OBAVEZNO za servis 4001)

Pri prvom pokretanju Windows Firewall može tražiti dozvolu za Chromium/headless
browser - klikni "Allow access".

## 3) Pokretanje

Dupli klik na `POKRENI-MITI.bat` (traži admin / UAC potvrdu) ili:

```powershell
powershell -ExecutionPolicy Bypass -File .\start.ps1
```

`start.ps1` prvo očisti sve staro (`stop.ps1`), sačeka da se portovi oslobode,
pokrene svih 6 servisa redom i sačeka da svaki postane dostupan, pa otvori sve
stranice u jednom browser prozoru.

## 4) Gašenje

Dupli klik na `STOP-MITI.bat` ili:

```powershell
powershell -ExecutionPolicy Bypass -File .\stop.ps1
```

Gasi sve node servise (zajedno sa njihovim Chrome/Playwright procesima) i zatvara
MITI UI prozor (profil `miti-ui`). Ne dira tvoj običan browser.

NAPOMENA: Admiral (`localhost:3000`) ume da otvori i svoj sopstveni prozor u tvom
običnom browseru - taj se ne zatvara automatski.

## Napomene

- Ako `4001` prikazuje "Mečeva 0", najčešće znači da trenutno nema eSoccer mečeva
  na bet365 - to je očekivano, servis radi.
- Lokalni podaci (`node_modules`, `miti-ui`, Playwright `profile`, istorije opklada,
  logovi) se NE šalju na git (vidi `.gitignore`); prave se lokalno pri instalaciji/radu.
