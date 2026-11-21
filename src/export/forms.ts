import {
  PDFCheckBox,
  PDFDocument,
  PDFDropdown,
  PDFOptionList,
  PDFRadioGroup,
  PDFTextField,
  type PDFField,
} from 'pdf-lib';
import type { FormFillPlan, FormFillValues } from '../core/forms';
import { planFill, collectFields, type RawFormWidget } from '../core/forms';

export interface PdfFormWriteOptions {
  flatten?: boolean;
  updateFieldAppearances?: boolean;
  saveOptions?: Parameters<PDFDocument['save']>[0];
}

export interface PdfFormWriteResult {
  bytes: Uint8Array;
  applied: string[];
  flattened: boolean;
  fieldNames: string[];
  limitations: string[];
}

function fieldNames(document: PDFDocument): string[] {
  try {
    return document.getForm().getFields().map(field => field.getName()).sort();
  } catch {
    return [];
  }
}

function writeUpdate(field: PDFField, value: string | boolean): void {
  if (field instanceof PDFTextField) {
    if (typeof value !== 'string') throw new Error('Text fields require string values.');
    field.setText(value);
    return;
  }
  if (field instanceof PDFCheckBox) {
    if (typeof value !== 'boolean') throw new Error('Checkbox fields require boolean values.');
    if (value) field.check(); else field.uncheck();
    return;
  }
  if (field instanceof PDFRadioGroup) {
    if (typeof value !== 'string') throw new Error('Radio fields require string values.');
    field.select(value);
    return;
  }
  if (field instanceof PDFDropdown) {
    if (typeof value !== 'string') throw new Error('Dropdown fields require string values.');
    field.select(value);
    return;
  }
  if (field instanceof PDFOptionList) {
    if (typeof value !== 'string') throw new Error('Option-list fields require string values.');
    field.select(value);
    return;
  }
  throw new Error(`Field ${field.getName()} is not writable by this exporter.`);
}

/** Apply a previously reviewed pure form plan to real PDF bytes. */
export async function applyPdfFormPlan(bytes: Uint8Array, plan: FormFillPlan, options: PdfFormWriteOptions = {}): Promise<PdfFormWriteResult> {
  const document = await PDFDocument.load(new Uint8Array(bytes), { updateMetadata: false });
  const form = document.getForm();
  const applied: string[] = [];
  for (const update of plan.updates) {
    const field = form.getFieldMaybe(update.name);
    if (!field) continue;
    writeUpdate(field, update.value);
    applied.push(update.name);
  }
  let flattened = false;
  if (options.flatten) {
    form.flatten({ updateFieldAppearances: options.updateFieldAppearances ?? true });
    flattened = true;
  }
  return {
    bytes: await document.save(options.saveOptions),
    applied,
    flattened,
    fieldNames: flattened ? [] : fieldNames(document),
    limitations: options.flatten ? ['Flattening removes editability and turns widget values into page content. Signatures and accessibility semantics may be invalidated.'] : [],
  };
}

/** Plan then apply a form fill in one explicit call. The caller still receives conflicts and missing fields. */
export async function fillPdfForm(bytes: Uint8Array, plan: FormFillPlan, options?: PdfFormWriteOptions): Promise<PdfFormWriteResult>;
export async function fillPdfForm(bytes: Uint8Array, fields: Parameters<typeof collectFields>[0], values: FormFillValues, options?: PdfFormWriteOptions): Promise<PdfFormWriteResult & { plan: FormFillPlan }>;
export async function fillPdfForm(
  bytes: Uint8Array,
  planOrWidgets: FormFillPlan | readonly RawFormWidget[],
  valuesOrOptions: FormFillValues | PdfFormWriteOptions = {},
  maybeOptions: PdfFormWriteOptions = {},
): Promise<PdfFormWriteResult | (PdfFormWriteResult & { plan: FormFillPlan })> {
  if ('updates' in planOrWidgets && 'conflicts' in planOrWidgets) return applyPdfFormPlan(bytes, planOrWidgets, valuesOrOptions as PdfFormWriteOptions);
  const collected = collectFields(planOrWidgets);
  const plan = planFill(collected.fields, valuesOrOptions as FormFillValues);
  return { ...(await applyPdfFormPlan(bytes, plan, maybeOptions)), plan };
}
