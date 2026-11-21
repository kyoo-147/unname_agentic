/**
 * H13: Real `pdf-lib` AcroForm inspection, filling, JSON export, and flattening.
 *
 * Composes with `src/core/forms.ts` (`collectFields`, `planFill`, `flattenPlan`) and
 * `src/export/fonts.ts` (`registerPdfFonts`) so real PDF forms can be inspected without
 * mutating documents lacking `/AcroForm`, filled with Unicode (including Vietnamese via
 * Noto Sans), exported as deterministic JSON, and flattened with explicit loss warnings.
 */

import {
  PDFArray,
  PDFButton,
  PDFCheckBox,
  PDFDict,
  PDFDocument,
  PDFDropdown,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFOptionList,
  PDFPage,
  PDFRadioGroup,
  PDFRef,
  PDFSignature,
  PDFStream,
  PDFString,
  PDFTextField,
  type PDFField,
  type PDFForm,
  type PDFWidgetAnnotation,
} from 'pdf-lib';
import {
  collectFields,
  flattenPlan,
  planFill,
  type FillUpdate,
  type FlattenField,
  type FlattenWarningCode,
  type FormField,
  type FormFieldOption,
  type FormFieldValue,
  type FormFillPlan,
  type FormFillValues,
  type FormFlattenPlan,
  type RawFormWidget,
  type UnsupportedWidget,
} from '../core/forms';
import { registerPdfFonts, type PdfFontSet, type PdfFontsOptions } from './fonts';

// --- Public types ----------------------------------------------------------

export type PdfFormWarningCode =
  | FlattenWarningCode
  | 'no-form-fields'
  | 'read-only-field'
  | 'signature-field'
  | 'signature-not-fillable'
  | 'xfa-unsupported'
  | 'unsupported-widgets'
  | 'font-fallback';

export interface PdfFormWarning {
  code: PdfFormWarningCode;
  fields: string[];
  message: string;
}

export interface PdfFormInspectionResult {
  hasForm: boolean;
  hasXfa: boolean;
  fields: FormField[];
  unsupported: UnsupportedWidget[];
  readOnlyFields: string[];
  signatureFields: string[];
  warnings: PdfFormWarning[];
}

export interface FillPdfFormOptions {
  fonts?: PdfFontsOptions;
  flatten?: boolean;
}

export interface FillPdfFormResult {
  bytes: Uint8Array;
  hasForm: boolean;
  hasXfa: boolean;
  flattened: boolean;
  fields: FormField[];
  applied: FillUpdate[];
  plan: FormFillPlan;
  flattenPlan: FormFlattenPlan | null;
  unsupported: UnsupportedWidget[];
  readOnlyFields: string[];
  signatureFields: string[];
  warnings: PdfFormWarning[];
}

export interface FlattenPdfFormOptions {
  fonts?: PdfFontsOptions;
}

export interface FlattenPdfFormResult {
  bytes: Uint8Array;
  hasForm: boolean;
  hasXfa: boolean;
  flattened: boolean;
  flattenedFields: FlattenField[];
  plan: FormFlattenPlan | null;
  unsupported: UnsupportedWidget[];
  readOnlyFields: string[];
  signatureFields: string[];
  warnings: PdfFormWarning[];
}

export interface PdfFormDataExport {
  version: 1;
  hasForm: boolean;
  hasXfa: boolean;
  fieldCount: number;
  values: Record<string, FormFieldValue>;
  fields: FormField[];
  unsupported: UnsupportedWidget[];
  warnings: PdfFormWarning[];
}

export interface ExportPdfFormJsonOptions {
  pretty?: boolean;
  indent?: number;
}

// --- Document loading and page geometry helpers ----------------------------

async function asPdfDocument(src: PDFDocument | Uint8Array): Promise<PDFDocument> {
  if (src instanceof Uint8Array) {
    return PDFDocument.load(src, { updateMetadata: false, ignoreEncryption: true });
  }
  return src;
}

interface PageLookup {
  pages: PDFPage[];
  pageRefToNumber: Map<PDFRef, number>;
  annotRefToPageNumber: Map<PDFRef, number>;
}

function buildPageLookup(doc: PDFDocument): PageLookup {
  const pages = doc.getPages();
  const pageRefToNumber = new Map<PDFRef, number>();
  const annotRefToPageNumber = new Map<PDFRef, number>();

  pages.forEach((page, index) => {
    const pageNumber = index + 1;
    pageRefToNumber.set(page.ref, pageNumber);
    const annots = page.node.Annots();
    if (!annots) return;
    for (let idx = 0; idx < annots.size(); idx += 1) {
      const entry = annots.get(idx);
      if (entry instanceof PDFRef) {
        annotRefToPageNumber.set(entry, pageNumber);
      }
    }
  });

  return { pages, pageRefToNumber, annotRefToPageNumber };
}

function resolveWidgetPageNumber(
  doc: PDFDocument,
  field: PDFField,
  widget: PDFWidgetAnnotation,
  widgetCount: number,
  lookup: PageLookup,
): number | undefined {
  const pRef = widget.P();
  if (pRef) {
    const byP = lookup.pageRefToNumber.get(pRef);
    if (byP !== undefined) return byP;
  }

  const widgetRef = doc.context.getObjectRef(widget.dict);
  if (widgetRef) {
    const byAnnot = lookup.annotRefToPageNumber.get(widgetRef);
    if (byAnnot !== undefined) return byAnnot;
  }

  if (widgetCount === 1) {
    const byFieldRef = lookup.annotRefToPageNumber.get(field.ref);
    if (byFieldRef !== undefined) return byFieldRef;
  }

  return undefined;
}

function readWidgetReaderRect(
  widget: PDFWidgetAnnotation,
  page: PDFPage | undefined,
): { x: number; y: number; width: number; height: number } | undefined {
  if (!page) return undefined;
  const rectArray = widget.dict.lookupMaybe(PDFName.of('Rect'), PDFArray);
  if (!rectArray || rectArray.size() < 4) return undefined;

  const x0 = rectArray.lookupMaybe(0, PDFNumber)?.asNumber();
  const y0 = rectArray.lookupMaybe(1, PDFNumber)?.asNumber();
  const x1 = rectArray.lookupMaybe(2, PDFNumber)?.asNumber();
  const y1 = rectArray.lookupMaybe(3, PDFNumber)?.asNumber();
  if (x0 === undefined || y0 === undefined || x1 === undefined || y1 === undefined) {
    return undefined;
  }
  if (![x0, y0, x1, y1].every(Number.isFinite)) {
    return undefined;
  }

  const minX = Math.min(x0, x1);
  const maxX = Math.max(x0, x1);
  const minY = Math.min(y0, y1);
  const maxY = Math.max(y0, y1);

  const box = page.getCropBox() ?? page.getMediaBox();
  return {
    x: minX - box.x,
    y: box.y + box.height - maxY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

// --- Converting pdf-lib fields into core/forms RawFormWidget entries --------

function safeReadTextFieldValue(field: PDFTextField): string {
  try {
    return field.getText() ?? '';
  } catch {
    const raw = field.acroField.V();
    if (raw instanceof PDFString || raw instanceof PDFHexString) {
      return raw.decodeText();
    }
    return '';
  }
}

function extractChoiceOptions(field: PDFDropdown | PDFOptionList): FormFieldOption[] {
  return field.acroField.getOptions().map((entry) => {
    const value = entry.value.decodeText();
    const label = entry.display?.decodeText();
    return label !== undefined && label.length > 0 && label !== value
      ? { value, label }
      : { value };
  });
}

function extractChoiceValue(field: PDFDropdown | PDFOptionList): string | string[] | null {
  const selected = field.getSelected();
  if (selected.length > 1) return selected;
  return selected[0] ?? null;
}

function buildWidgetPayload(field: PDFField): Partial<RawFormWidget> | undefined {
  if (field instanceof PDFTextField) {
    return { fieldType: 'text', fieldValue: safeReadTextFieldValue(field) };
  }
  if (field instanceof PDFCheckBox) {
    const checked = field.isChecked();
    return { fieldType: 'checkbox', checked, fieldValue: checked };
  }
  if (field instanceof PDFDropdown) {
    return {
      fieldType: 'combobox',
      options: extractChoiceOptions(field),
      fieldValue: extractChoiceValue(field),
    };
  }
  if (field instanceof PDFOptionList) {
    return {
      fieldType: 'listbox',
      options: extractChoiceOptions(field),
      fieldValue: extractChoiceValue(field),
    };
  }
  if (field instanceof PDFSignature) {
    return { fieldType: 'signature', fieldValue: null };
  }
  if (field instanceof PDFButton) {
    return { fieldType: 'pushbutton' };
  }
  return undefined;
}

function toRawWidgets(doc: PDFDocument, form: PDFForm): RawFormWidget[] {
  const lookup = buildPageLookup(doc);
  const rawWidgets: RawFormWidget[] = [];

  for (const field of form.getFields()) {
    const fieldName = field.getName();
    const fieldFlags = field.acroField.getFlags();
    const readOnly = field.isReadOnly();
    const required = field.isRequired();
    const widgets = field.acroField.getWidgets();

    const makeBaseWidget = (widget: PDFWidgetAnnotation | undefined): RawFormWidget => {
      const pageNumber = widget
        ? resolveWidgetPageNumber(doc, field, widget, widgets.length, lookup)
        : undefined;
      const pageObj = pageNumber !== undefined ? lookup.pages[pageNumber - 1] : undefined;
      const rect = widget ? readWidgetReaderRect(widget, pageObj) : undefined;
      return {
        fieldName,
        fieldFlags,
        readOnly,
        required,
        page: pageNumber,
        rect,
      };
    };

    const targets: ReadonlyArray<PDFWidgetAnnotation | undefined> =
      widgets.length > 0 ? widgets : [undefined];

    if (field instanceof PDFRadioGroup) {
      const options = field.getOptions();
      const selected = field.getSelected() ?? null;
      const exportValues = field.acroField.getExportValues();

      targets.forEach((widget, widgetIndex) => {
        const exportValue = widget
          ? (exportValues?.[widgetIndex]?.decodeText() ?? widget.getOnValue()?.decodeText())
          : undefined;
        rawWidgets.push({
          ...makeBaseWidget(widget),
          fieldType: 'radio',
          exportValues: options,
          ...(exportValue !== undefined ? { exportValue } : {}),
          checked: selected !== null && exportValue !== undefined && exportValue === selected,
          fieldValue: selected,
        });
      });
      continue;
    }

    const payload = buildWidgetPayload(field);
    if (!payload) continue;
    for (const widget of targets) {
      rawWidgets.push({ ...makeBaseWidget(widget), ...payload });
    }
  }

  return rawWidgets;
}

// --- Warning builders ------------------------------------------------------

const FLATTEN_WARNING_MESSAGES: Readonly<Record<FlattenWarningCode, string>> = {
  'editability-lost': 'Flattening turns interactive form fields into static page graphics.',
  'accessibility-lost': 'Flattening removes form role metadata and accessibility labels.',
  'signature-invalidated': 'Flattening rewrites page content and invalidates digital signatures.',
  'pending-updates': 'Pending form updates have not been applied prior to flattening.',
  'missing-values': 'Required fields were left empty before flattening.',
  'conflicting-values': 'Supplied values were refused because they conflicted with field constraints.',
};

function mergeWarning(warnings: PdfFormWarning[], next: PdfFormWarning): void {
  const existing = warnings.find((w) => w.code === next.code);
  if (!existing) {
    warnings.push({ code: next.code, fields: [...next.fields], message: next.message });
    return;
  }
  const merged = new Set(existing.fields);
  for (const name of next.fields) {
    merged.add(name);
  }
  existing.fields = [...merged];
}

function buildInspectionWarnings(
  hasForm: boolean,
  hasXfa: boolean,
  readOnlyFields: readonly string[],
  signatureFields: readonly string[],
  unsupported: readonly UnsupportedWidget[],
): PdfFormWarning[] {
  const warnings: PdfFormWarning[] = [];

  if (!hasForm) {
    warnings.push({
      code: 'no-form-fields',
      fields: [],
      message: 'PDF does not contain any AcroForm fields.',
    });
    return warnings;
  }

  if (hasXfa) {
    warnings.push({
      code: 'xfa-unsupported',
      fields: [],
      message: 'PDF contains XFA data, which is unsupported by pdf-lib form operations.',
    });
  }

  if (readOnlyFields.length > 0) {
    warnings.push({
      code: 'read-only-field',
      fields: [...readOnlyFields],
      message: `Read-only form fields cannot be modified: ${readOnlyFields.join(', ')}.`,
    });
  }

  if (signatureFields.length > 0) {
    warnings.push({
      code: 'signature-field',
      fields: [...signatureFields],
      message: `Digital signature fields cannot be filled programmatically: ${signatureFields.join(', ')}.`,
    });
  }

  if (unsupported.length > 0) {
    const names = [...new Set(unsupported.map((item) => item.name).filter((name) => name.length > 0))];
    warnings.push({
      code: 'unsupported-widgets',
      fields: names,
      message: `Skipped ${unsupported.length} unsupported widget(s) during field collection.`,
    });
  }

  return warnings;
}

function inspectPdfFormDocument(doc: PDFDocument): PdfFormInspectionResult {
  // Use catalog.getAcroForm() instead of doc.getForm() so plain PDFs do not gain an empty /AcroForm.
  const acroForm = doc.catalog.getAcroForm();
  if (!acroForm) {
    return {
      hasForm: false,
      hasXfa: false,
      fields: [],
      unsupported: [],
      readOnlyFields: [],
      signatureFields: [],
      warnings: buildInspectionWarnings(false, false, [], [], []),
    };
  }

  const hasXfa = acroForm.dict.has(PDFName.of('XFA'));
  const form = doc.getForm();
  const rawWidgets = toRawWidgets(doc, form);
  const { fields, unsupported } = collectFields(rawWidgets);
  const hasForm = fields.length > 0 || unsupported.length > 0 || hasXfa;
  const readOnlyFields = fields.filter((field) => field.readOnly).map((field) => field.name);
  const signatureFields = fields.filter((field) => field.type === 'signature').map((field) => field.name);
  const warnings = buildInspectionWarnings(
    hasForm,
    hasXfa,
    readOnlyFields,
    signatureFields,
    unsupported,
  );

  return {
    hasForm,
    hasXfa,
    fields,
    unsupported,
    readOnlyFields,
    signatureFields,
    warnings,
  };
}

// --- Appearance updates & safe flattening ----------------------------------

function updateFieldAppearanceSafe(
  form: PDFForm,
  field: PDFField,
  fontSet: PdfFontSet,
  fallbackFields: string[],
): void {
  if (field instanceof PDFSignature) return;
  if (!field.needsAppearancesUpdate()) return;

  if (field instanceof PDFCheckBox || field instanceof PDFRadioGroup) {
    field.defaultUpdateAppearances();
    return;
  }

  if (field instanceof PDFTextField) {
    const originalText = safeReadTextFieldValue(field);
    if (fontSet.canRepresent(originalText)) {
      field.defaultUpdateAppearances(fontSet.font);
      return;
    }

    const prepared = fontSet.prepare(originalText).text;
    fallbackFields.push(field.getName());
    field.setText(prepared);
    field.defaultUpdateAppearances(fontSet.font);
    field.acroField.setValue(PDFHexString.fromText(originalText));
    form.markFieldAsClean(field.ref);
    return;
  }

  if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
    const textToCheck =
      field instanceof PDFDropdown
        ? (field.getSelected()[0] ?? '')
        : field.getOptions().join('\n');
    if (fontSet.canRepresent(textToCheck)) {
      field.defaultUpdateAppearances(fontSet.font);
      return;
    }

    fallbackFields.push(field.getName());
    if (field instanceof PDFDropdown) {
      const selected = field.getSelected();
      const prepared = selected.map((item) => fontSet.prepare(item).text);
      const wasEditable = field.isEditable();
      field.select(prepared);
      field.defaultUpdateAppearances(fontSet.font);
      field.acroField.setValues(selected.map((item) => PDFHexString.fromText(item)));
      if (!wasEditable) field.disableEditing();
      form.markFieldAsClean(field.ref);
    } else {
      const originalOptions = field.acroField.getOptions();
      const originalSelected = field.getSelected();
      const foldedOptions = originalOptions.map((opt) => ({
        value: PDFHexString.fromText(fontSet.prepare(opt.value.decodeText()).text),
        ...(opt.display
          ? { display: PDFHexString.fromText(fontSet.prepare(opt.display.decodeText()).text) }
          : {}),
      }));
      field.acroField.setOptions(foldedOptions);
      field.defaultUpdateAppearances(fontSet.font);
      field.acroField.setOptions(originalOptions);
      field.acroField.setValues(originalSelected.map((item) => PDFHexString.fromText(item)));
      form.markFieldAsClean(field.ref);
    }
    return;
  }

  if (field instanceof PDFButton) {
    try {
      field.defaultUpdateAppearances(fontSet.font);
    } catch {
      fallbackFields.push(field.getName());
    }
  }
}

function updateFormAppearancesSafely(
  form: PDFForm,
  fontSet: PdfFontSet,
  warnings: PdfFormWarning[],
): void {
  const fallbackFields: string[] = [];
  for (const field of form.getFields()) {
    updateFieldAppearanceSafe(form, field, fontSet, fallbackFields);
  }
  if (fallbackFields.length > 0) {
    mergeWarning(warnings, {
      code: 'font-fallback',
      fields: fallbackFields,
      message: `Fell back to folded glyph representation for fields outside font coverage: ${fallbackFields.join(', ')}.`,
    });
  }
}

function widgetHasNormalAppearanceRef(
  doc: PDFDocument,
  field: PDFField,
  widget: PDFWidgetAnnotation,
): boolean {
  const ap = widget.AP();
  if (!ap) return false;
  const normal = ap.get(PDFName.of('N'));
  if (!normal) return false;

  if (normal instanceof PDFRef) return true;
  if (normal instanceof PDFStream) {
    ap.set(PDFName.of('N'), doc.context.register(normal));
    return true;
  }
  if (normal instanceof PDFDict && (field instanceof PDFCheckBox || field instanceof PDFRadioGroup)) {
    const value = field.acroField.getValue();
    const candidate = normal.get(value) ?? normal.get(PDFName.of('Off'));
    if (candidate instanceof PDFRef) return true;
    if (candidate instanceof PDFStream) {
      const key = normal.get(value) ? value : PDFName.of('Off');
      normal.set(key, doc.context.register(candidate));
      return true;
    }
  }
  return false;
}

function removeRefsFromAllPageAnnots(doc: PDFDocument, refs: ReadonlySet<PDFRef>): void {
  if (refs.size === 0) return;
  for (const page of doc.getPages()) {
    const annots = page.node.Annots();
    if (!annots) continue;
    for (let idx = annots.size() - 1; idx >= 0; idx -= 1) {
      const entry = annots.get(idx);
      if (entry instanceof PDFRef && refs.has(entry)) {
        annots.remove(idx);
      }
    }
    if (annots.size() === 0) {
      page.node.delete(PDFName.of('Annots'));
    }
  }
}

function removeFieldCompletely(doc: PDFDocument, form: PDFForm, field: PDFField): void {
  const fieldAndWidgetRefs = new Set<PDFRef>([field.ref]);
  const kids = field.acroField.Kids();
  if (kids) {
    for (let idx = 0; idx < kids.size(); idx += 1) {
      const entry = kids.get(idx);
      if (entry instanceof PDFRef) fieldAndWidgetRefs.add(entry);
    }
  }
  for (const widget of field.acroField.getWidgets()) {
    const ref = doc.context.getObjectRef(widget.dict);
    if (ref) fieldAndWidgetRefs.add(ref);
  }

  removeRefsFromAllPageAnnots(doc, fieldAndWidgetRefs);
  form.acroForm.removeField(field.acroField);
  for (const ref of fieldAndWidgetRefs) {
    doc.context.delete(ref);
  }
}

function flattenFormSafely(
  doc: PDFDocument,
  form: PDFForm,
  fontSet: PdfFontSet,
  warnings: PdfFormWarning[],
): void {
  updateFormAppearancesSafely(form, fontSet, warnings);

  const pageLookup = buildPageLookup(doc);
  const allRefsToClean = new Set<PDFRef>();

  for (const field of form.getFields()) {
    allRefsToClean.add(field.ref);
    const widgets = field.acroField.getWidgets();
    let canFlattenWithPdfLib = widgets.length > 0;

    for (const widget of widgets) {
      const widgetRef = doc.context.getObjectRef(widget.dict);
      if (widgetRef) allRefsToClean.add(widgetRef);

      const pageNum = resolveWidgetPageNumber(doc, field, widget, widgets.length, pageLookup);
      if (pageNum === undefined || !widgetHasNormalAppearanceRef(doc, field, widget)) {
        canFlattenWithPdfLib = false;
      } else if (widgetRef && !widget.P()) {
        const page = pageLookup.pages[pageNum - 1];
        if (page) widget.setP(page.ref);
      }
    }

    // Signatures or orphaned widgets without an /AP stream would cause pdf-lib's flatten() to throw.
    if (!canFlattenWithPdfLib) {
      removeFieldCompletely(doc, form, field);
    }
  }

  if (form.getFields().length > 0) {
    form.flatten({ updateFieldAppearances: false });
  }

  // pdf-lib's PDFForm.removeField removes the appearance ref rather than the widget ref from Annots;
  // strip all remaining widget/field refs so reloaded pages contain zero widget annotations.
  removeRefsFromAllPageAnnots(doc, allRefsToClean);

  const remainingFields = form.acroForm.Fields();
  if (!remainingFields || remainingFields.size() === 0) {
    const acroRef = doc.catalog.get(PDFName.of('AcroForm'));
    doc.catalog.delete(PDFName.of('AcroForm'));
    if (acroRef instanceof PDFRef) {
      doc.context.delete(acroRef);
    }
  }
}

// --- Applying fill updates onto PDFForm ------------------------------------

function applyUpdatesToForm(form: PDFForm, updates: readonly FillUpdate[]): void {
  for (const update of updates) {
    const field = form.getField(update.name);
    if (field instanceof PDFTextField) {
      field.setText(String(update.value));
    } else if (field instanceof PDFCheckBox) {
      if (update.value === true) field.check();
      else field.uncheck();
    } else if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
      field.select(String(update.value));
    } else if (field instanceof PDFRadioGroup) {
      field.select(String(update.value));
    }
  }
}

function applyUpdatesToFieldSnapshot(
  fields: readonly FormField[],
  updates: readonly FillUpdate[],
): FormField[] {
  const updateMap = new Map(updates.map((update) => [update.name, update.value]));
  return fields.map((field) => ({
    ...field,
    rect: { ...field.rect },
    ...(field.options ? { options: field.options.map((opt) => ({ ...opt })) } : {}),
    value: updateMap.has(field.name) ? (updateMap.get(field.name) ?? field.value) : field.value,
  }));
}

function addPlanConflictWarnings(plan: FormFillPlan, warnings: PdfFormWarning[]): void {
  const readOnlyConflicts = plan.conflicts
    .filter((conflict) => conflict.reason === 'read-only')
    .map((conflict) => conflict.name);
  if (readOnlyConflicts.length > 0) {
    mergeWarning(warnings, {
      code: 'read-only-field',
      fields: readOnlyConflicts,
      message: `Read-only form fields cannot be modified: ${readOnlyConflicts.join(', ')}.`,
    });
  }

  const signatureConflicts = plan.conflicts
    .filter((conflict) => conflict.reason === 'signature-not-fillable')
    .map((conflict) => conflict.name);
  if (signatureConflicts.length > 0) {
    mergeWarning(warnings, {
      code: 'signature-not-fillable',
      fields: signatureConflicts,
      message: `Digital signature fields cannot be filled programmatically: ${signatureConflicts.join(', ')}.`,
    });
  }
}

function addFlattenPlanWarnings(fPlan: FormFlattenPlan, warnings: PdfFormWarning[]): void {
  for (const warning of fPlan.warnings) {
    mergeWarning(warnings, {
      code: warning.code,
      fields: warning.fields,
      message: FLATTEN_WARNING_MESSAGES[warning.code],
    });
  }
}

// --- Public API ------------------------------------------------------------

/**
 * Inspects an interactive PDF's `/AcroForm` fields via `pdf-lib` and `src/core/forms.ts`
 * `collectFields()`. Never creates an `/AcroForm` dictionary on plain PDFs.
 */
export async function inspectPdfForm(
  input: PDFDocument | Uint8Array,
): Promise<PdfFormInspectionResult> {
  const doc = await asPdfDocument(input);
  return inspectPdfFormDocument(doc);
}

/**
 * Plans and applies form values using `planFill()`, embeds Unicode/fallback fonts via
 * `registerPdfFonts()` to update field appearance streams, and optionally flattens the form.
 */
export async function fillPdfForm(
  input: PDFDocument | Uint8Array,
  values: FormFillValues,
  options: FillPdfFormOptions = {},
): Promise<FillPdfFormResult> {
  const doc = await asPdfDocument(input);
  const inspection = inspectPdfFormDocument(doc);
  const plan = planFill(inspection.fields, values);
  const warnings: PdfFormWarning[] = inspection.warnings.map((w) => ({
    ...w,
    fields: [...w.fields],
  }));

  addPlanConflictWarnings(plan, warnings);

  if (!inspection.hasForm) {
    const bytes =
      input instanceof Uint8Array
        ? input.slice()
        : await doc.save({ updateFieldAppearances: false });
    return {
      bytes,
      hasForm: false,
      hasXfa: inspection.hasXfa,
      flattened: false,
      fields: [],
      applied: [],
      plan,
      flattenPlan: null,
      unsupported: inspection.unsupported,
      readOnlyFields: inspection.readOnlyFields,
      signatureFields: inspection.signatureFields,
      warnings,
    };
  }

  const form = doc.getForm();
  const shouldFlatten = options.flatten === true;
  const needsFontUpdate = plan.updates.length > 0 || shouldFlatten;
  const fontSet = needsFontUpdate ? await registerPdfFonts(doc, options.fonts) : null;

  if (plan.updates.length > 0) {
    applyUpdatesToForm(form, plan.updates);
  }

  const updatedFields = applyUpdatesToFieldSnapshot(inspection.fields, plan.updates);
  let fPlan: FormFlattenPlan | null = null;
  let flattened = false;

  if (shouldFlatten && fontSet) {
    fPlan = flattenPlan(updatedFields, {
      updates: [],
      missing: plan.missing,
      conflicts: plan.conflicts,
    });
    addFlattenPlanWarnings(fPlan, warnings);
    flattenFormSafely(doc, form, fontSet, warnings);
    flattened = fPlan.fields.length > 0 || inspection.unsupported.length > 0;
  } else if (fontSet) {
    updateFormAppearancesSafely(form, fontSet, warnings);
  }

  const bytes = await doc.save({ updateFieldAppearances: false });

  return {
    bytes,
    hasForm: flattened ? false : inspection.hasForm,
    hasXfa: inspection.hasXfa,
    flattened,
    fields: flattened ? [] : updatedFields,
    applied: plan.updates,
    plan,
    flattenPlan: fPlan,
    unsupported: inspection.unsupported,
    readOnlyFields: inspection.readOnlyFields,
    signatureFields: inspection.signatureFields,
    warnings,
  };
}

/**
 * Flattens all interactive AcroForm fields onto page content streams via `form.flatten()`,
 * returning documented loss warnings from `flattenPlan()`. Safe on plain/already-flattened PDFs.
 */
export async function flattenPdfForm(
  input: PDFDocument | Uint8Array,
  options: FlattenPdfFormOptions = {},
): Promise<FlattenPdfFormResult> {
  const doc = await asPdfDocument(input);
  const inspection = inspectPdfFormDocument(doc);
  const warnings: PdfFormWarning[] = inspection.warnings.map((w) => ({
    ...w,
    fields: [...w.fields],
  }));

  if (!inspection.hasForm) {
    const bytes =
      input instanceof Uint8Array
        ? input.slice()
        : await doc.save({ updateFieldAppearances: false });
    return {
      bytes,
      hasForm: false,
      hasXfa: inspection.hasXfa,
      flattened: false,
      flattenedFields: [],
      plan: null,
      unsupported: inspection.unsupported,
      readOnlyFields: inspection.readOnlyFields,
      signatureFields: inspection.signatureFields,
      warnings,
    };
  }

  const fPlan = flattenPlan(inspection.fields);
  addFlattenPlanWarnings(fPlan, warnings);

  const form = doc.getForm();
  const fontSet = await registerPdfFonts(doc, options.fonts);
  flattenFormSafely(doc, form, fontSet, warnings);
  const flattened = fPlan.fields.length > 0 || inspection.unsupported.length > 0;
  const bytes = await doc.save({ updateFieldAppearances: false });

  return {
    bytes,
    hasForm: false,
    hasXfa: inspection.hasXfa,
    flattened,
    flattenedFields: fPlan.fields,
    plan: fPlan,
    unsupported: inspection.unsupported,
    readOnlyFields: inspection.readOnlyFields,
    signatureFields: inspection.signatureFields,
    warnings,
  };
}

/**
 * Exports fillable field values from a PDF form as a structured JSON-serializable payload.
 */
export async function exportPdfFormData(
  input: PDFDocument | Uint8Array,
): Promise<PdfFormDataExport> {
  const inspection = await inspectPdfForm(input);
  const values: Record<string, FormFieldValue> = {};

  for (const field of inspection.fields) {
    if (field.type === 'signature') continue;
    values[field.name] = field.value;
  }

  return {
    version: 1,
    hasForm: inspection.hasForm,
    hasXfa: inspection.hasXfa,
    fieldCount: Object.keys(values).length,
    values,
    fields: inspection.fields,
    unsupported: inspection.unsupported,
    warnings: inspection.warnings,
  };
}

/**
 * Serializes {@link exportPdfFormData} as a JSON string.
 */
export async function exportPdfFormJson(
  input: PDFDocument | Uint8Array,
  options: ExportPdfFormJsonOptions = {},
): Promise<string> {
  const data = await exportPdfFormData(input);
  return options.pretty ? JSON.stringify(data, null, options.indent ?? 2) : JSON.stringify(data);
}
