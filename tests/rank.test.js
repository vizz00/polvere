import { test } from 'node:test';
import assert from 'node:assert/strict';
import { powderRank } from '../js/rank.js';

const BASE = { snow: 0, rain: 0, windMax: 10, tSnow: -8, tMax: -5, freezingMax: 1500, cloud: 90 };
const day = (date, over = {}) => ({ date, models: { a: { ...BASE, ...over }, b: { ...BASE, ...over } } });
const ELEV = 2500;
const sum = (days, past = [day('p1')]) => ({ past, days });

test('niente neve: punteggio 0, livello no', () => {
  const r = powderRank(sum([day('d1'), day('d2'), day('d3')]), ELEV);
  assert.equal(r.score, 0);
  assert.equal(r.level, 'no');
});

test('prende il giorno migliore dei prossimi 3', () => {
  const r = powderRank(sum([day('d1'), day('d2', { snow: 30 }), day('d3')]), ELEV);
  assert.equal(r.date, 'd2');
  assert.equal(r.level, 'ottima');
});

test('neve dal 4° giorno non conta', () => {
  const r = powderRank(sum([day('d1'), day('d2'), day('d3'), day('d4', { snow: 40 })]), ELEV);
  assert.equal(r.score, 0);
});

test('neve di ieri conta per oggi', () => {
  const r = powderRank(sum([day('d1'), day('d2'), day('d3')], [day('p1', { snow: 30 })]), ELEV);
  assert.ok(r.score > 0);
  assert.equal(r.date, 'd1');
});

test('senza dati: null', () => {
  assert.equal(powderRank(null, ELEV), null);
  assert.equal(powderRank({ days: [] }, ELEV), null);
});
