//! The workspace library handles the UI needs: records, PDF sources, trash,
//! settings and their diagnostics. It is a thin layer over `pdf_library`.

use crate::store::*;
use anyhow::Result;
use std::{cell::RefCell, rc::Rc};

#[derive(Clone)]
pub struct SharedStore(Rc<RefCell<Store>>);
impl gpui::Global for SharedStore {}
impl SharedStore {
    pub fn open() -> Result<Self> { Ok(Self(Rc::new(RefCell::new(Store::open()?)))) }
    pub fn take_warnings(&self) -> Vec<String> { self.0.borrow_mut().take_warnings() }
    pub fn list(&mut self) -> Vec<Entry> { self.0.borrow_mut().list() }
    pub fn pdf_path(&self, id: &str) -> Result<std::path::PathBuf> { self.0.borrow().pdf_path(id) }
    pub fn delete(&mut self, id: &str, root: Option<&str>) -> Result<()> { self.0.borrow_mut().delete(id, root) }
    pub fn list_trash(&mut self) -> Vec<TrashEntry> { self.0.borrow_mut().list_trash() }
    pub fn restore(&mut self, id: &str) -> Result<bool> { self.0.borrow_mut().restore(id) }
    pub fn purge(&mut self, id: &str) -> Result<()> { self.0.borrow_mut().purge(id) }
    pub fn update_meta(&mut self, id: &str, f: impl FnOnce(&mut Meta)) -> Result<()> { self.0.borrow_mut().update_meta(id, f) }
    pub fn settings(&self) -> Settings { self.0.borrow().settings() }
    pub fn save_settings(&self, s: &Settings) -> Result<()> { self.0.borrow().save_settings(s) }
    pub fn rename(&mut self, id: &str, title: &str) -> Result<Meta> { self.0.borrow_mut().rename(id, title) }
    pub fn touch(&mut self, id: &str) -> Option<Meta> { self.0.borrow_mut().touch(id) }
    pub fn set_parent(&mut self, id: &str, parent: Option<&str>) -> Result<Meta> { self.0.borrow_mut().set_parent(id, parent) }
    pub fn set_starred(&mut self, id: &str, on: bool) -> Result<u64> { self.0.borrow_mut().set_starred(id, on) }
    pub fn set_pinned(&mut self, id: &str, pinned: bool) -> Result<()> { self.0.borrow_mut().set_pinned(id, pinned) }
}
