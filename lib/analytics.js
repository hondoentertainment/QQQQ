// Pure analytics helpers for the dashboard and refresh pipeline.

/** Approximate contribution of a holding's day move to the fund (weight × day%). */
export function holdingContributionBps(h) {
  if (!h || !Number.isFinite(h.weight) || !Number.isFinite(h.changePct)) return null;
  return +(h.weight * h.changePct / 100).toFixed(3);
}

/** Weighted average day move across priced holdings. */
export function weightedDayMove(holdings) {
  const priced = (holdings || []).filter((h) => Number.isFinite(h.changePct));
  if (!priced.length) return null;
  const wSum = priced.reduce((s, h) => s + h.weight, 0);
  if (!wSum) return null;
  return priced.reduce((s, h) => s + h.changePct * h.weight, 0) / wSum;
}

/** Human-readable provenance for weights and quotes. */
export function sourceProvenance(holdingsSource, quoteSource) {
  const weights = {
    invesco: 'Invesco daily CSV',
    fmp: 'Financial Modeling Prep',
    'sec-nport': 'SEC N-PORT filing (lagged)',
    'invesco-cached': 'Cached Invesco snapshot',
    'fmp-cached': 'Cached FMP snapshot',
    seed: 'Sample seed data',
  }[holdingsSource] || holdingsSource || 'Unknown';
  const prices = {
    fmp: 'Financial Modeling Prep',
    yahoo: 'Yahoo Finance (delayed ~15 min)',
  }[quoteSource] || quoteSource || 'Unknown';
  return { weights, prices };
}

/** Warnings when snapshot quality looks degraded. */
export function dataQualityWarnings(holdingsDoc, refreshStatus) {
  const warnings = [];
  const count = holdingsDoc?.count ?? holdingsDoc?.holdings?.length ?? 0;
  const total = holdingsDoc?.totalWeight ?? 0;
  if (count > 0 && count < 98) {
    warnings.push(`${count} holdings mapped (expected ~100)`);
  }
  if (total > 0 && (total < 95 || total > 105)) {
    warnings.push(`weights sum to ${total}%`);
  }
  if (refreshStatus?.unmappedCount > 0) {
    warnings.push(`${refreshStatus.unmappedCount} SEC names unmapped`);
  }
  if (refreshStatus?.quoteSuccessRate != null && refreshStatus.quoteSuccessRate < 0.9) {
    warnings.push(`only ${Math.round(refreshStatus.quoteSuccessRate * 100)}% quotes priced`);
  }
  return warnings;
}

/** Note when top-10 concentration is at a series high. */
export function concentrationAlert(series) {
  if (!Array.isArray(series) || series.length < 3) return null;
  const vals = series.map((p) => p.top10).filter(Number.isFinite);
  if (vals.length < 3) return null;
  const last = vals[vals.length - 1];
  const max = Math.max(...vals.slice(0, -1));
  if (last >= max - 0.05) {
    return `Top-10 concentration (${last.toFixed(1)}%) is at a ${series.length}-month high`;
  }
  return null;
}
