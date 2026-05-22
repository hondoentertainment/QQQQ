import test from 'node:test';
import assert from 'node:assert/strict';
import {
  holdingContributionBps,
  sourceProvenance,
  dataQualityWarnings,
  concentrationAlert,
} from '../lib/analytics.js';

test('holdingContributionBps computes weight times day change', () => {
  assert.equal(holdingContributionBps({ weight: 10, changePct: 2 }), 0.2);
  assert.equal(holdingContributionBps({ weight: 10, changePct: null }), null);
});

test('sourceProvenance maps pipeline sources to labels', () => {
  const p = sourceProvenance('sec-nport', 'yahoo');
  assert.match(p.weights, /SEC/);
  assert.match(p.prices, /Yahoo/);
});

test('dataQualityWarnings flags low holdings count', () => {
  const warnings = dataQualityWarnings({ count: 91, totalWeight: 92.3 }, null);
  assert.ok(warnings.some((w) => w.includes('91 holdings')));
});

test('concentrationAlert detects a series high', () => {
  const series = [
    { top10: 50 }, { top10: 51 }, { top10: 52 }, { top10: 55 },
  ];
  assert.match(concentrationAlert(series), /high/);
});
