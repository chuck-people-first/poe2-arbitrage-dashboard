const $ = s => document.querySelector(s);
let run = null;
let tab = 'scanner';
let lastFocusedRow = null;
let currencyRates = [];
let historyRows = [];
const REQUIRED_SCANNER_ALGORITHM = 'phase6-ratio-boundaries-1';
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
function scannerRows() {
  const minVolume = Number($('#minVolume')?.value || 0);
  const minPnl = Number($('#minPnl')?.value || 0);
  const maxGold = Number($('#maxGold')?.value || 0);
  return (run?.routes || []).filter(r => r.discovery).filter(r => {
    if (!window.POE2_DEMO_DATA && r.algorithmVersion !== REQUIRED_SCANNER_ALGORITHM) return false;
    const s = r.discovery;
    if (Number(s.itemHourlyVolume || 0) < minVolume) return false;
    if (Number(s.closedCycleProfitPct ?? -Infinity) < minPnl) return false;
    if (s.goldVerified && maxGold > 0 && Number(s.totalGold || 0) > maxGold) return false;
    return true;
  }).sort((a,b) =>
    Number(b.discovery.estimatedDivPer100kGold ?? -Infinity) - Number(a.discovery.estimatedDivPer100kGold ?? -Infinity)
    || Number(a.discovery.maxVolumeShare ?? Infinity) - Number(b.discovery.maxVolumeShare ?? Infinity)
    || Number(b.discovery.closedCycleProfitPct || 0) - Number(a.discovery.closedCycleProfitPct || 0)
  );
}
function rows() { return tab === 'scanner' ? scannerRows() : tab === 'closed' ? cycleRows() : mtmRows(); }
function renderHeader() {
  $('#tabTitle').textContent = tab === 'scanner' ? 'Cross-currency flips' : tab === 'closed' ? 'Verified Closed Cycles' : 'Mark-to-Market Flips';
  $('#tabHint').textContent = tab === 'scanner'
    ? 'Buy with Exalted, Chaos, or Divine; sell into another hub; then convert back. Unknown item gold fees stay visible and clearly marked.'
    : tab === 'closed' ? 'Fully fee-verified, executable three-trade cycles only.' : 'Two-leg reference only—the return conversion is not included.';
  const head = tab === 'scanner'
    ? ['Item', 'In-game ratios (I WANT : I HAVE)', 'Cycle P&L', 'Est. Div / 100K Gold', 'Start → Final', 'Item volume', 'Gold', 'Recommendation']
    : tab === 'closed'
    ? ['Trade cycle', 'Start → Final', 'Realized profit', 'Div / 100K Gold', 'Trades', 'Bottleneck', 'Total gold', 'Recommendation']
    : ['Item', 'Buy With / Path', 'Conservative P&L', 'Div / 100K Gold', 'Volume', 'Fill Risk', 'Gold', 'Trend', 'Recommendation'];
  document.querySelector('thead tr').innerHTML = head.map((h, i) => `<th class="${i === 3 ? 'sort-dg' : ''}">${h}</th>`).join('');
}
function scannerRowHtml(r) {
  const s = r.discovery;
  const ret = s.returnLeg;
  const path = `<div class="path ratio-path">${ratioLadder('BUY',s.buyRatioRange,s.buyRatio,s.item.name,s.buyCurrency.name)}${ratioLadder('SELL',s.sellRatioRange,s.sellRatio,s.sellCurrency.name,s.item.name)}${ratioLadder('RETURN',s.returnRatioRange,s.returnRatio,s.buyCurrency.name,s.sellCurrency.name)}<small><b>Target bid</b> is the favorable completed-hour reference for the Competing Trades side. P&amp;L uses the safer Plan / Fill boundary. The current live ladder is only visible in game · ${esc(sourceAgeText(s.sourceHourUtc))}</small></div>`;
  const gold = s.goldVerified ? `<b>${fmtInt(s.totalGold)}</b><small>verified</small>` : `<b>~${fmtInt(s.estimatedTotalGold)}</b><small class="warn">estimated · OCR available</small>`;
  const divGold = s.estimatedDivPer100kGold == null ? '—' : fmt(s.estimatedDivPer100kGold);
  return `<tr class="clickable" data-id="${esc(r.id)}"><td><b>${esc(s.item.name)}</b><small>${esc(s.buyCurrency.name)} → ${esc(s.sellCurrency.name)}</small></td><td>${path}</td><td class="green"><strong>+${fmt(s.closedCycleProfitPct)}%</strong><small>completed-hour estimate; confirm live</small></td><td class="dg"><strong>${divGold}</strong><small>${s.goldVerified ? 'verified fees' : 'estimated fees'}</small></td><td><b>${fmtInt(s.startingQuantity)} → ${fmtInt(s.finalStartingQuantity)}</b><small>${esc(s.buyCurrency.name)}</small></td><td>${fmt(s.itemHourlyVolume)} / hr<small>${pct(s.maxVolumeShare)} max share · ${esc(s.fillRiskLabel)}</small></td><td>${gold}</td><td><b>${esc(s.recommendation)}</b><small>${esc(s.warning || 'Check the live order book')}</small></td></tr>`;
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
  const oldScannerRowsHidden = tab === 'scanner' && !window.POE2_DEMO_DATA && (run?.routes || []).some(r => r.discovery && r.algorithmVersion !== REQUIRED_SCANNER_ALGORITHM);
  $('#routes').innerHTML = rs.length ? rs.map(r => tab === 'scanner' ? scannerRowHtml(r) : tab === 'closed' ? closedRowHtml(r) : mtmRowHtml(r)).join('') : `<tr><td colspan="9" class="empty">${oldScannerRowsHidden ? 'Recalculating this completed hour with conservative in-game ratios. The invalid best-case percentages are hidden.' : tab === 'scanner' ? 'No signals match these filters. Lower Min cycle P&L or Min volume to see more completed-hour paths.' : tab === 'closed' ? 'No fully verified closed cycles this hour. Check Market Scanner for paths that need a live gold-fee check.' : 'No executable mark-to-market flips this hour.'}</td></tr>`;
  $('#count').textContent = String(rs.length);
  $('#verifiedCount').textContent = String(rs.filter(r => tab === 'scanner' ? r.discovery?.goldVerified : tab === 'closed').length);
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
  const divGold = s.estimatedDivPer100kGold == null ? '—' : fmt(s.estimatedDivPer100kGold);
  const defaultItemFee = s.buyLeg.goldVerified && s.buyLeg.receive > 0 ? s.buyLeg.goldCost / s.buyLeg.receive : (s.estimatedGoldPerUnknownUnit || 1000);
  const ocr = `<section class="drawer-sec gold-ocr"><h3>Confirm the gold fee from your screenshot</h3><p class="drawer-note">Paste or upload a crop showing the gold fee. OCR runs in your browser and suggests numbers; confirm the correct per-item fee before applying it.</p><input class="ocr-file" type="file" accept="image/*"><button type="button" class="ocr-read">Read screenshot</button><div class="ocr-status muted">No screenshot selected.</div><div class="ocr-candidates"></div><label>Gold per ${esc(s.item.name)} received<input class="ocr-fee" type="number" min="1" step="1" value="${fmtInt(defaultItemFee).replace(/,/g,'')}"></label><button type="button" class="ocr-apply">Apply confirmed fee</button><div class="ocr-result"></div></section>`;
  return `<header class="drawer-head"><div class="item-lockup"><strong>${esc(s.item.name)}</strong><small>${esc(s.buyCurrency.name)} → ${esc(s.sellCurrency.name)} → ${esc(s.buyCurrency.name)}</small></div><button class="close" aria-label="Close">×</button></header><section class="drawer-sec playbook"><h3>Ratios to type in game</h3><p class="drawer-note"><strong>Snapshot: ${esc(sourceAgeText(s.sourceHourUtc))}.</strong> Target Bid is the favorable completed-hour reference for the bottom Competing Trades section—the side where you post and wait. Plan / Fill is the safer boundary used by the displayed P&amp;L. Confirm the current competing ladder in game because the official API does not expose it live.</p><ol>${ratioStep('Buy the item',s.buyRatioRange,s.buyRatio,s.item.name,s.buyCurrency.name,`${fmtInt(s.buyLeg.pay)} ${esc(s.buyCurrency.name)} → ${fmtInt(s.buyLeg.receive)} ${esc(s.item.name)}`)}${ratioStep('Sell the item',s.sellRatioRange,s.sellRatio,s.sellCurrency.name,s.item.name,`${fmtInt(s.sellLeg.pay)} ${esc(s.item.name)} → ${fmtInt(s.sellLeg.receive)} ${esc(s.sellCurrency.name)}`)}${ratioStep('Return to the starting currency',s.returnRatioRange,s.returnRatio,s.buyCurrency.name,s.sellCurrency.name,`${fmtInt(ret.pay)} ${esc(s.sellCurrency.name)} → ${fmtInt(ret.receive)} ${esc(s.buyCurrency.name)}`)}</ol><p class="drawer-note"><strong>The Target Bid can improve profit only if it fills.</strong> The calculation does not count that favorable price as guaranteed; it uses the Plan / Fill boundary instead.</p></section><section class="drawer-sec"><h3>Potential cycle</h3><table class="detail"><tr><td>Potential cycle P&amp;L</td><td class="green">${fmt(s.closedCycleProfitPct)}%</td></tr><tr><td>Start → final</td><td>${fmtInt(s.startingQuantity)} → ${fmtInt(s.finalStartingQuantity)} ${esc(s.buyCurrency.name)}</td></tr><tr><td>Divine-equivalent profit</td><td>${s.estimatedProfitDivine == null ? '—' : `~${fmt(s.estimatedProfitDivine)} Divine`}</td></tr><tr><td>${s.goldVerified ? 'Total gold' : 'Estimated total gold'}</td><td id="drawerGold">${goldValue}</td></tr><tr><td>${s.goldVerified ? 'Div / 100K Gold' : 'Estimated Div / 100K Gold'}</td><td class="dg" id="drawerDivGold"><strong>${divGold}</strong></td></tr><tr><td>Fee estimate basis</td><td>${esc(s.goldEstimateBasis || 'All fees verified')}</td></tr><tr><td>Known leg fees</td><td>Buy ${fee(s.buyLeg)} · Sell ${fee(s.sellLeg)} · Return ${fee(ret)}</td></tr><tr><td>Item volume</td><td>${fmt(s.itemHourlyVolume)} / hr</td></tr><tr><td>Maximum volume share</td><td>${pct(s.maxVolumeShare)}</td></tr><tr><td>Ratio-range uncertainty</td><td>${fmt(s.ratioRangePct)}%</td></tr><tr><td>Source hour</td><td>${esc(s.sourceHourUtc)}</td></tr></table><p class="drawer-note"><strong>${esc(s.recommendation)}.</strong> ${esc(s.warning || 'Re-enter all three ratios in the live Exchange before placing orders; this is completed-hour data.')}</p></section>${ocr}`;
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
    const dg = s.estimatedProfitDivine == null || total <= 0 ? null : Number(s.estimatedProfitDivine) / total * 100000;
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
['minVolume','minPnl','maxGold'].forEach(id => document.getElementById(id)?.addEventListener('input', render));
const refresh = $('#refresh'); if (refresh) refresh.onclick = load; $('#scrim').onclick = closeDrawer; document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawer(); }); load();
