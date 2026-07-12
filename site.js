/* WattWindow site — the demo eats the same public endpoints customers do. */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var API = "api/v1";

  function fmtTime(iso) {
    var d = new Date(iso);
    return d.toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" });
  }

  function scoreClass(s) { return s >= 65 ? "good" : s >= 40 ? "warn" : "bad"; }
  function barColor(s) { return s >= 75 ? "#4ade80" : s >= 55 ? "#a3e635" : s >= 35 ? "#fbbf24" : "#f87171"; }

  function renderRegion(data) {
    var c = data.current;
    $("d-price").textContent = c.price.toFixed(2);
    $("d-price").className = "stat-v " + (c.price <= 5 ? "good" : c.price >= 25 ? "bad" : "");
    $("d-carbon").textContent = c.carbon;
    $("d-carbon").className = "stat-v " + (c.carbon <= 100 ? "good" : c.carbon >= 250 ? "bad" : "");
    $("d-score").textContent = c.score;
    $("d-score").className = "stat-v " + scoreClass(c.score);
    var w = data.windows["2h"] && data.windows["2h"].best;
    if (w) {
      $("d-window").textContent = fmtTime(w.from);
      $("d-window").className = "stat-v good";
      $("d-window-sub").textContent = w.avgPrice + "p/kWh avg · saves " + w.savingsVsAvgPct + "% vs day average";
    }
    $("demo-updated").textContent = "updated " + fmtTime(data.meta.updated) + " · horizon " + data.series.length + " half-hours";

    var chart = $("d-chart");
    chart.innerHTML = "";
    data.series.forEach(function (h) {
      var bar = document.createElement("div");
      bar.className = "bar";
      bar.style.height = Math.max(6, h.score) + "%";
      bar.style.background = barColor(h.score);
      bar.setAttribute("data-tip", fmtTime(h.from) + " · " + h.price + "p · " + h.carbon + "g · score " + h.score);
      chart.appendChild(bar);
    });
  }

  function loadRegion(dno) {
    fetch(API + "/regions/" + dno + ".json")
      .then(function (r) { return r.json(); })
      .then(renderRegion)
      .catch(function () { $("demo-updated").textContent = "endpoint unreachable — try a refresh"; });
  }

  document.addEventListener("DOMContentLoaded", function () {
    // hero terminal: show the real answer for London
    fetch(API + "/regions/C.json").then(function (r) { return r.json(); }).then(function (d) {
      var w = d.windows["2h"].best;
      $("hero-out").textContent = JSON.stringify(w, null, 2);
      $("hero-pill").textContent = "● live · updated " + fmtTime(d.meta.updated) + " · London best 2h saves " + w.savingsVsAvgPct + "%";
    }).catch(function () {
      $("hero-out").textContent = '{ "error": "run the pipeline once to populate api/v1" }';
    });

    // region picker
    fetch(API + "/regions.json").then(function (r) { return r.json(); }).then(function (d) {
      var sel = $("region-pick");
      sel.innerHTML = d.regions.map(function (r) {
        return '<option value="' + r.dno + '"' + (r.dno === "C" ? " selected" : "") + ">" + r.dno + " — " + r.name + "</option>";
      }).join("");
      sel.addEventListener("change", function () { loadRegion(sel.value); });
      loadRegion("C");
    });

    // quickstart tabs
    document.querySelectorAll(".tab").forEach(function (tab) {
      tab.addEventListener("click", function () {
        document.querySelectorAll(".tab").forEach(function (t) { t.classList.toggle("on", t === tab); });
        document.querySelectorAll(".tabpane").forEach(function (p) {
          p.classList.toggle("on", p.dataset.t === tab.dataset.t);
        });
      });
    });
  });
})();
