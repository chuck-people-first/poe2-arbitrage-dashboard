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
const { normalizeOpportunityRow } = window.POE2Dashboard;
const fmt = n => new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(Number(n || 0));
const fmtInt = n => new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Number(n || 0));
const pct = (n, d = 1) => `${(Number(n || 0) * 100).toFixed(d)}%`;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const risk = label => `<span class="risk ${String(label || '').toLowerCase()}">${esc(label || '—')}</span>`;
const rateFmt = n => n == null ? '—' : Number(n).toLocaleString('en-US', { maximumFractionDigits: 6 });
const ratioNum = n => Number(n).toLocaleString('en-US', { maximumFractionDigits: 4 });
const ratioText = (ratio, wantName, haveName) => ratio
  ? `${ratioNum(ratio.want)} ${esc(wantName)} : ${ratioNum(ratio.have)} ${esc(haveName)}`
  : 'Not observed';
const ratioRange = (range, fallback) => range || (fallback ? {
  favorable: fallback,
  conservative: fallback,
  source: 'legacy-single-boundary'
} : null);
// Compact single-line form for the main table: the bid the player types.
// Hub currencies lose their " Orb" suffix here — it costs width in every ratio
// cell and the Item column already carries the full path.
const shortName = name => String(name || '').replace(/ Orb$/, '');
const compactRatio = (range, fallback, wantName, haveName) => {
  const observed = ratioRange(range, fallback);
  return observed ? ratioText(observed.conservative, shortName(wantName), shortName(haveName)) : 'Not observed';
};
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
const spreadOf = s => Number(s?.priceModel?.twoLegSpreadPct ?? 0);
const divGoldOf = s => Number(s?.spreadDivPer100kGold ?? s?.estimatedDivPer100kGold ?? -Infinity);
const goldOf = s => Number(s?.goldVerified ? s.totalGold : s?.estimatedTotalGold ?? Infinity);
const isConfirmed = s => s?.classification === 'return-confirmed';

// Default order, in the product's words: return-confirmed and profitable first,
// then gold efficiency, then the lighter liquidity footprint, then depth, then
// the raw spread. Ranking never reads targetBidPotentialPct.
const SCANNER_SORTS = {
  default: (a, b) =>
    (isConfirmed(b.discovery) ? 1 : 0) - (isConfirmed(a.discovery) ? 1 : 0)
    || divGoldOf(b.discovery) - divGoldOf(a.discovery)
    || Number(a.discovery.maxVolumeShare ?? Infinity) - Number(b.discovery.maxVolumeShare ?? Infinity)
    || Number(b.discovery.itemHourlyVolume || 0) - Number(a.discovery.itemHourlyVolume || 0)
    || spreadOf(b.discovery) - spreadOf(a.discovery),
  spread: (a, b) => spreadOf(b.discovery) - spreadOf(a.discovery),
  divgold: (a, b) => divGoldOf(b.discovery) - divGoldOf(a.discovery),
  volume: (a, b) => Number(b.discovery.itemHourlyVolume || 0) - Number(a.discovery.itemHourlyVolume || 0),
  gold: (a, b) => goldOf(a.discovery) - goldOf(b.discovery),
  fresh: (a, b) => String(b.discovery.sourceHourUtc || '').localeCompare(String(a.discovery.sourceHourUtc || '')),
};

function scannerRows() {
  const minVolume = Number($('#minVolume')?.value || 0);
  const minSpread = Number($('#minSpread')?.value || 0);
  const maxGold = Number($('#maxGold')?.value || 0);
  const hideHighRisk = Boolean($('#hideHighRisk')?.checked);
  return (run?.routes || []).filter(r => r.discovery).filter(r => {
    if (!window.POE2_DEMO_DATA && !hasPriceModel(r)) return false;
    const s = r.discovery;
    if (Number(s.itemHourlyVolume || 0) < minVolume) return false;
    if (spreadOf(s) < minSpread) return false;
    if (hideHighRisk && s.classification === 'high-risk') return false;
    if (s.goldVerified && maxGold > 0 && Number(s.totalGold || 0) > maxGold) return false;
    return true;
  }).sort(SCANNER_SORTS[scannerSort] || SCANNER_SORTS.default);
}
function rows() { return tab === 'scanner' ? scannerRows() : tab === 'closed' ? cycleRows() : mtmRows(); }
// Scanner headers are sortable; the key is the SCANNER_SORTS entry to apply.
const SCANNER_HEAD = [
  ['Item', null], ['Buy bid<small>I want : I have</small>', null],
  ['Sell bid<small>I want : I have</small>', null], ['Return<small>I want : I have</small>', null],
  ['Spread', 'spread'], ['Div / 100K', 'divgold'], ['Volume<small>per hour</small>', 'volume'],
  ['Gold', 'gold'], ['Status', null],
];
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
      const apply = () => { scannerSort = scannerSort === th.dataset.sort ? 'default' : th.dataset.sort; render(); };
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
// A CDN icon that fails to load degrades to the neutral placeholder rather
// than a broken-image glyph; the row's identity is the name, not the picture.
const ICON = item => item?.iconUrl
  ? `<img class="item-icon" src="${esc(item.iconUrl)}" alt="" loading="lazy" width="28" height="28" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'item-icon placeholder'}))">`
  : '<span class="item-icon placeholder" aria-hidden="true"></span>';

// The return figure is the only one allowed to say "cycle". Everything else is
// a spread or a potential, and says so in the row itself.
function returnSummary(s) {
  const model = s.priceModel || {};
  if (model.returnConfirmedCyclePct == null) return '<small class="warn">round trip not proven</small>';
  const value = Number(model.returnConfirmedCyclePct);
  return `<small class="${value > 0 ? 'ok' : 'warn'}">round trip ${value > 0 ? '+' : ''}${fmt(value)}%</small>`;
}

function scannerRowHtml(r) {
  const s = r.discovery;
  const spread = spreadOf(s);
  const divGold = s.spreadDivPer100kGold == null ? '—' : fmt(s.spreadDivPer100kGold);
  const gold = s.goldVerified ? `<b>${fmtInt(s.totalGold)}</b><small>verified</small>` : `<b>~${fmtInt(s.estimatedTotalGold)}</b><small class="warn">estimated</small>`;
  const status = `<span class="status ${esc(s.classification || 'two-leg-spread')}">${esc(s.classificationLabel || s.recommendation)}</span>`;
  return `<tr class="clickable" data-id="${esc(r.id)}">`
    + `<td class="cell-item">${ICON(s.item)}<span><b>${esc(s.item.name)}</b><small>${esc(shortName(s.buyCurrency.name))} → ${esc(shortName(s.sellCurrency.name))} → ${esc(shortName(s.buyCurrency.name))}</small></span></td>`
    + `<td class="cell-ratio">${compactRatio(s.buyRatioRange,s.buyRatio,s.item.name,s.buyCurrency.name)}</td>`
    + `<td class="cell-ratio">${compactRatio(s.sellRatioRange,s.sellRatio,s.sellCurrency.name,s.item.name)}</td>`
    + `<td class="cell-ratio">${compactRatio(s.returnRatioRange,s.returnRatio,s.buyCurrency.name,s.sellCurrency.name)}</td>`
    + `<td class="${spread > 0 ? 'green' : ''}"><strong>${spread > 0 ? '+' : ''}${fmt(spread)}%</strong>${returnSummary(s)}</td>`
    + `<td class="dg"><strong>${divGold}</strong><small>${s.goldVerified ? 'verified fees' : 'estimated fees'}</small></td>`
    + `<td class="num">${fmt(s.itemHourlyVolume)}<small${s.closedCycleProfitPct == null ? ' class="warn"' : ''}>${s.closedCycleProfitPct == null ? 'no size fits' : `${pct(s.maxVolumeShare)} of volume`}</small></td>`
    + `<td>${gold}</td>`
    + `<td>${status}</td></tr>`;
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
function render() {
  if (!run) return;
  renderHeader();
  const rs = rows();
  const oldScannerRowsHidden = tab === 'scanner' && !window.POE2_DEMO_DATA && (run?.routes || []).some(r => r.discovery && !hasPriceModel(r));
  $('#routes').innerHTML = rs.length ? rs.map(r => tab === 'scanner' ? scannerRowHtml(r) : tab === 'closed' ? closedRowHtml(r) : mtmRowHtml(r)).join('') : `<tr><td colspan="9" class="empty">${oldScannerRowsHidden ? 'Recalculating this completed hour with the separated spread / return-confirmed model. The invalid best-case percentages are hidden.' : tab === 'scanner' ? 'No signals match these filters. Lower Min spread or Min volume to see more completed-hour paths.' : tab === 'closed' ? 'No fully verified closed cycles this hour. Check Market Scanner for paths that need a live gold-fee check.' : 'No executable mark-to-market flips this hour.'}</td></tr>`;
  $('#count').textContent = String(rs.length);
  $('#verifiedCount').textContent = String(rs.filter(r => tab === 'scanner' ? isConfirmed(r.discovery) : tab === 'closed').length);
  $('#unknownCount').textContent = String(rs.filter(r => tab === 'scanner' && !r.discovery?.goldVerified).length);
  document.querySelectorAll('#routes tr.clickable').forEach(tr => {
    tr.tabIndex = 0; tr.setAttribute('role', 'button');
    const activate = () => { lastFocusedRow = tr; openDrawer(rs.find(x => String(x.id) === String(tr.dataset.id))); };
    tr.onclick = activate;
    tr.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); } };
  });
}
function scannerDrawer(s) {
  const ret = s.returnLeg;
  const fee = leg => leg.goldVerified ? fmtInt(leg.goldCost) : 'Unknown—verify in game';
  const ratioStep = (title, range, ratio, wantName, haveName, batch) => `<li><b>${title}</b><div class="ratio-entry">${ratioLadder('',range,ratio,wantName,haveName)}</div><span class="muted">Optional batch illustration (do not type this): ${batch}</span></li>`;
  const goldValue = s.goldVerified ? fmtInt(s.totalGold) : `~${fmtInt(s.estimatedTotalGold)} estimated`;
  const divGold = s.spreadDivPer100kGold == null ? '—' : fmt(s.spreadDivPer100kGold);
  const defaultItemFee = s.buyLeg.goldVerified && s.buyLeg.receive > 0 ? s.buyLeg.goldCost / s.buyLeg.receive : (s.estimatedGoldPerUnknownUnit || 1000);
  const model = s.priceModel || {};
  const confirmed = model.returnConfirmedCyclePct;
  // Three figures, three separate rows, each labeled for what it actually is.
  // Presenting them together is the point: the gap between them IS the risk.
  const figures = `<section class="drawer-sec figures"><h3>Three separate figures</h3><table class="detail"><tr><td><b>Two-leg spread</b><small>Item mispricing between the two currency markets, every leg at its completed-hour midpoint. Discovery metric — gold excluded.</small></td><td class="${spreadOf(s) > 0 ? 'green' : ''}">${fmt(spreadOf(s))}%</td></tr><tr><td><b>Target-bid potential</b><small class="warn">What this path would return if every favorable posted bid filled. POTENTIAL, not executable profit: those prices may have occurred at different moments in the hour.</small></td><td class="muted">${model.targetBidPotentialPct == null ? '—' : `${fmt(model.targetBidPotentialPct)}%`}</td></tr><tr><td><b>Return-confirmed cycle</b><small>Exact integer sizing at the least-favorable observed boundary on all three legs, with all three gold fees. The only figure that may be called a closed cycle.</small></td><td class="${confirmed != null && confirmed > 0 ? 'green' : 'warn'}">${confirmed == null ? 'Not proven this hour' : `${fmt(confirmed)}%`}</td></tr></table><p class="drawer-note"><strong>Status: ${esc(s.classificationLabel || '')}.</strong> ${esc(s.warning || 'Re-enter all three ratios in the live Exchange before placing orders; this is completed-hour data.')}</p></section>`;
  const ocr = `<section class="drawer-sec gold-ocr"><h3>Confirm the gold fee from your screenshot</h3><p class="drawer-note">Paste or upload a crop showing the gold fee. OCR runs in your browser and suggests numbers; confirm the correct per-item fee before applying it.</p><input class="ocr-file" type="file" accept="image/*"><button type="button" class="ocr-read">Read screenshot</button><div class="ocr-status muted">No screenshot selected.</div><div class="ocr-candidates"></div><label>Gold per ${esc(s.item.name)} received<input class="ocr-fee" type="number" min="1" step="1" value="${fmtInt(defaultItemFee).replace(/,/g,'')}"></label><button type="button" class="ocr-apply">Apply confirmed fee</button><div class="ocr-result"></div></section>`;
  return `<header class="drawer-head"><div class="item-lockup"><strong>${esc(s.item.name)}</strong><small>${esc(s.buyCurrency.name)} → ${esc(s.sellCurrency.name)} → ${esc(s.buyCurrency.name)}</small></div><button class="close" aria-label="Close">×</button></header><section class="drawer-sec playbook"><h3>Ratios to type in game</h3><p class="drawer-note"><strong>Snapshot: ${esc(sourceAgeText(s.sourceHourUtc))}.</strong> Target Bid is the favorable completed-hour reference for the bottom Competing Trades section—the side where you post and wait. Plan / Fill is the safer boundary used by the displayed P&amp;L. Confirm the current competing ladder in game because the official API does not expose it live.</p><ol>${ratioStep('Buy the item',s.buyRatioRange,s.buyRatio,s.item.name,s.buyCurrency.name,`${fmtInt(s.buyLeg.pay)} ${esc(s.buyCurrency.name)} → ${fmtInt(s.buyLeg.receive)} ${esc(s.item.name)}`)}${ratioStep('Sell the item',s.sellRatioRange,s.sellRatio,s.sellCurrency.name,s.item.name,`${fmtInt(s.sellLeg.pay)} ${esc(s.item.name)} → ${fmtInt(s.sellLeg.receive)} ${esc(s.sellCurrency.name)}`)}${ratioStep('Return to the starting currency',s.returnRatioRange,s.returnRatio,s.buyCurrency.name,s.sellCurrency.name,ret ? `${fmtInt(ret.pay)} ${esc(s.sellCurrency.name)} → ${fmtInt(ret.receive)} ${esc(s.buyCurrency.name)}` : 'no sizing fits the observed hourly volume')}</ol><p class="drawer-note"><strong>The Target Bid can improve profit only if it fills.</strong> The calculation does not count that favorable price as guaranteed; it uses the Plan / Fill boundary instead.</p></section>${figures}<section class="drawer-sec"><h3>Sizing and cost</h3><table class="detail"><tr><td>Start → final</td><td>${s.finalStartingQuantity == null ? `${fmtInt(s.startingQuantity)} ${esc(s.buyCurrency.name)} — no closing size fits this hour's volume` : `${fmtInt(s.startingQuantity)} → ${fmtInt(s.finalStartingQuantity)} ${esc(s.buyCurrency.name)}`}</td></tr><tr><td>Divine-equivalent profit</td><td>${s.estimatedProfitDivine == null ? '—' : `~${fmt(s.estimatedProfitDivine)} Divine`}</td></tr><tr><td>${s.goldVerified ? 'Total gold' : 'Estimated total gold'}</td><td id="drawerGold">${goldValue}</td></tr><tr><td>${s.goldVerified ? 'Div / 100K Gold' : 'Estimated Div / 100K Gold'}</td><td class="dg" id="drawerDivGold"><strong>${divGold}</strong></td></tr><tr><td>Fee estimate basis</td><td>${esc(s.goldEstimateBasis || 'All fees verified')}</td></tr><tr><td>Known leg fees</td><td>Buy ${fee(s.buyLeg)} · Sell ${fee(s.sellLeg)} · Return ${ret ? fee(ret) : '—'}</td></tr><tr><td>Item volume</td><td>${fmt(s.itemHourlyVolume)} / hr</td></tr><tr><td>Maximum volume share</td><td>${pct(s.maxVolumeShare)}${s.closedCycleProfitPct == null ? ' — larger than the whole observed hour' : ''}</td></tr><tr><td>Estimated fill risk</td><td>${esc(s.fillRiskLabel)} (${pct(s.fillRisk)})<small class="muted">Heuristic from volume share, hourly ratio range and market depth. Not a guarantee.</small></td></tr><tr><td>Ratio-range uncertainty</td><td>${fmt(s.ratioRangePct)}%</td></tr><tr><td>Source hour</td><td>${esc(s.sourceHourUtc)}</td></tr></table></section>${ocr}`;
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
['minVolume','minSpread','maxGold'].forEach(id => document.getElementById(id)?.addEventListener('input', render));
document.getElementById('hideHighRisk')?.addEventListener('change', render);
const refresh = $('#refresh'); if (refresh) refresh.onclick = load; $('#scrim').onclick = closeDrawer; document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawer(); }); load();
