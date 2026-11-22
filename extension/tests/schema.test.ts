import { describe, expect, it } from 'vitest';
import {
  AMBIGUOUS_LABEL_PREFIX,
  SchemaError,
  defineSchema,
  extractFields,
  validateValue,
} from '../viewer/src/core/schema';
import type { FieldBlock, FieldSchema } from '../viewer/src/core/schema';

function field(
  id: string,
  label: string,
  type: FieldSchema['type'],
  extra: Partial<Pick<FieldSchema, 'required' | 'pattern' | 'enumValues'>> = {},
): Record<string, unknown> {
  return { id, label, type, ...extra };
}

function block(id: string, text: string, overrides: Partial<FieldBlock> = {}): FieldBlock {
  return {
    id,
    page: 1,
    text,
    rect: { x: 10, y: 20, width: 200, height: 12 },
    confidence: 1,
    ...overrides,
  };
}

function first<T>(items: readonly T[]): T {
  const [item] = items;
  if (item === undefined) throw new Error('expected at least one item');
  return item;
}

function schemaError(run: () => unknown): SchemaError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(SchemaError);
    return error as SchemaError;
  }
  throw new Error('expected the schema to be refused');
}

describe('defineSchema', () => {
  it('accepts a bare array or a fields object and defaults required to false', () => {
    const bare = defineSchema([field('note', 'Note', 'text')]);
    expect(bare).toEqual([{ id: 'note', label: 'Note', type: 'text', required: false }]);

    const wrapped = defineSchema({ fields: [field('note', 'Note', 'text')] });
    expect(wrapped).toEqual(bare);
  });

  it('refuses duplicate ids with the offending path', () => {
    const error = schemaError(() =>
      defineSchema([field('id', 'Invoice number', 'text'), field('id', 'Customer', 'text')]),
    );
    expect(error.code).toBe('duplicate-id');
    expect(error.path).toBe('fields[1].id');
    expect(error.message).toContain('fields[1].id');
  });

  it('refuses an unknown type', () => {
    const error = schemaError(() => defineSchema([field('amount', 'Amount', 'money' as FieldSchema['type'])]));
    expect(error.code).toBe('unknown-type');
    expect(error.path).toBe('fields[0].type');
    expect(error.message).toContain('text | number | date | currency | identifier | enum');
  });

  it('refuses a pattern that does not compile', () => {
    const error = schemaError(() => defineSchema([field('code', 'Code', 'text', { pattern: '([' })]));
    expect(error.code).toBe('invalid-pattern');
    expect(error.path).toBe('fields[0].pattern');
    expect(error.message).toContain('fields[0].pattern');
    expect(error.message).toContain('not a valid regular expression');
  });

  it('refuses a label repeated in another case or without accents', () => {
    const statuses = schemaError(() =>
      defineSchema([field('status', 'Status', 'text'), field('state', 'STATUS', 'text')]),
    );
    expect(statuses.code).toBe('duplicate-label');
    expect(statuses.path).toBe('fields[1].label');

    const vietnamese = schemaError(() =>
      defineSchema([field('date', 'Ngày', 'date'), field('issued', 'NGAY', 'date')]),
    );
    expect(vietnamese.code).toBe('duplicate-label');
  });

  it('needs enum values on an enum field and refuses them elsewhere', () => {
    const missing = schemaError(() => defineSchema([field('status', 'Status', 'enum')]));
    expect(missing.code).toBe('invalid-enum-values');
    expect(missing.path).toBe('fields[0].enumValues');

    const unexpected = schemaError(() =>
      defineSchema([field('status', 'Status', 'text', { enumValues: ['paid'] })]),
    );
    expect(unexpected.code).toBe('unexpected-enum-values');
    expect(unexpected.path).toBe('fields[0].enumValues');

    const duplicated = schemaError(() =>
      defineSchema([field('status', 'Status', 'enum', { enumValues: ['Paid', 'PAID'] })]),
    );
    expect(duplicated.code).toBe('invalid-enum-values');
  });

  it('refuses a value that is not a schema at all', () => {
    const error = schemaError(() => defineSchema('fields' as unknown));
    expect(error.code).toBe('malformed-schema');
    expect(error.path).toBe('fields');
  });
});

describe('extractFields', () => {
  it('reads a text field from the same line as its label', () => {
    const schema = defineSchema([field('customer', 'Customer', 'text', { required: true })]);
    const result = extractFields([block('p1-r0', 'Customer: Nguyễn Văn A')], schema);

    expect(result.missing).toEqual([]);
    const found = first(result.fields);
    expect(found).toMatchObject({
      id: 'customer',
      value: 'Nguyễn Văn A',
      raw: 'Nguyễn Văn A',
      page: 1,
      blockId: 'p1-r0',
      rect: { x: 10, y: 20, width: 200, height: 12 },
      valid: true,
      problems: [],
    });
    expect(found.confidence).toBe(0.9);
  });

  it('normalises a number in either separator convention', () => {
    const schema = defineSchema([field('amount', 'Amount', 'number', { required: true })]);
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['Amount: 1.234,56', '1234.56'],
      ['Amount: 1,234.56', '1234.56'],
      ['Amount: 1234', '1234'],
      ['Amount: 0,125', '0.125'],
      ['Amount: 1 234,56', '1234.56'],
      ['Amount: 1.234,56 VND', '1234.56'],
      ['Amount: 1.234,56VND', '1234.56'],
      ['Amount: VND 1.234,56', '1234.56'],
      ['Amount: -1.234,50', '-1234.5'],
      ['Amount: (1.234,50)', '-1234.5'],
    ];
    for (const [text, expected] of cases) {
      const result = extractFields([block('p1-r0', text)], schema);
      const found = first(result.fields);
      expect(found.value).toBe(expected);
      expect(found.valid).toBe(true);
    }
  });

  it('normalises a date in either order and drops a trailing time', () => {
    const schema = defineSchema([field('issued', 'Issued', 'date', { required: true })]);
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['Issued: 12/03/2024', '2024-03-12'],
      ['Issued: 2024-03-12', '2024-03-12'],
      ['Issued: 1/2/2024', '2024-02-01'],
      ['Issued: 12/03/2024 09:30', '2024-03-12'],
    ];
    for (const [text, expected] of cases) {
      const result = extractFields([block('p1-r0', text)], schema);
      expect(first(result.fields).value).toBe(expected);
    }
  });

  it('reads a currency amount and keeps the printed form in raw', () => {
    const schema = defineSchema([field('total', 'Tổng cộng', 'currency', { required: true })]);
    const result = extractFields([block('p1-r0', 'Tổng cộng: 1.234,56 ₫')], schema);

    const found = first(result.fields);
    expect(found.value).toBe('1234.56');
    expect(found.raw).toBe('1.234,56 ₫');
    expect(found.valid).toBe(true);
  });

  it('normalises an identifier by dropping spaces and keeping case', () => {
    const schema = defineSchema([field('invoice', 'Số hóa đơn', 'identifier', { required: true })]);
    const result = extractFields([block('p1-r0', 'Số hóa đơn: INV 2024-001')], schema);

    const found = first(result.fields);
    expect(found.value).toBe('INV2024-001');
    expect(found.raw).toBe('INV 2024-001');
    expect(found.valid).toBe(true);
  });

  it('matches an enum case-insensitively and returns the schema spelling', () => {
    const schema = defineSchema([
      field('status', 'Trạng thái', 'enum', {
        required: true,
        enumValues: ['Đã thanh toán', 'Chưa thanh toán'],
      }),
    ]);
    const paid = extractFields([block('p1-r0', 'Trạng thái: đã THANH TOÁN')], schema);
    const paidField = first(paid.fields);
    expect(paidField.value).toBe('Đã thanh toán');
    expect(paidField.valid).toBe(true);

    const other = extractFields([block('p1-r0', 'Trạng thái: Đang xử lý')], schema);
    const otherField = first(other.fields);
    expect(otherField.value).toBe('Đang xử lý');
    expect(otherField.valid).toBe(false);
    expect(otherField.problems).toEqual(['enum']);
  });

  it('finds a value on the next line of the same block with lower confidence', () => {
    const schema = defineSchema([field('invoice', 'Invoice number', 'identifier', { required: true })]);
    const result = extractFields([block('p1-r0', 'Invoice number\nINV-2024-001')], schema);

    const found = first(result.fields);
    expect(found.value).toBe('INV-2024-001');
    expect(found.blockId).toBe('p1-r0');
    expect(found.confidence).toBe(0.65);
    expect(found.confidence).toBeLessThan(0.9);
  });

  it('finds a value in the next block and reports the value location', () => {
    const schema = defineSchema([field('invoice', 'Invoice number', 'identifier', { required: true })]);
    const result = extractFields(
      [
        block('p1-r0', 'Invoice number'),
        block('p1-r1', 'INV-2024-001', { rect: { x: 10, y: 40, width: 200, height: 12 } }),
      ],
      schema,
    );

    const found = first(result.fields);
    expect(found.value).toBe('INV-2024-001');
    expect(found.blockId).toBe('p1-r1');
    expect(found.page).toBe(1);
    expect(found.rect).toEqual({ x: 10, y: 40, width: 200, height: 12 });
    expect(found.confidence).toBe(0.55);
  });

  it('reports a required field that is absent and leaves an optional field out', () => {
    const schema = defineSchema([
      field('invoice', 'Invoice number', 'identifier', { required: true }),
      field('note', 'Note', 'text'),
    ]);
    const result = extractFields([block('p1-r0', 'Something else entirely')], schema);

    expect(result.fields).toEqual([]);
    expect(result.missing).toEqual([{ id: 'invoice', label: 'Invoice number' }]);
  });

  it('returns the higher-confidence duplicate label and names the other block', () => {
    const schema = defineSchema([field('invoice', 'Invoice number', 'identifier', { required: true })]);
    const result = extractFields(
      [
        block('p1-r0', 'Invoice number: INV-LOW', { confidence: 0.5 }),
        block('p1-r1', 'Invoice number: INV-HIGH', { rect: { x: 10, y: 60, width: 200, height: 12 } }),
      ],
      schema,
    );

    const found = first(result.fields);
    expect(found.value).toBe('INV-HIGH');
    expect(found.blockId).toBe('p1-r1');
    expect(found.confidence).toBe(0.9);
    expect(found.problems).toEqual([`${AMBIGUOUS_LABEL_PREFIX}p1-r0`]);
    // Ambiguity is a review note, not a defect in the value.
    expect(found.valid).toBe(true);
  });

  it('marks a pattern mismatch invalid', () => {
    const schema = defineSchema([
      field('code', 'Mã', 'identifier', { required: true, pattern: '^INV-\\d{4}$' }),
    ]);
    const result = extractFields([block('p1-r0', 'Mã: 2024')], schema);

    const found = first(result.fields);
    expect(found.valid).toBe(false);
    expect(found.problems).toEqual(['pattern']);
    // A field that was found but does not validate is present, not missing.
    expect(result.missing).toEqual([]);
  });

  it('matches Vietnamese labels with or without diacritics in the document', () => {
    const schema = defineSchema([field('issued', 'Ngày:', 'date', { required: true })]);
    const accented = extractFields([block('p1-r0', 'Ngày: 12/03/2024')], schema);
    expect(first(accented.fields).value).toBe('2024-03-12');

    const plain = extractFields([block('p1-r0', 'Ngay: 01/02/2024')], schema);
    expect(first(plain.fields).value).toBe('2024-02-01');
  });

  it('tolerates extra spaces inside the label and around the separator', () => {
    const schema = defineSchema([field('invoice', 'Invoice number', 'identifier', { required: true })]);
    const result = extractFields([block('p1-r0', 'Invoice   number  :   INV-2024-001')], schema);

    const found = first(result.fields);
    expect(found.value).toBe('INV-2024-001');
    expect(found.valid).toBe(true);
  });

  it('does not read a label mentioned inside a sentence', () => {
    const schema = defineSchema([field('invoice', 'Invoice number', 'identifier', { required: true })]);
    const result = extractFields([block('p1-r0', 'The invoice number is not stated in this document.')], schema);

    expect(result.fields).toEqual([]);
    expect(result.missing).toEqual([{ id: 'invoice', label: 'Invoice number' }]);
  });

  it('does not consume a neighbouring field as the value of a label-only block', () => {
    const schema = defineSchema([
      field('invoice', 'Invoice number', 'identifier', { required: true }),
      field('issued', 'Date', 'date', { required: true }),
    ]);
    const result = extractFields(
      [
        block('p1-r0', 'Invoice number'),
        block('p1-r1', 'Date: 12/03/2024', { rect: { x: 10, y: 40, width: 200, height: 12 } }),
      ],
      schema,
    );

    expect(result.fields.map(entry => entry.id)).toEqual(['issued']);
    expect(first(result.fields).value).toBe('2024-03-12');
    expect(result.missing).toEqual([{ id: 'invoice', label: 'Invoice number' }]);
  });

  it('accepts a Document IR block through raw and polygon', () => {
    const schema = defineSchema([field('invoice', 'Số hóa đơn', 'identifier', { required: true })]);
    const result = extractFields(
      [
        {
          id: 'p2-r0',
          page: 2,
          raw: 'Số hóa đơn: INV 9',
          polygon: [
            { x: 0, y: 0 },
            { x: 100, y: 0 },
            { x: 100, y: 10 },
            { x: 0, y: 10 },
          ],
          confidence: 0.8,
        },
      ],
      schema,
    );

    const found = first(result.fields);
    expect(found.page).toBe(2);
    expect(found.blockId).toBe('p2-r0');
    expect(found.rect).toEqual({ x: 0, y: 0, width: 100, height: 10 });
    expect(found.confidence).toBe(0.72);
  });

  it('refuses input that is not a block array', () => {
    const schema = defineSchema([field('note', 'Note', 'text')]);
    const error = schemaError(() => extractFields(null as unknown as FieldBlock[], schema));
    expect(error.code).toBe('malformed-input');
    expect(error.path).toBe('blocks');
  });
});

describe('validateValue', () => {
  it('accepts an empty optional value and reports an empty required one', () => {
    const [optional] = defineSchema([field('note', 'Note', 'text')]);
    expect(validateValue(optional!, '')).toEqual([]);

    const [required] = defineSchema([field('note', 'Note', 'text', { required: true })]);
    expect(validateValue(required!, '')).toEqual(['required']);
  });

  it('reports each type problem as a stable code', () => {
    const [number] = defineSchema([field('amount', 'Amount', 'number')]);
    expect(validateValue(number!, '1.234,56')).toEqual([]);
    expect(validateValue(number!, 'twelve')).toEqual(['not-a-number']);

    const [date] = defineSchema([field('issued', 'Issued', 'date')]);
    expect(validateValue(date!, '2024-03-12')).toEqual([]);
    expect(validateValue(date!, '31/02/2024')).toEqual(['date-format']);
    expect(validateValue(date!, '12/03/1700')).toEqual(['date-implausible']);

    const [identifier] = defineSchema([field('code', 'Code', 'identifier')]);
    expect(validateValue(identifier!, 'INV-1')).toEqual([]);
    expect(validateValue(identifier!, 'INV 1')).toEqual(['identifier-whitespace']);
    expect(validateValue(identifier!, '---')).toEqual(['not-an-identifier']);

    const [status] = defineSchema([
      field('status', 'Status', 'enum', { enumValues: ['Paid', 'Unpaid'] }),
    ]);
    expect(validateValue(status!, 'paid')).toEqual([]);
    expect(validateValue(status!, 'Partially paid')).toEqual(['enum']);
  });
});
