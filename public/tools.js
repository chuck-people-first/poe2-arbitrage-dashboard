// Tools page UI. Logic lives in tools-core.js (window.POE2Tools); this file
// only wires the DOM, loads the price book and persists per-browser state.
(function () {
  const T = window.POE2Tools;
  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---- per-browser storage (never required for the page to work) ---------
  const store = {
    get(key, fallback) { try { const v = localStorage.getItem(`poe2tools:${key}`); return v === null ? fallback : JSON.parse(v); } catch { return fallback; } },
    set(key, value) { try { localStorage.setItem(`poe2tools:${key}`, JSON.stringify(value)); } catch { /* private mode */ } },
  };

  let index = T.indexBook({ items: [] });
  const league = () => $('league').value.trim() || 'Runes of Aldur';

  function fmt(n, digits) {
    if (n === null || n === undefined || !Number.isFinite(n)) return '—';
    const d = digits ?? (Math.abs(n) >= 100 ? 0 : Math.abs(n) >= 1 ? 2 : Math.abs(n) >= 0.01 ? 3 : 5);
    return n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: d });
  }
  function money(divine) {
    const c = T.convert(divine, index.book?.hubRatesPerDivine);
    if (!c) return '—';
    return `<span class="v-div">${fmt(c.divine)} Div</span><span class="v-ex">${fmt(c.exalted)} Ex</span><span class="v-ch">${fmt(c.chaos)} Chaos</span>`;
  }
  function icon(item) { return item?.icon ? `<img class="ico" src="${esc(item.icon)}" alt="" loading="lazy">` : ''; }
  function change(pct) {
    if (pct === null || pct === undefined) return '<span class="muted">—</span>';
    return `<span class="${pct > 0 ? 'green' : pct < 0 ? 'red' : 'muted'}">${pct > 0 ? '+' : ''}${fmt(pct, 1)}%</span>`;
  }
  function spark(points) {
    if (!points?.length) return '';
    const min = Math.min(...points); const max = Math.max(...points); const span = max - min || 1;
    const d = points.map((p, i) => `${(i / Math.max(1, points.length - 1)) * 60},${18 - ((p - min) / span) * 16}`).join(' ');
    return `<svg class="spark" viewBox="0 0 60 20" aria-hidden="true"><polyline points="${d}"/></svg>`;
  }

  // ---- price book ---------------------------------------------------------
  async function loadBook() {
    $('bookAge').textContent = 'Loading prices…';
    let book = null;
    try {
      const r = await fetch(`/api/prices?league=${encodeURIComponent(league())}`);
      if (r.ok) book = await r.json();
    } catch { /* fall through to the sample */ }
    if (!book?.items?.length) {
      try { const r = await fetch('/tools-sample-prices.json'); if (r.ok) book = { ...(await r.json()), sample: true }; } catch { /* none */ }
    }
    index = T.indexBook(book || { items: [] });
    const items = index.book.items || [];
    $('bookSource').textContent = book?.sample ? 'Sample prices (offline)' : 'poe.ninja live';
    $('bookDot').classList.toggle('warn', !!book?.sample || !items.length);
    $('bookAge').textContent = book?.fetchedAtUtc ? `As of ${new Date(book.fetchedAtUtc).toLocaleString()}` : 'No prices available';
    $('bookCount').textContent = `${items.length} items${book?.failedCategories?.length ? ` · missing ${book.failedCategories.join(', ')}` : ''}`;
    $('itemNames').innerHTML = items.map((i) => `<option value="${esc(i.name)}">`).join('');
    const cats = [...new Set(items.map((i) => i.category))].sort();
    $('econCategory').innerHTML = '<option value="">All</option>' + cats.map((c) => `<option>${esc(c)}</option>`).join('');
    renderAll();
  }

  // ---- tabs ---------------------------------------------------------------
  function showTool(name) {
    document.querySelectorAll('.tool-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tool === name));
    document.querySelectorAll('.tool').forEach((p) => { p.hidden = p.dataset.panel !== name; });
    store.set('tab', name);
    if (location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`);
  }
  document.querySelectorAll('.tool-tabs button').forEach((b) => b.addEventListener('click', () => showTool(b.dataset.tool)));

  // ---- price check --------------------------------------------------------
  function renderPrice() {
    const text = $('priceInput').value;
    if (!text.trim()) { $('priceResult').innerHTML = '<div class="empty">Paste an item to see its value.</div>'; return; }
    const r = T.priceCheck(index, text);
    const p = r.parsed;
    const title = `${esc(p.name || '')}${p.baseType && p.baseType !== p.name ? `<small>${esc(p.baseType)}</small>` : ''}`;
    const trade = `<a class="btn ghost" href="${esc(T.tradeUrl(league(), p))}" target="_blank" rel="noopener">Search official trade ↗</a>`;
    if (!r.item) {
      $('priceResult').innerHTML = `<h3>${title}</h3><p class="muted">${p.rarity ? `${esc(p.rarity)} ${esc(p.itemClass || 'item')} — ` : ''}not on the currency exchange, so there is no snapshot price. Check live listings instead:</p>${trade}`;
      return;
    }
    $('priceResult').innerHTML = `
      <div class="pc-head">${icon(r.item)}<div><h3>${esc(r.item.name)}</h3><small class="muted">${esc(r.item.category)} · 7-day ${change(r.item.changePct)}</small></div>${spark(r.item.sparkline)}</div>
      <div class="pc-line"><span>Each</span><div class="money">${money(r.item.divine)}</div></div>
      ${r.quantity > 1 ? `<div class="pc-line total"><span>× ${fmt(r.quantity, 0)}</span><div class="money">${money(r.totalDivine)}</div></div>` : ''}
      ${trade}`;
  }
  $('priceInput').addEventListener('input', renderPrice);
  $('priceClear').addEventListener('click', () => { $('priceInput').value = ''; renderPrice(); });
  $('pricePaste').addEventListener('click', async () => {
    try { $('priceInput').value = await navigator.clipboard.readText(); renderPrice(); } catch { $('priceInput').focus(); }
  });

  // ---- stash value --------------------------------------------------------
  $('stashInput').value = store.get('stash', '');
  function renderStash() {
    const text = $('stashInput').value;
    store.set('stash', text);
    const v = T.valueStash(index, T.parseStashLines(text));
    $('stashRows').innerHTML = v.rows.length ? v.rows.map((row) => `
      <tr class="${row.item ? '' : 'unpriced'}"><td>${icon(row.item)}${esc(row.item?.name || row.name)}${row.item ? '' : '<small>no price found</small>'}</td>
      <td>${fmt(row.quantity, 0)}</td><td>${fmt(row.divineEach)}</td><td>${fmt(row.totalDivine)}</td></tr>`).join('')
      : '<tr><td colspan="4" class="empty">Add items on the left.</td></tr>';
    $('stashTotals').innerHTML = `<article><span>Total value</span><div class="money big">${money(v.totalDivine)}</div>${v.unpriced ? `<small>${v.unpriced} line(s) not priced</small>` : ''}</article>`;
  }
  $('stashInput').addEventListener('input', renderStash);
  function picker(input, list, onPick) {
    const draw = () => {
      const hits = T.searchItems(index, input.value, 8);
      list.innerHTML = hits.map((i, n) => `<button type="button" data-n="${n}">${icon(i)}${esc(i.name)}<small>${fmt(i.divine)} Div</small></button>`).join('');
      list.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { onPick(hits[Number(b.dataset.n)]); input.value = ''; list.innerHTML = ''; }));
    };
    input.addEventListener('input', draw);
  }
  picker($('stashPick'), $('stashPickList'), (item) => {
    const box = $('stashInput');
    box.value = `${box.value.replace(/\s*$/, '')}${box.value.trim() ? '\n' : ''}1 ${item.name}`;
    renderStash();
  });

  // ---- economy ------------------------------------------------------------
  function renderEconomy() {
    const q = T.norm($('econSearch').value);
    const cat = $('econCategory').value;
    const sort = $('econSort').value;
    const rates = index.book?.hubRatesPerDivine || {};
    const rows = (index.book?.items || []).filter((i) => (!cat || i.category === cat) && (!q || T.norm(i.name).includes(q)));
    const by = { value: (a, b) => b.divine - a.divine, volume: (a, b) => (b.volumeDivine ?? 0) - (a.volumeDivine ?? 0), change: (a, b) => (b.changePct ?? -1e9) - (a.changePct ?? -1e9), name: (a, b) => a.name.localeCompare(b.name) };
    rows.sort(by[sort] || by.value);
    $('econRows').innerHTML = rows.slice(0, 300).map((i) => `
      <tr><td class="cell-name">${icon(i)}${esc(i.name)}</td><td class="muted">${esc(i.category)}</td><td>${fmt(i.divine)}</td>
      <td>${fmt(rates.exalted ? i.divine * rates.exalted : null)}</td><td>${fmt(rates.chaos ? i.divine * rates.chaos : null)}</td>
      <td>${spark(i.sparkline)} ${change(i.changePct)}</td><td>${fmt(i.volumeDivine, 0)}</td></tr>`).join('')
      || '<tr><td colspan="7" class="empty">No items match.</td></tr>';
  }
  ['econSearch', 'econCategory', 'econSort'].forEach((id) => $(id).addEventListener('input', renderEconomy));
  function renderConverter() {
    const amount = Number($('convAmount').value);
    const from = T.findItem(index, $('convFrom').value);
    const to = T.findItem(index, $('convTo').value);
    $('convOut').textContent = from && to && amount >= 0 ? `${fmt((amount * from.divine) / to.divine)} ${to.name}` : 'Pick two priced items';
  }
  ['convAmount', 'convFrom', 'convTo'].forEach((id) => $(id).addEventListener('input', renderConverter));

  // ---- EV calculator ------------------------------------------------------
  let ev = store.get('ev', {
    costs: [{ quantity: 1, name: 'Exalted Orb' }],
    outcomes: [
      { probPct: 10, quantity: 1, name: '', value: 1, unit: 'divine' },
      { probPct: 90, quantity: 1, name: '', value: 0, unit: 'divine' },
    ],
  });
  function evRow(kind, line, n) {
    const priced = line.name ? T.findItem(index, line.name) : null;
    return `<div class="ev-row" data-kind="${kind}" data-n="${n}">
      ${kind === 'outcomes' ? `<label>Chance %<input data-f="probPct" type="number" min="0" max="100" step="any" value="${esc(line.probPct ?? '')}"></label>` : ''}
      <label>Qty<input data-f="quantity" type="number" min="0" step="any" value="${esc(line.quantity ?? 1)}"></label>
      <label class="grow">Item (priced from book)<input data-f="name" list="itemNames" value="${esc(line.name ?? '')}" placeholder="${kind === 'costs' ? 'e.g. Exalted Orb' : 'leave blank for a custom value'}"></label>
      <label>…or value<input data-f="value" type="number" min="0" step="any" value="${esc(line.value ?? '')}" ${priced ? 'disabled' : ''}></label>
      <label>Unit<select data-f="unit" ${priced ? 'disabled' : ''}>${['divine', 'exalted', 'chaos'].map((u) => `<option ${line.unit === u ? 'selected' : ''}>${u}</option>`).join('')}</select></label>
      <span class="ev-val">${fmt(T.lineDivine(index, line))} Div</span>
      <button class="ghost x" data-del aria-label="Remove">×</button>
    </div>`;
  }
  function renderEv(redraw = true) {
    store.set('ev', ev);
    if (redraw) {
      $('evCosts').innerHTML = ev.costs.map((l, n) => evRow('costs', l, n)).join('');
      $('evOutcomes').innerHTML = ev.outcomes.map((l, n) => evRow('outcomes', l, n)).join('');
    } else {
      document.querySelectorAll('.ev-row').forEach((row) => {
        const line = ev[row.dataset.kind][Number(row.dataset.n)];
        row.querySelector('.ev-val').textContent = `${fmt(T.lineDivine(index, line))} Div`;
        const priced = !!(line.name && T.findItem(index, line.name));
        row.querySelectorAll('[data-f="value"],[data-f="unit"]').forEach((el) => { el.disabled = priced; });
      });
    }
    const r = T.expectedValue(index, ev.costs, ev.outcomes);
    const verdict = r.net > 0 ? 'green' : r.net < 0 ? 'red' : '';
    $('evTotals').innerHTML = `
      <article><span>Cost per attempt</span><div class="money">${money(r.costDivine)}</div></article>
      <article><span>Expected return</span><div class="money">${money(r.evDivine)}</div></article>
      <article class="${verdict}"><span>EV per attempt</span><div class="money big">${money(r.net)}</div><small>${r.roiPct === null ? '' : `${r.roiPct > 0 ? '+' : ''}${fmt(r.roiPct, 1)}% ROI`}</small></article>
      <article><span>Odds entered</span><strong>${fmt(r.probTotalPct, 1)}%</strong><small>${Math.abs(r.probTotalPct - 100) > 0.01 ? 'Outcomes do not sum to 100% — the rest counts as worth nothing.' : 'Covers every outcome.'}${r.unpriced ? ` ${r.unpriced} line(s) unpriced.` : ''}</small></article>`;
  }
  ['evCosts', 'evOutcomes'].forEach((id) => {
    const box = $(id);
    box.addEventListener('input', (e) => {
      const row = e.target.closest('.ev-row'); const f = e.target.dataset.f;
      if (!row || !f) return;
      ev[row.dataset.kind][Number(row.dataset.n)][f] = e.target.type === 'number' ? (e.target.value === '' ? '' : Number(e.target.value)) : e.target.value;
      renderEv(false);
    });
    box.addEventListener('click', (e) => {
      if (!e.target.matches('[data-del]')) return;
      const row = e.target.closest('.ev-row');
      ev[row.dataset.kind].splice(Number(row.dataset.n), 1);
      renderEv();
    });
  });
  $('evAddCost').addEventListener('click', () => { ev.costs.push({ quantity: 1, name: '' }); renderEv(); });
  $('evAddOutcome').addEventListener('click', () => { ev.outcomes.push({ probPct: 0, quantity: 1, name: '', value: '', unit: 'divine' }); renderEv(); });

  // ---- regex builder ------------------------------------------------------
  // Starter labels. GGG renames lines between patches, so every label stays
  // editable and the page says to check one item with Ctrl+C.
  const PRESETS = {
    waystone: { tiers: true, thresholds: [
      { label: 'Item Rarity', style: 'colon' }, { label: 'Waystone Drop Chance', style: 'colon' },
      { label: 'Monster Pack Size', style: 'colon' }, { label: 'Rare Monsters', style: 'colon' },
    ] },
    tablet: { tiers: false, thresholds: [
      { label: 'Quantity of Items found', style: 'increased' }, { label: 'Rarity of Items found', style: 'increased' },
      { label: 'Experience gain', style: 'increased' },
    ] },
    relic: { tiers: false, thresholds: [{ label: '', style: 'increased' }] },
    vendor: { tiers: false, thresholds: [{ label: 'Movement Speed', style: 'increased' }, { label: '', style: 'increased' }] },
  };
  let rx = store.get('rx', { preset: 'waystone', tierMin: 14, tierMax: 16, thresholds: PRESETS.waystone.thresholds.map((t) => ({ ...t, min: '' })), include: '', exclude: '', includeAll: false });
  function drawRxForm() {
    $('rxPreset').value = rx.preset;
    $('rxTierMin').value = rx.tierMin ?? ''; $('rxTierMax').value = rx.tierMax ?? '';
    $('rxTierMin').closest('.inline').hidden = !PRESETS[rx.preset]?.tiers;
    $('rxInclude').value = rx.include; $('rxExclude').value = rx.exclude; $('rxIncludeAll').checked = !!rx.includeAll;
    $('rxThresholds').innerHTML = rx.thresholds.map((t, n) => `
      <div class="inline thr" data-n="${n}">
        <label>Min<input data-t="min" type="number" min="0" value="${esc(t.min)}"></label>
        <label class="grow">Stat line<input data-t="label" value="${esc(t.label)}" placeholder="e.g. Item Rarity"></label>
        <label>Format<select data-t="style"><option value="colon" ${t.style === 'colon' ? 'selected' : ''}>Stat: +N%</option><option value="increased" ${t.style === 'increased' ? 'selected' : ''}>N% increased stat</option></select></label>
      </div>`).join('') + '<button id="rxAddThr" class="ghost" type="button">+ Add stat threshold</button>';
    $('rxAddThr').addEventListener('click', () => { rx.thresholds.push({ label: '', style: 'colon', min: '' }); drawRxForm(); renderRx(); });
  }
  function lines(text) { return String(text || '').split('\n').map((s) => s.trim()).filter(Boolean); }
  function renderRx() {
    store.set('rx', rx);
    const tiers = PRESETS[rx.preset]?.tiers;
    const out = T.buildSearch({
      tierMin: tiers && rx.tierMin !== '' ? Number(rx.tierMin) : null,
      tierMax: tiers && rx.tierMax !== '' ? Number(rx.tierMax) : null,
      thresholds: rx.thresholds, include: lines(rx.include), exclude: lines(rx.exclude), includeMode: rx.includeAll ? 'all' : 'any',
    });
    $('rxOut').textContent = out.value || '(add a rule on the left)';
    $('rxLen').innerHTML = `<span class="${out.tooLong ? 'red' : ''}">${out.length}/250 characters</span>`;
    return out.value;
  }
  $('rxPreset').addEventListener('change', (e) => {
    rx = { ...rx, preset: e.target.value, thresholds: PRESETS[e.target.value].thresholds.map((t) => ({ ...t, min: '' })) };
    drawRxForm(); renderRx();
  });
  $('rxTierMin').addEventListener('input', (e) => { rx.tierMin = e.target.value; renderRx(); });
  $('rxTierMax').addEventListener('input', (e) => { rx.tierMax = e.target.value; renderRx(); });
  $('rxInclude').addEventListener('input', (e) => { rx.include = e.target.value; renderRx(); });
  $('rxExclude').addEventListener('input', (e) => { rx.exclude = e.target.value; renderRx(); });
  $('rxIncludeAll').addEventListener('change', (e) => { rx.includeAll = e.target.checked; renderRx(); });
  $('rxThresholds').addEventListener('input', (e) => {
    const row = e.target.closest('.thr'); if (!row) return;
    rx.thresholds[Number(row.dataset.n)][e.target.dataset.t] = e.target.value; renderRx();
  });
  async function copy(text, button) {
    try { await navigator.clipboard.writeText(text); const old = button.textContent; button.textContent = 'Copied'; setTimeout(() => { button.textContent = old; }, 1200); } catch { window.prompt('Copy this:', text); }
  }
  $('rxCopy').addEventListener('click', (e) => copy(renderRx(), e.target));
  function renderSavedRx() {
    const saved = store.get('rxSaved', []);
    $('rxSaved').innerHTML = saved.map((s, n) => `<li><strong>${esc(s.name)}</strong><code>${esc(s.value)}</code><button class="ghost" data-copy="${n}">Copy</button><button class="ghost x" data-del="${n}" aria-label="Delete">×</button></li>`).join('') || '<li class="muted">Nothing saved yet.</li>';
  }
  $('rxSave').addEventListener('click', () => {
    const value = renderRx(); if (!value) return;
    const saved = store.get('rxSaved', []);
    saved.unshift({ name: $('rxName').value.trim() || `${rx.preset} search`, value });
    store.set('rxSaved', saved.slice(0, 50)); $('rxName').value = ''; renderSavedRx();
  });
  $('rxSaved').addEventListener('click', (e) => {
    const saved = store.get('rxSaved', []);
    if (e.target.dataset.copy) copy(saved[Number(e.target.dataset.copy)].value, e.target);
    if (e.target.dataset.del) { saved.splice(Number(e.target.dataset.del), 1); store.set('rxSaved', saved); renderSavedRx(); }
  });

  // ---- trade links --------------------------------------------------------
  function tradeLink() { return T.tradeUrl(league(), T.parseItemText($('tradeInput').value)); }
  $('tradeInput').addEventListener('input', () => {
    const p = T.parseItemText($('tradeInput').value);
    $('tradePreview').textContent = p.name ? `Searches for: ${p.rarity === 'Unique' && p.name !== p.baseType ? `${p.name} (${p.baseType})` : p.baseType}` : '';
  });
  $('tradeOpen').addEventListener('click', () => { if ($('tradeInput').value.trim()) window.open(tradeLink(), '_blank', 'noopener'); });
  $('tradeExchange').addEventListener('click', () => window.open(T.exchangeUrl(league()), '_blank', 'noopener'));
  function renderSavedTrade() {
    const saved = store.get('tradeSaved', []);
    $('tradeSaved').innerHTML = saved.map((s, n) => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.name)} ↗</a><button class="ghost x" data-del="${n}" aria-label="Delete">×</button></li>`).join('') || '<li class="muted">Nothing saved yet.</li>';
  }
  $('tradeSave').addEventListener('click', () => {
    const p = T.parseItemText($('tradeInput').value); if (!p.name) return;
    const saved = store.get('tradeSaved', []);
    saved.unshift({ name: p.rarity === 'Unique' ? p.name : p.baseType || p.name, url: tradeLink() });
    store.set('tradeSaved', saved.slice(0, 50)); renderSavedTrade();
  });
  $('tradeSaved').addEventListener('click', (e) => {
    if (!e.target.dataset.del) return;
    const saved = store.get('tradeSaved', []); saved.splice(Number(e.target.dataset.del), 1); store.set('tradeSaved', saved); renderSavedTrade();
  });

  // ---- favourites ---------------------------------------------------------
  const DEFAULT_LINKS = [
    { name: 'Official trade', url: 'https://www.pathofexile.com/trade2' },
    { name: 'GGG build planner', url: 'https://www.pathofexile.com/passive-skill-tree/poe2' },
    { name: 'poe.ninja economy', url: 'https://poe.ninja/poe2/economy' },
    { name: 'poe.ninja builds', url: 'https://poe.ninja/poe2/builds' },
    { name: 'poe2scout', url: 'https://poe2scout.com' },
    { name: 'poe2db', url: 'https://poe2db.tw/us/' },
    { name: 'Path of Building (PoE2)', url: 'https://pathofbuilding.community/' },
    { name: 'PoE2 wiki', url: 'https://www.poe2wiki.net/' },
    { name: 'Market scanner', url: '/' },
  ];
  function renderLinks() {
    const custom = store.get('links', []);
    $('linkGrid').innerHTML = [...DEFAULT_LINKS.map((l) => ({ ...l, builtIn: true })), ...custom].map((l, n) => `
      <a class="link-tile" href="${esc(l.url)}" ${l.url.startsWith('/') ? '' : 'target="_blank" rel="noopener"'}>${esc(l.name)}<small>${esc(l.url.replace(/^https?:\/\//, '').replace(/\/$/, ''))}</small>${l.builtIn ? '' : `<button class="ghost x" data-del="${n - DEFAULT_LINKS.length}" aria-label="Remove">×</button>`}</a>`).join('');
  }
  $('linkAdd').addEventListener('click', () => {
    const name = $('linkName').value.trim(); const url = $('linkUrl').value.trim();
    if (!name || !/^https?:\/\//i.test(url)) return;
    const custom = store.get('links', []); custom.push({ name, url }); store.set('links', custom);
    $('linkName').value = ''; $('linkUrl').value = ''; renderLinks();
  });
  $('linkGrid').addEventListener('click', (e) => {
    if (!e.target.dataset.del) return;
    e.preventDefault();
    const custom = store.get('links', []); custom.splice(Number(e.target.dataset.del), 1); store.set('links', custom); renderLinks();
  });

  // ---- boot ---------------------------------------------------------------
  function renderAll() { renderPrice(); renderStash(); renderEconomy(); renderConverter(); renderEv(); }
  $('league').value = store.get('league', 'Runes of Aldur');
  $('league').addEventListener('change', () => { store.set('league', league()); loadBook(); });
  $('reload').addEventListener('click', loadBook);
  drawRxForm(); renderRx(); renderSavedRx(); renderSavedTrade(); renderLinks();
  const initial = location.hash.slice(1) || store.get('tab', 'price');
  showTool(document.querySelector(`.tool-tabs [data-tool="${initial}"]`) ? initial : 'price');
  loadBook();
})();
