// Chart.js, loaded only when the Analytics page opens (vendored: the Content Security Policy allows only our own
// scripts). Colours come from the page's CSS variables, so charts follow the light and dark themes.
let loading;
export function loadChartJs() {
  if (window.Chart) return Promise.resolve(window.Chart);
  return loading || (loading = new Promise((resolve, reject) => {
    // Keep the ?v= build stamp of this module, so a new release is not served from an old cache.
    const src = new URL("../vendor/chartjs/chart.umd.js", import.meta.url);
    src.search = new URL(import.meta.url).search;
    const script = document.createElement("script");
    script.src = src.href;
    script.onload = () => window.Chart ? resolve(window.Chart) : reject(new Error("Chart.js did not start."));
    script.onerror = () => { loading = null; reject(new Error("Chart.js could not be loaded.")); };
    document.head.appendChild(script);
  }));
}

// The page's chart colours (--an-1..3, --an-ramp-*) and ink tokens, as resolved for the current theme.
export function theme() {
  const css = getComputedStyle(document.documentElement), read = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
  return {
    fg: read("--fg", "#202a40"), muted: read("--muted", "#5f6d83"), line: read("--line", "#e8ebf2"), surface: read("--surface", "#fff"),
    series: [1, 2, 3].map(n => read("--an-" + n, ["#4a5fd6", "#0f8f80", "#c9731a"][n - 1])),
    ramp: [1, 2, 3, 4, 5].map(n => read("--an-ramp-" + n, "#4a5fd6")),
  };
}

// Redraw when the colour scheme changes (system setting or the data-theme attribute). Returns a function to stop.
export function watchTheme(callback) {
  const media = matchMedia("(prefers-color-scheme: dark)"), observer = new MutationObserver(callback);
  media.addEventListener("change", callback);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => { media.removeEventListener("change", callback); observer.disconnect(); };
}

// "2026-10-04" → "4 Oct": week labels without the noise of the year.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function shortDay(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day));
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}` : String(day);
}

// Shows each bar's value just past its end, so the exact number never needs a tooltip.
const valueLabels = {
  id: "anValueLabels",
  afterDatasetsDraw(chart, _args, o) {
    if (!o || !o.show) return;
    const { ctx } = chart; ctx.save(); ctx.font = "600 12px system-ui, sans-serif"; ctx.fillStyle = o.color; ctx.textBaseline = "middle";
    chart.getDatasetMeta(0).data.forEach((bar, i) => {
      const v = chart.data.datasets[0].data[i]; if (v === null || v === undefined) return;
      ctx.fillText(`${Number(v).toLocaleString(undefined, { maximumFractionDigits: 1 })}${o.unit || ""}`, bar.x + 8, bar.y);
    });
    ctx.restore();
  },
};

// One bar chart.
// `spec`: {labels, datasets:[{label, data, color?}], stacked, horizontal, unit, weekly, colors, onPick(index), highlight(index)}.
export function drawBars(Chart, canvas, spec) {
  const t = theme(), reduce = matchMedia("(prefers-reduced-motion: reduce)").matches, horizontal = !!spec.horizontal;
  const tick = { color: t.muted, font: { size: 12 } };
  const colorOf = (d, i) => d.color ?? spec.colors?.[i] ?? t.series[i % t.series.length];
  const datasets = spec.datasets.map((d, i) => ({
    ...d,
    backgroundColor: spec.colors && spec.datasets.length === 1 ? spec.colors : colorOf(d, i),
    // A 2px surface-coloured edge is the gap between touching fills (stacked segments, neighbouring bars).
    borderColor: t.surface, borderWidth: spec.stacked ? 2 : 0,
    borderRadius: spec.stacked ? 0 : { topLeft: horizontal ? 0 : 4, topRight: 4, bottomRight: horizontal ? 4 : 0 }, borderSkipped: false,
    maxBarThickness: horizontal ? 22 : 32, categoryPercentage: 0.8, barPercentage: spec.datasets.length > 1 && !spec.stacked ? 0.9 : 0.7,
  }));
  const labels = spec.weekly ? spec.labels.map(shortDay) : spec.labels;
  return new Chart(canvas, {
    type: "bar",
    data: { labels, datasets },
    options: {
      indexAxis: horizontal ? "y" : "x", responsive: true, maintainAspectRatio: false, animation: reduce ? false : { duration: 350 },
      layout: { padding: { top: 6, right: horizontal ? 44 : 4 } },
      interaction: { mode: horizontal ? "nearest" : "index", intersect: false, axis: horizontal ? "y" : "x" },
      plugins: {
        legend: { display: false },
        anValueLabels: { show: horizontal, unit: spec.unit, color: t.fg },
        tooltip: {
          backgroundColor: t.surface, titleColor: t.fg, bodyColor: t.fg, borderColor: t.line, borderWidth: 1, padding: 10, cornerRadius: 8, boxPadding: 4, usePointStyle: true,
          callbacks: {
            title: items => spec.weekly ? "Week of " + shortDay(spec.labels[items[0].dataIndex]) : items[0].label,
            label: c => `${c.dataset.label ? c.dataset.label + ": " : ""}${Number(c.parsed[horizontal ? "x" : "y"]).toLocaleString(undefined, { maximumFractionDigits: 1 })}${spec.unit || ""}`,
          },
        },
      },
      scales: {
        x: horizontal
          ? { display: false, stacked: !!spec.stacked, beginAtZero: true, grid: { display: false } }
          : { stacked: !!spec.stacked, grid: { display: false }, border: { color: t.line }, ticks: { ...tick, maxRotation: 0, autoSkip: true, maxTicksLimit: 8 } },
        y: horizontal
          ? { stacked: !!spec.stacked, grid: { display: false }, border: { display: false }, ticks: { ...tick, color: t.fg } }
          : { stacked: !!spec.stacked, beginAtZero: true, grid: { color: t.line, drawTicks: false }, border: { display: false }, ticks: { ...tick, padding: 8, maxTicksLimit: 5, precision: 0, callback: v => v + (spec.unit || "") } },
      },
      onClick: spec.onPick ? (_e, hit) => { if (hit.length) spec.onPick(hit[0].index); } : undefined,
      onHover: spec.onPick ? (e, hit) => { e.native.target.style.cursor = hit.length ? "pointer" : "default"; } : undefined,
    },
    plugins: [valueLabels],
  });
}
