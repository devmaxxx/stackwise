import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

const TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
};

export function resolveAsset(root, urlPath) {
  const rel = decodeURIComponent(urlPath.slice('/assets/'.length));
  return join(root, rel);
}

export async function serveAsset(root, urlPath) {
  const file = resolveAsset(root, urlPath);
  try {
    const body = await readFile(file);
    return { status: 200, type: TYPES[extname(file)] ?? 'application/octet-stream', body };
  } catch {
    return { status: 404 };
  }
}
