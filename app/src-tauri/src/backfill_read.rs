//! Read outcomes shared by session backfill and the harvest queue.

use serde::Serialize;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReadStatus {
    #[default]
    Complete,
    Partial,
    ReadFailed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReadIssueCode {
    StateRead,
    StateDecode,
    DirectoryRead,
    EntryRead,
    MetadataRead,
    BodyRead,
    CompletionRead,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ReadIssue {
    pub path: String,
    pub code: ReadIssueCode,
    pub message: String,
}

impl ReadIssue {
    pub(crate) fn new(
        path: impl Into<String>,
        code: ReadIssueCode,
        message: impl Into<String>,
    ) -> Self {
        Self {
            path: path.into(),
            code,
            message: message.into(),
        }
    }
}
