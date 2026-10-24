/**
 * A tiny metrics registry that prints the Prometheus text format (no dependencies, no database).
 * Counters and histograms are kept in memory per process; gauges are produced fresh at scrape time.
 */

const MAX_SERIES = 500; // a metric never holds more label combinations than this, so odd traffic cannot grow memory without limit
export const DEFAULT_BUCKETS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

const escapeLabel = (v) => String(v).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
const labelText = (labels) =>
  Object.keys(labels)
    .sort()
    .map((k) => `${k}="${escapeLabel(labels[k])}"`)
    .join(',');
const number = (v) => (Number.isFinite(v) ? String(v) : '0');
const braces = (text) => (text ? `{${text}}` : '');

/** One metric as text. `samples` is [{ labels, value }]. Used for gauges produced at scrape time. */
export function formatMetric({ name, help, type = 'gauge', samples }) {
  const lines = [`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`];
  for (const s of samples) lines.push(`${name}${braces(labelText(s.labels || {}))} ${number(s.value)}`);
  return lines.join('\n');
}

export function createRegistry() {
  const counters = new Map(); // name -> { help, series: Map(key -> { labels, value }) }
  const histograms = new Map(); // name -> { help, buckets, series: Map(key -> { labels, counts, sum, count }) }

  function inc(name, help, labels = {}, by = 1) {
    let metric = counters.get(name);
    if (!metric) counters.set(name, (metric = { help, series: new Map() }));
    const key = labelText(labels);
    let series = metric.series.get(key);
    if (!series) {
      if (metric.series.size >= MAX_SERIES) return;
      metric.series.set(key, (series = { labels, value: 0 }));
    }
    series.value += by;
  }

  function observe(name, help, labels, value, buckets = DEFAULT_BUCKETS) {
    let metric = histograms.get(name);
    if (!metric) histograms.set(name, (metric = { help, buckets, series: new Map() }));
    const key = labelText(labels);
    let series = metric.series.get(key);
    if (!series) {
      if (metric.series.size >= MAX_SERIES) return;
      metric.series.set(key, (series = { labels, counts: new Array(metric.buckets.length).fill(0), sum: 0, count: 0 }));
    }
    metric.buckets.forEach((limit, i) => {
      if (value <= limit) series.counts[i] += 1;
    });
    series.sum += value;
    series.count += 1;
  }

  /** Everything recorded so far, plus any extra gauges, as one text document. */
  function render(extra = []) {
    const blocks = [];
    for (const [name, m] of counters) {
      blocks.push(formatMetric({ name, help: m.help, type: 'counter', samples: [...m.series.values()].map((s) => ({ labels: s.labels, value: s.value })) }));
    }
    for (const [name, m] of histograms) {
      const lines = [`# HELP ${name} ${m.help}`, `# TYPE ${name} histogram`];
      for (const s of m.series.values()) {
        const base = labelText(s.labels);
        const withLe = (le) => braces([base, `le="${le}"`].filter(Boolean).join(','));
        m.buckets.forEach((limit, i) => lines.push(`${name}_bucket${withLe(limit)} ${s.counts[i]}`));
        lines.push(`${name}_bucket${withLe('+Inf')} ${s.count}`);
        lines.push(`${name}_sum${braces(base)} ${number(s.sum)}`);
        lines.push(`${name}_count${braces(base)} ${s.count}`);
      }
      blocks.push(lines.join('\n'));
    }
    for (const g of extra) blocks.push(formatMetric(g));
    return `${blocks.join('\n')}\n`;
  }

  function reset() {
    counters.clear();
    histograms.clear();
  }

  return { inc, observe, render, reset };
}

/** The registry the app records into. */
export const registry = createRegistry();
