import { describe, expect, it } from 'vitest';
import {
  FORM_FLAG_MULTI_SELECT,
  FORM_FLAG_PUSHBUTTON,
  FORM_FLAG_RADIO,
  FORM_FLAG_READ_ONLY,
  FORM_FLAG_REQUIRED,
  collectFields,
  flattenPlan,
  planFill,
  type CollectFieldsResult,
  type FormField,
  type RawFormWidget,
} from '../src/core/forms';
import type { Rect } from '../src/core/types';

function rect(x: number, y: number, width: number, height: number): Rect {
  return { x, y, width, height };
}

/** Collects fields and asserts that every widget was understood. */
function collect(widgets: readonly RawFormWidget[]): FormField[] {
  const result = collectFields(widgets);
  expect(result.unsupported).toEqual([]);
  return result.fields;
}

function fieldNamed(fields: readonly FormField[], name: string): FormField {
  const field = fields.find(candidate => candidate.name === name);
  if (field === undefined) throw new Error(`expected a field named "${name}"`);
  return field;
}

function optionValues(field: FormField): string[] {
  return (field.options ?? []).map(option => option.value);
}

describe('collectFields: field kinds', () => {
  it('collects text, checkbox, radio, choice and signature fields with their values', () => {
    const result = collectFields([
      { fieldName: 'fullname', fieldType: 'text', fieldValue: 'An Nguyen', required: true, page: 1, rect: [72, 72, 320, 92] },
      { fieldName: 'agree', fieldType: 'checkbox', fieldValue: 'Yes', page: 1, rect: [72, 110, 88, 126] },
      {
        fieldName: 'colour',
        fieldType: 'radiobutton',
        fieldValue: 'green',
        exportValues: ['red', 'green', 'blue'],
        page: 2,
        rect: [72, 72, 88, 88],
      },
      { fieldName: 'country', fieldType: 'combobox', fieldValue: 'vn', options: ['vn', 'sg'], page: 2, rect: [72, 150, 220, 170] },
      { fieldName: 'signature', fieldType: 'signature', page: 2, rect: [72, 200, 220, 240] },
    ]);

    expect(result.unsupported).toEqual([]);
    expect(result.fields.map(field => field.name)).toEqual(['fullname', 'agree', 'colour', 'country', 'signature']);

    const fullname = fieldNamed(result.fields, 'fullname');
    expect(fullname).toMatchObject({
      type: 'text',
      value: 'An Nguyen',
      required: true,
      readOnly: false,
      page: 1,
      rect: rect(72, 72, 248, 20),
    });
    expect(fullname.options).toBeUndefined();

    expect(fieldNamed(result.fields, 'agree')).toMatchObject({ type: 'checkbox', value: true, required: false });
    expect(fieldNamed(result.fields, 'colour')).toMatchObject({ type: 'radio', value: 'green' });
    expect(optionValues(fieldNamed(result.fields, 'colour'))).toEqual(['red', 'green', 'blue']);
    expect(fieldNamed(result.fields, 'country')).toMatchObject({ type: 'choice', value: 'vn' });
    expect(optionValues(fieldNamed(result.fields, 'country'))).toEqual(['vn', 'sg']);
    expect(fieldNamed(result.fields, 'signature')).toMatchObject({ type: 'signature', value: null });
    expect(fieldNamed(result.fields, 'signature').options).toBeUndefined();
  });

  it('merges a radio group into one field and keeps the checked on-state', () => {
    const result = collectFields([
      { fieldName: 'size', fieldType: 'radio', exportValue: 's', page: 1, rect: [72, 72, 88, 88] },
      { fieldName: 'size', fieldType: 'radio', exportValue: 'm', checked: true, page: 1, rect: [100, 72, 116, 88] },
      { fieldName: 'size', fieldType: 'radio', exportValue: 'l', page: 1, rect: [128, 72, 144, 88] },
    ]);

    expect(result.unsupported).toEqual([]);
    expect(result.fields).toHaveLength(1);
    const size = fieldNamed(result.fields, 'size');
    expect(size.value).toBe('m');
    expect(optionValues(size)).toEqual(['s', 'm', 'l']);
    expect(size.page).toBe(1);
    expect(size.rect).toEqual(rect(72, 72, 16, 16));
  });

  it('keeps a selected radio value the widget list does not declare as an option', () => {
    const fields = collect([
      { fieldName: 'size', fieldType: 'radio', exportValues: ['s', 'm'], page: 1, rect: [72, 72, 88, 88] },
      { fieldName: 'size', fieldType: 'radio', exportValue: 'xl', checked: true, page: 1, rect: [100, 72, 116, 88] },
    ]);

    expect(fieldNamed(fields, 'size').value).toBe('xl');
    expect(optionValues(fieldNamed(fields, 'size'))).toEqual(['s', 'm', 'xl']);
  });

  it('merges a text field repeated on two pages and keeps the first widget geometry', () => {
    const fields = collect([
      { fieldName: 'applicant', fieldType: 'text', fieldValue: 'An', page: 1, rect: [72, 72, 272, 92] },
      { fieldName: 'applicant', fieldType: 'text', fieldValue: 'Ignored', page: 2, rect: [72, 600, 272, 620] },
    ]);

    expect(fields).toHaveLength(1);
    expect(fieldNamed(fields, 'applicant')).toMatchObject({ page: 1, rect: rect(72, 72, 200, 20) });
    expect(fieldNamed(fields, 'applicant').value).toBe('An');
  });

  it('reads choice options that carry a display label', () => {
    const fields = collect([
      {
        fieldName: 'country',
        fieldType: 'choice',
        fieldValue: 'vn',
        options: [
          { exportValue: 'vn', displayValue: 'Vietnam' },
          { exportValue: 'sg', displayValue: 'Singapore' },
        ],
        page: 1,
        rect: [72, 72, 220, 92],
      },
    ]);

    expect(fieldNamed(fields, 'country').options).toEqual([
      { value: 'vn', label: 'Vietnam' },
      { value: 'sg', label: 'Singapore' },
    ]);
  });

  it('reads the off state of a checkbox as unchecked', () => {
    const fields = collect([
      { fieldName: 'off', fieldType: 'checkbox', fieldValue: 'Off', page: 1, rect: [72, 72, 88, 88] },
      { fieldName: 'on', fieldType: 'checkbox', fieldValue: 'Yes', page: 1, rect: [100, 72, 116, 88] },
      { fieldName: 'flagged', fieldType: 'checkbox', checked: true, page: 1, rect: [128, 72, 144, 88] },
      { fieldName: 'boolean', fieldType: 'checkbox', fieldValue: true, page: 1, rect: [156, 72, 172, 88] },
    ]);

    expect(fieldNamed(fields, 'off').value).toBe(false);
    expect(fieldNamed(fields, 'on').value).toBe(true);
    expect(fieldNamed(fields, 'flagged').value).toBe(true);
    expect(fieldNamed(fields, 'boolean').value).toBe(true);
  });

  it('orders fields by page, then top, then left, whatever the input order', () => {
    const fields = collect([
      { fieldName: 'bottom', fieldType: 'text', page: 1, rect: [300, 300, 400, 320] },
      { fieldName: 'page-two', fieldType: 'text', page: 2, rect: [72, 72, 200, 92] },
      { fieldName: 'top-right', fieldType: 'text', page: 1, rect: [300, 72, 400, 92] },
      { fieldName: 'top-left', fieldType: 'text', page: 1, rect: [72, 72, 200, 92] },
    ]);

    expect(fields.map(field => field.name)).toEqual(['top-left', 'top-right', 'bottom', 'page-two']);
  });
});

describe('collectFields: unsupported widgets', () => {
  it('reports push buttons and unknown field types instead of dropping them', () => {
    const result = collectFields([
      { fieldName: 'submit', fieldType: 'pushbutton', page: 1, rect: [72, 72, 120, 92] },
      { fieldName: 'barcode', fieldType: 'barcode', fieldValue: 'x', page: 1, rect: [72, 100, 200, 120] },
      { fieldName: 'reset', fieldType: 'Btn', buttonType: 'pushbutton', page: 1, rect: [72, 130, 120, 150] },
    ]);

    expect(result.fields).toEqual([]);
    expect(result.unsupported).toEqual([
      { name: 'submit', widgetType: 'pushbutton', reason: 'unsupported-type', page: 1 },
      { name: 'barcode', widgetType: 'barcode', reason: 'unsupported-type', page: 1 },
      { name: 'reset', widgetType: 'Btn', reason: 'unsupported-type', page: 1 },
    ]);
  });

  it('reports a widget with no name, page or rect, and a non-object entry', () => {
    const notAWidget = 'not a widget' as unknown as RawFormWidget;
    const result = collectFields([
      { fieldType: 'text', fieldValue: 'x', page: 1, rect: [72, 72, 200, 92] },
      { fieldName: 'no-page', fieldType: 'text', rect: [72, 72, 200, 92] },
      { fieldName: 'no-rect', fieldType: 'text', page: 1 },
      notAWidget,
    ]);

    expect(result.fields).toEqual([]);
    expect(result.unsupported).toEqual([
      { name: '', widgetType: 'text', reason: 'missing-name', page: 1 },
      { name: 'no-page', widgetType: 'text', reason: 'missing-page', page: null },
      { name: 'no-rect', widgetType: 'text', reason: 'invalid-rect', page: 1 },
      { name: '', widgetType: '', reason: 'invalid-widget', page: null },
    ]);
  });

  it('reports a multi-select list box rather than truncating its value', () => {
    const result = collectFields([
      {
        fieldName: 'tags',
        fieldType: 'listbox',
        fieldFlags: FORM_FLAG_MULTI_SELECT,
        fieldValue: ['one'],
        page: 1,
        rect: [72, 72, 220, 120],
      },
      { fieldName: 'more-tags', fieldType: 'listbox', fieldValue: ['one', 'two'], page: 1, rect: [72, 130, 220, 170] },
    ]);

    expect(result.fields).toEqual([]);
    expect(result.unsupported.map(entry => [entry.name, entry.reason])).toEqual([
      ['tags', 'multi-select-value'],
      ['more-tags', 'multi-select-value'],
    ]);
  });

  it('reports a later widget whose type contradicts the field it reuses', () => {
    const result = collectFields([
      { fieldName: 'mixed', fieldType: 'text', page: 1, rect: [72, 72, 200, 92] },
      { fieldName: 'mixed', fieldType: 'checkbox', page: 1, rect: [72, 100, 88, 116] },
    ]);

    expect(result.fields).toHaveLength(1);
    expect(fieldNamed(result.fields, 'mixed').type).toBe('text');
    expect(result.unsupported).toEqual([
      { name: 'mixed', widgetType: 'checkbox', reason: 'type-conflict', page: 1 },
    ]);
  });

  it('reports a widget whose fieldType and buttonType disagree', () => {
    const result = collectFields([
      { fieldName: 'odd', fieldType: 'text', buttonType: 'radio', page: 1, rect: [72, 72, 200, 92] },
    ]);

    expect(result.unsupported).toEqual([
      { name: 'odd', widgetType: 'text', reason: 'type-conflict', page: 1 },
    ]);
  });

  it('rejects a non-array input instead of guessing', () => {
    expect(() => collectFields('nope' as unknown as RawFormWidget[])).toThrow(TypeError);
  });
});

describe('collectFields: PDF flags', () => {
  it('classifies a generic button from its flags and reads required and read-only', () => {
    const fields = collect([
      {
        fieldName: 'terms',
        fieldType: 'Btn',
        fieldFlags: FORM_FLAG_RADIO | FORM_FLAG_REQUIRED | FORM_FLAG_READ_ONLY,
        fieldValue: 'no',
        exportValues: ['yes', 'no'],
        page: 1,
        rect: [72, 72, 88, 88],
      },
      { fieldName: 'agree', fieldType: 'Btn', buttonType: 'checkbox', fieldValue: 'Off', page: 1, rect: [72, 100, 88, 116] },
    ]);

    const terms = fieldNamed(fields, 'terms');
    expect(terms.type).toBe('radio');
    expect(terms.required).toBe(true);
    expect(terms.readOnly).toBe(true);
    expect(terms.value).toBe('no');
    expect(optionValues(terms)).toEqual(['yes', 'no']);

    expect(fieldNamed(fields, 'agree')).toMatchObject({ type: 'checkbox', value: false, required: false });
  });

  it('honours a push-button flag on a generic button', () => {
    const result = collectFields([
      { fieldName: 'print', fieldType: 'button', fieldFlags: FORM_FLAG_PUSHBUTTON, page: 1, rect: [72, 72, 120, 92] },
    ]);

    expect(result.unsupported).toEqual([
      { name: 'print', widgetType: 'button', reason: 'unsupported-type', page: 1 },
    ]);
  });
});

describe('planFill: accepted values', () => {
  it('turns a matching value for every field kind into one update each', () => {
    const fields = collect([
      { fieldName: 'fullname', fieldType: 'text', fieldValue: 'An', page: 1, rect: [72, 72, 272, 92] },
      { fieldName: 'agree', fieldType: 'checkbox', page: 1, rect: [72, 110, 88, 126] },
      { fieldName: 'colour', fieldType: 'radio', fieldValue: 'red', exportValues: ['red', 'green'], page: 1, rect: [72, 150, 88, 166] },
      { fieldName: 'country', fieldType: 'choice', fieldValue: 'vn', options: ['vn', 'sg'], page: 1, rect: [72, 190, 220, 210] },
    ]);

    const plan = planFill(fields, { fullname: 'Binh', agree: true, colour: 'green', country: 'sg' });

    expect(plan.conflicts).toEqual([]);
    expect(plan.missing).toEqual([]);
    expect(plan.updates.map(update => [update.name, update.value])).toEqual([
      ['fullname', 'Binh'],
      ['agree', true],
      ['colour', 'green'],
      ['country', 'sg'],
    ]);
    expect(plan.updates[0]).toMatchObject({ type: 'text', page: 1, rect: rect(72, 72, 200, 20) });
    expect(plan.updates[1]).toMatchObject({ type: 'checkbox', value: true });
  });

  it('accepts an empty string as clearing a text field', () => {
    const fields = collect([{ fieldName: 'note', fieldType: 'text', fieldValue: 'old', page: 1, rect: [72, 72, 272, 92] }]);

    const plan = planFill(fields, { note: '' });

    expect(plan.updates).toEqual([{ name: 'note', type: 'text', value: '', page: 1, rect: rect(72, 72, 200, 20) }]);
    expect(plan.conflicts).toEqual([]);
  });

  it('does not mutate the field list it plans against', () => {
    const fields = collect([{ fieldName: 'fullname', fieldType: 'text', fieldValue: 'An', page: 1, rect: [72, 72, 272, 92] }]);
    const before = JSON.stringify(fields);

    planFill(fields, { fullname: 'Binh' });

    expect(JSON.stringify(fields)).toBe(before);
  });
});

describe('planFill: refusals', () => {
  it('refuses a read-only field', () => {
    const fields = collect([
      { fieldName: 'locked', fieldType: 'text', fieldValue: 'x', readOnly: true, page: 1, rect: [72, 72, 272, 92] },
    ]);

    const plan = planFill(fields, { locked: 'y' });

    expect(plan.updates).toEqual([]);
    expect(plan.conflicts).toEqual([{ name: 'locked', reason: 'read-only', value: 'y' }]);
  });

  it('reports a type mismatch instead of coercing the value', () => {
    const fields = collect([
      { fieldName: 'fullname', fieldType: 'text', page: 1, rect: [72, 72, 272, 92] },
      { fieldName: 'agree', fieldType: 'checkbox', page: 1, rect: [72, 110, 88, 126] },
    ]);

    const plan = planFill(fields, { fullname: true, agree: 'yes' });

    expect(plan.updates).toEqual([]);
    expect(plan.conflicts).toEqual([
      { name: 'fullname', reason: 'type-mismatch', value: true },
      { name: 'agree', reason: 'type-mismatch', value: 'yes' },
    ]);
  });

  it('refuses a choice or radio value outside the field options', () => {
    const fields = collect([
      { fieldName: 'country', fieldType: 'choice', fieldValue: 'vn', options: ['vn', 'sg'], page: 1, rect: [72, 72, 220, 92] },
      { fieldName: 'colour', fieldType: 'radio', fieldValue: 'red', exportValues: ['red', 'green'], page: 1, rect: [72, 110, 88, 126] },
    ]);

    const plan = planFill(fields, { country: 'us', colour: 'black' });

    expect(plan.updates).toEqual([]);
    expect(plan.conflicts).toEqual([
      { name: 'country', reason: 'not-an-option', value: 'us' },
      { name: 'colour', reason: 'not-an-option', value: 'black' },
    ]);
  });

  it('accepts nothing for a radio whose options are unknown', () => {
    const fields = collect([{ fieldName: 'pick', fieldType: 'radio', page: 1, rect: [72, 72, 88, 88] }]);

    const plan = planFill(fields, { pick: 'a' });

    expect(plan.updates).toEqual([]);
    expect(plan.conflicts).toEqual([{ name: 'pick', reason: 'not-an-option', value: 'a' }]);
  });

  it('never fills a signature and lists a required one as needing a human', () => {
    const fields = collect([
      { fieldName: 'signature', fieldType: 'signature', required: true, page: 2, rect: [72, 72, 300, 140] },
    ]);

    const plan = planFill(fields, { signature: 'signed' });

    expect(plan.updates).toEqual([]);
    expect(plan.conflicts).toEqual([{ name: 'signature', reason: 'signature-not-fillable', value: 'signed' }]);
    expect(plan.missing).toEqual([
      { name: 'signature', type: 'signature', reason: 'signature', page: 2, rect: rect(72, 72, 228, 68) },
    ]);
  });

  it('refuses a value that is neither a string nor a boolean instead of ignoring it', () => {
    const fields = collect([{ fieldName: 'fullname', fieldType: 'text', page: 1, rect: [72, 72, 272, 92] }]);

    const plan = planFill(fields, { fullname: 42 as unknown as string, nickname: false });

    expect(plan.updates).toEqual([]);
    expect(plan.conflicts).toEqual([
      { name: 'fullname', reason: 'type-mismatch', value: 42 },
      { name: 'nickname', reason: 'unknown-field', value: false },
    ]);
  });

  it('reports a value for a field that does not exist', () => {
    const fields = collect([{ fieldName: 'fullname', fieldType: 'text', page: 1, rect: [72, 72, 272, 92] }]);

    const plan = planFill(fields, { nickname: 'Binh', fullname: 'An' });

    expect(plan.updates.map(update => update.name)).toEqual(['fullname']);
    expect(plan.conflicts).toEqual([{ name: 'nickname', reason: 'unknown-field', value: 'Binh' }]);
  });
});

describe('planFill: missing required fields', () => {
  const fields = (): FormField[] =>
    collect([
      { fieldName: 'title', fieldType: 'text', required: true, page: 1, rect: [72, 72, 272, 92] },
      { fieldName: 'agree', fieldType: 'checkbox', required: true, page: 1, rect: [72, 110, 88, 126] },
      { fieldName: 'colour', fieldType: 'radio', required: true, exportValues: ['red', 'green'], page: 1, rect: [72, 150, 88, 166] },
      { fieldName: 'country', fieldType: 'choice', required: true, options: ['vn', 'sg'], page: 1, rect: [72, 190, 220, 210] },
      { fieldName: 'note', fieldType: 'text', page: 1, rect: [72, 230, 272, 250] },
    ]);

  it('lists every required field that has no value, and no optional field', () => {
    const plan = planFill(fields());

    expect(plan.updates).toEqual([]);
    expect(plan.conflicts).toEqual([]);
    expect(plan.missing.map(field => [field.name, field.reason])).toEqual([
      ['title', 'no-value'],
      ['agree', 'no-value'],
      ['colour', 'no-value'],
      ['country', 'no-value'],
    ]);
  });

  it('lists nothing once every required field is filled', () => {
    const plan = planFill(fields(), { title: 'Report', agree: true, colour: 'red', country: 'vn' });

    expect(plan.missing).toEqual([]);
    expect(plan.updates).toHaveLength(4);
  });

  it('treats a whitespace-only text value as empty while still applying it', () => {
    const plan = planFill(fields(), { title: '   ' });

    expect(plan.updates.map(update => update.name)).toEqual(['title']);
    expect(plan.missing.map(field => field.name)).toEqual(['title', 'agree', 'colour', 'country']);
  });

  it('keeps a required field missing when its supplied value was refused', () => {
    const plan = planFill(fields(), { title: 'Report', agree: 'yes' });

    expect(plan.conflicts.map(conflict => conflict.name)).toEqual(['agree']);
    expect(plan.missing.map(field => field.name)).toContain('agree');
  });

  it('treats null and undefined as no value supplied', () => {
    const plan = planFill(fields(), { title: null, note: undefined });

    expect(plan.updates).toEqual([]);
    expect(plan.conflicts).toEqual([]);
    expect(plan.missing.map(field => field.name)).toContain('title');
  });
});

describe('flattenPlan', () => {
  it('lists every field and warns that interactivity and accessibility are lost', () => {
    const fields = collect([
      { fieldName: 'fullname', fieldType: 'text', fieldValue: 'An', page: 1, rect: [72, 72, 272, 92] },
      { fieldName: 'agree', fieldType: 'checkbox', page: 1, rect: [72, 110, 88, 126] },
    ]);
    const plan = planFill(fields, { agree: true });

    const flatten = flattenPlan(fields, plan);

    expect(flatten.fields.map(field => [field.name, field.value, field.updatePending])).toEqual([
      ['fullname', 'An', false],
      ['agree', true, true],
    ]);
    expect(flatten.fields[1]?.rect).toEqual(rect(72, 110, 16, 16));
    expect(flatten.warnings.map(warning => warning.code)).toEqual([
      'editability-lost',
      'accessibility-lost',
      'pending-updates',
    ]);
    expect(flatten.warnings[0]?.fields).toEqual(['fullname', 'agree']);
    expect(flatten.warnings[2]?.fields).toEqual(['agree']);
  });

  it('warns that flattening a form with a signature invalidates it', () => {
    const fields = collect([
      { fieldName: 'signature', fieldType: 'signature', page: 2, rect: [72, 72, 300, 140] },
    ]);

    const flatten = flattenPlan(fields, planFill(fields));

    expect(flatten.warnings.map(warning => warning.code)).toEqual([
      'editability-lost',
      'accessibility-lost',
      'signature-invalidated',
    ]);
    expect(flatten.warnings[2]?.fields).toEqual(['signature']);
    expect(flatten.fields[0]?.value).toBeNull();
  });

  it('warns when required values are missing and refused values were not applied', () => {
    const fields = collect([
      { fieldName: 'title', fieldType: 'text', required: true, page: 1, rect: [72, 72, 272, 92] },
      { fieldName: 'note', fieldType: 'text', page: 1, rect: [72, 110, 272, 130] },
    ]);
    const plan = planFill(fields, { note: true });

    const flatten = flattenPlan(fields, plan);

    expect(flatten.warnings.map(warning => warning.code)).toEqual([
      'editability-lost',
      'accessibility-lost',
      'missing-values',
      'conflicting-values',
    ]);
    expect(flatten.warnings[2]?.fields).toEqual(['title']);
    expect(flatten.warnings[3]?.fields).toEqual(['note']);
  });

  it('has nothing to flatten for an empty field list', () => {
    expect(flattenPlan([], planFill([]))).toEqual({ fields: [], warnings: [] });
  });
});
