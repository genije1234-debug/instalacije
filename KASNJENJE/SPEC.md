# KASNJENJE - SPECIFIKACIJA (START / STOP)

Ovaj dokument definise obavezno ponasanje za pokretanje i gasenje KASNJENJE stack-a.

## 1) Scope

KASNJENJE stack cine 3 servisa:

- `bwin-live.mjs` na portu `3200`
- `admiral-football.mjs` na portu `3201`
- `compare-3202.mjs` na portu `3202`

Skripte:

- `KASNJENJE/start.ps1`
- `KASNJENJE/stop.ps1`

## 2) START - obavezna pravila

`start.ps1` mora da uradi sledece:

1. Za svaki servis proveri da li je vec podignut:
   - proces postoji i
   - health endpoint vraca odgovor.
2. Ako servis nije podignut:
   - pokrene `node <skripta>`
   - saceka da health endpoint postane dostupan (timeout do 50s).
3. Ako je endpoint gore, a process za trazenu skriptu nije pronadjen:
   - prekida start sa greskom (port zauzet necim drugim).
4. Na kraju upisuje `.pids.json` sa mapom `skripta -> pid`.
5. Otvara browser tabove ovim redosledom:
   - `http://localhost:3201/`
   - `http://localhost:3202/`
   - `http://localhost:3200/`

Health endpointi:

- `3200` -> `http://localhost:3200/data`
- `3201` -> `http://localhost:3201/api`
- `3202` -> `http://localhost:3202/`

## 3) STOP - obavezna pravila

`stop.ps1` mora da uradi sledece:

1. Ako postoji `.pids.json`, pokusava gasenje po tracked PID-ovima.
2. Radi fallback gasenje po nazivu skripte (`node.exe` command line match):
   - `bwin-live.mjs`
   - `admiral-football.mjs`
   - `compare-3202.mjs`
3. Brise `.pids.json`.
4. Verifikuje da portovi `3200`, `3201`, `3202` vise ne slusaju.
5. Ispisuje status (ok/warn) po portu i ukupno ubijenih procesa.

## 4) Ocekivani rezultat

Posle uspesnog `start`:

- sva 3 endpointa su dostupna,
- `.pids.json` postoji i sadrzi pid-eve,
- otvoreni su lokalni tabovi za 3201/3202/3200.

Posle uspesnog `stop`:

- nijedan od 3 servisa ne radi,
- `.pids.json` ne postoji,
- portovi 3200/3201/3202 su free.

## 5) Poznato ponasanje browser-a

`stop.ps1` gasi `node` procese. Ako je browser tab ostao otvoren, to nije aktivan servis.
Tab/prozor se tada zatvara rucno, osim ako se eksplicitno ne uvede gasenje browser procesa.

## 6) Operativne komande

Pokretanje:

```powershell
powershell -ExecutionPolicy Bypass -File .\KASNJENJE\start.ps1
```

Gasenje:

```powershell
powershell -ExecutionPolicy Bypass -File .\KASNJENJE\stop.ps1
```
