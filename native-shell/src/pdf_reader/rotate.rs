use image::imageops;
use mirror_pdf_desktop::model::{BlockRect, PageFrame};

pub fn rotate_rect(rect: BlockRect, rotation: u16) -> BlockRect {
    let BlockRect { x, y, width, height } = rect;
    match rotation % 360 {
        90 => BlockRect { x: 1. - y - height, y: x, width: height, height: width },
        180 => BlockRect { x: 1. - x - width, y: 1. - y - height, width, height },
        270 => BlockRect { x: y, y: 1. - x - width, width: height, height: width },
        _ => rect,
    }
}

pub fn rotate_frame(mut frame: PageFrame, rotation: u16) -> PageFrame {
    match rotation % 360 {
        90 => {
            frame.original = imageops::rotate90(&frame.original);
            frame.clean = imageops::rotate90(&frame.clean);
        }
        180 => {
            frame.original = imageops::rotate180(&frame.original);
            frame.clean = imageops::rotate180(&frame.clean);
        }
        270 => {
            frame.original = imageops::rotate270(&frame.original);
            frame.clean = imageops::rotate270(&frame.clean);
        }
        _ => return frame,
    }
    for block in &mut frame.blocks {
        block.rect = rotate_rect(block.rect, rotation);
    }
    frame
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgba, RgbaImage};
    use mirror_pdf_desktop::model::TextBlock;

    fn rect() -> BlockRect { BlockRect { x: 0.1, y: 0.2, width: 0.3, height: 0.4 } }

    fn assert_close(actual: BlockRect, expected: BlockRect) {
        for (left, right) in [(actual.x, expected.x), (actual.y, expected.y), (actual.width, expected.width), (actual.height, expected.height)] {
            assert!((left - right).abs() < 1e-6, "{actual:?} != {expected:?}");
        }
    }

    #[test]
    fn quarter_turns_transform_normalized_rects() {
        assert_close(rotate_rect(rect(), 0), rect());
        assert_close(rotate_rect(rect(), 90), BlockRect { x: 0.4, y: 0.1, width: 0.4, height: 0.3 });
        assert_close(rotate_rect(rect(), 180), BlockRect { x: 0.6, y: 0.4, width: 0.3, height: 0.4 });
        assert_close(rotate_rect(rect(), 270), BlockRect { x: 0.2, y: 0.6, width: 0.4, height: 0.3 });
    }

    #[test]
    fn frame_dimensions_and_blocks_rotate_together() {
        let image = RgbaImage::from_pixel(4, 2, Rgba([10, 20, 30, 255]));
        let frame = PageFrame {
            original: image.clone(),
            clean: image,
            blocks: vec![TextBlock { id: 1, source: "text".into(), translated: None, rect: rect(), background: None, font_size: 12., bold: false }],
            title: "page".into(),
            page_index: 0,
            page_count: 1,
            quality: String::new(),
            document_digest: "digest".into(),
        };
        let rotated = rotate_frame(frame, 90);
        assert_eq!(rotated.original.dimensions(), (2, 4));
        assert_close(rotated.blocks[0].rect, BlockRect { x: 0.4, y: 0.1, width: 0.4, height: 0.3 });
    }
}
