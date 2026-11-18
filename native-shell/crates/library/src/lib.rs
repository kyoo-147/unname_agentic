//! The workspace library: one record per document, its retained PDF and its
//! first-page thumbnail, plus the trash. Storage is plain JSON on disk:
//!
//! ```text
//! <library>/documents/
//!   index.json          id -> metadata
//!   settings.json       library-wide settings
//!   docs/<id>.json      { title, icon }
//!   assets/<id>-pdf.png first page, rendered at import time
//!   sources/<id>.pdf    the retained original
//!   trash/<id>/         a deleted record (metadata + files)
//! ```
//!
//! Nothing here depends on a UI framework.

pub mod store;
pub mod time;
