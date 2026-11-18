use mirror_pdf_desktop::pdf;
use std::path::Path;

#[test]
fn real_pdf_reopens_and_preserves_artwork_when_text_is_removed() {
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/mirror-field-notes.pdf");
    for page in [0, 1, 0] {
        let frame = pdf::load_page(&fixture, page, None).unwrap();
        assert_eq!(frame.page_count, 4);
        assert!(!frame.blocks.is_empty());
        assert_eq!(frame.original.dimensions(), frame.clean.dimensions());
        assert!(frame.original.pixels().zip(frame.clean.pixels()).any(|(a,b)| a != b));
        if page == 0 {
            let x = (frame.original.width() as f32 * 0.70) as u32;
            let y = (frame.original.height() as f32 * 0.48) as u32;
            assert_eq!(frame.original.get_pixel(x,y),frame.clean.get_pixel(x,y),"Chart artwork changed");
        }
    }
}
