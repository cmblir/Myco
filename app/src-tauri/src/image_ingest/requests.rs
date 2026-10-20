//! Opening-bound image request ownership and bounded cancel-before-start state.

use super::{Failure, FailureCode};
use crate::vault_session::AgentVaultSession;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

type Key = (String, String, String);

#[derive(Default)]
struct Entries {
    active: BTreeMap<Key, Arc<AtomicBool>>,
    early: BTreeSet<Key>,
}

#[derive(Clone, Default)]
pub(super) struct Registry(Arc<Mutex<Entries>>);

pub(super) fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 96
        && id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'))
}

fn key(origin: &AgentVaultSession, id: &str) -> Key {
    (
        origin.vault_path.clone(),
        origin.opening_token.clone(),
        id.into(),
    )
}

impl Registry {
    pub(super) fn begin(&self, origin: &AgentVaultSession, id: &str) -> Result<Run, Failure> {
        if !valid_id(id) {
            return Err(FailureCode::InvalidRequest.into());
        }
        let mut entries = self.0.lock().map_err(|_| FailureCode::RequestBusy)?;
        let key = key(origin, id);
        if entries.active.len() >= 4 || entries.active.contains_key(&key) {
            return Err(FailureCode::RequestBusy.into());
        }
        // Previous openings cannot execute their early requests. Retain every
        // accepted marker for the current opening; never evict one silently.
        entries
            .early
            .retain(|old| old.0 == origin.vault_path && old.1 == origin.opening_token);
        let flag = Arc::new(AtomicBool::new(entries.early.remove(&key)));
        entries.active.insert(key.clone(), flag.clone());
        Ok(Run(Arc::new(Owner {
            entries: self.0.clone(),
            key,
            flag,
        })))
    }

    pub(super) fn cancel(&self, origin: &AgentVaultSession, id: &str) -> Result<bool, Failure> {
        if !valid_id(id) {
            return Err(FailureCode::InvalidRequest.into());
        }
        let mut entries = self.0.lock().map_err(|_| FailureCode::RequestBusy)?;
        let key = key(origin, id);
        if let Some(flag) = entries.active.get(&key) {
            flag.store(true, Ordering::Release);
            return Ok(true);
        }
        entries
            .early
            .retain(|old| old.0 == origin.vault_path && old.1 == origin.opening_token);
        if entries.early.contains(&key) {
            return Ok(true);
        }
        if entries.early.len() >= 16 {
            return Err(FailureCode::RequestBusy.into());
        }
        entries.early.insert(key);
        Ok(true)
    }

    #[cfg(any(test, feature = "native-index-probe"))]
    pub(super) fn active_count(&self) -> usize {
        self.0
            .lock()
            .expect("image request state poisoned")
            .active
            .len()
    }

    #[cfg(any(test, feature = "native-index-probe"))]
    pub(super) fn early_count(&self) -> usize {
        self.0
            .lock()
            .expect("image request state poisoned")
            .early
            .len()
    }
}

struct Owner {
    entries: Arc<Mutex<Entries>>,
    key: Key,
    flag: Arc<AtomicBool>,
}

impl Drop for Owner {
    fn drop(&mut self) {
        match self.entries.lock() {
            Ok(mut entries) => {
                if entries
                    .active
                    .get(&self.key)
                    .is_some_and(|flag| Arc::ptr_eq(flag, &self.flag))
                {
                    entries.active.remove(&self.key);
                }
            }
            Err(_) => eprintln!("image request cleanup lock poisoned"),
        }
    }
}

#[derive(Clone)]
pub(super) struct Run(Arc<Owner>);

impl Run {
    pub(super) fn cancel_on_drop(&self) -> CancelOnDrop {
        CancelOnDrop(self.clone())
    }

    pub(super) fn check(&self) -> Result<(), Failure> {
        if self.0.flag.load(Ordering::Acquire) {
            Err(FailureCode::Cancelled.into())
        } else {
            Ok(())
        }
    }
}

pub(super) struct CancelOnDrop(Run);

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        (self.0).0.flag.store(true, Ordering::Release);
    }
}
