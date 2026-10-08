import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../docs/michael/index.html', import.meta.url), 'utf8');

test('Michael page publishes the approved Little Glitch IT launch page', () => {
  assert.ok(html.includes('<title>Little Glitch IT | Small glitches. Big relief.</title>'));
  assert.ok(html.includes('LAUNCH PREVIEW'));
  assert.ok(!html.includes('PRIVATE CONCEPT PREVIEW'));
  assert.ok(html.includes('Not accepting bookings yet.'));
  for (const id of ['overview', 'services', 'pricing', 'about', 'process', 'contact']) {
    assert.ok(html.includes(`id="${id}"`), `Missing section ${id}`);
  }
  assert.ok(html.includes('Mike and his family outdoors'));
  assert.ok(html.includes('data:image/jpeg;base64,'));
  assert.ok(html.includes('From door dings to digital glitches'));
});

test('Published prices and calculator use the approved lower rates', () => {
  for (const price of ['$75', '$105/hour', '$249', '$499']) {
    assert.ok(html.includes(price), `Missing approved price ${price}`);
  }
  for (const old of ['$95', '$125', '$299', '$549']) {
    assert.ok(!html.includes(old), `Obsolete rate ${old}`);
  }
  assert.ok(html.includes('(plus?499:249)'));
  assert.ok(html.includes('Approved overage is $75/hour'));
});
