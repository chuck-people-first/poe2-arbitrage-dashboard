const $=s=>document.querySelector(s);let run=null,tab='cross';
const {normalizeOpportunityRow,name}=window.POE2Dashboard;
const fmt=n=>new Intl.NumberFormat('en-US',{maximumFractionDigits:2}).format(n);
const MARKET='mark-to-market', CLOSED='closed-realized';

// Item 6: mark-to-market and closed-realized results are never mixed under an
// unlabeled "profit" ranking. `tab` selects a surface: 'cross' = cross-currency
// signals (mark-to-market), 'closed' = closed realized loops.
const isClosed = r => (r.profitClass ?? (r.strategy==='closed-triangle'?CLOSED:MARKET)) === CLOSED;

function rowClass(r){ return isClosed(r) ? CLOSED : MARKET; }

function render(){
  if(!run) return;
  const status = run.status;
  // Source of truth for the header is the safe status projection
  // (opportunity_run_status), NOT the first opportunity row — a successful
  // zero-opportunity hour must render "Completed HH:00 UTC / 0 candidates"
  // without looking like a connection failure or falling back to an older hour.
  const hour = status?.latest_successful_source_hour ? new Date(status.latest_successful_source_hour) : null;
  const ageHours = hour ? Math.max(0,(Date.now()-hour.getTime())/36e5) : null;
  const completedAt = status?.completed_at ? new Date(status.completed_at) : null;
  if(status){
    $('#sourceAge').textContent = hour
      ? `Completed ${hour.toISOString().replace('T',' ').slice(0,16)} UTC${ageHours>2?' · STALE':''} · ${name(status.league??'')}`
      : 'No completed ingestion yet';
    $('#age').textContent = hour ? hour.toISOString().slice(0,10) : '—';
    $('#count').textContent = String(status.candidate_count ?? 0); // 0 is a valid answer
    $('#completedAt').textContent = completedAt ? `Completed ${completedAt.toISOString().replace('T',' ').slice(0,16)} UTC` : '—';
    $('#algorithmVersion').textContent = status.algorithm_version ?? '—';
    $('#runStatus').textContent = status.run_status ?? '—';
  } else {
    $('#sourceAge').textContent = 'No completed ingestion yet';
    $('#age').textContent='—'; $('#count').textContent='0';
    $('#completedAt').textContent='—'; $('#algorithmVersion').textContent='—'; $('#runStatus').textContent='—';
  }
  const rows = (run.routes||[]).filter(r => tab==='cross' ? !isClosed(r) : tab==='closed' ? isClosed(r) : true);
  $('#tabTitle').textContent = tab==='cross'?'Cross-currency signals':tab==='closed'?'Closed realized loops':'All signals';
  $('#tabHint').textContent = tab==='cross'
    ? 'Mark-to-market edges: ends in another currency; return conversion NOT included.'
    : tab==='closed'
      ? 'Closed realized loops: profit is realized in the loop currency.'
      : 'Both surfaces shown — labels distinguish mark-to-market from closed-realized.';
  $('#routes').innerHTML = rows.map(r=>{
    const closed = isClosed(r);
    const legs=(r.legs||[]).map(l=>`${l.playbook.give} ${name(l.from)} → ${l.playbook.receive} ${name(l.to)}`).join(' · ');
    const profitLabel = closed ? 'Realized profit' : 'Conservative mark-to-market edge';
    const returnNote = closed
      ? (r.realizedCurrency ? `Closed in ${name(r.realizedCurrency)}` : 'Closed in base currency')
      : 'Return conversion not included';
    const profit = closed ? (r.realizedProfitStart ?? r.conservativeProfitBase) : r.conservativeProfitBase;
    const profitUnit = closed && r.realizedCurrency && !String(r.realizedCurrency).includes('CurrencyModValues') ? name(r.realizedCurrency) : 'Divine';
    return `<tr><td><strong>${closed?'▲':'='} ${r.startUnits} ${name(r.startCurrency)} → ${r.endUnits} ${name(r.endCurrency)}</strong><div class="route-sub">${legs}</div></td><td><span class="badge ${closed?'tri':''}">${closed?'3 legs':'2 legs'} · ${Math.round((r.fillConfidence||0)*100)}% conf.</span><div class="route-sub">${profitLabel} · ${returnNote}</div></td><td class="green"><strong>+${Number(profit||0).toFixed(2)} ${profitUnit}</strong><div class="route-sub">haircut ${Number(r.movementHaircutPct||0).toFixed(1)}%</div></td><td>${fmt(Number(r.profitPer1mGold||0))}</td><td>${Number(r.profitPerTrade||0).toFixed(3)}</td><td>${Number(r.capitalRoiPct||0).toFixed(1)}%</td><td>${fmt(Number(r.goldCostTotal||r.gold_cost||0))}</td><td>${(Number(r.bottleneckVolumeShare||r.bottleneck_volume_share||0)*100).toFixed(1)}%</td></tr>`;
  }).join('') || `<tr><td colspan="8" class="empty">${status ? 'This hour completed with 0 candidates for the selected surface.' : 'No completed ingestion data is available yet. The dashboard will not fall back to fixtures.'}</td></tr>`;
}

async function load(){
  const url=window.POE2_SUPABASE_URL || '';
  const key=window.POE2_SUPABASE_PUBLISHABLE_KEY || '';
  if(!url||!key){run={routes:[],status:null,league:'',settings:{}};$('#sourceAge').textContent='No live connection configured';$('#age').textContent='—';$('#count').textContent='0';render();return}
  const headers={apikey:key,Authorization:`Bearer ${key}`};
  // Item 3: the SAFE STATUS projection is the source of truth for the latest
  // successful source hour, candidate count, algorithm version, completed time
  // and stale-state. The opportunity view supplies the candidate rows.
  const [statusRes, rowsRes] = await Promise.all([
    fetch(`${url}/rest/v1/opportunity_run_status?select=*`,{headers}),
    fetch(`${url}/rest/v1/opportunity_public?select=*&order=score.desc`,{headers}),
  ]);
  if(!statusRes.ok || !rowsRes.ok){
    $('#sourceAge').textContent=`Live read unavailable (${statusRes.status}/${rowsRes.status})`;
    run={routes:[],status:null,league:'',settings:{}};render();return;
  }
  const statusRows = await statusRes.json();
  const status = Array.isArray(statusRows) && statusRows.length ? statusRows[0] : null;
  const rows = await rowsRes.json();
  const routes = (Array.isArray(rows)?rows:[]).map(normalizeOpportunityRow);
  run={routes,status,league:status?.league??'',settings:{}};render();
}
document.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>{document.querySelectorAll('[data-tab]').forEach(x=>x.classList.remove('active'));b.classList.add('active');tab=b.dataset.tab;render()});$('#refresh').onclick=load;load();
