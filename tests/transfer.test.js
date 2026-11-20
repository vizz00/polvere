import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readCode } from '../js/transfer.js';

const code = (data) => Buffer.from(JSON.stringify(data)).toString('base64url');
const good = { id: 'riale-ab12', name: 'Riale', lat: 46.4, lon: 8.4, elevations: { valle: 1700, meta: 2200, cima: 2700 }, region: 'IT-21' };

test('readCode tiene i posti validi e solo i campi noti', () => {
  const d = readCode(code({ v: 1, places: [{ ...good, wepowder: '"><img>' }], favorites: ['riale-ab12'], list: ['riale-ab12'], aspects: { 'riale-ab12': ['N', 'X'] } }));
  assert.equal(d.places.length, 1);
  assert.equal(d.places[0].wepowder, undefined);
  assert.deepEqual(d.aspects, { 'riale-ab12': ['N'] });
});

test('readCode scarta posti con id, quote o regione non validi', () => {
  const bad = [
    { ...good, id: 'x" onclick="y' },
    { ...good, elevations: { valle: '<b>', meta: 1, cima: 2 } },
    { ...good, region: '<script>' },
  ];
  const d = readCode(code({ v: 1, places: bad, favorites: ['a"b', 'ok-1'] }));
  assert.equal(d.places.length, 0);
  assert.deepEqual(d.favorites, ['ok-1']);
});
