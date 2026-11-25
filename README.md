# Raleigh fuel prices

Posted 7-Eleven and Speedway gas prices in Raleigh, North Carolina. The page compares stations and keeps hourly and daily history.

**Live site:** https://frostcutter778.github.io/raleigh-711-prices/

Prices are the posted pump board from [7-Eleven’s store locator](https://www.7-eleven.com/locator), before any 7REWARDS discount. Speedway stations are included because 7-Eleven owns them and lists them in the same locator.

## How it stays updated

GitHub Pages only hosts static files, so a [GitHub Actions](.github/workflows/update-prices.yml) workflow checks 7-Eleven on the free schedule. GitHub’s shortest interval is every 5 minutes, and a run can start later than that. When a posted price changes, and at least once an hour, the workflow commits a snapshot to the `data` branch. The site reads that file.

The code on `main` stays separate from those price commits.

## Local preview

```bash
npm run update   # fetch the current prices into data/prices.json
npm start        # open http://127.0.0.1:8787
```

Node.js 20 or newer is enough. No packages to install.

## Price file

`prices.json` on the `data` branch holds stations, readings, and price changes for the last 120 days. Readings use dollars per gallon.
