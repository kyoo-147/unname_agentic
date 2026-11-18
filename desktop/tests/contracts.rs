use mirror_pdf_desktop::model::*;
use mirror_pdf_desktop::provider::validate_translations;

#[test]
fn delayed_results_cannot_cross_viewports_or_languages() {
    let mut guard = GenerationGuard::default();
    let old = guard.current();
    guard.invalidate();
    assert!(!guard.accepts(old));
    assert!(guard.accepts(guard.current()));
}

#[test]
fn normalized_rect_maps_without_changing_page_geometry() {
    let rect = BlockRect { x: 0.1, y: 0.2, width: 0.3, height: 0.1 };
    assert_eq!(rect.at_size(1000.0, 2000.0), [100.0, 400.0, 300.0, 200.0]);
}

#[test]
fn provider_must_return_exactly_one_translation_per_block() {
    assert!(validate_translations(vec!["bonjour".into()], 2).is_err());
    assert!(validate_translations(vec![" ".into()], 1).is_err());
    assert_eq!(validate_translations(vec!["xin chào".into()], 1).unwrap(), vec!["xin chào"]);
}

#[test]
fn cache_identity_changes_with_provider_model_and_language() {
    let mut config = ProviderSettings::default();
    let first = config.cache_key("hello");
    config.target_language = "fr".into();
    assert_ne!(first, config.cache_key("hello"));
    config.target_language = "vi".into();
    config.model = "different-model".into();
    assert_ne!(first, config.cache_key("hello"));
}

#[test]
fn detector_finds_page_inside_dark_viewer_not_browser_chrome() {
    let mut pixels = image::RgbaImage::from_pixel(800, 600, image::Rgba([40, 40, 40, 255]));
    for y in 90..570 { for x in 220..580 { pixels.put_pixel(x, y, image::Rgba([250, 250, 250, 255])); } }
    let crop = detect_document_region(&pixels).unwrap();
    assert!(crop.x >= 210 && crop.x <= 230, "{crop:?}");
    assert!(crop.y >= 80 && crop.y <= 100, "{crop:?}");
    assert!(crop.width >= 350 && crop.width <= 370);
}

#[test]
fn ocr_regions_never_erase_artwork_enclosed_by_a_flat_border() {
    let mut pixels = image::RgbaImage::from_pixel(200, 100, image::Rgba([255, 255, 255, 255]));
    for y in 30..60 { for x in 70..120 { pixels.put_pixel(x, y, image::Rgba([18, 110, 190, 255])); } }
    let mut blocks = vec![TextBlock { id: 0, source: "Text around a logo".into(), translated: None, rect: BlockRect { x: 0.1, y: 0.1, width: 0.8, height: 0.7 }, background: None, font_size: 0.02, bold: false }];
    assert_eq!(suppress_flat_text(&pixels, &mut blocks), pixels);
    assert!(blocks[0].background.is_none());
}

#[test]
fn grouped_lines_use_full_union_when_indents_differ() {
    let make = |id, x, width, y| TextBlock { id, source: "Scientific reading".into(), translated: None, rect: BlockRect { x, y, width, height: 0.02 }, background: None, font_size: 0.02, bold: false };
    let grouped = group_lines(vec![make(0, 0.100, 0.400, 0.10), make(1, 0.090, 0.405, 0.13)]);
    assert_eq!(grouped.len(), 1);
    assert!((grouped[0].rect.x - 0.090).abs() < 0.0001);
    assert!((grouped[0].rect.x + grouped[0].rect.width - 0.500).abs() < 0.0001);
}

#[test]
fn detector_does_not_claim_uniform_black_capture_is_document() {
    let pixels = image::RgbaImage::from_pixel(640, 480, image::Rgba([0, 0, 0, 255]));
    assert!(detect_document_region(&pixels).is_none());
}
