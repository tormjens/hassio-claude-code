/**
 * Entry point: HTTP server (static UI + small JSON API) and the WebSocket
 * endpoint the chat UI talks to. Everything runs in this one process.
 *
 * Phase 1 skeleton: serves the UI, a health endpoint and an echo WebSocket so
 * ingress routing can be verified end to end.
 */
import http from 'node:http';
import fs from 'node:fs';
import { WebSocketServer } from 'ws';
import { loadConfig, createLogger } from './config.js';
import { createStaticHandler, ingressPath, isTrustedPeer, sendJson, sendText } from './http.js';

const config = loadConfig();
const log = createLogger(config.logLevel);
const allowAnyPeer = process.env.CLAUDE_HA_ALLOW_ANY_PEER === '1' || !fs.existsSync('/data/options.json');

const serveStatic = createStaticHandler(config.publicDir);

const server = http.createServer(async (req, res) => {
  try {
    if (!isTrustedPeer(req, allowAnyPeer)) {
      sendText(res, 403, 'Forbidden: only Home Assistant ingress may access this add-on');
      return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/api/health') {
      sendJson(res, 200, {
        ok: true,
        version: config.version,
        ingressPath: ingressPath(req),
        configDir: config.configDir,
        hasApiKey: Boolean(config.anthropicApiKey),
      });
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      sendJson(res, 404, { error: 'Not found' });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendText(res, 405, 'Method not allowed');
      return;
    }
    await serveStatic(req, res, url.pathname);
  } catch (err) {
    log.error('request failed', err);
    if (!res.headersSent) sendText(res, 500, 'Internal error');
    else res.end();
  }
});

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  if (!isTrustedPeer(req, allowAnyPeer)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname !== '/ws') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'hello', version: config.version }));
  ws.on('message', (data) => ws.send(JSON.stringify({ type: 'echo', data: data.toString() })));
});

server.listen(config.port, '0.0.0.0', () => {
  log.info(`Claude for Home Assistant ${config.version} listening on :${config.port}`);
  if (!config.anthropicApiKey) log.warning('ANTHROPIC_API_KEY is not set');
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    log.info(`received ${sig}, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
