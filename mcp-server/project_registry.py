"""project_registry.py — 멀티 프로젝트 레지스트리/resolver.

- projects.json 읽기/쓰기
- Project dataclass
- legacy 모드 지원 (projects.json이 없거나 비어있으면 현재 루트의 wiki/raw를 default로 간주)
- 모든 경로는 PROJECT_ROOT 기준 절대 경로로 변환
"""

from __future__ import annotations

import json
import os
import re
import shutil
import sys
import time
from dataclasses import dataclass, field, asdict
from datetime import datetime
from pathlib import Path

# 모듈 로드 시 PROJECT_ROOT 고정.
# When the MCP server ships bundled inside the desktop app, the script lives in
# the (read-only) app resources, NOT next to the vault — and the stdio server
# has no live IPC link back to the app. So the data root is resolved, in order:
#   1. the desktop app's "active vault" marker — the vault the app currently
#      has open (the app rewrites it on every open_vault). This makes the MCP
#      server FOLLOW the app instead of writing into the source-repo root.
#   2. MEMEX_PROJECT_ROOT env — explicit override for CLI / dev / a pinned setup
#      (used when no app marker exists, e.g. headless).
#   3. script-relative repo root — running directly from a checkout.


def _app_data_dir() -> Path:
    """Per-user app data dir — must mirror the Rust app's settings_dir()
    (app/src-tauri/src/settings.rs) so we read the marker the app writes."""
    override = os.environ.get("MEMEX_DATA_DIR")
    if override:
        return Path(override)
    home = Path(os.path.expanduser("~"))
    if sys.platform == "darwin":
        return home / "Library" / "Application Support" / "dev.cmblir.memex"
    if os.name == "nt":
        appdata = os.environ.get("APPDATA")
        return Path(appdata) / "Memex" if appdata else home / "Memex"
    return home / ".config" / "memex"


def _active_vault() -> Path | None:
    """Absolute path the app wrote to <data dir>/active-vault (one line)."""
    try:
        f = _app_data_dir() / "active-vault"
        if f.is_file():
            p = f.read_text("utf-8").strip()
            if p and Path(p).is_dir():
                return Path(p)
    except Exception:
        return None
    return None


def _resolve_project_root() -> Path:
    # 1. explicit override wins — an operator setting MEMEX_PROJECT_ROOT means
    #    "this vault", regardless of which vault the desktop app has open.
    #    (It used to lose to active-vault, which made the env var a silent no-op
    #    whenever the app had ever been launched.)
    env = os.environ.get("MEMEX_PROJECT_ROOT")
    if env:
        return Path(env).resolve()
    av = _active_vault()  # 2. follow the app's current vault
    if av:
        return av.resolve()
    return Path(__file__).resolve().parent.parent  # 3. checkout fallback


PROJECT_ROOT = _resolve_project_root()
REGISTRY_FILE = PROJECT_ROOT / "projects.json"
PROJECTS_DIR = PROJECT_ROOT / "projects"
TEMPLATES_DIR = PROJECT_ROOT / "templates"

# legacy 경로 (마이그레이션 전 현재 레이아웃)
LEGACY_WIKI = PROJECT_ROOT / "wiki"
LEGACY_RAW = PROJECT_ROOT / "raw"
LEGACY_CLAUDE_MD = PROJECT_ROOT / "CLAUDE.md"
LEGACY_SETTINGS = PROJECT_ROOT / ".dashboard-settings.json"
LEGACY_INGEST_REPORTS = PROJECT_ROOT / "ingest-reports"
LEGACY_REFLECT_REPORTS = PROJECT_ROOT / "reflect-reports"
LEGACY_QUERY_LOG = PROJECT_ROOT / "query-log.jsonl"
LEGACY_PLANS = PROJECT_ROOT / "plans"


@dataclass(frozen=True)
class Project:
    slug: str                  # "" for legacy
    title: str
    is_legacy: bool
    root: Path                 # projects/<slug>/ or PROJECT_ROOT
    wiki_dir: Path
    raw_dir: Path
    claude_md: Path
    settings_file: Path
    ingest_reports: Path
    reflect_reports: Path
    plans_dir: Path
    query_log: Path
    model: str = "default"
    description: str = ""
    created: str = ""
    last_used: str = ""
    template: str = ""
    # MP-10: True when this project has been scaffolded as its own standalone
    # Obsidian vault (its root holds an .obsidian/ dir), so it can be opened
    # independently via Obsidian's "Open folder as vault".
    independent_vault: bool = False

    def to_dict(self) -> dict:
        d = asdict(self)
        # Path → str for JSON
        for k, v in list(d.items()):
            if isinstance(v, Path):
                d[k] = str(v.relative_to(PROJECT_ROOT)) if v.is_relative_to(PROJECT_ROOT) else str(v)
        return d


# ─── registry I/O ───

def _default_registry() -> dict:
    return {"version": 1, "active": None, "projects": []}


def _load_registry() -> dict:
    if not REGISTRY_FILE.exists():
        return _default_registry()
    try:
        data = json.loads(REGISTRY_FILE.read_text("utf-8"))
        if not isinstance(data, dict):
            return _default_registry()
        data.setdefault("version", 1)
        data.setdefault("active", None)
        data.setdefault("projects", [])
        return data
    except Exception:
        return _default_registry()


def _save_registry(reg: dict) -> None:
    REGISTRY_FILE.write_text(
        json.dumps(reg, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


# ─── slug ───

def make_slug(title: str) -> str:
    """Mirror of server.make_slug — duplicated to avoid circular import."""
    s = (title or "").strip().lower()
    s = re.sub(r"[^\w\s-]", "", s, flags=re.UNICODE)
    s = re.sub(r"[\s_]+", "-", s)
    s = re.sub(r"-+", "-", s).strip("-")
    if not s:
        s = f"untitled-{int(time.time())}"
    return s


def _validate_slug(slug: str) -> str:
    """Reject a registry slug that could escape PROJECTS_DIR.

    Defense-in-depth: make_slug already strips traversal when a project is
    created, but a hand-edited or imported projects.json must not be able to
    relocate a project root outside projects/ via `..`, a path separator, or an
    absolute path. Fails closed (raises) rather than building an out-of-tree path.
    """
    s = (slug or "").strip()
    if (
        not s
        or "/" in s
        or "\\" in s
        or ".." in s
        or s.startswith(".")
        or "\x00" in s
    ):
        raise ValueError(f"invalid project slug: {slug!r}")
    root = (PROJECTS_DIR / s).resolve()
    base = PROJECTS_DIR.resolve()
    if root != base and base not in root.parents:
        raise ValueError(f"project slug escapes projects/: {slug!r}")
    return s


# ─── 프로젝트 설정 파일 (model 등) ───

def _load_project_settings(settings_path: Path) -> dict:
    if not settings_path.exists():
        return {}
    try:
        return json.loads(settings_path.read_text("utf-8")) or {}
    except Exception:
        return {}


def _save_project_settings(settings_path: Path, settings: dict) -> None:
    settings_path.write_text(
        json.dumps(settings, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


# ─── Project 인스턴스화 ───

def _legacy_project() -> Project:
    settings = _load_project_settings(LEGACY_SETTINGS)
    return Project(
        slug="",
        title="(legacy)",
        is_legacy=True,
        root=PROJECT_ROOT,
        wiki_dir=LEGACY_WIKI,
        raw_dir=LEGACY_RAW,
        claude_md=LEGACY_CLAUDE_MD,
        settings_file=LEGACY_SETTINGS,
        ingest_reports=LEGACY_INGEST_REPORTS,
        reflect_reports=LEGACY_REFLECT_REPORTS,
        plans_dir=LEGACY_PLANS,
        query_log=LEGACY_QUERY_LOG,
        model=settings.get("model", "default"),
    )


def _entry_to_project(entry: dict) -> Project:
    slug = _validate_slug(entry["slug"])
    root = PROJECTS_DIR / slug
    settings = _load_project_settings(root / ".settings.json")
    # model 우선순위: .settings.json > registry entry > default
    model = settings.get("model") or entry.get("model") or "default"
    return Project(
        slug=slug,
        title=entry.get("title", slug),
        is_legacy=False,
        root=root,
        wiki_dir=root / "wiki",
        raw_dir=root / "raw",
        claude_md=root / "CLAUDE.md",
        settings_file=root / ".settings.json",
        ingest_reports=root / "ingest-reports",
        reflect_reports=root / "reflect-reports",
        plans_dir=root / "plans",
        query_log=root / "query-log.jsonl",
        model=model,
        description=entry.get("description", ""),
        created=entry.get("created", ""),
        last_used=entry.get("last_used", ""),
        template=entry.get("template", ""),
        # Reflect the on-disk truth (an .obsidian/ dir), OR-ed with the registry
        # flag, so a hand-scaffolded vault is still recognised.
        independent_vault=bool(entry.get("independent_vault"))
        or (root / ".obsidian").is_dir(),
    )


def scaffold_independent_vault(slug: str) -> Path:
    """Make projects/<slug>/ a standalone Obsidian vault (MP-10): create a
    minimal .obsidian/ config so Obsidian can 'Open folder as vault', and set
    the registry entry's independent_vault flag. Returns the .obsidian path.
    Idempotent. Does NOT touch Obsidian's global config — the user opens the
    folder themselves.
    """
    slug = _validate_slug(slug)
    root = PROJECTS_DIR / slug
    if not root.is_dir():
        raise ValueError(f"project root missing: {slug}")
    obs = root / ".obsidian"
    obs.mkdir(parents=True, exist_ok=True)
    app_json = obs / "app.json"
    if not app_json.exists():
        # Minimal, Obsidian fills the rest on first open.
        app_json.write_text('{\n  "attachmentFolderPath": "raw/assets"\n}\n', "utf-8")
    reg = _load_registry()
    for e in reg.get("projects", []):
        if e.get("slug") == slug:
            e["independent_vault"] = True
            _save_registry(reg)
            break
    return obs


def all_raw_dirs() -> list[Path]:
    """모든 raw/ 경로 (legacy + 각 프로젝트). 쓰기 보호 판정에 사용."""
    out = [LEGACY_RAW]
    if PROJECTS_DIR.exists():
        for p in PROJECTS_DIR.iterdir():
            if p.is_dir() and not p.name.startswith("."):
                out.append(p / "raw")
    return out


def is_protected_raw(path: Path | str) -> bool:
    """주어진 경로가 어떤 raw/ 안에 있으면 True (불변 보호 대상)."""
    s = str(Path(path).absolute())
    for r in all_raw_dirs():
        rs = str(r.absolute())
        if s == rs or s.startswith(rs + "/"):
            return True
    return False


def list_projects() -> list[Project]:
    reg = _load_registry()
    out: list[Project] = []
    for e in reg.get("projects", []):
        try:
            out.append(_entry_to_project(e))
        except (ValueError, KeyError):
            # Skip a malformed or unsafe registry entry rather than aborting the
            # whole listing or building an out-of-tree path.
            continue
    return out


def get_active_slug() -> str | None:
    reg = _load_registry()
    return reg.get("active")


def has_projects() -> bool:
    reg = _load_registry()
    return bool(reg.get("projects"))


def get_project(slug: str | None = None) -> Project:
    """주어진 slug의 프로젝트. 없거나 projects.json이 비어있으면 legacy project 반환.

    Args:
        slug: 구체적 프로젝트 slug. None이면 active 사용. legacy 폴백.
    """
    reg = _load_registry()
    projects = reg.get("projects", [])
    if not projects:
        # projects.json 비어있음 → legacy
        return _legacy_project()

    target = slug or reg.get("active")
    if not target:
        # active 미지정인데 프로젝트는 있음 → 첫 항목으로 폴백
        return _entry_to_project(projects[0])

    for e in projects:
        if e.get("slug") == target:
            return _entry_to_project(e)

    # slug 불일치 → legacy 폴백 (조용히) 대신 예외
    raise KeyError(f"Project not found: {target}")


# ─── CRUD ───

# 템플릿별 권장 wiki/ 하위 폴더. 프로젝트 생성 시 자동 스캐폴드.
# 키는 templates/ 디렉터리명 및 "" (generic).
TEMPLATE_FOLDERS: dict[str, list[str]] = {
    "": ["sources", "entities", "concepts", "techniques", "analyses"],
    "llm-research": ["sources", "models", "techniques", "concepts", "entities", "benchmarks", "analyses"],
    "reading-log": ["sources", "authors", "ideas", "quotes", "reviews"],
    "personal-notes": ["daily", "topics", "people", "projects"],
}


def recommended_folders(template_name: str) -> list[str]:
    """주어진 템플릿의 권장 폴더 목록."""
    return TEMPLATE_FOLDERS.get(template_name or "", TEMPLATE_FOLDERS[""])


def list_template_names() -> list[str]:
    """`templates/` 바로 아래 디렉터리 중 CLAUDE.md를 가진 것만 허용."""
    if not TEMPLATES_DIR.is_dir():
        return []
    out = []
    for child in TEMPLATES_DIR.iterdir():
        if not child.is_dir() or child.name.startswith("."):
            continue
        if (child / "CLAUDE.md").is_file():
            out.append(child.name)
    return sorted(out)


def _copy_template(template_name: str, dest: Path) -> None:
    """templates/<name>/CLAUDE.md를 dest/CLAUDE.md로 복사. 없으면 generic.

    보안: template_name은 `list_template_names()`의 화이트리스트 + 슬래시/점 불허.
    traversal 시도(`../foo`, `a/b` 등)는 generic 폴백으로 강등.

    placeholder {{TOPIC}} {{PURPOSE}}는 create_project에서 replace.
    """
    generic = TEMPLATES_DIR / "CLAUDE.md"

    safe_name = (template_name or "").strip()
    allowed = set(list_template_names())
    bad = ("/" in safe_name) or ("\\" in safe_name) or (".." in safe_name) or safe_name.startswith(".")
    if not safe_name or bad or safe_name not in allowed:
        # generic fallback (templates/CLAUDE.md)
        src_file = generic
    else:
        candidate = TEMPLATES_DIR / safe_name / "CLAUDE.md"
        # resolve 후 TEMPLATES_DIR 아래인지 재확인 (심볼릭 링크 등 방어)
        try:
            resolved = candidate.resolve(strict=True)
            if not str(resolved).startswith(str(TEMPLATES_DIR.resolve()) + "/"):
                src_file = generic
            else:
                src_file = resolved
        except FileNotFoundError:
            src_file = generic

    if not src_file.is_file():
        # generic조차 없으면 최소 스텁
        dest.write_text("# Wiki\n\n(no template available)\n", encoding="utf-8")
        return
    dest.write_text(src_file.read_text("utf-8"), encoding="utf-8")


# Optional model-validation hook a caller may inject. Default passes everything
# (legacy-compatible). Return True to allow, False to reject.
_model_validator = lambda m: True  # noqa: E731


def set_model_validator(fn) -> None:
    """Inject model allowlist validator (to avoid circular import with server)."""
    global _model_validator
    _model_validator = fn


def create_project(
    slug_hint: str,
    title: str,
    description: str = "",
    model: str = "default",
    template: str = "",
) -> Project:
    """신규 프로젝트 생성.

    - slug_hint → make_slug → 중복 체크
    - model은 `set_model_validator`로 주입된 검증기 통과해야 함
    - projects/<slug>/ 디렉터리 + 기본 파일 생성
    - projects.json에 등록, active로 설정
    """
    if not title or not title.strip():
        raise ValueError("title is required")
    slug = make_slug(slug_hint or title)
    if not slug:
        raise ValueError("invalid slug")
    if not _model_validator(model):
        raise ValueError(f"invalid model: {model!r}")

    reg = _load_registry()
    for e in reg.get("projects", []):
        if e.get("slug") == slug:
            raise ValueError(f"slug already exists: {slug}")

    root = PROJECTS_DIR / slug
    if root.exists():
        raise ValueError(f"projects/{slug} already exists on disk")
    root.mkdir(parents=True)
    (root / "wiki").mkdir()
    (root / "raw").mkdir()
    (root / "raw" / "assets").mkdir()
    (root / "ingest-reports").mkdir()
    (root / "reflect-reports").mkdir()
    (root / "plans").mkdir()

    # 템플릿 권장 폴더 스캐폴드. 화이트리스트에 없는 템플릿이면 generic fallback.
    tmpl_key = template if template in list_template_names() else ""
    for folder in recommended_folders(tmpl_key):
        (root / "wiki" / folder).mkdir(exist_ok=True)

    # 스타터 wiki 파일 (최소)
    today = datetime.now().strftime("%Y-%m-%d")
    (root / "wiki" / "index.md").write_text(
        f"# {title} — Index\n\n## Sources\n\n## Entities\n\n## Concepts\n\n## Techniques\n\n## Analyses\n",
        encoding="utf-8",
    )
    (root / "wiki" / "log.md").write_text(
        f"# {title} — Activity Log\n\n## [{today}] init | {title}\nProject created.\n",
        encoding="utf-8",
    )
    (root / "wiki" / "overview.md").write_text(
        f"---\ntitle: \"{title}\"\ntype: overview\ncreated: {today}\nlast_updated: {today}\n---\n\n# {title}\n\n{description}\n",
        encoding="utf-8",
    )

    # CLAUDE.md 템플릿 복사
    _copy_template(template or "", root / "CLAUDE.md")
    content = (root / "CLAUDE.md").read_text("utf-8")
    content = content.replace("{{TOPIC}}", title).replace("{{PURPOSE}}", description or "")
    (root / "CLAUDE.md").write_text(content, encoding="utf-8")

    # .settings.json
    _save_project_settings(root / ".settings.json", {"model": model})

    # 빈 query-log
    (root / "query-log.jsonl").write_text("", encoding="utf-8")

    # 레지스트리 업데이트
    entry = {
        "slug": slug,
        "title": title,
        "description": description,
        "model": model,
        "created": today,
        "last_used": today,
        "template": template or "",
    }
    reg.setdefault("projects", []).append(entry)
    reg["active"] = slug
    _save_registry(reg)

    return _entry_to_project(entry)


def switch_project(slug: str) -> Project:
    reg = _load_registry()
    projects = reg.get("projects", [])
    for e in projects:
        if e.get("slug") == slug:
            reg["active"] = slug
            e["last_used"] = datetime.now().strftime("%Y-%m-%d")
            _save_registry(reg)
            return _entry_to_project(e)
    raise KeyError(f"Project not found: {slug}")


def update_project_settings(slug: str, *, model: str | None = None, title: str | None = None, description: str | None = None) -> Project:
    reg = _load_registry()
    projects = reg.get("projects", [])
    for e in projects:
        if e.get("slug") == slug:
            if model is not None:
                if not _model_validator(model):
                    raise ValueError(f"invalid model: {model!r}")
                e["model"] = model
                # .settings.json과 동기화
                sf = PROJECTS_DIR / slug / ".settings.json"
                s = _load_project_settings(sf)
                s["model"] = model
                _save_project_settings(sf, s)
            if title is not None:
                e["title"] = title
            if description is not None:
                e["description"] = description
            _save_registry(reg)
            return _entry_to_project(e)
    raise KeyError(f"Project not found: {slug}")


def delete_project(slug: str, confirm: bool = False) -> dict:
    """프로젝트 삭제. 기본값은 projects/.trash/<slug>-<ts>/로 이동 (soft).
    confirm=True여야만 실행. 'hard' 옵션은 이번 단계에서 미구현.
    """
    if not confirm:
        return {"ok": False, "error": "confirm=True required"}
    reg = _load_registry()
    projects = reg.get("projects", [])
    entry = next((e for e in projects if e.get("slug") == slug), None)
    if not entry:
        return {"ok": False, "error": f"Project not found: {slug}"}

    src = PROJECTS_DIR / slug
    trash = PROJECTS_DIR / ".trash"
    trash.mkdir(exist_ok=True)
    # ms + 충돌 시 counter. shutil.move는 dest가 존재하는 디렉터리면
    # src를 그 안으로 넣어버리기 때문에 유일한 이름을 반드시 확보해야 함.
    ts = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    dest = trash / f"{slug}-{ts}"
    n = 0
    while dest.exists():
        n += 1
        dest = trash / f"{slug}-{ts}-{n}"
    shutil.move(str(src), str(dest))

    reg["projects"] = [e for e in projects if e.get("slug") != slug]
    if reg.get("active") == slug:
        reg["active"] = reg["projects"][0]["slug"] if reg["projects"] else None
    _save_registry(reg)
    return {"ok": True, "moved_to": str(dest.relative_to(PROJECT_ROOT))}
