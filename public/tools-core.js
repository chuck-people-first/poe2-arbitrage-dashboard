// Pure logic for the Tools page: item-text parsing, price lookup, stash
// valuation, stash-search regex building and trade links. No DOM, no network,
// so test/tools-core.test.ts can run it in a bare VM context.
(function (root) {
  const SEPARATOR = /^-{4,}$/;

  /** Normalize a name for lookup: case, apostrophes and spacing never matter. */
  function norm(text) {
    return String(text ?? '').toLowerCase().replace(/[’'`]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  }

  /**
   * Parse the text the game copies with Ctrl+C (Ctrl+Alt+C works too). Falls
   * back to treating a single plain line as an item name.
   */
  function parseItemText(text) {
    const lines = String(text ?? '').replace(/\r/g, '').split('\n').map((line) => line.trim()).filter(Boolean);
    const out = { itemClass: null, rarity: null, name: null, baseType: null, stackSize: 1, tier: null, raw: lines };
    if (!lines.length) return out;
    const header = [];
    let i = 0;
    for (; i < lines.length && !SEPARATOR.test(lines[i]); i++) header.push(lines[i]);
    const nameLines = [];
    for (const line of header) {
      const cls = /^Item Class:\s*(.+)$/i.exec(line);
      const rar = /^Rarity:\s*(.+)$/i.exec(line);
      if (cls) out.itemClass = cls[1];
      else if (rar) out.rarity = rar[1];
      else nameLines.push(line);
    }
    // Two name lines = "Name / Base" (unique or rare); one = the item itself.
    if (nameLines.length >= 2) { out.name = nameLines[0]; out.baseType = nameLines[1]; }
    else if (nameLines.length === 1) { out.name = nameLines[0]; out.baseType = nameLines[0]; }
    for (const line of lines) {
      const stack = /^Stack Size:\s*([\d,.\s]+)\s*\/\s*[\d,.\s]+$/i.exec(line);
      if (stack) out.stackSize = Number(stack[1].replace(/[^\d]/g, '')) || 1;
      const tier = /^(?:Waystone )?Tier:\s*(\d+)/i.exec(line) || /\(Tier (\d+)\)/i.exec(line);
      if (tier && out.tier === null) out.tier = Number(tier[1]);
    }
    return out;
  }

  /** Build a lookup over a price book ({ items: [{ name, divine, ... }] }). */
  function indexBook(book) {
    const byName = new Map();
    for (const item of book?.items ?? []) byName.set(norm(item.name), item);
    return { book, byName };
  }

  /** Best match for a name: exact, then whole-word containment, shortest wins. */
  function findItem(index, query) {
    const q = norm(query);
    if (!q || !index) return null;
    const exact = index.byName.get(q);
    if (exact) return exact;
    let best = null;
    for (const [key, item] of index.byName) {
      const hit = ` ${key} `.includes(` ${q} `) || ` ${q} `.includes(` ${key} `);
      if (hit && (!best || Math.abs(key.length - q.length) < Math.abs(norm(best.name).length - q.length))) best = item;
    }
    return best;
  }

  /** Search for the picker: every item whose name contains all query words. */
  function searchItems(index, query, limit = 12) {
    const words = norm(query).split(' ').filter(Boolean);
    if (!words.length || !index) return [];
    const hits = [];
    for (const [key, item] of index.byName) if (words.every((w) => key.includes(w))) hits.push(item);
    hits.sort((a, b) => (b.volumeDivine ?? 0) - (a.volumeDivine ?? 0) || a.name.localeCompare(b.name));
    return hits.slice(0, limit);
  }

  /** Price an item text or name. */
  function priceCheck(index, text) {
    const parsed = parseItemText(text);
    const item = findItem(index, parsed.baseType) || findItem(index, parsed.name);
    // Uniques and rares share a base with nothing priced on the exchange; a
    // base-type hit for them would be a lie.
    const gear = /^(unique|rare|magic)$/i.test(parsed.rarity ?? '') && !/currency|gem|rune|essence|soul|idol|omen|catalyst|fragment|splinter|tablet|waystone/i.test(parsed.itemClass ?? '');
    if (!item || gear) return { parsed, item: null, quantity: parsed.stackSize, totalDivine: null };
    return { parsed, item, quantity: parsed.stackSize, totalDivine: item.divine * parsed.stackSize };
  }

  /** Divine value in each hub currency. */
  function convert(divine, hubRatesPerDivine) {
    if (!Number.isFinite(divine)) return null;
    const rates = hubRatesPerDivine || {};
    return {
      divine,
      exalted: rates.exalted ? divine * rates.exalted : null,
      chaos: rates.chaos ? divine * rates.chaos : null,
    };
  }

  /**
   * Parse a stash list, one entry per line: "12 Divine Orb", "12x Divine Orb",
   * "Divine Orb x12", "Divine Orb: 12", "Divine Orb 12". A line with no
   * number counts as 1. Pasted Ctrl+C blocks are handled by priceCheck.
   */
  function parseStashLines(text) {
    const entries = [];
    for (const rawLine of String(text ?? '').split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      let m = /^([\d,]+)\s*x?\s+(.+)$/i.exec(line);
      if (m) { entries.push({ quantity: Number(m[1].replace(/,/g, '')), name: m[2].trim() }); continue; }
      m = /^(.+?)\s*(?:[x×:]\s*|\s)([\d,]+)$/i.exec(line);
      if (m) { entries.push({ quantity: Number(m[2].replace(/,/g, '')), name: m[1].trim() }); continue; }
      entries.push({ quantity: 1, name: line });
    }
    return entries.filter((e) => e.quantity > 0);
  }

  function valueStash(index, entries) {
    const rows = entries.map((entry) => {
      const item = findItem(index, entry.name);
      return { ...entry, item, divineEach: item?.divine ?? null, totalDivine: item ? item.divine * entry.quantity : null };
    });
    const totalDivine = rows.reduce((sum, row) => sum + (row.totalDivine ?? 0), 0);
    return { rows, totalDivine, unpriced: rows.filter((row) => !row.item).length };
  }

  // ---- Stash search regex -------------------------------------------------

  /** Regex alternation matching every integer in [min, max] (no leading zeros). */
  function rangeRegex(min, max) {
    min = Math.max(0, Math.floor(min)); max = Math.floor(max);
    if (max < min) return '';
    const parts = [];
    const byPrefix = new Map();
    for (let n = min; n <= max; n++) {
      const s = String(n);
      const prefix = s.slice(0, -1);
      if (!byPrefix.has(prefix)) byPrefix.set(prefix, []);
      byPrefix.get(prefix).push(Number(s.slice(-1)));
    }
    for (const [prefix, digits] of byPrefix) {
      const lo = digits[0]; const hi = digits[digits.length - 1];
      const tail = lo === 0 && hi === 9 && prefix ? '\\d' : lo === hi ? String(lo) : `[${lo}-${hi}]`;
      parts.push({ prefix, tail });
    }
    // Merge runs of whole decades, "5\d|6\d|7\d" -> "[5-7]\d", so searches
    // stay under the game's 250-character cap.
    const merged = [];
    for (const part of parts) {
      const last = merged[merged.length - 1];
      const head = part.prefix.slice(0, -1); const digit = Number(part.prefix.slice(-1));
      if (last && part.tail === '\\d' && last.tail === '\\d' && last.head === head && digit === last.hi + 1) {
        last.hi = digit; continue;
      }
      merged.push({ ...part, head, lo: digit, hi: digit });
    }
    return merged.map((m) => (m.tail === '\\d' && m.hi > m.lo ? `${m.head}[${m.lo}-${m.hi}]\\d` : m.prefix + m.tail)).join('|').replace(/\[0-9\]/g, '\\d');
  }

  /** Regex alternation for any integer >= n. */
  function atLeastRegex(n) {
    n = Math.max(0, Math.floor(n));
    const digits = String(n).length;
    const top = 10 ** digits - 1;
    const same = rangeRegex(n, top);
    return `${same}|\\d{${digits + 1},}`;
  }

  /** Escape regex metacharacters in user text, keep it case-insensitive-friendly. */
  function escapeTerm(text) {
    return String(text ?? '').trim().toLowerCase().replace(/[.*+?^${}()|[\]\\"]/g, '\\$&');
  }

  /**
   * Build a stash-search string. Each quoted group must match (AND); inside a
   * group `|` is OR; a leading `!` excludes. Thresholds match lines like
   * "Item Rarity: +45%".
   */
  function buildSearch(spec) {
    const groups = [];
    if (spec.tierMin != null || spec.tierMax != null) {
      const lo = spec.tierMin ?? 1; const hi = spec.tierMax ?? 16;
      groups.push(`"tier: (${rangeRegex(lo, hi)})\\b"`);
    }
    for (const t of spec.thresholds ?? []) {
      if (!t?.label || !(Number(t.min) > 0)) continue;
      const n = atLeastRegex(Number(t.min));
      // "Item Rarity: +45%" vs "45% increased Movement Speed"
      groups.push(t.style === 'increased'
        ? `"(${n})% increased ${escapeTerm(t.label)}"`
        : `"${escapeTerm(t.label)}: \\+(${n})%"`);
    }
    const include = (spec.include ?? []).map(escapeTerm).filter(Boolean);
    if (include.length) {
      if (spec.includeMode === 'all') for (const term of include) groups.push(`"${term}"`);
      else groups.push(`"${include.join('|')}"`);
    }
    const exclude = (spec.exclude ?? []).map(escapeTerm).filter(Boolean);
    if (exclude.length) groups.push(`"!${exclude.join('|')}"`);
    const value = groups.join(' ');
    return { value, length: value.length, tooLong: value.length > 250 };
  }

  // ---- Expected value -----------------------------------------------------

  const UNIT_KEYS = { divine: 'divine', exalted: 'exalted', chaos: 'chaos' };

  /**
   * Divine value of one EV line: { quantity, name } priced from the book, or
   * { quantity, value, unit } when the user typed the value themselves (gear).
   */
  function lineDivine(index, line) {
    const qty = Number(line?.quantity ?? 1);
    if (!(qty > 0)) return 0;
    const item = line?.name ? findItem(index, line.name) : null;
    if (item) return qty * item.divine;
    // A typed 0 is a real outcome ("it bricked"); a blank value is unpriced.
    if (line?.value === '' || line?.value === null || line?.value === undefined) return null;
    const value = Number(line.value);
    if (!Number.isFinite(value) || value < 0) return null;
    const unit = UNIT_KEYS[String(line?.unit ?? 'divine').toLowerCase()] ?? 'divine';
    if (unit === 'divine') return qty * value;
    const rate = index?.book?.hubRatesPerDivine?.[unit];
    return rate ? (qty * value) / rate : null;
  }

  /** EV of one attempt. Probabilities are percentages and need not sum to 100. */
  function expectedValue(index, costs, outcomes) {
    let costDivine = 0; let unpriced = 0;
    for (const c of costs ?? []) { const v = lineDivine(index, c); if (v === null) unpriced++; else costDivine += v; }
    let evDivine = 0; let probTotal = 0;
    for (const o of outcomes ?? []) {
      const p = Number(o?.probPct) / 100;
      if (!(p > 0)) continue;
      probTotal += p;
      const v = lineDivine(index, o);
      if (v === null) unpriced++; else evDivine += p * v;
    }
    const net = evDivine - costDivine;
    return {
      costDivine, evDivine, net,
      roiPct: costDivine > 0 ? (net / costDivine) * 100 : null,
      probTotalPct: probTotal * 100,
      unpriced,
    };
  }

  // ---- Trade links ---------------------------------------------------------

  const TRADE = 'https://www.pathofexile.com/trade2';

  /** Official trade site search for a parsed item (or a plain name). */
  function tradeUrl(league, parsed) {
    const query = { status: { option: 'online' } };
    const rarity = (parsed?.rarity ?? '').toLowerCase();
    if (rarity === 'unique' && parsed.name && parsed.baseType && parsed.name !== parsed.baseType) {
      query.name = parsed.name; query.type = parsed.baseType;
    } else if (rarity === 'rare' || rarity === 'magic') {
      query.type = parsed.baseType;
    } else {
      query.type = parsed?.baseType || parsed?.name || '';
    }
    const q = encodeURIComponent(JSON.stringify({ query }));
    return `${TRADE}/search/poe2/${encodeURIComponent(league)}?q=${q}`;
  }

  function exchangeUrl(league) {
    return `${TRADE}/exchange/poe2/${encodeURIComponent(league)}`;
  }

  root.POE2Tools = {
    norm, parseItemText, indexBook, findItem, searchItems, priceCheck, convert,
    parseStashLines, valueStash, rangeRegex, atLeastRegex, escapeTerm, buildSearch,
    lineDivine, expectedValue, tradeUrl, exchangeUrl,
  };
})(window);
