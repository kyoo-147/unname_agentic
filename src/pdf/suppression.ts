export interface TextSuppressionDiagnostics {
  textOperators: number;
  suppressedTextPaints: number;
}

/** Keep PDF.js text layout/advance operations intact; suppress their paint calls only. */
export function textPaintGate(context: CanvasRenderingContext2D, isTextOperator: (index: number) => boolean) {
  const diagnostics: TextSuppressionDiagnostics = { textOperators: 0, suppressedTextPaints: 0 };
  let paintingText = false;
  const proxy = new Proxy(context, {
    get(target, key) {
      if (key === 'fillText' || key === 'strokeText' || key === 'fill' || key === 'stroke') {
        return (...args: unknown[]) => {
          if (paintingText || key === 'fillText' || key === 'strokeText') {
            diagnostics.suppressedTextPaints++;
            return;
          }
          return Reflect.apply(Reflect.get(target, key, target), target, args);
        };
      }
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
    set(target, key, value) { return Reflect.set(target, key, value, target); },
  });
  return {
    context: proxy,
    diagnostics,
    operationsFilter(index: number) {
      paintingText = isTextOperator(index);
      if (paintingText) diagnostics.textOperators++;
      return true;
    },
  };
}

export function pageFrameWidth(rowWidth: number, split: number): number {
  return Math.max(1, Math.min(rowWidth * split / 100 - 9, rowWidth * (100 - split) / 100 - 9));
}
