#!/usr/bin/env node
// A keyless translation bridge for local demos.
//
// The desktop app speaks the OpenAI chat-completions protocol to a loopback
// endpoint when the provider is "Local". This process implements just enough of
// that protocol to translate the block array the app sends:
//
//   POST /v1/chat/completions
//   { messages: [{role:"system", content:"... Source language: auto ..."},
//                {role:"user", content:"[\"block one\", \"block two\"]"}] }
//   -> { choices: [{ message: { content: "{\"translations\":[...]}" }, finish_reason: "stop" }] }
//
// Blocks are translated with MyMemory's public API first (documented, keyless,
// anonymous daily quota) and Google's public `gtx` endpoint as a fallback. Both
// are free web endpoints, NOT licensed translation APIs: this file exists so a
// reader can see the product work end to end without a key. For real work point
// the app at your own key (Google Cloud, DeepL, OpenAI) or at a local model.
//
//   node scripts/translate-bridge.mjs [--port 4400] [--target vi] [--verbose]
import { createServer } from 'node:http';

const args = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (!arg.startsWith('--')) continue;
  const value = process.argv[i + 1]?.startsWith('--') ? 'true' : process.argv[i + 1];
  args.set(arg.slice(2), value ?? 'true');
}
const port = Number(args.get('port') ?? 4400);
const defaultTarget = String(args.get('target') ?? 'vi');
const verbose = args.has('verbose');

const cache = new Map();
const stats = { requests: 0, blocks: 0, mymemory: 0, google: 0, failed: 0, startedAt: Date.now() };

function log(...parts) {
  if (verbose) console.log(new Date().toISOString().slice(11, 19), ...parts);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) { reject(new Error('request exceeds 8 MB')); request.destroy(); return; }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function sourceLanguage(system) {
  const match = /source language:\s*([a-zA-Z-]+)/i.exec(system ?? '');
  const value = match?.[1]?.toLowerCase();
  return !value || value === 'auto' ? 'auto' : value;
}

async function fetchJson(url, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { 'user-agent': 'mirror-pdf-translate-bridge/1.0' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function translateWithMymemory(text, source, target) {
  const pair = `${source === 'auto' ? 'en' : source}|${target}`;
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${encodeURIComponent(pair)}`;
  const body = await fetchJson(url);
  const translated = body?.responseData?.translatedText;
  if (typeof translated !== 'string' || !translated.trim()) throw new Error('empty MyMemory answer');
  // MyMemory answers 200 with an explanation string when the quota is gone.
  if (/MYMEMORY WARNING|QUERY LENGTH LIMIT/i.test(translated)) throw new Error('MyMemory quota');
  return translated.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

async function translateWithGoogle(text, source, target) {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${encodeURIComponent(source)}&tl=${encodeURIComponent(target)}&dt=t&q=${encodeURIComponent(text)}`;
  const body = await fetchJson(url);
  const parts = Array.isArray(body?.[0]) ? body[0] : [];
  const translated = parts.map((segment) => (Array.isArray(segment) ? segment[0] : '')).join('');
  if (!translated.trim()) throw new Error('empty Google answer');
  return translated;
}

async function translate(text, source, target) {
  const key = `${source}|${target}|${text}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let result = text;
  for (const [name, run] of [['mymemory', translateWithMymemory], ['google', translateWithGoogle]]) {
    try {
      result = await run(text, source, target);
      stats[name] += 1;
      break;
    } catch (failure) {
      log(`${name} failed for a ${text.length}-char block: ${failure.message}`);
    }
  }
  if (result === text) stats.failed += 1;
  cache.set(key, result);
  return result;
}

function lastUserBlocks(messages) {
  const user = [...(messages ?? [])].reverse().find((message) => message?.role === 'user');
  if (!user) return null;
  try {
    const parsed = JSON.parse(user.content);
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) return parsed;
  } catch {
    // Not the block protocol (the chat panel sends prose): answer with the text unchanged.
  }
  return null;
}

const server = createServer(async (request, response) => {
  const send = (status, payload) => {
    const body = JSON.stringify(payload);
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
    response.end(body);
  };

  if (request.method === 'GET' && (request.url === '/health' || request.url === '/metrics')) {
    return send(200, { ok: true, target: defaultTarget, ...stats, uptimeSeconds: Math.round((Date.now() - stats.startedAt) / 1000) });
  }
  if (request.method === 'GET' && request.url?.startsWith('/v1/models')) {
    return send(200, { object: 'list', data: [{ id: 'translate-bridge', object: 'model' }] });
  }
  if (request.method !== 'POST' || !request.url?.startsWith('/v1/chat/completions')) {
    return send(404, { error: { message: 'only POST /v1/chat/completions is implemented' } });
  }

  let payload;
  try {
    payload = JSON.parse(await readBody(request));
  } catch (failure) {
    return send(400, { error: { message: `invalid JSON: ${failure.message}` } });
  }
  stats.requests += 1;
  const system = payload.messages?.find((message) => message?.role === 'system')?.content ?? '';
  const target = /into\s+([a-zA-Z-]{2,8})/i.exec(system)?.[1]?.toLowerCase() ?? defaultTarget;
  const source = sourceLanguage(system);
  const blocks = lastUserBlocks(payload.messages);

  if (!blocks) {
    // The chat panel is not a translation request: answer plainly so the app never hangs.
    const answer = 'Translate bridge: this endpoint only translates document blocks.';
    return send(200, { choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: answer } }] });
  }

  const started = Date.now();
  const translations = [];
  for (const block of blocks) {
    const text = block ?? '';
    if (!text.trim()) { translations.push(text); continue; }
    translations.push(await translate(text, source, target));
    // MyMemory's anonymous quota is small: a short delay keeps us polite.
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  stats.blocks += blocks.length;
  log(`translated ${blocks.length} block(s) ${source}->${target} in ${Date.now() - started} ms`);
  return send(200, {
    id: `bridge-${Date.now()}`,
    object: 'chat.completion',
    model: payload.model ?? 'translate-bridge',
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ translations }) } }]
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Translate bridge on http://127.0.0.1:${port}/v1 -> target ${defaultTarget}`);
  console.log('Keyless demo engines: MyMemory (documented, quota), Google gtx (fallback, undocumented).');
  console.log('Point the app at provider Local, endpoint http://127.0.0.1:' + port + '/v1, model translate-bridge.');
});
