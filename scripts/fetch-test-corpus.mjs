#!/usr/bin/env node
/**
 * Fetch a real-world PDF test corpus for mirror_trans_pdf.
 *
 * Usage:
 *   node scripts/fetch-test-corpus.mjs [--force] [--concurrency N] [--strict]
 *
 * Downloads each URL over HTTPS (redirects followed, 60 s timeout, 120 MB cap,
 * 2 retries), validates the payload before publishing it, and writes:
 *   artifacts/test-corpus/NN-slug.pdf
 *   artifacts/test-corpus/corpus-manifest.json
 *   artifacts/test-corpus/corpus-summary.json
 *
 * Existing valid files are reused, so re-running is cheap and idempotent.
 * Invalid downloads are deleted, never published.
 */

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CORPUS_DIR = path.join(ROOT, 'artifacts', 'test-corpus');
const MANIFEST_PATH = path.join(CORPUS_DIR, 'corpus-manifest.json');
const SUMMARY_PATH = path.join(CORPUS_DIR, 'corpus-summary.json');

const MAX_BYTES = 120 * 1024 * 1024;
const MIN_BYTES = 20 * 1024;
const TIMEOUT_MS = 60_000;
const RETRIES = 2;
const DEFAULT_CONCURRENCY = 4;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const DOCUMENTS = [
  {
    title: "MIT 15.393 IAP 2025: Beginner's Guide to VC",
    slug: 'beginner-guide-to-vc',
    url: 'https://ocw.mit.edu/courses/15-393-nuts-and-bolts-of-new-ventures-january-iap-2025/mit15_393_iap25_beginners-guide-to-vc_ses5_part1.pdf',
  },
  {
    title: 'MIT 15.393 IAP 2025: Venture Capital Deal Terms',
    slug: 'vc-deal-terms',
    url: 'https://ocw.mit.edu/courses/15-393-nuts-and-bolts-of-new-ventures-january-iap-2025/mit15_393_iap25_venture-capital-deal-terms_ses5_part1.pdf',
  },
  {
    title: 'YC SAFE User Guide',
    slug: 'yc-safe-user-guide',
    url: 'https://bookface-static.ycombinator.com/assets/ycdc/SAFE%20User%20Guide-a47c6588327d73aa2799e61ed7c2cae9f1a0ee9acfa9c43b62039dc06e715832.pdf',
  },
  {
    title: 'HSBC US Completed Financings Guide 2026',
    slug: 'hsbc-completed-financings-guide',
    url: 'https://www.hsbcinnovationbanking.com/-/media/hinv/pdf/us-completed-financings-guide-2026.pdf',
  },
  {
    title: 'NVCA 2026 Yearbook',
    slug: 'nvca-2026-yearbook',
    url: 'https://nvca.org/wp-content/uploads/2026/04/NVCA-2026-Yearbook-4.9.26.pdf',
  },
  {
    title: 'SEC: Anatomy of Raising Capital',
    slug: 'sec-anatomy-raising-capital',
    url: 'https://www.sec.gov/files/anatomy-raising-capital.pdf',
  },
  {
    title: 'SEC OASB TCC Slides',
    slug: 'sec-oasb-tcc-slides',
    url: 'https://www.sec.gov/files/oasb-tcc-ppt.pdf',
  },
  {
    title: 'MIT 15.393 IAP 2025: What Are the Terms (Part 3)',
    slug: 'what-are-the-terms',
    url: 'https://ocw.mit.edu/courses/15-393-nuts-and-bolts-of-new-ventures-january-iap-2025/mit15_393_iap25_what_are_the_terms_part3_ses5_part1.pdf',
  },
  {
    title: 'MIT 15.393 IAP 2025: All Financing Sources',
    slug: 'all-financing-sources',
    url: 'https://ocw.mit.edu/courses/15-393-nuts-and-bolts-of-new-ventures-january-iap-2025/mit15_393_iap25all_financing_sources_ses5_part1.pdf',
  },
  {
    title: 'MIT 15.393 IAP 2025: Dilution',
    slug: 'dilution',
    url: 'https://ocw.mit.edu/courses/15-393-nuts-and-bolts-of-new-ventures-january-iap-2025/mit15_393_iap25_dilution_ses5_part1.pdf',
  },
  {
    title: 'MIT 15.393 IAP 2025: Thinking About Valuation',
    slug: 'thinking-about-valuation',
    url: 'https://ocw.mit.edu/courses/15-393-nuts-and-bolts-of-new-ventures-january-iap-2025/mit15_393_iap25_thinking_about_valuation_ses5_part1.pdf',
  },
  {
    title: 'MIT 15.431 Entrepreneurial Finance: Lecture 1',
    slug: 'mit-15-431-lecture-01',
    url: 'https://ocw.mit.edu/courses/15-431-entrepreneurial-finance-spring-2011/4a2e49e2bb9d4dbfe0bb7b89cccb1016_MIT15_431S11_lec01.pdf',
  },
  {
    title: 'MIT 15.431 Entrepreneurial Finance: Lecture 5',
    slug: 'mit-15-431-lecture-05',
    url: 'https://ocw.mit.edu/courses/15-431-entrepreneurial-finance-spring-2011/087effe609c8c7c597ba8c92f86d11ec_MIT15_431S11_lec05.pdf',
  },
  {
    title: 'MIT 15.431 Entrepreneurial Finance: Lecture 8',
    slug: 'mit-15-431-lecture-08',
    url: 'https://ocw.mit.edu/courses/15-431-entrepreneurial-finance-spring-2011/c4f24465da4825762232032699d7a132_MIT15_431S11_lec08.pdf',
  },
  {
    title: 'MIT 15.431 Entrepreneurial Finance: Lecture 10',
    slug: 'mit-15-431-lecture-10',
    url: 'https://ocw.mit.edu/courses/15-431-entrepreneurial-finance-spring-2011/eaea828a7b13f14dad4346961a018071_MIT15_431S11_lec10.pdf',
  },
  {
    title: 'MIT 15.431 Entrepreneurial Finance: Lecture 20',
    slug: 'mit-15-431-lecture-20',
    url: 'https://ocw.mit.edu/courses/15-431-entrepreneurial-finance-spring-2011/fd1e26cd4266ff11f6c8e1fbfd3019f3_MIT15_431S11_lec20.pdf',
  },
  {
    title: 'MIT 15.431 Entrepreneurial Finance: Lecture 21',
    slug: 'mit-15-431-lecture-21',
    url: 'https://ocw.mit.edu/courses/15-431-entrepreneurial-finance-spring-2011/9e690c8eb9e00575584eb32f0938c433_MIT15_431S11_lec21.pdf',
  },
  {
    title: 'MIT 15.431 Entrepreneurial Finance: Lecture 23',
    slug: 'mit-15-431-lecture-23',
    url: 'https://ocw.mit.edu/courses/15-431-entrepreneurial-finance-spring-2011/2d67bd8703313fac26d6bc226396b7de_MIT15_431S11_lec23.pdf',
  },
  {
    title: 'Damodaran: Valuation, Chapter 23',
    slug: 'damodaran-valuation-ch23',
    url: 'https://pages.stern.nyu.edu/~adamodar/pdfiles/val3ed/c23.pdf',
  },
  {
    title: 'MIT 15.393 IAP 2025: Session 5 Part 2 (Derezinski)',
    slug: 'session5-derezinski',
    url: 'https://ocw.mit.edu/courses/15-393-nuts-and-bolts-of-new-ventures-january-iap-2025/mit15_393_iap25_session5_part2_derezinski.pdf',
  },
  {
    title: 'HUST OER Business Document',
    slug: 'hust-oer-business',
    url: 'https://dlib.hust.edu.vn/bitstream/HUST/22807/1/OER000001997-1.pdf',
  },
  {
    title: 'OpenStax: Introduction to Business',
    slug: 'openstax-introduction-to-business',
    url: 'https://assets.openstax.org/oscms-prodcms/media/documents/IntroductionToBusiness-OP_8D04gAa.pdf',
  },
  {
    title: 'MIT 15.393 IAP 2025: Session 1 Part 1 (Hadzima)',
    slug: 'session1-hadzima',
    url: 'https://ocw.mit.edu/courses/15-393-nuts-and-bolts-of-new-ventures-january-iap-2025/mit15_393_iap25_session1_part1_slides_hadzima.pdf',
  },
  {
    title: 'MIT 15.393 IAP 2025: Session 1 Part 2 (Jones)',
    slug: 'session1-jones',
    url: 'https://ocw.mit.edu/courses/15-393-nuts-and-bolts-of-new-ventures-january-iap-2025/mit15_393_iap25_session1_part2_slides_jones.pdf',
  },
  {
    title: 'MIT 15.393 IAP 2025: Session 2 Part 2 (Kivel)',
    slug: 'session2-kivel',
    url: 'https://ocw.mit.edu/courses/15-393-nuts-and-bolts-of-new-ventures-january-iap-2025/mit15_393_iap25_session2_part2_slides_kivel.pdf',
  },
  {
    title: 'MIT 15.393 IAP 2025: Session 4 Part 1 (Jones)',
    slug: 'session4-part1-jones',
    url: 'https://ocw.mit.edu/courses/15-393-nuts-and-bolts-of-new-ventures-january-iap-2025/mit15_393_iap25_session4_part1_slides_jones.pdf',
  },
  {
    title: 'MIT 15.393 IAP 2025: Session 4 Part 2 (Garber)',
    slug: 'session4-part2-garber',
    url: 'https://ocw.mit.edu/courses/15-393-nuts-and-bolts-of-new-ventures-january-iap-2025/mit15_393_iap25_session4_part2_garber.pdf',
  },
  {
    title: 'MIT 15.393 IAP 2025: Session 6 Part 2 (Hatsopoulos)',
    slug: 'session6-hatsopoulos',
    url: 'https://ocw.mit.edu/courses/15-393-nuts-and-bolts-of-new-ventures-january-iap-2025/mit15_393_iap25_session6_part2_slides_hatsopoulos.pdf',
  },
  {
    title: 'MIT 15.393 IAP 2025: Session 6 Part 1 (Jones)',
    slug: 'session6-part1-jones',
    url: 'https://ocw.mit.edu/courses/15-393-nuts-and-bolts-of-new-ventures-january-iap-2025/mit15_393_iap25_session6_part1_slides_jones.pdf',
  },
  {
    title: 'MIT 15.393 IAP 2025: Lecture Slides',
    slug: 'lecture-slides',
    url: 'https://ocw.mit.edu/courses/15-393-nuts-and-bolts-of-new-ventures-january-iap-2025/mit15_393_iap25_lectureslides.pdf',
  },
  {
    title: 'MIT 15.393 IAP 2025: Session 3 Part 1 (Hadzima)',
    slug: 'session3-hadzima',
    url: 'https://ocw.mit.edu/courses/15-393-nuts-and-bolts-of-new-ventures-january-iap-2025/mit15_393_iap25_session3_part1_hadzima.pdf',
  },
  {
    title: 'MIT 15.393 IAP 2025: Ten Commandments',
    slug: 'ten-commandments',
    url: 'https://ocw.mit.edu/courses/15-393-nuts-and-bolts-of-new-ventures-january-iap-2025/mit_15393_iap25_ten_commandment_ses3_part1.pdf',
  },
  {
    title: 'MIT 15.393 IAP 2025: Steer Clear',
    slug: 'steer-clear',
    url: 'https://ocw.mit.edu/courses/15-393-nuts-and-bolts-of-new-ventures-january-iap-2025/mit15_393_iap_steer_clear_ses3_part1.pdf',
  },
  {
    title: 'MIT 15.393 IAP 2025: Of Kleenex',
    slug: 'of-kleenex',
    url: 'https://ocw.mit.edu/courses/15-393-nuts-and-bolts-of-new-ventures-january-iap-2025/mit15_393_iap25_of_kleenex_ses3_part1.pdf',
  },
  {
    title: 'MIT 15.393 IAP 2025: Questions of Copyright',
    slug: 'questions-of-copyright',
    url: 'https://ocw.mit.edu/courses/15-393-nuts-and-bolts-of-new-ventures-january-iap-2025/mit15_393_iap25_questions_of_copyright_ses3_part1.pdf',
  },
  {
    title: 'Stanford AI Index Report 2026',
    slug: 'stanford-ai-index-2026',
    url: 'https://hai.stanford.edu/assets/files/ai_index_report_2026.pdf',
  },
  {
    title: 'Stanford: Enterprise AI Playbook',
    slug: 'enterprise-ai-playbook',
    url: 'https://digitaleconomy.stanford.edu/app/uploads/2026/03/EnterpriseAIPlaybook_PereiraGraylinBrynjolfsson.pdf',
  },
  {
    title: 'NIST AI Risk Management Framework 1.0',
    slug: 'nist-ai-rmf-1-0',
    url: 'https://nvlpubs.nist.gov/nistpubs/ai/NIST.AI.100-1.pdf',
  },
  {
    title: 'NIST AI 600-1: Generative AI Profile',
    slug: 'nist-ai-600-1',
    url: 'https://nvlpubs.nist.gov/nistpubs/ai/NIST.AI.600-1.pdf',
  },
  {
    title: 'World Bank: Financing Innovation',
    slug: 'worldbank-financing-innovation',
    url: 'https://documents1.worldbank.org/curated/en/099111623132511499/pdf/P178764034088f0840b95603af423252410.pdf',
  },
  {
    title: 'World Bank: Tokyo Startup Ecosystem',
    slug: 'worldbank-tokyo-startup-ecosystem',
    url: 'https://documents1.worldbank.org/curated/en/977211634185509759/pdf/Tokyo-Start-Up-Ecosystem.pdf',
  },
];

class DownloadError extends Error {
  constructor(message, { retryable = false } = {}) {
    super(message);
    this.name = 'DownloadError';
    this.retryable = retryable;
  }
}

function parseArgs(argv) {
  const options = { force: false, concurrency: DEFAULT_CONCURRENCY, strict: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--force') options.force = true;
    else if (arg === '--strict') options.strict = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--concurrency') {
      const raw = argv[i + 1];
      i += 1;
      if (!raw || !/^\d+$/.test(raw) || Number(raw) < 1) {
        throw new Error('--concurrency expects a positive integer');
      }
      options.concurrency = Math.min(Number(raw), 16);
    } else if (arg.startsWith('--concurrency=')) {
      const raw = arg.slice('--concurrency='.length);
      if (!/^\d+$/.test(raw) || Number(raw) < 1) {
        throw new Error('--concurrency expects a positive integer');
      }
      options.concurrency = Math.min(Number(raw), 16);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function printUsage() {
  console.log(`Usage: node scripts/fetch-test-corpus.mjs [--force] [--concurrency N] [--strict]

  --force           Redownload every PDF, even when a valid local copy exists.
  --concurrency N   Parallel downloads (1-16, default ${DEFAULT_CONCURRENCY}).
  --strict          Exit with code 1 when any document failed.

Outputs:
  artifacts/test-corpus/NN-slug.pdf
  artifacts/test-corpus/corpus-manifest.json
  artifacts/test-corpus/corpus-summary.json`);
}

/** Return a human-readable reason when the first 1024 bytes are not a usable PDF. */
function inspectHead(buffer, contentType = '') {
  const head = buffer.subarray(0, 1024);
  const latin = head.toString('latin1');
  const lower = latin.toLowerCase();
  const type = (contentType || '').toLowerCase();
  const startsWithHtml = /^\s*(?:<!doctype\s+html|<html[\s>])/i.test(latin);
  const hasPdfMagic = latin.includes('%PDF');

  if (startsWithHtml) {
    const login =
      /type\s*=\s*["']?password|name\s*=\s*["']?password|sign[\s-]*in|log[\s-]*in/i.test(
        lower,
      );
    return `HTML ${login ? 'login page' : 'page'} returned instead of PDF (content-type: ${type || 'unknown'})`;
  }

  if (!hasPdfMagic) {
    if (type.includes('text/html') || type.includes('application/xhtml+xml')) {
      const login =
        /type\s*=\s*["']?password|name\s*=\s*["']?password|sign[\s-]*in|log[\s-]*in/i.test(
          lower,
        );
      return `HTML ${login ? 'login page' : 'page'} returned instead of PDF (no %PDF signature, content-type: ${type})`;
    }
    return `missing %PDF signature in first 1024 bytes (content-type: ${type || 'unknown'})`;
  }

  return null;
}

function describeError(error) {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
    return `timeout after ${TIMEOUT_MS / 1000}s`;
  }
  const cause = error?.cause;
  if (cause) {
    const code = cause.code || cause.errno || '';
    const message = cause.message || String(cause);
    return `${error.message || 'fetch failed'}${code ? ` [${code}]` : ''}: ${message}`;
  }
  return error?.message || String(error);
}

function isRetryable(error) {
  if (error instanceof DownloadError) return error.retryable;
  // Network failures, dropped bodies and stream errors are worth retrying.
  return true;
}

async function hashFile(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

/** Validate an existing local file so reruns can skip it. */
async function inspectExisting(filePath) {
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    return { ok: false, error: `cannot stat existing file: ${describeError(error)}` };
  }
  if (!stat.isFile()) return { ok: false, error: 'existing path is not a regular file' };
  if (stat.size <= MIN_BYTES) {
    return {
      ok: false,
      error: `existing file too small: ${stat.size} bytes (minimum is > ${MIN_BYTES})`,
    };
  }

  const handle = await fs.open(filePath, 'r');
  let head;
  try {
    const buffer = Buffer.alloc(1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    head = buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
  const headError = inspectHead(head, '');
  if (headError) return { ok: false, error: `existing file invalid: ${headError}` };

  const sha256 = await hashFile(filePath);
  return { ok: true, bytes: stat.size, sha256 };
}

async function downloadOnce(document, destination) {
  const response = await fetch(document.url, {
    method: 'GET',
    redirect: 'follow',
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/pdf,application/octet-stream;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cache-Control': 'no-cache',
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!response.ok) {
    try {
      await response.body?.cancel();
    } catch {
      // Nothing useful to do with the failed response body.
    }
    const status = response.status;
    const retryable = status === 408 || status === 425 || status === 429 || status >= 500;
    throw new DownloadError(
      `HTTP ${status}${response.statusText ? ` ${response.statusText}` : ''}`,
      { retryable },
    );
  }

  if (!response.url.startsWith('https://')) {
    try {
      await response.body?.cancel();
    } catch {
      // Ignore.
    }
    throw new DownloadError(`redirected to non-HTTPS URL: ${response.url}`, {
      retryable: false,
    });
  }

  const contentLength = response.headers.get('content-length');
  if (contentLength && Number(contentLength) > MAX_BYTES) {
    try {
      await response.body?.cancel();
    } catch {
      // Ignore.
    }
    throw new DownloadError(
      `declared size ${contentLength} bytes exceeds ${MAX_BYTES} byte limit`,
      { retryable: false },
    );
  }

  if (!response.body) {
    throw new DownloadError('response has no body', { retryable: true });
  }

  const hash = createHash('sha256');
  let bytes = 0;
  let head = Buffer.alloc(0);

  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > MAX_BYTES) {
        callback(
          new DownloadError(`download exceeded ${MAX_BYTES} byte limit`, {
            retryable: false,
          }),
        );
        return;
      }
      if (head.length < 1024) {
        head = Buffer.concat([head, chunk.subarray(0, 1024 - head.length)]);
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });

  try {
    await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(destination));
  } catch (error) {
    await fs.rm(destination, { force: true }).catch(() => {});
    throw error;
  }

  if (bytes <= MIN_BYTES) {
    await fs.rm(destination, { force: true });
    throw new DownloadError(
      `file too small: ${bytes} bytes (minimum is > ${MIN_BYTES})`,
      { retryable: true },
    );
  }

  const headError = inspectHead(head, response.headers.get('content-type') || '');
  if (headError) {
    await fs.rm(destination, { force: true });
    throw new DownloadError(headError, { retryable: false });
  }

  return { bytes, sha256: hash.digest('hex') };
}

async function downloadWithRetries(document, entry) {
  let lastError = null;
  for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
    if (attempt > 0) {
      console.warn(
        `        retry ${attempt}/${RETRIES} for ${entry.file}: ${describeError(lastError)}`,
      );
      await sleep(1000 * attempt);
    }

    const tempPath = path.join(
      CORPUS_DIR,
      `.${entry.file}.part-${process.pid}-${attempt}-${Date.now()}`,
    );
    try {
      const result = await downloadOnce(document, tempPath);
      const finalPath = path.join(CORPUS_DIR, entry.file);
      await fs.rm(finalPath, { force: true });
      await fs.rename(tempPath, finalPath);
      return result;
    } catch (error) {
      lastError = error;
      await fs.rm(tempPath, { force: true }).catch(() => {});
      if (!isRetryable(error) || attempt === RETRIES) break;
    }
  }
  throw lastError;
}

async function processDocument(document, entry, options) {
  const finalPath = path.join(CORPUS_DIR, entry.file);

  if (!options.force) {
    const existing = await inspectExisting(finalPath);
    if (existing?.ok) {
      entry.bytes = existing.bytes;
      entry.sha256 = existing.sha256;
      entry.ok = true;
      entry.error = null;
      console.log(
        `[${String(entry.index).padStart(2, '0')}/${DOCUMENTS.length}] REUSE ${entry.file} (${entry.bytes} bytes)`,
      );
      return entry;
    }
    if (existing && !existing.ok) {
      console.warn(
        `[${String(entry.index).padStart(2, '0')}/${DOCUMENTS.length}] STALE ${entry.file}: ${existing.error}; redownloading`,
      );
      await fs.rm(finalPath, { force: true });
    }
  }

  try {
    const result = await downloadWithRetries(document, entry);
    entry.bytes = result.bytes;
    entry.sha256 = result.sha256;
    entry.ok = true;
    entry.error = null;
    console.log(
      `[${String(entry.index).padStart(2, '0')}/${DOCUMENTS.length}] OK    ${entry.file} (${entry.bytes} bytes)`,
    );
  } catch (error) {
    entry.bytes = 0;
    entry.sha256 = null;
    entry.ok = false;
    entry.error = describeError(error);
    await fs.rm(finalPath, { force: true }).catch(() => {});
    console.error(
      `[${String(entry.index).padStart(2, '0')}/${DOCUMENTS.length}] FAIL  ${entry.file}: ${entry.error}`,
    );
  }
  return entry;
}

async function runPool(items, concurrency, worker) {
  let next = 0;
  const runners = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (true) {
        const current = next;
        next += 1;
        if (current >= items.length) return;
        await worker(items[current], current);
      }
    },
  );
  await Promise.all(runners);
}

async function writeJsonAtomic(filePath, value) {
  const temporary = `${filePath}.tmp-${process.pid}`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rm(filePath, { force: true });
  await fs.rename(temporary, filePath);
}

async function removeStaleParts() {
  let names;
  try {
    names = await fs.readdir(CORPUS_DIR);
  } catch {
    return;
  }
  await Promise.all(
    names
      .filter((name) => name.includes('.part-') || name.includes('.tmp-'))
      .map((name) => fs.rm(path.join(CORPUS_DIR, name), { force: true }).catch(() => {})),
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }

  await fs.mkdir(CORPUS_DIR, { recursive: true });
  await removeStaleParts();

  const entries = DOCUMENTS.map((document, index) => ({
    index: index + 1,
    title: document.title,
    url: document.url,
    file: `${String(index + 1).padStart(2, '0')}-${document.slug}.pdf`,
    bytes: 0,
    sha256: null,
    ok: false,
    error: null,
  }));

  console.log(
    `Fetching ${DOCUMENTS.length} PDFs into ${path.relative(process.cwd(), CORPUS_DIR) || CORPUS_DIR}` +
      `${options.force ? ' (force redownload)' : ''} with concurrency ${options.concurrency}`,
  );

  let done = 0;
  const total = DOCUMENTS.length;
  await runPool(DOCUMENTS, options.concurrency, async (document, index) => {
    await processDocument(document, entries[index], options);
    done += 1;
    if (done === total) console.log(`Progress: ${done}/${total} processed`);
  });

  entries.sort((a, b) => a.index - b.index);
  const succeeded = entries.filter((entry) => entry.ok).length;
  const failed = entries.length - succeeded;
  const summary = {
    total: entries.length,
    succeeded,
    failed,
    totalBytes: entries.reduce((sum, entry) => sum + (entry.ok ? entry.bytes : 0), 0),
    generatedAt: new Date().toISOString(),
    forced: options.force,
  };

  await writeJsonAtomic(MANIFEST_PATH, entries);
  await writeJsonAtomic(SUMMARY_PATH, summary);

  console.log('');
  console.log(`Summary: ${succeeded} succeeded, ${failed} failed, ${entries.length} total`);
  console.log(
    `Bytes: ${summary.totalBytes} across ${succeeded} valid PDFs`,
  );
  console.log(`Manifest: ${MANIFEST_PATH}`);
  console.log(`Summary:  ${SUMMARY_PATH}`);

  if (failed > 0) {
    console.log('');
    console.log('Failures:');
    for (const entry of entries) {
      if (!entry.ok) console.log(`  ${entry.file} ${entry.url} -> ${entry.error}`);
    }
  }

  if (options.strict && failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`Fatal: ${error?.stack || error}`);
  process.exitCode = 1;
});
