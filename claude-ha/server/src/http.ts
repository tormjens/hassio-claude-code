/**
 * Small HTTP helpers: static file serving, JSON responses, ingress guard.
 *
 * Home Assistant ingress proxies requests to the add-on with the ingress
 * prefix already stripped, and adds `X-Ingress-Path` with the prefix the
 * browser used. The UI only ever uses relative URLs, so the server never has
 * to know the prefix. We still expose it on /api/health for debugging.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

/** The Supervisor ingress gateway. Only this peer may talk to us in production. */
export const INGRESS_GATEWAY = '172.30.32.2';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

export function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

export function sendText(res: http.ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

export async function readJsonBody<T = unknown>(req: http.IncomingMessage, limit = 1_000_000): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > limit) throw new Error('Request body too large');
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? (JSON.parse(text) as T) : ({} as T);
}

/**
 * True when the request comes from a peer we trust. Ingress traffic always
 * arrives from the Supervisor gateway. Outside Home Assistant (development)
 * we allow loopback.
 */
export function isTrustedPeer(req: http.IncomingMessage, allowAny: boolean): boolean {
  if (allowAny) return true;
  const addr = req.socket.remoteAddress ?? '';
  const ip = addr.startsWith('::ffff:') ? addr.slice(7) : addr;
  return ip === INGRESS_GATEWAY || ip === '127.0.0.1' || ip === '::1';
}

export function ingressPath(req: http.IncomingMessage): string {
  const header = req.headers['x-ingress-path'];
  return typeof header === 'string' ? header : '';
}

/**
 * Serve files from `root`. Unknown paths fall back to index.html so a page
 * reload deep inside the SPA still works. Assets in /assets/ are immutable
 * (Vite hashes them) and can be cached hard.
 */
export function createStaticHandler(root: string) {
  const indexFile = path.join(root, 'index.html');
  return async (req: http.IncomingMessage, res: http.ServerResponse, urlPath: string): Promise<void> => {
    let rel = decodeURIComponent(urlPath.split('?')[0]);
    if (rel === '/' || rel === '') rel = '/index.html';
    const abs = path.normalize(path.join(root, rel));
    if (!abs.startsWith(root)) {
      sendText(res, 403, 'Forbidden');
      return;
    }
    let file = abs;
    let stat = await fsp.stat(file).catch(() => undefined);
    if (!stat || !stat.isFile()) {
      file = indexFile;
      stat = await fsp.stat(file).catch(() => undefined);
      if (!stat) {
        sendText(res, 404, 'UI not built. Run `npm run build` in claude-ha/ui.');
        return;
      }
    }
    const ext = path.extname(file).toLowerCase();
    const immutable = rel.startsWith('/assets/');
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(file).pipe(res);
  };
}
