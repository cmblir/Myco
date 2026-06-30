// i18n — EN / KO / JA. Notion-flavoured copy.

export type Lang = "en" | "ko" | "ja";

export interface Strings {
  app_name: string;
  quick_search: string;
  quick_ingest: string;
  quick_ask: string;
  nav_workspace: string;
  nav_pages: string;
  nav_tools: string;
  nav_overview: string;
  nav_ingest: string;
  nav_query: string;
  nav_graph: string;
  nav_history: string;
  nav_provenance: string;
  nav_settings: string;
  folder__root: string;
  folder_sources: string;
  folder_entities: string;
  folder_concepts: string;
  folder_techniques: string;
  folder_analyses: string;
  ph_search: string;
  ov_eyebrow: string;
  ov_title: string;
  ov_lede: string;
  ov_cta_ingest: string;
  ov_cta_ask: string;
  ov_stats_pages: string;
  ov_stats_sources: string;
  ov_stats_links: string;
  ov_stats_ratio: string;
  ov_recent: string;
  ov_recent_more: string;
  ov_quick: string;
  ing_title: string;
  ing_lede: string;
  ing_drop: string;
  ing_drop_or: string;
  ing_browse: string;
  ing_paste_url_ph: string;
  ing_or_paste: string;
  ing_paste_ph: string;
  ing_run: string;
  ing_recent: string;
  ing_pipeline: string;
  ing_step_read: string;
  ing_step_summarize: string;
  ing_step_extract: string;
  ing_step_link: string;
  ing_step_lint: string;
  ing_step_claude: string;
  ing_step_refresh: string;
  ing_success_title: string;
  ing_success_sub: string;
  ing_open_index: string;
  ing_open_report: string;
  ing_run_again: string;
  ing_live_title: string;
  ing_live_warmup: string;
  ing_live_activity: string;
  ing_live_files: string;
  ing_live_reads: string;
  ing_live_writes: string;
  ing_cancel: string;
  ing_cancelled: string;
  ing_preview_open: string;
  ing_preview_close: string;
  ing_preview_writing: string;
  ing_chip_done: string;
  ing_chip_error: string;
  q_title: string;
  q_lede: string;
  q_ph: string;
  q_send: string;
  q_recent: string;
  q_answer: string;
  q_sources_used: string;
  q_wiki: string;
  q_raw: string;
  gr_title: string;
  gr_lede: string;
  gr_legend: string;
  gr_filter: string;
  gr_node_count: string;
  gr_edge_count: string;
  gr_settings: string;
  gr_filters: string;
  gr_display: string;
  gr_forces: string;
  gr_search: string;
  gr_search_ph: string;
  gr_tags: string;
  gr_folder: string;
  gr_all: string;
  gr_all_folders: string;
  gr_show_orphans: string;
  gr_show_orphans_hint: string;
  gr_existing_only: string;
  gr_existing_only_hint: string;
  gr_arrows: string;
  gr_arrows_hint: string;
  gr_text_fade: string;
  gr_node_size: string;
  gr_link_thickness: string;
  gr_brightness: string;
  gr_center_force: string;
  gr_repel_force: string;
  gr_link_force: string;
  gr_link_distance: string;
  gr_cluster_force: string;
  gr_reset: string;
  gr_empty_pre: string;
  gr_empty_post: string;
  gr_timelapse_play: string;
  gr_timelapse_pause: string;
  // Graph node inspector (optional — components fall back to English).
  gr_insp_type?: string;
  gr_insp_confidence?: string;
  gr_insp_status?: string;
  gr_insp_connections?: string;
  gr_insp_links_out?: string;
  gr_insp_backlinks?: string;
  gr_insp_tags?: string;
  gr_insp_open?: string;
  gr_insp_unresolved?: string;
  gr_insp_none?: string;
  gr_find_ph?: string;
  gr_insp_path_start?: string;
  gr_insp_path_anchor?: string;
  gr_insp_path_clear?: string;
  gr_insp_path?: string;
  gr_insp_path_none?: string;
  gr_insp_hops?: string;
  gr_gaps_title?: string;
  gr_gaps_btn?: string;
  gr_gap_missing?: string;
  gr_gap_orphans?: string;
  gr_gap_undercited?: string;
  gr_gap_lowconf?: string;
  gr_gap_disputed?: string;
  gr_gap_islands?: string;
  gr_gap_none?: string;
  gr_gap_more?: string;
  h_title: string;
  h_lede: string;
  h_created: string;
  h_modified: string;
  p_title: string;
  p_lede: string;
  p_threshold: string;
  p_low: string;
  p_ok: string;
  p_lint_running: string;
  p_lint_done: string;
  p_lint_failed: string;
  h_empty: string;
  s_title: string;
  s_account: string;
  s_workspace: string;
  s_model: string;
  s_providers: string;
  s_mcp: string;
  s_appearance: string;
  s_lang: string;
  s_about: string;
  mcp_lede: string;
  mcp_status_installed: string;
  mcp_status_not_installed: string;
  mcp_install_btn: string;
  mcp_installing: string;
  mcp_command_label: string;
  mcp_desktop_label: string;
  mcp_desktop_path: string;
  mcp_copy: string;
  mcp_copied: string;
  mcp_register_btn: string;
  mcp_offline_note: string;
  mcp_not_found: string;
  s_model_lede: string;
  s_model_ingest: string;
  s_model_query: string;
  s_model_recommended: string;
  s_model_ctx: string;
  s_providers_lede: string;
  s_provider_connected: string;
  s_provider_disconnected: string;
  s_provider_cli_missing: string;
  s_memexpro_url: string;
  s_memexpro_key: string;
  s_memexpro_email: string;
  s_memexpro_password: string;
  s_memexpro_login: string;
  s_memexpro_logout: string;
  s_memexpro_loggedin: string;
  s_memexpro_noaccess: string;
  s_autoingest_title: string;
  s_autoingest_desc: string;
  s_autoingest_interval: string;
  s_provider_connect: string;
  s_provider_disconnect: string;
  s_provider_test: string;
  s_lang_lede: string;
  s_lang_ui: string;
  s_lang_drafts: string;
  s_appearance_lede: string;
  s_appearance_light: string;
  s_appearance_dark: string;
  s_appearance_system: string;
  s_about_built: string;
  dlg_cancel: string;
  dlg_ok: string;
  dlg_create: string;
  dlg_delete: string;
  ol_not_installed_title: string;
  ol_not_installed_body_pre: string;
  ol_not_installed_body_post: string;
  ol_get: string;
  ol_not_running_title: string;
  ol_not_running_body_pre: string;
  ol_not_running_body_mid: string;
  ol_not_running_body_post: string;
  ol_recheck: string;
  ol_daemon_ready: string;
  ol_models_installed: string;
  ol_model_installed: string;
  ol_pull_a_model: string;
  ol_full_catalog: string;
  ol_card_installed: string;
  ol_card_pulling: string;
  ol_custom_ph: string;
  ol_pull: string;
  ol_installed_models: string;
  ol_pull_starting: string;
  ol_pull_error: string;
  ol_pull_failed: string;
  ol_pull_ready: string;
  ol_dismiss: string;
}

export const STRINGS: Record<Lang, Strings> = {
  en: {
    app_name: "Memex",
    quick_search: "Search or jump to…",
    quick_ingest: "Ingest a source",
    quick_ask: "Ask the wiki",
    nav_workspace: "Workspace",
    nav_pages: "Pages",
    nav_tools: "Tools",
    nav_overview: "Overview",
    nav_ingest: "Ingest",
    nav_query: "Ask",
    nav_graph: "Graph",
    nav_history: "History",
    nav_provenance: "Provenance",
    nav_settings: "Settings",
    folder__root: "Root",
    folder_sources: "Sources",
    folder_entities: "Entities",
    folder_concepts: "Concepts",
    folder_techniques: "Techniques",
    folder_analyses: "Analyses",
    ph_search: "Search or jump to…",
    ov_eyebrow: "Living wiki",
    ov_title: "Drop a source. Watch the graph grow.",
    ov_lede:
      "Memex turns every paper, article and note you ingest into a cross-linked, fully-cited knowledge graph — kept in plain markdown so you stay in control.",
    ov_cta_ingest: "Ingest a source",
    ov_cta_ask: "Ask the wiki",
    ov_stats_pages: "Pages",
    ov_stats_sources: "Sources",
    ov_stats_links: "Links",
    ov_stats_ratio: "Wiki-only answers",
    ov_recent: "Recent activity",
    ov_recent_more: "View all",
    ov_quick: "Jump back in",
    ing_title: "Ingest",
    ing_lede:
      "Drop a file, paste a URL, or write a note. Memex will route it through Claude, extract entities and concepts, write a source page, and weave it into the graph.",
    ing_drop: "Drop a file here",
    ing_drop_or: "or paste a URL",
    ing_browse: "Browse files…",
    ing_paste_url_ph: "https://example.com/paper.pdf",
    ing_or_paste: "Or paste raw text",
    ing_paste_ph: "Paste an article, transcript, your own notes…",
    ing_run: "Ingest with Claude",
    ing_recent: "Recent ingests",
    ing_pipeline: "Pipeline",
    ing_step_read: "Read source",
    ing_step_summarize: "Summarise",
    ing_step_extract: "Extract entities & concepts",
    ing_step_link: "Cross-link existing pages",
    ing_step_lint: "Lint and write log",
    ing_step_claude: "Claude reads & writes wiki",
    ing_step_refresh: "Refresh index & link graph",
    ing_success_title: "Ingest complete",
    ing_success_sub: "Wiki updated · {time}",
    ing_open_index: "Open wiki index",
    ing_open_report: "Open ingest report",
    ing_run_again: "Ingest another",
    ing_live_title: "Writing your wiki…",
    ing_live_warmup: "Starting Claude…",
    ing_live_activity: "Live activity",
    ing_live_files: "Pages touched",
    ing_live_reads: "read",
    ing_live_writes: "written",
    ing_cancel: "Cancel",
    ing_cancelled: "Ingest cancelled",
    ing_preview_open: "Open page",
    ing_preview_close: "Close preview",
    ing_preview_writing: "Still being written — try again in a moment.",
    ing_chip_done: "Ingest done",
    ing_chip_error: "Ingest failed",
    q_title: "Ask the wiki",
    q_lede:
      "Memex answers from your wiki first, then reaches into raw sources only when needed. Every claim ships with a citation.",
    q_ph: "What is BPE? How does midtraining differ from finetuning?",
    q_send: "Ask",
    q_recent: "Recent questions",
    q_answer: "Answer",
    q_sources_used: "Sources used",
    q_wiki: "wiki",
    q_raw: "raw",
    gr_title: "Graph",
    gr_lede:
      "Pages and the links between them. Drag nodes to feel the simulation pull, click a node to open it, open the settings panel to tune.",
    gr_legend: "Legend",
    gr_filter: "Filter",
    gr_node_count: "nodes",
    gr_edge_count: "links",
    gr_settings: "Graph settings",
    gr_filters: "Filters",
    gr_display: "Display",
    gr_forces: "Forces",
    gr_search: "Search",
    gr_search_ph: "filename contains…",
    gr_tags: "Tags",
    gr_folder: "Folder",
    gr_all: "all",
    gr_all_folders: "all folders",
    gr_show_orphans: "Show orphans",
    gr_show_orphans_hint: "Nodes with no links",
    gr_existing_only: "Existing files only",
    gr_existing_only_hint: "Hide unresolved [[wikilinks]]",
    gr_arrows: "Arrows",
    gr_arrows_hint: "Show direction on each link",
    gr_text_fade: "Text fade threshold",
    gr_node_size: "Node size",
    gr_link_thickness: "Link thickness",
    gr_brightness: "Brightness",
    gr_center_force: "Center force",
    gr_repel_force: "Repel force",
    gr_link_force: "Link force",
    gr_link_distance: "Link distance",
    gr_cluster_force: "Cluster force",
    gr_reset: "Reset",
    gr_empty_pre: "No wikilinks found in the vault yet. Add some ",
    gr_empty_post: " to see the graph grow.",
    gr_timelapse_play: "Play timelapse",
    gr_timelapse_pause: "Pause timelapse",
    gr_insp_type: "Type",
    gr_insp_confidence: "Confidence",
    gr_insp_status: "Status",
    gr_insp_connections: "Connections",
    gr_insp_links_out: "Links",
    gr_insp_backlinks: "Backlinks",
    gr_insp_tags: "Tags",
    gr_insp_open: "Open in reader",
    gr_insp_unresolved: "Unresolved note (no file yet)",
    gr_insp_none: "—",
    gr_find_ph: "Find a note…",
    gr_insp_path_start: "Set as path start",
    gr_insp_path_anchor: "Path start",
    gr_insp_path_clear: "clear",
    gr_insp_path: "Path",
    gr_insp_path_none: "No path to this node",
    gr_insp_hops: "hops",
    gr_gaps_title: "Gaps",
    gr_gaps_btn: "Gap analysis",
    gr_gap_missing: "Missing pages",
    gr_gap_orphans: "Orphans",
    gr_gap_undercited: "Under-cited",
    gr_gap_lowconf: "Low confidence",
    gr_gap_disputed: "Disputed",
    gr_gap_islands: "Disconnected",
    gr_gap_none: "No gaps found",
    gr_gap_more: "more",
    h_title: "History",
    h_lede:
      "Every ingest files a WHY report. Browse what each run created and changed, newest first.",
    h_created: "created",
    h_modified: "modified",
    h_empty:
      "No ingest reports yet — run an Ingest and its report will appear here.",
    p_title: "Provenance",
    p_lede:
      "Each wiki claim carries a citation back to the raw source. Pages with low coverage are flagged so you can fix or remove them.",
    p_threshold: "Coverage threshold",
    p_low: "Below threshold",
    p_ok: "Healthy",
    p_lint_running: "Lint is running — you can keep browsing; it continues in the background.",
    p_lint_done: "Lint done",
    p_lint_failed: "Lint failed",
    s_title: "Settings",
    s_account: "Account",
    s_workspace: "Workspace",
    s_model: "Model",
    s_providers: "Connections",
    s_appearance: "Appearance",
    s_lang: "Language",
    s_about: "About",
    s_mcp: "MCP Server",
    mcp_lede:
      "Expose this vault to Claude Code and Claude Desktop as MCP tools. Register once with the command below — it then works in every Claude session, even when this app is closed.",
    mcp_status_installed: "MCP server installed",
    mcp_status_not_installed: "MCP server not installed",
    mcp_install_btn: "Install MCP server",
    mcp_installing: "Installing…",
    mcp_command_label: "Register with Claude Code",
    mcp_desktop_label: "Claude Desktop config",
    mcp_desktop_path:
      "Add to ~/Library/Application Support/Claude/claude_desktop_config.json",
    mcp_copy: "Copy",
    mcp_copied: "Copied",
    mcp_register_btn: "Register to Claude Code now",
    mcp_offline_note:
      "Works even when Memex is closed — Claude launches the server itself.",
    mcp_not_found:
      "MCP server files are missing from this build. Reinstall the latest Memex.",
    s_model_lede:
      "Memex uses Claude by default. You can switch models for ingest, queries, or both — each task can use a different model.",
    s_model_ingest: "Ingest model",
    s_model_query: "Query model",
    s_model_recommended: "Recommended",
    s_model_ctx: "context",
    s_providers_lede:
      "Bring your own provider. Memex never sees your keys — they're stored locally.",
    s_provider_connected: "Connected",
    s_provider_disconnected: "Not connected",
    s_provider_cli_missing: "CLI not installed",
    s_memexpro_url: "Service URL",
    s_memexpro_key: "License key",
    s_memexpro_email: "Email",
    s_memexpro_password: "Password",
    s_memexpro_login: "Log in",
    s_memexpro_logout: "Log out",
    s_memexpro_loggedin: "Logged in as",
    s_memexpro_noaccess: "No active access yet",
    s_autoingest_title: "Auto-ingest inbox",
    s_autoingest_desc:
      "While Memex is open, periodically ingest sources you drop into the vault's _inbox/ folder.",
    s_autoingest_interval: "Every",
    s_provider_connect: "Connect",
    s_provider_disconnect: "Disconnect",
    s_provider_test: "Test",
    s_lang_lede:
      "Memex's UI and Claude's drafting language are independent — write English notes from a Korean UI if you like.",
    s_lang_ui: "Interface",
    s_lang_drafts: "Drafting language (Claude)",
    s_appearance_lede: "Theme follows your system by default.",
    s_appearance_light: "Light",
    s_appearance_dark: "Dark",
    s_appearance_system: "System",
    s_about_built:
      "Memex is a thin client over a local Obsidian vault and the Claude Code CLI. Pages are plain markdown — your knowledge stays yours.",
    dlg_cancel: "Cancel",
    dlg_ok: "OK",
    dlg_create: "Create",
    dlg_delete: "Delete",
    ol_not_installed_title: "Ollama not installed",
    ol_not_installed_body_pre: "Download Ollama from ",
    ol_not_installed_body_post:
      " — one click, runs as a tiny system daemon. After installing, come back here.",
    ol_get: "Get Ollama",
    ol_not_running_title: "Ollama installed but not running",
    ol_not_running_body_pre: "Start the Ollama app from Spotlight (or run ",
    ol_not_running_body_mid: " in a terminal), then click ",
    ol_not_running_body_post: ".",
    ol_recheck: "Recheck",
    ol_daemon_ready: "daemon ready",
    ol_models_installed: "models installed",
    ol_model_installed: "model installed",
    ol_pull_a_model: "Pull a model",
    ol_full_catalog: "full catalog ↗",
    ol_card_installed: "● installed",
    ol_card_pulling: "pulling…",
    ol_custom_ph: "custom model, e.g. phi3.5 or gemma2:2b",
    ol_pull: "Pull",
    ol_installed_models: "Installed models",
    ol_pull_starting: "starting…",
    ol_pull_error: "pull error",
    ol_pull_failed: "failed",
    ol_pull_ready: "ready",
    ol_dismiss: "dismiss",
  },
  ko: {
    app_name: "Memex",
    quick_search: "검색하거나 이동…",
    quick_ingest: "소스 가져오기",
    quick_ask: "위키에 질문하기",
    nav_workspace: "워크스페이스",
    nav_pages: "페이지",
    nav_tools: "도구",
    nav_overview: "개요",
    nav_ingest: "가져오기",
    nav_query: "질문",
    nav_graph: "그래프",
    nav_history: "히스토리",
    nav_provenance: "출처",
    nav_settings: "설정",
    folder__root: "루트",
    folder_sources: "소스",
    folder_entities: "엔티티",
    folder_concepts: "개념",
    folder_techniques: "기법",
    folder_analyses: "분석",
    ph_search: "검색하거나 이동…",
    ov_eyebrow: "살아있는 위키",
    ov_title: "소스를 넣으면, 그래프가 자랍니다.",
    ov_lede:
      "Memex는 가져온 모든 논문·아티클·노트를 인용 기반으로 연결된 지식 그래프로 만듭니다. 모든 페이지는 마크다운이라, 통제권은 항상 당신에게 있습니다.",
    ov_cta_ingest: "소스 가져오기",
    ov_cta_ask: "위키에 질문",
    ov_stats_pages: "페이지",
    ov_stats_sources: "소스",
    ov_stats_links: "연결",
    ov_stats_ratio: "위키만으로 답변",
    ov_recent: "최근 활동",
    ov_recent_more: "전체 보기",
    ov_quick: "이어서 보기",
    ing_title: "가져오기",
    ing_lede:
      "파일을 드롭하거나 URL을 붙여넣거나 메모를 입력하세요. Claude가 읽고, 엔티티와 개념을 추출하고, 소스 페이지를 만들고, 그래프에 엮어 넣습니다.",
    ing_drop: "여기에 파일 드롭",
    ing_drop_or: "또는 URL 붙여넣기",
    ing_browse: "파일 선택…",
    ing_paste_url_ph: "https://example.com/paper.pdf",
    ing_or_paste: "또는 원문 붙여넣기",
    ing_paste_ph: "아티클·트랜스크립트·메모를 붙여 넣으세요…",
    ing_run: "Claude로 가져오기",
    ing_recent: "최근 가져온 항목",
    ing_pipeline: "파이프라인",
    ing_step_read: "소스 읽기",
    ing_step_summarize: "요약",
    ing_step_extract: "엔티티·개념 추출",
    ing_step_link: "기존 페이지와 교차 연결",
    ing_step_lint: "린트 및 로그 기록",
    ing_step_claude: "Claude가 위키를 작성",
    ing_step_refresh: "인덱스·그래프 갱신",
    ing_success_title: "가져오기 완료",
    ing_success_sub: "위키가 갱신되었습니다 · {time}",
    ing_open_index: "위키 인덱스 열기",
    ing_open_report: "Ingest 보고서 열기",
    ing_run_again: "새로 가져오기",
    ing_live_title: "LLM 위키 작성 중…",
    ing_live_warmup: "Claude 시작 중…",
    ing_live_activity: "실시간 활동",
    ing_live_files: "작업한 페이지",
    ing_live_reads: "읽음",
    ing_live_writes: "작성",
    ing_cancel: "취소",
    ing_cancelled: "가져오기가 취소되었습니다",
    ing_preview_open: "페이지 열기",
    ing_preview_close: "미리보기 닫기",
    ing_preview_writing: "아직 작성 중입니다 — 잠시 후 다시 눌러보세요.",
    ing_chip_done: "가져오기 완료",
    ing_chip_error: "가져오기 실패",
    q_title: "위키에 질문하기",
    q_lede:
      "Memex는 먼저 위키에서 답을 찾고, 부족할 때만 원본 소스로 들어갑니다. 모든 주장에는 인용이 따라옵니다.",
    q_ph: "BPE는 무엇인가요? 미드트레이닝은 파인튜닝과 어떻게 다른가요?",
    q_send: "질문하기",
    q_recent: "최근 질문",
    q_answer: "답변",
    q_sources_used: "참조된 소스",
    q_wiki: "위키",
    q_raw: "원본",
    gr_title: "그래프",
    gr_lede:
      "페이지와 그 사이의 연결. 노드를 드래그하면 시뮬레이션이 따라옵니다. 우측 설정 패널에서 필터/디스플레이/포스를 조정하세요.",
    gr_legend: "범례",
    gr_filter: "필터",
    gr_node_count: "노드",
    gr_edge_count: "연결",
    gr_settings: "그래프 설정",
    gr_filters: "필터",
    gr_display: "디스플레이",
    gr_forces: "포스",
    gr_search: "검색",
    gr_search_ph: "파일명 포함...",
    gr_tags: "태그",
    gr_folder: "폴더",
    gr_all: "전체",
    gr_all_folders: "전체 폴더",
    gr_show_orphans: "고립 노드 표시",
    gr_show_orphans_hint: "연결이 없는 노드",
    gr_existing_only: "존재하는 파일만",
    gr_existing_only_hint: "미해결 [[위키링크]] 숨김",
    gr_arrows: "화살표",
    gr_arrows_hint: "각 링크에 방향 표시",
    gr_text_fade: "라벨 페이드 임계",
    gr_node_size: "노드 크기",
    gr_link_thickness: "링크 두께",
    gr_brightness: "밝기",
    gr_center_force: "중심력",
    gr_repel_force: "반발력",
    gr_link_force: "링크 장력",
    gr_link_distance: "링크 거리",
    gr_cluster_force: "뭉침 강도",
    gr_reset: "초기화",
    gr_empty_pre: "아직 위키링크가 없습니다. ",
    gr_empty_post: " 를 추가하면 그래프가 자랍니다.",
    gr_timelapse_play: "타임랩스 재생",
    gr_timelapse_pause: "타임랩스 일시정지",
    gr_insp_type: "유형",
    gr_insp_confidence: "신뢰도",
    gr_insp_status: "상태",
    gr_insp_connections: "연결 수",
    gr_insp_links_out: "나가는 링크",
    gr_insp_backlinks: "백링크",
    gr_insp_tags: "태그",
    gr_insp_open: "리더에서 열기",
    gr_insp_unresolved: "미해결 노트 (파일 없음)",
    gr_insp_none: "—",
    gr_find_ph: "노트 찾기…",
    gr_insp_path_start: "경로 시작점으로",
    gr_insp_path_anchor: "경로 시작점",
    gr_insp_path_clear: "지우기",
    gr_insp_path: "경로",
    gr_insp_path_none: "이 노드까지 경로 없음",
    gr_insp_hops: "홉",
    gr_gaps_title: "갭",
    gr_gaps_btn: "갭 분석",
    gr_gap_missing: "없는 페이지",
    gr_gap_orphans: "고립 노드",
    gr_gap_undercited: "인용 부족",
    gr_gap_lowconf: "낮은 신뢰도",
    gr_gap_disputed: "논쟁",
    gr_gap_islands: "끊긴 클러스터",
    gr_gap_none: "갭 없음",
    gr_gap_more: "더",
    h_title: "히스토리",
    h_lede:
      "모든 가져오기는 WHY 보고서를 남깁니다. 각 실행이 무엇을 만들고 바꿨는지 최신순으로 봅니다.",
    h_created: "생성",
    h_modified: "수정",
    h_empty:
      "아직 가져오기 기록이 없습니다 — Ingest를 실행하면 보고서가 여기에 쌓입니다.",
    p_title: "출처",
    p_lede:
      "위키의 각 주장은 원본 소스로 인용됩니다. 인용 비율이 낮은 페이지는 표시되어 수정하거나 제거할 수 있습니다.",
    p_threshold: "인용률 임계값",
    p_low: "임계값 미만",
    p_ok: "양호",
    p_lint_running: "Lint 실행 중 — 다른 페이지로 이동해도 백그라운드에서 계속됩니다.",
    p_lint_done: "Lint 완료",
    p_lint_failed: "Lint 실패",
    s_title: "설정",
    s_account: "계정",
    s_workspace: "워크스페이스",
    s_model: "모델",
    s_providers: "연결",
    s_appearance: "테마",
    s_lang: "언어",
    s_about: "정보",
    s_mcp: "MCP 서버",
    mcp_lede:
      "이 vault를 Claude Code·Claude Desktop에 MCP 도구로 노출합니다. 아래 명령으로 한 번만 등록하면, 이 앱이 꺼져 있어도 모든 Claude 세션에서 동작합니다.",
    mcp_status_installed: "MCP 서버 설치됨",
    mcp_status_not_installed: "MCP 서버 미설치",
    mcp_install_btn: "MCP 서버 설치",
    mcp_installing: "설치 중…",
    mcp_command_label: "Claude Code에 등록",
    mcp_desktop_label: "Claude Desktop 설정",
    mcp_desktop_path:
      "~/Library/Application Support/Claude/claude_desktop_config.json 에 추가",
    mcp_copy: "복사",
    mcp_copied: "복사됨",
    mcp_register_btn: "지금 Claude Code에 등록",
    mcp_offline_note:
      "Memex가 꺼져 있어도 동작 — Claude가 서버를 직접 띄웁니다.",
    mcp_not_found:
      "이 빌드에 MCP 서버 파일이 없습니다. 최신 Memex를 다시 설치하세요.",
    s_model_lede:
      "Memex는 기본적으로 Claude를 사용합니다. 가져오기와 질문에 서로 다른 모델을 지정할 수 있습니다.",
    s_model_ingest: "가져오기용 모델",
    s_model_query: "질문용 모델",
    s_model_recommended: "추천",
    s_model_ctx: "컨텍스트",
    s_providers_lede:
      "원하는 제공자를 연결하세요. 키는 로컬에만 저장되며, Memex 서버는 절대 보지 못합니다.",
    s_provider_connected: "연결됨",
    s_provider_disconnected: "미연결",
    s_provider_cli_missing: "CLI 설치 안 됨",
    s_memexpro_url: "서비스 URL",
    s_memexpro_key: "라이선스 키",
    s_memexpro_email: "이메일",
    s_memexpro_password: "비밀번호",
    s_memexpro_login: "로그인",
    s_memexpro_logout: "로그아웃",
    s_memexpro_loggedin: "로그인:",
    s_memexpro_noaccess: "활성 구독 없음",
    s_autoingest_title: "인박스 자동 인게스트",
    s_autoingest_desc:
      "Memex가 켜져 있는 동안 vault의 _inbox/ 폴더에 넣은 소스를 주기적으로 인게스트합니다.",
    s_autoingest_interval: "주기",
    s_provider_connect: "연결",
    s_provider_disconnect: "해제",
    s_provider_test: "테스트",
    s_lang_lede:
      "UI 언어와 Claude의 작성 언어는 별개입니다. 한국어 UI에서 영어 노트를 만들어도 좋습니다.",
    s_lang_ui: "인터페이스",
    s_lang_drafts: "작성 언어 (Claude)",
    s_appearance_lede: "기본값은 시스템을 따릅니다.",
    s_appearance_light: "라이트",
    s_appearance_dark: "다크",
    s_appearance_system: "시스템",
    s_about_built:
      "Memex는 로컬 Obsidian 볼트와 Claude Code CLI 위에서 동작하는 얇은 클라이언트입니다. 페이지는 마크다운 — 당신의 지식은 당신의 것입니다.",
    dlg_cancel: "취소",
    dlg_ok: "확인",
    dlg_create: "만들기",
    dlg_delete: "삭제",
    ol_not_installed_title: "Ollama가 설치되어 있지 않습니다",
    ol_not_installed_body_pre: "Ollama를 ",
    ol_not_installed_body_post:
      " 에서 받으세요 — 클릭 한 번이면 작은 시스템 데몬으로 실행됩니다. 설치 후 이 화면으로 돌아오세요.",
    ol_get: "Ollama 받기",
    ol_not_running_title: "Ollama가 설치되었지만 실행 중이 아닙니다",
    ol_not_running_body_pre: "Spotlight에서 Ollama 앱을 실행하거나(터미널에서 ",
    ol_not_running_body_mid: " 실행), ",
    ol_not_running_body_post: " 을(를) 누르세요.",
    ol_recheck: "다시 확인",
    ol_daemon_ready: "데몬 준비됨",
    ol_models_installed: "개 모델 설치됨",
    ol_model_installed: "개 모델 설치됨",
    ol_pull_a_model: "모델 받기",
    ol_full_catalog: "전체 카탈로그 ↗",
    ol_card_installed: "● 설치됨",
    ol_card_pulling: "받는 중…",
    ol_custom_ph: "사용자 지정 모델, 예: phi3.5 또는 gemma2:2b",
    ol_pull: "받기",
    ol_installed_models: "설치된 모델",
    ol_pull_starting: "시작 중…",
    ol_pull_error: "받기 오류",
    ol_pull_failed: "실패",
    ol_pull_ready: "준비됨",
    ol_dismiss: "닫기",
  },
  ja: {
    app_name: "Memex",
    quick_search: "検索 / 移動…",
    quick_ingest: "ソースを取り込む",
    quick_ask: "ウィキに質問",
    nav_workspace: "ワークスペース",
    nav_pages: "ページ",
    nav_tools: "ツール",
    nav_overview: "概要",
    nav_ingest: "取り込み",
    nav_query: "質問",
    nav_graph: "グラフ",
    nav_history: "履歴",
    nav_provenance: "出典",
    nav_settings: "設定",
    folder__root: "ルート",
    folder_sources: "ソース",
    folder_entities: "エンティティ",
    folder_concepts: "概念",
    folder_techniques: "技法",
    folder_analyses: "分析",
    ph_search: "検索 / 移動…",
    ov_eyebrow: "生きたウィキ",
    ov_title: "ソースを入れる。グラフが育つ。",
    ov_lede:
      "Memex は取り込んだ論文・記事・ノートを、引用付きの知識グラフへと織り上げます。すべてはマークダウン — あなたの知識は、あなたの手の中に。",
    ov_cta_ingest: "ソースを取り込む",
    ov_cta_ask: "ウィキに質問",
    ov_stats_pages: "ページ",
    ov_stats_sources: "ソース",
    ov_stats_links: "リンク",
    ov_stats_ratio: "ウィキだけで回答",
    ov_recent: "最近のアクティビティ",
    ov_recent_more: "すべて見る",
    ov_quick: "続きから",
    ing_title: "取り込み",
    ing_lede:
      "ファイルをドロップ、URL を貼り付け、あるいはメモを書く。Claude が読み、エンティティと概念を抽出し、ソースページを作成し、グラフに織り込みます。",
    ing_drop: "ここにファイルをドロップ",
    ing_drop_or: "または URL を貼り付け",
    ing_browse: "ファイルを選択…",
    ing_paste_url_ph: "https://example.com/paper.pdf",
    ing_or_paste: "原文を貼り付け",
    ing_paste_ph: "記事・トランスクリプト・メモを貼り付けてください…",
    ing_run: "Claude で取り込む",
    ing_recent: "最近の取り込み",
    ing_pipeline: "パイプライン",
    ing_step_read: "ソースを読む",
    ing_step_summarize: "要約",
    ing_step_extract: "エンティティ・概念を抽出",
    ing_step_link: "既存ページと相互リンク",
    ing_step_lint: "リント & ログ書き込み",
    ing_step_claude: "Claude がウィキを書く",
    ing_step_refresh: "インデックス・グラフ更新",
    ing_success_title: "取り込み完了",
    ing_success_sub: "ウィキを更新しました · {time}",
    ing_open_index: "ウィキインデックスを開く",
    ing_open_report: "取り込みレポートを開く",
    ing_run_again: "別のソースを取り込む",
    ing_live_title: "LLM がウィキを作成中…",
    ing_live_warmup: "Claude を起動中…",
    ing_live_activity: "ライブアクティビティ",
    ing_live_files: "作業したページ",
    ing_live_reads: "読込",
    ing_live_writes: "作成",
    ing_cancel: "キャンセル",
    ing_cancelled: "取り込みをキャンセルしました",
    ing_preview_open: "ページを開く",
    ing_preview_close: "プレビューを閉じる",
    ing_preview_writing: "まだ書き込み中です — 少し待ってからもう一度。",
    ing_chip_done: "取り込み完了",
    ing_chip_error: "取り込み失敗",
    q_title: "ウィキに質問",
    q_lede:
      "Memex はまずウィキから答え、必要なときだけ原本に降りていきます。すべての主張に出典が付きます。",
    q_ph: "BPE とは? ミッドトレーニングはファインチューニングとどう違う?",
    q_send: "質問する",
    q_recent: "最近の質問",
    q_answer: "回答",
    q_sources_used: "参照したソース",
    q_wiki: "ウィキ",
    q_raw: "原本",
    gr_title: "グラフ",
    gr_lede:
      "ページとリンク。ノードをドラッグするとシミュレーションが追従。右側パネルでフィルター/表示/力を調整。",
    gr_legend: "凡例",
    gr_filter: "フィルター",
    gr_node_count: "ノード",
    gr_edge_count: "リンク",
    gr_settings: "グラフ設定",
    gr_filters: "フィルター",
    gr_display: "表示",
    gr_forces: "力",
    gr_search: "検索",
    gr_search_ph: "ファイル名に含む…",
    gr_tags: "タグ",
    gr_folder: "フォルダ",
    gr_all: "すべて",
    gr_all_folders: "すべてのフォルダ",
    gr_show_orphans: "孤立ノード表示",
    gr_show_orphans_hint: "リンクなしのノード",
    gr_existing_only: "既存ファイルのみ",
    gr_existing_only_hint: "未解決の [[wikilinks]] を非表示",
    gr_arrows: "矢印",
    gr_arrows_hint: "各リンクに方向を表示",
    gr_text_fade: "ラベルフェード閾値",
    gr_node_size: "ノードサイズ",
    gr_link_thickness: "リンク太さ",
    gr_brightness: "明るさ",
    gr_center_force: "中心力",
    gr_repel_force: "反発力",
    gr_link_force: "リンク張力",
    gr_link_distance: "リンク距離",
    gr_cluster_force: "クラスター力",
    gr_reset: "リセット",
    gr_empty_pre: "まだウィキリンクがありません。",
    gr_empty_post: " を追加するとグラフが育ちます。",
    gr_timelapse_play: "タイムラプス再生",
    gr_timelapse_pause: "タイムラプス一時停止",
    h_title: "履歴",
    h_lede:
      "すべての取り込みは WHY レポートを残します。各実行が何を作り、何を変えたかを新しい順に見られます。",
    h_created: "作成",
    h_modified: "変更",
    h_empty:
      "まだ取り込み履歴がありません — Ingest を実行するとレポートがここに溜まります。",
    p_title: "出典",
    p_lede:
      "ウィキの各主張は原本に紐づきます。引用率の低いページにはフラグが立ち、修正や削除を促します。",
    p_threshold: "引用率しきい値",
    p_low: "しきい値未満",
    p_ok: "良好",
    p_lint_running: "Lint 実行中 — 他のページに移動してもバックグラウンドで続行します。",
    p_lint_done: "Lint 完了",
    p_lint_failed: "Lint 失敗",
    s_title: "設定",
    s_account: "アカウント",
    s_workspace: "ワークスペース",
    s_model: "モデル",
    s_providers: "接続",
    s_appearance: "外観",
    s_lang: "言語",
    s_about: "Memex について",
    s_mcp: "MCP サーバー",
    mcp_lede:
      "この vault を Claude Code・Claude Desktop に MCP ツールとして公開します。下のコマンドで一度登録すれば、このアプリを閉じていても全ての Claude セッションで動作します。",
    mcp_status_installed: "MCP サーバー導入済み",
    mcp_status_not_installed: "MCP サーバー未導入",
    mcp_install_btn: "MCP サーバーを導入",
    mcp_installing: "導入中…",
    mcp_command_label: "Claude Code に登録",
    mcp_desktop_label: "Claude Desktop 設定",
    mcp_desktop_path:
      "~/Library/Application Support/Claude/claude_desktop_config.json に追加",
    mcp_copy: "コピー",
    mcp_copied: "コピー済み",
    mcp_register_btn: "今すぐ Claude Code に登録",
    mcp_offline_note:
      "Memex を閉じていても動作 — Claude がサーバーを自分で起動します。",
    mcp_not_found:
      "このビルドに MCP サーバーファイルがありません。最新の Memex を再インストールしてください。",
    s_model_lede:
      "Memex は標準で Claude を使います。取り込みと質問で別々のモデルを指定できます。",
    s_model_ingest: "取り込み用モデル",
    s_model_query: "質問用モデル",
    s_model_recommended: "推奨",
    s_model_ctx: "コンテキスト",
    s_providers_lede:
      "好きなプロバイダーを接続してください。キーはローカル保存 — Memex のサーバーには届きません。",
    s_provider_connected: "接続済み",
    s_provider_disconnected: "未接続",
    s_provider_cli_missing: "CLI 未インストール",
    s_memexpro_url: "サービス URL",
    s_memexpro_key: "ライセンスキー",
    s_memexpro_email: "メール",
    s_memexpro_password: "パスワード",
    s_memexpro_login: "ログイン",
    s_memexpro_logout: "ログアウト",
    s_memexpro_loggedin: "ログイン中:",
    s_memexpro_noaccess: "有効なアクセスなし",
    s_autoingest_title: "受信トレイ自動取り込み",
    s_autoingest_desc:
      "Memexを開いている間、vaultの_inbox/フォルダに入れたソースを定期的に取り込みます。",
    s_autoingest_interval: "間隔",
    s_provider_connect: "接続",
    s_provider_disconnect: "解除",
    s_provider_test: "テスト",
    s_lang_lede:
      "UI 言語と Claude の作成言語は独立。日本語 UI から英語のノートを書いても OK です。",
    s_lang_ui: "インターフェース",
    s_lang_drafts: "作成言語 (Claude)",
    s_appearance_lede: "既定はシステム設定に従います。",
    s_appearance_light: "ライト",
    s_appearance_dark: "ダーク",
    s_appearance_system: "システム",
    s_about_built:
      "Memex はローカルの Obsidian ボルトと Claude Code CLI 上に立つ薄いクライアントです。ページはマークダウン — あなたの知識はあなたのもの。",
    dlg_cancel: "キャンセル",
    dlg_ok: "OK",
    dlg_create: "作成",
    dlg_delete: "削除",
    ol_not_installed_title: "Ollama がインストールされていません",
    ol_not_installed_body_pre: "Ollama を ",
    ol_not_installed_body_post:
      " からダウンロード — ワンクリックで小さなシステムデーモンとして動作します。インストール後、この画面に戻ってください。",
    ol_get: "Ollama を入手",
    ol_not_running_title: "Ollama はインストール済みですが起動していません",
    ol_not_running_body_pre: "Spotlight から Ollama アプリを起動（またはターミナルで ",
    ol_not_running_body_mid: " を実行）し、",
    ol_not_running_body_post: " をクリックしてください。",
    ol_recheck: "再確認",
    ol_daemon_ready: "デーモン準備完了",
    ol_models_installed: "個のモデルがインストール済み",
    ol_model_installed: "個のモデルがインストール済み",
    ol_pull_a_model: "モデルを取得",
    ol_full_catalog: "全カタログ ↗",
    ol_card_installed: "● インストール済み",
    ol_card_pulling: "取得中…",
    ol_custom_ph: "カスタムモデル、例: phi3.5 または gemma2:2b",
    ol_pull: "取得",
    ol_installed_models: "インストール済みモデル",
    ol_pull_starting: "開始中…",
    ol_pull_error: "取得エラー",
    ol_pull_failed: "失敗",
    ol_pull_ready: "準備完了",
    ol_dismiss: "閉じる",
  },
};
