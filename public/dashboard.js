const $ = s => document.querySelector(s);
let run = null;
let tab = 'closed';
let lastFocusedRow = null;
const { normalizeOpportunityRow } = window.POE2Dashboard;
const fmt = n => new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(Number(n || 0));
const fmtInt = n => new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Number(n || 0));
const pct = (n, d = 1) => `${(Number(n || 0) * 100).toFixed(d)}%`;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const risk = label => `<span class="risk ${String(label || '').toLowerCase()}">${esc(label || '—')}</span>`;
function cycleRows() { return (run?.routes || []).filter(r => r.cycle?.closed && r.cycle?.executable); }
function mtmRows() { return (run?.routes || []).filter(r => r.flip && r.strategy === 'two-leg-cross'); }
function rows() { return tab === 'closed' ? cycleRows() : mtmRows(); }
function renderHeader() {
  $('#tabTitle').textContent = tab === 'closed' ? 'Closed Cycles' : 'Mark-to-Market Flips';
  $('#tabHint').textContent = tab === 'closed'
    ? 'Executable three-trade cycles only. The return conversion is independently observed and included.'
    : 'Ends in another currency — return conversion not included.';
  const head = tab === 'closed'
    ? ['Trade cycle', 'Start → Final', 'Realized profit', 'Div / 100K Gold', 'Trades', 'Bottleneck', 'Total gold', 'Recommendation']
    : ['Item', 'Buy With / Path', 'Conservative P&L', 'Div / 100K Gold', 'Volume', 'Fill Risk', 'Gold', 'Trend', 'Recommendation'];
  document.querySelector('thead tr').innerHTML = head.map((h, i) => `<th class="${i === 3 ? 'sort-dg' : ''}">${h}</th>`).join('');
}
function closedRowHtml(r) {
  const c = r.cycle;
  const trade = `<div class="path"><b>BUY</b> ${fmtInt(c.buyLeg.pay)} ${esc(c.startCurrency.name)} → ${fmtInt(c.buyLeg.receive)} ${esc(c.item.name)}<br><b>SELL</b> ${fmtInt(c.sellLeg.pay)} ${esc(c.item.name)} → ${fmtInt(c.sellLeg.receive)} Divine<br><b>RETURN</b> ${fmtInt(c.returnLeg.pay)} Divine → ${fmtInt(c.returnLeg.receive)} ${esc(c.startCurrency.name)}</div>`;
  return `<tr class="clickable" data-id="${esc(r.id)}"><td>${trade}</td><td><b>${fmtInt(c.startingQuantity)} → ${fmtInt(c.finalStartingQuantity)}</b> ${esc(c.startCurrency.name)}<small>${fmtInt(c.netRealizedProfitStart)} ${esc(c.startCurrency.name)} profit</small></td><td class="green"><strong>+${fmt(c.conservativeRealizedProfitStart)}</strong> ${esc(c.startCurrency.name)}<small>${fmt(c.conservativeRealizedProfitDivine)} Divine-equivalent</small></td><td class="dg"><strong>${fmt(c.realizedProfitPer100kGold)}</strong><small>per 100K gold</small></td><td>3</td><td>${fmt(c.bottleneckVolume)} / hr<small>${pct(c.maxVolumeShare)} max share</small></td><td>${fmtInt(c.totalGold)}</td><td><b>TRADE NOW</b></td></tr>`;
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
  $('#routes').innerHTML = rs.length ? rs.map(r => tab === 'closed' ? closedRowHtml(r) : mtmRowHtml(r)).join('') : `<tr><td colspan="9" class="empty">${tab === 'closed' ? 'No executable closed cycles this hour. Mark-to-market flips do not appear here.' : 'No executable mark-to-market flips this hour.'}</td></tr>`;
  document.querySelectorAll('#routes tr.clickable').forEach(tr => {
    tr.tabIndex = 0; tr.setAttribute('role', 'button');
    const activate = () => { lastFocusedRow = tr; openDrawer(rs.find(x => String(x.id) === String(tr.dataset.id))); };
    tr.onclick = activate;
    tr.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); } };
  });
}
function cycleDrawer(c) {
  const step = (n, title, leg, receiveName) => `<li><b>Step ${n} — ${title}</b><br>Pay <strong>${fmtInt(leg.pay)}</strong> ${esc(n === 1 ? c.startCurrency.name : n === 2 ? c.item.name : 'Divine Orb')} → receive <strong>${fmtInt(leg.receive)}</strong> ${esc(receiveName)}<br>Gold: <strong>${fmtInt(leg.goldCost)}</strong> · Volume: ${fmt(leg.hourlyVolume)} / hr</li>`;
  return `<header class="drawer-head"><div class="item-lockup"><strong>Closed Cycle · ${esc(c.item.name)}</strong><small>${esc(c.startCurrency.name)} → ${esc(c.startCurrency.name)} · 3 trades</small></div><button class="close" aria-label="Close">×</button></header><section class="drawer-sec playbook"><h3>Exact three-step playbook</h3><ol>${step(1,'Buy the item',c.buyLeg,c.item.name)}${step(2,'Sell the same item for Divine',c.sellLeg,'Divine Orb')}${step(3,'Convert Divine back to starting currency',c.returnLeg,c.startCurrency.name)}</ol></section><section class="drawer-sec"><h3>Closed-cycle result</h3><table class="detail"><tr><td>Starting Exalted</td><td>${fmtInt(c.startingQuantity)}</td></tr><tr><td>Final Exalted</td><td>${fmtInt(c.finalStartingQuantity)}</td></tr><tr><td>Realized Exalted profit</td><td class="green">+${fmt(c.netRealizedProfitStart)}</td></tr><tr><td>Conservative realized Exalted profit</td><td class="green">+${fmt(c.conservativeRealizedProfitStart)}</td></tr><tr><td>Divine-equivalent realized profit</td><td>${fmt(c.conservativeRealizedProfitDivine)} Divine</td></tr><tr><td>Total gold, all 3 legs</td><td>${fmtInt(c.totalGold)}</td></tr><tr><td>Div / 100K Gold</td><td>${fmt(c.realizedProfitPer100kGold)}</td></tr><tr><td>Trades</td><td>3</td></tr><tr><td>Conservative realized ROI</td><td>${fmt(c.capitalRoiPct)}%</td></tr><tr><td>Residual inventory</td><td>${fmtInt(c.leftoverStartingCurrency)} ${esc(c.startCurrency.name)}</td></tr></table></section><section class="drawer-sec"><h3>Return-leg disclosure</h3><table class="detail"><tr><td>Return rate</td><td>${fmtInt(c.returnLeg.pay)} Divine → ${fmtInt(c.returnLeg.receive)} ${esc(c.startCurrency.name)}</td></tr><tr><td>Return-leg volume</td><td>${fmt(c.returnLeg.hourlyVolume)} / hr</td></tr><tr><td>Return-leg volume share</td><td>${pct(c.maxVolumeShare)}</td></tr><tr><td>Source age</td><td>${esc(c.sourceHourUtc)} UTC</td></tr><tr><td>Risk</td><td>${fmt(c.movementHaircutPct)}% movement / ${fmt(c.marketImpactHaircutPct)}% impact</td></tr></table></section>`;
}
function mtmDrawer(f) {
  return `<header class="drawer-head"><div class="item-lockup"><strong>${esc(f.item.name)}</strong><small>${esc(f.buyCurrency.name)} → ${esc(f.sellCurrency.name)}</small></div><button class="close" aria-label="Close">×</button></header><section class="drawer-sec playbook"><h3>Mark-to-market playbook</h3><ol><li>Pay ${fmtInt(f.buyLeg.pay)} ${esc(f.buyCurrency.name)} → receive ${fmtInt(f.buyLeg.receive)} ${esc(f.item.name)}. Gold: ${fmtInt(f.buyLeg.goldCost)}</li><li>Pay ${fmtInt(f.sellLeg.pay)} ${esc(f.item.name)} → receive ${fmtInt(f.sellLeg.receive)} ${esc(f.sellCurrency.name)}. Gold: ${fmtInt(f.sellLeg.goldCost)}</li></ol><p class="drawer-note"><strong>Ends in another currency — return conversion not included.</strong> This is not realized profit and cannot receive TRADE NOW.</p></section><section class="drawer-sec"><table class="detail"><tr><td>Conservative Divine-equivalent profit</td><td>${fmt(f.conservativeNetProfitDivine)} Div</td></tr><tr><td>Div / 100K Gold</td><td>${fmt(f.divPer100kGold)}</td></tr><tr><td>Total gold</td><td>${fmtInt(f.goldRequired)}</td></tr></table></section>`;
}
function openDrawer(r) { const body = $('#drawerInner'); body.innerHTML = tab === 'closed' ? cycleDrawer(r.cycle) : mtmDrawer(r.flip); $('#drawer').classList.add('open'); $('#drawer').setAttribute('aria-hidden','false'); $('#scrim').hidden = false; body.querySelector('.close').onclick = closeDrawer; }
function closeDrawer() { $('#drawer').classList.remove('open'); $('#drawer').setAttribute('aria-hidden','true'); $('#scrim').hidden = true; if (lastFocusedRow) lastFocusedRow.focus(); }
function renderStatus(status) { $('#sourceAge').textContent = status?.latest_successful_source_hour ? `Completed ${status.latest_successful_source_hour.replace('T',' ').slice(0,16)} UTC` : 'No completed ingestion yet'; $('#age').textContent = status?.latest_successful_source_hour?.slice(0,10) || '—'; $('#count').textContent = String(status?.candidate_count ?? 0); $('#completedAt').textContent = status?.completed_at ? `Completed ${String(status.completed_at).replace('T',' ').slice(0,16)} UTC` : '—'; $('#algorithmVersion').textContent = status?.algorithm_version ?? '—'; $('#runStatus').textContent = status?.run_status ?? '—'; }
async function load() { if (window.POE2_DEMO_DATA) { run = { routes: (window.POE2_DEMO_DATA.routes || []).map(normalizeOpportunityRow), status: window.POE2_DEMO_DATA.status }; renderStatus(run.status); render(); return; } const url = window.POE2_SUPABASE_URL || ''; const key = window.POE2_SUPABASE_PUBLISHABLE_KEY || ''; if (!url || !key) { run = { routes: [], status: null }; renderStatus(null); render(); return; } const headers = { apikey: key, Authorization: `Bearer ${key}` }; const [s, o] = await Promise.all([fetch(`${url}/rest/v1/opportunity_run_status?select=*`,{headers}), fetch(`${url}/rest/v1/opportunity_public?select=*&order=score.desc`,{headers})]); const statusRows = s.ok ? await s.json() : []; const rowsResp = o.ok ? await o.json() : []; run = { routes: (Array.isArray(rowsResp) ? rowsResp : []).map(normalizeOpportunityRow), status: statusRows[0] || null }; renderStatus(run.status); render(); }
document.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { tab = b.dataset.tab; document.querySelectorAll('[data-tab]').forEach(x => x.classList.toggle('active', x === b)); closeDrawer(); render(); });
const refresh = $('#refresh'); if (refresh) refresh.onclick = load; $('#scrim').onclick = closeDrawer; document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawer(); }); load();
