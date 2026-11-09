//! Interface language: one process-wide choice (Vietnamese, English or
//! Chinese), `tr3` for strings written in all three, and `tr` for the older
//! two-language call sites — Vietnamese falls back to English there until a
//! string is translated.

use std::sync::atomic::{AtomicU8, Ordering};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
#[repr(u8)]
pub enum Lang {
    /// Also the default when a preferences file has neither `lang` nor the old
    /// `english` switch.
    #[default]
    Vi = 0,
    En = 1,
    Zh = 2,
}

impl Lang {
    pub const ALL: [Lang; 3] = [Lang::Vi, Lang::En, Lang::Zh];

    /// A saved code: "vi", "en" or "zh"; anything else (empty included) is Vi.
    pub fn from_code(code: &str) -> Lang {
        match code { "en" => Lang::En, "zh" => Lang::Zh, _ => Lang::Vi }
    }

    /// The old `english` switch: true was English, false Chinese.
    pub(crate) fn from_english(old: Option<bool>) -> Lang {
        match old { Some(true) => Lang::En, Some(false) => Lang::Zh, None => Lang::Vi }
    }

    pub fn code(self) -> &'static str { match self { Lang::Vi => "vi", Lang::En => "en", Lang::Zh => "zh" } }

    /// The name in that language, for the interface-language control.
    pub fn label(self) -> &'static str { match self { Lang::Vi => "Tiếng Việt", Lang::En => "English", Lang::Zh => "简体中文" } }

    /// Position in `ALL`, i.e. the selected segment.
    pub fn index(self) -> usize { self as usize }
}

static LANG: AtomicU8 = AtomicU8::new(Lang::Vi as u8);

pub fn set_lang(lang: Lang) { LANG.store(lang as u8, Ordering::Relaxed) }

pub fn lang() -> Lang {
    match LANG.load(Ordering::Relaxed) {
        1 => Lang::En,
        2 => Lang::Zh,
        _ => Lang::Vi,
    }
}

/// The string for the active language: `zh`, `en` or `vi` in that order.
pub fn tr3(zh: &'static str, en: &'static str, vi: &'static str) -> &'static str {
    match lang() { Lang::Zh => zh, Lang::En => en, Lang::Vi => vi }
}

/// The old two-language form; kept so existing `tr(zh, en)` calls compile.
/// Vietnamese looks the English form up in the shell table below, so the many
/// two-language call sites translate without being edited one by one.
pub fn tr(zh: &'static str, en: &'static str) -> &'static str {
    match lang() { Lang::Zh => zh, Lang::En => en, Lang::Vi => vi_for(en).unwrap_or(en) }
}

/// Vietnamese for the shell's recurring English labels. Keys are the exact
/// English strings passed to `tr`; anything missing falls back to English.
pub fn vi_for(en: &str) -> Option<&'static str> { VI.iter().find(|(key, _)| *key == en).map(|(_, value)| *value) }

/// An English literal written in place: Vietnamese when known, otherwise the
/// English string itself.
pub fn en_or_vi(en: &'static str) -> &'static str {
    match lang() { Lang::Vi => vi_for(en).unwrap_or(en), _ => en }
}

static VI: &[(&str, &str)] = &[
    ("Home", "Trang chủ"),
    ("New chat", "Trò chuyện mới"),
    ("Recent", "Gần đây"),
    ("Favorites", "Yêu thích"),
    ("Live mirror", "Live mirror"),
    ("Translate", "Dịch thuật"),
    ("Settings", "Cài đặt"),
    ("My documents", "Tài liệu của tôi"),
    ("All documents", "Tất cả tài liệu"),
    ("Manage", "Quản lý"),
    ("Last visited", "Xem gần nhất"),
    ("Last modified", "Sửa gần nhất"),
    ("Recently visited", "Xem gần đây"),
    ("Date created", "Ngày tạo"),
    ("Date modified", "Ngày sửa"),
    ("Name", "Tên"),
    ("Title", "Tiêu đề"),
    ("Sort", "Sắp xếp"),
    ("By name", "Theo tên"),
    ("Search documents…", "Tìm tài liệu…"),
    ("Search", "Tìm kiếm"),
    ("Import PDF", "Nhập PDF"),
    ("Open PDF", "Mở PDF"),
    ("No PDF documents yet", "Chưa có tài liệu PDF nào"),
    ("No documents yet", "Chưa có tài liệu nào"),
    ("Nothing here yet", "Chưa có gì ở đây"),
    ("Open", "Mở"),
    ("Rename", "Đổi tên"),
    ("Delete", "Xoá"),
    ("Move to trash", "Chuyển vào thùng rác"),
    ("Add to favorites", "Thêm vào yêu thích"),
    ("Remove from favorites", "Bỏ khỏi yêu thích"),
    ("Pin", "Ghim"),
    ("Unpin", "Bỏ ghim"),
    ("Duplicate", "Tạo bản sao"),
    ("Trash", "Thùng rác"),
    ("Empty trash", "Dọn thùng rác"),
    ("Restore", "Khôi phục"),
    ("Delete permanently", "Xoá vĩnh viễn"),
    ("Back", "Quay lại"),
    ("Cancel", "Huỷ"),
    ("OK", "Đồng ý"),
    ("Copy", "Sao chép"),
    ("Paste", "Dán"),
    ("Cut", "Cắt"),
    ("Select all", "Chọn tất cả"),
    ("General", "Chung"),
    ("Appearance", "Giao diện"),
    ("Documents", "Tài liệu"),
    ("About", "Giới thiệu"),
    ("Interface language", "Ngôn ngữ giao diện"),
    ("Colour palette", "Bảng màu"),
    ("System", "Hệ thống"),
    ("Light", "Sáng"),
    ("Dark", "Tối"),
    ("Local workspace", "Không gian cục bộ"),
    ("Translations", "Bản dịch"),
    ("Provider", "Nhà cung cấp"),
    ("Model", "Mô hình"),
    ("Source language", "Ngôn ngữ nguồn"),
    ("Target language", "Ngôn ngữ đích"),
    ("API key", "Khoá API"),
    ("Save", "Lưu"),
    ("Retry", "Thử lại"),
    ("Pause", "Tạm dừng"),
    ("Resume", "Tiếp tục"),
    ("Previous", "Trước"),
    ("Next", "Sau"),
    ("Original", "Bản gốc"),
    ("Translation", "Bản dịch"),
    ("Split view", "Chia đôi"),
    ("Translation only", "Chỉ bản dịch"),
    ("Full paired reading", "Đọc song song đầy đủ"),
    ("Summarise", "Tóm tắt"),
    ("Find in documents", "Tìm trong tài liệu"),
    ("Open in new window", "Mở trong cửa sổ mới"),
    ("Show in File Explorer", "Hiện trong File Explorer"),
    ("Document information", "Thông tin tài liệu"),
    ("Word count", "Số từ"),
    ("Keyboard shortcuts", "Phím tắt"),
    ("Trash is empty", "Thùng rác trống"),
    ("Local PDF library", "Thư viện PDF cục bộ"),
    ("Imported PDFs and thumbnails stay in this workspace. Open a document to choose a translation provider. Cloud text transfer is opt-in.", "PDF và ảnh thu nhỏ được giữ trong không gian này. Mở một tài liệu để chọn nhà cung cấp dịch. Gửi văn bản lên đám mây là tuỳ chọn."),
];

#[cfg(test)]
mod tests {
    use super::*;

    // The language is process-wide; tests take turns and put it back.
    static TURN: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn with_lang<T>(lang: Lang, f: impl FnOnce() -> T) -> T {
        let _turn = TURN.lock().unwrap_or_else(|e| e.into_inner());
        let old = super::lang();
        set_lang(lang);
        let out = f();
        set_lang(old);
        out
    }

    #[test]
    fn codes_round_trip() {
        assert_eq!(Lang::ALL.map(|lang| Lang::from_code(lang.code())), Lang::ALL);
        assert_eq!(Lang::ALL.map(Lang::index), [0, 1, 2]);
        assert_eq!(Lang::from_code(""), Lang::Vi);
        assert_eq!(Lang::from_code("fr"), Lang::Vi);
        assert_eq!(Lang::default(), Lang::Vi);
    }

    #[test]
    fn labels_are_distinct() {
        let mut labels = Lang::ALL.map(Lang::label);
        labels.sort_unstable();
        assert!(labels.windows(2).all(|pair| pair[0] != pair[1]));
    }

    #[test]
    fn tr3_returns_one_distinct_string_per_language() {
        let (zh, en, vi) = ("中文", "English", "Tiếng Việt");
        assert_ne!(zh, en); assert_ne!(en, vi); assert_ne!(zh, vi);
        assert_eq!(with_lang(Lang::Zh, || tr3(zh, en, vi)), zh);
        assert_eq!(with_lang(Lang::En, || tr3(zh, en, vi)), en);
        assert_eq!(with_lang(Lang::Vi, || tr3(zh, en, vi)), vi);
    }

    #[test]
    fn legacy_tr_falls_back_to_english_in_vietnamese() {
        assert_eq!(with_lang(Lang::Vi, || tr("中文", "English")), "English");
        assert_eq!(with_lang(Lang::En, || tr("中文", "English")), "English");
        assert_eq!(with_lang(Lang::Zh, || tr("中文", "English")), "中文");
    }

    #[test]
    fn old_english_switch_maps_to_a_language() {
        assert_eq!(Lang::from_english(Some(true)), Lang::En);
        assert_eq!(Lang::from_english(Some(false)), Lang::Zh);
        assert_eq!(Lang::from_english(None), Lang::Vi);
    }
}
