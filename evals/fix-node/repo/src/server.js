import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { serveAsset } from './assets.js';

const root = fileURLToPath(new URL('../public/', import.meta.url));

const server = createServer(async (req, res) => {
  if (!req.url.startsWith('/assets/')) {
    res.writeHead(404).end();
    return;
  }
  const asset = await serveAsset(root, req.url);
  res.writeHead(asset.status, asset.type ? { 'content-type': asset.type } : {});
  res.end(asset.body);
});

server.listen(Number(process.env.PORT ?? 3000));
