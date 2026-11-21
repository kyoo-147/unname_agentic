import { describe, expect, it } from 'vitest';
import {
  bboxToQuad,
  computeRotatedSize,
  mapBBoxToOriginal,
  type CropTransform,
} from '../src/core/visual-grounding';
import {
  parseActionPayload,
  runAgenticOcr,
  type ImagePayload,
  type PageImageInput,
  type VisionCropper,
} from '../src/core/agentic-ocr';

describe('OCR visual grounding and truthful visual abstention', () => {
  it('maps a padded rotated crop back to a four-corner source quad', () => {
    const transform: CropTransform = {
      originalSize: { width: 1000, height: 1000 },
      cropRectPx: { x: 100, y: 200, width: 400, height: 200 },
      rotationDegCCW: 90,
      rotatedSize: computeRotatedSize(400, 200, 90),
      paddingPx: { top: 20, right: 10, bottom: 20, left: 10 },
      resizedSize: { width: 440, height: 880 },
    };
    const mapped = mapBBoxToOriginal([60 / 440 * 1000, 600 / 880 * 1000, 180 / 440 * 1000, 760 / 880 * 1000], transform);

    expect(mapped.quad).toHaveLength(4);
    expect(mapped.bbox[0]).toBeGreaterThanOrEqual(100);
    expect(mapped.bbox[2]).toBeLessThanOrEqual(500);
  });

  it('keeps citation geometry deterministic for an unrotated evidence box', () => {
    expect(bboxToQuad([100, 200, 400, 600])).toEqual([
      { x: 100, y: 200 },
      { x: 400, y: 200 },
      { x: 400, y: 600 },
      { x: 100, y: 600 },
    ]);
  });

  it('rejects placeholder evidence instead of turning it into a grounded claim', () => {
    const parsed = parseActionPayload({
      type: 'stop_with_evidence',
      answerable: true,
      evidence: [{ content: 'no evidence', bbox: [100, 100, 200, 200], pageIndex: 1 }],
    });
    expect(parsed.ok).toBe(true);

    const page: PageImageInput = { pageId: 'doc-p1', pageIndex: 1, width: 800, height: 600, sourceRef: 'fixture' };
    const image: ImagePayload = { id: 'overview', width: 80, height: 60, byteLength: 10, data: 'fixture' };
    const cropper: VisionCropper = {
      async renderOverview() { return image; },
      async cropAndTransform() { throw new Error('no crop should be needed'); },
    };
    return expect(runAgenticOcr({
      page,
      query: 'unanswerable fixture',
      cropper,
      ocr: { async extract() { return { text: '' }; } },
      model: { async nextStep() { return { type: 'stop_with_evidence', answerable: false, evidence: [] }; } },
      verify: false,
    })).resolves.toMatchObject({ status: 'completed', answerable: false, evidence: [] });
  });
});
