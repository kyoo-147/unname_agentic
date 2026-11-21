//! Fixture for `tests/ui-strings.test.ts`: a capture picker with exactly one
//! hardcoded English label.
//!
//! Every other literal in this file is a documented non-violation, so the test
//! can prove the scan's exclusions as well as its hit:
//!   - `tr3(..)` arguments are already translated;
//!   - `eprintln!` is logging, never UI text;
//!   - a one-word label ("Cancel") is not prose;
//!   - `#[cfg(test)]` copy is blanked before scanning.
//! The file is read as text; it is never compiled.

use crate::ui::{dialog, secondary_button};

pub fn render(empty: bool) -> impl IntoElement {
    let body = if empty {
        div().child("No capture sources found. Open a document window, then refresh.")
    } else {
        div().child(crate::i18n::tr3("选择实时来源", "Choose a live source", "Chọn nguồn trực tiếp"))
    };
    dialog("capture-picker").child(body)
}

pub fn refresh_label() -> &'static str {
    crate::i18n::tr3("刷新", "Refresh", "Làm mới")
}

pub fn log_failure(error: &str) {
    eprintln!("capture picker failed: {error}");
}

pub fn tokens_are_not_prose() -> impl IntoElement {
    // Class names, ids and file names are single lowercase tokens or hyphenated,
    // so they fail the leading-capital, two-word prose rule even as element text.
    div().child("flex items-center").child("capture-picker").child("report.pdf")
}

pub fn format_strings_and_errors(count: usize) {
    // A format string and an error message never reach an element builder.
    let _ = format!("{} open windows", count);
    if count == 0 {
        eprintln!("no capture sources: nothing to mirror");
    }
}

pub fn secondary_action() -> impl IntoElement {
    secondary_button("capture-cancel", "Cancel").child("×")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_state_is_plain() {
        let _ = div().child("Test only copy that must never fail the gate");
    }
}
