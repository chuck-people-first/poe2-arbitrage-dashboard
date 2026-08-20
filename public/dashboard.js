const $ = s => document.querySelector(s);
let run = null;
let tab = 'scanner';
let lastFocusedRow = null;
let currencyRates = [];
let historyRows = [];
const { normalizeOpportunityRow } = window.POE2Dashboard;
const fmt = n => new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(Number(n || 0));
const fmtInt = n => new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Number(n || 0));
const pct = (n, d = 1) => `${(Number(n || 0) * 100).toFixed(d)}%`;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const risk = label => `<span class="risk ${String(label || '').toLowerCase()}">${esc(label || '—')}</span>`;
const rateFmt = n => n == null ? '—' : Number(n).toLocaleString('en-US', { maximumFractionDigits: 6 });
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
    const s = r.discovery;
    if (Number(s.itemHourlyVolume || 0) < minVolume) return false;
    if (Number(s.closedCycleProfitPct ?? -Infinity) < minPnl) return false;
    if (s.goldVerified && maxGold > 0 && Number(s.totalGold || 0) > maxGold) return false;
    return true;
  }).sort((a,b) => Number(b.discovery.closedCycleProfitPct || 0) - Number(a.discovery.closedCycleProfitPct || 0));
}
function rows() { return tab === 'scanner' ? scannerRows() : tab === 'closed' ? cycleRows() : mtmRows(); }
function renderHeader() {
  $('#tabTitle').textContent = tab === 'scanner' ? 'Cross-currency flips' : tab === 'closed' ? 'Verified Closed Cycles' : 'Mark-to-Market Flips';
  $('#tabHint').textContent = tab === 'scanner'
    ? 'Buy with Exalted, Chaos, or Divine; sell into another hub; then convert back. Unknown item gold fees stay visible and clearly marked.'
    : tab === 'closed' ? 'Fully fee-verified, executable three-trade cycles only.' : 'Two-leg reference only—the return conversion is not included.';
  const head = tab === 'scanner'
    ? ['Item', 'Complete path', 'Cycle P&L', 'Start → Final', 'Item volume', 'Fill risk', 'Gold', 'Recommendation']
    : tab === 'closed'
    ? ['Trade cycle', 'Start → Final', 'Realized profit', 'Div / 100K Gold', 'Trades', 'Bottleneck', 'Total gold', 'Recommendation']
    : ['Item', 'Buy With / Path', 'Conservative P&L', 'Div / 100K Gold', 'Volume', 'Fill Risk', 'Gold', 'Trend', 'Recommendation'];
  document.querySelector('thead tr').innerHTML = head.map((h, i) => `<th class="${i === 3 ? 'sort-dg' : ''}">${h}</th>`).join('');
}
function scannerRowHtml(r) {
  const s = r.discovery;
  const ret = s.returnLeg;
  const path = `<div class="path"><span><b>BUY</b> ${fmtInt(s.buyLeg.pay)} ${esc(s.buyCurrency.name)} → ${fmtInt(s.buyLeg.receive)} ${esc(s.item.name)}</span><span><b>SELL</b> ${fmtInt(s.sellLeg.pay)} ${esc(s.item.name)} → ${fmtInt(s.sellLeg.receive)} ${esc(s.sellCurrency.name)}</span><span><b>RETURN</b> ${fmtInt(ret.pay)} ${esc(s.sellCurrency.name)} → ${fmtInt(ret.receive)} ${esc(s.buyCurrency.name)}</span></div>`;
  const gold = s.goldVerified ? fmtInt(s.totalGold) : '<b class="warn">VERIFY FEE</b>';
  return `<tr class="clickable" data-id="${esc(r.id)}"><td><b>${esc(s.item.name)}</b><small>${esc(s.buyCurrency.name)} → ${esc(s.sellCurrency.name)}</small></td><td>${path}</td><td class="green"><strong>+${fmt(s.closedCycleProfitPct)}%</strong><small>after return conversion</small></td><td><b>${fmtInt(s.startingQuantity)} → ${fmtInt(s.finalStartingQuantity)}</b><small>${esc(s.buyCurrency.name)}</small></td><td>${fmt(s.itemHourlyVolume)} / hr<small>${pct(s.maxVolumeShare)} max share</small></td><td>${risk(s.fillRiskLabel)}</td><td>${gold}</td><td><b>${esc(s.recommendation)}</b><small>${esc(s.warning || 'Check the live order book')}</small></td></tr>`;
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
  $('#routes').innerHTML = rs.length ? rs.map(r => tab === 'scanner' ? scannerRowHtml(r) : tab === 'closed' ? closedRowHtml(r) : mtmRowHtml(r)).join('') : `<tr><td colspan="9" class="empty">${tab === 'scanner' ? 'No signals match these filters. Lower Min cycle P&L or Min volume to see more completed-hour paths.' : tab === 'closed' ? 'No fully verified closed cycles this hour. Check Market Scanner for paths that need a live gold-fee check.' : 'No executable mark-to-market flips this hour.'}</td></tr>`;
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
  return `<header class="drawer-head"><div class="item-lockup"><strong>${esc(s.item.name)}</strong><small>${esc(s.buyCurrency.name)} → ${esc(s.sellCurrency.name)} → ${esc(s.buyCurrency.name)}</small></div><button class="close" aria-label="Close">×</button></header><section class="drawer-sec playbook"><h3>Complete three-step equation</h3><ol><li><b>Buy ${esc(s.item.name)}</b><br>Pay <strong>${fmtInt(s.buyLeg.pay)}</strong> ${esc(s.buyCurrency.name)} → receive <strong>${fmtInt(s.buyLeg.receive)}</strong> ${esc(s.item.name)}<br>Gold: ${fee(s.buyLeg)}</li><li><b>Sell for ${esc(s.sellCurrency.name)}</b><br>Pay <strong>${fmtInt(s.sellLeg.pay)}</strong> ${esc(s.item.name)} → receive <strong>${fmtInt(s.sellLeg.receive)}</strong> ${esc(s.sellCurrency.name)}<br>Gold: ${fee(s.sellLeg)}</li><li><b>Return to ${esc(s.buyCurrency.name)}</b><br>Pay <strong>${fmtInt(ret.pay)}</strong> ${esc(s.sellCurrency.name)} → receive <strong>${fmtInt(ret.receive)}</strong> ${esc(s.buyCurrency.name)}<br>Gold: ${fee(ret)}</li></ol></section><section class="drawer-sec"><h3>What the signal means</h3><table class="detail"><tr><td>Two-leg potential spread</td><td>${fmt(s.twoLegProfitPct)}%</td></tr><tr><td>Exact closed-cycle P&amp;L</td><td class="green">${fmt(s.closedCycleProfitPct)}%</td></tr><tr><td>Start → final</td><td>${fmtInt(s.startingQuantity)} → ${fmtInt(s.finalStartingQuantity)} ${esc(s.buyCurrency.name)}</td></tr><tr><td>Total gold</td><td>${s.goldVerified ? fmtInt(s.totalGold) : 'Unknown—item fee not verified'}</td></tr><tr><td>Item volume</td><td>${fmt(s.itemHourlyVolume)} / hr</td></tr><tr><td>Maximum volume share</td><td>${pct(s.maxVolumeShare)}</td></tr><tr><td>Ratio-range uncertainty</td><td>${fmt(s.ratioRangePct)}%</td></tr><tr><td>Source hour</td><td>${esc(s.sourceHourUtc)}</td></tr></table><p class="drawer-note"><strong>${esc(s.recommendation)}.</strong> ${esc(s.warning || 'Re-enter all three ratios in the live Exchange before placing orders; this is completed-hour data.')}</p></section>`;
}
function cycleDrawer(c) {
  const sellName = c.sellCurrency?.name || 'Divine Orb';
  const step = (n, title, leg, payName, receiveName) => `<li><b>Step ${n} — ${title}</b><br>Pay <strong>${fmtInt(leg.pay)}</strong> ${esc(payName)} → receive <strong>${fmtInt(leg.receive)}</strong> ${esc(receiveName)}<br>Gold: <strong>${fmtInt(leg.goldCost)}</strong> · Volume: ${fmt(leg.hourlyVolume)} / hr</li>`;
  return `<header class="drawer-head"><div class="item-lockup"><strong>Closed Cycle · ${esc(c.item.name)}</strong><small>${esc(c.startCurrency.name)} → ${esc(c.startCurrency.name)} · 3 trades</small></div><button class="close" aria-label="Close">×</button></header><section class="drawer-sec playbook"><h3>Exact three-step playbook</h3><ol>${step(1,'Buy the item',c.buyLeg,c.startCurrency.name,c.item.name)}${step(2,`Sell the same item for ${sellName}`,c.sellLeg,c.item.name,sellName)}${step(3,`Convert ${sellName} back to starting currency`,c.returnLeg,sellName,c.startCurrency.name)}</ol></section><section class="drawer-sec"><h3>Closed-cycle result</h3><table class="detail"><tr><td>Starting ${esc(c.startCurrency.name)}</td><td>${fmtInt(c.startingQuantity)}</td></tr><tr><td>Final ${esc(c.startCurrency.name)}</td><td>${fmtInt(c.finalStartingQuantity)}</td></tr><tr><td>Realized ${esc(c.startCurrency.name)} profit</td><td class="green">+${fmt(c.netRealizedProfitStart)}</td></tr><tr><td>Conservative ${esc(c.startCurrency.name)} profit</td><td class="green">+${fmt(c.conservativeRealizedProfitStart)}</td></tr><tr><td>Divine-equivalent realized profit</td><td>${fmt(c.conservativeRealizedProfitDivine)} Divine</td></tr><tr><td>Total gold, all 3 legs</td><td>${fmtInt(c.totalGold)}</td></tr><tr><td>Div / 100K Gold</td><td>${fmt(c.realizedProfitPer100kGold)}</td></tr><tr><td>Trades</td><td>3</td></tr><tr><td>Conservative realized ROI</td><td>${fmt(c.capitalRoiPct)}%</td></tr><tr><td>Residual inventory</td><td>${fmtInt(c.leftoverStartingCurrency)} ${esc(c.startCurrency.name)}</td></tr></table></section><section class="drawer-sec"><h3>Return-leg disclosure</h3><table class="detail"><tr><td>Return rate</td><td>${fmtInt(c.returnLeg.pay)} ${esc(sellName)} → ${fmtInt(c.returnLeg.receive)} ${esc(c.startCurrency.name)}</td></tr><tr><td>Return-leg volume</td><td>${fmt(c.returnLeg.hourlyVolume)} / hr</td></tr><tr><td>Return-leg volume share</td><td>${pct(c.maxVolumeShare)}</td></tr><tr><td>Source age</td><td>${esc(c.sourceHourUtc)} UTC</td></tr><tr><td>Risk</td><td>${fmt(c.movementHaircutPct)}% movement / ${fmt(c.marketImpactHaircutPct)}% impact</td></tr></table></section>`;
}
function mtmDrawer(f) {
  return `<header class="drawer-head"><div class="item-lockup"><strong>${esc(f.item.name)}</strong><small>${esc(f.buyCurrency.name)} → ${esc(f.sellCurrency.name)}</small></div><button class="close" aria-label="Close">×</button></header><section class="drawer-sec playbook"><h3>Mark-to-market playbook</h3><ol><li>Pay ${fmtInt(f.buyLeg.pay)} ${esc(f.buyCurrency.name)} → receive ${fmtInt(f.buyLeg.receive)} ${esc(f.item.name)}. Gold: ${fmtInt(f.buyLeg.goldCost)}</li><li>Pay ${fmtInt(f.sellLeg.pay)} ${esc(f.item.name)} → receive ${fmtInt(f.sellLeg.receive)} ${esc(f.sellCurrency.name)}. Gold: ${fmtInt(f.sellLeg.goldCost)}</li></ol><p class="drawer-note"><strong>Ends in another currency — return conversion not included.</strong> This is not realized profit and cannot receive TRADE NOW.</p></section><section class="drawer-sec"><table class="detail"><tr><td>Conservative Divine-equivalent profit</td><td>${fmt(f.conservativeNetProfitDivine)} Div</td></tr><tr><td>Div / 100K Gold</td><td>${fmt(f.divPer100kGold)}</td></tr><tr><td>Total gold</td><td>${fmtInt(f.goldRequired)}</td></tr></table></section>`;
}
function openDrawer(r) { const body = $('#drawerInner'); body.innerHTML = (tab === 'scanner' ? scannerDrawer(r.discovery) : tab === 'closed' ? cycleDrawer(r.cycle) : mtmDrawer(r.flip)) + historySection(historyFor(r)); $('#drawer').classList.add('open'); $('#drawer').setAttribute('aria-hidden','false'); $('#scrim').hidden = false; body.querySelector('.close').onclick = closeDrawer; body.querySelectorAll('[data-history-hours]').forEach(btn => btn.onclick = () => { const history = historyFor(r); body.querySelector('.history-chart').innerHTML = chartPoints(history, Number(btn.dataset.historyHours)); body.querySelectorAll('[data-history-hours]').forEach(x => x.classList.toggle('active', x === btn)); }); }
function closeDrawer() { $('#drawer').classList.remove('open'); $('#drawer').setAttribute('aria-hidden','true'); $('#scrim').hidden = true; if (lastFocusedRow) lastFocusedRow.focus(); }
function renderStatus(status) { const hour = status?.latest_successful_source_hour; $('#sourceAge').textContent = hour ? `Market hour ${hour.replace('T',' ').slice(0,16)} UTC` : 'No completed ingestion yet'; $('#age').textContent = hour ? window.POE2CurrencyRates.ageLabel(hour) : '—'; $('#completedAt').textContent = status?.completed_at ? `Fetched ${String(status.completed_at).replace('T',' ').slice(0,16)} UTC` : '—'; }
async function load() { if (window.POE2_DEMO_DATA) { run = { routes: (window.POE2_DEMO_DATA.routes || []).map(normalizeOpportunityRow), status: window.POE2_DEMO_DATA.status }; currencyRates = window.POE2_DEMO_DATA.currencyRates || []; historyRows = window.POE2_DEMO_DATA.history || []; renderStatus(run.status); renderCurrencyRates(); render(); return; } const url = window.POE2_SUPABASE_URL || ''; const key = window.POE2_SUPABASE_PUBLISHABLE_KEY || ''; if (!url || !key) { run = { routes: [], status: null }; currencyRates = []; historyRows = []; renderStatus(null); renderCurrencyRates(); render(); return; } const headers = { apikey: key, Authorization: `Bearer ${key}` }; const [s, o, rates, history] = await Promise.all([fetch(`${url}/rest/v1/opportunity_run_status?select=*`,{headers}), fetch(`${url}/rest/v1/opportunity_public?select=*&order=score.desc`,{headers}), fetch(`${url}/rest/v1/currency_rates_public?select=*&order=source_hour.desc`,{headers}), fetch(`${url}/rest/v1/signal_history_public?select=*&order=source_hour.asc`,{headers})]); const statusRows = s.ok ? await s.json() : []; const rowsResp = o.ok ? await o.json() : []; currencyRates = rates.ok ? await rates.json() : []; historyRows = history.ok ? await history.json() : []; run = { routes: (Array.isArray(rowsResp) ? rowsResp : []).map(normalizeOpportunityRow), status: statusRows[0] || null }; renderStatus(run.status); renderCurrencyRates(); render(); }
document.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { tab = b.dataset.tab; document.querySelectorAll('[data-tab]').forEach(x => x.classList.toggle('active', x === b)); closeDrawer(); render(); });
['minVolume','minPnl','maxGold'].forEach(id => document.getElementById(id)?.addEventListener('input', render));
const refresh = $('#refresh'); if (refresh) refresh.onclick = load; $('#scrim').onclick = closeDrawer; document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawer(); }); load();
