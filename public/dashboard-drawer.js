// Drawer-only demo loader: populates the drawer from the demo fixture and
// auto-opens it (for screenshot capture of the detail drawer). This page is
// strictly a demo artifact — never loaded by the live index.html.
(function () {
  function normalizeOpportunityRow(row) {
    const route = row && row.route && typeof row.route === 'object' ? row.route : {};
    return { ...route, id: row?.id ?? route.id, flip: route.flip || null, league: row?.league ?? route.league };
  }
  const demo = window.POE2_DEMO_DATA;
  if (!demo) return;
  const first = (demo.routes || []).map(normalizeOpportunityRow).find((r) => r && r.flip);
  if (!first) return;

  const f = first.flip;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = n => new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(n);
  const fmtInt = n => new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(n);
  const pct = (n, d = 1) => `${(Number(n || 0) * 100).toFixed(d)}%`;
  const divPer100k = (g) => { const gold = Number(g.goldRequired); return gold > 0 ? (Number(g.conservativeNetProfitDivine) / gold) * 100_000 : 0; };
  const riskBadge = (label) => `<span class="risk ${String(label || '').toLowerCase()}">${label || '—'}</span>`;
  const closed = f.profitKind === 'closed-realized';

  document.getElementById('drawerInner').innerHTML = `
    <header class="drawer-head">
      <div class="item-lockup"><strong>${esc(f.item.name)}</strong><small>${esc(f.buyCurrency.name)} → ${esc(f.sellCurrency.name)} · ${esc(first.league)}</small></div>
      <button class="close" aria-label="Close">×</button>
    </header>
    <section class="drawer-sec playbook"><h3>In-game playbook — do exactly this</h3>
      <ol>
        <li><b>Step 1 — Buy the item.</b> Offer <b>${fmtInt(f.buyLeg.pay)} ${esc(f.buyCurrency.name)}</b> and receive <b>${fmtInt(f.buyLeg.receive)} ${esc(f.item.name)}</b>. Gold fee ≈ <b>${fmtInt(f.buyLeg.goldCost)}</b>.</li>
        <li><b>Step 2 — Sell the same item.</b> Offer <b>${fmtInt(f.sellLeg.pay)} ${esc(f.item.name)}</b> and receive <b>${fmtInt(f.sellLeg.receive)} ${esc(f.sellCurrency.name)}</b>. Gold fee ≈ <b>${fmtInt(f.sellLeg.goldCost)}</b>.</li>
      </ol>
      <p class="drawer-note">Two trades total. Exact integer quantities from the audited market quotes — not estimates.</p>
    </section>
    <section class="drawer-sec"><h3>P&amp;L calculation</h3>
      <table class="detail">
        <tr><td>Input value (buy amount, Divine-equiv)</td><td>${f.inputDivineValue.toFixed(3)} Div</td></tr>
        <tr><td>Input paid</td><td>${fmtInt(f.buyLeg.pay)} ${esc(f.buyCurrency.name)}</td></tr>
        <tr><td>Output received</td><td>${fmtInt(f.sellLeg.receive)} ${esc(f.sellCurrency.name)}</td></tr>
        <tr><td>Output value (Divine-equiv)</td><td>${f.outputDivineValue.toFixed(3)} Div</td></tr>
        <tr><td>Gross profit</td><td class="green">${f.grossProfitDivine.toFixed(3)} Div</td></tr>
        <tr><td>Movement / market-impact haircut</td><td>${Number(f.movementHaircutPct || 0).toFixed(1)}%</td></tr>
        <tr class="total"><td>Conservative net profit</td><td class="green">${f.conservativeNetProfitDivine.toFixed(3)} Div</td></tr>
      </table>
    </section>
    <section class="drawer-sec"><h3>Gold, volume &amp; fill risk</h3>
      <table class="detail">
        <tr><td>Gold required (both legs)</td><td>${fmtInt(f.goldRequired)}</td></tr>
        <tr><td>Div / 100K Gold (net Divine per 100K gold)</td><td><strong>${fmt(divPer100k(f))}</strong></td></tr>
        <tr><td>Lowest-leg volume</td><td>${fmt(f.lowestLegVolume)} / hr</td></tr>
        <tr><td>Volume share (bottleneck)</td><td>${pct(f.volumeShare)}</td></tr>
        <tr><td>Fill risk (estimate)</td><td>${riskBadge(f.fillRiskLabel)} <small>${(f.fillRisk * 100).toFixed(0)}% — estimate, not guarantee</small></td></tr>
      </table>
    </section>
    <section class="drawer-sec"><h3>Valuation &amp; classification</h3>
      <table class="detail">
        <tr><td>Profit kind</td><td>${esc(f.profitKind)}</td></tr>
        <tr><td>Classification</td><td>${closed ? 'Closed realized loop' : 'Mark-to-market (return conversion NOT included)'}</td></tr>
        <tr><td>Valuation path liquidity</td><td>${fmt(f.valuation?.valuationBottleneckVolumeShare ?? 0)} share</td></tr>
        <tr><td>Valuation confidence</td><td>${pct(f.valuation?.valuationConfidence ?? 0)}</td></tr>
        <tr><td>Valuation range uncertainty</td><td>${(f.valuation?.valuationRangeUncertaintyPct ?? 0).toFixed(1)}%</td></tr>
        <tr><td>Capital ROI</td><td>${f.capitalRoiPct?.toFixed(1) ?? '—'}%</td></tr>
        <tr><td>Source age</td><td>${f.sourceAgeHours?.toFixed(1) ?? '—'} h (${esc(f.sourceHourUtc ?? '')} UTC)</td></tr>
      </table>
      <p class="drawer-note">Mark-to-market signals are not realized profit.</p>
    </section>
    <section class="drawer-sec"><h3>Trend &amp; history</h3>
      <p class="drawer-note"><strong>Insufficient history.</strong> Phase B compact-hourly history is not enabled, so no trend chart, heatmap, or recommendation is derived — nothing is fabricated from missing data.</p>
    </section>
  `;
})();
