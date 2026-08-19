const $ = s => document.querySelector(s);
let run = null;
let lastFocusedRow = null;
let sortKey = 'dg';
let sortDir = -1; // -1 = descending (best Div / 100K Gold first)
const { normalizeOpportunityRow } = window.POE2Dashboard;

const fmt = n => new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(n);
const fmtInt = n => new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(n);
const pct = (n, d = 1) => `${(Number(n || 0) * 100).toFixed(d)}%`;

// Div / 100K Gold = Net Divine profit per 100K Gold (explicit denominator).
function divPer100k(f) {
  const gold = Number(f.goldRequired);
  if (!gold || gold <= 0) return 0;
  return (Number(f.conservativeNetProfitDivine) / gold) * 100_000;
}

function fillRiskBadge(label) {
  const cls = String(label || '').toLowerCase();
  return `<span class="risk ${cls}">${label || '—'}</span>`;
}

function iconCell(f) {
  const url = f?.item?.iconUrl || f?.buyCurrency?.iconUrl;
  const img = url ? `<img class="icon" src="${url}" alt="">` : '';
  return `<div class="item-cell">${img}<div class="item-lockup"><strong>${esc(f?.item?.name ?? '—')}</strong><small>${esc(f?.buyCurrency?.name ?? '')} → ${esc(f?.sellCurrency?.name ?? '')}</small></div></div>`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function rows() {
  // Only exact two-leg flips with a resolved product projection are listed.
  return (run?.routes || []).filter(r => r && r.flip && r.strategy === 'two-leg-cross');
}

function sortedRows() {
  const rs = rows();
  const map = new Map();
  for (const r of rs) {
    const f = r.flip;
    const dg = divPer100k(f);
    map.set(r.id, dg);
  }
  return rs.slice().sort((a, b) => sortDir * (divPer100k(a.flip) - divPer100k(b.flip)));
}

function render() {
  if (!run) return;
  const status = run.status;
  const hour = status?.latest_successful_source_hour ? new Date(status.latest_successful_source_hour) : null;
  const ageHours = hour ? Math.max(0, (Date.now() - hour.getTime()) / 36e5) : null;
  const completedAt = status?.completed_at ? new Date(status.completed_at) : null;
  if (status) {
    $('#sourceAge').textContent = hour
      ? `Completed ${hour.toISOString().replace('T', ' ').slice(0, 16)} UTC${ageHours > 2 ? ' · STALE' : ''}`
      : 'No completed ingestion yet';
    $('#age').textContent = hour ? hour.toISOString().slice(0, 10) : '—';
    $('#count').textContent = String(status.candidate_count ?? 0);
    $('#completedAt').textContent = completedAt ? `Completed ${completedAt.toISOString().replace('T', ' ').slice(0, 16)} UTC` : '—';
    $('#algorithmVersion').textContent = status.algorithm_version ?? '—';
    $('#runStatus').textContent = status.run_status ?? '—';
  } else {
    $('#sourceAge').textContent = 'No completed ingestion yet';
    $('#age').textContent = '—'; $('#count').textContent = '0';
    $('#completedAt').textContent = '—'; $('#algorithmVersion').textContent = '—'; $('#runStatus').textContent = '—';
  }

  const rs = sortedRows();
  $('#routes').innerHTML = rs.map(r => {
    const f = r.flip;
    const dg = divPer100k(f);
    const rec = f.recommendation ? f.recommendation.action : 'Insufficient history';
    const trend = f.trend ? f.trend.change24hPct : 'Insufficient history';
    return `<tr class="clickable" data-id="${esc(r.id)}">
      <td>${iconCell(f)}</td>
      <td><div class="path"><span class="pay">Pay <b>${fmtInt(f.buyLeg.pay)}</b> ${esc(f.buyCurrency.name)}</span> → <span class="get">Get <b>${fmtInt(f.buyLeg.receive)}</b> ${esc(f.item.name)}</span> <small class="mnem">then sell ${fmtInt(f.sellLeg.pay)} for ${fmtInt(f.sellLeg.receive)} ${esc(f.sellCurrency.name)}</small></div></td>
      <td class="green"><strong>+${f.conservativeNetProfitDivine.toFixed(2)}</strong> <small>Div</small></td>
      <td class="dg"><strong>${fmt(dg)}</strong> <small>per 100K gold</small></td>
      <td>${fmt(f.lowestLegVolume || 0)} <small>lowest leg / hr</small></td>
      <td>${fillRiskBadge(f.fillRiskLabel)}</td>
      <td>${fmtInt(f.goldRequired)}</td>
      <td>${trend === 'Insufficient history' ? '<span class="hist">Insufficient history</span>' : `${trend > 0 ? '+' : ''}${trend}%`}</td>
      <td>${esc(rec)}</td>
    </tr>`;
  }).join('') || `<tr><td colspan="9" class="empty">${status ? 'This hour completed with 0 executable two-leg flips (Phase 0 rejected every signal for valuation liquidity / unverified gold — no invented opportunities).' : 'No completed ingestion data is available yet. The dashboard will not fall back to fixtures.'}</td></tr>`;

  // wire row clicks to the drawer
  document.querySelectorAll('#routes tr.clickable').forEach(tr => {
    tr.setAttribute('tabindex', '0');
    tr.setAttribute('role', 'button');
    tr.onclick = () => { lastFocusedRow = tr; openDrawer(rs.find(x => x.id === tr.dataset.id)); };
    tr.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); lastFocusedRow = tr; openDrawer(rs.find(x => x.id === tr.dataset.id)); } };
  });
}

// ---------------------------------------------------------------------------
// Detail drawer: exact two-step playbook, complete P&L, gold, lowest-leg
// volume, fill risk, valuation disclosure, mark-to-market vs realized.
// ---------------------------------------------------------------------------
function openDrawer(r) {
  const f = r.flip;
  const closed = f.profitKind === 'closed-realized';
  const drawer = $('#drawerInner');
  drawer.innerHTML = `
    <header class="drawer-head">
      <div class="item-lockup"><strong>${esc(f.item.name)}</strong><small>${esc(f.buyCurrency.name)} → ${esc(f.sellCurrency.name)} · ${esc(r.league)}</small></div>
      <button class="close" id="drawerClose" aria-label="Close">×</button>
    </header>

    <section class="drawer-sec playbook">
      <h3>In-game playbook — do exactly this</h3>
      <ol>
        <li><b>Step 1 — Buy the item.</b> In the Currency Exchange, offer <b>${fmtInt(f.buyLeg.pay)} ${esc(f.buyCurrency.name)}</b> and receive <b>${fmtInt(f.buyLeg.receive)} ${esc(f.item.name)}</b>. Gold fee ≈ <b>${fmtInt(f.buyLeg.goldCost)}</b>.</li>
        <li><b>Step 2 — Sell the same item.</b> Offer <b>${fmtInt(f.sellLeg.pay)} ${esc(f.item.name)}</b> and receive <b>${fmtInt(f.sellLeg.receive)} ${esc(f.sellCurrency.name)}</b>. Gold fee ≈ <b>${fmtInt(f.sellLeg.goldCost)}</b>.</li>
      </ol>
      <p class="drawer-note">Two trades total. These are exact integer quantities from the audited market quotes — not estimates.</p>
    </section>

    <section class="drawer-sec">
      <h3>P&amp;L calculation</h3>
      <table class="detail">
        <tr><td>Input value (buy amount, Divine-equivalent)</td><td>${f.inputDivineValue.toFixed(3)} Div</td></tr>
        <tr><td>Input paid</td><td>${fmtInt(f.buyLeg.pay)} ${esc(f.buyCurrency.name)}</td></tr>
        <tr><td>Output received</td><td>${fmtInt(f.sellLeg.receive)} ${esc(f.sellCurrency.name)}</td></tr>
        <tr><td>Output value (Divine-equivalent)</td><td>${f.outputDivineValue.toFixed(3)} Div</td></tr>
        <tr><td>Gross profit</td><td class="green">${f.grossProfitDivine.toFixed(3)} Div</td></tr>
        <tr><td>Movement / market-impact haircut</td><td>${Number(f.movementHaircutPct || 0).toFixed(1)}%</td></tr>
        <tr class="total"><td>Conservative net profit</td><td class="green">${f.conservativeNetProfitDivine.toFixed(3)} Div</td></tr>
      </table>
    </section>

    <section class="drawer-sec">
      <h3>Gold, volume &amp; fill risk</h3>
      <table class="detail">
        <tr><td>Gold required (both legs)</td><td>${fmtInt(f.goldRequired)}</td></tr>
        <tr><td>Div / 100K Gold (net Divine per 100K gold)</td><td>${fmt(divPer100k(f))}</td></tr>
        <tr><td>Lowest-leg volume</td><td>${fmt(f.lowestLegVolume)} / hr</td></tr>
        <tr><td>Volume share (bottleneck)</td><td>${pct(f.volumeShare)}</td></tr>
        <tr><td>Fill risk (estimate)</td><td>${fillRiskBadge(f.fillRiskLabel)} <small>${(f.fillRisk * 100).toFixed(0)}% — heuristic from volume &amp; spread, not a guarantee</small></td></tr>
      </table>
    </section>

    <section class="drawer-sec">
      <h3>Valuation &amp; classification</h3>
      <table class="detail">
        <tr><td>Profit kind</td><td>${esc(f.profitKind)}</td></tr>
        <tr><td>Classification</td><td>${closed ? 'Closed realized loop' : 'Mark-to-market (return conversion NOT included; ends in another currency)'}</td></tr>
        <tr><td>Valuation path liquidity</td><td>${fmt(f.valuation?.valuationBottleneckVolumeShare ?? 0)} share</td></tr>
        <tr><td>Valuation confidence</td><td>${pct(f.valuation?.valuationConfidence ?? 0)}</td></tr>
        <tr><td>Valuation range uncertainty</td><td>${(f.valuation?.valuationRangeUncertaintyPct ?? 0).toFixed(1)}%</td></tr>
        <tr><td>Ratio range (this hour)</td><td>${f.ratioRangePct?.toFixed(1) ?? '—'}%</td></tr>
        <tr><td>Capital ROI</td><td>${f.capitalRoiPct?.toFixed(1) ?? '—'}%</td></tr>
        <tr><td>Expected profit (conservative→gross)</td><td>${f.expectedProfitDivine?.toFixed(3) ?? '—'} Div</td></tr>
        <tr><td>Fill confidence</td><td>${pct(f.confidence ?? 0)}</td></tr>
        <tr><td>Source age</td><td>${f.sourceAgeHours?.toFixed(1) ?? '—'} h (${esc(f.sourceHourUtc ?? '')} UTC)</td></tr>
      </table>
      <p class="drawer-note">Valuation reference rates and their source age are disclosed here. Mark-to-market signals are not realized profit.</p>
    </section>

    <section class="drawer-sec">
      <h3>Trend &amp; history</h3>
      <p class="drawer-note"><strong>Insufficient history.</strong> Phase B compact-hourly history is not enabled, so no trend chart, heatmap, or recommendation is derived — nothing is fabricated from missing data. Recommendations only ever appear once deterministic (UTC) hourly history with a minimum sample is collected (Phase B/C).</p>
    </section>
  `;
  $('#drawer').classList.add('open');
  $('#drawer').setAttribute('aria-hidden', 'false');
  $('#scrim').hidden = false;
  $('#drawerClose').onclick = closeDrawer;
}

function closeDrawer() {
  $('#drawer').classList.remove('open');
  $('#drawer').setAttribute('aria-hidden', 'true');
  $('#scrim').hidden = true;
  if (lastFocusedRow) lastFocusedRow.focus();
}

async function load() {
  // Demo mode: render static fixture; never hit the network or clobber it.
  if (window.POE2_DEMO_DATA) {
    const demo = window.POE2_DEMO_DATA;
    run = { routes: (demo.routes || []).map(normalizeOpportunityRow), status: demo.status || null, league: demo.league || 'Runes of Aldur', settings: {} };
    render();
    return;
  }
  const url = window.POE2_SUPABASE_URL || '';
  const key = window.POE2_SUPABASE_PUBLISHABLE_KEY || '';
  if (!url || !key) {
    run = { routes: [], status: null, league: '', settings: {} };
    $('#sourceAge').textContent = 'No live connection configured';
    $('#age').textContent = '—'; $('#count').textContent = '0';
    render();
    return;
  }
  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  const [statusRes, rowsRes] = await Promise.all([
    fetch(`${url}/rest/v1/opportunity_run_status?select=*`, { headers }),
    fetch(`${url}/rest/v1/opportunity_public?select=*&order=score.desc`, { headers }),
  ]);
  if (!statusRes.ok || !rowsRes.ok) {
    $('#sourceAge').textContent = `Live read unavailable (${statusRes.status}/${rowsRes.status})`;
    run = { routes: [], status: null, league: '', settings: {} };
    render();
    return;
  }
  const statusRows = await statusRes.json();
  const status = Array.isArray(statusRows) && statusRows.length ? statusRows[0] : null;
  const rowsResp = await rowsRes.json();
  const routes = (Array.isArray(rowsResp) ? rowsResp : []).map(normalizeOpportunityRow);
  run = { routes, status, league: status?.league ?? '', settings: {} };
  render();
}

// Sortable Div / 100K Gold column (default best-first descending).
const refreshBtn = $('#refresh'); if (refreshBtn) refreshBtn.onclick = load;
const scrimEl = $('#scrim'); if (scrimEl) scrimEl.onclick = closeDrawer;
const drawerCloseBtn = $('#drawerClose'); if (drawerCloseBtn) drawerCloseBtn.onclick = closeDrawer;
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawer(); });
load();

// Demo-mode hook: window.POE2_DEMO_DATA lets a static build render a fixture.
if (window.POE2_DEMO_DATA) {
  const demo = window.POE2_DEMO_DATA;
  run = { routes: (demo.routes || []).map(normalizeOpportunityRow), status: demo.status || null, league: demo.league || 'Runes of Aldur', settings: {} };
  render();
}
// Zero-candidate hook: a REAL-style completed hour with 0 publishable flips
// (the honest Phase 0 output), captured for the live dashboard's empty state.
if (window.POE2_ZERO_DATA) {
  const zero = window.POE2_ZERO_DATA;
  run = { routes: [], status: zero.status || null, league: zero.league || 'Runes of Aldur', settings: {} };
  render();
}
