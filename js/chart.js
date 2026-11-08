// Price history chart: face value (Ticketmaster) and resale (SeatGeek) as step lines,
// prices you logged as hollow markers, your target as a dashed line. Tap/drag for a crosshair readout.

import { esc, fmtMoney, daysUntil } from './util.js';

const RANGES = [['1w', '1W', 7], ['1m', '1M', 30], ['3m', '3M', 90], ['all', 'All', Infinity]];
let currentRange = 'all';

const SERIES = [
  { key: 'api', label: 'Face value', cls: 's1' },
  { key: 'resale', label: 'Resale', cls: 's2' },
];

function seriesPoints(ev, key) {
  return (ev.priceHistory || []).filter((h) => h.src === key && h.min != null).sort((a, b) => a.t - b.t);
}

/** Value of a step series at time t (last observation at or before t). */
function valueAt(points, t) {
  let v = null;
  for (const p of points) {
    if (p.t <= t) v = p.min;
    else break;
  }
  return v;
}

export function hasChartData(ev) {
  return (ev.priceHistory || []).filter((h) => h.min != null).length >= 2;
}

export function mountPriceChart(container, ev) {
  if (!container) return;
  if (!hasChartData(ev)) { container.innerHTML = ''; return; }
  const draw = () => {
    container.innerHTML = renderChart(ev, container.clientWidth || 320);
    wire(container, ev, draw);
  };
  draw();
}

function renderChart(ev, width) {
  const now = Date.now();
  const range = RANGES.find((r) => r[0] === currentRange) || RANGES[3];
  const from = range[2] === Infinity ? 0 : now - range[2] * 86400000;
  const all = (ev.priceHistory || []).filter((h) => h.min != null);
  const series = SERIES.map((s) => ({ ...s, pts: seriesPoints(ev, s.key) })).filter((s) => s.pts.length);
  const manual = seriesPoints(ev, 'manual');

  const chips = `<div class="chart-ranges" role="tablist" aria-label="Time range">${RANGES.map(([id, label]) =>
    `<button class="chip ${id === currentRange ? 'active' : ''}" data-range="${id}" role="tab" aria-selected="${id === currentRange}">${label}</button>`).join('')}</div>`;

  const inRange = all.filter((h) => h.t >= from);
  // Include the value carried in from before the window so lines start at the left edge.
  const carried = series.map((s) => valueAt(s.pts, from)).filter((v) => v != null);
  if (inRange.length + (from ? carried.length : 0) < 2) {
    return `${chips}<p class="help" style="margin:10px 4px">Not enough price data in this range yet.</p>`;
  }
  const t0 = from ? from : Math.min(...all.map((h) => h.t));
  const t1 = now;
  const target = ev.mine?.targetPrice;
  const vals = [...inRange.map((h) => h.min), ...(from ? carried : []), ...(target != null ? [target] : [])];
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  if (hi - lo < 2) { hi += 5; lo = Math.max(0, lo - 5); }
  const pad = (hi - lo) * 0.12;
  lo = Math.max(0, lo - pad);
  hi += pad;

  const W = Math.max(260, Math.round(width));
  const H = 150;
  const padL = 46;
  const padR = 10;
  const padT = 10;
  const padB = 24;
  const x = (t) => padL + ((t - t0) / Math.max(1, t1 - t0)) * (W - padL - padR);
  const y = (v) => padT + (1 - (v - lo) / (hi - lo)) * (H - padT - padB);
  const cur = ev.currency;

  const paths = series.map((s) => {
    const pts = s.pts.filter((p) => p.t >= t0);
    const start = valueAt(s.pts, t0);
    const seq = [...(start != null && (!pts.length || pts[0].t > t0) ? [{ t: t0, min: start }] : []), ...pts];
    if (!seq.length) return '';
    let d = `M${x(seq[0].t).toFixed(1)},${y(seq[0].min).toFixed(1)}`;
    for (let i = 1; i < seq.length; i++) d += ` H${x(seq[i].t).toFixed(1)} V${y(seq[i].min).toFixed(1)}`;
    d += ` H${x(t1).toFixed(1)}`;
    const dots = pts.map((p) => `<circle class="pt ${s.cls}" cx="${x(p.t).toFixed(1)}" cy="${y(p.min).toFixed(1)}" r="4"/>`).join('');
    return `<path class="line ${s.cls}" d="${d}"/>${dots}`;
  }).join('');
  const manualDots = manual.filter((p) => p.t >= t0)
    .map((p) => `<circle class="pt manual" cx="${x(p.t).toFixed(1)}" cy="${y(p.min).toFixed(1)}" r="4.5"/>`).join('');
  const ticks = [hi, (hi + lo) / 2, lo];
  const grid = ticks.map((v) => `<line class="grid" x1="${padL}" x2="${W - padR}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/>
    <text x="${padL - 6}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${esc(fmtMoney(Math.round(v), cur))}</text>`).join('');
  const fmtD = (t) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const targetLine = target != null
    ? `<line class="target" x1="${padL}" x2="${W - padR}" y1="${y(target).toFixed(1)}" y2="${y(target).toFixed(1)}"/>` : '';

  const legend = [
    ...series.map((s) => `<span><i class="sw ${s.cls}"></i>${s.label}</span>`),
    manual.length ? '<span><i class="sw manual"></i>Logged by you</span>' : '',
    target != null ? '<span><i class="sw target"></i>Your target</span>' : '',
  ].join('');

  const meta = { t0, t1, padL, padR, W, lo, hi, padT, padB, H };
  return `${chips}
    <div class="chart-wrap">
      <svg class="spark" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Lowest ticket price over time" data-meta='${esc(JSON.stringify(meta))}'>
        ${grid}${targetLine}${paths}${manualDots}
        <line class="xhair" x1="0" x2="0" y1="${padT}" y2="${H - padB}" visibility="hidden"/>
        <text x="${padL}" y="${H - 6}">${esc(fmtD(t0))}</text>
        <text x="${W - padR}" y="${H - 6}" text-anchor="end">Today</text>
        <rect class="hit" x="${padL}" y="0" width="${W - padL - padR}" height="${H}"/>
      </svg>
    </div>
    <div class="spark-tip" data-spark-tip aria-live="polite">Tap or drag on the chart to read prices.</div>
    <div class="legend">${legend}</div>`;
}

function wire(container, ev, redraw) {
  container.querySelectorAll('[data-range]').forEach((b) => b.addEventListener('click', () => {
    currentRange = b.dataset.range;
    redraw();
  }));
  const svg = container.querySelector('svg.spark');
  if (!svg) return;
  const tip = container.querySelector('[data-spark-tip]');
  const xh = svg.querySelector('.xhair');
  const meta = JSON.parse(svg.dataset.meta);
  const series = SERIES.map((s) => ({ ...s, pts: seriesPoints(ev, s.key) })).filter((s) => s.pts.length);
  const manual = seriesPoints(ev, 'manual');
  const show = (clientX) => {
    const r = svg.getBoundingClientRect();
    const px = Math.min(Math.max(clientX - r.left, meta.padL), meta.W - meta.padR);
    const t = meta.t0 + ((px - meta.padL) / (meta.W - meta.padL - meta.padR)) * (meta.t1 - meta.t0);
    xh.setAttribute('x1', px);
    xh.setAttribute('x2', px);
    xh.setAttribute('visibility', 'visible');
    const parts = series.map((s) => {
      const v = valueAt(s.pts, t);
      return v != null ? `${s.label} ${fmtMoney(v, ev.currency)}` : null;
    }).filter(Boolean);
    const nearManual = manual.find((m) => Math.abs(m.t - t) < (meta.t1 - meta.t0) * 0.04);
    if (nearManual) parts.push(`You logged ${fmtMoney(nearManual.min, ev.currency)}${nearManual.note ? ` (${nearManual.note})` : ''}`);
    tip.textContent = `${new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} — ${parts.join(' · ') || 'no data'}`;
  };
  svg.addEventListener('pointerdown', (e) => { show(e.clientX); svg.setPointerCapture?.(e.pointerId); });
  svg.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse' || e.buttons) show(e.clientX); });
}

/** Plain-language observations about the price trend (not predictions). */
export function priceInsights(ev) {
  const out = [];
  const resale = seriesPoints(ev, 'resale');
  const face = seriesPoints(ev, 'api');
  const main = resale.length >= 2 ? { pts: resale, label: 'Resale' } : face.length >= 2 ? { pts: face, label: 'Face value' } : null;
  const days = daysUntil(ev.date);
  if (ev.status === 'soldout' || ev.status === 'offsale') {
    out.push({ tone: 'info', text: 'Face-value tickets aren’t on sale right now — resale is the main option.' });
  }
  if (main) {
    const cur = main.pts[main.pts.length - 1].min;
    const low = Math.min(...main.pts.map((p) => p.min));
    const weekAgo = valueAt(main.pts, Date.now() - 7 * 86400000);
    if (cur <= low * 1.03) out.push({ tone: 'good', text: `${main.label} is at the lowest price Encore has seen (${fmtMoney(low, ev.currency)}).` });
    else out.push({ tone: '', text: `${main.label} low so far: ${fmtMoney(low, ev.currency)} — now ${fmtMoney(cur, ev.currency)}.` });
    if (weekAgo != null && weekAgo > 0) {
      const pct = Math.round(((cur - weekAgo) / weekAgo) * 100);
      if (pct <= -5) out.push({ tone: 'good', text: `Down ${-pct}% in the past week.` });
      else if (pct >= 5) out.push({ tone: 'bad', text: `Up ${pct}% in the past week.` });
      else out.push({ tone: '', text: 'Roughly flat over the past week.' });
    }
  }
  if (ev.resale && !ev.resale.gone && ev.resale.count) {
    out.push({ tone: '', text: `${ev.resale.count.toLocaleString()} resale listing${ev.resale.count === 1 ? '' : 's'}${ev.resale.avg ? `, average ${fmtMoney(ev.resale.avg, ev.currency)}` : ''}.` });
  }
  if (days != null && days >= 0 && days <= 3 && resale.length) {
    out.push({ tone: 'info', text: 'Show is days away — resale prices tend to move quickly now. Check often.' });
  }
  return out;
}
