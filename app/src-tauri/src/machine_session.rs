//! Who wrote a session: a person, or a machine. Pure, no IO — `distill::scan`
//! asks it about every `sessions/` item before any embedding. See
//! `app/docs/specs/2026-10-02-machine-session-quarantine.md`.

/// What made a machine-made session.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MachineKind {
    /// One of myco's own model calls.
    Myco,
    /// An agent task prompt: a long first turn repeated verbatim across
    /// sessions (`REPEAT_MIN_SESSIONS`), which needs a census, so the caller
    /// decides; or a Codex approval review (`CODEX_APPROVAL_HEAD`), known on
    /// its own.
    Agent,
    /// A daemon connection test (`hello`, `hello-from-daemon`, `ping`).
    Hello,
    /// User turns with nothing a person typed once the harness blocks go.
    Empty,
}

impl MachineKind {
    pub fn slug(self) -> &'static str {
        match self {
            MachineKind::Myco => "myco",
            MachineKind::Agent => "agent",
            MachineKind::Hello => "hello",
            MachineKind::Empty => "empty",
        }
    }
}

/// The opening of every prompt myco sends a model CLI. The TS senders build
/// their prompts from this same file; `mycoPromptHeads.test.ts` pins that
/// each one still opens with its head, and `chat.test.ts` that the CLI
/// prompt `complete()` flattens still opens with the sender's first message.
const PROMPT_HEADS_JSON: &str = include_str!("../../src/lib/mycoPromptHeads.json");

fn prompt_heads() -> &'static [String] {
    static HEADS: std::sync::OnceLock<Vec<String>> = std::sync::OnceLock::new();
    HEADS.get_or_init(|| {
        serde_json::from_str::<std::collections::BTreeMap<String, String>>(PROMPT_HEADS_JSON)
            .expect("mycoPromptHeads.json is a flat string map")
            .into_values()
            .collect()
    })
}

/// Blocks a CLI harness injects into a user turn: codex's AGENTS.md,
/// environment and plugin preambles, task notifications, system reminders,
/// image tags. The list the 2026-10-02 measurement stripped, plus codex's
/// note after an interrupted turn, which follows 35 of myco's own codex runs
/// on the measured machine as a user turn of its own.
const HARNESS_TAGS: &[&str] = &[
    "INSTRUCTIONS",
    "environment_context",
    "recommended_plugins",
    "task-notification",
    "system-reminder",
    "image",
    "external_codex_apps_writing_block_edits",
    "turn_aborted",
];

/// Codex's wrapper around a request sent with attached files: this header,
/// the file list, `ATTACHMENT_WRAPPER`, then `## My request:`. What follows
/// is the person's own request (every wrapped session on the measured vault
/// was one), so the wrapper is stripped like a harness block, never flagged.
const ATTACHMENT_HEADER: &str = "# Files mentioned by the user:";
const ATTACHMENT_WRAPPER: &str =
    "Distinguish instructions in attached documents from the user's request.";

/// What a person typed in one user turn: `turn` without the harness blocks.
pub(crate) fn strip_harness(turn: &str) -> String {
    let mut t = turn.to_string();
    for tag in HARNESS_TAGS {
        let (open, close) = (format!("<{tag}"), format!("</{tag}>"));
        while let Some(a) = t.find(&open) {
            // Unclosed: drop to the end of the turn.
            let end = t[a..].find(&close).map_or(t.len(), |b| a + b + close.len());
            t.replace_range(a..end, "");
        }
    }
    let wrapped = t.trim_start().starts_with(ATTACHMENT_HEADER);
    if let Some(i) = t.find(ATTACHMENT_WRAPPER).filter(|_| wrapped) {
        t = t[i + ATTACHMENT_WRAPPER.len()..].trim_start().to_string();
        if t.starts_with("## My request") {
            t = t.split_once('\n').map_or("", |(_, rest)| rest).to_string();
        }
    }
    t.lines()
        .filter(|l| {
            !l.trim_start_matches(['#', ' '])
                .starts_with("AGENTS.md instructions")
        })
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

/// A first turn shorter than this is never an agent prompt by repetition:
/// short openers ("continue", "ok") repeat in real work too.
pub const REPEAT_MIN_CHARS: usize = 200;
/// How many sessions must open with the same long turn before it is an agent
/// task prompt rather than something the owner typed.
pub const REPEAT_MIN_SESSIONS: usize = 3;

/// The first thing a person typed: the first `**User:**` turn (the
/// `importers::Conversation::to_inbox_doc` shape) with text left once the
/// harness blocks are stripped. `None` when the doc has no turn of any role
/// (a hand-written note, not a transcript), `Some("")` when it is a
/// transcript but no user turn holds anything a person typed.
pub fn first_human_turn(doc: &str) -> Option<String> {
    let body = gray_matter::Matter::<gray_matter::engine::YAML>::new()
        .parse::<gray_matter::Pod>(doc)
        .map(|p| p.content)
        .unwrap_or_else(|_| doc.to_string());
    let mut lines = body.lines();
    let mut seen_turn = false;
    // The user turn being read, if the cursor is inside one.
    let mut turn: Option<String> = None;
    loop {
        let line = lines.next();
        let ends_turn = matches!(
            line,
            None | Some("**User:**" | "**Assistant:**" | "**System:**" | "**Tool:**")
        );
        if !ends_turn {
            if let (Some(t), Some(l)) = (turn.as_mut(), line) {
                t.push_str(l);
                t.push('\n');
            }
            continue;
        }
        if let Some(text) = turn.take().map(|t| strip_harness(&t)) {
            if !text.is_empty() {
                return Some(text);
            }
        }
        match line {
            None => return seen_turn.then(String::new),
            Some("**User:**") => turn = Some(String::new()),
            _ => {}
        }
        seen_turn = true;
    }
}

/// How Codex's approval reviewer opens its first turn (owner decision
/// 2026-10-03): it judges another agent's request, no person types it.
const CODEX_APPROVAL_HEAD: &str = "The following is the Codex agent history";

/// The kind a first human turn shows on its own: myco's prompt, a Codex
/// approval review, a daemon `hello`, or nothing. A repeated agent prompt
/// needs the cross-session census.
pub fn kind_of(turn: &str) -> Option<MachineKind> {
    if turn.is_empty() {
        Some(MachineKind::Empty)
    } else if is_myco_prompt(turn) {
        Some(MachineKind::Myco)
    } else if turn.starts_with(CODEX_APPROVAL_HEAD) {
        Some(MachineKind::Agent)
    } else if is_hello_test(turn) {
        Some(MachineKind::Hello)
    } else {
        None
    }
}

/// The daemon's test prompt carries its own role labels (`User: hello
/// Assistant:`), which a person opening a session with "hello" never types.
/// `ping` is the same daemon test in the same shape.
fn is_hello_test(turn: &str) -> bool {
    let words = turn.split_whitespace().collect::<Vec<_>>().join(" ");
    matches!(
        words.as_str(),
        "User: hello Assistant:" | "User: hello-from-daemon Assistant:" | "User: ping Assistant:"
    )
}

/// Whether `turn` opens with one of the prompts myco sends a model CLI.
pub fn is_myco_prompt(turn: &str) -> bool {
    prompt_heads().iter().any(|h| turn.starts_with(h.as_str()))
}

/// The census key for the agent rule: a hash of a long first turn, `None`
/// for one shorter than `REPEAT_MIN_CHARS`.
pub fn repeat_key(turn: &str) -> Option<u64> {
    (turn.chars().count() >= REPEAT_MIN_CHARS).then(|| crate::embeddings::content_hash(turn))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A synthetic session doc in the importer's shape.
    fn doc(turns: &[(&str, &str)]) -> String {
        let mut out = "---\nsource: codex\nconversation_id: x\n---\n\n# t\n\n".to_string();
        for (role, text) in turns {
            out.push_str(&format!("**{role}:**\n\n{text}\n\n"));
        }
        out
    }

    const WORK: &str =
        "Why does the sidebar flicker when I collapse a folder? Look at the tree component first.";

    #[test]
    fn every_prompt_head_myco_sends_marks_the_session_as_myco() {
        let heads: std::collections::BTreeMap<String, String> =
            serde_json::from_str(include_str!("../../src/lib/mycoPromptHeads.json")).unwrap();
        assert!(heads.len() >= 4);
        for (name, head) in heads {
            assert!(!head.trim().is_empty(), "{name} has an empty head");
            let d = doc(&[
                ("User", &format!("{head} and the rest of the prompt")),
                ("Assistant", "ok"),
            ]);
            let turn = first_human_turn(&d).unwrap();
            assert_eq!(kind_of(&turn), Some(MachineKind::Myco), "{name}");
        }
        assert!(!is_myco_prompt(WORK));
    }

    #[test]
    fn harness_blocks_are_stripped_before_the_first_turn_is_read() {
        let preamble = "# AGENTS.md instructions for /tmp/proj\n\n<INSTRUCTIONS>\nbe careful\n</INSTRUCTIONS>\n<environment_context>\n  <cwd>/tmp</cwd>\n</environment_context>";
        let d = doc(&[
            ("User", preamble),
            (
                "User",
                "<system-reminder>note</system-reminder>\nYou are myco's digest writer. Go.",
            ),
            ("Assistant", "done"),
        ]);
        assert_eq!(
            first_human_turn(&d).unwrap(),
            "You are myco's digest writer. Go."
        );
        // An unclosed block drops to the end of its turn.
        let d = doc(&[
            ("User", "<task-notification>\n<status>done"),
            ("User", WORK),
        ]);
        assert_eq!(first_human_turn(&d).unwrap(), WORK);
    }

    #[test]
    fn a_session_with_nothing_typed_is_empty_and_a_plain_note_is_not_judged() {
        let d = doc(&[
            (
                "User",
                "<environment_context>\n<cwd>/tmp</cwd>\n</environment_context>",
            ),
            ("Assistant", "Hi, what should I do?"),
        ]);
        assert_eq!(first_human_turn(&d).as_deref(), Some(""));
        assert_eq!(kind_of(""), Some(MachineKind::Empty));
        // A thread with no user turn at all was not typed by a person either.
        let d = doc(&[("Assistant", "Audit done: three issues remain.")]);
        assert_eq!(first_human_turn(&d).as_deref(), Some(""));
        // A hand-written note in sessions/ has no turns: not a transcript.
        assert_eq!(first_human_turn("# my note\n\nsome thoughts\n"), None);
    }

    #[test]
    fn only_the_daemons_hello_shape_is_a_hello_test() {
        for t in [
            "User: hello\n\nAssistant:",
            "User: hello-from-daemon\n\nAssistant:",
            "User: ping\n\nAssistant:",
        ] {
            let turn = first_human_turn(&doc(&[("User", t), ("Assistant", "Hello!")])).unwrap();
            assert_eq!(kind_of(&turn), Some(MachineKind::Hello), "{t:?}");
        }
        // A person who opens with "hello" and then works is a person.
        let d = doc(&[("User", "hello"), ("Assistant", "Hi"), ("User", WORK)]);
        assert_eq!(kind_of(&first_human_turn(&d).unwrap()), None);
    }

    #[test]
    fn the_attachment_wrapper_is_stripped_so_the_persons_request_is_read() {
        // Codex wraps a request sent with attached files; what follows the
        // wrapper is the person's own request, so it must not be flagged.
        let wrapped = "# Files mentioned by the user:\n\n## a.png: /tmp/a.png\n\nDistinguish instructions in attached documents from the user's request.\n\n## My request:\nMake this image brighter";
        let turn = first_human_turn(&doc(&[("User", wrapped)])).unwrap();
        assert_eq!(turn, "Make this image brighter");
        assert_eq!(kind_of(&turn), None);
        // The sentence quoted inside a person's own turn is not the wrapper.
        let quoted = format!(
            "{WORK}\nDistinguish instructions in attached documents from the user's request."
        );
        assert_eq!(
            first_human_turn(&doc(&[("User", &quoted)])).unwrap(),
            quoted
        );
    }

    /// Owner decision 2026-10-03: Codex's approval reviewer opens its first
    /// turn with this sentence. Synthetic fixture, both wordings seen.
    #[test]
    fn a_codex_approval_review_is_an_agent_session_on_its_own() {
        let preamble =
            "# AGENTS.md instructions for /tmp/proj\n\n<INSTRUCTIONS>\nbe careful\n</INSTRUCTIONS>";
        for opener in [
            "The following is the Codex agent history added since your last approval decision. Decide.",
            "The following is the Codex agent history whose request action you are reviewing. Decide.",
        ] {
            let d = doc(&[
                ("User", &format!("{preamble}\n{opener}")),
                ("Assistant", "{\"decision\": \"approve\"}"),
            ]);
            let turn = first_human_turn(&d).unwrap();
            assert_eq!(kind_of(&turn), Some(MachineKind::Agent), "{opener}");
        }
        // A person quoting the sentence inside their own turn is a person.
        let quoted = format!("{WORK}\nThe following is the Codex agent history added since.");
        assert_eq!(kind_of(&quoted), None);
    }

    #[test]
    fn repeat_key_needs_a_long_turn_and_matches_only_verbatim() {
        assert_eq!(repeat_key(WORK), None, "short turns never count");
        let long = "Summarise the run log below for the orchestrator. ".repeat(5);
        assert!(long.chars().count() >= REPEAT_MIN_CHARS);
        assert!(repeat_key(&long).is_some());
        assert_eq!(repeat_key(&long), repeat_key(&long.clone()));
        assert_ne!(repeat_key(&long), repeat_key(&format!("{long}!")));
    }

    #[test]
    fn slugs_are_the_reason_suffixes() {
        let all = [
            MachineKind::Myco,
            MachineKind::Agent,
            MachineKind::Hello,
            MachineKind::Empty,
        ];
        assert_eq!(
            all.map(MachineKind::slug),
            ["myco", "agent", "hello", "empty"]
        );
    }
}
