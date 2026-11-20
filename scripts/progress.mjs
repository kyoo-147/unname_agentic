#!/usr/bin/env node
// Print the project's progress as numbers, from the two places that own them:
// docs/backlog-e-n.md (which items are done) and git (how much work landed).
//
//   node scripts/progress.mjs [--markdown]
//
// It reads the working tree, so run it after a wave rather than during one.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const markdown = process.argv.includes('--markdown');

const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

const backlog = readFileSync(join(root, 'docs', 'backlog-e-n.md'), 'utf8');
const rows = backlog.split('\n').filter((line) => /^\| [A-N]\d{2} \|/.test(line));
const count = (marker) => rows.filter((line) => line.includes(marker)).length;

const groups = [['E', 'Nhập liệu & cấu trúc'], ['F', 'OCR & visual'], ['G', 'Dịch chuyên nghiệp'], ['H', 'PDF editor & xuất file'], ['I', 'AI assistant & RAG'], ['J', 'Research & paper'], ['K', 'Workflow & extraction'], ['L', 'Reader / extension / desktop'], ['M', 'Privacy & security'], ['N', 'Đo chất lượng & phát hành']];
const byGroup = groups.map(([prefix, title]) => {
  const own = rows.filter((line) => line.startsWith(`| ${prefix}`));
  return { prefix, title, total: own.length, done: own.filter((line) => line.includes('✅')).length, partial: own.filter((line) => line.includes('🟡')).length };
});

const commitsToday = Number(git('rev-list', '--since', '2026-11-20 00:00', '--count', 'HEAD'));
const commitsTotal = Number(git('rev-list', '--count', 'HEAD'));
const merges = Number(git('rev-list', '--count', '--merges', 'HEAD'));
const last = git('log', '-1', '--format=%h %s');

const lines = [];
lines.push(markdown ? '| Nhóm | Xong | Một phần | Tổng |' : 'Nhóm                           Xong / Một phần / Tổng');
if (markdown) lines.push('|---|---|---|---|');
for (const group of byGroup) {
  lines.push(markdown ? `| ${group.prefix}. ${group.title} | ${group.done} | ${group.partial} | ${group.total} |` : `${(group.prefix + '. ' + group.title).padEnd(30)} ${String(group.done).padStart(3)} / ${String(group.partial).padStart(2)} / ${String(group.total).padStart(3)}`);
}
const total = rows.length;
const done = count('✅');
const partial = count('🟡');
lines.push('');
lines.push(markdown ? `| Tổng | ${done} | ${partial} | ${total} |` : `${'Tổng'.padEnd(30)} ${String(done).padStart(3)} / ${String(partial).padStart(2)} / ${String(total).padStart(3)}`);
lines.push('');
lines.push(`commit hôm nay ${commitsToday} · tổng ${commitsTotal} · merge ${merges}`);
lines.push(`HEAD ${last}`);
process.stdout.write(lines.join('\n') + '\n');
