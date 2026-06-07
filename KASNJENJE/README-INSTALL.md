# KASNJENJE

Ovaj paket sadrzi:
- `bwin-live.mjs` (3200)
- `admiral-football.mjs` (3201)
- `compare-3202.mjs` (3202)

Napomena: glavne `.mjs` skripte su prekopirane bez izmene logike.

## 1) Instalacija (prvi put)

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

## 2) Pokretanje

```powershell
powershell -ExecutionPolicy Bypass -File .\start.ps1
```

## 3) Gasenje

```powershell
powershell -ExecutionPolicy Bypass -File .\stop.ps1
```

## Preduslovi

- Windows + PowerShell
- Node.js instaliran i dostupan kroz `node` komandu
- Internet konekcija
- Google Chrome (za `bwin-live.mjs`, jer koristi `puppeteer-core`)
