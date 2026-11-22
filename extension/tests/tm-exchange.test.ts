import { describe, expect, it } from 'vitest';
import { GLOSSARY_MAX_ENTRIES, type GlossaryEntry } from '../viewer/src/core/glossary';
import { TM_SCHEMA_VERSION, TranslationMemory, type TmEntry } from '../viewer/src/core/tm';
import {
  exportGlossaryCsv,
  exportGlossaryTbx,
  exportGlossaryTmx,
  exportTmCsv,
  exportTmTmx,
  formatCsv,
  importGlossaryCsv,
  importGlossaryTbx,
  importGlossaryTmx,
  importTmCsv,
  importTmTmx,
  parseCsv,
  parseTmCsv,
  parseTmTmx,
  TmExchangeError,
  type ExchangeErrorCode,
  type ExchangeFormat,
} from '../viewer/src/core/tm-exchange';

const BASE_TIME = Date.UTC(2026, 2, 15, 8, 45, 30);

function expectExchangeError(
  run: () => unknown,
  expected: { code: ExchangeErrorCode; format?: ExchangeFormat; line?: number },
): TmExchangeError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(TmExchangeError);
    const ex = error as TmExchangeError;
    expect(ex.code).toBe(expected.code);
    if (expected.format !== undefined) expect(ex.format).toBe(expected.format);
    if (expected.line !== undefined) expect(ex.line).toBe(expected.line);
    expect(ex.issues.length).toBeGreaterThan(0);
    return ex;
  }
  throw new Error(`Expected TmExchangeError(${expected.code})`);
}

function makeTmEntry(overrides: Partial<TmEntry> & Pick<TmEntry, 'id' | 'source' | 'target'>): TmEntry {
  return {
    sourceLang: 'en',
    targetLang: 'vi',
    engine: 'human',
    createdAt: BASE_TIME,
    uses: 0,
    ...overrides,
  };
}

describe('RFC 4180 CSV parser and formatter', () => {
  it('formats and parses UTF-8 Vietnamese, CJK, commas, quotes, and multiline quoted fields', () => {
    const headers = ['source', 'target'];
    const rows = [
      ['Hello, "world"', 'Xin chào, "thế giới"'],
      ['Line 1\nLine 2', 'Dòng 1\r\nDòng 2'],
      ['日本語と中文 & 한국어', 'Tiếng Việt: ă â đ ê ô ơ ư ỷ ỹ'],
    ];

    const csv = formatCsv(headers, rows);
    expect(csv).toBe(
      'source,target\r\n' +
        '"Hello, ""world""","Xin chào, ""thế giới"""\r\n' +
        '"Line 1\nLine 2","Dòng 1\r\nDòng 2"\r\n' +
        '日本語と中文 & 한국어,Tiếng Việt: ă â đ ê ô ơ ư ỷ ỹ\r\n',
    );

    const parsed = parseCsv(csv);
    expect(parsed.headers).toEqual(['source', 'target']);
    expect(parsed.rows).toEqual([
      { line: 2, values: ['Hello, "world"', 'Xin chào, "thế giới"'] },
      { line: 3, values: ['Line 1\nLine 2', 'Dòng 1\r\nDòng 2'] },
      { line: 6, values: ['日本語と中文 & 한국어', 'Tiếng Việt: ă â đ ê ô ơ ư ỷ ỹ'] },
    ]);
  });

  it('strips an optional UTF-8 BOM on import and writes one only when requested', () => {
    const withoutBom = formatCsv(['a', 'b'], [['1', '2']]);
    expect(withoutBom.startsWith('\uFEFF')).toBe(false);

    const withBom = formatCsv(['a', 'b'], [['1', '2']], { bom: true });
    expect(withBom.startsWith('\uFEFF')).toBe(true);

    const parsed = parseCsv(withBom);
    expect(parsed.headers).toEqual(['a', 'b']);
    expect(parsed.rows).toEqual([{ line: 2, values: ['1', '2'] }]);
  });

  it('reports exact line numbers for RFC 4180 syntax errors and column mismatches', () => {
    expectExchangeError(() => parseCsv('   \r\n '), {
      code: 'empty-input',
      format: 'csv',
      line: 1,
    });

    expectExchangeError(() => parseCsv('source,target\n"unclosed,value\nnext,line'), {
      code: 'malformed-csv',
      format: 'csv',
      line: 2,
    });

    expectExchangeError(() => parseCsv('source,target\n"abc"def,ghi'), {
      code: 'malformed-csv',
      format: 'csv',
      line: 2,
    });

    expectExchangeError(() => parseCsv('source,target\nfoo"bar,baz'), {
      code: 'malformed-csv',
      format: 'csv',
      line: 2,
    });

    expectExchangeError(() => parseCsv('source,target\nalpha,beta\nonly_one_col'), {
      code: 'invalid-schema',
      format: 'csv',
      line: 3,
    });
  });
});

describe('Glossary CSV import and export', () => {
  it('round-trips UTF-8 Vietnamese, CJK, and RFC 4180 special characters', () => {
    const entries: GlossaryEntry[] = [
      { source: 'neural network', target: 'mạng nơ-ron' },
      { source: 'API, "v2"', target: 'Giao diện lập trình, "v2"' },
      { source: '機械学習', target: 'Học máy (tiếng Nhật)' },
    ];

    const csv = exportGlossaryCsv(entries);
    expect(importGlossaryCsv(csv)).toEqual(entries);
  });

  it('rejects bad CSV headers and glossary constraint violations with exact line numbers', () => {
    expectExchangeError(() => importGlossaryCsv('src,tgt\nalpha,beta'), {
      code: 'invalid-schema',
      format: 'csv',
      line: 1,
    });

    expectExchangeError(() => importGlossaryCsv('source,source\na,b'), {
      code: 'invalid-schema',
      format: 'csv',
      line: 1,
    });

    expectExchangeError(() => importGlossaryCsv('source,target,unexpected\na,b,c'), {
      code: 'invalid-schema',
      format: 'csv',
      line: 1,
    });

    expectExchangeError(() => importGlossaryCsv('source,target\nok,đúng\n  ,missing_source'), {
      code: 'missing-field',
      format: 'csv',
      line: 3,
    });

    expectExchangeError(() => importGlossaryCsv('source,target\nok,đúng\nmissing_target,   '), {
      code: 'missing-field',
      format: 'csv',
      line: 3,
    });

    const longSource = 'x'.repeat(65);
    expectExchangeError(() => importGlossaryCsv(`source,target\n${longSource},ok`), {
      code: 'invalid-field',
      format: 'csv',
      line: 2,
    });

    const longTarget = 'y'.repeat(129);
    expectExchangeError(() => importGlossaryCsv(`source,target\nok,${longTarget}`), {
      code: 'invalid-field',
      format: 'csv',
      line: 2,
    });

    expectExchangeError(() => importGlossaryCsv('source,target\nGPU,GPU\ngpu,Bộ xử lý đồ họa'), {
      code: 'duplicate-term',
      format: 'csv',
      line: 3,
    });

    const rows = Array.from({ length: GLOSSARY_MAX_ENTRIES + 1 }, (_, i) => `term-${i},mục-${i}`);
    expectExchangeError(() => importGlossaryCsv(['source,target', ...rows].join('\n')), {
      code: 'invalid-field',
      format: 'csv',
      line: GLOSSARY_MAX_ENTRIES + 2,
    });
  });
});

describe('Glossary TBX-Basic import and export', () => {
  it('exports valid TBX-Basic XML and preserves UTF-8 Vietnamese, CJK, and XML special characters', () => {
    const entries: GlossaryEntry[] = [
      { source: 'R&D <Lab> "A" & \'B\'', target: 'Phòng R&D <Thử nghiệm> "A" & \'B\'' },
      { source: '自然言語処理', target: 'Xử lý ngôn ngữ tự nhiên (NLP)' },
      { source: '인공지능', target: 'Trí tuệ nhân tạo' },
    ];

    const tbx = exportGlossaryTbx(entries, { sourceLang: 'en', targetLang: 'vi' });
    expect(tbx).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(tbx).toContain('<martif type="TBX-Basic" xml:lang="en">');
    expect(tbx).toContain('<martifHeader>');
    expect(tbx).toContain('<term>R&amp;D &lt;Lab&gt; &quot;A&quot; &amp; &apos;B&apos;</term>');

    const imported = importGlossaryTbx(tbx);
    expect(imported).toEqual({
      sourceLang: 'en',
      targetLang: 'vi',
      entries,
    });
  });

  it('imports TBX-Basic with reversed langSet order, CDATA, numeric entities, and TBX v3 conceptEntry', () => {
    const martifReordered = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<martif type="TBX-Basic" xml:lang="en">',
      '  <martifHeader><fileDesc><sourceDesc><p>External</p></sourceDesc></fileDesc></martifHeader>',
      '  <text><body>',
      '    <termEntry id="t-1">',
      '      <langSet xml:lang="vi"><tig><term><![CDATA[Bảo mật <UTF-8> & khóa]]></term></tig></langSet>',
      '      <langSet xml:lang="en"><tig><term>UTF-8 &#x26; Security</term></tig></langSet>',
      '    </termEntry>',
      '  </body></text>',
      '</martif>',
    ].join('\n');

    expect(importGlossaryTbx(martifReordered)).toEqual({
      sourceLang: 'en',
      targetLang: 'vi',
      entries: [{ source: 'UTF-8 & Security', target: 'Bảo mật <UTF-8> & khóa' }],
    });

    const tbxV3 = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<tbx type="TBX-Basic" style="dct" xml:lang="en">',
      '  <tbxHeader><fileDesc><sourceDesc><p>V3</p></sourceDesc></fileDesc></tbxHeader>',
      '  <text><body>',
      '    <conceptEntry id="c-1">',
      '      <langSec xml:lang="en"><termSec><term>Latency</term></termSec></langSec>',
      '      <langSec xml:lang="vi"><termSec><term>Độ trễ</term></termSec></langSec>',
      '    </conceptEntry>',
      '  </body></text>',
      '</tbx>',
    ].join('\n');

    expect(importGlossaryTbx(tbxV3)).toEqual({
      sourceLang: 'en',
      targetLang: 'vi',
      entries: [{ source: 'Latency', target: 'Độ trễ' }],
    });
  });

  it('rejects malformed XML and invalid TBX-Basic schema with line numbers', () => {
    expectExchangeError(
      () =>
        importGlossaryTbx(
          '<?xml version="1.0" encoding="ISO-8859-1"?>\n<martif type="TBX-Basic" xml:lang="en"></martif>',
        ),
      { code: 'malformed-xml', format: 'tbx', line: 1 },
    );

    expectExchangeError(
      () =>
        importGlossaryTbx(
          [
            '<?xml version="1.0" encoding="UTF-8"?>',
            '<martif type="TBX-Basic" xml:lang="en">',
            '  <martifHeader><fileDesc><sourceDesc><p>X</p></sourceDesc></fileDesc></martifHeader>',
            '  <text><body>',
            '    <termEntry id="1"><langSet xml:lang="en"><tig><term>A &bogus;</term></tig></langSet></termEntry>',
            '  </body></text>',
            '</martif>',
          ].join('\n'),
        ),
      { code: 'malformed-xml', format: 'tbx', line: 5 },
    );

    expectExchangeError(
      () =>
        importGlossaryTbx(
          [
            '<?xml version="1.0" encoding="UTF-8"?>',
            '<martif type="TBX-Default" xml:lang="en">',
            '  <martifHeader><fileDesc><sourceDesc><p>X</p></sourceDesc></fileDesc></martifHeader>',
            '  <text><body/></text>',
            '</martif>',
          ].join('\n'),
        ),
      { code: 'invalid-schema', format: 'tbx', line: 2 },
    );

    expectExchangeError(
      () =>
        importGlossaryTbx(
          [
            '<?xml version="1.0" encoding="UTF-8"?>',
            '<martif type="TBX-Basic" xml:lang="en">',
            '  <text><body/></text>',
            '</martif>',
          ].join('\n'),
        ),
      { code: 'invalid-schema', format: 'tbx', line: 2 },
    );

    expectExchangeError(
      () =>
        importGlossaryTbx(
          [
            '<?xml version="1.0" encoding="UTF-8"?>',
            '<martif type="TBX-Basic" xml:lang="en">',
            '  <martifHeader><fileDesc><sourceDesc><p>X</p></sourceDesc></fileDesc></martifHeader>',
            '  <text><body>',
            '    <termEntry id="1">',
            '      <langSet xml:lang="en"><tig><term>Only source</term></tig></langSet>',
            '    </termEntry>',
            '  </body></text>',
            '</martif>',
        ].join('\n'),
        ),
      { code: 'missing-field', format: 'tbx', line: 5 },
    );

    expectExchangeError(
      () =>
        importGlossaryTbx(
          [
            '<?xml version="1.0" encoding="UTF-8"?>',
            '<martif type="TBX-Basic" xml:lang="en">',
            '  <martifHeader><fileDesc><sourceDesc><p>X</p></sourceDesc></fileDesc></martifHeader>',
            '  <text><body>',
            '    <termEntry id="dup">',
            '      <langSet xml:lang="en"><tig><term>Alpha</term></tig></langSet>',
            '      <langSet xml:lang="vi"><tig><term>Anpha</term></tig></langSet>',
            '    </termEntry>',
            '    <termEntry id="dup">',
            '      <langSet xml:lang="en"><tig><term>Beta</term></tig></langSet>',
            '      <langSet xml:lang="vi"><tig><term>Bêta</term></tig></langSet>',
            '    </termEntry>',
            '  </body></text>',
            '</martif>',
          ].join('\n'),
        ),
      { code: 'duplicate-id', format: 'tbx', line: 9 },
    );
  });
});

describe('Translation Memory CSV import and export', () => {
  it('exports TranslationMemory and imports it atomically into a fresh memory', () => {
    const sourceTm = new TranslationMemory();
    sourceTm.add(
      makeTmEntry({
        id: 'tm-1',
        source: 'Click "Save", then export.',
        target: 'Nhấn "Lưu", sau đó xuất tệp.',
        engine: 'openai',
        model: 'gpt-4o-mini',
        uses: 2,
      }),
    );
    sourceTm.add(
      makeTmEntry({
        id: 'tm-2',
        source: '文字化けしない UTF-8 テスト',
        target: 'Kiểm tra UTF-8 không lỗi font (한국어 포함)',
        sourceLang: 'ja',
        targetLang: 'vi',
        engine: 'human',
        createdAt: BASE_TIME + 123,
      }),
    );

    const csv = exportTmCsv(sourceTm);
    const parsedEntries = parseTmCsv(csv);
    expect(parsedEntries).toHaveLength(2);
    expect(parsedEntries[0]?.model).toBe('gpt-4o-mini');
    expect(parsedEntries[1]?.model).toBeUndefined();
    expect(parsedEntries[1]?.createdAt).toBe(BASE_TIME + 123);

    const targetTm = new TranslationMemory();
    const result = importTmCsv(targetTm, csv);
    expect(result).toEqual({ imported: 2, total: 2 });
    expect(JSON.parse(targetTm.exportJson())).toEqual({
      schemaVersion: TM_SCHEMA_VERSION,
      kind: 'translation-memory',
      entries: parsedEntries,
    });
  });

  it('rejects bad TM CSV rows and leaves target memory untouched on failure', () => {
    const tm = new TranslationMemory();
    tm.add(makeTmEntry({ id: 'existing', source: 'Keep me', target: 'Giữ nguyên' }));

    const invalidTimestampCsv = [
      'id,source,target,sourceLang,targetLang,engine,model,createdAt,uses',
      'tm-ok,Good,Tốt,en,vi,human,,1700000000000,0',
      'tm-bad,Bad,Xấu,en,vi,human,,not-an-int,0',
    ].join('\n');

    expectExchangeError(() => importTmCsv(tm, invalidTimestampCsv), {
      code: 'invalid-field',
      format: 'csv',
      line: 3,
    });
    expect(tm.stats().entries).toBe(1);

    const dupAgainstMemoryCsv = [
      'id,source,target,sourceLang,targetLang,engine,model,createdAt,uses',
      'tm-new,New,Mới,en,vi,human,,1700000000000,0',
      'existing,Dup,Trùng,en,vi,human,,1700000000000,0',
    ].join('\n');

    expectExchangeError(() => importTmCsv(tm, dupAgainstMemoryCsv), {
      code: 'duplicate-id',
      format: 'csv',
      line: 3,
    });
    expect(tm.stats().entries).toBe(1);
  });
});

describe('Translation Memory and Glossary TMX 1.4b import and export', () => {
  it('exports valid TMX 1.4b and lossless round-trips UTF-8, XML special chars, and millisecond createdAt', () => {
    const entries: TmEntry[] = [
      makeTmEntry({
        id: 'tmx-1',
        source: '5 < 10 & "quoted" \'tag\'',
        target: '5 < 10 & "ngoặc" \'thẻ\' tiếng Việt',
        engine: 'deepl',
        model: 'next-gen',
        createdAt: BASE_TIME + 456,
        uses: 4,
      }),
      makeTmEntry({
        id: 'tmx-2',
        source: '高速翻訳エンジン',
        target: 'Công cụ dịch nhanh 漢字 / 한글',
        sourceLang: 'ja',
        targetLang: 'vi',
        engine: 'human',
        createdAt: BASE_TIME,
        uses: 0,
      }),
    ];

    const tmx = exportTmTmx(entries);
    expect(tmx).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(tmx).toContain('<tmx version="1.4">');
    expect(tmx).toContain('<header ');
    expect(tmx).toContain('srclang="*all*"');
    expect(tmx).toContain('<seg>5 &lt; 10 &amp; &quot;quoted&quot; &apos;tag&apos;</seg>');

    const targetTm = new TranslationMemory();
    const res = importTmTmx(targetTm, tmx);
    expect(res).toEqual({ imported: 2, total: 2 });
    expect(parseTmTmx(tmx)).toEqual(entries);
  });

  it('imports external TMX 1.4b with reordered tuv languages, CDATA, inline tags, and comments', () => {
    const externalTmx = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<tmx version="1.4">',
      '  <header creationtool="OmegaT" creationtoolversion="6.0" segtype="sentence" o-tmf="OmegaT TMX" adminlang="en" srclang="en" datatype="plaintext"/>',
      '  <body>',
      '    <!-- Vietnamese tuv comes before English tuv -->',
      '    <tu tuid="ext-1" creationdate="20260315T084530Z" creationid="translator">',
      '      <tuv xml:lang="vi"><seg><![CDATA[Xin chào <user> & bạn]]></seg></tuv>',
      '      <tuv xml:lang="en"><seg>Hello <hi x="1">&lt;user&gt;</hi> &amp; friend</seg></tuv>',
      '    </tu>',
      '  </body>',
      '</tmx>',
    ].join('\n');

    const entries = parseTmTmx(externalTmx);
    expect(entries).toEqual([
      {
        id: 'ext-1',
        source: 'Hello <user> & friend',
        target: 'Xin chào <user> & bạn',
        sourceLang: 'en',
        targetLang: 'vi',
        engine: 'translator',
        createdAt: Date.UTC(2026, 2, 15, 8, 45, 30),
        uses: 0,
      },
    ]);
  });

  it('rejects invalid TMX 1.4b XML, header, segtype, tuv, and duplicate ids with line numbers atomically', () => {
    const tm = new TranslationMemory();
    tm.add(makeTmEntry({ id: 'keep', source: 'Keep', target: 'Giữ' }));

    expectExchangeError(
      () =>
        importTmTmx(
          tm,
          '<?xml version="1.0" encoding="UTF-8"?>\n<tmx version="2.0">\n  <header creationtool="x" creationtoolversion="1" segtype="sentence" o-tmf="x" adminlang="en" srclang="en" datatype="plaintext"/>\n  <body/>\n</tmx>',
        ),
      { code: 'invalid-schema', format: 'tmx', line: 2 },
    );

    expectExchangeError(
      () =>
        importTmTmx(
          tm,
          [
            '<?xml version="1.0" encoding="UTF-8"?>',
            '<tmx version="1.4">',
            '  <header creationtool="x" creationtoolversion="1" segtype="bogus" o-tmf="x" adminlang="en" srclang="en" datatype="plaintext"/>',
            '  <body/>',
            '</tmx>',
          ].join('\n'),
        ),
      { code: 'invalid-schema', format: 'tmx', line: 3 },
    );

    expectExchangeError(
      () =>
        importTmTmx(
          tm,
          [
            '<?xml version="1.0" encoding="UTF-8"?>',
            '<tmx version="1.4">',
            '  <header creationtool="x" creationtoolversion="1" segtype="sentence" o-tmf="x" adminlang="en" srclang="en" datatype="plaintext"/>',
            '  <body>',
            '    <tu tuid="one-tuv"><tuv xml:lang="en"><seg>Only source</seg></tuv></tu>',
            '  </body>',
            '</tmx>',
          ].join('\n'),
        ),
      { code: 'missing-field', format: 'tmx', line: 5 },
    );

    expectExchangeError(
      () =>
        importTmTmx(
          tm,
          [
            '<?xml version="1.0" encoding="UTF-8"?>',
            '<tmx version="1.4">',
            '  <header creationtool="x" creationtoolversion="1" segtype="sentence" o-tmf="x" adminlang="en" srclang="en" datatype="plaintext"/>',
            '  <body>',
            '    <tu tuid="mismatched">',
            '      <tuv xml:lang="en"><seg>Hello</seg>',
            '    </tu>',
            '  </body>',
            '</tmx>',
          ].join('\n'),
        ),
      { code: 'malformed-xml', format: 'tmx', line: 7 },
    );

    expectExchangeError(
      () =>
        importTmTmx(
          tm,
          [
            '<?xml version="1.0" encoding="UTF-8"?>',
            '<tmx version="1.4">',
            '  <header creationtool="x" creationtoolversion="1" segtype="sentence" o-tmf="x" adminlang="en" srclang="en" datatype="plaintext"/>',
            '  <body>',
            '    <tu tuid="ok-1" creationdate="20260315T084530Z">',
            '      <tuv xml:lang="en"><seg>One</seg></tuv>',
            '      <tuv xml:lang="vi"><seg>Một</seg></tuv>',
            '    </tu>',
            '    <tu tuid="keep" creationdate="20260315T084530Z">',
            '      <tuv xml:lang="en"><seg>Two</seg></tuv>',
            '      <tuv xml:lang="vi"><seg>Hai</seg></tuv>',
            '    </tu>',
            '  </body>',
            '</tmx>',
          ].join('\n'),
        ),
      { code: 'duplicate-id', format: 'tmx', line: 9 },
    );

    expect(tm.stats().entries).toBe(1);
  });

  it('round-trips Glossary through TMX 1.4b and enforces glossary term constraints', () => {
    const entries: GlossaryEntry[] = [
      { source: 'Vector DB & RAG', target: 'Cơ sở dữ liệu vector & RAG' },
      { source: '量子計算', target: 'Điện toán lượng tử' },
    ];

    const tmx = exportGlossaryTmx(entries, { sourceLang: 'en', targetLang: 'vi' });
    expect(tmx).toContain('segtype="phrase"');
    expect(importGlossaryTmx(tmx)).toEqual({
      sourceLang: 'en',
      targetLang: 'vi',
      entries,
    });

    const dupGlossaryTmx = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<tmx version="1.4">',
      '  <header creationtool="x" creationtoolversion="1" segtype="phrase" o-tmf="x" adminlang="en" srclang="en" datatype="plaintext"/>',
      '  <body>',
      '    <tu tuid="g1"><tuv xml:lang="en"><seg>Cache</seg></tuv><tuv xml:lang="vi"><seg>Bộ nhớ đệm</seg></tuv></tu>',
      '    <tu tuid="g2"><tuv xml:lang="en"><seg>cache</seg></tuv><tuv xml:lang="vi"><seg>Đệm</seg></tuv></tu>',
      '  </body>',
      '</tmx>',
    ].join('\n');

    expectExchangeError(() => importGlossaryTmx(dupGlossaryTmx), {
      code: 'duplicate-term',
      format: 'tmx',
      line: 6,
    });
  });
});
