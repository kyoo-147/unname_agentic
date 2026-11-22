use image::{Rgba, RgbaImage};
use mirror_pdf_desktop::{
    model::{self, BlockRect, TextBlock},
    ocr_fallback,
};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

const MAX_DESKEW_DEGREES: f32 = 8.0;
const MAX_DEWARP_SHIFT: f32 = 0.15;

#[derive(Clone, Debug, PartialEq)]
pub struct RowWarp {
    /// Displacement in normalized page-width units, sampled at normalized y positions.
    pub samples: Vec<(f32, f32)>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct PreprocessOptions {
    pub grayscale: bool,
    /// Positive values rotate clockwise in image coordinates.
    pub deskew_degrees: f32,
    pub dewarp: Option<RowWarp>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum OcrMarkupError {
    InvalidInput(String),
    Unavailable(String),
    Cancelled,
}

impl std::fmt::Display for OcrMarkupError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidInput(message) => write!(f, "invalid OCR input: {message}"),
            Self::Unavailable(message) => write!(f, "OCR engine unavailable: {message}"),
            Self::Cancelled => f.write_str("OCR derivation cancelled"),
        }
    }
}

impl std::error::Error for OcrMarkupError {}

#[derive(Clone, Debug, PartialEq)]
pub struct OcrBlock {
    pub id: String,
    pub page: usize,
    pub reading_order: usize,
    pub text: String,
    /// Normalized top-left-origin geometry mapped back to the immutable source page.
    pub rect: BlockRect,
    /// `None` means the engine did not provide confidence. It is never synthesized.
    pub confidence: Option<f32>,
    pub provenance: OcrProvenance,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SourceTransform {
    Ocr,
    Unknown,
}

#[derive(Clone, Debug, PartialEq)]
pub struct OcrProvenance {
    pub source_sha256: String,
    pub engine: Option<String>,
    pub transform: SourceTransform,
    pub preprocessing: PreprocessOptions,
}

#[derive(Clone, Debug)]
pub struct OcrPage {
    pub page: usize,
    pub width: u32,
    pub height: u32,
    /// Original page pixels are retained independently of preprocessing.
    pub source_pixels: Arc<RgbaImage>,
    pub blocks: Vec<OcrBlock>,
}

#[derive(Clone, Debug)]
pub struct OcrDocument {
    pub source_bytes: Arc<[u8]>,
    pub source_sha256: String,
    pub pages: Vec<OcrPage>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MarkupType {
    Heading,
    List,
    Paragraph,
    Other,
}

#[derive(Clone, Debug, PartialEq)]
pub struct MarkupNode {
    pub id: String,
    pub page: usize,
    pub text: String,
    pub rect: BlockRect,
    pub kind: MarkupType,
    pub confidence: Option<f32>,
    pub evidence: MarkupEvidence,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MarkupEvidence {
    Ocr { engine: String },
    Unknown,
}

pub trait OcrEngine {
    fn recognize(&self, image: &RgbaImage) -> Result<OcrEngineOutput, String>;
}

#[derive(Clone, Debug, PartialEq)]
pub struct OcrEngineOutput {
    pub engine: String,
    pub blocks: Vec<EngineBlock>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct EngineBlock {
    pub text: String,
    pub rect: BlockRect,
    pub confidence: Option<f32>,
}

/// Uses the installed local OCR adapter. Errors are preserved instead of creating blank or guessed text.
pub struct LocalOcrEngine;

impl OcrEngine for LocalOcrEngine {
    fn recognize(&self, image: &RgbaImage) -> Result<OcrEngineOutput, String> {
        let recognized = ocr_fallback::recognize(image).map_err(|error| format!("{error:#}"))?;
        Ok(OcrEngineOutput {
            engine: format!("{} OCR", recognized.engine.title()),
            blocks: recognized
                .blocks
                .into_iter()
                .map(|block| EngineBlock {
                    text: block.source,
                    rect: block.rect,
                    confidence: None,
                })
                .collect(),
        })
    }
}

/// Returns a fully derived document only after every page succeeds. Source bytes and pixels are not mutated.
pub fn recognize_document(
    source_bytes: Arc<[u8]>,
    page_images: &[RgbaImage],
    options: &PreprocessOptions,
    engine: &dyn OcrEngine,
    cancelled: &AtomicBool,
) -> Result<OcrDocument, OcrMarkupError> {
    if source_bytes.is_empty() {
        return Err(OcrMarkupError::InvalidInput(
            "source bytes are empty".into(),
        ));
    }
    if page_images.is_empty() {
        return Err(OcrMarkupError::InvalidInput("document has no pages".into()));
    }
    validate_options(options)?;
    let source_sha256 = model::digest(&source_bytes);
    let mut pages = Vec::with_capacity(page_images.len());
    for (page_index, source_image) in page_images.iter().enumerate() {
        check_cancelled(cancelled)?;
        if source_image.width() == 0 || source_image.height() == 0 {
            return Err(OcrMarkupError::InvalidInput(format!(
                "page {} has empty pixels",
                page_index + 1
            )));
        }
        let processed = preprocess(source_image, options);
        let found = engine
            .recognize(&processed)
            .map_err(OcrMarkupError::Unavailable)?;
        check_cancelled(cancelled)?;
        if found.engine.trim().is_empty() {
            return Err(OcrMarkupError::InvalidInput(
                "engine returned no identity".into(),
            ));
        }
        let mut blocks = Vec::with_capacity(found.blocks.len());
        for item in found.blocks {
            if item.text.trim().is_empty() {
                continue;
            }
            if !item.rect.is_valid()
                || item
                    .confidence
                    .is_some_and(|value| !value.is_finite() || !(0.0..=1.0).contains(&value))
            {
                return Err(OcrMarkupError::InvalidInput(format!(
                    "page {} engine returned invalid block geometry or confidence",
                    page_index + 1
                )));
            }
            let rect = processed_rect_to_source(item.rect, options);
            if !rect.is_valid() {
                return Err(OcrMarkupError::InvalidInput(format!(
                    "page {} transform produced invalid geometry",
                    page_index + 1
                )));
            }
            let reading_order = blocks.len();
            blocks.push(OcrBlock {
                id: format!("p{}-r{}", page_index + 1, reading_order),
                page: page_index + 1,
                reading_order,
                text: item.text,
                rect,
                confidence: item.confidence,
                provenance: OcrProvenance {
                    source_sha256: source_sha256.clone(),
                    engine: Some(found.engine.clone()),
                    transform: SourceTransform::Ocr,
                    preprocessing: options.clone(),
                },
            });
        }
        pages.push(OcrPage {
            page: page_index + 1,
            width: source_image.width(),
            height: source_image.height(),
            source_pixels: Arc::new(source_image.clone()),
            blocks,
        });
    }
    check_cancelled(cancelled)?;
    Ok(OcrDocument {
        source_bytes,
        source_sha256,
        pages,
    })
}

/// Extracts conservative markup from OCR blocks without claiming OCR or semantic confidence.
pub fn extract_markup(document: &OcrDocument) -> Vec<MarkupNode> {
    document
        .pages
        .iter()
        .flat_map(|page| page.blocks.iter())
        .map(|block| {
            let trimmed = block.text.trim();
            let kind = if is_list_item(trimmed) {
                MarkupType::List
            } else if trimmed.len() <= 120
                && (trimmed.chars().all(|ch| !ch.is_lowercase()) || trimmed.ends_with(':'))
            {
                MarkupType::Heading
            } else {
                MarkupType::Paragraph
            };
            MarkupNode {
                id: block.id.clone(),
                page: block.page,
                text: block.text.clone(),
                rect: block.rect,
                kind,
                confidence: block.confidence,
                evidence: match (block.provenance.transform, &block.provenance.engine) {
                    (SourceTransform::Ocr, Some(engine)) => MarkupEvidence::Ocr {
                        engine: engine.clone(),
                    },
                    _ => MarkupEvidence::Unknown,
                },
            }
        })
        .collect()
}

/// Renders extracted nodes as Markdown without modifying source text.
pub fn render_markup_markdown(nodes: &[MarkupNode]) -> String {
    nodes
        .iter()
        .filter_map(|node| {
            let text = node.text.trim();
            if text.is_empty() {
                return None;
            }
            Some(match node.kind {
                MarkupType::Heading => format!("# {text}"),
                MarkupType::List if !is_list_item(text) => format!("- {text}"),
                _ => text.to_string(),
            })
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// Converts native reader blocks without changing their page identity or inventing confidence.
pub fn blocks_from_reader(
    page: usize,
    blocks: &[TextBlock],
    source_sha256: &str,
    engine: Option<&str>,
) -> Vec<OcrBlock> {
    blocks
        .iter()
        .enumerate()
        .map(|(reading_order, block)| OcrBlock {
            id: format!("p{}-r{}", page + 1, reading_order),
            page: page + 1,
            reading_order,
            text: block.source.clone(),
            rect: block.rect,
            confidence: None,
            provenance: OcrProvenance {
                source_sha256: source_sha256.to_string(),
                engine: engine.map(str::to_string),
                transform: if engine.is_some() {
                    SourceTransform::Ocr
                } else {
                    SourceTransform::Unknown
                },
                preprocessing: PreprocessOptions::default(),
            },
        })
        .collect()
}

fn validate_options(options: &PreprocessOptions) -> Result<(), OcrMarkupError> {
    if !options.deskew_degrees.is_finite() || options.deskew_degrees.abs() > MAX_DESKEW_DEGREES {
        return Err(OcrMarkupError::InvalidInput(format!(
            "deskew angle must be finite and within ±{MAX_DESKEW_DEGREES} degrees"
        )));
    }
    if let Some(warp) = &options.dewarp {
        if warp.samples.len() < 2
            || warp.samples.first().map(|sample| sample.0) != Some(0.0)
            || warp.samples.last().map(|sample| sample.0) != Some(1.0)
        {
            return Err(OcrMarkupError::InvalidInput(
                "dewarp samples must include ordered y endpoints 0 and 1".into(),
            ));
        }
        let mut previous = -1.0;
        for &(y, shift) in &warp.samples {
            if !y.is_finite()
                || !shift.is_finite()
                || y <= previous
                || !(0.0..=1.0).contains(&y)
                || shift.abs() > MAX_DEWARP_SHIFT
            {
                return Err(OcrMarkupError::InvalidInput(
                    "dewarp samples must be finite, ordered, and bounded to ±0.15 page widths"
                        .into(),
                ));
            }
            previous = y;
        }
    }
    Ok(())
}

fn preprocess(source: &RgbaImage, options: &PreprocessOptions) -> RgbaImage {
    let (width, height) = source.dimensions();
    let radians = options.deskew_degrees.to_radians();
    let (sin, cos) = radians.sin_cos();
    let mut output = RgbaImage::new(width, height);
    for y in 0..height {
        for x in 0..width {
            let (sx, sy) = processed_to_source(
                x as f32 / width as f32,
                y as f32 / height as f32,
                options,
                sin,
                cos,
            );
            let px = (sx * width as f32).round() as i32;
            let py = (sy * height as f32).round() as i32;
            let mut pixel = if px >= 0 && py >= 0 && px < width as i32 && py < height as i32 {
                *source.get_pixel(px as u32, py as u32)
            } else {
                Rgba([255, 255, 255, 255])
            };
            if options.grayscale {
                let gray = ((u32::from(pixel[0]) * 299
                    + u32::from(pixel[1]) * 587
                    + u32::from(pixel[2]) * 114
                    + 500)
                    / 1000) as u8;
                pixel[0] = gray;
                pixel[1] = gray;
                pixel[2] = gray;
            }
            output.put_pixel(x, y, pixel);
        }
    }
    output
}

fn processed_to_source(
    x: f32,
    y: f32,
    options: &PreprocessOptions,
    sin: f32,
    cos: f32,
) -> (f32, f32) {
    let warped_x = x - row_shift(options.dewarp.as_ref(), y);
    let dx = warped_x - 0.5;
    let dy = y - 0.5;
    let source_x = cos * dx + sin * dy + 0.5;
    let source_y = -sin * dx + cos * dy + 0.5;
    (source_x, source_y)
}

fn row_shift(warp: Option<&RowWarp>, y: f32) -> f32 {
    let Some(warp) = warp else {
        return 0.0;
    };
    for pair in warp.samples.windows(2) {
        if y <= pair[1].0 {
            let (y0, x0) = pair[0];
            let (y1, x1) = pair[1];
            let ratio = ((y - y0) / (y1 - y0)).clamp(0.0, 1.0);
            return x0 + (x1 - x0) * ratio;
        }
    }
    warp.samples.last().map_or(0.0, |sample| sample.1)
}

fn processed_rect_to_source(rect: BlockRect, options: &PreprocessOptions) -> BlockRect {
    let radians = options.deskew_degrees.to_radians();
    let (sin, cos) = radians.sin_cos();
    let corners = [
        (rect.x, rect.y),
        (rect.x + rect.width, rect.y),
        (rect.x + rect.width, rect.y + rect.height),
        (rect.x, rect.y + rect.height),
    ]
    .map(|(x, y)| processed_to_source(x, y, options, sin, cos));
    let left = corners
        .iter()
        .map(|p| p.0)
        .fold(f32::INFINITY, f32::min)
        .clamp(0.0, 1.0);
    let top = corners
        .iter()
        .map(|p| p.1)
        .fold(f32::INFINITY, f32::min)
        .clamp(0.0, 1.0);
    let right = corners
        .iter()
        .map(|p| p.0)
        .fold(f32::NEG_INFINITY, f32::max)
        .clamp(0.0, 1.0);
    let bottom = corners
        .iter()
        .map(|p| p.1)
        .fold(f32::NEG_INFINITY, f32::max)
        .clamp(0.0, 1.0);
    BlockRect {
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
    }
}

fn is_list_item(text: &str) -> bool {
    text.starts_with("- ")
        || text.starts_with("* ")
        || text.starts_with("• ")
        || text.starts_with("▪ ")
        || text.split_once('.').is_some_and(|(prefix, rest)| {
            !prefix.is_empty()
                && prefix.len() <= 3
                && prefix.chars().all(|c| c.is_ascii_digit())
                && rest.starts_with(' ')
        })
}

fn check_cancelled(cancelled: &AtomicBool) -> Result<(), OcrMarkupError> {
    if cancelled.load(Ordering::Acquire) {
        Err(OcrMarkupError::Cancelled)
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;
    use std::sync::atomic::AtomicBool;

    struct FakeEngine {
        blocks: Vec<EngineBlock>,
        fail: bool,
        cancel: Option<Arc<AtomicBool>>,
    }
    impl OcrEngine for FakeEngine {
        fn recognize(&self, _: &RgbaImage) -> Result<OcrEngineOutput, String> {
            if let Some(cancel) = &self.cancel {
                cancel.store(true, Ordering::Release);
            }
            if self.fail {
                Err("not installed".into())
            } else {
                Ok(OcrEngineOutput {
                    engine: "fixture-engine".into(),
                    blocks: self.blocks.clone(),
                })
            }
        }
    }

    fn source_image() -> RgbaImage {
        RgbaImage::from_pixel(20, 10, Rgba([255, 0, 0, 255]))
    }
    fn line(text: &str) -> EngineBlock {
        EngineBlock {
            text: text.into(),
            rect: BlockRect {
                x: 0.1,
                y: 0.2,
                width: 0.3,
                height: 0.2,
            },
            confidence: None,
        }
    }

    #[test]
    fn deterministic_grayscale_and_geometry_normalization_preserve_input_pixels() {
        let source = source_image();
        let options = PreprocessOptions {
            grayscale: true,
            deskew_degrees: 0.0,
            dewarp: None,
        };
        let engine = FakeEngine {
            blocks: vec![line("text")],
            fail: false,
            cancel: None,
        };
        let doc = recognize_document(
            Arc::from(&b"source bytes"[..]),
            &[source.clone()],
            &options,
            &engine,
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(source.get_pixel(0, 0).0, [255, 0, 0, 255]);
        assert_eq!(
            doc.pages[0].source_pixels.get_pixel(0, 0).0,
            [255, 0, 0, 255]
        );
        let mapped = doc.pages[0].blocks[0].rect;
        let expected = line("text").rect;
        assert!((mapped.x - expected.x).abs() < 1e-6);
        assert!((mapped.y - expected.y).abs() < 1e-6);
        assert!((mapped.width - expected.width).abs() < 1e-6);
        assert!((mapped.height - expected.height).abs() < 1e-6);
    }

    #[test]
    fn page_and_block_identity_and_provenance_are_stable() {
        let engine = FakeEngine {
            blocks: vec![line("first"), line("second")],
            fail: false,
            cancel: None,
        };
        let doc = recognize_document(
            Arc::from(&b"pdf"[..]),
            &[source_image(), source_image()],
            &PreprocessOptions::default(),
            &engine,
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!((doc.pages[1].page, doc.pages[1].blocks[0].page), (2, 2));
        assert_eq!(
            doc.pages[1]
                .blocks
                .iter()
                .map(|block| block.id.as_str())
                .collect::<Vec<_>>(),
            vec!["p2-r0", "p2-r1"]
        );
        assert_eq!(doc.pages[1].blocks[0].confidence, None);
        assert_eq!(
            doc.pages[1].blocks[0].provenance.source_sha256,
            doc.source_sha256
        );
        assert_eq!(
            doc.pages[1].blocks[0].provenance.engine.as_deref(),
            Some("fixture-engine")
        );
        assert_eq!(
            doc.pages[1].blocks[0].provenance.transform,
            SourceTransform::Ocr
        );
    }

    #[test]
    fn reader_conversion_without_receipt_stays_unverified() {
        let block = TextBlock {
            id: 5,
            source: "existing text".into(),
            translated: None,
            rect: line("existing").rect,
            background: None,
            font_size: 12.0,
            bold: false,
        };
        let converted = blocks_from_reader(2, &[block], "source-hash", None);
        assert_eq!(converted[0].id, "p3-r0");
        assert_eq!(converted[0].confidence, None);
        assert_eq!(converted[0].provenance.engine, None);
        assert_eq!(converted[0].provenance.transform, SourceTransform::Unknown);
    }

    #[test]
    fn dewarp_and_deskew_map_recognized_geometry_to_source_coordinates() {
        let engine = FakeEngine {
            blocks: vec![line("mapped")],
            fail: false,
            cancel: None,
        };
        let options = PreprocessOptions {
            grayscale: false,
            deskew_degrees: 2.0,
            dewarp: Some(RowWarp {
                samples: vec![(0.0, 0.0), (1.0, 0.1)],
            }),
        };
        let doc = recognize_document(
            Arc::from(&b"pdf"[..]),
            &[source_image()],
            &options,
            &engine,
            &AtomicBool::new(false),
        )
        .unwrap();
        let rect = doc.pages[0].blocks[0].rect;
        assert!(rect.x < 0.1, "dewarp shift and deskew map back: {rect:?}");
        assert!(rect.is_valid());
        let image = preprocess(
            &source_image(),
            &PreprocessOptions {
                grayscale: true,
                ..PreprocessOptions::default()
            },
        );
        assert_eq!(image.get_pixel(10, 5).0, [76, 76, 76, 255]);
    }

    #[test]
    fn invalid_skew_and_warp_limits_fail_closed() {
        let engine = FakeEngine {
            blocks: vec![],
            fail: false,
            cancel: None,
        };
        for options in [
            PreprocessOptions {
                deskew_degrees: 9.0,
                ..PreprocessOptions::default()
            },
            PreprocessOptions {
                dewarp: Some(RowWarp {
                    samples: vec![(0.0, 0.0), (1.0, 0.2)],
                }),
                ..PreprocessOptions::default()
            },
            PreprocessOptions {
                dewarp: Some(RowWarp {
                    samples: vec![(0.0, 0.0), (0.0, 0.1), (1.0, 0.0)],
                }),
                ..PreprocessOptions::default()
            },
        ] {
            let result = recognize_document(
                Arc::from(&b"pdf"[..]),
                &[source_image()],
                &options,
                &engine,
                &AtomicBool::new(false),
            );
            assert!(matches!(result, Err(OcrMarkupError::InvalidInput(_))));
        }
    }

    #[test]
    fn engine_unavailable_or_cancelled_never_returns_partial_document() {
        let unavailable = FakeEngine {
            blocks: vec![],
            fail: true,
            cancel: None,
        };
        assert!(matches!(
            recognize_document(
                Arc::from(&b"pdf"[..]),
                &[source_image()],
                &PreprocessOptions::default(),
                &unavailable,
                &AtomicBool::new(false)
            ),
            Err(OcrMarkupError::Unavailable(_))
        ));
        let cancelled = Arc::new(AtomicBool::new(false));
        let engine = FakeEngine {
            blocks: vec![line("partial")],
            fail: false,
            cancel: Some(cancelled.clone()),
        };
        assert_eq!(
            recognize_document(
                Arc::from(&b"pdf"[..]),
                &[source_image()],
                &PreprocessOptions::default(),
                &engine,
                &cancelled
            )
            .unwrap_err(),
            OcrMarkupError::Cancelled
        );
    }

    #[test]
    fn malformed_images_and_engine_geometry_are_rejected() {
        let engine = FakeEngine {
            blocks: vec![EngineBlock {
                rect: BlockRect {
                    x: f32::NAN,
                    y: 0.0,
                    width: 0.1,
                    height: 0.1,
                },
                ..line("invalid")
            }],
            fail: false,
            cancel: None,
        };
        assert!(matches!(
            recognize_document(
                Arc::from(&b"pdf"[..]),
                &[],
                &PreprocessOptions::default(),
                &engine,
                &AtomicBool::new(false)
            ),
            Err(OcrMarkupError::InvalidInput(_))
        ));
        assert!(matches!(
            recognize_document(
                Arc::from(&b""[..]),
                &[source_image()],
                &PreprocessOptions::default(),
                &engine,
                &AtomicBool::new(false)
            ),
            Err(OcrMarkupError::InvalidInput(_))
        ));
        assert!(matches!(
            recognize_document(
                Arc::from(&b"pdf"[..]),
                &[source_image()],
                &PreprocessOptions::default(),
                &engine,
                &AtomicBool::new(false)
            ),
            Err(OcrMarkupError::InvalidInput(_))
        ));
    }

    #[test]
    fn markup_is_deterministic_and_retains_evidence_without_fake_confidence() {
        let engine = FakeEngine {
            blocks: vec![line("SECTION TITLE"), line("- item"), line("body text")],
            fail: false,
            cancel: None,
        };
        let doc = recognize_document(
            Arc::from(&b"pdf"[..]),
            &[source_image()],
            &PreprocessOptions::default(),
            &engine,
            &AtomicBool::new(false),
        )
        .unwrap();
        let nodes = extract_markup(&doc);
        assert_eq!(
            nodes.iter().map(|node| node.kind).collect::<Vec<_>>(),
            vec![MarkupType::Heading, MarkupType::List, MarkupType::Paragraph]
        );
        assert_eq!(
            nodes[1].evidence,
            MarkupEvidence::Ocr {
                engine: "fixture-engine".into()
            }
        );
        assert_eq!(nodes[0].confidence, None);
        assert_eq!(extract_markup(&doc), nodes);
        assert_eq!(
            render_markup_markdown(&nodes),
            "# SECTION TITLE\n\n- item\n\nbody text"
        );
    }
}
