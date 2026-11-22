/**
 * PDF form widgets: listing fields, planning a fill, planning a flatten (backlog items
 * H12-H13).
 *
 * A PDF form is a set of widget annotations that share field names: three widgets named
 * `size` are one radio group, a checkbox is a button whose value is on or off, a text
 * field can appear on two pages at once. Read that data naively and most of it is lost:
 * duplicate names become duplicate rows, a push button becomes a text box, a widget
 * nobody understands disappears without a trace. This module owns the honest version:
 * one field per name, every widget accounted for, and no write the reader did not ask
 * for. Flattening is the irreversible step, so it is planned and warned about before it
 * happens, never implied by a fill.
 *
 * Contract:
 * - Input is plain data in the shape pdfjs reports (`getFieldObjects()` field objects
 *   and widget annotations): no pdfjs import, no PDF bytes, no DOM. `RawFormWidget`
 *   documents every accepted member, including the aliases kept for callers that already
 *   normalised their data.
 * - Nothing is dropped silently. A widget this module cannot model — a push button, an
 *   unknown field type, a multi-select list box, a widget with no name, page or rect, or
 *   a name that contradicts the type already reported for it — is returned in
 *   `unsupported` with a machine-readable reason instead of being skipped.
 * - One field per name. Radio widgets merge into one field whose `options` are the union
 *   of their on-states, in the order reported; checkbox widgets merge to one boolean; a
 *   text field repeated on two pages keeps the first widget's page and rect. `required`
 *   and `readOnly` are the strict reading of the field: a flag or an explicit `true` on
 *   any widget wins, so a group is never editable because one widget forgot the flag.
 * - `value` is what the document currently holds, not a default. Text is a string,
 *   checkbox a boolean, radio and choice a string or `null` when nothing is selected. A
 *   signature field always has `value: null`: this module does not read, write or
 *   validate a signature, because verifying one needs its bytes and certificate chain
 *   (H13) and writing one is not a form fill.
 * - `planFill` is a plan, not an action: it never touches its input and writes nothing.
 *   A value is applied only when the field exists, is not read-only, is not a signature,
 *   and the value has the field's type; a radio or choice value must also be one of the
 *   field's known options. Everything else is reported in `conflicts`, and a required
 *   field that is still empty afterwards is reported in `missing`.
 * - `flattenPlan` describes what flattening costs before it happens. It flattens
 *   nothing: it returns the fields that would become page pixels and a documented list
 *   of warnings. A fill never flattens, and a plan with pending updates must be applied
 *   before flattening or the page can bake the old appearance.
 * - Pure and deterministic: no clock, no randomness, no DOM, no locale, no I/O. Fields
 *   come back ordered by page, top edge, left edge, then name. Updates and missing
 *   fields follow that order, and conflicts follow it too, with a value for a name that
 *   is not a field last, in the order the caller supplied it.
 * - Coordinates are page points in the reader's space: origin at the top-left corner, y
 *   growing downwards, matching `Rect` in `types.ts`. pdfjs reports widget rects in PDF
 *   user space with y growing upwards; converting that is the caller's job. A
 *   four-number rect is read as the four edges `[x0, y0, x1, y1]` and normalised to a
 *   positive width and height; no origin flip happens here.
 * - Accepted value shapes are exact: `string` for text, radio and choice, `boolean` for a
 *   checkbox. Nothing is coerced — a boolean for a text field is a conflict, not the text
 *   `"true"` — because a silently coerced value is one the reader never typed.
 */

import type { Rect } from './types';

// --- Public shape ----------------------------------------------------------

/** Widget kinds this module models. Anything else is reported in `unsupported`. */
export type FormFieldType = 'text' | 'checkbox' | 'radio' | 'choice' | 'signature';

export const FORM_FIELD_TYPES: readonly FormFieldType[] = ['text', 'checkbox', 'radio', 'choice', 'signature'];

/** PDF field flag bit 0: the field cannot be changed by a reader. */
export const FORM_FLAG_READ_ONLY = 1 << 0;

/** PDF field flag bit 1: the field must carry a value before the form is complete. */
export const FORM_FLAG_REQUIRED = 1 << 1;

/** PDF field flag bit 15: a button field is a radio group. */
export const FORM_FLAG_RADIO = 1 << 15;

/** PDF field flag bit 16: a button field is a push button, which is not a fillable field. */
export const FORM_FLAG_PUSHBUTTON = 1 << 16;

/** PDF field flag bit 21: a choice field accepts more than one selected value. */
export const FORM_FLAG_MULTI_SELECT = 1 << 21;

/** A value a fill can write: a string for text/radio/choice, a boolean for a checkbox. */
export type FormFillValue = string | boolean;

/** Current value of a field: `null` when it has none, which a signature always is. */
export type FormFieldValue = FormFillValue | null;

/** One selectable value of a radio group or a choice field. */
export interface FormFieldOption {
  /** The value a fill writes, for example a radio widget's on-state or a choice export value. */
  value: string;
  /** Display label when the PDF supplies one; absent when `value` is all there is. */
  label?: string;
}

/** One fillable field, de-duplicated by name. */
export interface FormField {
  /** Fully qualified field name, as the PDF names it. */
  name: string;
  type: FormFieldType;
  /** Current value; text is `''` and a checkbox `false` when the form leaves it empty. */
  value: FormFieldValue;
  /** True when the field is required; a required field that is still empty is `missing`. */
  required: boolean;
  /**
   * Options of a radio group or choice, in the order the widgets reported them. Present
   * — possibly empty — on those two kinds only; a radio or choice with no known option
   * accepts no fill, because guessing a value the widgets may not carry is worse.
   */
  options?: FormFieldOption[];
  /** Box of the first widget reported for this name, in reader page space. */
  rect: Rect;
  /** 1-based page of that first widget. */
  page: number;
  /** True when the PDF marks the field read-only; such a field is never filled. */
  readOnly: boolean;
}

/**
 * One widget as plain data, in pdfjs's vocabulary. Every member is `unknown` because
 * this is untrusted input and each reader validates what it needs.
 */
export interface RawFormWidget {
  /** pdfjs field name. `name` is accepted for callers that already normalised the data. */
  fieldName?: unknown;
  name?: unknown;
  /**
   * pdfjs field type: the long names (`text`, `checkbox`, `radiobutton`, `combobox`,
   * `listbox`, `signature`, `pushbutton`) or the short `/FT` codes (`Tx`, `Btn`, `Ch`,
   * `Sig`), case and separators being insignificant.
   */
  fieldType?: unknown;
  /** The widget's button kind when the caller has it: `checkbox`, `radio` or `pushbutton`. */
  buttonType?: unknown;
  /** PDF `/V` as the caller reports it: a string, a boolean, or an array for a list box. */
  fieldValue?: unknown;
  /** On-state of this widget, pdfjs's `exportValue`; the value a radio fill writes. */
  exportValue?: unknown;
  /** Alias for `exportValue`. */
  buttonValue?: unknown;
  /**
   * Values the field accepts, one per option. pdfjs may put the field's `/Opt` display
   * values here; when those differ from the widgets' on-states, pass `options` entries
   * with `value` (the on-state a fill writes) and `label` (the display text) instead.
   */
  exportValues?: unknown;
  /** Alias for `exportValues`; takes precedence when both are arrays. */
  options?: unknown;
  /** True when a call reports this widget as checked; otherwise `fieldValue` decides. */
  checked?: unknown;
  /** PDF `/Ff` bits; `FORM_FLAG_*` names the ones this module reads. */
  fieldFlags?: unknown;
  /** Explicit read-only flag, honoured alongside {@link FORM_FLAG_READ_ONLY}. */
  readOnly?: unknown;
  /** Explicit required flag, honoured alongside {@link FORM_FLAG_REQUIRED}. */
  required?: unknown;
  /** 1-based page the widget is drawn on. */
  page?: unknown;
  /** `Rect` in reader space, or the four edges `[x0, y0, x1, y1]` pdfjs reports. */
  rect?: unknown;
}

/** Why a widget could not become a `FormField`. */
export type UnsupportedWidgetReason =
  /** A push button, or a field type this build does not model. */
  | 'unsupported-type'
  /** The widget had no usable field name, so nothing can address it. */
  | 'missing-name'
  /** The widget had no 1-based page number. */
  | 'missing-page'
  /** The widget's rect was absent or not four finite numbers. */
  | 'invalid-rect'
  /** `fieldType` and `buttonType` disagree, or a later widget reuses a name with another type. */
  | 'type-conflict'
  /** A choice that accepts several values; this build models one value per field. */
  | 'multi-select-value'
  /** The entry was not an object at all. */
  | 'invalid-widget';

/** A widget that was reported instead of being turned into a field. */
export interface UnsupportedWidget {
  /** Field name when the widget had one; `''` otherwise. */
  name: string;
  /** The type as the caller wrote it, trimmed; `''` when absent or not a string. */
  widgetType: string;
  reason: UnsupportedWidgetReason;
  /** 1-based page when it could be read; `null` when it could not. */
  page: number | null;
}

export interface CollectFieldsResult {
  /** Fillable fields, sorted by page, top, left, then name. */
  fields: FormField[];
  /** Widgets that could not be modelled, in input order. */
  unsupported: UnsupportedWidget[];
}

/** Values a caller wants to write, keyed by field name. `null`/`undefined` means none. */
export type FormFillValues = Readonly<Record<string, FormFillValue | null | undefined>>;

/** Why a supplied value was not turned into an update. */
export type FillConflictReason =
  /** No field has that name. */
  | 'unknown-field'
  /** The field is read-only. */
  | 'read-only'
  /** The value's JavaScript type is not the field's type. */
  | 'type-mismatch'
  /** A radio or choice value that is not one of the field's known options. */
  | 'not-an-option'
  /** A signature is never filled programmatically. */
  | 'signature-not-fillable';

/** One value to write, with the geometry of the field's first widget. */
export interface FillUpdate {
  name: string;
  type: FormFieldType;
  /** The exact value to write: a string, or a boolean for a checkbox. */
  value: FormFillValue;
  page: number;
  rect: Rect;
}

/** Why a required field is still empty after the plan. */
export type MissingFieldReason =
  /** Nothing supplied a value, or the field's current value is empty. */
  | 'no-value'
  /** The field is a signature: only a human can complete it. */
  | 'signature';

/** A required field the plan leaves empty. */
export interface MissingField {
  name: string;
  type: FormFieldType;
  reason: MissingFieldReason;
  page: number;
  rect: Rect;
}

/** A supplied value that was refused, with what was supplied. */
export interface FillConflict {
  name: string;
  reason: FillConflictReason;
  /** The value the caller supplied, verbatim, whatever its type. */
  value: unknown;
}

/** What to write, what is still missing, and what was refused. */
export interface FormFillPlan {
  /** Accepted values, in field order. Apply these; the plan does not. */
  updates: FillUpdate[];
  /** Required fields that are still empty after the accepted updates. */
  missing: MissingField[];
  /** Supplied values that were not applied, with the reason. */
  conflicts: FillConflict[];
}

/** What flattening costs, one code per kind of loss. */
export type FlattenWarningCode =
  /**
   * The listed widgets become page pixels: their values can no longer be typed,
   * checked, chosen, or exported from the flattened file.
   */
  | 'editability-lost'
  /**
   * The widgets stop being form controls, so assistive technology sees static content
   * and their labels, required state and grouping are gone.
   */
  | 'accessibility-lost'
  /**
   * A signature field is present. Flattening rewrites the page content, which
   * invalidates any signature that covers those pages.
   */
  | 'signature-invalidated'
  /**
   * The plan still holds updates. Flattening now bakes whatever appearance the widgets
   * carry, so apply the plan first or the page keeps the old values.
   */
  | 'pending-updates'
  /** Required fields the plan leaves empty; the flattened form freezes that gap. */
  | 'missing-values'
  /** Values the plan refused; the flattened form freezes the refused attempt. */
  | 'conflicting-values';

/** One documented loss a caller must show before flattening. */
export interface FlattenWarning {
  code: FlattenWarningCode;
  /** Field names the warning is about; never empty, so the caller can point at them. */
  fields: string[];
}

/** A field that flattening would turn into page pixels. */
export interface FlattenField {
  name: string;
  type: FormFieldType;
  page: number;
  rect: Rect;
  /** What the page would show: the planned update when there is one, else the current value. */
  value: FormFieldValue;
  /** True when this value comes from `plan.updates` and has not necessarily been applied. */
  updatePending: boolean;
}

/** What flattening would touch and what it would cost. */
export interface FormFlattenPlan {
  /** Fields that would be flattened, in field order. */
  fields: FlattenField[];
  /** Documented losses, in the order the codes are declared; empty when there is nothing to flatten. */
  warnings: FlattenWarning[];
}

// --- Reading widgets -------------------------------------------------------

/**
 * Turns pdfjs-style widget annotations into fillable fields.
 *
 * The result has one field per name. A radio group is one field whose `options` union
 * every widget's on-state; a checked widget decides the selected `value`. Checkbox
 * widgets merge to one boolean, and a repeated text or choice field keeps the first
 * widget's page, rect and non-empty value.
 *
 * A widget this module cannot model is not skipped: it is returned in `unsupported`
 * with a reason, including a push button, an unknown `fieldType`, a multi-select list
 * box, a missing name/page/rect, and a later widget that reuses a name with a different
 * type (the first field is kept). `fieldType` decides the kind; `buttonType` and the PDF
 * flags only classify a widget whose `fieldType` is absent or the generic `Btn`/`button`.
 * When `fieldType` and `buttonType` disagree the widget is reported as a type conflict
 * rather than guessed.
 *
 * Throws a `TypeError` when `annotations` is not an array; individual malformed entries
 * are reported, not thrown on.
 */
export function collectFields(annotations: readonly RawFormWidget[]): CollectFieldsResult {
  if (!Array.isArray(annotations)) {
    throw new TypeError('collectFields needs an array of widgets (pdfjs annotation data).');
  }

  const fields: FormField[] = [];
  const unsupported: UnsupportedWidget[] = [];
  const byName = new Map<string, PendingField>();

  for (const raw of annotations) {
    if (!isRecord(raw)) {
      unsupported.push({ name: '', widgetType: '', reason: 'invalid-widget', page: null });
      continue;
    }

    const name = trimmedOf(raw.fieldName) ?? trimmedOf(raw.name);
    const page = readPage(raw.page);
    const rect = readRectValue(raw.rect);
    const reading = readType(raw);
    const widgetType = reading.declared;

    if (name === undefined) {
      unsupported.push({ name: '', widgetType, reason: 'missing-name', page: page ?? null });
      continue;
    }
    if (reading.pushbutton) {
      unsupported.push({ name, widgetType, reason: 'unsupported-type', page: page ?? null });
      continue;
    }
    if (reading.contradiction) {
      unsupported.push({ name, widgetType, reason: 'type-conflict', page: page ?? null });
      continue;
    }
    if (reading.type === undefined) {
      unsupported.push({ name, widgetType, reason: 'unsupported-type', page: page ?? null });
      continue;
    }
    if (page === undefined) {
      unsupported.push({ name, widgetType, reason: 'missing-page', page: null });
      continue;
    }
    if (rect === undefined) {
      unsupported.push({ name, widgetType, reason: 'invalid-rect', page });
      continue;
    }

    const type = reading.type;
    const flags = readFlags(raw.fieldFlags);
    if (type === 'choice' && (flags & FORM_FLAG_MULTI_SELECT) !== 0) {
      unsupported.push({ name, widgetType, reason: 'multi-select-value', page });
      continue;
    }

    const value = readFieldValue(raw, type);
    if (value === MULTI_SELECT) {
      unsupported.push({ name, widgetType, reason: 'multi-select-value', page });
      continue;
    }

    const readOnly = raw.readOnly === true || (flags & FORM_FLAG_READ_ONLY) !== 0;
    const required = raw.required === true || (flags & FORM_FLAG_REQUIRED) !== 0;
    const existing = byName.get(name);

    if (existing !== undefined && existing.field.type !== type) {
      unsupported.push({ name, widgetType, reason: 'type-conflict', page });
      continue;
    }

    if (existing === undefined) {
      const field: FormField = {
        name,
        type,
        value: initialValue(type),
        required,
        rect: { ...rect },
        page,
        readOnly,
      };
      if (type === 'radio' || type === 'choice') field.options = [];
      const pending: PendingField = { field, options: new Map() };
      // The first widget's value is the field's value; `applyValue` handles later ones.
      applyValue(field, value);
      collectOptions(pending.options, raw, type);
      byName.set(name, pending);
      fields.push(field);
      continue;
    }

    const { field, options } = existing;
    field.required = field.required || required;
    field.readOnly = field.readOnly || readOnly;
    collectOptions(options, raw, type);
    applyValue(field, value);
  }

  for (const { field, options } of byName.values()) {
    if (field.type !== 'radio' && field.type !== 'choice') continue;
    // A selected value the widget list does not declare is kept as an option: losing the
    // current state would be worse than showing an option the PDF failed to list.
    if (typeof field.value === 'string' && field.value.length > 0 && !options.has(field.value)) {
      options.set(field.value, { value: field.value });
    }
    field.options = [...options.values()];
  }

  fields.sort(compareFields);
  return { fields, unsupported };
}

// --- Planning a fill -------------------------------------------------------

/**
 * Plans a fill without performing it.
 *
 * `values` is keyed by field name. `null` and `undefined` mean "no value supplied", so a
 * required field stays missing; an empty string is a value, and a text field can be
 * cleared with it. Each other value is checked against its field, in this order:
 *
 * 1. The name must belong to a field, otherwise the value is an `unknown-field` conflict.
 * 2. A signature is never filled: `signature-not-fillable`, even when it is read-only,
 *    because no caller action can change that.
 * 3. A read-only field is refused as `read-only`.
 * 4. The value's type must be the field's type (`string` for text/radio/choice,
 *    `boolean` for a checkbox); anything else — including a number or `null`-like
 *    object — is a `type-mismatch`, never a coercion and never a silent skip.
 * 5. A radio or choice value must be one of the field's `options`; with no known option
 *    the field accepts nothing and the value is `not-an-option`.
 *
 * Accepted values become `updates` in field order. Then every required field is checked
 * against its effective value — the update when there is one, else the current value —
 * and an empty one is listed in `missing`, with `reason: 'signature'` for a signature
 * and `'no-value'` otherwise. An unchecked checkbox and an unselected radio or choice are
 * empty: a required checkbox the reader did not tick is not complete.
 *
 * Nothing supplied is dropped silently. A value that is neither a string nor a boolean
 * is refused as a `type-mismatch` for a known field, and as `unknown-field` when no field
 * has that name; `undefined` and `null` are the only values read as "no value supplied".
 * A name repeated in `fields` is read once, from the first entry. The input fields are
 * not mutated.
 */
export function planFill(fields: readonly FormField[], values: FormFillValues = {}): FormFillPlan {
  if (!Array.isArray(fields)) {
    throw new TypeError('planFill needs the field list returned by collectFields.');
  }
  const supplied: Readonly<Record<string, unknown>> = isRecord(values) ? values : {};

  const updates: FillUpdate[] = [];
  const conflicts: FillConflict[] = [];
  const byName = new Map<string, FormField>();

  for (const field of fields) {
    if (typeof field !== 'object' || field === null) continue;
    if (typeof field.name !== 'string' || byName.has(field.name)) continue;
    byName.set(field.name, field);

    if (!hasOwn(supplied, field.name)) continue;
    const raw = supplied[field.name];
    if (raw === undefined || raw === null) continue;

    const outcome = checkFill(field, raw);
    if ('update' in outcome) updates.push(outcome.update);
    else conflicts.push(outcome.conflict);
  }

  // A value for a name no field carries is a conflict, whatever its type: the caller
  // believes there is a field there and silently ignoring it would hide a bad mapping.
  for (const name of Object.keys(supplied)) {
    const raw = supplied[name];
    if (raw === undefined || raw === null) continue;
    if (byName.has(name)) continue;
    conflicts.push({ name, reason: 'unknown-field', value: raw });
  }

  const planned = new Map<string, FormFillValue>();
  for (const update of updates) planned.set(update.name, update.value);

  const missing: MissingField[] = [];
  for (const field of byName.values()) {
    if (field.required !== true) continue;
    const value = planned.has(field.name) ? planned.get(field.name) : field.value;
    if (!isEmptyValue(field.type, value)) continue;
    missing.push({
      name: field.name,
      type: field.type,
      reason: field.type === 'signature' ? 'signature' : 'no-value',
      page: field.page,
      rect: { ...field.rect },
    });
  }

  return { updates, missing, conflicts };
}

// --- Planning a flatten ----------------------------------------------------

/**
 * Describes what flattening would do, before it is done.
 *
 * Every listed field becomes page pixels, so the plan names them in field order with the
 * value the page would show — the planned update when `plan` holds one, else the field's
 * current value — and marks whether that value is still pending. The warnings are the
 * documented losses:
 *
 * - `editability-lost`: the widgets can no longer be typed into, checked, chosen or
 *   exported from the flattened file.
 * - `accessibility-lost`: they are no longer form controls for assistive technology.
 * - `signature-invalidated`: a signature field is present, and rewriting the page
 *   invalidates any signature covering it (H13).
 * - `pending-updates`: `plan.updates` is not empty; flattening now bakes the current
 *   appearance, so apply the plan first.
 * - `missing-values`: required fields the plan leaves empty are frozen as a gap.
 * - `conflicting-values`: values the plan refused are frozen as the old value.
 *
 * A widget that `collectFields` reported in `unsupported` is also removed by flattening
 * without appearing here, because this plan only sees fields: warn the reader about
 * those separately.
 *
 * Nothing is flattened and no input is mutated. An empty field list returns an empty
 * plan: there is no interactivity to lose.
 */
export function flattenPlan(
  fields: readonly FormField[],
  plan: FormFillPlan = { updates: [], missing: [], conflicts: [] },
): FormFlattenPlan {
  if (!Array.isArray(fields)) {
    throw new TypeError('flattenPlan needs the field list returned by collectFields.');
  }
  const updates = Array.isArray(plan?.updates) ? plan.updates : [];
  const pending = new Map<string, FormFillValue>();
  for (const update of updates) {
    if (typeof update !== 'object' || update === null || typeof update.name !== 'string') continue;
    if (typeof update.value === 'string' || typeof update.value === 'boolean') {
      pending.set(update.name, update.value);
    }
  }

  const flattened: FlattenField[] = [];
  const seen = new Set<string>();
  for (const field of fields) {
    if (typeof field !== 'object' || field === null) continue;
    if (typeof field.name !== 'string' || seen.has(field.name)) continue;
    seen.add(field.name);
    const isPending = pending.has(field.name);
    const value = isPending ? pending.get(field.name) : field.value;
    flattened.push({
      name: field.name,
      type: field.type,
      page: field.page,
      rect: { ...field.rect },
      value: value ?? null,
      updatePending: isPending,
    });
  }

  if (flattened.length === 0) return { fields: [], warnings: [] };

  const names = flattened.map(field => field.name);
  const signatures = flattened.filter(field => field.type === 'signature').map(field => field.name);
  const warnings: FlattenWarning[] = [
    { code: 'editability-lost', fields: names },
    { code: 'accessibility-lost', fields: names },
  ];
  if (signatures.length > 0) {
    warnings.push({ code: 'signature-invalidated', fields: signatures });
  }
  if (pending.size > 0) {
    warnings.push({ code: 'pending-updates', fields: [...pending.keys()] });
  }

  const missing = Array.isArray(plan?.missing)
    ? plan.missing.map(entry => (isRecord(entry) ? entry.name : undefined)).filter(isText)
    : [];
  if (missing.length > 0) warnings.push({ code: 'missing-values', fields: missing });

  const conflicted = Array.isArray(plan?.conflicts)
    ? plan.conflicts.map(entry => (isRecord(entry) ? entry.name : undefined)).filter(isText)
    : [];
  if (conflicted.length > 0) warnings.push({ code: 'conflicting-values', fields: conflicted });

  return { fields: flattened, warnings };
}

// --- Field classification -------------------------------------------------

type DeclaredType = FormFieldType | 'button' | 'pushbutton';

interface TypeReading {
  /** The modelled type, when the widget has one this build understands. */
  type?: FormFieldType;
  /** True when the widget is a push button: a control, not a fillable field. */
  pushbutton: boolean;
  /** True when `fieldType` and `buttonType` name different kinds. */
  contradiction: boolean;
  /** The type as the caller wrote it, for an `unsupported` entry. */
  declared: string;
}

/** The type names this module understands, normalised to lowercase without separators. */
const TYPE_NAMES: Readonly<Record<string, DeclaredType>> = {
  text: 'text',
  tx: 'text',
  checkbox: 'checkbox',
  radio: 'radio',
  radiobutton: 'radio',
  choice: 'choice',
  ch: 'choice',
  combobox: 'choice',
  listbox: 'choice',
  signature: 'signature',
  sig: 'signature',
  button: 'button',
  btn: 'button',
  pushbutton: 'pushbutton',
};

/**
 * Classifies one widget.
 *
 * `fieldType` decides when it names a kind. `buttonType` and the PDF flags classify only
 * a widget whose `fieldType` is absent or the generic `Btn`/`button`; for a generic
 * button without a button type, the PDF default is a checkbox unless the radio or push
 * button flag is set.
 */
function readType(raw: RawFormWidget): TypeReading {
  const declaredText = trimmedOf(raw.fieldType) ?? '';
  const buttonText = trimmedOf(raw.buttonType) ?? '';
  const declared = declaredText.length > 0 ? TYPE_NAMES[typeKey(declaredText)] : undefined;
  const button = buttonText.length > 0 ? TYPE_NAMES[typeKey(buttonText)] : undefined;
  const flags = readFlags(raw.fieldFlags);
  const declaredLabel = declaredText.length > 0 ? declaredText : buttonText;

  if (declared === 'pushbutton') return { pushbutton: true, contradiction: false, declared: declaredLabel };
  if (declared === 'signature') return { type: 'signature', pushbutton: false, contradiction: false, declared: declaredLabel };
  if (declared !== undefined && declared !== 'button') {
    const contradicts = button !== undefined && button !== 'button' && button !== declared;
    return { type: declared, pushbutton: false, contradiction: contradicts, declared: declaredLabel };
  }

  if (button === 'pushbutton') return { pushbutton: true, contradiction: false, declared: declaredLabel };
  if (button === 'radio' || button === 'checkbox') {
    return { type: button, pushbutton: false, contradiction: false, declared: declaredLabel };
  }

  if (declared === 'button') {
    if ((flags & FORM_FLAG_PUSHBUTTON) !== 0) return { pushbutton: true, contradiction: false, declared: declaredLabel };
    if ((flags & FORM_FLAG_RADIO) !== 0) {
      return { type: 'radio', pushbutton: false, contradiction: false, declared: declaredLabel };
    }
    return { type: 'checkbox', pushbutton: false, contradiction: false, declared: declaredLabel };
  }

  return { pushbutton: false, contradiction: false, declared: declaredLabel };
}

/** Lowercase and drop whitespace, `-` and `_`, so `radio-button` and `RadioButton` agree. */
function typeKey(value: string): string {
  return value.toLowerCase().replace(/[\s_-]+/gu, '');
}

// --- Field state -----------------------------------------------------------

/** The value a field starts with before any widget reports one. */
function initialValue(type: FormFieldType): FormFieldValue {
  if (type === 'text') return '';
  if (type === 'checkbox') return false;
  return null;
}

/** Merges one widget's value into a field without letting a later widget clear it. */
function applyValue(field: FormField, value: FormFieldValue): void {
  if (field.type === 'signature') return;
  if (field.type === 'checkbox') {
    if (value === true) field.value = true;
    return;
  }
  if (field.type === 'text') {
    if (field.value === '' && typeof value === 'string') field.value = value;
    return;
  }
  if (field.value === null && typeof value === 'string' && value.length > 0) field.value = value;
}

/** Collects the options one widget contributes to its field. */
function collectOptions(into: Map<string, FormFieldOption>, raw: RawFormWidget, type: FormFieldType): void {
  if (type !== 'radio' && type !== 'choice') return;
  for (const option of readOptions(raw)) addOption(into, option);
  if (type === 'radio') {
    const on = onStateOf(raw);
    if (on !== undefined) addOption(into, { value: on });
  }
}

/** Adds an option without losing a label a later widget supplies for the same value. */
function addOption(into: Map<string, FormFieldOption>, option: FormFieldOption): void {
  const current = into.get(option.value);
  if (current === undefined) {
    into.set(option.value, option);
    return;
  }
  if (current.label === undefined && option.label !== undefined) {
    into.set(option.value, { value: option.value, label: option.label });
  }
}

/** A pending field and its option table, before options are frozen into the field. */
interface PendingField {
  field: FormField;
  options: Map<string, FormFieldOption>;
}

/**
 * Reads the current value of one widget. A multi-select choice is returned as the
 * {@link MULTI_SELECT} sentinel; a caller that cannot tell must not truncate the value.
 */
function readFieldValue(raw: RawFormWidget, type: FormFieldType): FormFieldValue | typeof MULTI_SELECT {
  if (type === 'text') return stringOf(raw.fieldValue) ?? '';
  if (type === 'checkbox') return readChecked(raw);
  if (type === 'signature') return null;
  if (type === 'radio') return readRadioValue(raw);
  return readChoiceValue(raw.fieldValue);
}

/** Sentinel for a choice that holds more than one value. */
const MULTI_SELECT = Symbol('multi-select');

/**
 * Reads a checkbox.
 *
 * An explicit `checked` boolean wins. Otherwise a boolean `fieldValue` is itself, a
 * number is checked when non-zero, and a string is checked unless it is empty or the
 * PDF's off state `Off` (case-insensitive), because the off state is what a PDF writes
 * for a button nobody ticked.
 */
function readChecked(raw: RawFormWidget): boolean {
  if (typeof raw.checked === 'boolean') return raw.checked;
  const value = raw.fieldValue;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) && value !== 0;
  if (typeof value === 'string') return !isOffState(value);
  return false;
}

/**
 * Reads a radio group's selected on-state.
 *
 * A checked widget names its own on-state (`exportValue`, `buttonValue`, or the value it
 * reports); otherwise the shared `fieldValue` may already carry the selection, which is
 * what pdfjs reports for every widget of a group.
 */
function readRadioValue(raw: RawFormWidget): string | null {
  if (raw.checked === true) return onStateOf(raw) ?? radioValueOf(raw.fieldValue);
  return radioValueOf(raw.fieldValue);
}

/** Reads a choice's single value, or reports that it holds several. */
function readChoiceValue(value: unknown): string | null | typeof MULTI_SELECT {
  if (Array.isArray(value)) {
    if (value.length > 1) return MULTI_SELECT;
    return value.length === 0 ? null : stringOf(value[0]) ?? null;
  }
  return stringOf(value) ?? null;
}

/** A field's value with nothing selected read as `null`, and an empty string as `null`. */
function radioValueOf(value: unknown): string | null {
  const text = stringOf(value);
  return text === undefined || isOffState(text) ? null : text;
}

/** One widget's on-state, ignoring the PDF off state. */
function onStateOf(raw: RawFormWidget): string | undefined {
  const on = trimmedOf(raw.exportValue) ?? trimmedOf(raw.buttonValue);
  return on !== undefined && !isOffState(on) ? on : undefined;
}

/** True for the PDF off-state name and the empty string. */
function isOffState(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length === 0 || trimmed.toLowerCase() === 'off';
}

/** Reads the options one widget reports, from `options` or pdfjs's `exportValues`. */
function readOptions(raw: RawFormWidget): FormFieldOption[] {
  const source = Array.isArray(raw.options) ? raw.options : raw.exportValues;
  if (!Array.isArray(source)) return [];
  const options: FormFieldOption[] = [];
  for (const entry of source) {
    const option = readOption(entry);
    if (option !== undefined) options.push(option);
  }
  return options;
}

/** Reads one option: a bare value, or `{ value, label }`/pdfjs `{ exportValue, displayValue }`. */
function readOption(entry: unknown): FormFieldOption | undefined {
  if (typeof entry === 'string') {
    return entry.trim().length > 0 ? { value: entry } : undefined;
  }
  if (!isRecord(entry)) return undefined;
  const value = firstText(entry.value, entry.exportValue, entry.displayValue, entry.label);
  if (value === undefined || value.trim().length === 0) return undefined;
  const label = trimmedOf(entry.label) ?? trimmedOf(entry.displayValue);
  return label !== undefined && label.length > 0 && label !== value ? { value, label } : { value };
}

// --- Field checks ----------------------------------------------------------

/** Checks one value against one field. */
function checkFill(field: FormField, value: unknown): { update: FillUpdate } | { conflict: FillConflict } {
  const geometry = { name: field.name, type: field.type, page: field.page, rect: { ...field.rect } };
  const refuse = (reason: FillConflictReason): { conflict: FillConflict } => ({
    conflict: { name: field.name, reason, value },
  });

  // A signature is permanently unfillable, so that reason wins over read-only: nothing a
  // caller can change would make the write possible.
  if (field.type === 'signature') return refuse('signature-not-fillable');
  if (field.readOnly === true) return refuse('read-only');

  if (field.type === 'text') {
    if (typeof value !== 'string') return refuse('type-mismatch');
    return { update: { ...geometry, value } };
  }
  if (field.type === 'checkbox') {
    if (typeof value !== 'boolean') return refuse('type-mismatch');
    return { update: { ...geometry, value } };
  }
  if (typeof value !== 'string') return refuse('type-mismatch');
  if (!isOption(field, value)) return refuse('not-an-option');
  return { update: { ...geometry, value } };
}

/** True when `value` is one of the field's known options. */
function isOption(field: FormField, value: string): boolean {
  return Array.isArray(field.options) && field.options.some(option => isRecord(option) && option.value === value);
}

/** True when a field's effective value counts as empty. */
function isEmptyValue(type: FormFieldType, value: FormFieldValue | undefined): boolean {
  if (type === 'signature') return true;
  if (type === 'checkbox') return value !== true;
  if (typeof value !== 'string') return true;
  return value.trim().length === 0;
}

// --- Readers ---------------------------------------------------------------

/** Reads a 1-based page number. */
function readPage(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : undefined;
}

/**
 * Reads a widget rect: an object with finite, non-negative dimensions, or the four edges
 * `[x0, y0, x1, y1]` normalised to a positive box. No origin flip is done here.
 */
function readRectValue(value: unknown): Rect | undefined {
  if (Array.isArray(value)) {
    if (value.length < 4) return undefined;
    const x0 = readNumber(value[0]);
    const y0 = readNumber(value[1]);
    const x1 = readNumber(value[2]);
    const y1 = readNumber(value[3]);
    if (x0 === undefined || y0 === undefined || x1 === undefined || y1 === undefined) return undefined;
    return {
      x: Math.min(x0, x1),
      y: Math.min(y0, y1),
      width: Math.abs(x1 - x0),
      height: Math.abs(y1 - y0),
    };
  }
  if (!isRecord(value)) return undefined;
  const x = readNumber(value.x);
  const y = readNumber(value.y);
  const width = readNumber(value.width);
  const height = readNumber(value.height);
  if (x === undefined || y === undefined || width === undefined || height === undefined) return undefined;
  if (width < 0 || height < 0) return undefined;
  return { x, y, width, height };
}

/** Reads the PDF field flags as an integer; anything else reads as no flags. */
function readFlags(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : 0;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function trimmedOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** The first of the given values that is a non-empty string. */
function firstText(...values: readonly unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return undefined;
}

function isText(value: unknown): value is string {
  return typeof value === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(record: Readonly<Record<string, unknown>>, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, field);
}

function compareFields(left: FormField, right: FormField): number {
  return (
    left.page - right.page ||
    left.rect.y - right.rect.y ||
    left.rect.x - right.rect.x ||
    compareText(left.name, right.name)
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
