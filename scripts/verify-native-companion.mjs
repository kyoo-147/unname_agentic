import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';

const root = resolve('.');
const run = join(root, 'artifacts', `native-companion-${randomUUID()}`);
const inbox = join(run, 'inbox');
await mkdir(inbox, { recursive: true });
const env = { ...process.env, PDF_WORKSPACE_INBOX: inbox, PDF_WORKSPACE_HOME: join(run, 'library'), PDF_WORKSPACE_DATA: join(run, 'services'), PDF_WORKSPACE_LAYOUT_PREVIEW: '0', FDL_SCRIPT: join(root, 'scripts/native-companion-smoke.txt'), FDL_SHOTS: run, FDL_TRACE: '1' };
const host = spawn(join(root, 'desktop/target/debug/pdf-workspace-host.exe'), ['chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
let buffer = Buffer.alloc(0); const replies = []; const waiters = []; let hostError = '';
host.stderr.on('data', data => { hostError += data; });
host.stdout.on('data', data => {
  buffer = Buffer.concat([buffer, data]);
  while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE(0) + 4) {
    const length = buffer.readUInt32LE(0); const value = JSON.parse(buffer.subarray(4, length + 4)); buffer = buffer.subarray(length + 4);
    const waiter = waiters.shift(); if (waiter) waiter(value); else replies.push(value);
  }
});
function request(value) {
  const data = Buffer.from(JSON.stringify(value)); const header = Buffer.alloc(4); header.writeUInt32LE(data.length);
  const result = new Promise(resolve => { const cached = replies.shift(); if (cached) resolve(cached); else waiters.push(resolve); });
  host.stdin.write(Buffer.concat([header, data]));
  return Promise.race([result, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Native host reply timed out')), 15000); timer.unref(); })]).then(reply => { assert.equal(reply.ok, true, JSON.stringify(reply)); return reply; });
}
async function snapshot(name) {
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    try { return JSON.parse(await readFile(join(run, `${name}.json`), 'utf8')); } catch { await new Promise(resolve => setTimeout(resolve, 80)); }
  }
  throw new Error(`Native snapshot missing: ${name}`);
}
let app; let appLog = '';
try {
  await request({ type: 'hello' });
  const bytes = await readFile(join(root, 'tests/fixtures/mirror-field-notes.pdf'));
  const binding = { session_id: randomUUID(), source_id: 'a'.repeat(64), request_nonce: randomUUID(), generation: Date.now() };
  const page = { page: 2, page_count: 4, fraction: 0, zoom: 1 };
  await request({ type: 'begin', binding, total_bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), title: 'Chrome transfer verification', page });
  for (let offset = 0, index = 0; offset < bytes.length; offset += 192 * 1024, index++) await request({ type: 'chunk', binding, index, data: bytes.subarray(offset, offset + 192 * 1024).toString('base64') });
  await request({ type: 'commit', binding });
  app = spawn(join(root, 'native-shell/target/debug/pdf_workspace.exe'), [], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  app.stderr.on('data', data => { appLog += data; });
  const closed = new Promise(resolve => app.once('exit', (code, signal) => resolve({ code, signal })));
  const initial = await snapshot('companion-initial');
  assert.equal(initial.page, 2, 'Committed browser page must survive asynchronous PDF load');
  assert.equal(initial.browser_linked, true);
  await snapshot('companion-ready');
  await request({ type: 'page', binding, page: { page: 1, page_count: 4, fraction: 0.25, zoom: 1.3 } });
  const followed = await snapshot('companion-followed');
  assert.equal(followed.page, 1); assert.equal(followed.browser_linked, true);
  const reachable = Math.max(...followed.panes.map(pane => Math.max(0, (pane.page[1] + 32 - pane.viewport[1]) / pane.page[1])));
  assert.ok(Math.abs(followed.position[1] - Math.min(0.25, reachable)) < 0.01, JSON.stringify(followed));
  const nativeEdited = await snapshot('companion-native-edited');
  assert.equal(nativeEdited.page, 2, 'Native Next must advance the linked document');
  const polled = await request({ type: 'poll', binding, after_sequence: 0 });
  assert.ok(polled.command, 'Native user navigation must create a bound reverse command');
  assert.deepEqual(polled.command.binding, binding);
  assert.equal(polled.command.page.page, nativeEdited.page);
  assert.ok(Math.abs(polled.command.page.fraction - nativeEdited.position[1]) < 0.02, JSON.stringify(polled.command));
  const acknowledged = await request({ type: 'poll', binding, after_sequence: polled.command.sequence });
  assert.equal(acknowledged.command, null, 'Reverse command cursor must suppress replay');
  await request({ type: 'page', binding, page: polled.command.page });
  const echo = await request({ type: 'poll', binding, after_sequence: polled.command.sequence });
  assert.equal(echo.command, null, 'Applying a browser echo must not invent native input');
  await request({ type: 'end', binding });
  const ended = await snapshot('companion-ended'); assert.equal(ended.browser_linked, false);
  const result = await closed; assert.equal(result.code, 0, appLog);
  const published = (await readdir(inbox)).filter(name => name.startsWith('ready-'));
  assert.equal(published.length, 1);
  const contents = await readdir(join(inbox, published[0])); assert.ok(contents.includes('acknowledged.json')); assert.ok(!contents.includes('document.pdf'), 'Duplicate inbox PDF must be removed after retained import');
  const index = JSON.parse(await readFile(join(run, 'library/documents/index.json'), 'utf8')); assert.equal(Object.keys(index).length, 1);
  const proof = { transport: 'Real native host framing -> checksum-verified inbox -> live GPUI reader; Chrome registry not modified', run_directory: run, initial, followed, nativeEdited, reverse_command: polled.command, ended, app_exit: result.code, duplicate_inbox_pdf_removed: true, cloud_requests: 0, note: 'Chrome nativeMessaging registration and extension-to-host connection remain a separate user-invoked installation gate.' };
  await writeFile(join(root, 'artifacts/native-companion-verification.json'), JSON.stringify(proof, null, 2));
  console.log(JSON.stringify(proof, null, 2));
} finally {
  host.stdin.end(); if (app && app.exitCode === null) app.kill();
  const hostClosed = new Promise(resolve => host.once('exit', resolve));
  if (host.exitCode === null) await Promise.race([hostClosed, new Promise(resolve => setTimeout(() => { host.kill(); resolve(); }, 2000))]);
  await writeFile(join(run, 'app.log'), appLog); await writeFile(join(run, 'host.log'), hostError);
}
