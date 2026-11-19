#!/usr/bin/env node
/* Nexus editor backend — REFERENCE implementation of the W4 contract.
   Zero dependencies (node:http only). The production backend is the
   Express editor service (distinct from the uWS world gateway); this
   reference exists to prove the contract end to end and to give the
   real build something executable to conformance-test against.

   Storage: plain JSON files under DATA_DIR/<project>/ —
     draft.json            the current draft document
     versions/<v>.json     one file per committed version (full doc)
     versions/index.json   [{v, name, when, note}]
     commands.jsonl        the editor command stream, one JSON per line

   Run:  node server.mjs            (PORT=8921 DATA_DIR=./data)
*/
import http from 'node:http';
import { mkdir, readFile, writeFile, rename, appendFile } from 'node:fs/promises';
import { join } from 'node:path';

const PORT = process.env.PORT || 8921;
const DATA = process.env.DATA_DIR || new URL('./data', import.meta.url).pathname;

const safe = s => /^[a-zA-Z0-9_-]+$/.test(s) ? s : null;
const dirFor = id => join(DATA, id);
const readJSON = async p => { try { return JSON.parse(await readFile(p, 'utf8')); } catch { return null; } };
const writeJSON = async (p, obj) => {
  await mkdir(join(p, '..'), { recursive: true });
  const tmp = p + '.tmp';
  await writeFile(tmp, JSON.stringify(obj, null, 2));
  await rename(tmp, p);   // atomic-ish: readers never see a torn file
};

function send(res, code, obj) {
  const body = obj === undefined ? '' : JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,PUT,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
  res.end(body);
}
function body(req) {
  return new Promise((resolve, reject) => {
    let raw = ''; req.on('data', c => { raw += c; if (raw.length > 12e6) req.destroy(); });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : null); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204);
  const parts = new URL(req.url, 'http://x').pathname.split('/').filter(Boolean);
  try {
    if (parts[0] === 'api' && parts[1] === 'health') return send(res, 200, { ok: true, service: 'nexus-editor-backend-reference', time: new Date().toISOString() });
    if (parts[0] === 'api' && parts[1] === 'projects' && parts[2]) {
      const id = safe(parts[2]); if (!id) return send(res, 400, { error: 'bad project id' });
      const dir = dirFor(id);
      if (parts[3] === 'draft' && req.method === 'GET') {
        const doc = await readJSON(join(dir, 'draft.json'));
        return doc ? send(res, 200, doc) : send(res, 404, { error: 'no draft' });
      }
      if (parts[3] === 'draft' && req.method === 'PUT') {
        const doc = await body(req);
        if (!doc || doc.kind !== 'nexus-game-project') return send(res, 422, { error: 'not a game project document' });
        await writeJSON(join(dir, 'draft.json'), doc);
        return send(res, 200, { ok: true, savedAt: doc.manifest?.savedAt });
      }
      if (parts[3] === 'versions' && req.method === 'GET' && !parts[4]) {
        return send(res, 200, (await readJSON(join(dir, 'versions', 'index.json'))) || []);
      }
      if (parts[3] === 'versions' && parts[4] && req.method === 'PUT') {
        const v = safe(parts[4]); const payload = await body(req);
        if (!v || !payload?.doc) return send(res, 422, { error: 'expected {doc, meta}' });
        await writeJSON(join(dir, 'versions', `${v}.json`), payload.doc);
        const idx = (await readJSON(join(dir, 'versions', 'index.json'))) || [];
        const meta = payload.meta || { v: Number(v) || v, when: new Date().toISOString(), note: '' };
        const next = idx.filter(x => String(x.v) !== String(meta.v)); next.push(meta);
        next.sort((a, b) => Number(a.v) - Number(b.v));
        await writeJSON(join(dir, 'versions', 'index.json'), next);
        return send(res, 200, { ok: true, v: meta.v });
      }
      if (parts[3] === 'versions' && parts[4] && req.method === 'GET') {
        const v = safe(parts[4]); const doc = v && await readJSON(join(dir, 'versions', `${v}.json`));
        return doc ? send(res, 200, doc) : send(res, 404, { error: 'no such version' });
      }
      if (parts[3] === 'commands' && req.method === 'POST') {
        const payload = await body(req);
        const cmds = Array.isArray(payload?.commands) ? payload.commands : [];
        if (cmds.length) await appendFile(join(dir, 'commands.jsonl'), cmds.map(c => JSON.stringify(c)).join('\n') + '\n');
        return send(res, 200, { ok: true, accepted: cmds.length });
      }
      if (parts[3] === 'commands' && parts[4] === 'count' && req.method === 'GET') {
        let count = 0;
        try { count = (await readFile(join(dir, 'commands.jsonl'), 'utf8')).split('\n').filter(Boolean).length; } catch { /* none yet */ }
        return send(res, 200, { count });
      }
    }
    return send(res, 404, { error: 'no such route' });
  } catch (e) {
    return send(res, 500, { error: String(e && e.message || e) });
  }
});

server.listen(PORT, '127.0.0.1', () => console.log(`nexus editor backend (reference) on http://127.0.0.1:${PORT} · data: ${DATA}`));
