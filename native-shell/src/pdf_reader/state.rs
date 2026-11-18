#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Stamp { pub source: u64, pub profile: u64, pub request: u64 }

#[derive(Default)]
pub(crate) struct Epoch { source: u64, profile: u64, request: u64 }
impl Epoch {
    pub fn stamp(&self) -> Stamp { Stamp { source: self.source, profile: self.profile, request: self.request } }
    pub fn source(&mut self) { self.source = self.source.wrapping_add(1); self.request = self.request.wrapping_add(1); }
    pub fn profile(&mut self) { self.profile = self.profile.wrapping_add(1); self.request = self.request.wrapping_add(1); }
    pub fn cancel(&mut self) { self.request = self.request.wrapping_add(1); }
    pub fn accepts(&self, stamp: Stamp) -> bool { self.stamp() == stamp }
    pub fn same_source(&self, stamp: Stamp) -> bool { self.source == stamp.source }
}

pub(crate) fn page_step(page: u16, count: u16, step: i32) -> u16 {
    (i32::from(page) + step).clamp(0, i32::from(count.saturating_sub(1))) as u16
}

pub(crate) fn visible(y: f32, height: f32, top: f32, bottom: f32) -> bool {
    y.is_finite() && height.is_finite() && y + height >= top && y <= bottom
}

pub(crate) fn patch_bounds(rect: [f32; 4], width: u32, height: u32) -> (u32, u32, u32, u32) {
    let [x, y, w, h] = rect;
    let left = (x.max(0.) * width as f32).floor() as u32;
    let top = (y.max(0.) * height as f32).floor() as u32;
    let right = ((x + w) * width as f32).ceil().clamp(0., width as f32) as u32;
    let bottom = ((y + h) * height as f32).ceil().clamp(0., height as f32) as u32;
    (left.saturating_sub(4), top.saturating_sub(4), right.saturating_add(4).min(width), bottom.saturating_add(4).min(height))
}

pub(crate) fn preserve_formula(text: &str) -> bool {
    let math = text.chars().filter(|c| "=∑∫√∏≈≠≤≥∂∞∈⊂∀∃±×÷^_".contains(*c)).count();
    let words = text.split_whitespace().filter(|s| s.chars().filter(|c| c.is_alphabetic()).count() > 3).count();
    math > 0 && (words < 4 || math >= 3)
}

pub(crate) fn browser_gesture(linked: bool, active: bool, user_input: bool, page: u16, fraction: f32, zoom: f32) -> Option<(u16, f32, f32)> {
    (linked && active && user_input && fraction.is_finite() && zoom.is_finite()).then(|| (page, fraction.clamp(0., 1.), zoom.clamp(0.1, 10.)))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn only_explicit_native_gestures_can_publish_browser_location() {
        assert_eq!(browser_gesture(true, true, true, 2, 0.25, 1.5), Some((2, 0.25, 1.5)));
        assert_eq!(browser_gesture(true, true, false, 2, 0.25, 1.5), None);
        assert_eq!(browser_gesture(false, true, true, 2, 0.25, 1.5), None);
        assert_eq!(browser_gesture(true, false, true, 2, 0.25, 1.5), None);
        assert_eq!(browser_gesture(true, true, true, 2, f32::NAN, 1.), None);
    }
    #[test] fn navigation_is_bounded() {
        assert_eq!(page_step(0, 4, -1), 0);
        assert_eq!(page_step(3, 4, 1), 3);
        assert_eq!(page_step(1, 4, 1), 2);
        assert_eq!(page_step(0, 0, 1), 0);
    }
    #[test] fn page_change_rejects_old_network_and_pixels() {
        let mut epoch = Epoch::default(); let old = epoch.stamp(); epoch.source();
        assert!(!epoch.accepts(old)); assert!(!epoch.same_source(old));
    }
    #[test] fn profile_change_rejects_translation_but_keeps_pixels() {
        let mut epoch = Epoch::default(); let old = epoch.stamp(); epoch.profile();
        assert!(!epoch.accepts(old)); assert!(epoch.same_source(old));
    }
    #[test] fn pause_invalidates_inflight_request() {
        let mut epoch = Epoch::default(); let old = epoch.stamp(); epoch.cancel();
        assert!(!epoch.accepts(old)); assert!(epoch.same_source(old)); assert!(epoch.accepts(epoch.stamp()));
    }
    #[test] fn visibility_uses_intersection_not_block_start() {
        assert!(visible(0.1, 0.3, 0.25, 0.5)); assert!(!visible(0.6, 0.1, 0.2, 0.5));
        assert!(!visible(f32::NAN, 0.2, 0., 1.));
    }
    #[test] fn suppression_patch_covers_antialiasing_outside_text_bounds() {
        assert_eq!(patch_bounds([0.1, 0.2, 0.3, 0.1], 1000, 1000), (96, 196, 404, 304));
        assert_eq!(patch_bounds([0., 0., 1., 1.], 1000, 1000), (0, 0, 1000, 1000));
    }
    #[test] fn equations_remain_original() {
        assert!(preserve_formula("E = mc^2")); assert!(preserve_formula("∫ x dx = x² / 2"));
        assert!(!preserve_formula("The measured result is shown in the accompanying figure."));
        assert!(!preserve_formula("The measured expression x = y follows from the preceding argument."));
    }
}
