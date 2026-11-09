use super::*;

#[derive(Clone, Copy)]
struct Grab { axis: usize, delta: f32 }
#[derive(Default)]
pub(super) struct Scrollbar { grab: Cell<Option<Grab>> }

impl Scrollbar {
    pub fn render(self: &Rc<Self>, handle: &ScrollHandle, pane: usize, last_input: Rc<Cell<usize>>, native_input: Rc<Cell<bool>>, entity: EntityId) -> impl IntoElement {
        let handle = handle.clone(); let state = self.clone();
        canvas(move |bounds, window, _| {
            let view = handle.bounds().size; let maximum = handle.max_offset(); let offset = handle.offset();
            let mut bars = Vec::new();
            for axis in 0..2 {
                let (length, visible, max, distance) = if axis == 0 {
                    (f32::from(bounds.size.width) - 12., f32::from(view.width), f32::from(maximum.width), -f32::from(offset.x))
                } else { (f32::from(bounds.size.height) - 12., f32::from(view.height), f32::from(maximum.height), -f32::from(offset.y)) };
                if max <= 0.5 || length <= 0. { continue; }
                let thumb = (length * visible / (visible + max)).max(28.).min(length);
                let start = (length - thumb) * (distance / max).clamp(0., 1.);
                let zone = if axis == 0 { Bounds::new(point(bounds.left(), bounds.bottom() - px(12.)), size(px(length), px(12.))) }
                    else { Bounds::new(point(bounds.right() - px(12.), bounds.top()), size(px(12.), px(length))) };
                let hitbox = window.insert_hitbox(zone, HitboxBehavior::BlockMouseExceptScroll);
                bars.push((axis, zone, start, thumb, length, max, hitbox));
            }
            (bars, handle.clone(), state.clone(), last_input.clone(), native_input.clone())
        }, move |_, (bars, handle, state, last_input, native_input), window, _| {
            for (axis, zone, start, thumb, length, maximum, hitbox) in bars {
                let hot = hitbox.is_hovered(window); let dragging = state.grab.get().is_some_and(|grab| grab.axis == axis);
                let thickness = if hot || dragging { 6. } else { 4. };
                let rect = if axis == 0 { Bounds::new(point(zone.left() + px(start), zone.bottom() - px(2. + thickness)), size(px(thumb), px(thickness))) }
                    else { Bounds::new(point(zone.right() - px(2. + thickness), zone.top() + px(start)), size(px(thickness), px(thumb))) };
                window.paint_quad(fill(rect, if hot || dragging { Theme::text_caption() } else { Theme::scrollbar_thumb() }).corner_radii(px(3.)));
                window.set_cursor_style(CursorStyle::Arrow, &hitbox);
                window.on_mouse_event({
                    let handle = handle.clone(); let state = state.clone(); let last_input = last_input.clone(); let native_input = native_input.clone(); let hitbox = hitbox.clone();
                    move |ev: &MouseDownEvent, phase, window, cx| {
                        if phase != DispatchPhase::Bubble || ev.button != MouseButton::Left || !hitbox.is_hovered(window) { return; }
                        let pointer = if axis == 0 { f32::from(ev.position.x - zone.left()) } else { f32::from(ev.position.y - zone.top()) };
                        let delta = if pointer >= start && pointer <= start + thumb { pointer - start } else { thumb / 2. };
                        state.grab.set(Some(Grab { axis, delta })); last_input.set(pane); native_input.set(true);
                        let distance = ((pointer - delta) / (length - thumb).max(1.)).clamp(0., 1.) * maximum;
                        let mut offset = handle.offset(); if axis == 0 { offset.x = px(-distance); } else { offset.y = px(-distance); }
                        handle.set_offset(offset); cx.notify(entity); window.refresh(); cx.stop_propagation();
                    }
                });
                window.on_mouse_event({
                    let handle = handle.clone(); let state = state.clone(); let last_input = last_input.clone(); let native_input = native_input.clone();
                    move |ev: &MouseMoveEvent, phase, window, cx| {
                        if phase != DispatchPhase::Bubble { return; }
                        let Some(grab) = state.grab.get().filter(|grab| grab.axis == axis) else { return; };
                        if ev.pressed_button != Some(MouseButton::Left) { state.grab.set(None); cx.notify(entity); return; }
                        let pointer = if axis == 0 { f32::from(ev.position.x - zone.left()) } else { f32::from(ev.position.y - zone.top()) };
                        let distance = ((pointer - grab.delta) / (length - thumb).max(1.)).clamp(0., 1.) * maximum;
                        let mut offset = handle.offset(); if axis == 0 { offset.x = px(-distance); } else { offset.y = px(-distance); }
                        handle.set_offset(offset); last_input.set(pane); native_input.set(true); cx.notify(entity); window.refresh(); cx.stop_propagation();
                    }
                });
            }
            window.on_mouse_event(move |ev: &MouseUpEvent, phase, window, cx| {
                if phase == DispatchPhase::Bubble && ev.button == MouseButton::Left && state.grab.take().is_some() { cx.notify(entity); window.refresh(); }
            });
        }).absolute().inset_0()
    }
}
