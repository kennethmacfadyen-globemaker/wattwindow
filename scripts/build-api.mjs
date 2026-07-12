#!/usr/bin/env node
/**
 * WattWindow — pipeline. Combines two free public UK data streams into one
 * derived product, published as static JSON endpoints:
 *
 *   1. National Grid ESO Carbon Intensity API  (gCO2/kWh, per DNO region, 48h forecast)
 *   2. Octopus Energy Agile tariff public feed (p/kWh, half-hourly, per DNO region)
 *
 * Derived value (the maths):
 *   - joins both series on half-hour boundaries per region
 *   - normalises each onto percentile scales across the visible horizon
 *   - WattWindow score = 100 - (0.6 * price percentile + 0.4 * carbon percentile)
 *   - sliding-window optimiser finds the cheapest/greenest/best contiguous
 *     window for appliance durations of 1, 2, 3, 4, 6 and 8 hours
 *
 * No API keys. Run every 30 minutes by .github/workflows/refresh.yml.
 */
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "api", "v1");
const AGILE_PRODUCT = "AGILE-24-10-01";

// Octopus DNO letter ↔ Carbon Intensity regionid ↔ human name
// mpan = the first two digits of the supply number (bottom-left "S" box) on any
// UK electricity bill — the canonical way for a user to identify their region.
const REGIONS = [
  { letter: "A", carbonId: 10, mpan: "10", name: "Eastern England" },
  { letter: "B", carbonId: 9,  mpan: "11", name: "East Midlands" },
  { letter: "C", carbonId: 13, mpan: "12", name: "London" },
  { letter: "D", carbonId: 6,  mpan: "13", name: "Merseyside & North Wales" },
  { letter: "E", carbonId: 8,  mpan: "14", name: "West Midlands" },
  { letter: "F", carbonId: 4,  mpan: "15", name: "North East England" },
  { letter: "G", carbonId: 3,  mpan: "16", name: "North West England" },
  { letter: "H", carbonId: 12, mpan: "20", name: "Southern England" },
  { letter: "J", carbonId: 14, mpan: "19", name: "South East England" },
  { letter: "K", carbonId: 7,  mpan: "21", name: "South Wales" },
  { letter: "L", carbonId: 11, mpan: "22", name: "South West England" },
  { letter: "M", carbonId: 5,  mpan: "23", name: "Yorkshire" },
  { letter: "N", carbonId: 2,  mpan: "18", name: "South Scotland" },
  { letter: "P", carbonId: 1,  mpan: "17", name: "North Scotland" }
];

const DURATIONS = [1, 2, 3, 4, 6, 8]; // hours

async function getJSON(url) {
  const r = await fetch(url, { headers: { "User-Agent": "WattWindow-pipeline/1.0 (github.com/kennethmacfadyen-globemaker/wattwindow)" } });
  if (!r.ok) throw new Error(`HTTP ${r.status} from ${new URL(url).host}`);
  return r.json();
}

// Floor a date to the half-hour and format as the ISO key both APIs share
function halfHourKey(d) {
  const t = new Date(Math.floor(d.getTime() / 1800000) * 1800000);
  return t.toISOString().slice(0, 16) + "Z";
}

function percentileRanks(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return values.map((v) => {
    let lo = 0, hi = sorted.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < v) lo = mid + 1; else hi = mid; }
    return sorted.length > 1 ? (lo / (sorted.length - 1)) * 100 : 50;
  });
}

function label(score) {
  return score >= 75 ? "excellent" : score >= 55 ? "good" : score >= 35 ? "fair" : "poor";
}

function buildWindows(series) {
  const windows = {};
  for (const hours of DURATIONS) {
    const n = hours * 2;
    if (series.length < n) continue;
    let best = null, cheapest = null, greenest = null;
    for (let i = 0; i + n <= series.length; i++) {
      const slice = series.slice(i, i + n);
      const avgPrice = slice.reduce((s, x) => s + x.price, 0) / n;
      const avgCarbon = slice.reduce((s, x) => s + x.carbon, 0) / n;
      const avgScore = slice.reduce((s, x) => s + x.score, 0) / n;
      const w = {
        from: slice[0].from, to: slice[n - 1].to,
        avgPrice: +avgPrice.toFixed(2), avgCarbon: Math.round(avgCarbon),
        score: Math.round(avgScore)
      };
      if (!best || avgScore > best._k) { best = { ...w, _k: avgScore }; }
      if (!cheapest || avgPrice < cheapest._k) { cheapest = { ...w, _k: avgPrice }; }
      if (!greenest || avgCarbon < greenest._k) { greenest = { ...w, _k: avgCarbon }; }
    }
    const horizonAvgPrice = series.reduce((s, x) => s + x.price, 0) / series.length;
    for (const w of [best, cheapest, greenest]) {
      delete w._k;
      w.savingsVsAvgPct = horizonAvgPrice > 0
        ? Math.round((1 - w.avgPrice / horizonAvgPrice) * 100) : 0;
    }
    windows[hours + "h"] = { best, cheapest, greenest };
  }
  return windows;
}

async function main() {
  const now = new Date();
  const nowKey = halfHourKey(now);
  const fromISO = nowKey.replace(":00Z", ":00Z"); // carbon API accepts YYYY-MM-DDTHH:mmZ
  const updated = now.toISOString();

  // ---- fetch carbon: two 24h regional calls stitched into 48h ----
  const carbByKey = {}; // key -> { regionid -> {forecast, mix} }
  const natByKey = {};  // key -> national forecast
  const from2 = new Date(now.getTime() + 24 * 3600000);
  const [reg1, reg2, nat] = await Promise.all([
    getJSON(`https://api.carbonintensity.org.uk/regional/intensity/${fromISO}/fw24h`),
    getJSON(`https://api.carbonintensity.org.uk/regional/intensity/${halfHourKey(from2)}/fw24h`),
    getJSON(`https://api.carbonintensity.org.uk/intensity/${fromISO}/fw48h`)
  ]);
  for (const block of [...reg1.data, ...(reg2.data || [])]) {
    const key = block.from.length === 17 ? block.from.slice(0, 16) + "Z" : block.from;
    carbByKey[key] ||= {};
    for (const r of block.regions) {
      carbByKey[key][r.regionid] = {
        carbon: r.intensity.forecast,
        mix: Object.fromEntries(r.generationmix.map((g) => [g.fuel, g.perc]))
      };
    }
  }
  for (const b of nat.data) natByKey[b.from.slice(0, 16) + "Z"] = b.intensity.forecast;

  // ---- fetch Agile prices for all regions in parallel ----
  const to = new Date(now.getTime() + 48 * 3600000).toISOString();
  const priceResults = await Promise.all(REGIONS.map((reg) =>
    getJSON(`https://api.octopus.energy/v1/products/${AGILE_PRODUCT}/electricity-tariffs/E-1R-${AGILE_PRODUCT}-${reg.letter}/standard-unit-rates/?period_from=${nowKey}&period_to=${to}`)
      .then((d) => ({ reg, rates: d.results }))
      .catch((e) => ({ reg, rates: null, err: e.message }))
  ));

  await mkdir(join(OUT, "regions"), { recursive: true });
  const bestSummary = [];
  const built = [];

  for (const { reg, rates, err } of priceResults) {
    if (!rates) { console.error(`✗ ${reg.name}: ${err}`); continue; }
    const priceByKey = {};
    for (const r of rates) priceByKey[r.valid_from.slice(0, 16) + "Z"] = r.value_inc_vat;

    // join: only half-hours where BOTH price and carbon exist, from now forward
    const keys = Object.keys(priceByKey)
      .filter((k) => k >= nowKey && carbByKey[k] && carbByKey[k][reg.carbonId] &&
                     carbByKey[k][reg.carbonId].carbon !== null)
      .sort();
    if (keys.length < 8) { console.error(`✗ ${reg.name}: only ${keys.length} joined half-hours`); continue; }

    const prices = keys.map((k) => priceByKey[k]);
    const carbons = keys.map((k) => carbByKey[k][reg.carbonId].carbon);
    const pricePct = percentileRanks(prices);
    const carbonPct = percentileRanks(carbons);

    const series = keys.map((k, i) => {
      const score = Math.round(100 - (0.6 * pricePct[i] + 0.4 * carbonPct[i]));
      return {
        from: k,
        to: halfHourKey(new Date(new Date(k).getTime() + 1800000)),
        price: prices[i], carbon: carbons[i],
        score, label: label(score)
      };
    });

    const windows = buildWindows(series);
    const current = series[0];
    const renewables = (m) => Math.round((m.wind || 0) + (m.solar || 0) + (m.hydro || 0));
    const mixNow = carbByKey[keys[0]][reg.carbonId].mix;

    const payload = {
      meta: {
        product: "WattWindow", version: 1, region: reg.name, dno: reg.letter,
        updated, horizonHalfHours: series.length,
        units: { price: "p/kWh inc. VAT (Octopus Agile)", carbon: "gCO2/kWh (forecast)", score: "0-100, higher = better time to draw power" },
        sources: ["api.carbonintensity.org.uk", "api.octopus.energy (Agile public tariff feed)"],
        licence: "Free for personal & non-commercial use with attribution. Commercial use requires a licence — see https://kennethmacfadyen-globemaker.github.io/wattwindow/#pricing"
      },
      current: { ...current, renewablesPct: renewables(mixNow), mix: mixNow },
      windows, series
    };
    await writeFile(join(OUT, "regions", `${reg.letter}.json`), JSON.stringify(payload, null, 1));
    built.push(reg);
    const b2 = windows["2h"] && windows["2h"].best;
    if (b2) bestSummary.push({ region: reg.name, dno: reg.letter, now: { price: current.price, carbon: current.carbon, score: current.score }, best2h: b2 });
    console.log(`✓ ${reg.name}: ${series.length} half-hours, now ${current.price}p/${current.carbon}g (score ${current.score})${b2 ? `, best 2h ${b2.from} @ ${b2.avgPrice}p` : ""}`);
  }

  if (built.length < 10) throw new Error(`Only ${built.length}/14 regions built — refusing to publish a degraded API.`);

  // national carbon summary (no prices at national level)
  const natKeys = Object.keys(natByKey).filter((k) => k >= nowKey).sort();
  await writeFile(join(OUT, "national.json"), JSON.stringify({
    meta: { product: "WattWindow", version: 1, scope: "Great Britain (carbon only — prices are regional)", updated },
    series: natKeys.map((k) => ({ from: k, carbon: natByKey[k] }))
  }, null, 1));

  await writeFile(join(OUT, "best.json"), JSON.stringify({
    meta: { product: "WattWindow", version: 1, updated, description: "At-a-glance: current conditions and the best 2-hour window per region." },
    regions: bestSummary
  }, null, 1));

  await writeFile(join(OUT, "regions.json"), JSON.stringify({
    meta: { product: "WattWindow", version: 1, updated },
    regions: REGIONS.map((r) => ({ dno: r.letter, mpanPrefix: r.mpan, name: r.name, endpoint: `regions/${r.letter}.json` }))
  }, null, 1));

  await writeFile(join(OUT, "index.json"), JSON.stringify({
    product: "WattWindow", version: 1, updated,
    description: "UK half-hourly electricity price + carbon intensity, scored and optimised into the best times to draw power. Refreshed every 30 minutes.",
    docs: "https://kennethmacfadyen-globemaker.github.io/wattwindow/",
    endpoints: {
      "index.json": "this file",
      "regions.json": "list of the 14 DNO regions",
      "regions/{DNO}.json": "full series + optimal windows for one region (A-P)",
      "best.json": "current conditions + best 2h window, all regions",
      "national.json": "GB-wide carbon intensity series"
    }
  }, null, 1));

  console.log(`✓ wrote ${built.length} regional endpoints + index/regions/best/national`);
}

main().catch((e) => { console.error(e); process.exit(1); });
