//! Publication boundary for one lexical/dense index generation.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
#[cfg(test)]
use std::io::Read;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use sha2::{Digest, Sha256};

use crate::retrieval::Bm25Index;
use crate::vector_index::VectorStore;

#[path = "index_file_snapshot.rs"]
mod file_snapshot;
pub(crate) use file_snapshot::{read_snapshot, IndexFileRevision, IndexFileSnapshot};

/// Serializes manual and background writers from load through final publication.
pub(crate) static PUBLISHER: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

const MAGIC: &[u8; 4] = b"MXP1";
const HEADER_LEN: usize = 28;

pub(crate) struct IndexPair {
    pub generation: u64,
    pub store: VectorStore,
    pub lexical: Bm25Index,
}

pub(crate) struct PairSnapshot {
    pub generation: u64,
    pub store: Arc<VectorStore>,
    pub lexical: Arc<Bm25Index>,
}

struct CachedPair {
    root: PathBuf,
    fingerprint: Vec<Option<IndexFileRevision>>,
    pair: Arc<PairSnapshot>,
}

static PAIR_CACHE: Mutex<Option<CachedPair>> = Mutex::new(None);

pub(crate) fn legacy_path_for(root: &str, extension: &str) -> Result<PathBuf, String> {
    let mut hash = DefaultHasher::new();
    root.hash(&mut hash);
    let directory = crate::settings::settings_dir()?.join("embeddings");
    std::fs::create_dir_all(&directory).map_err(|error| format!("mkdir embeddings: {error}"))?;
    Ok(directory.join(format!("{:016x}.{extension}", hash.finish())))
}

pub(crate) fn path_for(root: &str) -> Result<PathBuf, String> {
    legacy_path_for(root, "mxp")
}

/// Single-index readers also follow the paired publication after migration.
pub(crate) fn read_path_for(root: &str, legacy_extension: &str) -> Result<PathBuf, String> {
    let pair = path_for(root)?;
    match std::fs::symlink_metadata(&pair) {
        Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => Ok(pair),
        Ok(_) => Err("published index is not a regular file".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            legacy_path_for(root, legacy_extension)
        }
        Err(error) => Err(format!("inspect published index: {error}")),
    }
}

/// Existing derived files must not be mistaken for absent files on read failure.
pub(crate) fn read_checked(path: &Path) -> Result<Option<Vec<u8>>, String> {
    Ok(read_snapshot(path)?.map(|snapshot| snapshot.bytes))
}

fn encode(pair: &IndexPair) -> Vec<u8> {
    let dense = pair.store.encode();
    let lexical = pair.lexical.encode();
    let mut bytes = Vec::with_capacity(HEADER_LEN + dense.len() + lexical.len() + 32);
    bytes.extend_from_slice(MAGIC);
    bytes.extend_from_slice(&pair.generation.to_le_bytes());
    bytes.extend_from_slice(&(dense.len() as u64).to_le_bytes());
    bytes.extend_from_slice(&(lexical.len() as u64).to_le_bytes());
    bytes.extend_from_slice(&dense);
    bytes.extend_from_slice(&lexical);
    let checksum = Sha256::digest(&bytes);
    bytes.extend_from_slice(&checksum);
    bytes
}

pub(crate) fn decode(bytes: &[u8]) -> Option<IndexPair> {
    if bytes.len() < HEADER_LEN + 32 || bytes.get(..4)? != MAGIC {
        return None;
    }
    let generation = u64::from_le_bytes(bytes.get(4..12)?.try_into().ok()?);
    let dense_len =
        usize::try_from(u64::from_le_bytes(bytes.get(12..20)?.try_into().ok()?)).ok()?;
    let lexical_len =
        usize::try_from(u64::from_le_bytes(bytes.get(20..28)?.try_into().ok()?)).ok()?;
    let dense_end = HEADER_LEN.checked_add(dense_len)?;
    let payload_end = dense_end.checked_add(lexical_len)?;
    if payload_end.checked_add(32)? != bytes.len()
        || Sha256::digest(bytes.get(..payload_end)?).as_slice() != bytes.get(payload_end..)?
    {
        return None;
    }
    Some(IndexPair {
        generation,
        store: VectorStore::decode(bytes.get(HEADER_LEN..dense_end)?)?,
        lexical: Bm25Index::decode(bytes.get(dense_end..payload_end)?)?,
    })
}

/// Legacy sidecars stay readable until a complete first paired build succeeds.
pub(crate) fn load(root: &Path) -> Result<IndexPair, String> {
    capture(root)?.decode()
}

enum CapturedPair {
    Published(IndexFileSnapshot),
    Legacy {
        dense: Option<IndexFileSnapshot>,
        json: Option<IndexFileSnapshot>,
        lexical: Option<IndexFileSnapshot>,
    },
}

impl CapturedPair {
    fn fingerprint(&self) -> Vec<Option<IndexFileRevision>> {
        match self {
            Self::Published(snapshot) => vec![Some(snapshot.revision.clone())],
            Self::Legacy {
                dense,
                json,
                lexical,
            } => [dense, json, lexical]
                .into_iter()
                .map(|snapshot| snapshot.as_ref().map(|snapshot| snapshot.revision.clone()))
                .collect(),
        }
    }

    fn decode(self) -> Result<IndexPair, String> {
        match self {
            Self::Published(snapshot) => {
                decode(&snapshot.bytes).ok_or_else(|| "published index pair is corrupt".into())
            }
            Self::Legacy {
                dense,
                json,
                lexical,
            } => {
                let store = match (dense, json) {
                    (Some(snapshot), _) => VectorStore::decode(&snapshot.bytes)
                        .ok_or("legacy dense index is corrupt")?,
                    (None, Some(snapshot)) => {
                        let store: VectorStore = serde_json::from_slice(&snapshot.bytes)
                            .map_err(|_| "legacy dense JSON index is corrupt")?;
                        store.validate_geometry()?;
                        store
                    }
                    (None, None) => VectorStore::default(),
                };
                let lexical = match lexical {
                    Some(snapshot) => Bm25Index::decode(&snapshot.bytes)
                        .ok_or("legacy lexical index is corrupt")?,
                    None => Bm25Index::default(),
                };
                Ok(IndexPair {
                    generation: 0,
                    store,
                    lexical,
                })
            }
        }
    }
}

fn capture(root: &Path) -> Result<CapturedPair, String> {
    let root = root.to_string_lossy();
    let path = path_for(&root)?;
    if let Some(snapshot) = read_snapshot(&path)? {
        return Ok(CapturedPair::Published(snapshot));
    }
    let dense_path = legacy_path_for(&root, "mxv")?;
    let dense = read_snapshot(&dense_path)?;
    let json = if dense.is_none() {
        read_snapshot(&legacy_path_for(&root, "json")?)?
    } else {
        None
    };
    let lexical = read_snapshot(&legacy_path_for(&root, "mxb")?)?;
    if read_snapshot(&path)?.is_some() || (dense.is_none() && read_snapshot(&dense_path)?.is_some())
    {
        return Err("index primary appeared during legacy selection".into());
    }
    Ok(CapturedPair::Legacy {
        dense,
        json,
        lexical,
    })
}

/// Inspect generation headers in codec tests; caches bind the complete content.
#[cfg(test)]
pub(crate) fn generation_of(path: &Path) -> Result<u64, String> {
    if path.extension().and_then(|extension| extension.to_str()) != Some("mxp") {
        return Ok(0);
    }
    let mut header = [0; 12];
    std::fs::File::open(path)
        .and_then(|mut file| file.read_exact(&mut header))
        .map_err(|error| format!("read index generation: {error}"))?;
    if header[..4] != *MAGIC {
        return Err("invalid index generation header".into());
    }
    Ok(u64::from_le_bytes(header[4..].try_into().unwrap()))
}

pub(crate) async fn snapshot(root: PathBuf) -> Result<Arc<PairSnapshot>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut cache = PAIR_CACHE
            .lock()
            .map_err(|_| "index pair cache lock poisoned")?;
        let captured = capture(&root)?;
        let fingerprint = captured.fingerprint();
        if let Some(cached) = cache.as_ref() {
            if cached.root == root && cached.fingerprint == fingerprint {
                return Ok(cached.pair.clone());
            }
        }
        let pair = captured.decode()?;
        if capture(&root)?.fingerprint() != fingerprint {
            return Err("index pair changed during cache admission".into());
        }
        let pair = Arc::new(PairSnapshot {
            generation: pair.generation,
            store: Arc::new(pair.store),
            lexical: Arc::new(pair.lexical),
        });
        *cache = Some(CachedPair {
            root,
            fingerprint,
            pair: pair.clone(),
        });
        Ok(pair)
    })
    .await
    .map_err(|error| format!("index pair load task failed: {error}"))?
}

/// A complete shadow pair. Drop removes uncommitted staging without touching sources.
pub(crate) struct PreparedPair {
    path: PathBuf,
    shadow: tempfile::NamedTempFile,
}

impl PreparedPair {
    pub(crate) fn prepare(root: &Path, pair: &IndexPair) -> Result<Self, String> {
        pair.store.validate_geometry()?;
        let path = path_for(&root.to_string_lossy())?;
        let mut shadow = tempfile::NamedTempFile::new_in(path.parent().unwrap())
            .map_err(|error| format!("stage index pair: {error}"))?;
        shadow
            .write_all(&encode(pair))
            .map_err(|error| format!("write index pair: {error}"))?;
        shadow
            .as_file()
            .sync_all()
            .map_err(|error| format!("sync index pair: {error}"))?;
        Ok(Self { path, shadow })
    }

    /// Call only while the publisher and native opening transition are held.
    pub(crate) fn commit(self) -> Result<PathBuf, String> {
        match std::fs::symlink_metadata(&self.path) {
            Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {
                let previous = self.path.with_extension("mxp.previous");
                let shadow = tempfile::NamedTempFile::new_in(self.path.parent().unwrap())
                    .map_err(|error| format!("stage previous index: {error}"))?;
                std::fs::copy(&self.path, shadow.path())
                    .map_err(|error| format!("retain previous index: {error}"))?;
                shadow
                    .as_file()
                    .sync_all()
                    .map_err(|error| error.to_string())?;
                shadow
                    .persist(&previous)
                    .map_err(|error| format!("publish previous index: {error}"))?;
            }
            Ok(_) => return Err("published index is not a regular file".into()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("inspect index publication: {error}")),
        }
        self.shadow
            .persist(&self.path)
            .map_err(|error| format!("publish index pair: {error}"))?;
        Ok(self.path)
    }
}

#[cfg(test)]
#[path = "index_publication_tests.rs"]
mod tests;

#[cfg(feature = "native-index-probe")]
pub(crate) mod probe_hooks {
    use std::path::Path;
    use std::sync::{Mutex, OnceLock};

    type Hook =
        Box<dyn FnOnce() -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> + Send>;
    static AFTER_SCAN: OnceLock<Mutex<Option<Hook>>> = OnceLock::new();

    pub(crate) fn install_after_scan<F: std::future::Future<Output = ()> + Send + 'static>(
        hook: impl FnOnce() -> F + Send + 'static,
    ) {
        *AFTER_SCAN.get_or_init(Mutex::default).lock().unwrap() =
            Some(Box::new(move || Box::pin(hook())));
    }

    pub(crate) async fn after_scan(_root: &Path) {
        let hook = AFTER_SCAN
            .get_or_init(Mutex::default)
            .lock()
            .unwrap()
            .take();
        if let Some(hook) = hook {
            hook().await;
        }
    }
}
