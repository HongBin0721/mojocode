import { test } from 'node:test';
import assert from 'node:assert/strict';
import { total } from '../src/price.js';

test('sums price × qty', () => {
  assert.equal(total([{ price: 10, qty: 2 }, { price: 5, qty: 1 }]), 25);
});
test('applies discount', () => {
  assert.equal(total([{ price: 100, qty: 1 }], 0.2), 80);
});
