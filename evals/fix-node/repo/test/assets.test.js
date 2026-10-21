import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { serveAsset } from '../src/assets.js';

const root = fileURLToPath(new URL('../public/', import.meta.url));

test('serves a stylesheet with its content type', async () => {
  const res = await serveAsset(root, '/assets/app.css');
  assert.equal(res.status, 200);
  assert.match(res.type, /^text\/css/);
  assert.match(res.body.toString(), /\.price/);
});

test('answers 404 for a file that does not exist', async () => {
  const res = await serveAsset(root, '/assets/missing.css');
  assert.equal(res.status, 404);
});
