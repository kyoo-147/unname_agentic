//! The product's own text field element: it shapes one string (optionally
//! wrapped), paints its placeholder, selection and caret, and records a layout
//! the field can hit-test for clicks, IME and `MoveUp`/`MoveDown`.
//!
//! This replaces the document editor's rich-text element: a field only ever
//! holds one plain string, so there are no blocks, marks, equations or inline
//! objects here.

use gpui::*;
use std::cell::RefCell;
use std::collections::HashMap;
use std::ops::Range;
use std::rc::Rc;

/// A field's identity in the layout cache: one per `TextField`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct FieldId(pub u64);

/// Where a byte range sits on screen, for `bounds_for_range`.
#[derive(Clone, Debug)]
pub struct FieldLayout {
    rows: Vec<Row>,
    /// Per hard line, the shaped layout (wrap boundaries included).
    lines: Vec<WrappedLine>,
    /// Byte offset where each hard line starts.
    starts: Vec<usize>,
    pub line_height: Pixels,
    pub origin: Point<Pixels>,
}

#[derive(Clone, Debug)]
struct Row {
    /// Byte range of this visual row inside the field's text.
    range: Range<usize>,
    /// Index into `lines`.
    hard: usize,
    /// Top of the row, relative to `origin`.
    y: Pixels,
    /// x of the row's first glyph inside the unwrapped layout.
    x0: Pixels,
    /// Alignment offset inside the field's width.
    align_dx: Pixels,
}

impl Default for FieldLayout {
    fn default() -> Self { Self { rows: Vec::new(), lines: Vec::new(), starts: Vec::new(), line_height: px(20.), origin: Point::default() } }
}

impl FieldLayout {
    /// The caret position for a byte offset, in window coordinates.
    pub fn position_for(&self, index: usize) -> Point<Pixels> {
        let Some(row) = self.row_for(index) else { return self.origin };
        let line = &self.lines[row.hard];
        let local = index.saturating_sub(self.starts[row.hard]).min(line.len());
        let x = line.unwrapped_layout.x_for_index(local) - row.x0 + row.align_dx;
        point(self.origin.x + x, self.origin.y + row.y)
    }

    /// The byte offset nearest a window point.
    pub fn index_for(&self, position: Point<Pixels>) -> usize {
        let local_y = position.y - self.origin.y;
        let Some(row) = self.rows.iter().find(|r| local_y >= r.y && local_y < r.y + self.line_height).or_else(|| self.rows.last()) else { return 0 };
        let line = &self.lines[row.hard];
        let inside = position.x - self.origin.x - row.align_dx + row.x0;
        let at = line.unwrapped_layout.closest_index_for_x(inside.max(px(0.)));
        (self.starts[row.hard] + at).min(row.range.end)
    }

    fn row_for(&self, index: usize) -> Option<&Row> {
        self.rows.iter().find(|r| index >= r.range.start && index < r.range.end).or_else(|| self.rows.last())
    }

    /// The x span of `range` inside `row`.
    fn span_in(&self, row: &Row, range: &Range<usize>) -> Option<(Pixels, Pixels)> {
        let line = &self.lines[row.hard];
        let start = range.start.max(row.range.start);
        let end = range.end.min(row.range.end);
        if start > end || (start == end && range.start != range.end) { return None; }
        let base = self.starts[row.hard];
        let x = |i: usize| line.unwrapped_layout.x_for_index(i.saturating_sub(base).min(line.len())) - row.x0 + row.align_dx;
        Some((x(start), x(end)))
    }
}

/// The shaped layouts of every live field, by id.
pub type LayoutCache = Rc<RefCell<HashMap<FieldId, FieldLayout>>>;

/// One text field's visual state for the frame being built.
pub struct FieldElement {
    pub id: FieldId,
    pub text: SharedString,
    pub placeholder: Option<SharedString>,
    pub placeholder_color: Hsla,
    pub color: Hsla,
    pub size: f32,
    pub line_height: f32,
    pub mono: bool,
    pub wrap: bool,
    pub align: TextAlign,
    pub selection: Option<Range<usize>>,
    pub caret: Option<usize>,
    pub marked: Option<Range<usize>>,
    pub show_caret: bool,
    pub cache: LayoutCache,
}

pub struct Prepared {
    lines: Vec<WrappedLine>,
    starts: Vec<usize>,
    rows: Vec<Row>,
    height: Pixels,
    wrap_width: Option<Pixels>,
}

impl IntoElement for FieldElement {
    type Element = Self;
    fn into_element(self) -> Self::Element { self }
}

impl Element for FieldElement {
    type RequestLayoutState = Rc<RefCell<Option<Prepared>>>;
    type PrepaintState = ();

    fn id(&self) -> Option<ElementId> { None }
    fn source_location(&self) -> Option<&'static std::panic::Location<'static>> { None }

    fn request_layout(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        window: &mut Window,
        _cx: &mut App,
    ) -> (LayoutId, Self::RequestLayoutState) {
        let state: Rc<RefCell<Option<Prepared>>> = Rc::new(RefCell::new(None));
        let stored = state.clone();
        let mut style = Style::default();
        style.size.width = relative(1.).into();
        let (text, color, placeholder) = (self.text.clone(), self.color, self.placeholder.clone());
        let placeholder_color = self.placeholder_color;
        let (fs, lh, mono, wrap, align) = (self.size, self.line_height, self.mono, self.wrap, self.align);
        let font = if mono { crate::theme::MONO_FONT } else { crate::theme::UI_FONT };
        let layout_id = window.request_measured_layout(style, move |known, available, window, _cx| {
            let wrap_width = if wrap {
                known.width.or(match available.width { AvailableSpace::Definite(x) => Some(x), _ => None })
            } else { None };
            let showing_placeholder = text.is_empty();
            let shown: SharedString = if showing_placeholder { placeholder.clone().unwrap_or_default() } else { text.clone() };
            let run_color = if showing_placeholder { placeholder_color } else { color };
            let font_size = px(fs);
            let runs = [TextRun { len: shown.len(), font: gpui::font(font), color: run_color, background_color: None, underline: None, strikethrough: None }];
            let mut lines: Vec<WrappedLine> = window.text_system().shape_text(shown.clone(), font_size, &runs, wrap_width, None).unwrap_or_default().into_iter().collect();
            // Rows: every hard line is cut at its wrap boundaries.
            let mut rows = Vec::new();
            let mut starts = Vec::new();
            let mut start = 0;
            let mut y = px(0.);
            for (hard, line) in lines.iter().enumerate() {
                starts.push(start);
                let mut cuts: Vec<(usize, Pixels)> = vec![(0, px(0.))];
                for b in line.wrap_boundaries() {
                    let glyph = &line.unwrapped_layout.runs[b.run_ix].glyphs[b.glyph_ix];
                    cuts.push((glyph.index, glyph.position.x));
                }
                cuts.push((line.len(), line.unwrapped_layout.width));
                for w in cuts.windows(2) {
                    let (a, xa) = w[0];
                    let (b, xb) = w[1];
                    let align_dx = match align {
                        TextAlign::Left => px(0.),
                        TextAlign::Center => ((known.width.unwrap_or(px(0.)) - (xb - xa)) / 2.).max(px(0.)),
                        TextAlign::Right => (known.width.unwrap_or(px(0.)) - (xb - xa)).max(px(0.)),
                    };
                    rows.push(Row { range: start + a..start + b, hard, y, x0: xa, align_dx });
                    y += px(lh);
                }
                start += line.len();
            }
            if rows.is_empty() {
                // An empty field still occupies one line, so the caret shows.
                let len = shown.len();
                rows.push(Row { range: 0..len, hard: 0, y: px(0.), x0: px(0.), align_dx: px(0.) });
                if lines.is_empty() {
                    let space = SharedString::from(" ");
                    let space_runs = [TextRun { len: space.len(), font: gpui::font(font), color: run_color, background_color: None, underline: None, strikethrough: None }];
                    lines = window.text_system().shape_text(space, font_size, &space_runs, None, None).unwrap_or_default().into_iter().collect();
                }
                starts.push(0);
                y = px(lh);
            }
            let height = y;
            *stored.borrow_mut() = Some(Prepared { lines, starts, rows, height, wrap_width });
            size(known.width.unwrap_or(px(0.)), height)
        });
        (layout_id, state)
    }

    fn prepaint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        state: &mut Self::RequestLayoutState,
        _window: &mut Window,
        _cx: &mut App,
    ) -> Self::PrepaintState {
        let Some(p) = state.borrow_mut().take() else { return };
        self.cache.borrow_mut().insert(self.id, FieldLayout { rows: p.rows, lines: p.lines, starts: p.starts, line_height: px(self.line_height), origin: bounds.origin });
    }

    fn paint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _state: &mut Self::RequestLayoutState,
        _prepaint: &mut Self::PrepaintState,
        window: &mut Window,
        cx: &mut App,
    ) {
        let cache = self.cache.borrow();
        let Some(layout) = cache.get(&self.id) else { return };
        let lh = layout.line_height;
        // Selection first, so the glyphs sit on top of it.
        if let Some(sel) = &self.selection
            && !sel.is_empty() {
                for row in &layout.rows {
                    if let Some((xa, xb)) = layout.span_in(row, sel) {
                        let top = bounds.top() + row.y;
                        let rect = Bounds::new(point(bounds.left() + xa, top), size((xb - xa).max(px(2.)), lh));
                        window.paint_quad(quad(rect, px(2.), crate::theme::Theme::selection(), px(0.), transparent_black(), BorderStyle::Solid));
                    }
                }
            }
        // The text itself.
        for (hard, line) in layout.lines.iter().enumerate() {
            let tops: Vec<Pixels> = layout.rows.iter().filter(|r| r.hard == hard).map(|r| r.y).collect();
            let origin = point(bounds.left(), bounds.top());
            if tops.is_empty() { continue }
            let _ = line.paint_rows(origin, lh, &tops, self.align, Some(bounds), window, cx);
        }
        // The IME composition underline.
        if let Some(marked) = &self.marked
            && !marked.is_empty() {
                for row in &layout.rows {
                    if let Some((xa, xb)) = layout.span_in(row, marked) {
                        let y = bounds.top() + row.y + lh - px(1.);
                        let rect = Bounds::new(point(bounds.left() + xa, y), size(xb - xa, px(1.)));
                        window.paint_quad(quad(rect, px(0.), self.color, px(0.), transparent_black(), BorderStyle::Solid));
                    }
                }
            }
        // The caret last.
        if self.show_caret && self.selection.as_ref().is_none_or(|s| s.is_empty())
            && let Some(at) = self.caret {
                let p = layout.position_for(at);
                let rect = Bounds::new(p, size(px(1.5), lh));
                window.paint_quad(quad(rect, px(0.), self.color, px(0.), transparent_black(), BorderStyle::Solid));
            }
    }
}
