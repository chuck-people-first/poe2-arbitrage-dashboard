const $ = s => document.querySelector(s);
let run = null;
let tab = 'scanner';
let lastFocusedRow = null;
let currencyRates = [];
let historyRows = [];
// A scanner row is publishable when it carries the separated price model.
// This is a structural check, not a version-string match: a row produced by an
// older projection has no priceModel and is hidden without needing the browser
// and the Edge Function to be redeployed in lockstep.
const hasPriceModel = r => Boolean(r?.discovery?.priceModel);
let scannerSort = 'default';

const DIVINE = 'Metadata/Items/Currency/CurrencyModValues';
const EXALTED = 'Metadata/Items/Currency/CurrencyAddModToRare';
const CHAOS = 'Metadata/Items/Currency/CurrencyRerollRare';

// The flow the player actually runs: pay Exalted or Chaos for an item, sell it
// for Divine, convert the Divine back. Everything else is available but is not
// what the scanner opens on.
const FLOW_PRESETS = {
  mine: {
    label: 'My flow',
    hint: 'Buy with Exalted or Chaos → sell for Divine → convert back',
    match: s => s.sellCurrency?.id === DIVINE && (s.buyCurrency?.id === EXALTED || s.buyCurrency?.id === CHAOS),
  },
  exalted: {
    label: 'Exalted only',
    hint: 'Exalted → item → Divine → Exalted',
    match: s => s.sellCurrency?.id === DIVINE && s.buyCurrency?.id === EXALTED,
  },
  all: { label: 'All paths', hint: 'Every hub pair, including Divine-funded routes', match: () => true },
};
let flowPreset = 'mine';
let search = '';
// Bankroll per starting currency; a row is sized from the pot it actually starts in.
let bankroll = { Exalted: 4000, Chaos: 120, Divine: 10 };

// Settings survive a reload. This is a tool someone returns to every hour, and
// retyping filters each time is friction, not safety.
const STORE_KEY = 'poe2.scanner.v1';
function saveSettings() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({
      flowPreset, scannerSort, bankroll,
      minVolume: $('#minVolume')?.value, minSpread: $('#minSpread')?.value,
      maxGold: $('#maxGold')?.value, hideHighRisk: $('#hideHighRisk')?.checked,
      hideLosers: $('#hideLosers')?.checked,
    }));
  } catch { /* private mode, or storage disabled: the tool still works */ }
}
function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (!saved) return;
    if (saved.flowPreset && FLOW_PRESETS[saved.flowPreset]) flowPreset = saved.flowPreset;
    if (saved.scannerSort && SCANNER_SORTS[saved.scannerSort]) scannerSort = saved.scannerSort;
    if (saved.bankroll && typeof saved.bankroll === 'object') bankroll = { ...bankroll, ...saved.bankroll };
    const set = (id, v) => { const el = document.getElementById(id); if (el && v != null && v !== '') el.value = v; };
    set('minVolume', saved.minVolume); set('minSpread', saved.minSpread); set('maxGold', saved.maxGold);
    if ($('#hideHighRisk')) $('#hideHighRisk').checked = Boolean(saved.hideHighRisk);
    if ($('#hideLosers') && saved.hideLosers !== undefined) $('#hideLosers').checked = Boolean(saved.hideLosers);
  } catch { /* ignore malformed state rather than blocking the page */ }
}
const { normalizeOpportunityRow, isCredibleSignal, MIN_ITEM_HOURLY_VOLUME } = window.POE2Dashboard;
const GoldFees = window.POE2GoldFees;
// The operator's own checked fees. Loaded once; every render reads this table.
let goldFees = GoldFees.load(window.localStorage);

const fmt = n => new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(Number(n || 0));
const fmtInt = n => new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Number(n || 0));
const pct = (n, d = 1) => `${(Number(n || 0) * 100).toFixed(d)}%`;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const risk = label => `<span class="risk ${String(label || '').toLowerCase()}">${esc(label || '—')}</span>`;
const rateFmt = n => n == null ? '—' : Number(n).toLocaleString('en-US', { maximumFractionDigits: 6 });
const ratioNum = n => Number(n).toLocaleString('en-US', { maximumFractionDigits: 4 });
// Two forms: one for the DOM (escaped) and one for the clipboard (raw). Passing
// the escaped form to the clipboard pastes "Glassblower&#39;s" into the game.
const ratioPlain = (ratio, wantName, haveName) => ratio
  ? `${ratioNum(ratio.want)} ${wantName} : ${ratioNum(ratio.have)} ${haveName}`
  : 'Not observed';
const ratioText = (ratio, wantName, haveName) => esc(ratioPlain(ratio, wantName, haveName));
const ratioRange = (range, fallback) => range || (fallback ? {
  favorable: fallback,
  conservative: fallback,
  source: 'legacy-single-boundary'
} : null);
// Compact single-line form for the main table: the bid the player types.
// Hub currencies lose their " Orb" suffix here — it costs width in every ratio
// cell and the Item column already carries the full path.
const shortName = name => String(name || '').replace(/ Orb$/, '');
const compactRatioPlain = (range, fallback, wantName, haveName) => {
  const observed = ratioRange(range, fallback);
  return observed ? ratioPlain(observed.conservative, shortName(wantName), shortName(haveName)) : 'Not observed';
};
const compactRatio = (range, fallback, wantName, haveName) =>
  esc(compactRatioPlain(range, fallback, wantName, haveName));
const ratioLadder = (title, range, fallback, wantName, haveName) => {
  const observed = ratioRange(range, fallback);
  if (!observed) return `<div class="ratio-leg"><b>${title}</b><span>Not observed</span></div>`;
  const same = Number(observed.favorable.want) === Number(observed.conservative.want)
    && Number(observed.favorable.have) === Number(observed.conservative.have);
  const target = same ? '' : `<span class="ratio-bound target"><em>TARGET BID</em>${ratioText(observed.favorable,wantName,haveName)}</span>`;
  return `<div class="ratio-leg"><b>${title}</b><small>COMPLETED-HOUR REFERENCES · I WANT : I HAVE</small>${target}<span class="ratio-bound planning"><em>PLAN / FILL</em>${ratioText(observed.conservative,wantName,haveName)}</span></div>`;
};
const sourceAgeText = sourceHour => sourceHour
  ? `${new Date(sourceHour).toLocaleString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })} UTC · ${window.POE2CurrencyRates.ageLabel(sourceHour)}`
  : 'source time unavailable';
function renderCurrencyRates() {
  const el = $('#currencyRates'); if (!el) return;
  const model = window.POE2CurrencyRates.pairModels(currencyRates);
  const line = (from, to, value) => `<div class="rate-line"><span>1 ${esc(from.name)}</span><strong>${value == null ? 'Not observed' : `≈ ${rateFmt(value)} ${esc(to.name)}`}</strong></div>`;
  const cards = model.pairs.map(pair => `<article class="rate-card"><div class="rate-pair-title"><strong>${esc(pair.left.short)} ↔ ${esc(pair.right.short)}</strong><span>DIRECT</span></div>${line(pair.left, pair.right, pair.leftToRight)}${line(pair.right, pair.left, pair.rightToLeft)}</article>`).join('');
  const source = model.sourceHour
    ? `Latest completed hour: ${new Date(model.sourceHour).toLocaleString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })} UTC · ${window.POE2CurrencyRates.ageLabel(model.sourceHour)}`
    : 'No completed-hour currency observations yet.';
  el.innerHTML = `<div class="rates-grid">${cards}</div><div class="rates-note"><span>${esc(source)}</span><span>Reference ratios only. Trade sizing, gold fees, and fill risk are evaluated in the opportunities below.</span></div>`;
}
function historyFor(row) { const family = row?.routeFamilyId || row?.cycle?.familyId || row?.route?.routeFamilyId; return historyRows.filter(h => h.family_id === family).sort((a,b) => String(a.source_hour).localeCompare(String(b.source_hour))); }
function chartPoints(rows, hours) {
  const end = rows.length ? Date.parse(rows.at(-1).source_hour) : Date.now(); const start = end - hours * 3600000;
  const filtered = rows.filter(r => Date.parse(r.source_hour) >= start);
  if (!filtered.length) return '<span class="muted">No retained observations in this window</span>';
  const vals = filtered.map(x => Number(x.div_per_100k_gold)); const min = Math.min(0, ...vals), max = Math.max(0, ...vals); const span = Math.max(0.000001, max - min);
  const byHour = new Map(filtered.map(r => [Date.parse(r.source_hour), r])); const points = [];
  for (let t = start; t <= end; t += 3600000) { const row = byHour.get(t); points.push(row ? `${((t-start)/(end-start))*100},${24-((Number(row.div_per_100k_gold)-min)/span)*20}` : ''); }
  const segments = []; let seg = []; for (const p of points) { if (p) seg.push(p); else if (seg.length) { segments.push(seg.join(' ')); seg=[]; } } if (seg.length) segments.push(seg.join(' '));
  return `<svg class="sparkline" viewBox="0 0 100 26" preserveAspectRatio="none" aria-label="Hourly signal history"><line x1="0" y1="${24-(0-min)/span*20}" x2="100" y2="${24-(0-min)/span*20}" class="zero-line"/>${segments.map(s => `<polyline points="${s}" />`).join('')}</svg>`;
}
function historySection(rows) {
  if (!rows.length) return '<section class="drawer-sec history"><h3>Signal History</h3><p class="drawer-note">INSUFFICIENT HISTORY · hourly observations are not available for this family.</p></section>';
  const first = rows[0], current = rows.at(-1), best = rows.reduce((a,b) => Number(b.div_per_100k_gold) > Number(a.div_per_100k_gold) ? b : a, first);
  const breakEven = rows.find((r,i) => i > 0 && Number(rows[i-1].div_per_100k_gold) > 0 && Number(r.div_per_100k_gold) <= 0);
  const rowDetail = r => `<tr><td>${esc(r.source_hour || '')}</td><td>${fmtInt(r.buy_pay_units)} → ${fmtInt(r.buy_receive_units)}</td><td>${fmtInt(r.sell_pay_units)} → ${fmtInt(r.sell_receive_units)}</td><td>${fmtInt(r.return_pay_units)} → ${fmtInt(r.return_receive_units)}</td><td>${fmtInt(r.buy_gold)} / ${fmtInt(r.sell_gold)} / ${fmtInt(r.return_gold)}</td></tr>`;
  return `<section class="drawer-sec history"><h3>Signal History · hourly resolution</h3><div class="history-status"><b>${esc(current.status || 'INSUFFICIENT HISTORY')}</b><span>${rows.length} observations · gaps preserved</span></div><div class="history-grid"><div><small>First Detected</small><b>${rateFmt(first.div_per_100k_gold)}</b><span>${esc(first.source_hour || '')}</span></div><div><small>Current</small><b>${rateFmt(current.div_per_100k_gold)}</b><span>${esc(current.source_hour || '')}</span></div><div><small>Best</small><b>${rateFmt(best.div_per_100k_gold)}</b><span>${esc(best.source_hour || '')}</span></div><div><small>Break-even</small><b>${breakEven ? rateFmt(breakEven.div_per_100k_gold) : '—'}</b><span>${breakEven ? esc(breakEven.source_hour || '') : 'Not reached'}</span></div></div><div class="chart-switch"><button type="button" data-history-hours="24">24 hours</button><button type="button" data-history-hours="168">7 days</button></div><div class="history-chart">${chartPoints(rows,24)}</div><table class="history-legs"><thead><tr><th>Source hour</th><th>Buy</th><th>Sell</th><th>Return</th><th>Gold fees (each leg)</th></tr></thead><tbody>${rows.map(rowDetail).join('')}</tbody></table><p class="drawer-note">Missing hours are gaps, not zeroes. Gold remains separate from currency profit. Original and current three-leg observations retain exact quantities, rates, volumes and fees.</p></section>`;
}
function cycleRows() { return (run?.routes || []).filter(r => r.cycle?.closed && r.cycle?.executable); }
function mtmRows() { return (run?.routes || []).filter(r => r.flip && r.strategy === 'two-leg-cross'); }
const bankrollFor = s => Number(bankroll[shortName(s?.flow?.startCurrency || '')] ?? 0) || 0;

// Gold efficiency MUST come from the same plan as Net. Deriving it from the
// midpoint spread while Net came from the conservative round trip is how a row
// showed "30.64 Div / 100K" next to "-30 Chaos": two different price models in
// adjacent columns, which is exactly what the three-figure separation exists to
// forbid. Valuing the plan's own net in Divine keeps one model per row.
function planDivPer100k(s, plan) {
  if (!plan || plan.net == null || !(plan.gold > 0)) return null;
  const perStart = Number(s?.flow?.startDivinePrice);
  if (!Number.isFinite(perStart) || perStart <= 0) return null;
  return (plan.net * perStart) / plan.gold * 100000;
}
const spreadOf = s => Number(s?.priceModel?.twoLegSpreadPct ?? 0);
const divGoldOf = s => Number(s?.spreadDivPer100kGold ?? s?.estimatedDivPer100kGold ?? -Infinity);
const goldOf = s => Number(s?.goldVerified ? s.totalGold : s?.estimatedTotalGold ?? Infinity);
const isConfirmed = s => s?.classification === 'return-confirmed';

// Default order, in the product's words: return-confirmed and profitable first,
// then gold efficiency, then the lighter liquidity footprint, then depth, then
// the raw spread. Ranking never reads targetBidPotentialPct.
const AGREEMENT_RANK = { confirmed: 4, close: 3, 'single-source': 2, diverging: 1, conflicting: 0, undefined: 2 };
// Profit at the size you would actually trade. Every sort is layered on top of
// this, because no ordering — not gold efficiency, not volume — should ever put
// a trade that loses money above one that makes it.
const profits = r => Number(r._plan?.net ?? -Infinity) > 0;

// When one hour's ratios span this much, its midpoint is not a price. The
// Omen markets routinely print 1 Divine : 3 items and 1 Divine : 26 items in
// the same hour, which is what inflates a midpoint spread to +310%.
const WILD_RANGE_PCT = 80;
const wildRange = s => Number(s?.ratioRangePct ?? 0) > WILD_RANGE_PCT;

// ---------------------------------------------------------------------------
// Bankroll sizing.
//
// A row arrives sized to whatever batch the scanner picked. That is useless if
// you hold 4,000 Exalted and the row is quoted in 17. Re-running the same three
// conservative ratios against the amount actually held turns every row into a
// plan you can execute, and exposes the two things that decide whether you
// should: how much of the hour's volume your order would eat, and how much gold
// it burns.
//
// The ratios come from the server-side flow (want / have per step) and are the
// Plan / Fill boundary — the same conservative prices the published numbers use.
// ---------------------------------------------------------------------------
const stepRate = step => (step && step.haveUnits > 0 ? step.wantUnits / step.haveUnits : 0);
const stepGoldPerUnit = (step, fallback) =>
  step && step.goldCost != null && step.wantUnits > 0 ? step.goldCost / step.wantUnits : fallback;

/** Share of an hour's item volume a single order may claim before it stops
 *  being a plan and becomes a wish. Matches the scanner's own liquidity cap. */
const MARKET_SHARE_CAP = 0.2;

function scaleFlow(s, bankroll) {
  const flow = s?.flow;
  if (!flow || !Array.isArray(flow.steps) || flow.steps.length < 3) return null;
  const [buyStep, sellStep, backStep] = flow.steps;
  const buyRate = stepRate(buyStep), sellRate = stepRate(sellStep), backRate = stepRate(backStep);
  if (!(buyRate > 0) || !(sellRate > 0) || !(backRate > 0)) return null;

  const stake = Math.max(1, Math.floor(Number(bankroll) || 0));
  // Telling someone their 4,000 Exalted "will not fill" is not advice. Cap the
  // order at the slice of the hour this market can absorb and say so; the rest
  // of the stake is free for other rows.
  const affordable = s.itemHourlyVolume > 0
    ? Math.floor((s.itemHourlyVolume * MARKET_SHARE_CAP) / buyRate)
    : Infinity;
  const ceiling = Math.max(1, Math.min(stake, affordable));

  // Quantities on the Exchange are whole units, and every leg floors. Scaling
  // naively to the ceiling throws that remainder away: 378 Exalted buys 126
  // Baubles which floor to 1 Divine, losing 30% to rounding alone. So size from
  // the OUTPUT backwards — pick the largest whole number of sell-currency units
  // reachable within the ceiling, then buy exactly what that needs.
  const maxOut = Math.floor(ceiling * buyRate * sellRate);
  let start = ceiling;
  if (maxOut >= 1) {
    const items = Math.ceil(maxOut / sellRate);
    const needed = Math.ceil(items / buyRate);
    if (needed >= 1 && needed <= ceiling) start = needed;
  }

  const fallbackGold = Number(s.estimatedGoldPerUnknownUnit) || 0;
  // Fees are charged per unit received, and the three steps receive, in order,
  // the item, the sell currency, then the starting currency back. Resolution is
  // guarded: if the fee table has not loaded, the server's own figures decide,
  // exactly as they did before the operator table existed.
  const feeModule = typeof GoldFees !== 'undefined' ? GoldFees : null;
  const feeTable = typeof goldFees !== 'undefined' ? goldFees : null;
  const receives = [s.item, s.sellCurrency, s.buyCurrency];
  let units = start, gold = 0, goldKnown = true, usesOperatorFee = false;
  const steps = [];
  for (const [index, step] of flow.steps.entries()) {
    const receive = Math.floor(units * stepRate(step));
    const resolved = feeModule && feeTable && receives[index]
      ? feeModule.resolveFee(receives[index], feeTable)
      : null;
    let perUnit;
    if (resolved && resolved.verified) {
      // An operator fee is knowledge the server did not have.
      perUnit = resolved.cost;
      if (resolved.source === 'user-verified') usesOperatorFee = true;
    } else {
      // A missing fee is still missing: estimate, and keep it flagged.
      perUnit = stepGoldPerUnit(step, fallbackGold);
      if (resolved || step.goldCost == null) goldKnown = false;
    }
    gold += receive * perUnit;
    steps.push({ action: step.action, have: units, haveCurrency: step.haveCurrency, want: receive, wantCurrency: step.wantCurrency });
    units = receive;
    if (units <= 0) break;
  }
  const closed = steps.length === flow.steps.length && units > 0;
  const itemUnits = steps[0]?.want ?? 0;
  const share = s.itemHourlyVolume > 0 ? itemUnits / s.itemHourlyVolume : Infinity;
  return {
    start, stake, capped: Number.isFinite(affordable) && affordable < stake,
    steps, closed,
    final: closed ? units : null,
    net: closed ? units - start : null,
    netPct: closed && start > 0 ? (units / start - 1) * 100 : null,
    gold: Math.round(gold), goldKnown, usesOperatorFee,
    volumeShare: share,
    tooThin: !closed,
  };
}


// ---------------------------------------------------------------------------
// Bankroll sizing.
//
// A row arrives sized to whatever batch the scanner picked. That is useless if
// you hold 4,000 Exalted and the row is quoted in 17. Re-running the same three
// conservative ratios against the amount actually held turns every row into a
// plan you can execute, and exposes the two things that decide whether you
// should: how much of the hour's volume your order would eat, and how much gold
// it burns.
//
const SCANNER_COLUMN_SORTS = {
  default: (a, b) =>
    (isConfirmed(b.discovery) ? 1 : 0) - (isConfirmed(a.discovery) ? 1 : 0)
    || Number(b._divGold ?? -Infinity) - Number(a._divGold ?? -Infinity)
    || Number(a._plan?.volumeShare ?? Infinity) - Number(b._plan?.volumeShare ?? Infinity)
    || Number(b.discovery.itemHourlyVolume || 0) - Number(a.discovery.itemHourlyVolume || 0)
    || spreadOf(b.discovery) - spreadOf(a.discovery),
  net: (a, b) => Number(b._plan?.netPct ?? -Infinity) - Number(a._plan?.netPct ?? -Infinity),
  spread: (a, b) => spreadOf(b.discovery) - spreadOf(a.discovery),
  divgold: (a, b) => Number(b._divGold ?? -Infinity) - Number(a._divGold ?? -Infinity),
  volume: (a, b) => Number(b.discovery.itemHourlyVolume || 0) - Number(a.discovery.itemHourlyVolume || 0),
  gold: (a, b) => Number(a._plan?.gold ?? Infinity) - Number(b._plan?.gold ?? Infinity),
  fresh: (a, b) => String(b.discovery.sourceHourUtc || '').localeCompare(String(a.discovery.sourceHourUtc || '')),
  // Best-corroborated first: two agreeing sources beat one, and a conflict sinks.
  sources: (a, b) => AGREEMENT_RANK[b.discovery.sourceCheck?.agreement] - AGREEMENT_RANK[a.discovery.sourceCheck?.agreement],
};

// Whatever column is chosen, a losing round trip never outranks a winning one.
const SCANNER_SORTS = Object.fromEntries(Object.entries(SCANNER_COLUMN_SORTS).map(([key, compare]) =>
  [key, (a, b) => ((profits(b) ? 1 : 0) - (profits(a) ? 1 : 0)) || compare(a, b)]));

function scannerRows() {
  const minVolume = Number($('#minVolume')?.value || 0);
  const minSpread = Number($('#minSpread')?.value || 0);
  const maxGold = Number($('#maxGold')?.value || 0);
  const hideHighRisk = Boolean($('#hideHighRisk')?.checked);
  const preset = FLOW_PRESETS[flowPreset] || FLOW_PRESETS.all;
  const hideLosers = $('#hideLosers') ? $('#hideLosers').checked : true;
  return (run?.routes || []).filter(r => r.discovery).map(r => {
    // Size once per render; filter, sort and every cell read the same plan.
    r._plan = scaleFlow(r.discovery, bankrollFor(r.discovery));
    r._divGold = planDivPer100k(r.discovery, r._plan);
    return r;
  }).filter(r => {
    if (!window.POE2_DEMO_DATA && !hasPriceModel(r)) return false;
    const s = r.discovery;
    // Not a user filter: a stored signal this thin or this extreme is a data
    // fault, and no toggle should be able to put it back on the board.
    if (!isCredibleSignal(s)) return false;
    if (!preset.match(s)) return false;
    if (search && !`${s.item.name} ${s.buyCurrency.name} ${s.sellCurrency.name}`.toLowerCase().includes(search)) return false;
    if (Number(s.itemHourlyVolume || 0) < minVolume) return false;
    if (spreadOf(s) < minSpread) return false;
    if (hideHighRisk && s.classification === 'high-risk') return false;
    // A round trip that ends with less than it started is not an opportunity.
    // Listing it as a candidate is how "52 Chaos in, 22 Chaos out" reached the
    // top of the table; it stays available behind the toggle, not by default.
    if (hideLosers && !(Number(r._plan?.net ?? -Infinity) > 0)) return false;
    if (s.goldVerified && maxGold > 0 && Number(s.totalGold || 0) > maxGold) return false;
    return true;
  }).sort(SCANNER_SORTS[scannerSort] || SCANNER_SORTS.default);
}
function rows() { return tab === 'scanner' ? scannerRows() : tab === 'closed' ? cycleRows() : mtmRows(); }
// Scanner headers are sortable; the key is the SCANNER_SORTS entry to apply.
const SCANNER_HEAD = [
  ['Item', null],
  ['Round trip<small>start → item → sell → back</small>', null],
  ['Net', 'net'], ['Spread', 'spread'], ['Div / 100K', 'divgold'],
  ['Volume<small>per hour</small>', 'volume'], ['Gold', 'gold'],
  ['Sources<small>GGG vs poe.ninja</small>', 'sources'], ['Status', null],
];
const SCANNER_COLSPAN = SCANNER_HEAD.length;
function renderFlowPresets() {
  const host = $('#flowPresets'); if (!host) return;
  host.innerHTML = Object.entries(FLOW_PRESETS).map(([key, preset]) =>
    `<button type="button" class="${key === flowPreset ? 'active' : ''}" data-flow="${key}">${esc(preset.label)}</button>`).join('');
  host.querySelectorAll('[data-flow]').forEach(btn => btn.onclick = () => {
    flowPreset = btn.dataset.flow; saveSettings(); closeDrawer(); renderFlowPresets(); render();
  });
  const hint = $('#flowHint');
  if (hint) hint.textContent = (FLOW_PRESETS[flowPreset] || FLOW_PRESETS.all).hint;
}
function renderHeader() {
  $('#tabTitle').textContent = tab === 'scanner' ? 'Cross-currency flips' : tab === 'closed' ? 'Verified Closed Cycles' : 'Mark-to-Market Flips';
  $('#tabHint').textContent = tab === 'scanner'
    ? 'Same item, priced differently in two currency markets. Every row is measured back to the currency you started in. Ratios are shown as you type them in the Exchange: I WANT : I HAVE.'
    : tab === 'closed' ? 'Fully fee-verified, executable three-trade cycles only.' : 'Two-leg reference only—the return conversion is not included.';
  const headRow = document.querySelector('thead tr');
  if (tab === 'scanner') {
    headRow.innerHTML = SCANNER_HEAD.map(([label, key]) => key
      ? `<th class="sortable${scannerSort === key ? ' active' : ''}" data-sort="${key}" role="button" tabindex="0">${label}${scannerSort === key ? ' <span class="sort-caret">▼</span>' : ''}</th>`
      : `<th>${label}</th>`).join('');
    headRow.querySelectorAll('[data-sort]').forEach(th => {
      const apply = () => { scannerSort = scannerSort === th.dataset.sort ? 'default' : th.dataset.sort; saveSettings(); render(); };
      th.onclick = apply;
      th.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); apply(); } };
    });
    return;
  }
  const head = tab === 'closed'
    ? ['Trade cycle', 'Start → Final', 'Realized profit', 'Div / 100K Gold', 'Trades', 'Bottleneck', 'Total gold', 'Recommendation']
    : ['Item', 'Buy With / Path', 'Conservative P&L', 'Div / 100K Gold', 'Volume', 'Fill Risk', 'Gold', 'Trend', 'Recommendation'];
  headRow.innerHTML = head.map((h, i) => `<th class="${i === 3 ? 'sort-dg' : ''}">${h}</th>`).join('');
}
// The round trip, in one line, in the quantities the player will actually
// hold: 200 Ex -> 1,000 item -> 1 Div -> 300 Ex. The closing hop is drawn
// differently from the rest because converting back is the step people skip.
function flowChainHtml(s, plan) {
  const flow = s.flow;
  if (!flow) return '';
  const hop = (units, name, cls) =>
    `<span class="hop ${cls}"><b>${fmtInt(units)}</b> ${esc(shortName(name))}</span>`;
  // A hop that floors to zero is where the plan dies; render up to that point
  // and stop, rather than printing "0 Divine" as though it were a quantity.
  const raw = plan ? plan.steps : flow.steps.map(x => ({ want: x.wantUnits, wantCurrency: x.wantCurrency }));
  const dead = raw.findIndex(step => !((step.want ?? step.wantUnits) > 0));
  const steps = dead === -1 ? raw : raw.slice(0, dead);
  const startUnits = plan ? plan.start : flow.startUnits;
  const parts = [hop(startUnits, flow.startCurrency, 'start')];
  steps.forEach((step, i) => {
    const last = i === steps.length - 1;
    // Arrow and hop travel together; a line break must not strand an arrow.
    parts.push(`<span class="link"><i class="arrow" aria-hidden="true">→</i>`
      + hop(step.want ?? step.wantUnits, step.wantCurrency, last ? 'back' : 'mid') + `</span>`);
  });
  // Two different failures, and blaming the wrong one sends the player to fix
  // the wrong thing: a stake too small is theirs to change, a market too thin
  // within the volume cap is not.
  const sellName = esc(shortName(flow.steps[1].wantCurrency));
  const broken = plan && !plan.closed
    ? plan.capped
      ? `<small class="warn">this hour is too thin — ${pct(MARKET_SHARE_CAP, 0)} of its volume still buys less than one whole ${sellName}</small>`
      : `<small class="warn">${fmtInt(plan.stake)} ${esc(shortName(flow.startCurrency))} is not enough to reach one whole ${sellName}</small>`
    : plan && plan.capped
      ? `<small class="muted">sized to ${pct(MARKET_SHARE_CAP, 0)} of this hour's volume · ${fmtInt(plan.stake - plan.start)} ${esc(shortName(flow.startCurrency))} of your stake stays free</small>`
      : !flow.closesInStartCurrency && !plan
        ? '<small class="warn">no order size closes this loop inside the hour\u2019s volume</small>'
        : '';
  return `<div class="flow">${parts.join('')}</div>${broken}`;
}

// The three bids exactly as they are typed into the Exchange. They sit on
// their own line so the round trip above can stay one uninterrupted chain.
function bidStripHtml(s) {
  // Each bid is a button: the Exchange wants these two numbers typed in, so one
  // click puts them on the clipboard instead of making anyone transcribe.
  const bid = (label, range, fallback, wantName, haveName) => {
    const plain = compactRatioPlain(range, fallback, wantName, haveName);
    return `<button type="button" class="bid" data-copy="${esc(plain)}" title="Copy ${esc(plain)}">`
      + `<em>${label}</em>${esc(plain)}<span class="copy-hint" aria-hidden="true">⧉</span></button>`;
  };
  return `<div class="bid-strip"><span class="bid-lead">Type in Exchange · I want : I have</span>`
    + bid('Buy', s.buyRatioRange, s.buyRatio, s.item.name, s.buyCurrency.name)
    + bid('Sell', s.sellRatioRange, s.sellRatio, s.sellCurrency.name, s.item.name)
    + bid('Back', s.returnRatioRange, s.returnRatio, s.buyCurrency.name, s.sellCurrency.name)
    + `</div>`;
}

const ICON = item => item?.iconUrl
  ? `<img class="item-icon" src="${esc(item.iconUrl)}" alt="" loading="lazy" width="30" height="30" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'item-icon placeholder'}))">`
  : '<span class="item-icon placeholder" aria-hidden="true"></span>';

function netCellHtml(plan) {
  if (!plan || plan.net == null) return '<td class="num muted"><strong>—</strong><small>loop not closed</small></td>';
  const up = plan.net > 0;
  return `<td class="num ${up ? 'green' : 'red'}"><strong>${up ? '+' : ''}${fmtInt(plan.net)}</strong>`
    + `<small>${esc(shortName(plan.steps[0].haveCurrency))} · ${up ? '+' : ''}${fmt(plan.netPct)}%</small></td>`;
}

/** A 7-point poe.ninja history, drawn small enough to read at a glance. */
function sparkHtml(values, trendPct) {
  if (!Array.isArray(values) || values.length < 2) return '<small class="muted">no history</small>';
  const min = Math.min(...values), max = Math.max(...values), span = Math.max(1e-9, max - min);
  const points = values.map((v, i) => `${i / (values.length - 1) * 100},${14 - ((v - min) / span) * 12}`).join(' ');
  const dir = trendPct == null ? '' : trendPct > 0 ? 'up' : trendPct < 0 ? 'down' : '';
  return `<svg class="spark ${dir}" viewBox="0 0 100 16" preserveAspectRatio="none" aria-hidden="true"><polyline points="${points}"/></svg>`;
}

function sourceCellHtml(s) {
  const sc = s.sourceCheck;
  if (!sc) return '<td><span class="src single-source">GGG only</span></td>';
  const trend = sc.trendPct == null ? '' :
    `<small class="${sc.trendPct > 0 ? 'ok' : sc.trendPct < 0 ? 'warn' : ''}">${sc.trendPct > 0 ? '+' : ''}${fmt(sc.trendPct)}% 7d</small>`;
  const dev = sc.deviationPct == null ? 'poe.ninja has no price for this item'
    : `GGG ${fmt(sc.gggDivine)} div vs poe.ninja ${fmt(sc.ninjaDivine)} div · ${fmt(sc.deviationPct)}% apart`;
  return `<td class="cell-src" title="${esc(dev)}"><span class="src ${esc(sc.agreement)}">${esc(sc.agreementLabel)}</span>`
    + `${sparkHtml(sc.sparkline, sc.trendPct)}${trend}</td>`;
}

function scannerRowHtml(r) {
  const s = r.discovery;
  const plan = r._plan;
  const spread = spreadOf(s);
  const divGold = r._divGold == null ? '—' : fmt(r._divGold);
  const losing = plan && plan.net != null && plan.net <= 0;
  const goldLabel = !plan || !plan.goldKnown ? 'estimated' : plan.usesOperatorFee ? 'your fee' : 'verified';
  const gold = plan
    ? `<b>${plan.goldKnown ? '' : '~'}${fmtInt(plan.gold)}</b><small class="${plan.goldKnown ? (plan.usesOperatorFee ? 'own-fee' : '') : 'warn'}">${goldLabel}</small>`
    : `<b>—</b>`;
  // Short chip in the row, full wording on hover and in the drawer: the column
  // is scanned, not read, and the long form costs ~60px on every line.
  const SHORT_STATUS = {
    'return-confirmed': 'Confirmed', 'fee-check-needed': 'Fee check',
    'fee-confirmed-by-you': 'Your fee',
    'return-quote-available': 'Quote only', 'two-leg-spread': 'Spread only', 'high-risk': 'High risk',
  };
  // A losing plan is labelled as such regardless of how much of the equation is
  // proven: "Quote only" reads neutral next to a 58% loss.
  // Once the operator has supplied the missing fee the row is no longer waiting
  // on a fee check — but it is labelled with whose answer resolved it, and it
  // still does not enter the Verified Closed Cycles tab.
  const resolvedClass = s.classification === 'fee-check-needed' && plan && plan.goldKnown
    ? 'fee-confirmed-by-you'
    : (s.classification || 'two-leg-spread');
  const cls = losing ? 'loses' : resolvedClass;
  const status = losing
    ? `<span class="status loses" title="This round trip ends with less than it started, at the size you can trade">Loses money</span>`
    : `<span class="status ${esc(cls)}" title="${esc(cls === 'fee-confirmed-by-you' ? 'Closed cycle priced with the gold fee you entered, not a repo-verified one' : (s.classificationLabel || ''))}">${esc(SHORT_STATUS[cls] || s.classificationLabel || s.recommendation)}</span>`;
  return `<tr class="clickable lead" data-id="${esc(r.id)}">`
    + `<td class="cell-item">${ICON(s.item)}<span><b>${esc(s.item.name)}</b><small>${esc(shortName(s.buyCurrency.name))} → ${esc(shortName(s.sellCurrency.name))} → ${esc(shortName(s.buyCurrency.name))}</small></span></td>`
    + `<td class="cell-flow">${flowChainHtml(s, plan)}</td>`
    + netCellHtml(plan)
    + `<td class="num ${spread > 0 && !wildRange(s) ? 'green' : ''}"><strong>${spread > 0 ? '+' : ''}${fmt(spread)}%</strong>`
      + `<small class="${wildRange(s) ? 'warn' : ''}">${wildRange(s) ? `range ${fmt(s.ratioRangePct)}%` : 'midpoint'}</small></td>`
    + `<td class="num dg ${r._divGold != null && r._divGold < 0 ? 'red' : ''}"><strong>${divGold}</strong><small>${plan && plan.goldKnown ? (plan.usesOperatorFee ? 'your fees' : 'verified fees') : 'estimated fees'}</small></td>`
    + `<td class="num">${fmt(s.itemHourlyVolume)}<small class="${plan && plan.volumeShare > MARKET_SHARE_CAP + 1e-9 ? 'warn' : ''}">${plan ? pct(plan.volumeShare, 0) : pct(s.maxVolumeShare, 0)} share</small></td>`
    + `<td class="num">${gold}</td>`
    + sourceCellHtml(s)
    + `<td>${status}</td></tr>`
    + `<tr class="clickable bids" data-id="${esc(r.id)}"><td colspan="${SCANNER_COLSPAN}">${bidStripHtml(s)}</td></tr>`;
}

function closedRowHtml(r) {
  const c = r.cycle;
  const sellName = c.sellCurrency?.name || 'Divine Orb';
  const trade = `<div class="path"><b>BUY</b> ${fmtInt(c.buyLeg.pay)} ${esc(c.startCurrency.name)} → ${fmtInt(c.buyLeg.receive)} ${esc(c.item.name)}<br><b>SELL</b> ${fmtInt(c.sellLeg.pay)} ${esc(c.item.name)} → ${fmtInt(c.sellLeg.receive)} ${esc(sellName)}<br><b>RETURN</b> ${fmtInt(c.returnLeg.pay)} ${esc(sellName)} → ${fmtInt(c.returnLeg.receive)} ${esc(c.startCurrency.name)}</div>`;
  const expired = (Date.now() - Date.parse(c.sourceHourUtc)) / 3600000 > 24;
  return `<tr class="clickable" data-id="${esc(r.id)}"><td>${trade}</td><td><b>${fmtInt(c.startingQuantity)} → ${fmtInt(c.finalStartingQuantity)}</b> ${esc(c.startCurrency.name)}<small>${fmtInt(c.netRealizedProfitStart)} ${esc(c.startCurrency.name)} profit</small></td><td class="green"><strong>+${fmt(c.conservativeRealizedProfitStart)}</strong> ${esc(c.startCurrency.name)}<small>${fmt(c.conservativeRealizedProfitDivine)} Divine-equivalent</small></td><td class="dg"><strong>${fmt(c.realizedProfitPer100kGold)}</strong><small>per 100K gold</small></td><td>3</td><td>${fmt(c.bottleneckVolume)} / hr<small>${pct(c.maxVolumeShare)} max share</small></td><td>${fmtInt(c.totalGold)}</td><td><b>${expired ? 'EXPIRED' : 'TRADE NOW'}</b><small>${expired ? 'Last profitable observation' : 'Executable now'}</small></td></tr>`;
}
function mtmRowHtml(r) {
  const f = r.flip;
  const dg = f.divPer100kGold;
  return `<tr class="clickable" data-id="${esc(r.id)}"><td><b>${esc(f.item.name)}</b><small>${esc(f.buyCurrency.name)} → ${esc(f.sellCurrency.name)}</small></td><td>Pay <b>${fmtInt(f.buyLeg.pay)}</b> ${esc(f.buyCurrency.name)} → Get <b>${fmtInt(f.buyLeg.receive)}</b> ${esc(f.item.name)}<small>then sell ${fmtInt(f.sellLeg.pay)} for ${fmtInt(f.sellLeg.receive)} ${esc(f.sellCurrency.name)}</small></td><td class="green"><strong>+${fmt(f.conservativeNetProfitDivine)}</strong> Div<small>Mark-to-market only</small></td><td class="dg"><strong>${fmt(dg)}</strong><small>per 100K gold</small></td><td>${fmt(f.lowestLegVolume)} / hr</td><td>${risk(f.fillRiskLabel)}</td><td>${fmtInt(f.goldRequired)}</td><td>Insufficient history</td><td>WATCH</td></tr>`;
}

// ---------------------------------------------------------------------------
// Fees worth checking.
//
// The scanner will not call a cycle executable while any leg's gold fee is
// unverified, and only 14 fees ship verified — so on a normal hour the best
// rows on the board are all sitting behind a fee nobody has looked up. This
// panel turns that into a short, ranked errand list: check this fee in game,
// type it once, and every row using that item re-prices for good.
function feeRowHtml(entry) {
  const identity = entry.identity;
  const current = goldFees[identity.id];
  return `<div class="fee-item">`
    + `<div class="fee-item-name">${ICON(identity)}<span><b>${esc(identity.name)}</b>`
      + `<small>unlocks ${entry.rows} ${entry.rows === 1 ? 'row' : 'rows'} · best ${fmt(entry.bestProfitPct)}% round trip</small></span></div>`
    + `<label class="fee-item-input">Gold per unit received`
      + `<input type="number" min="1" step="1" inputmode="numeric" placeholder="not set"`
        + ` data-fee-path="${esc(identity.id)}" value="${current == null ? '' : String(current)}">`
    + `</label>`
    + `</div>`;
}

function renderFeeQueue(scannerRowsThisPass) {
  const panel = $('#feePanel');
  if (!panel) return;
  if (tab !== 'scanner') { panel.hidden = true; return; }
  // Rank against the same filtered, credible population the table shows, so the
  // errand list can never point at a row the scanner would not display.
  const signals = (scannerRowsThisPass || scannerRows()).map(r => r.discovery).filter(Boolean);
  const items = GoldFees.missingFeeItems(signals, goldFees);
  panel.hidden = items.length === 0;
  if (!items.length) return;
  const best = items[0];
  $('#feeUnlockPill').textContent = `${items.length} ${items.length === 1 ? 'FEE' : 'FEES'} · BEST ${fmt(best.bestProfitPct)}%`;
  $('#feeQueue').innerHTML = items.slice(0, 8).map(feeRowHtml).join('');
  $('#feeQueue').querySelectorAll('[data-fee-path]').forEach(input => {
    input.onchange = () => {
      goldFees = GoldFees.setFee(goldFees, input.dataset.feePath, input.value);
      GoldFees.save(window.localStorage, goldFees);
      render();
    };
  });
}

function render() {
  if (!run) return;
  const flowBar = $('#flowBar');
  if (flowBar) flowBar.hidden = tab !== 'scanner';
  renderHeader();
  const rs = rows();
  // Rows produced before this build carry no priceModel and cannot be rendered
  // in the round-trip model. Say plainly that the data predates the dashboard
  // rather than implying a recalculation is under way — nothing is running.
  const staleRows = tab === 'scanner' && !window.POE2_DEMO_DATA
    ? (run?.routes || []).filter(r => r.discovery && !hasPriceModel(r))
    : [];
  // Signals the ingest published but the credibility gate suppressed. Told
  // apart from user filters so the empty state does not send Chuck to widen
  // filters that would not have brought these back anyway.
  const suppressedRows = tab === 'scanner'
    ? (run?.routes || []).filter(r => r.discovery && hasPriceModel(r) && !isCredibleSignal(r.discovery))
    : [];
  const staleVersion = staleRows[0]?.algorithmVersion || run?.status?.algorithm_version || null;
  const staleNotice = `<b>Waiting on the next hourly ingest.</b><span>This dashboard reads the round-trip model, and the ${staleRows.length} stored ${staleRows.length === 1 ? 'signal was' : 'signals were'} produced by the previous scanner${staleVersion ? ` (<code>${esc(staleVersion)}</code>)` : ''}. Nothing is wrong with the data — the hourly ingestion just has not run with this version yet. Old best-case percentages stay hidden rather than being shown as if they were comparable.</span>`;
  $('#routes').innerHTML = rs.length ? rs.map(r => tab === 'scanner' ? scannerRowHtml(r) : tab === 'closed' ? closedRowHtml(r) : mtmRowHtml(r)).join('') : `<tr><td colspan="${tab === 'scanner' ? SCANNER_COLSPAN : 9}" class="empty">${staleRows.length ? `<div class="empty-notice">${staleNotice}</div>` : tab === 'scanner' ? (suppressedRows.length ? `<div class="empty-notice"><b>${suppressedRows.length} stored ${suppressedRows.length === 1 ? 'signal was' : 'signals were'} held back as untradeable.</b><span>They quote markets that traded fewer than ${MIN_ITEM_HOURLY_VOLUME} units in the hour, or a spread too wide for the two markets to be pricing the same item. A single trade in a dead market is not a price, so these are not shown at any filter setting. The next hourly ingest may surface real ones.</span></div>` : `No ${esc((FLOW_PRESETS[flowPreset] || FLOW_PRESETS.all).label)} signals match these filters. Switch to All paths, or lower Min spread / Min volume.`) : tab === 'closed' ? 'No fully verified closed cycles this hour. Check Market Scanner for paths that need a live gold-fee check.' : 'No executable mark-to-market flips this hour.'}</td></tr>`;
  $('#count').textContent = String(rs.length);
  $('#verifiedCount').textContent = String(rs.filter(r => tab === 'scanner' ? isConfirmed(r.discovery) : tab === 'closed').length);
  $('#unknownCount').textContent = String(rs.filter(r => tab === 'scanner' && !(r._plan && r._plan.goldKnown)).length);
  renderFeeQueue(tab === 'scanner' ? rs : null);
  // Copying a bid must not also open the drawer.
  document.querySelectorAll('#routes [data-copy]').forEach(btn => {
    btn.onclick = async event => {
      event.stopPropagation();
      try {
        await navigator.clipboard.writeText(btn.dataset.copy);
        btn.classList.add('copied');
        setTimeout(() => btn.classList.remove('copied'), 900);
      } catch {
        // Clipboard denied (insecure context or permission): select the text so
        // it can still be copied by hand rather than silently failing.
        const range = document.createRange();
        range.selectNodeContents(btn);
        const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
      }
    };
  });
  document.querySelectorAll('#routes tr.clickable').forEach(tr => {
    // Scanner opportunities render as a lead row plus a bid strip. Only the
    // lead row takes focus, so tabbing moves one stop per opportunity.
    const isStrip = tr.classList.contains('bids');
    if (!isStrip) { tr.tabIndex = 0; tr.setAttribute('role', 'button'); }
    const activate = () => {
      lastFocusedRow = isStrip ? tr.previousElementSibling : tr;
      openDrawer(rs.find(x => String(x.id) === String(tr.dataset.id)));
    };
    tr.onclick = activate;
    if (!isStrip) tr.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); } };
  });
}
function scannerDrawer(s) {
  const ret = s.returnLeg;
  const fee = leg => leg.goldVerified ? fmtInt(leg.goldCost) : 'Unknown—verify in game';
  const goldValue = s.goldVerified ? fmtInt(s.totalGold) : `~${fmtInt(s.estimatedTotalGold)} estimated`;
  const divGold = s.spreadDivPer100kGold == null ? '—' : fmt(s.spreadDivPer100kGold);
  const defaultItemFee = s.buyLeg.goldVerified && s.buyLeg.receive > 0 ? s.buyLeg.goldCost / s.buyLeg.receive : (s.estimatedGoldPerUnknownUnit || 1000);
  const flow = s.flow;
  // The round trip leads the drawer: three numbered steps in Exchange
  // vocabulary (you HAVE this, you WANT that), then what you are left with.
  const STEP_TITLES = { buy: 'Buy the item', sell: 'Sell the item', convert: 'Convert back to your starting currency' };
  const STEP_RANGE = {
    buy: [s.buyRatioRange, s.buyRatio, s.item.name, s.buyCurrency.name],
    sell: [s.sellRatioRange, s.sellRatio, s.sellCurrency.name, s.item.name],
    convert: [s.returnRatioRange, s.returnRatio, s.buyCurrency.name, s.sellCurrency.name],
  };
  const stepHtml = (step, index) => {
    const [range, fallback, wantName, haveName] = STEP_RANGE[step.action];
    return `<li class="flow-step ${esc(step.action)}"><span class="step-n">${index + 1}</span>`
      + `<div class="step-body"><b>${esc(STEP_TITLES[step.action])}</b>`
      + `<div class="have-want"><span>Have <strong>${fmtInt(step.haveUnits)}</strong> ${esc(step.haveCurrency)}</span>`
      + `<i aria-hidden="true">→</i><span>Want <strong>${fmtInt(step.wantUnits)}</strong> ${esc(step.wantCurrency)}</span></div>`
      + `<div class="step-bid">${ratioLadder('', range, fallback, wantName, haveName)}</div>`
      + `<small class="step-gold">Exchange fee: ${step.goldCost == null ? 'unknown — verify in game' : `${fmtInt(step.goldCost)} gold`}</small>`
      + `</div></li>`;
  };
  const netClass = flow?.netUnits == null ? 'muted' : flow.netUnits > 0 ? 'green' : 'red';
  const roundTrip = `<section class="drawer-sec roundtrip"><h3>The round trip</h3>`
    + `<p class="drawer-note"><strong>Snapshot: ${esc(sourceAgeText(s.sourceHourUtc))}.</strong> Target Bid is the favorable completed-hour reference for the Competing Trades side — where you post and wait. Plan / Fill is the safer boundary the numbers use. Confirm the live ladder in game; the official API does not expose it.</p>`
    + `<ol class="flow-steps">${(flow?.steps || []).map(stepHtml).join('')}</ol>`
    + `<div class="flow-outcome"><div><small>You start with</small><b>${fmtInt(flow?.startUnits)} ${esc(shortName(flow?.startCurrency || ''))}</b></div>`
    + `<div><small>You end with</small><b>${flow?.finalUnits == null ? '—' : `${fmtInt(flow.finalUnits)} ${esc(shortName(flow.startCurrency))}`}</b></div>`
    + `<div class="${netClass}"><small>Net</small><b>${flow?.netUnits == null ? 'Loop not closed' : `${flow.netUnits > 0 ? '+' : ''}${fmtInt(flow.netUnits)} ${esc(shortName(flow.startCurrency))}`}</b></div>`
    + `<div><small>Total gold</small><b>${flow?.totalGold == null ? `~${fmtInt(flow?.estimatedTotalGold)} est.` : fmtInt(flow.totalGold)}</b></div>`
    + `<div><small>Liquidity</small><b>${esc(s.liquidityLabel || '—')}</b></div></div>`
    + (flow?.closesInStartCurrency ? '' : `<p class="drawer-note warn">No integer order size closes this loop inside the observed hourly volume. The prices are real; the plan is not sized.</p>`)
    + `</section>`;
  const model = s.priceModel || {};
  const confirmed = model.returnConfirmedCyclePct;
  // Three figures, three separate rows, each labeled for what it actually is.
  // Presenting them together is the point: the gap between them IS the risk.
  const figures = `<section class="drawer-sec figures"><h3>Three separate figures</h3><table class="detail"><tr><td><b>Two-leg spread</b><small>Item mispricing between the two currency markets, every leg at its completed-hour midpoint. Discovery metric — gold excluded.</small></td><td class="${spreadOf(s) > 0 ? 'green' : ''}">${fmt(spreadOf(s))}%</td></tr><tr><td><b>Target-bid potential</b><small class="warn">What this path would return if every favorable posted bid filled. POTENTIAL, not executable profit: those prices may have occurred at different moments in the hour.</small></td><td class="muted">${model.targetBidPotentialPct == null ? '—' : `${fmt(model.targetBidPotentialPct)}%`}</td></tr><tr><td><b>Return-confirmed cycle</b><small>Exact integer sizing at the least-favorable observed boundary on all three legs, with all three gold fees. The only figure that may be called a closed cycle.</small></td><td class="${confirmed != null && confirmed > 0 ? 'green' : 'warn'}">${confirmed == null ? 'Not proven this hour' : `${fmt(confirmed)}%`}</td></tr></table><p class="drawer-note"><strong>Status: ${esc(s.classificationLabel || '')}.</strong> ${esc(s.warning || 'Re-enter all three ratios in the live Exchange before placing orders; this is completed-hour data.')}</p></section>`;
  const ocr = `<section class="drawer-sec gold-ocr"><h3>Confirm the gold fee from your screenshot</h3><p class="drawer-note">Paste or upload a crop showing the gold fee. OCR runs in your browser and suggests numbers; confirm the correct per-item fee before applying it.</p><input class="ocr-file" type="file" accept="image/*"><button type="button" class="ocr-read">Read screenshot</button><div class="ocr-status muted">No screenshot selected.</div><div class="ocr-candidates"></div><label>Gold per ${esc(s.item.name)} received<input class="ocr-fee" type="number" min="1" step="1" value="${fmtInt(defaultItemFee).replace(/,/g,'')}"></label><button type="button" class="ocr-apply">Apply confirmed fee</button><div class="ocr-result"></div></section>`;
  return `<header class="drawer-head"><div class="item-lockup">${ICON(s.item)}<span><strong>${esc(s.item.name)}</strong><small>${esc(shortName(s.buyCurrency.name))} → ${esc(shortName(s.sellCurrency.name))} → ${esc(shortName(s.buyCurrency.name))}</small></span></div><button class="close" aria-label="Close">×</button></header>${roundTrip}${figures}<section class="drawer-sec"><h3>Sizing and cost</h3><table class="detail"><tr><td>Start → final</td><td>${s.finalStartingQuantity == null ? `${fmtInt(s.startingQuantity)} ${esc(s.buyCurrency.name)} — no closing size fits this hour's volume` : `${fmtInt(s.startingQuantity)} → ${fmtInt(s.finalStartingQuantity)} ${esc(s.buyCurrency.name)}`}</td></tr><tr><td>Divine-equivalent profit</td><td>${s.estimatedProfitDivine == null ? '—' : `~${fmt(s.estimatedProfitDivine)} Divine`}</td></tr><tr><td>${s.goldVerified ? 'Total gold' : 'Estimated total gold'}</td><td id="drawerGold">${goldValue}</td></tr><tr><td>${s.goldVerified ? 'Div / 100K Gold' : 'Estimated Div / 100K Gold'}</td><td class="dg" id="drawerDivGold"><strong>${divGold}</strong></td></tr><tr><td>Fee estimate basis</td><td>${esc(s.goldEstimateBasis || 'All fees verified')}</td></tr><tr><td>Known leg fees</td><td>Buy ${fee(s.buyLeg)} · Sell ${fee(s.sellLeg)} · Return ${ret ? fee(ret) : '—'}</td></tr><tr><td>Item volume</td><td>${fmt(s.itemHourlyVolume)} / hr</td></tr><tr><td>Maximum volume share</td><td>${pct(s.maxVolumeShare)}${s.closedCycleProfitPct == null ? ' — larger than the whole observed hour' : ''}</td></tr><tr><td>Estimated fill risk</td><td>${esc(s.fillRiskLabel)} (${pct(s.fillRisk)})<small class="muted">Heuristic from volume share, hourly ratio range and market depth. Not a guarantee.</small></td></tr><tr><td>Ratio-range uncertainty</td><td>${fmt(s.ratioRangePct)}%</td></tr><tr><td>Source hour</td><td>${esc(s.sourceHourUtc)}</td></tr></table></section>${ocr}`;
}

function wireGoldOcr(s, body) {
  const section = body.querySelector('.gold-ocr'); if (!section) return;
  const file = section.querySelector('.ocr-file'), status = section.querySelector('.ocr-status');
  const candidates = section.querySelector('.ocr-candidates'), feeInput = section.querySelector('.ocr-fee');
  const read = async selected => {
    if (!selected) { status.textContent = 'Choose or paste a screenshot first.'; return; }
    status.textContent = 'Reading screenshot locally…'; candidates.innerHTML = '';
    try {
      const result = await window.POE2GoldOCR.recognize(selected, p => { if (p.status) status.textContent = `${p.status}${p.progress ? ` · ${Math.round(p.progress*100)}%` : ''}`; });
      status.textContent = result.text ? 'OCR complete—select or type the correct gold fee.' : 'No text found. Crop closer around the gold fee and retry.';
      candidates.innerHTML = result.candidates.map(n => `<button type="button" data-ocr-value="${n}">${fmtInt(n)}</button>`).join('');
      candidates.querySelectorAll('button').forEach(b => b.onclick = () => { feeInput.value = b.dataset.ocrValue; });
    } catch (error) { status.textContent = `OCR failed: ${error.message || error}`; }
  };
  section.querySelector('.ocr-read').onclick = () => read(file.files?.[0]);
  section.onpaste = event => { const image = [...(event.clipboardData?.items || [])].find(i => i.type.startsWith('image/'))?.getAsFile(); if (image) read(image); };
  section.querySelector('.ocr-apply').onclick = () => {
    const perItem = Number(feeInput.value); if (!Number.isFinite(perItem) || perItem <= 0) return;
    const knownOtherGold = Number(s.sellLeg.goldCost || 0) + Number(s.returnLeg?.goldCost || 0);
    const total = knownOtherGold + Number(s.buyLeg.receive || 0) * perItem;
    const dg = s.spreadProfitDivine == null || total <= 0 ? null : Number(s.spreadProfitDivine) / total * 100000;
    body.querySelector('#drawerGold').textContent = `${fmtInt(total)} (OCR/manual)`;
    body.querySelector('#drawerDivGold strong').textContent = dg == null ? '—' : fmt(dg);
    section.querySelector('.ocr-result').innerHTML = `<b>Updated estimate:</b> ${dg == null ? 'Divine conversion unavailable' : `${fmt(dg)} Div / 100K Gold`} using ${fmtInt(total)} total gold. Confirm the in-game fee visually.`;
  };
}
function cycleDrawer(c) {
  const sellName = c.sellCurrency?.name || 'Divine Orb';
  const step = (n, title, leg, payName, receiveName) => `<li><b>Step ${n} — ${title}</b><br>Pay <strong>${fmtInt(leg.pay)}</strong> ${esc(payName)} → receive <strong>${fmtInt(leg.receive)}</strong> ${esc(receiveName)}<br>Gold: <strong>${fmtInt(leg.goldCost)}</strong> · Volume: ${fmt(leg.hourlyVolume)} / hr</li>`;
  return `<header class="drawer-head"><div class="item-lockup"><strong>Closed Cycle · ${esc(c.item.name)}</strong><small>${esc(c.startCurrency.name)} → ${esc(c.startCurrency.name)} · 3 trades</small></div><button class="close" aria-label="Close">×</button></header><section class="drawer-sec playbook"><h3>Exact three-step playbook</h3><ol>${step(1,'Buy the item',c.buyLeg,c.startCurrency.name,c.item.name)}${step(2,`Sell the same item for ${sellName}`,c.sellLeg,c.item.name,sellName)}${step(3,`Convert ${sellName} back to starting currency`,c.returnLeg,sellName,c.startCurrency.name)}</ol></section><section class="drawer-sec"><h3>Closed-cycle result</h3><table class="detail"><tr><td>Starting ${esc(c.startCurrency.name)}</td><td>${fmtInt(c.startingQuantity)}</td></tr><tr><td>Final ${esc(c.startCurrency.name)}</td><td>${fmtInt(c.finalStartingQuantity)}</td></tr><tr><td>Realized ${esc(c.startCurrency.name)} profit</td><td class="green">+${fmt(c.netRealizedProfitStart)}</td></tr><tr><td>Conservative ${esc(c.startCurrency.name)} profit</td><td class="green">+${fmt(c.conservativeRealizedProfitStart)}</td></tr><tr><td>Divine-equivalent realized profit</td><td>${fmt(c.conservativeRealizedProfitDivine)} Divine</td></tr><tr><td>Total gold, all 3 legs</td><td>${fmtInt(c.totalGold)}</td></tr><tr><td>Div / 100K Gold</td><td>${fmt(c.realizedProfitPer100kGold)}</td></tr><tr><td>Trades</td><td>3</td></tr><tr><td>Conservative realized ROI</td><td>${fmt(c.capitalRoiPct)}%</td></tr><tr><td>Residual inventory</td><td>${fmtInt(c.leftoverStartingCurrency)} ${esc(c.startCurrency.name)}</td></tr></table></section><section class="drawer-sec"><h3>Return-leg disclosure</h3><table class="detail"><tr><td>Return rate</td><td>${fmtInt(c.returnLeg.pay)} ${esc(sellName)} → ${fmtInt(c.returnLeg.receive)} ${esc(c.startCurrency.name)}</td></tr><tr><td>Return-leg volume</td><td>${fmt(c.returnLeg.hourlyVolume)} / hr</td></tr><tr><td>Return-leg volume share</td><td>${pct(c.maxVolumeShare)}</td></tr><tr><td>Source age</td><td>${esc(c.sourceHourUtc)} UTC</td></tr><tr><td>Risk</td><td>${fmt(c.movementHaircutPct)}% movement / ${fmt(c.marketImpactHaircutPct)}% impact</td></tr></table></section>`;
}
function mtmDrawer(f) {
  return `<header class="drawer-head"><div class="item-lockup"><strong>${esc(f.item.name)}</strong><small>${esc(f.buyCurrency.name)} → ${esc(f.sellCurrency.name)}</small></div><button class="close" aria-label="Close">×</button></header><section class="drawer-sec playbook"><h3>Mark-to-market playbook</h3><ol><li>Pay ${fmtInt(f.buyLeg.pay)} ${esc(f.buyCurrency.name)} → receive ${fmtInt(f.buyLeg.receive)} ${esc(f.item.name)}. Gold: ${fmtInt(f.buyLeg.goldCost)}</li><li>Pay ${fmtInt(f.sellLeg.pay)} ${esc(f.item.name)} → receive ${fmtInt(f.sellLeg.receive)} ${esc(f.sellCurrency.name)}. Gold: ${fmtInt(f.sellLeg.goldCost)}</li></ol><p class="drawer-note"><strong>Ends in another currency — return conversion not included.</strong> This is not realized profit and cannot receive TRADE NOW.</p></section><section class="drawer-sec"><table class="detail"><tr><td>Conservative Divine-equivalent profit</td><td>${fmt(f.conservativeNetProfitDivine)} Div</td></tr><tr><td>Div / 100K Gold</td><td>${fmt(f.divPer100kGold)}</td></tr><tr><td>Total gold</td><td>${fmtInt(f.goldRequired)}</td></tr></table></section>`;
}
function openDrawer(r) { const body = $('#drawerInner'); body.innerHTML = (tab === 'scanner' ? scannerDrawer(r.discovery) : tab === 'closed' ? cycleDrawer(r.cycle) : mtmDrawer(r.flip)) + historySection(historyFor(r)); $('#drawer').classList.add('open'); $('#drawer').setAttribute('aria-hidden','false'); $('#scrim').hidden = false; body.querySelector('.close').onclick = closeDrawer; if (tab === 'scanner') wireGoldOcr(r.discovery, body); body.querySelectorAll('[data-history-hours]').forEach(btn => btn.onclick = () => { const history = historyFor(r); body.querySelector('.history-chart').innerHTML = chartPoints(history, Number(btn.dataset.historyHours)); body.querySelectorAll('[data-history-hours]').forEach(x => x.classList.toggle('active', x === btn)); }); }
function closeDrawer() { $('#drawer').classList.remove('open'); $('#drawer').setAttribute('aria-hidden','true'); $('#scrim').hidden = true; if (lastFocusedRow) lastFocusedRow.focus(); }
function renderStatus(status) { const hour = status?.latest_successful_source_hour; $('#sourceAge').textContent = hour ? `Market hour ${hour.replace('T',' ').slice(0,16)} UTC` : 'No completed ingestion yet'; $('#age').textContent = hour ? window.POE2CurrencyRates.ageLabel(hour) : '—'; $('#completedAt').textContent = status?.completed_at ? `Fetched ${String(status.completed_at).replace('T',' ').slice(0,16)} UTC` : '—'; }
async function load() { if (window.POE2_DEMO_DATA) { run = { routes: (window.POE2_DEMO_DATA.routes || []).map(normalizeOpportunityRow), status: window.POE2_DEMO_DATA.status }; currencyRates = window.POE2_DEMO_DATA.currencyRates || []; historyRows = window.POE2_DEMO_DATA.history || []; renderStatus(run.status); renderCurrencyRates(); render(); return; } const url = window.POE2_SUPABASE_URL || ''; const key = window.POE2_SUPABASE_PUBLISHABLE_KEY || ''; if (!url || !key) { run = { routes: [], status: null }; currencyRates = []; historyRows = []; renderStatus(null); renderCurrencyRates(); render(); return; } const headers = { apikey: key, Authorization: `Bearer ${key}` }; const [s, o, rates, history] = await Promise.all([fetch(`${url}/rest/v1/opportunity_run_status?select=*`,{headers}), fetch(`${url}/rest/v1/opportunity_public?select=*&order=score.desc`,{headers}), fetch(`${url}/rest/v1/currency_rates_public?select=*&order=source_hour.desc`,{headers}), fetch(`${url}/rest/v1/signal_history_public?select=*&order=source_hour.asc`,{headers})]); const statusRows = s.ok ? await s.json() : []; const rowsResp = o.ok ? await o.json() : []; currencyRates = rates.ok ? await rates.json() : []; historyRows = history.ok ? await history.json() : []; run = { routes: (Array.isArray(rowsResp) ? rowsResp : []).map(normalizeOpportunityRow), status: statusRows[0] || null }; renderStatus(run.status); renderCurrencyRates(); render(); }
document.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { tab = b.dataset.tab; document.querySelectorAll('[data-tab]').forEach(x => x.classList.toggle('active', x === b)); closeDrawer(); render(); });
loadSettings();
renderFlowPresets();
['minVolume','minSpread','maxGold'].forEach(id => document.getElementById(id)?.addEventListener('input', () => { saveSettings(); render(); }));
['hideHighRisk','hideLosers'].forEach(id => document.getElementById(id)?.addEventListener('change', () => { saveSettings(); render(); }));
$('#search')?.addEventListener('input', event => { search = event.target.value.trim().toLowerCase(); render(); });
document.querySelectorAll('[data-bankroll]').forEach(input => {
  input.value = bankroll[input.dataset.bankroll] ?? 0;
  input.addEventListener('input', () => {
    bankroll = { ...bankroll, [input.dataset.bankroll]: Number(input.value) || 0 };
    saveSettings(); render();
  });
});

// Keyboard: this is a tool used at speed with the game open next to it.
document.addEventListener('keydown', event => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
  if (event.key === '/' && !typing) { event.preventDefault(); $('#search')?.focus(); return; }
  if (typing || (event.key !== 'j' && event.key !== 'k')) return;
  const rows = [...document.querySelectorAll('#routes tr.lead')];
  if (!rows.length) return;
  const current = rows.indexOf(document.activeElement);
  const next = event.key === 'j' ? Math.min(rows.length - 1, current + 1) : Math.max(0, current < 0 ? 0 : current - 1);
  rows[next]?.focus();
  rows[next]?.scrollIntoView({ block: 'nearest' });
});
const refresh = $('#refresh'); if (refresh) refresh.onclick = load; $('#scrim').onclick = closeDrawer; document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawer(); }); load();
