import { readFileSync } from 'node:fs';
import { PDFDocument, PDFName, PDFString, StandardFonts } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';
import type { FillUpdate, FlattenField, FormField, FormFieldOption } from '../src/core/forms';
import {
  exportPdfFormData,
  exportPdfFormJson,
  fillPdfForm,
  flattenPdfForm,
  inspectPdfForm,
} from '../src/export/pdf-forms';

const FONT_BYTES = new Uint8Array(
  readFileSync(new URL('../public/fonts/NotoSans-Regular.ttf', import.meta.url)),
);

async function readPdfJsFormAndText(bytes: Uint8Array) {
  const task = getDocument({ data: bytes.slice(), disableFontFace: true, useSystemFonts: false, verbosity: 0 });
  const doc = await task.promise;
  try {
    const fieldObjects = await doc.getFieldObjects() as Record<string, Array<Record<string, unknown>>> | null;
    const pageTexts: string[] = [];
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      pageTexts.push(content.items.map(item => ('str' in item ? item.str : '')).join(' '));
    }
    return { numPages: doc.numPages, fieldObjects, pageTexts };
  } finally {
    await task.destroy();
  }
}

async function createRichFormPdf(options: {
  includeSignature?: boolean;
  includeReadOnly?: boolean;
  includePushButton?: boolean;
} = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page1 = doc.addPage([612, 792]);
  const page2 = doc.addPage([612, 792]);

  page1.drawText('Application Form', { x: 72, y: 740, size: 16, font });
  page2.drawText('Preferences and Approval', { x: 72, y: 740, size: 16, font });

  const form = doc.getForm();

  const fullName = form.createTextField('applicantName');
  fullName.enableRequired();
  fullName.addToPage(page1, { x: 72, y: 660, width: 260, height: 24 });

  const notes = form.createTextField('notes');
  notes.addToPage(page1, { x: 72, y: 610, width: 260, height: 24 });
  notes.setText('Initial note');

  const acceptTerms = form.createCheckBox('acceptTerms');
  acceptTerms.enableRequired();
  acceptTerms.addToPage(page1, { x: 72, y: 560, width: 18, height: 18 });

  const country = form.createDropdown('country');
  country.setOptions(['Vietnam', 'Japan', 'Singapore']);
  country.addToPage(page2, { x: 72, y: 660, width: 180, height: 24 });

  const plan = form.createRadioGroup('planTier');
  plan.addOptionToPage('starter', page2, { x: 72, y: 600, width: 16, height: 16 });
  plan.addOptionToPage('pro', page2, { x: 160, y: 600, width: 16, height: 16 });

  if (options.includeReadOnly) {
    const caseId = form.createTextField('caseId');
    caseId.addToPage(page1, { x: 360, y: 660, width: 160, height: 24 });
    caseId.setText('CASE-2026-001');
    caseId.enableReadOnly();
  }

  if (options.includePushButton) {
    const submitBtn = form.createButton('submitAction');
    submitBtn.addToPage('Submit', page2, { x: 72, y: 520, width: 90, height: 26 });
  }

  if (options.includeSignature) {
    const sigRef = doc.context.nextRef();
    doc.context.assign(
      sigRef,
      doc.context.obj({
        Type: 'Annot',
        Subtype: 'Widget',
        FT: 'Sig',
        T: PDFString.of('reviewerSignature'),
        Rect: [72, 440, 260, 480],
        P: page2.ref,
      }),
    );
    doc.catalog.getOrCreateAcroForm().addField(sigRef);
    page2.node.addAnnot(sigRef);
  }

  return doc.save();
}

describe('H13 inspectPdfForm: real AcroForm detection and field modeling', () => {
  it('inspects TextField, CheckBox, Dropdown, RadioGroup, ReadOnly, Signature, and PushButton via core collectFields()', async () => {
    const bytes = await createRichFormPdf({
      includeReadOnly: true,
      includeSignature: true,
      includePushButton: true,
    });

    const report = await inspectPdfForm(bytes);
    expect(report.hasForm).toBe(true);
    expect(report.hasXfa).toBe(false);

    const names = report.fields.map((field: FormField) => field.name);
    expect(names).toEqual([
      'applicantName',
      'caseId',
      'notes',
      'acceptTerms',
      'country',
      'planTier',
      'reviewerSignature',
    ]);

    const byName = Object.fromEntries(
      report.fields.map((field: FormField): [string, FormField] => [field.name, field]),
    );
    expect(byName['applicantName']).toMatchObject({
      type: 'text',
      value: '',
      required: true,
      readOnly: false,
      page: 1,
    });
    // pdf-lib default borderWidth=1 expands Rect by 0.5pt -> y=659.5..684.5 on height 792 -> 792 - 684.5 = 107.5
    expect(byName['applicantName']?.rect.y).toBeCloseTo(107.5, 1);

    expect(byName['caseId']).toMatchObject({
      type: 'text',
      value: 'CASE-2026-001',
      readOnly: true,
      page: 1,
    });
    expect(byName['acceptTerms']).toMatchObject({
      type: 'checkbox',
      value: false,
      required: true,
      page: 1,
    });
    expect(byName['country']?.options?.map((o: FormFieldOption) => o.value)).toEqual(['Vietnam', 'Japan', 'Singapore']);
    expect(byName['planTier']?.options?.map((o: FormFieldOption) => o.value)).toEqual(['starter', 'pro']);
    expect(byName['reviewerSignature']).toMatchObject({
      type: 'signature',
      value: null,
      page: 2,
    });

    // Push buttons are non-fillable controls reported in unsupported
    expect(report.unsupported).toHaveLength(1);
    expect(report.unsupported[0]).toMatchObject({
      name: 'submitAction',
      reason: 'unsupported-type',
      page: 2,
    });

    expect(report.readOnlyFields).toEqual(['caseId']);
    expect(report.signatureFields).toEqual(['reviewerSignature']);
    expect(report.warnings.some((w: { code: string }) => w.code === 'read-only-field')).toBe(true);
    expect(report.warnings.some((w: { code: string }) => w.code === 'signature-field')).toBe(true);
  });

  it('reports no-form-fields without creating an empty /AcroForm on a plain PDF', async () => {
    const plain = await PDFDocument.create();
    plain.addPage([612, 792]);
    const report = await inspectPdfForm(plain);

    expect(report.hasForm).toBe(false);
    expect(report.fields).toEqual([]);
    expect(report.warnings.some((w: { code: string }) => w.code === 'no-form-fields')).toBe(true);
    expect(plain.catalog.get(PDFName.of('AcroForm'))).toBeUndefined();
  });
});

describe('H13 fillPdfForm & JSON export via planFill', () => {
  it('fills TextField, CheckBox, Dropdown, RadioGroup via planFill, refuses read-only/signature/bad values, and verifies via pdf-lib & pdfjs-dist', async () => {
    const bytes = await createRichFormPdf({
      includeReadOnly: true,
      includeSignature: true,
    });

    const filled = await fillPdfForm(
      bytes,
      {
        applicantName: 'Nguyễn Văn Minh',
        notes: 'Approved after review',
        acceptTerms: true,
        country: 'Vietnam',
        planTier: 'pro',
        caseId: 'TAMPERED-ID',
        reviewerSignature: 'FakeSig',
        nonExistent: 'ignored',
      },
      { fonts: { bytes: FONT_BYTES } },
    );

    expect(filled.flattened).toBe(false);
    expect(filled.applied.map((u: FillUpdate) => u.name)).toEqual([
      'applicantName',
      'notes',
      'acceptTerms',
      'country',
      'planTier',
    ]);
    expect(filled.plan.missing).toEqual([]);
    expect(filled.plan.conflicts).toEqual([
      { name: 'caseId', reason: 'read-only', value: 'TAMPERED-ID' },
      { name: 'reviewerSignature', reason: 'signature-not-fillable', value: 'FakeSig' },
      { name: 'nonExistent', reason: 'unknown-field', value: 'ignored' },
    ]);

    expect(
      filled.warnings.some((w: { code: string; fields: string[] }) => w.code === 'read-only-field' && w.fields.includes('caseId')),
    ).toBe(true);
    expect(
      filled.warnings.some(
        (w: { code: string; fields: string[] }) =>
          w.code === 'signature-not-fillable' && w.fields.includes('reviewerSignature'),
      ),
    ).toBe(true);

    // Verify with pdf-lib reload
    const reloaded = await PDFDocument.load(filled.bytes, { updateMetadata: false });
    const form = reloaded.getForm();
    expect(form.getTextField('applicantName').getText()).toBe('Nguyễn Văn Minh');
    expect(form.getTextField('notes').getText()).toBe('Approved after review');
    expect(form.getTextField('caseId').getText()).toBe('CASE-2026-001'); // read-only unchanged
    expect(form.getCheckBox('acceptTerms').isChecked()).toBe(true);
    expect(form.getDropdown('country').getSelected()).toEqual(['Vietnam']);
    expect(form.getRadioGroup('planTier').getSelected()).toBe('pro');

    // Verify with pdfjs-dist
    const pdfjs = await readPdfJsFormAndText(filled.bytes);
    expect(pdfjs.fieldObjects).not.toBeNull();
    const widgetOf = (name: string) =>
      pdfjs.fieldObjects?.[name]?.find(entry => entry['type'] !== '');
    expect(widgetOf('applicantName')).toMatchObject({ type: 'text', value: 'Nguyễn Văn Minh' });
    expect(widgetOf('caseId')).toMatchObject({ type: 'text', value: 'CASE-2026-001' });
    expect(widgetOf('acceptTerms')).toMatchObject({ type: 'checkbox', value: 'Yes' });
    expect(widgetOf('country')).toMatchObject({ type: 'combobox', value: 'Vietnam' });
    // pdf-lib addOptionToPage stores ['starter', 'pro'] in /Opt and writes the option index '/1' in /V
    expect(widgetOf('planTier')).toMatchObject({ type: 'radiobutton', value: '1' });
  });

  it('exports filled field JSON and round-trips exported values into a blank form', async () => {
    const blankBytes = await createRichFormPdf();
    const filled = await fillPdfForm(blankBytes, {
      applicantName: 'Le Thi Hoa',
      acceptTerms: true,
      country: 'Singapore',
      planTier: 'starter',
    });

    const data = await exportPdfFormData(filled.bytes);
    expect(data.version).toBe(1);
    expect(data.hasForm).toBe(true);
    expect(data.fieldCount).toBe(5);
    expect(data.values).toEqual({
      applicantName: 'Le Thi Hoa',
      notes: 'Initial note',
      acceptTerms: true,
      country: 'Singapore',
      planTier: 'starter',
    });

    const json = await exportPdfFormJson(filled.bytes, { pretty: true });
    const parsed = JSON.parse(json) as typeof data;
    expect(parsed.values).toEqual(data.values);

    // Re-apply exported values onto a fresh blank copy of the form
    const reapplied = await fillPdfForm(blankBytes, parsed.values);
    const reloaded = await PDFDocument.load(reapplied.bytes);
    expect(reloaded.getForm().getTextField('applicantName').getText()).toBe('Le Thi Hoa');
    expect(reloaded.getForm().getDropdown('country').getSelected()).toEqual(['Singapore']);
    expect(reloaded.getForm().getRadioGroup('planTier').getSelected()).toBe('starter');
    expect(reloaded.getForm().getCheckBox('acceptTerms').isChecked()).toBe(true);
  });
});

describe('H13 flattenPdfForm: real form.flatten(), warnings, and pdfjs-dist text extraction', () => {
  it('flattens filled AcroForm fields via form.flatten(), emits warnings, removes widgets, and exposes filled text via pdfjs-dist', async () => {
    const bytes = await createRichFormPdf({
      includeReadOnly: true,
      includeSignature: true,
    });

    const result = await fillPdfForm(
      bytes,
      {
        applicantName: 'Nguyễn Văn Minh',
        notes: 'Final flattened submission',
        acceptTerms: true,
        country: 'Japan',
        planTier: 'pro',
      },
      {
        flatten: true,
        fonts: { bytes: FONT_BYTES },
      },
    );

    expect(result.flattened).toBe(true);
    expect(result.fields).toEqual([]);
    expect(result.flattenPlan).not.toBeNull();
    expect(result.flattenPlan?.fields.map((f: FlattenField) => f.name)).toEqual([
      'applicantName',
      'caseId',
      'notes',
      'acceptTerms',
      'country',
      'planTier',
      'reviewerSignature',
    ]);

    const warningCodes = result.warnings.map((w: { code: string }) => w.code);
    expect(warningCodes).toContain('editability-lost');
    expect(warningCodes).toContain('accessibility-lost');
    expect(warningCodes).toContain('signature-invalidated');
    expect(warningCodes).toContain('read-only-field');

    // Verify with pdf-lib reload: zero interactive fields & zero widget annotations
    const reloaded = await PDFDocument.load(result.bytes, { updateMetadata: false });
    expect(reloaded.getForm().getFields()).toEqual([]);
    expect(reloaded.getPage(0).node.Annots()?.size() ?? 0).toBe(0);
    expect(reloaded.getPage(1).node.Annots()?.size() ?? 0).toBe(0);

    // Verify with pdfjs-dist: no AcroForm fields remain, and flattened text is in page text content!
    const pdfjs = await readPdfJsFormAndText(result.bytes);
    expect(pdfjs.fieldObjects).toBeNull();
    expect(pdfjs.pageTexts[0]).toContain('Nguyễn Văn Minh');
    expect(pdfjs.pageTexts[0]).toContain('Final flattened submission');
    expect(pdfjs.pageTexts[0]).toContain('CASE-2026-001');
    expect(pdfjs.pageTexts[1]).toContain('Japan');
  });

  it('flattenPdfForm handles already-flattened PDFs safely and warns with no-form-fields', async () => {
    const bytes = await createRichFormPdf();
    const filled = await fillPdfForm(bytes, {
      applicantName: 'Alice Tran',
      acceptTerms: true,
      country: 'Vietnam',
      planTier: 'starter',
    });

    const flattenedOnce = await flattenPdfForm(filled.bytes);
    expect(flattenedOnce.flattened).toBe(true);
    expect(flattenedOnce.flattenedFields).toHaveLength(5);
    expect(flattenedOnce.warnings.map((w: { code: string }) => w.code)).toContain('editability-lost');

    const flattenedAgain = await flattenPdfForm(flattenedOnce.bytes);
    expect(flattenedAgain.flattened).toBe(false);
    expect(flattenedAgain.flattenedFields).toEqual([]);
    expect(flattenedAgain.warnings.some((w: { code: string }) => w.code === 'no-form-fields')).toBe(true);

    // Attempting to fill an already-flattened PDF produces unknown-field conflicts & no-form-fields warning
    const refillAttempt = await fillPdfForm(flattenedOnce.bytes, { applicantName: 'Bob' });
    expect(refillAttempt.applied).toEqual([]);
    expect(refillAttempt.plan.conflicts).toEqual([
      { name: 'applicantName', reason: 'unknown-field', value: 'Bob' },
    ]);
    expect(refillAttempt.warnings.some((w: { code: string }) => w.code === 'no-form-fields')).toBe(true);
  });

  it('emits missing-values and conflicting-values warnings when flattening an incomplete form', async () => {
    const bytes = await createRichFormPdf();
    const result = await fillPdfForm(
      bytes,
      {
        notes: 'Partial fill',
        country: 'InvalidCountry',
      },
      { flatten: true },
    );

    expect(result.flattened).toBe(true);
    const missingWarn = result.warnings.find((w: { code: string; fields: string[] }) => w.code === 'missing-values');
    expect(missingWarn?.fields).toEqual(['applicantName', 'acceptTerms']);
    const conflictWarn = result.warnings.find(
      (w: { code: string; fields: string[] }) => w.code === 'conflicting-values',
    );
    expect(conflictWarn?.fields).toEqual(['country']);
  });
});
