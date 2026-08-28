// The operator's own gold-fee table.
//
// WHY THIS EXISTS. Only 14 item fees are checked-in verified, so on a typical
// hour the great majority of rows carry an unverified fee and can never close a
// cycle. On 2026-08-28T08Z exactly one row was executable while ten more were
// blocked on nothing but a missing fee — including a 185.7% closed cycle on a
// market that moved 123 units with a 25% ratio range. Those are not marginal
// rows; they are the best ones on the board.
//
// WHAT THIS DOES NOT DO. It never invents a fee. An item with no checked-in fee
// and no operator entry stays unverified, its gold stays an estimate, and it
// never reaches a closed cycle — the "unknown is a hard reject" rule is intact.
// The only new thing here is that the operator can check a fee in-game once and
// have that answer persist, instead of re-reading a screenshot every hour.
//
// PROVENANCE IS NEVER LAUNDERED. A fee the operator typed is reported as
// "user-verified" and never as "checked-in-verified". Where an entry disagrees
// with the checked-in table, both numbers are kept so the UI can say so.
(function (root) {
  const STORAGE_KEY = 'poe2.goldFees.v1';
  // Same ceiling the OCR helper trusts: a larger number is an account total
  // that was misread, not a per-unit exchange fee.
  const MAX_FEE = 100000;

  /** A typed fee is usable only as a real positive per-unit number. A zero is
   *  rejected outright: "free" is the one answer that would silently fabricate
   *  a verified cycle out of an unknown cost. */
  function normalizeFee(value) {
    const fee = Number(value);
    if (!Number.isFinite(fee) || fee <= 0 || fee > MAX_FEE) return null;
    return Math.round(fee);
  }

  /** Malformed storage yields an empty table rather than a broken page. */
  function load(storage) {
    try {
      const parsed = JSON.parse(storage.getItem(STORAGE_KEY) || '{}');
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      const table = {};
      for (const [path, value] of Object.entries(parsed)) {
        const fee = normalizeFee(value);
        if (fee !== null) table[path] = fee;
      }
      return table;
    } catch { return {}; }
  }

  function save(storage, table) {
    try { storage.setItem(STORAGE_KEY, JSON.stringify(table)); return true; }
    catch { return false; }
  }

  /** Set or clear one entry, returning a new table. A null/blank value removes
   *  the entry and the item falls back to whatever the checked-in table says. */
  function setFee(table, gggPath, value) {
    const next = { ...table };
    const fee = normalizeFee(value);
    if (fee === null) delete next[gggPath]; else next[gggPath] = fee;
    return next;
  }

  /**
   * The fee for one RECEIVED identity — fees are charged per unit received on
   * the "I want" side, so every leg is priced by what it hands back.
   */
  function resolveFee(identity, table) {
    const checkedIn = Number(identity && identity.goldCostPerUnit);
    // -1 is the repo's marker for "named, but no fee was ever verified".
    const hasCheckedIn = Number.isFinite(checkedIn) && checkedIn >= 0;
    const override = normalizeFee(table && table[identity && identity.id]);
    if (override !== null) {
      return {
        cost: override,
        verified: true,
        source: 'user-verified',
        basis: 'Fee you checked in-game',
        // Kept, not resolved: the checked-in table was read from the wiki on a
        // date, and a patch can move a fee. The UI shows both numbers.
        checkedInValue: hasCheckedIn ? checkedIn : null,
        disagrees: hasCheckedIn && checkedIn !== override,
      };
    }
    if (hasCheckedIn) {
      return {
        cost: checkedIn, verified: true, source: 'checked-in-verified',
        basis: 'Verified item fee', checkedInValue: checkedIn, disagrees: false,
      };
    }
    return {
      cost: null, verified: false, source: 'unverified',
      basis: 'No verified fee for this item', checkedInValue: null, disagrees: false,
    };
  }

  /** The three legs of a signal, each paired with the identity it receives. */
  function legsOf(signal) {
    if (!signal) return [];
    const legs = [
      { key: 'buy', leg: signal.buyLeg, receives: signal.item },
      { key: 'sell', leg: signal.sellLeg, receives: signal.sellCurrency },
    ];
    if (signal.returnLeg) legs.push({ key: 'return', leg: signal.returnLeg, receives: signal.buyCurrency });
    return legs.filter(entry => entry.leg);
  }

  /**
   * Re-price a signal's gold against the operator's table.
   *
   * totalGold is a real number only when EVERY leg resolved to a verified fee.
   * Otherwise it stays null and the caller must keep presenting an estimate —
   * a partially-known cost is not a cost.
   */
  function applyFees(signal, table) {
    const legs = legsOf(signal).map(entry => {
      const fee = resolveFee(entry.receives, table);
      const received = Number(entry.leg.receive) || 0;
      return {
        key: entry.key,
        identity: entry.receives,
        fee,
        goldCost: fee.verified ? fee.cost * received : null,
      };
    });
    const allVerified = legs.length > 0 && legs.every(entry => entry.fee.verified);
    const unresolved = legs.filter(entry => !entry.fee.verified).map(entry => entry.identity);
    // "user" only when the operator's own entry actually changed the answer.
    const usesOperatorFee = legs.some(entry => entry.fee.source === 'user-verified');
    return {
      legs,
      allVerified,
      unresolved,
      usesOperatorFee,
      provenance: !allVerified ? 'unverified' : usesOperatorFee ? 'user-verified' : 'checked-in-verified',
      totalGold: allVerified ? legs.reduce((sum, entry) => sum + entry.goldCost, 0) : null,
      disagreements: legs.filter(entry => entry.fee.disagrees),
    };
  }

  /**
   * Rows whose ONLY remaining blocker is a fee nobody has checked, ranked by
   * what they would be worth if the fee is real. This is the work list: check
   * these fees in-game, best first.
   *
   * The engine's own classification decides what belongs here. "fee-check-needed"
   * is precisely the class it assigns when the cycle closes profitably at the
   * conservative boundary, the sizing fits inside the hour's liquidity, and the
   * one thing missing is a verified fee. A high-risk or unclosable row is
   * excluded even when its headline looks good: no fee makes it executable, so
   * sending someone into the game to look one up would waste the trip.
   */
  function feeCheckQueue(signals, table) {
    const queue = [];
    for (const signal of signals || []) {
      if (!signal || signal.classification !== 'fee-check-needed') continue;
      const applied = applyFees(signal, table);
      if (applied.allVerified) continue;
      const profit = Number(signal.closedCycleProfitPct);
      if (!Number.isFinite(profit) || profit <= 0) continue;
      queue.push({
        signal,
        closedCycleProfitPct: profit,
        missing: applied.unresolved,
        estimatedTotalGold: Number(signal.estimatedTotalGold) || null,
      });
    }
    return queue.sort((a, b) => b.closedCycleProfitPct - a.closedCycleProfitPct);
  }

  /** Distinct fee-less identities across many signals, best potential first. */
  function missingFeeItems(signals, table) {
    const best = new Map();
    for (const entry of feeCheckQueue(signals, table)) {
      for (const identity of entry.missing) {
        const current = best.get(identity.id);
        if (!current || entry.closedCycleProfitPct > current.bestProfitPct) {
          best.set(identity.id, { identity, bestProfitPct: entry.closedCycleProfitPct, rows: current ? current.rows + 1 : 1 });
        } else {
          current.rows += 1;
        }
      }
    }
    return [...best.values()].sort((a, b) => b.bestProfitPct - a.bestProfitPct);
  }

  root.POE2GoldFees = {
    STORAGE_KEY, MAX_FEE,
    normalizeFee, load, save, setFee,
    resolveFee, applyFees, feeCheckQueue, missingFeeItems,
  };
})(window);
