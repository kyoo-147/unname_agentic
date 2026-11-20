//! F07/F09 — the page-frame toolbox an agent calls so a question can ask for
//! one region instead of OCR-ing the whole page: crop it, enlarge it, turn it,
//! OCR just that region, and inspect what the page already knows.
//!
//! Page space is [`BlockRect`]: normalized `0..1` against the page raster. Crop
//! space is the same rectangle against the crop, which is why [`ocr_region`]
//! routes every block it gets back through the pixel window the crop actually
//! covered — the caller only ever sees page-space rectangles.
//!
//! Every call can go through [`ToolTrace`], which times it, records its name,
//! arguments and result rectangles, and refuses a call once `max_steps` is
//! spent ([`ToolError::BudgetExceeded`]).

#![allow(dead_code)]

use image::{RgbaImage, imageops};
use mirror_pdf_desktop::model::{BlockRect, PageFrame, PixelCrop, TextBlock};

/// The largest factor [`zoom`] honours. The raster holds no more detail than it
/// holds, so past this an upscale only multiplies memory for the same glyphs.
pub const MAX_ZOOM: f32 = 8.0;

/// The step budget a fresh [`ToolTrace`] starts with.
pub const DEFAULT_MAX_STEPS: usize = 16;

/// `rect` intersected with the `0..1` page: the result is always inside the
/// page and never larger than the request, so an overhanging rectangle keeps
/// only the part a reader can see and one that starts past the edge collapses
/// to no area instead of inventing one. A NaN field is treated as 0.
pub fn clamp(rect: BlockRect) -> BlockRect {
    let x = clamp_unit(rect.x);
    let y = clamp_unit(rect.y);
    let width = (clamp_unit(rect.x + rect.width) - x).max(0.);
    let height = (clamp_unit(rect.y + rect.height) - y).max(0.);
    BlockRect { x, y, width, height }
}

fn clamp_unit(value: f32) -> f32 { if value.is_nan() { 0. } else { value.clamp(0., 1.) } }

/// The pixels of `frame.original` a page-space rectangle covers, after clamping.
/// A rectangle whose clamped area is under one pixel still yields a one-pixel
/// raster, so an OCR call always has something to read.
pub fn page_pixels(frame: &PageFrame, rect: BlockRect) -> PixelCrop {
    let width = frame.original.width();
    let height = frame.original.height();
    if width == 0 || height == 0 { return PixelCrop { x: 0, y: 0, width, height }; }
    let page = clamp(rect);
    let x = ((page.x * width as f32).round() as u32).min(width - 1);
    let y = ((page.y * height as f32).round() as u32).min(height - 1);
    PixelCrop { x, y, width: ((page.width * width as f32).round() as u32).max(1).min(width - x), height: ((page.height * height as f32).round() as u32).max(1).min(height - y) }
}

/// One region of the page at page resolution.
pub fn crop(frame: &PageFrame, rect: BlockRect) -> RgbaImage {
    let bounds = page_pixels(frame, rect);
    imageops::crop_imm(&frame.original, bounds.x, bounds.y, bounds.width, bounds.height).to_image()
}

/// `image` enlarged by `factor` with nearest-neighbour sampling, clamped to
/// `1.0` through [`MAX_ZOOM`]: shrinking loses text an OCR pass needs, and
/// enlarging past the maximum repaints identical pixels larger.
pub fn zoom(image: &RgbaImage, factor: f32) -> RgbaImage {
    let factor = if factor.is_nan() { 1. } else { factor.clamp(1., MAX_ZOOM) };
    if factor == 1. { return image.clone(); }
    let width = (image.width() as f32 * factor).round().max(1.) as u32;
    let height = (image.height() as f32 * factor).round().max(1.) as u32;
    imageops::resize(image, width, height, imageops::FilterType::Nearest)
}

/// A quarter turn of `image`; any other angle returns the image unchanged —
/// this toolbox turns complete pages, it never resamples them.
pub fn rotate(image: &RgbaImage, degrees: u16) -> RgbaImage {
    match degrees % 360 {
        90 => imageops::rotate90(image),
        180 => imageops::rotate180(image),
        270 => imageops::rotate270(image),
        _ => image.clone(),
    }
}

/// One OCR pass over one raster; the rectangles it returns are normalized to
/// that raster, not to the page it was cut from.
pub trait OcrEngine {
    fn recognize(&self, image: &RgbaImage) -> Result<Vec<TextBlock>, String>;
}

/// The desktop crate's OCR pair: Windows OCR, Tesseract when it finds nothing.
pub struct DesktopOcr;

impl OcrEngine for DesktopOcr {
    fn recognize(&self, image: &RgbaImage) -> Result<Vec<TextBlock>, String> {
        mirror_pdf_desktop::ocr_fallback::recognize(image).map(|recognized| recognized.blocks).map_err(|error| format!("{error:#}"))
    }
}

/// The page-space rectangle `rect` (normalized to the crop) covers. The pixel
/// window the crop really took is the bridge between the two spaces.
pub fn map_crop_rect_to_page(frame: &PageFrame, bounds: PixelCrop, rect: BlockRect) -> BlockRect {
    let width = frame.original.width() as f32;
    let height = frame.original.height() as f32;
    if width == 0. || height == 0. { return BlockRect::default(); }
    BlockRect {
        x: (bounds.x as f32 + rect.x * bounds.width as f32) / width,
        y: (bounds.y as f32 + rect.y * bounds.height as f32) / height,
        width: rect.width * bounds.width as f32 / width,
        height: rect.height * bounds.height as f32 / height,
    }
}

/// OCR one region only: crop, recognize the crop, and translate every block
/// back into page space, so a caller never sees crop coordinates.
pub fn ocr_region(frame: &PageFrame, rect: BlockRect, engine: &dyn OcrEngine) -> Result<Vec<TextBlock>, ToolError> {
    let bounds = page_pixels(frame, rect);
    let raster = crop(frame, rect);
    let mut mapped = Vec::new();
    for block in engine.recognize(&raster).map_err(ToolError::Ocr)? {
        let page_rect = map_crop_rect_to_page(frame, bounds, block.rect);
        if !page_rect.is_valid() { continue; }
        mapped.push(TextBlock { id: mapped.len() as u64, rect: page_rect, ..block });
    }
    Ok(mapped)
}

/// What a page already knows: its raster size, its blocks, and the rectangles
/// text occupies, so a caller can skip OCR for a region that is done.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RegionReport {
    pub width: u32,
    pub height: u32,
    pub region_count: usize,
    /// Where text already exists, in page space.
    pub text_regions: Vec<BlockRect>,
    /// Sum of the block areas (`0..=1`); overlapping blocks count twice, so this
    /// is a rough "how much of this page is text", not a union.
    pub covered: f32,
}

impl RegionReport {
    /// The known text rectangles that overlap `rect`.
    pub fn regions_in(&self, rect: BlockRect) -> Vec<BlockRect> {
        let target = clamp(rect);
        self.text_regions.iter().copied().filter(|region| overlap(*region, target) > 0.).collect()
    }

    /// Whether the page already has text in `rect`.
    pub fn has_text_in(&self, rect: BlockRect) -> bool {
        let target = clamp(rect);
        self.text_regions.iter().any(|region| overlap(*region, target) > 0.)
    }

    /// Whether `rect` still needs an OCR pass, i.e. it holds no known text.
    pub fn needs_ocr(&self, rect: BlockRect) -> bool { !self.has_text_in(rect) }
}

fn overlap(left: BlockRect, right: BlockRect) -> f32 {
    let width = (left.x + left.width).min(right.x + right.width) - left.x.max(right.x);
    let height = (left.y + left.height).min(right.y + right.height) - left.y.max(right.y);
    width.max(0.) * height.max(0.)
}

/// The page's size and the text it already has.
pub fn inspect(frame: &PageFrame) -> RegionReport {
    let mut covered = 0.;
    let text_regions: Vec<BlockRect> = frame.blocks.iter().map(|block| {
        covered += block.rect.width.max(0.) * block.rect.height.max(0.);
        block.rect
    }).collect();
    RegionReport { width: frame.original.width(), height: frame.original.height(), region_count: text_regions.len(), text_regions, covered: covered.min(1.) }
}

/// Why a tool call produced nothing.
#[derive(Clone, Debug, PartialEq)]
pub enum ToolError {
    /// The trace's step budget is spent; the call never ran.
    BudgetExceeded { used: usize, max: usize },
    /// The OCR engine's own message, passed through unchanged.
    Ocr(String),
}

impl std::fmt::Display for ToolError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::BudgetExceeded { used, max } => write!(formatter, "{} ({used}/{max})", crate::i18n::tr3("工具调用次数已用尽", "Tool-call budget exhausted", "Đã dùng hết số lần gọi công cụ")),
            Self::Ocr(message) => formatter.write_str(message),
        }
    }
}

impl std::error::Error for ToolError {}

/// One audited agent call.
#[derive(Clone, Debug, PartialEq)]
pub struct TraceEntry {
    pub tool: &'static str,
    pub args: String,
    pub duration_ms: u64,
    pub result_rects: Vec<BlockRect>,
}

/// What a tool returned, in the page rectangles an auditor can look up later.
pub trait ResultRects {
    fn result_rects(&self) -> Vec<BlockRect>;
}

impl ResultRects for () {
    fn result_rects(&self) -> Vec<BlockRect> { Vec::new() }
}

impl ResultRects for RgbaImage {
    /// A raster result carries no page rectangle of its own; the region it was
    /// asked for is in [`TraceEntry::args`].
    fn result_rects(&self) -> Vec<BlockRect> { Vec::new() }
}

impl ResultRects for RegionReport {
    fn result_rects(&self) -> Vec<BlockRect> { self.text_regions.clone() }
}

impl ResultRects for Vec<TextBlock> {
    fn result_rects(&self) -> Vec<BlockRect> { self.iter().map(|block| block.rect).collect() }
}

/// The audit trail of one run: one [`TraceEntry`] per call that ran, and the
/// `max_steps` budget that decides when the run must stop.
#[derive(Clone, Debug)]
pub struct ToolTrace {
    max_steps: usize,
    entries: Vec<TraceEntry>,
}

impl Default for ToolTrace {
    fn default() -> Self { Self::new(DEFAULT_MAX_STEPS) }
}

impl ToolTrace {
    pub fn new(max_steps: usize) -> Self { Self { max_steps, entries: Vec::new() } }

    pub fn max_steps(&self) -> usize { self.max_steps }

    pub fn steps(&self) -> usize { self.entries.len() }

    pub fn entries(&self) -> &[TraceEntry] { &self.entries }

    pub fn is_exhausted(&self) -> bool { self.entries.len() >= self.max_steps }

    /// Runs one call under the step budget: timed and recorded (a failed call
    /// included, with no rectangles). A call refused by the budget never runs
    /// and adds no entry, so the trace only ever holds calls that happened.
    pub fn call<T: ResultRects>(&mut self, tool: &'static str, args: impl Into<String>, work: impl FnOnce() -> Result<T, ToolError>) -> Result<T, ToolError> {
        if self.is_exhausted() {
            return Err(ToolError::BudgetExceeded { used: self.entries.len(), max: self.max_steps });
        }
        let args = args.into();
        let started = std::time::Instant::now();
        let outcome = work();
        let duration_ms = started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;
        let result_rects = match &outcome { Ok(value) => value.result_rects(), Err(_) => Vec::new() };
        self.entries.push(TraceEntry { tool, args, duration_ms, result_rects });
        outcome
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;
    use std::cell::RefCell;

    fn frame(width: u32, height: u32) -> PageFrame {
        let image = RgbaImage::from_pixel(width, height, Rgba([250, 250, 250, 255]));
        PageFrame { original: image.clone(), clean: image, blocks: Vec::new(), title: "page".into(), page_index: 0, page_count: 1, quality: String::new(), document_digest: "digest".into() }
    }

    fn block(id: u64, rect: BlockRect) -> TextBlock {
        TextBlock { id, source: format!("line {id}"), translated: None, rect, background: None, font_size: 12., bold: false }
    }

    fn pixels(bounds: PixelCrop) -> (u32, u32, u32, u32) { (bounds.x, bounds.y, bounds.width, bounds.height) }

    fn assert_close(actual: BlockRect, expected: BlockRect) {
        for (left, right) in [(actual.x, expected.x), (actual.y, expected.y), (actual.width, expected.width), (actual.height, expected.height)] {
            assert!((left - right).abs() < 1e-6, "{actual:?} != {expected:?}");
        }
    }

    /// Fixed blocks in crop space, plus the raster sizes it was handed, so a
    /// test can prove OCR ran on the crop and not on the page.
    struct StubOcr {
        blocks: Vec<BlockRect>,
        seen: RefCell<Vec<(u32, u32)>>,
    }

    impl StubOcr {
        fn new(blocks: Vec<BlockRect>) -> Self { Self { blocks, seen: RefCell::new(Vec::new()) } }
    }

    impl OcrEngine for StubOcr {
        fn recognize(&self, image: &RgbaImage) -> Result<Vec<TextBlock>, String> {
            self.seen.borrow_mut().push(image.dimensions());
            Ok(self.blocks.iter().enumerate().map(|(id, rect)| block(id as u64, *rect)).collect())
        }
    }

    #[test]
    fn crop_clamps_rectangles_to_the_page() {
        let page = frame(200, 100);
        assert_eq!(crop(&page, BlockRect { x: 0., y: 0., width: 1., height: 1. }).dimensions(), (200, 100));
        assert_eq!(crop(&page, BlockRect { x: 0.1, y: 0.2, width: 0.3, height: 0.4 }).dimensions(), (60, 40));
        assert_eq!(crop(&page, BlockRect { x: 0.9, y: 0.85, width: 0.5, height: 0.5 }).dimensions(), (20, 15));
        assert_eq!(pixels(page_pixels(&page, BlockRect { x: 0.9, y: 0.85, width: 0.5, height: 0.5 })), (180, 85, 20, 15));
        assert_eq!(pixels(page_pixels(&page, BlockRect { x: 1.5, y: -2., width: 0.5, height: 0.5 })), (199, 0, 1, 1));
        assert_eq!(crop(&page, BlockRect { x: 1.5, y: -2., width: 0.5, height: 0.5 }).dimensions(), (1, 1));
        assert_eq!(crop(&page, BlockRect { x: f32::NAN, y: 0.5, width: f32::NAN, height: 0.5 }).dimensions(), (1, 50));
    }

    #[test]
    fn zoom_changes_dimensions_exactly() {
        let image = RgbaImage::from_pixel(40, 24, Rgba([0, 0, 0, 255]));
        assert_eq!(zoom(&image, 3.).dimensions(), (120, 72));
        assert_eq!(zoom(&image, 2.5).dimensions(), (100, 60));
        assert_eq!(zoom(&image, MAX_ZOOM).dimensions(), (320, 192));
        assert_eq!(zoom(&image, MAX_ZOOM * 4.).dimensions(), (320, 192));
        assert_eq!(zoom(&image, 1.).dimensions(), (40, 24));
        assert_eq!(zoom(&image, 0.25).dimensions(), (40, 24));

        let mut pixels = RgbaImage::from_pixel(2, 2, Rgba([10, 20, 30, 255]));
        pixels.put_pixel(1, 0, Rgba([200, 0, 0, 255]));
        let enlarged = zoom(&pixels, 2.);
        assert_eq!(enlarged.dimensions(), (4, 4));
        assert_eq!(enlarged.get_pixel(1, 1).0, [10, 20, 30, 255], "nearest neighbour copies the source pixel, it never blends one");
    }

    #[test]
    fn quarter_turn_swaps_width_and_height() {
        let image = RgbaImage::from_pixel(4, 2, Rgba([1, 2, 3, 255]));
        assert_eq!(rotate(&image, 90).dimensions(), (2, 4));
        assert_eq!(rotate(&image, 270).dimensions(), (2, 4));
        assert_eq!(rotate(&image, 180).dimensions(), (4, 2));
        assert_eq!(rotate(&image, 0).dimensions(), (4, 2));
        assert_eq!(rotate(&image, 45).dimensions(), (4, 2));

        let mut row = RgbaImage::from_pixel(2, 1, Rgba([9, 9, 9, 255]));
        row.put_pixel(1, 0, Rgba([200, 200, 200, 255]));
        let turned = rotate(&row, 90);
        assert_eq!(turned.get_pixel(0, 0).0, [9, 9, 9, 255]);
        assert_eq!(turned.get_pixel(0, 1).0, [200, 200, 200, 255]);
    }

    #[test]
    fn ocr_region_maps_crop_coordinates_back_to_the_page() {
        let page = frame(200, 100);
        let engine = StubOcr::new(vec![
            BlockRect { x: 0.10, y: 0.50, width: 0.20, height: 0.25 },
            BlockRect { x: 0.60, y: 0.10, width: 0.30, height: 0.20 },
        ]);
        let region = BlockRect { x: 0.25, y: 0.20, width: 0.50, height: 0.60 };
        let blocks = ocr_region(&page, region, &engine).expect("the stub engine always finds its blocks");
        assert_eq!(engine.seen.borrow().as_slice(), &[(100, 60)], "OCR must see the crop, not the page");
        assert_eq!(blocks.len(), 2);
        assert_close(blocks[0].rect, BlockRect { x: 0.30, y: 0.50, width: 0.10, height: 0.15 });
        assert_close(blocks[1].rect, BlockRect { x: 0.55, y: 0.26, width: 0.15, height: 0.12 });
        assert_eq!(blocks[0].source, "line 0");
        assert_eq!(blocks[1].id, 1);
        assert!(blocks.iter().all(|block| block.rect.is_valid()));
        assert!((blocks[0].rect.x - 0.10).abs() > 1e-6, "the crop-space x must not leak through");
    }

    #[test]
    fn ocr_region_translates_through_a_clamped_crop_window() {
        let page = frame(200, 100);
        let engine = StubOcr::new(vec![BlockRect { x: 0., y: 0., width: 1., height: 1. }]);
        let blocks = ocr_region(&page, BlockRect { x: 0.8, y: 0.7, width: 0.5, height: 0.5 }, &engine).expect("the stub engine answers");
        assert_eq!(engine.seen.borrow().as_slice(), &[(40, 30)]);
        assert_close(blocks[0].rect, BlockRect { x: 0.8, y: 0.7, width: 0.2, height: 0.3 });
    }

    #[test]
    fn inspect_reports_page_size_and_existing_text() {
        let mut page = frame(300, 150);
        page.blocks = vec![block(0, BlockRect { x: 0.1, y: 0.1, width: 0.2, height: 0.2 }), block(1, BlockRect { x: 0.6, y: 0.6, width: 0.1, height: 0.1 })];
        let report = inspect(&page);
        assert_eq!((report.width, report.height), (300, 150));
        assert_eq!(report.region_count, 2);
        assert_eq!(report.text_regions.len(), 2);
        assert!((report.covered - 0.05).abs() < 1e-6);
        assert!(report.has_text_in(BlockRect { x: 0.15, y: 0.15, width: 0.05, height: 0.05 }));
        assert!(report.needs_ocr(BlockRect { x: 0.4, y: 0.4, width: 0.1, height: 0.1 }));
        assert_eq!(report.regions_in(BlockRect { x: 0.05, y: 0.05, width: 0.3, height: 0.3 }).len(), 1);
        assert!(!report.has_text_in(BlockRect { x: 0.2, y: 0.3, width: 0.1, height: 0.1 }), "no overlap means no text");
    }

    #[test]
    fn trace_records_one_entry_per_call_with_the_tool_name() {
        let mut page = frame(200, 100);
        page.blocks = vec![block(0, BlockRect { x: 0.1, y: 0.1, width: 0.2, height: 0.2 })];
        let engine = StubOcr::new(vec![BlockRect { x: 0., y: 0., width: 0.5, height: 0.5 }]);
        let region = BlockRect { x: 0.25, y: 0.20, width: 0.50, height: 0.60 };
        let mut trace = ToolTrace::new(4);
        let report = trace.call("inspect", "page".to_string(), || Ok(inspect(&page))).expect("inspect runs");
        let blocks = trace.call("ocr_region", format!("{region:?}"), || ocr_region(&page, region, &engine)).expect("ocr_region runs");
        trace.call("crop", "region", || Ok(crop(&page, region))).expect("crop runs");
        assert_eq!(trace.steps(), 3);
        assert_eq!(trace.entries().len(), 3);
        assert_eq!(trace.entries().iter().map(|entry| entry.tool).collect::<Vec<_>>(), ["inspect", "ocr_region", "crop"]);
        assert_eq!(trace.entries()[0].result_rects, report.text_regions);
        assert_eq!(trace.entries()[1].result_rects, blocks.iter().map(|block| block.rect).collect::<Vec<_>>());
        assert!(trace.entries()[2].result_rects.is_empty(), "a raster result reports no page rectangles");
        assert!(trace.entries()[1].args.contains("x:"));
        assert!(!trace.is_exhausted());
    }

    #[test]
    fn budget_refuses_calls_past_max_steps() {
        let page = frame(40, 40);
        let region = BlockRect { x: 0., y: 0., width: 1., height: 1. };
        let mut trace = ToolTrace::new(2);
        trace.call("crop", "first", || Ok(crop(&page, region))).expect("first call fits the budget");
        trace.call("crop", "second", || Ok(crop(&page, region))).expect("second call fits the budget");
        assert!(trace.is_exhausted());
        let error = trace.call("crop", "third", || Ok(crop(&page, region))).expect_err("the budget is spent");
        assert_eq!(error, ToolError::BudgetExceeded { used: 2, max: 2 });
        assert_eq!(trace.steps(), 2, "a refused call adds no entry");
        assert!(error.to_string().contains("2/2"));
    }

    #[test]
    fn failed_calls_are_recorded_without_rectangles() {
        let mut trace = ToolTrace::new(1);
        let error = trace.call("ocr_region", "page", || Err::<Vec<TextBlock>, _>(ToolError::Ocr("no engine installed".into()))).expect_err("the engine failed");
        assert_eq!(error, ToolError::Ocr("no engine installed".into()));
        assert_eq!(error.to_string(), "no engine installed");
        assert_eq!(trace.steps(), 1);
        assert_eq!(trace.entries()[0].tool, "ocr_region");
        assert!(trace.entries()[0].result_rects.is_empty());
        assert!(trace.is_exhausted());
    }
}
