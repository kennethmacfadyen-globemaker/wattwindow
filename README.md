# ⚡ WattWindow

**The UK "when to run it" energy API.** Octopus Agile half-hourly prices × National Grid carbon intensity, joined per DNO region, normalised onto one 0–100 score, and optimised into the best contiguous windows to run appliances — served as plain JSON from a global CDN, refreshed every 30 minutes.

**Docs & live demo:** https://kennethmacfadyen-globemaker.github.io/wattwindow/

```bash
curl -s https://kennethmacfadyen-globemaker.github.io/wattwindow/api/v1/regions/C.json \
  | jq '.windows["2h"].best'
```

## How it's made

- `scripts/build-api.mjs` fetches both public sources (no keys), joins on half-hour boundaries, computes percentile-normalised scores (`100 − (0.6·pricePct + 0.4·carbonPct)`), runs a sliding-window optimiser for 1–8 h durations, and writes static JSON under `api/v1/`.
- A GitHub Action re-runs it twice an hour and commits only when data changed. There is no server: uptime is GitHub Pages' uptime.
- The site's live demo consumes the same endpoints customers do.

## Licence

- **Data pipeline & site code:** MIT.
- **API usage:** free for personal & non-commercial projects (attribution appreciated). Commercial use requires a licence — £29/year, honour-system via [Buy Me a Coffee](https://www.buymeacoffee.com/globemaker), note "WattWindow".
- Carbon Intensity data © National Grid ESO (CC-BY-4.0). Agile prices via Octopus Energy's public API. Not affiliated with either.
