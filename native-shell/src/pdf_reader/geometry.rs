pub(super) const DIVIDER: f32 = 14.;
pub(super) const INSET: f32 = 16.;

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(super) struct Pane { pub page: [f32; 2], pub viewport: [f32; 2] }

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct Viewport { pub left: f32, pub top: f32, pub right: f32, pub bottom: f32 }
impl Viewport {
    pub fn intersects(self, rect: [f32; 4]) -> bool {
        let [x, y, w, h] = rect;
        [x, y, w, h].iter().all(|v| v.is_finite()) && w > 0. && h > 0.
            && x < self.right && x + w > self.left && y < self.bottom && y + h > self.top
    }
}

pub(super) fn divider_ratio(pointer: f32, left: f32, width: f32) -> f32 {
    if !pointer.is_finite() || !left.is_finite() || !width.is_finite() || width <= DIVIDER { return 0.5; }
    ((pointer - left - DIVIDER / 2.) / (width - DIVIDER)).clamp(0.3, 0.7)
}

impl Pane {
    pub fn new(viewport: [f32; 2], zoom: f32, aspect: f32) -> Self {
        let viewport = viewport.map(|v| if v.is_finite() { v.max(1.) } else { 1. });
        let width = (viewport[0] - INSET * 2.).max(1.) * zoom.clamp(0.55, 3.);
        Self { page: [width, width * aspect.max(0.01)], viewport }
    }
    pub fn visible(self, offset: [f32; 2]) -> Option<Viewport> {
        let left = ((offset[0] - INSET) / self.page[0]).clamp(0., 1.);
        let top = ((offset[1] - INSET) / self.page[1]).clamp(0., 1.);
        let right = ((offset[0] + self.viewport[0] - INSET) / self.page[0]).clamp(0., 1.);
        let bottom = ((offset[1] + self.viewport[1] - INSET) / self.page[1]).clamp(0., 1.);
        (right > left && bottom > top).then_some(Viewport { left, top, right, bottom })
    }
    pub fn content(self, limit: [f32; 2]) -> [f32; 2] {
        std::array::from_fn(|axis| (self.page[axis] + INSET * 2.).max(self.viewport[axis] + limit[axis] * self.page[axis]))
    }
}

pub(super) fn limits(panes: [Pane; 2], split: bool) -> [f32; 2] {
    std::array::from_fn(|axis| panes.iter().enumerate().filter(|(i, _)| split || *i == 1)
        .map(|(_, pane)| ((pane.page[axis] + INSET * 2. - pane.viewport[axis]) / pane.page[axis]).max(0.))
        .fold(0., f32::max))
}

#[derive(Default)]
pub(super) struct LinkedScroll { pub position: [f32; 2], expected: [[f32; 2]; 2] }
impl LinkedScroll {
    pub fn sync(&mut self, offsets: [[f32; 2]; 2], panes: [Pane; 2], split: bool, layout_changed: bool, last_input: usize) -> [[f32; 2]; 2] {
        let changed: [bool; 2] = std::array::from_fn(|i| (split || i == 1) && (0..2).any(|axis| (offsets[i][axis] - self.expected[i][axis]).abs() > 0.25));
        if !layout_changed && let Some(leader) = if changed[last_input] { Some(last_input) } else { changed.iter().position(|changed| *changed) } {
            self.position = std::array::from_fn(|axis| offsets[leader][axis] / panes[leader].page[axis]);
        }
        let limit = limits(panes, split);
        self.position = std::array::from_fn(|axis| if self.position[axis].is_finite() { self.position[axis].clamp(0., limit[axis]) } else { 0. });
        self.expected = std::array::from_fn(|i| std::array::from_fn(|axis| self.position[axis] * panes[i].page[axis]));
        self.expected
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn close(a: f32, b: f32) { assert!((a - b).abs() < 0.0001, "{a} != {b}"); }
    fn panes(zoom: f32) -> [Pane; 2] { [Pane::new([300., 420.], zoom, 1.414), Pane::new([700., 420.], zoom, 1.414)] }
    #[test] fn divider_drag_clamps_at_thirty_and_seventy_percent() {
        close(divider_ratio(100., 100., 1014.), 0.3);
        close(divider_ratio(1100., 100., 1014.), 0.7);
        close(divider_ratio(607., 100., 1014.), 0.5);
        close(divider_ratio(f32::NAN, 0., 1000.), 0.5);
    }
    #[test] fn unequal_panes_share_page_position_not_pixel_offset() {
        let panes = panes(1.); let mut linked = LinkedScroll::default();
        let out = linked.sync([[0., 75.], [0., 0.]], panes, true, false, 0);
        close(out[0][1] / panes[0].page[1], out[1][1] / panes[1].page[1]);
        assert!((out[0][1] - out[1][1]).abs() > 100.);
    }
    #[test] fn normalized_position_survives_zoom_and_divider_reflow() {
        let mut linked = LinkedScroll::default(); let old = panes(1.5);
        let first = linked.sync([[0., 125.], [0., 0.]], old, true, false, 0); let anchor = linked.position;
        let resized = [Pane::new([620., 420.], 2.3, 1.414), Pane::new([380., 420.], 2.3, 1.414)];
        let out = linked.sync(first, resized, true, true, 1);
        close(linked.position[1], anchor[1]);
        for i in 0..2 { close(out[i][1] / resized[i].page[1], anchor[1]); }
    }
    #[test] fn shared_extent_keeps_bottom_reachable_in_both_panes() {
        let panes = panes(1.); let limit = limits(panes, true); let mut linked = LinkedScroll::default();
        let out = linked.sync([[0., 0.], [0., 100000.]], panes, true, false, 1);
        for i in 0..2 {
            close(out[i][1] / panes[i].page[1], limit[1]);
            assert!(out[i][1] <= panes[i].content(limit)[1] - panes[i].viewport[1] + 0.001);
        }
    }
    #[test] fn scheduler_uses_both_actual_normalized_viewport_rectangles() {
        let panes = panes(2.); let source = panes[0].visible([100., 160.]).unwrap(); let target = panes[1].visible([249.25374, 398.80597]).unwrap();
        assert!(source.bottom > target.bottom);
        let source_only = [0.2, (source.bottom + target.bottom) / 2., 0.02, 0.01];
        assert!(source.intersects(source_only)); assert!(!target.intersects(source_only));
        assert!(!source.intersects([0.99, 0.9, 0.01, 0.01]));
        assert!(!source.intersects([f32::NAN, 0., 0.2, 0.2]));
    }
    #[test] fn programmatic_scroll_echo_is_idempotent() {
        let panes = panes(2.); let mut linked = LinkedScroll::default();
        let expected = linked.sync([[100., 180.], [0., 0.]], panes, true, false, 0); let anchor = linked.position;
        for _ in 0..100 { assert_eq!(linked.sync(expected, panes, true, false, 1), expected); assert_eq!(linked.position, anchor); }
        let mut moved = expected; moved[1][1] += 20.;
        let out = linked.sync(moved, panes, true, false, 1);
        close(out[0][1] / panes[0].page[1], out[1][1] / panes[1].page[1]);
        assert!(linked.position[1] > anchor[1]);
    }
    #[test] fn translation_only_ignores_hidden_source_scroll() {
        let panes = panes(2.); let mut linked = LinkedScroll::default();
        let out = linked.sync([[0., 1000.], [0., 120.]], panes, false, false, 0);
        close(out[1][1], 120.);
    }
    #[test] fn empty_or_fully_scrolled_out_page_has_no_visible_regions() {
        let pane = Pane::new([300., 420.], 1., 1.414);
        assert!(pane.visible([0., pane.page[1] + 100.]).is_none());
        let rect = pane.visible([0., 0.]).unwrap(); close(rect.top, 0.); close(rect.bottom, 1.);
    }
}
