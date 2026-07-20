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
  nav_views?: string;
  ls_title?: string;
  ls_hint?: string;
  ls_accept?: string;
  ls_dismiss?: string;
  zi_title?: string;
  zi_hint?: string;
  zi_none?: string;
  zi_done?: string;
  ci_title?: string;
  ci_hint?: string;
  ci_btn?: string;
  ci_busy?: string;
  ci_done?: string; // {n}
  ci_quarantined?: string; // {n}
  ci_none?: string;
  ci_skipped?: string; // {n}
  ci_sweep_cc?: string;
  ci_sweep_cx?: string;
  ci_sweep_hint?: string;
  ci_sweep_progress?: string; // {done} {total}
  ci_sweep_tally?: string; // {i} {s} {f}
  ci_failed_summary?: string; // {n}
  ci_retry_failed?: string; // {n}
  q_empty?: string;
  s_mascot?: string;
  s_mascot_hint?: string;
  hw_title?: string;
  hw_sub?: string;
  hw_sc_cmd?: string;
  hw_sc_sidebar?: string;
  hw_sc_fly?: string;
  hw_sc_esc?: string;
  hw_tip_graph1?: string;
  hw_tip_graph2?: string;
  hw_tip_graph3?: string;
  hw_tip_query1?: string;
  hw_tip_query2?: string;
  hw_tip_ingest1?: string;
  hw_tip_ingest2?: string;
  hw_tip_views1?: string;
  hw_tip_overview1?: string;
  hw_tip_default?: string;
  vw_title?: string;
  vw_lede?: string;
  vw_search?: string;
  vw_any_type?: string;
  vw_any_conf?: string;
  vw_any_status?: string;
  vw_any_tag?: string;
  vw_orphans?: string;
  vw_save?: string;
  vw_save_prompt?: string;
  vw_pages?: string;
  vw_empty?: string;
  vw_col_name?: string;
  vw_col_type?: string;
  vw_col_conf?: string;
  vw_col_sources?: string;
  vw_col_links?: string;
  vw_col_tags?: string;
  nav_history: string;
  nav_provenance: string;
  nav_tasks: string;
  tasks_title: string;
  tasks_lede: string;
  tasks_loading: string;
  tasks_empty: string;
  tasks_empty_hint: string;
  tasks_open_n: string;
  tasks_done_n: string;
  tasks_all_done: string;
  tasks_completed: string;
  nav_tags: string;
  nav_study: string;
  nav_schedules: string;
  nav_settings: string;
  // Multiverse overview (Phase 1)
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
  ing_drop_multi?: string; // {n} = count
  ing_yt_fetch?: string;
  ing_yt_fetching?: string;
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
  hist_collapse?: string;
  hist_expand?: string;
  ing_run_again: string;
  ing_live_title: string;
  ing_live_warmup: string;
  ing_live_activity: string;
  ing_live_files: string;
  ing_live_reads: string;
  ing_live_writes: string;
  ing_grounded: string;
  ing_grounded_hint: string;
  ing_plan: string;
  ing_plan_hint: string;
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
  gr_skin?: string;
  gr_skin_auto?: string;
  gr_skin_black?: string;
  gr_skin_white?: string;
  gr_skin_galaxy?: string;
  gr_galaxies?: string;
  gr_galaxies_hint?: string;
  gr_multiverse?: string;
  gr_multiverse_hint?: string;
  gr_mv_loading?: string;
  gr_mv_none?: string;
  gr_layout?: string;
  gr_layout_galaxy?: string;
  gr_layout_atlas?: string;
  gr_layout_synapse?: string;
  gr_layout_synapse3d?: string;
  gr_recommend?: string;
  gr_recommend_hint?: string;
  gr_sky?: string;
  gr_sky_stars?: string;
  gr_sky_dense?: string;
  gr_sky_grid?: string;
  gr_sky_void?: string;
  gr_node_color?: string;
  gr_node_color_community?: string;
  gr_node_color_white?: string;
  gr_node_color_auto?: string;
  gr_mono_below?: string;
  gr_tl_speed?: string;
  gr_scale_star?: string;
  gr_scale_system?: string;
  gr_scale_galaxy?: string;
  gr_scale_cluster?: string;
  gr_arrows: string;
  gr_arrows_hint: string;
  gr_arrow_size: string;
  gr_semantic_edges?: string;
  gr_semantic_edges_hint?: string;
  gr_edge_bundles?: string;
  gr_edge_bundles_hint?: string;
  gr_fly_btn?: string;
  gr_timelapse_record?: string;
  gr_node_color_black?: string;
  gr_cosmic?: string;
  gr_cosmic_hint?: string;
  gr_cosmic_freq?: string;
  gr_click_burst?: string;
  gr_click_burst_hint?: string;
  gr_neural_firing?: string;
  gr_neural_firing_hint?: string;
  gr_planets?: string;
  gr_planets_hint?: string;
  gr_color_depth?: string;
  gr_edge_tint?: string;
  gr_edge_tint_grey?: string;
  gr_edge_tint_community?: string;
  // Gesture cheat-sheet popover ("?" toolbar button).
  gr_help_btn?: string;
  gr_help_title?: string;
  gr_help_click?: string;
  gr_help_dblclick?: string;
  gr_help_cmdclick?: string;
  gr_help_esc?: string;
  gr_help_fly?: string;
  gr_help_drag?: string;
  gr_trace: string;
  gr_trace_hint: string;
  gr_spaceship: string;
  gr_spaceship_hint: string;
  gr_spaceship_exit: string;
  gr_speed?: string;
  gr_close: string;
  gr_open: string;
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
  gr_gap_bridges?: string;
  gr_gap_ask?: string;
  gr_bridge_question?: string;
  gr_gap_more?: string;
  q_thinking?: string;
  q_answering?: string;
  q_answering_from?: string;
  gr_key_size?: string;
  gr_key_dim?: string;
  gr_key_amber?: string;
  gr_key_neutral?: string;
  gr_more?: string; // legend: "+{n} more" clusters beyond the shown cap
  gr_focus_trail?: string;
  gr_focus_esc?: string;
  gr_preset?: string;
  gr_preset_galaxy?: string;
  gr_preset_loose?: string;
  gr_preset_dense?: string;
  gr_glow?: string;
  gr_motion?: string;
  gr_motion_hint?: string;
  gr_advanced?: string;
  gr_loading?: string;
  gr_ctx_lost?: string;
  gr_retry?: string;
  gr_perf_mode?: string;
  h_title: string;
  h_lede: string;
  h_created: string;
  h_modified: string;
  p_title: string;
  p_lede: string;
  p_threshold: string;
  p_low: string;
  p_ok: string;
  p_sources: string;
  p_src_manual: string;
  p_src_missing: string;
  p_lint_running: string;
  p_lint_done: string;
  p_lint_failed: string;
  h_empty: string;
  s_title: string;
  s_account: string;
  s_local_user?: string;
  s_no_vault?: string;
  s_vault_path?: string;
  s_change?: string;
  q_empty_response?: string;
  eb_title?: string; // "{area}" is substituted with eb_area_*
  eb_reload?: string;
  eb_retry?: string;
  eb_area_app?: string;
  eb_area_graph?: string;
  s_workspace: string;
  s_model: string;
  s_embeddings?: string;
  s_embeddings_lede?: string;
  s_embeddings_indexed?: string;
  s_embeddings_reindex?: string;
  s_embeddings_indexing?: string;
  s_embeddings_empty?: string;
  s_embeddings_loading_model?: string;
  s_embeddings_loading_model_hint?: string;
  s_embeddings_done?: string;
  s_autoreindex_title?: string;
  s_autoreindex_desc?: string;
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
  mcp_serving?: string;
  mcp_not_serving?: string;
  mcp_start_btn?: string;
  mcp_stop_btn?: string;
  mcp_registering?: string;
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
  ol_delete: string;
  ol_delete_confirm: string;
  ol_delete_yes: string;
  ol_deleting: string;
  ol_delete_failed: string;
  // Shared UI (optional — components fall back to English).
  ui_close?: string;
  // Provenance page.
  p_lint_run?: string;
  p_linting?: string;
  p_lint_report?: string;
  p_dismiss?: string;
  p_open_vault?: string;
  p_scanning?: string;
  p_empty?: string;
  p_overall?: string;
  p_claims_cited?: string;
  p_pages_by_coverage?: string;
  // Reader page.
  rd_meta?: string;
  rd_source?: string;
  rd_split?: string;
  rd_preview?: string;
  rd_backlinks_empty?: string;
  rd_related?: string;
  rd_related_no_index?: string;
  rd_related_no_index_cta?: string;
  rd_make_cards?: string;
  rd_making?: string;
  rd_cards_none?: string;
  rd_cards_made?: string;
  rd_open_study?: string;
  // Study page (Feature 3).
  st_title?: string;
  st_lede?: string;
  st_no_decks?: string;
  st_generate_hint?: string;
  st_browse_pages?: string;
  st_refresh?: string;
  st_total?: string;
  st_due?: string;
  st_no_due?: string;
  st_all_decks?: string;
  st_review?: string;
  st_quiz?: string;
  st_loading?: string;
  st_progress?: string;
  st_source?: string;
  st_flip?: string;
  st_grade_again?: string;
  st_grade_hard?: string;
  st_grade_good?: string;
  st_grade_easy?: string;
  st_all_done?: string;
  st_done_sub?: string;
  st_quiz_needs_cards?: string;
  st_quiz_intro?: string;
  st_quiz_empty?: string;
  st_gen_quiz?: string;
  st_generating?: string;
  st_quiz_done?: string;
  st_quiz_score?: string;
  st_correct?: string;
  st_wrong?: string;
  st_next?: string;
  // Agent mode (Feature 4).
  q_mode?: string;
  q_mode_ask?: string;
  q_mode_agent?: string;
  ag_lede?: string;
  ag_preset?: string;
  ag_preset_none?: string;
  ag_new_preset?: string;
  ag_preset_name?: string;
  ag_preset_prompt?: string;
  ag_preset_prompt_hint?: string;
  ag_allow_write?: string;
  ag_write_hint?: string;
  ag_ph?: string;
  ag_run?: string;
  ag_stop?: string;
  ag_task?: string;
  ag_steps?: string;
  ag_working?: string;
  ag_declined?: string;
  ag_stopped_limit?: string;
  ag_unsupported?: string;
  // Audio overview (Feature 5).
  rd_audio?: string;
  au_title?: string;
  au_close?: string;
  au_generating?: string;
  au_play?: string;
  au_pause?: string;
  au_stop?: string;
  au_turns?: string;
  au_open_transcript?: string;
  au_no_tts?: string;
  au_host?: string;
  au_guest?: string;
  au_play_from?: string;
  // PDF viewer (Feature 6).
  pdf_page?: string;
  pdf_close?: string;
  pdf_loading?: string;
  pdf_error?: string;
  pdf_highlight_cite?: string;
  // Schedules (Feature 7).
  sc_title?: string;
  sc_lede?: string;
  sc_new?: string;
  sc_empty?: string;
  sc_run_now?: string;
  sc_running?: string;
  sc_edit?: string;
  sc_last_run?: string;
  sc_never?: string;
  sc_done?: string;
  sc_open?: string;
  sc_f_title?: string;
  sc_f_kind?: string;
  sc_f_cadence?: string;
  sc_f_prompt?: string;
  sc_f_topic?: string;
  sc_f_enabled?: string;
  sc_f_notify?: string;
  sc_f_notify_hint?: string;
  sc_f_save?: string;
  sc_f_cancel?: string;
  sc_bg_install?: string;
  sc_bg_remove?: string;
  sc_bg_hint?: string;
  // Ingest page.
  ing_title_label?: string;
  ing_title_ph?: string;
  ing_working?: string;
  // Query page.
  q_via?: string;
  q_builtin_note?: string;
  q_open_model_settings?: string;
  q_you?: string;
  // Sidebar.
  sb_new_note?: string;
  sb_new_folder?: string;
  sb_rename?: string;
  sb_today_note?: string;
  sb_new_note_root?: string;
  sb_delete_folder_q?: string;
  sb_delete_file_q?: string;
  // Command bar.
  cb_no_results?: string;
  cb_tag_page?: string;
  cb_tag_file?: string;
  cb_in_contents?: string;
  cb_semantic?: string;
  // Topbar.
  tb_lint?: string;
  tb_toggle_sidebar?: string;
  tb_model_picker?: string;
  // Graph toolbar.
  gr_zoom_out?: string;
  gr_fit?: string;
  gr_zoom_in?: string;
  // Overview / History empty states.
  ov_no_git?: string;
  h_open_vault?: string;
  // Tags page (FEAT-03).
  tg_title: string;
  tg_lede: string;
  tg_empty: string;
  // Reflect suggestions panel (FEAT-06).
  rf_title: string;
  rf_lede: string;
  rf_run: string;
  rf_running: string;
  rf_empty: string;
  // First-run onboarding wizard (UX-01) — optional; components fall back to EN.
  ob_title?: string;
  ob_skip?: string;
  ob_back?: string;
  ob_next?: string;
  ob_finish?: string;
  ob_vault_linked?: string;
  ob_vault_none?: string;
  ob_s1_title?: string;
  ob_s1_body?: string;
  ob_s1_action?: string;
  ob_s2_title?: string;
  ob_s2_body?: string;
  ob_s2_action?: string;
  ob_s3_title?: string;
  ob_s3_body?: string;
  ob_s3_action?: string;
  // Budget guard (OPS-03) — optional; components fall back to English.
  s_budget_title?: string;
  s_budget_desc?: string;
  s_budget_threshold?: string;
  s_budget_usage?: string;
  s_budget_total?: string;
  s_budget_empty?: string;
  // Auto-reflect (FEAT-06) — optional; components fall back to English.
  s_autoreflect_title?: string;
  s_autoreflect_desc?: string;
  s_autoreflect_interval?: string;
  // Independent Obsidian vault (MP-10) — optional; fall back to English.
  s_vault_register?: string;
  s_vault_registered?: string;
  // Provider blurbs (Task 2) — optional; fall back to the English `desc:`.
  s_provider_desc_anthropic_cli?: string;
  s_provider_desc_gemini_cli?: string;
  s_provider_desc_codex_cli?: string;
  s_provider_desc_anthropic_api?: string;
  s_provider_desc_openai_api?: string;
  s_provider_desc_google_api?: string;
  s_provider_desc_builtin_local?: string;
  s_provider_desc_ollama?: string;
  s_provider_desc_openrouter?: string;
  s_provider_desc_memex_pro?: string;
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
    nav_views: "Views",
    ls_title: "Suggested links",
    ls_hint: "Semantically close notes that aren't linked yet. Accept to add a [[wikilink]] under \u201c## Related\u201d.",
    ls_accept: "Link them",
    ls_dismiss: "Dismiss",
    zi_title: "Import from Zotero",
    zi_hint: "CSL-JSON or BibTeX export (highlights come along when present). Items land in _inbox/ as source docs for the ingest pipeline.",
    zi_none: "No importable items found in that file.",
    zi_done: "Imported {n} item(s) into _inbox/ — run Ingest to turn them into wiki pages.",
    ci_title: "Import a conversation",
    ci_hint: "A ChatGPT export (conversations.json) or a Claude Code / Codex session (.jsonl). Each conversation lands in _inbox/ as a source doc for the ingest pipeline.",
    ci_btn: "Choose a file…",
    ci_busy: "Importing…",
    ci_done: "Imported {n} conversation(s) into _inbox/ — run Ingest to turn them into wiki pages.",
    ci_quarantined: "{n} conversation(s) were held back because they contain what looks like a secret (API key, token). Review them at the source; they were not imported.",
    ci_none: "No conversations found in that file.",
    ci_skipped: " ({n} already imported, skipped.)",
    ci_sweep_cc: "Import my Claude Code sessions",
    ci_sweep_cx: "Import my Codex sessions",
    ci_sweep_hint: "Or import every session already on this machine — from ~/.claude and ~/.codex. Re-running only adds new and grown sessions.",
    ci_sweep_progress: "Importing session {done} of {total}",
    ci_sweep_tally: "imported {i} · skipped {s} · {f} failed",
    ci_failed_summary: "{n} couldn’t be imported",
    ci_retry_failed: "Retry failed ({n})",
    q_empty: "Ask the wiki anything — answers cite your own pages.",
    s_mascot: "Show MYCO, the mascot",
    s_mascot_hint: "Loaders, empty states and the About page. Off = static logo.",
    hw_title: "Help",
    hw_sub: "Tips for this page",
    hw_sc_cmd: "Command palette",
    hw_sc_sidebar: "Toggle sidebar",
    hw_sc_fly: "Fly mode (graph)",
    hw_sc_esc: "Close / deselect",
    hw_tip_graph1: "Drag a star and the simulation re-heats around it.",
    hw_tip_graph2: "F flies the spaceship; the ⚠ badge opens gap analysis with research bridges.",
    hw_tip_graph3: "Near-field planets (settings drawer) turn close-up notes into worlds.",
    hw_tip_query1: "Answers cite wiki pages — click a citation to open it.",
    hw_tip_query2: "The graph's gap panel can draft research questions into this box.",
    hw_tip_ingest1: "Drop any file, paste text, or import a Zotero export.",
    hw_tip_ingest2: "The web clipper sends pages here through _inbox/ (see clipper/).",
    hw_tip_views1: "Filters compose — save the result as a named view chip.",
    hw_tip_overview1: "Suggested links are semantic pairs with no wikilink yet — accept or dismiss.",
    hw_tip_default: "⌘K jumps anywhere — pages, actions, semantic hits.",
    vw_title: "Query views",
    vw_lede: "Filter the wiki by its frontmatter — type, confidence, status, tags, sources — and save the lenses you keep coming back to.",
    vw_search: "Filter by name…",
    vw_any_type: "Any type",
    vw_any_conf: "Any confidence",
    vw_any_status: "Any status",
    vw_any_tag: "Any tag",
    vw_orphans: "Orphans only",
    vw_save: "Save view",
    vw_save_prompt: "Name this view:",
    vw_pages: "pages",
    vw_empty: "No pages match this view.",
    vw_col_name: "Page",
    vw_col_type: "Type",
    vw_col_conf: "Confidence",
    vw_col_sources: "Sources",
    vw_col_links: "Links",
    vw_col_tags: "Tags",
    nav_history: "History",
    nav_provenance: "Provenance",
    nav_tasks: "Tasks",
    tasks_title: "Tasks",
    tasks_lede: "Every checkbox item across your notes, gathered in one place.",
    tasks_loading: "Scanning notes…",
    tasks_empty: "No tasks yet",
    tasks_empty_hint: "Add a `- [ ] …` checkbox to any note and it will show up here.",
    tasks_open_n: "{n} open",
    tasks_done_n: "{n} done",
    tasks_all_done: "All caught up — nothing open.",
    tasks_completed: "Completed ({n})",
    nav_tags: "Tags",
    nav_study: "Study",
    nav_schedules: "Schedules",
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
    ing_drop_multi: "Loaded the first of {n} files — this form takes one source at a time. Drop the rest one by one.",
    ing_yt_fetch: "Fetch YouTube transcript",
    ing_yt_fetching: "Fetching transcript…",
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
    hist_collapse: "Collapse",
    hist_expand: "Expand",
    ing_run_again: "Ingest another",
    ing_live_title: "Writing your wiki…",
    ing_live_warmup: "Starting Claude…",
    ing_live_activity: "Live activity",
    ing_live_files: "Pages touched",
    ing_live_reads: "read",
    ing_live_writes: "written",
    ing_grounded: "Matched {n} existing page(s) to update",
    ing_grounded_hint:
      "The source was steered to these pages so it updates them instead of duplicating.",
    ing_plan: "Ingest plan ({n})",
    ing_plan_hint:
      "What the source will change — the agent follows this, updating existing pages instead of duplicating.",
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
    gr_skin: "Color mode",
    gr_skin_auto: "App theme",
    gr_skin_black: "Black",
    gr_skin_white: "White",
    gr_skin_galaxy: "Galaxy",
    gr_galaxies: "Folder galaxies",
    gr_galaxies_hint: "Split the vault into one slowly rotating galaxy per folder",
    gr_multiverse: "Multiverse",
    gr_multiverse_hint: "Show every project as its own universe-bubble; fly into one to open it",
    gr_mv_loading: "Charting universes…",
    gr_mv_none: "No vault to show yet.",
    gr_layout: "Layout",
    gr_layout_galaxy: "Galaxy (3D)",
    gr_layout_atlas: "Atlas (2D)",
    gr_layout_synapse: "Synapse (2D)",
    gr_layout_synapse3d: "Synapse (3D)",
    gr_recommend: "Recommended settings",
    gr_recommend_hint: "Apply the recommended settings for this layout",
    gr_sky: "Sky",
    gr_sky_stars: "Stars",
    gr_sky_dense: "Dense",
    gr_sky_grid: "Grid",
    gr_sky_void: "Void",
    gr_node_color: "Node colour",
    gr_node_color_community: "By folder",
    gr_node_color_white: "White",
    gr_node_color_auto: "Auto",
    gr_mono_below: "Colour above N nodes",
    gr_tl_speed: "Timelapse speed",
    gr_scale_star: "Star",
    gr_scale_system: "Star system",
    gr_scale_galaxy: "Galaxy",
    gr_scale_cluster: "Galaxy cluster",
    gr_arrows: "Arrows",
    gr_arrows_hint: "Show direction on each link",
    gr_arrow_size: "Arrow size",
    gr_semantic_edges: "Semantic links",
    gr_semantic_edges_hint: "Overlay dim edges between similar notes",
    gr_edge_bundles: "Bundled strands",
    gr_edge_bundles_hint: "Merge links between two topics into one weighted arc",
    gr_fly_btn: "Spaceship mode (F)",
    gr_timelapse_record: "Record timelapse (WebM)",
    gr_node_color_black: "Black",
    gr_cosmic: "Cosmic events",
    gr_cosmic_hint: "Black holes & wormholes (dark theme)",
    gr_cosmic_freq: "Event frequency",
    gr_click_burst: "Click burst",
    gr_click_burst_hint: "Supernova + ripple when you select a node",
    gr_neural_firing: "Neural firing",
    gr_neural_firing_hint: "Signals that periodically ripple the mesh",
    gr_planets: "Near-field planets",
    gr_planets_hint: "Close-up nodes become procedural planets (dark 3D)",
    gr_color_depth: "Colour depth",
    gr_edge_tint: "Link colour",
    gr_edge_tint_grey: "Grey",
    gr_edge_tint_community: "Community webs",
    gr_help_btn: "Gestures & keys",
    gr_help_title: "Gestures & keys",
    gr_help_click: "Focus a note (1 hop)",
    gr_help_dblclick: "Widen focus to 2 hops",
    gr_help_cmdclick: "Shortest path between notes",
    gr_help_esc: "Step out of the focus",
    gr_help_fly: "Toggle spaceship mode",
    gr_help_drag: "Orbit the cosmos",
    gr_trace: "Trace path",
    gr_trace_hint: "Click a start node, then an end node",
    gr_spaceship: "Spaceship",
    gr_spaceship_hint: "WASD fly · drag to steer · click a node for info · Esc exit",
    gr_spaceship_exit: "Exit",
    gr_speed: "Speed",
    gr_close: "Close",
    gr_open: "Open page",
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
    gr_gap_bridges: "Research bridges",
    gr_gap_ask: "Ask about this gap",
    gr_bridge_question:
      'My notes about "{a}" and "{b}" are semantically related but not yet linked. What connects these two topics? Suggest the bridging ideas or notes I should write.',
    gr_gap_more: "more",
    q_thinking: "searching the wiki…",
    q_answering: "answering…",
    q_answering_from: "answering from {n} pages…",
    gr_key_size: "size = links",
    gr_key_dim: "faint = low confidence",
    gr_key_amber: "amber = disputed",
    gr_key_neutral: "grey = unclassified",
    gr_more: "+{n} more",
    gr_focus_trail: "Focus trail",
    gr_focus_esc: "Step out (Esc / click the void)",
    gr_preset: "Layout",
    gr_preset_galaxy: "Galaxy",
    gr_preset_loose: "Loose web",
    gr_preset_dense: "Dense",
    gr_glow: "Glow",
    gr_motion: "Ambient motion",
    gr_motion_hint: "Auto-rotate, pulses, breathing",
    gr_advanced: "Advanced",
    gr_loading: "aligning constellations…",
    gr_ctx_lost: "Graphics context was lost.",
    gr_retry: "Rebuild",
    gr_perf_mode: "Performance mode — ambient layers off for large graphs",
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
    p_sources: "Sources ({n})",
    p_src_manual: "Written source",
    p_src_missing: "raw source missing",
    p_lint_running: "Lint is running — you can keep browsing; it continues in the background.",
    p_lint_done: "Lint done",
    p_lint_failed: "Lint failed",
    s_title: "Settings",
    s_account: "Account",
    s_local_user: "Local user",
    s_no_vault: "no vault",
    s_vault_path: "Vault path",
    s_change: "Change…",
    q_empty_response: "(empty response)",
    eb_title: "Something went wrong in {area}.",
    eb_reload: "Reload Memex",
    eb_retry: "Try again",
    eb_area_app: "the app",
    eb_area_graph: "the graph",
    s_workspace: "Workspace",
    s_model: "Model",
    s_embeddings: "Semantic search",
    s_embeddings_lede: "Build an on-device embedding index for semantic search, related notes, and graph similarity. Runs offline.",
    s_embeddings_indexed: "pages indexed",
    s_embeddings_reindex: "Reindex now",
    s_embeddings_indexing: "Indexing…",
    s_embeddings_empty: "Not indexed yet",
    s_embeddings_loading_model: "Loading model…",
    s_embeddings_loading_model_hint: "First run loads the bundled model — this takes a few seconds.",
    s_embeddings_done: "Indexed {n} pages",
    s_autoreindex_title: "Keep the index up to date",
    s_autoreindex_desc: "While Memex is open, re-embed pages you edit once you stop typing. Only pages that changed are re-embedded.",
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
    mcp_serving: "SSE server running",
    mcp_not_serving: "SSE server stopped",
    mcp_start_btn: "Start server",
    mcp_stop_btn: "Stop",
    mcp_registering: "Registering…",
    mcp_offline_note:
      "The app hosts the SSE server while it's open and follows your active vault.",
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
    ol_delete: "Remove model",
    ol_delete_confirm: "Remove?",
    ol_delete_yes: "Remove",
    ol_deleting: "Removing…",
    ol_delete_failed: "Couldn't remove the model.",
    ui_close: "Close",
    p_lint_run: "Run lint",
    p_linting: "Linting…",
    p_lint_report: "Lint report",
    p_dismiss: "dismiss",
    p_open_vault: "Open a vault to scan provenance.",
    p_scanning: "Scanning vault…",
    p_empty: "No claim-bearing notes yet — add some prose.",
    p_overall: "Overall",
    p_claims_cited: "claims cited",
    p_pages_by_coverage: "Pages, by claim coverage",
    rd_meta: "updated {date} · {words} words · {links} links",
    rd_source: "Source",
    rd_split: "Split",
    rd_preview: "Preview",
    rd_backlinks_empty: "No notes link here yet.",
    rd_related: "Related",
    rd_related_no_index: "Related notes come from an on-device index that hasn't been built yet.",
    rd_related_no_index_cta: "Set up semantic search",
    rd_make_cards: "Make cards",
    rd_making: "Generating…",
    rd_cards_none: "No cards generated.",
    rd_cards_made: "{n} cards added",
    rd_open_study: "Open study",
    st_title: "Study",
    st_lede:
      "Review your knowledge with spaced-repetition flashcards and quizzes generated from your pages.",
    st_no_decks: "No decks yet",
    st_generate_hint:
      "Open a page and choose “Make cards” to generate a deck from it.",
    st_browse_pages: "Browse pages",
    st_refresh: "Refresh",
    st_total: "{n} cards",
    st_due: "{n} due",
    st_no_due: "All caught up",
    st_all_decks: "All decks",
    st_review: "Review",
    st_quiz: "Quiz",
    st_loading: "Loading…",
    st_progress: "{done} / {total}",
    st_source: "Source",
    st_flip: "Show answer",
    st_grade_again: "Again",
    st_grade_hard: "Hard",
    st_grade_good: "Good",
    st_grade_easy: "Easy",
    st_all_done: "All done",
    st_done_sub: "Reviewed {n} cards.",
    st_quiz_needs_cards: "Add cards to this deck first to take a quiz.",
    st_quiz_intro: "Generate a multiple-choice quiz from this deck's cards.",
    st_quiz_empty: "The model didn't return any questions. Try again.",
    st_gen_quiz: "Generate quiz",
    st_generating: "Generating…",
    st_quiz_done: "Quiz complete",
    st_quiz_score: "Score: {score} / {total}",
    st_correct: "Correct",
    st_wrong: "Not quite",
    st_next: "Next",
    q_mode: "Mode",
    q_mode_ask: "Ask",
    q_mode_agent: "Agent",
    ag_lede:
      "Give the agent a multi-step task. It plans, searches your wiki, reads and links pages, and answers with citations.",
    ag_preset: "Task agent",
    ag_preset_none: "Default",
    ag_new_preset: "New agent",
    ag_preset_name: "Name",
    ag_preset_prompt: "System prompt",
    ag_preset_prompt_hint: "What should this agent do?",
    ag_allow_write: "Allow writes",
    ag_write_hint: "Let the agent create/update pages (confirmed per write)",
    ag_ph: "Give the agent a multi-step task…",
    ag_run: "Run",
    ag_stop: "Stop",
    ag_task: "task",
    ag_steps: "{n} steps",
    ag_working: "working",
    ag_declined: "declined",
    ag_stopped_limit: "Stopped at the step limit — partial answer.",
    ag_unsupported:
      "Agent mode needs the Anthropic API or an OpenAI-compatible provider. Current: {provider}.",
    rd_audio: "Audio overview",
    au_title: "Audio overview",
    au_close: "Close",
    au_generating: "Writing the dialogue…",
    au_play: "Play",
    au_pause: "Pause",
    au_stop: "Stop",
    au_turns: "{n} turns",
    au_open_transcript: "Open transcript",
    au_no_tts: "Speech synthesis unavailable — transcript only.",
    au_host: "Host",
    au_guest: "Guest",
    au_play_from: "Play from here",
    pdf_page: "p. {n} / {total}",
    pdf_close: "Close",
    pdf_loading: "Loading PDF…",
    pdf_error: "Could not open this PDF.",
    pdf_highlight_cite: "Highlight & cite",
    sc_title: "Schedules",
    sc_lede: "Recurring digests written into your vault while the app is open.",
    sc_new: "New schedule",
    sc_empty: "No schedules yet.",
    sc_run_now: "Run now",
    sc_running: "Running…",
    sc_edit: "Edit",
    sc_last_run: "last run {t}",
    sc_never: "never run",
    sc_done: "Digest written.",
    sc_open: "Open digest",
    sc_f_title: "Title (e.g. Weekly review)",
    sc_f_kind: "Kind",
    sc_f_cadence: "Cadence",
    sc_f_prompt: "Prompt to run over the wiki",
    sc_f_topic: "Topic to track",
    sc_f_enabled: "Enabled",
    sc_f_notify: "Notify",
    sc_f_notify_hint: "Native notification when a run finishes (opt-in)",
    sc_f_save: "Save",
    sc_f_cancel: "Cancel",
    sc_bg_install: "Run in background",
    sc_bg_remove: "Remove background",
    sc_bg_hint: "Run this schedule even when the app is closed (macOS launchd)",
    ing_title_label: "Title",
    ing_title_ph: "e.g. Byte Pair Encoding",
    ing_working: "working…",
    q_via: "via {provider} · {model}",
    q_builtin_note:
      "The built-in offline model (Gemma 3 1B) is compact and can be inaccurate. For better offline answers, run a larger model via Ollama (e.g. gemma3:4b); for the most reliable answers, use Claude.",
    q_open_model_settings: "Model settings",
    q_you: "you",
    sb_new_note: "New note",
    sb_new_folder: "New folder",
    sb_rename: "Rename…",
    sb_today_note: "Today's note",
    sb_new_note_root: "New note in vault root",
    sb_delete_folder_q: "Delete folder?",
    sb_delete_file_q: "Delete file?",
    cb_no_results: "No results",
    cb_tag_page: "page",
    cb_tag_file: "file",
    cb_in_contents: "In page contents",
    cb_semantic: "Related (semantic)",
    tb_lint: "Lint",
    tb_toggle_sidebar: "Toggle sidebar (⌘B)",
    tb_model_picker: "Switch query model",
    gr_zoom_out: "Zoom out",
    gr_fit: "Fit",
    gr_zoom_in: "Zoom in",
    ov_no_git: "No git history yet.",
    h_open_vault: "Open a vault to see history.",
    tg_title: "Tags",
    tg_lede:
      "Every tag across your vault's frontmatter. Pick a tag to see the pages carrying it, then jump straight to a page.",
    tg_empty:
      "No tags yet — add a `tags:` list to a page's frontmatter and they'll gather here.",
    rf_title: "Reflect suggestions",
    rf_lede:
      "Claude's read-only pass over the vault: orphans to link, stale pages, and missing cross-references.",
    rf_run: "Reflect",
    rf_running: "Reflecting…",
    rf_empty: "No suggestions — the vault looks well-connected.",
    ob_title: "Welcome to Memex",
    ob_skip: "Skip",
    ob_back: "Back",
    ob_next: "Next",
    ob_finish: "Done",
    ob_vault_linked: "Linked",
    ob_vault_none: "No vault linked yet",
    ob_s1_title: "Create or open a project",
    ob_s1_body:
      "Memex keeps every page as plain markdown in a folder you control. Open an existing folder, or keep the default vault Memex just created for you.",
    ob_s1_action: "Open a folder…",
    ob_s2_title: "Add your first source",
    ob_s2_body:
      "Drop a file, paste a URL, or write a note. Memex reads it, extracts entities and concepts, and weaves a cited page into your graph.",
    ob_s2_action: "Go to Ingest",
    ob_s3_title: "Ask a question",
    ob_s3_body:
      "Ask the wiki anything. Memex answers from your pages first and reaches into raw sources only when needed — every claim ships with a citation.",
    ob_s3_action: "Go to Ask",
    s_budget_title: "Monthly spend guard",
    s_budget_desc:
      "Estimated spend across paid API providers this month. A rough tripwire, not billing — set a threshold to get warned before you cross it.",
    s_budget_threshold: "Monthly limit (USD)",
    s_budget_usage: "This month",
    s_budget_total: "Total",
    s_budget_empty: "No paid-API usage tracked yet this month.",
    s_autoreflect_title: "Auto-reflect",
    s_autoreflect_desc:
      "While Memex is open, periodically run a read-only reflect pass to surface orphans, stale pages, and missing links.",
    s_autoreflect_interval: "Every",
    s_vault_register: "Make this an independent Obsidian vault",
    s_vault_registered: "Obsidian vault ready",
    s_provider_desc_anthropic_cli:
      "Use your Claude Pro / Max subscription via the local `claude` CLI. No API key needed.",
    s_provider_desc_gemini_cli:
      "Use your Google subscription via the local `gemini` CLI. No API key needed.",
    s_provider_desc_codex_cli:
      "Use your OpenAI subscription via the local `codex` CLI. No API key needed.",
    s_provider_desc_anthropic_api:
      "Direct calls to api.anthropic.com. Key from console.anthropic.com.",
    s_provider_desc_openai_api: "GPT-5 family via api.openai.com.",
    s_provider_desc_google_api:
      "Gemini family via generativelanguage.googleapis.com.",
    s_provider_desc_builtin_local:
      "Gemma 3 1B bundled inside the app. Works offline with zero setup; good for classification and light queries, use a cloud provider for high-quality ingest. Model © Google, provided under the Gemma Terms of Use (text ships with the app).",
    s_provider_desc_ollama:
      "Run open-source models locally. Auto-detects http://localhost:11434.",
    s_provider_desc_openrouter:
      "One key for many providers (useful for model comparison).",
    s_provider_desc_memex_pro:
      "Unlimited ingest on a managed model — no API key or CLI needed. Sign in with your Memex Pro account.",
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
    nav_views: "뷰",
    ls_title: "제안된 연결",
    ls_hint: "의미상 가깝지만 아직 연결되지 않은 노트들입니다. 수락하면 \u201c## Related\u201d 아래에 [[위키링크]]가 추가됩니다.",
    ls_accept: "연결하기",
    ls_dismiss: "무시",
    zi_title: "Zotero에서 가져오기",
    zi_hint: "CSL-JSON 또는 BibTeX 내보내기 파일(하이라이트 포함 시 함께). 항목은 _inbox/에 소스 문서로 저장됩니다.",
    zi_none: "가져올 항목을 찾지 못했습니다.",
    zi_done: "{n}개 항목을 _inbox/로 가져왔습니다 — Ingest를 실행해 위키 페이지로 만드세요.",
    ci_title: "대화 가져오기",
    ci_hint: "ChatGPT 내보내기(conversations.json) 또는 Claude Code / Codex 세션(.jsonl). 각 대화가 소스 문서로 _inbox/에 들어가 ingest 파이프라인이 처리합니다.",
    ci_btn: "파일 선택…",
    ci_busy: "가져오는 중…",
    ci_done: "{n}개 대화를 _inbox/로 가져왔습니다 — Ingest를 실행해 위키 페이지로 만드세요.",
    ci_quarantined: "{n}개 대화가 시크릿(API 키·토큰)으로 보이는 내용을 포함해 제외됐습니다. 원본에서 확인하세요. 가져오지 않았습니다.",
    ci_none: "그 파일에서 대화를 찾지 못했습니다.",
    ci_skipped: " ({n}개는 이미 가져와 건너뜀.)",
    ci_sweep_cc: "내 Claude Code 세션 가져오기",
    ci_sweep_cx: "내 Codex 세션 가져오기",
    ci_sweep_hint: "또는 이 컴퓨터에 이미 있는 모든 세션을 가져옵니다 — ~/.claude·~/.codex에서. 다시 실행해도 새로 생기거나 늘어난 세션만 추가됩니다.",
    ci_sweep_progress: "세션 가져오는 중 {done} / {total}",
    ci_sweep_tally: "가져옴 {i} · 건너뜀 {s} · 실패 {f}",
    ci_failed_summary: "{n}개를 가져오지 못했습니다",
    ci_retry_failed: "실패 재시도 ({n})",
    q_empty: "위키에 무엇이든 물어보세요 — 답변은 당신의 페이지를 인용합니다.",
    s_mascot: "마스코트 MYCO 표시",
    s_mascot_hint: "로더·빈 화면·정보 페이지에 등장합니다. 끄면 정적 로고로 대체됩니다.",
    hw_title: "도움말",
    hw_sub: "이 페이지의 팁",
    hw_sc_cmd: "커맨드 팔레트",
    hw_sc_sidebar: "사이드바 토글",
    hw_sc_fly: "비행 모드 (그래프)",
    hw_sc_esc: "닫기 / 선택 해제",
    hw_tip_graph1: "별을 드래그하면 시뮬레이션이 주변에서 다시 살아납니다.",
    hw_tip_graph2: "F는 우주선 비행, ⚠ 배지는 연구 다리가 포함된 갭 분석을 엽니다.",
    hw_tip_graph3: "근접 행성(설정 서랍)을 켜면 가까운 노트가 행성이 됩니다.",
    hw_tip_query1: "답변은 위키 페이지를 인용합니다 — 인용을 클릭해 열어보세요.",
    hw_tip_query2: "그래프의 갭 패널이 연구 질문을 이 입력창에 담아줄 수 있습니다.",
    hw_tip_ingest1: "파일 드롭, 텍스트 붙여넣기, Zotero 가져오기 모두 가능합니다.",
    hw_tip_ingest2: "웹 클리퍼는 _inbox/를 통해 페이지를 이곳으로 보냅니다 (clipper/ 참고).",
    hw_tip_views1: "필터는 조합됩니다 — 결과를 이름 있는 뷰로 저장하세요.",
    hw_tip_overview1: "제안된 연결은 아직 링크되지 않은 의미상 유사 쌍입니다 — 수락하거나 무시하세요.",
    hw_tip_default: "⌘K로 어디든 이동 — 페이지·액션·시맨틱 검색.",
    vw_title: "쿼리 뷰",
    vw_lede: "프론트매터(종류·신뢰도·상태·태그·출처 수)로 위키를 필터링하고, 자주 쓰는 렌즈를 저장하세요.",
    vw_search: "이름으로 필터…",
    vw_any_type: "모든 종류",
    vw_any_conf: "모든 신뢰도",
    vw_any_status: "모든 상태",
    vw_any_tag: "모든 태그",
    vw_orphans: "고립 노드만",
    vw_save: "뷰 저장",
    vw_save_prompt: "뷰 이름:",
    vw_pages: "페이지",
    vw_empty: "조건에 맞는 페이지가 없습니다.",
    vw_col_name: "페이지",
    vw_col_type: "종류",
    vw_col_conf: "신뢰도",
    vw_col_sources: "출처",
    vw_col_links: "링크",
    vw_col_tags: "태그",
    nav_history: "히스토리",
    nav_provenance: "출처",
    nav_tasks: "할 일",
    tasks_title: "할 일",
    tasks_lede: "노트 전체의 체크박스 항목을 한곳에 모았습니다.",
    tasks_loading: "노트 스캔 중…",
    tasks_empty: "아직 할 일이 없습니다",
    tasks_empty_hint: "아무 노트에나 `- [ ] …` 체크박스를 추가하면 여기에 표시됩니다.",
    tasks_open_n: "미완 {n}개",
    tasks_done_n: "완료 {n}개",
    tasks_all_done: "모두 완료 — 남은 항목이 없습니다.",
    tasks_completed: "완료 ({n})",
    nav_tags: "태그",
    nav_study: "학습",
    nav_schedules: "스케줄",
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
    ing_drop_multi: "{n}개 중 첫 파일만 불러왔습니다 — 이 폼은 한 번에 하나의 소스만 처리합니다. 나머지는 하나씩 드롭하세요.",
    ing_yt_fetch: "YouTube 자막 가져오기",
    ing_yt_fetching: "자막 가져오는 중…",
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
    hist_collapse: "접기",
    hist_expand: "펼치기",
    ing_run_again: "새로 가져오기",
    ing_live_title: "LLM 위키 작성 중…",
    ing_live_warmup: "Claude 시작 중…",
    ing_live_activity: "실시간 활동",
    ing_live_files: "작업한 페이지",
    ing_live_reads: "읽음",
    ing_live_writes: "작성",
    ing_grounded: "갱신할 기존 페이지 {n}개 매칭",
    ing_grounded_hint:
      "이 페이지들로 유도해 중복 생성 대신 기존 페이지를 갱신하도록 했습니다.",
    ing_plan: "인제스트 계획 {n}개",
    ing_plan_hint:
      "이 소스가 무엇을 바꿀지 — 에이전트가 이 계획을 따라 중복 대신 기존 페이지를 갱신합니다.",
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
    gr_skin: "색상 모드",
    gr_skin_auto: "앱 테마",
    gr_skin_black: "블랙",
    gr_skin_white: "화이트",
    gr_skin_galaxy: "은하계",
    gr_galaxies: "폴더 은하계",
    gr_galaxies_hint: "폴더마다 하나씩, 천천히 자전하는 은하계로 분리",
    gr_multiverse: "멀티버스",
    gr_multiverse_hint: "모든 프로젝트를 각자의 우주 버블로 표시. 하나로 날아 들어가면 그 프로젝트가 열림",
    gr_mv_loading: "우주를 그리는 중…",
    gr_mv_none: "아직 표시할 볼트가 없습니다.",
    gr_layout: "레이아웃",
    gr_layout_galaxy: "은하계 (3D)",
    gr_layout_atlas: "아틀라스 (2D)",
    gr_layout_synapse: "시냅스 (2D)",
    gr_layout_synapse3d: "시냅스 (3D)",
    gr_recommend: "추천 설정 적용",
    gr_recommend_hint: "이 레이아웃의 추천 설정을 적용합니다",
    gr_sky: "배경",
    gr_sky_stars: "별",
    gr_sky_dense: "조밀",
    gr_sky_grid: "그리드",
    gr_sky_void: "비움",
    gr_node_color: "노드 색상",
    gr_node_color_community: "폴더별",
    gr_node_color_white: "화이트",
    gr_node_color_auto: "자동",
    gr_mono_below: "N개 이상일 때 색상",
    gr_tl_speed: "타임랩스 속도",
    gr_scale_star: "항성",
    gr_scale_system: "항성계",
    gr_scale_galaxy: "은하",
    gr_scale_cluster: "은하단",
    gr_arrows: "화살표",
    gr_arrows_hint: "각 링크에 방향 표시",
    gr_arrow_size: "화살표 크기",
    gr_semantic_edges: "의미 연결",
    gr_semantic_edges_hint: "유사한 노트 사이에 흐린 엣지 표시",
    gr_edge_bundles: "번들 스트랜드",
    gr_edge_bundles_hint: "두 토픽 사이 링크를 하나의 가중 아크로 묶기",
    gr_fly_btn: "우주선 모드 (F)",
    gr_timelapse_record: "타임랩스 녹화 (WebM)",
    gr_node_color_black: "블랙",
    gr_cosmic: "우주 이벤트",
    gr_cosmic_hint: "블랙홀·웜홀 (다크 테마)",
    gr_cosmic_freq: "이벤트 빈도",
    gr_click_burst: "클릭 버스트",
    gr_click_burst_hint: "노드 선택 시 슈퍼노바 + 파동",
    gr_neural_firing: "신경 발화",
    gr_neural_firing_hint: "주기적으로 메시를 타고 흐르는 신호",
    gr_planets: "근접 행성",
    gr_planets_hint: "가까운 노드가 절차적 행성이 됨 (다크 3D)",
    gr_color_depth: "색 짙기",
    gr_edge_tint: "링크 색상",
    gr_edge_tint_grey: "회색",
    gr_edge_tint_community: "커뮤니티 웹",
    gr_help_btn: "제스처 안내",
    gr_help_title: "제스처 안내",
    gr_help_click: "노트에 포커스 (1홉)",
    gr_help_dblclick: "포커스를 2홉으로 확장",
    gr_help_cmdclick: "노트 사이 최단 경로",
    gr_help_esc: "포커스에서 한 단계 나가기",
    gr_help_fly: "우주선 모드 전환",
    gr_help_drag: "우주 궤도 회전",
    gr_trace: "경로 추적",
    gr_trace_hint: "시작 노드를 누른 뒤 끝 노드를 누르세요",
    gr_spaceship: "우주선 비행",
    gr_spaceship_hint: "WASD 이동 · 드래그로 방향 · 노드 클릭해 정보 · Esc 종료",
    gr_spaceship_exit: "나가기",
    gr_speed: "속도",
    gr_close: "닫기",
    gr_open: "페이지 열기",
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
    gr_gap_bridges: "연구 다리",
    gr_gap_ask: "이 갭에 질문하기",
    gr_bridge_question:
      '"{a}"와(과) "{b}"에 대한 내 노트들은 의미상 가깝지만 아직 연결되어 있지 않습니다. 두 주제를 잇는 것은 무엇인가요? 다리가 될 아이디어나 작성할 노트를 제안해 주세요.',
    gr_gap_more: "더",
    q_thinking: "위키를 탐색하는 중…",
    q_answering: "답변 작성 중…",
    q_answering_from: "{n}개 페이지를 근거로 답변 작성 중…",
    gr_key_size: "크기 = 링크 수",
    gr_key_dim: "흐림 = 낮은 신뢰도",
    gr_key_amber: "호박색 = 논쟁 중",
    gr_key_neutral: "회청 = 미분류",
    gr_more: "+{n}개 더",
    gr_focus_trail: "포커스 경로",
    gr_focus_esc: "한 단계 나가기 (Esc / 빈 공간 클릭)",
    gr_preset: "레이아웃",
    gr_preset_galaxy: "은하",
    gr_preset_loose: "느슨한 웹",
    gr_preset_dense: "조밀",
    gr_glow: "글로우",
    gr_motion: "잔잔한 움직임",
    gr_motion_hint: "자동 회전·펄스·깜빡임",
    gr_advanced: "고급",
    gr_loading: "별자리를 정렬하는 중…",
    gr_ctx_lost: "그래픽 컨텍스트가 끊어졌습니다.",
    gr_retry: "다시 그리기",
    gr_perf_mode: "성능 모드 — 큰 그래프에서는 배경 효과를 끕니다",
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
    p_sources: "출처 {n}개",
    p_src_manual: "직접 작성한 출처",
    p_src_missing: "raw 원본 없음",
    p_lint_running: "Lint 실행 중 — 다른 페이지로 이동해도 백그라운드에서 계속됩니다.",
    p_lint_done: "Lint 완료",
    p_lint_failed: "Lint 실패",
    s_title: "설정",
    s_account: "계정",
    s_local_user: "로컬 사용자",
    s_no_vault: "볼트 없음",
    s_vault_path: "볼트 경로",
    s_change: "변경…",
    q_empty_response: "(응답 없음)",
    eb_title: "{area}에서 문제가 발생했습니다.",
    eb_reload: "Memex 다시 불러오기",
    eb_retry: "다시 시도",
    eb_area_app: "앱",
    eb_area_graph: "그래프",
    s_workspace: "워크스페이스",
    s_model: "모델",
    s_embeddings: "의미 검색",
    s_embeddings_lede: "의미 검색·관련 노트·그래프 유사도를 위한 온디바이스 임베딩 인덱스를 만듭니다. 오프라인 동작.",
    s_embeddings_indexed: "페이지 인덱싱됨",
    s_embeddings_reindex: "지금 재인덱스",
    s_embeddings_indexing: "인덱싱 중…",
    s_embeddings_empty: "아직 인덱스 없음",
    s_embeddings_loading_model: "모델 로딩 중…",
    s_embeddings_loading_model_hint: "첫 실행에는 내장 모델을 불러옵니다 — 몇 초 걸립니다.",
    s_embeddings_done: "{n}개 페이지 인덱싱 완료",
    s_autoreindex_title: "인덱스 자동 최신화",
    s_autoreindex_desc: "Memex가 열려 있는 동안, 편집을 멈추면 수정한 페이지를 다시 임베딩합니다. 바뀐 페이지만 처리합니다.",
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
    mcp_serving: "SSE 서버 실행 중",
    mcp_not_serving: "SSE 서버 중지됨",
    mcp_start_btn: "서버 시작",
    mcp_stop_btn: "중지",
    mcp_registering: "등록 중…",
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
    ol_delete: "모델 삭제",
    ol_delete_confirm: "삭제할까요?",
    ol_delete_yes: "삭제",
    ol_deleting: "삭제 중…",
    ol_delete_failed: "모델을 삭제하지 못했습니다.",
    ui_close: "닫기",
    p_lint_run: "린트 실행",
    p_linting: "린트 중…",
    p_lint_report: "린트 보고서",
    p_dismiss: "닫기",
    p_open_vault: "출처를 스캔하려면 vault를 여세요.",
    p_scanning: "vault 스캔 중…",
    p_empty: "아직 주장이 담긴 노트가 없습니다 — 본문을 추가해 보세요.",
    p_overall: "전체",
    p_claims_cited: "주장 인용됨",
    p_pages_by_coverage: "페이지별 인용 커버리지",
    rd_meta: "{date} 업데이트 · 단어 {words} · 링크 {links}",
    rd_source: "소스",
    rd_split: "분할",
    rd_preview: "미리보기",
    rd_backlinks_empty: "아직 여기로 연결된 노트가 없습니다.",
    rd_related: "관련 노트",
    rd_related_no_index: "관련 노트는 아직 만들지 않은 온디바이스 인덱스에서 나옵니다.",
    rd_related_no_index_cta: "의미 검색 설정하기",
    rd_make_cards: "카드 만들기",
    rd_making: "생성 중…",
    rd_cards_none: "생성된 카드가 없습니다.",
    rd_cards_made: "카드 {n}개 추가됨",
    rd_open_study: "학습 열기",
    st_title: "학습",
    st_lede:
      "페이지에서 생성한 간격 반복 플래시카드와 퀴즈로 지식을 복습하세요.",
    st_no_decks: "덱이 없습니다",
    st_generate_hint: "페이지를 열고 “카드 만들기”를 선택해 덱을 생성하세요.",
    st_browse_pages: "페이지 보기",
    st_refresh: "새로고침",
    st_total: "카드 {n}개",
    st_due: "복습 {n}개",
    st_no_due: "모두 완료",
    st_all_decks: "모든 덱",
    st_review: "복습",
    st_quiz: "퀴즈",
    st_loading: "불러오는 중…",
    st_progress: "{done} / {total}",
    st_source: "출처",
    st_flip: "정답 보기",
    st_grade_again: "다시",
    st_grade_hard: "어려움",
    st_grade_good: "보통",
    st_grade_easy: "쉬움",
    st_all_done: "모두 완료",
    st_done_sub: "카드 {n}개를 복습했습니다.",
    st_quiz_needs_cards: "퀴즈를 보려면 먼저 이 덱에 카드를 추가하세요.",
    st_quiz_intro: "이 덱의 카드로 객관식 퀴즈를 생성합니다.",
    st_quiz_empty: "모델이 문제를 반환하지 않았습니다. 다시 시도하세요.",
    st_gen_quiz: "퀴즈 생성",
    st_generating: "생성 중…",
    st_quiz_done: "퀴즈 완료",
    st_quiz_score: "점수: {score} / {total}",
    st_correct: "정답",
    st_wrong: "오답",
    st_next: "다음",
    q_mode: "모드",
    q_mode_ask: "질문",
    q_mode_agent: "에이전트",
    ag_lede:
      "에이전트에게 여러 단계의 작업을 맡기세요. 계획을 세우고 위키를 검색·열람·연결한 뒤 출처와 함께 답합니다.",
    ag_preset: "작업 에이전트",
    ag_preset_none: "기본",
    ag_new_preset: "새 에이전트",
    ag_preset_name: "이름",
    ag_preset_prompt: "시스템 프롬프트",
    ag_preset_prompt_hint: "이 에이전트가 할 일은?",
    ag_allow_write: "쓰기 허용",
    ag_write_hint: "에이전트가 페이지를 생성/수정하도록 허용(쓰기마다 확인)",
    ag_ph: "에이전트에게 여러 단계 작업을 지시하세요…",
    ag_run: "실행",
    ag_stop: "중지",
    ag_task: "작업",
    ag_steps: "{n}단계",
    ag_working: "작업 중",
    ag_declined: "거부됨",
    ag_stopped_limit: "단계 한도에서 중지됨 — 부분 답변입니다.",
    ag_unsupported:
      "에이전트 모드에는 Anthropic API 또는 OpenAI 호환 제공자가 필요합니다. 현재: {provider}.",
    rd_audio: "오디오 개요",
    au_title: "오디오 개요",
    au_close: "닫기",
    au_generating: "대화 작성 중…",
    au_play: "재생",
    au_pause: "일시정지",
    au_stop: "정지",
    au_turns: "{n}개 대화",
    au_open_transcript: "대본 열기",
    au_no_tts: "음성 합성을 사용할 수 없음 — 대본만 표시합니다.",
    au_host: "진행자",
    au_guest: "게스트",
    au_play_from: "여기부터 재생",
    pdf_page: "p. {n} / {total}",
    pdf_close: "닫기",
    pdf_loading: "PDF 불러오는 중…",
    pdf_error: "이 PDF를 열 수 없습니다.",
    pdf_highlight_cite: "하이라이트 & 인용",
    sc_title: "스케줄",
    sc_lede: "앱이 열려 있는 동안 볼트에 정기 다이제스트를 작성합니다.",
    sc_new: "새 스케줄",
    sc_empty: "아직 스케줄이 없습니다.",
    sc_run_now: "지금 실행",
    sc_running: "실행 중…",
    sc_edit: "편집",
    sc_last_run: "마지막 실행 {t}",
    sc_never: "실행된 적 없음",
    sc_done: "다이제스트 작성됨.",
    sc_open: "다이제스트 열기",
    sc_f_title: "제목 (예: 주간 리뷰)",
    sc_f_kind: "종류",
    sc_f_cadence: "주기",
    sc_f_prompt: "위키에 실행할 프롬프트",
    sc_f_topic: "추적할 주제",
    sc_f_enabled: "사용",
    sc_f_notify: "알림",
    sc_f_notify_hint: "실행 완료 시 네이티브 알림(옵트인)",
    sc_f_save: "저장",
    sc_f_cancel: "취소",
    sc_bg_install: "백그라운드 실행",
    sc_bg_remove: "백그라운드 해제",
    sc_bg_hint: "앱이 닫혀 있어도 이 스케줄을 실행 (macOS launchd)",
    ing_title_label: "제목",
    ing_title_ph: "예: Byte Pair Encoding",
    ing_working: "작업 중…",
    q_via: "{provider} · {model} 사용",
    q_builtin_note:
      "내장 오프라인 모델(Gemma 3 1B)은 작아서 부정확할 수 있습니다. 오프라인이라면 Ollama로 더 큰 모델(예: gemma3:4b)을 돌려보고, 가장 정확한 답변은 Claude를 쓰세요.",
    q_open_model_settings: "모델 설정",
    q_you: "나",
    sb_new_note: "새 노트",
    sb_new_folder: "새 폴더",
    sb_rename: "이름 바꾸기…",
    sb_today_note: "오늘의 노트",
    sb_new_note_root: "vault 루트에 새 노트",
    sb_delete_folder_q: "폴더를 삭제할까요?",
    sb_delete_file_q: "파일을 삭제할까요?",
    cb_no_results: "결과 없음",
    cb_tag_page: "페이지",
    cb_tag_file: "파일",
    cb_in_contents: "페이지 본문에서",
    cb_semantic: "관련 (의미)",
    tb_lint: "린트",
    tb_toggle_sidebar: "사이드바 토글 (⌘B)",
    tb_model_picker: "질문 모델 변경",
    gr_zoom_out: "축소",
    gr_fit: "맞춤",
    gr_zoom_in: "확대",
    ov_no_git: "아직 git 히스토리가 없습니다.",
    h_open_vault: "히스토리를 보려면 vault를 여세요.",
    tg_title: "태그",
    tg_lede:
      "vault의 프론트매터에 있는 모든 태그입니다. 태그를 고르면 그 태그가 달린 페이지가 보이고, 페이지로 바로 이동할 수 있습니다.",
    tg_empty:
      "아직 태그가 없습니다 — 페이지 프론트매터에 `tags:` 목록을 추가하면 여기에 모입니다.",
    rf_title: "Reflect 제안",
    rf_lede:
      "Claude가 vault를 읽기 전용으로 훑어 제안합니다: 연결할 고립 노드, 오래된 페이지, 빠진 교차 참조.",
    rf_run: "Reflect 실행",
    rf_running: "분석 중…",
    rf_empty: "제안이 없습니다 — vault가 잘 연결되어 있습니다.",
    ob_title: "Memex에 오신 것을 환영합니다",
    ob_skip: "건너뛰기",
    ob_back: "이전",
    ob_next: "다음",
    ob_finish: "완료",
    ob_vault_linked: "연결됨",
    ob_vault_none: "아직 연결된 vault가 없습니다",
    ob_s1_title: "프로젝트 만들기 또는 열기",
    ob_s1_body:
      "Memex는 모든 페이지를 당신이 관리하는 폴더에 마크다운으로 보관합니다. 기존 폴더를 열거나, 방금 만들어진 기본 vault를 그대로 사용하세요.",
    ob_s1_action: "폴더 열기…",
    ob_s2_title: "첫 소스 추가하기",
    ob_s2_body:
      "파일을 드롭하거나 URL을 붙여넣거나 메모를 쓰세요. Memex가 읽고, 엔티티와 개념을 추출해 인용이 달린 페이지를 그래프에 엮습니다.",
    ob_s2_action: "가져오기로 이동",
    ob_s3_title: "질문하기",
    ob_s3_body:
      "위키에 무엇이든 물어보세요. Memex는 먼저 당신의 페이지에서 답하고 필요할 때만 원본으로 들어갑니다 — 모든 주장에는 인용이 따라옵니다.",
    ob_s3_action: "질문으로 이동",
    s_budget_title: "월 지출 가드",
    s_budget_desc:
      "이번 달 유료 API 제공자에서의 예상 지출입니다. 정확한 청구가 아닌 대략적 경보로, 임계값을 설정하면 초과 전에 경고합니다.",
    s_budget_threshold: "월 한도 (USD)",
    s_budget_usage: "이번 달",
    s_budget_total: "합계",
    s_budget_empty: "이번 달 추적된 유료 API 사용량이 없습니다.",
    s_autoreflect_title: "자동 Reflect",
    s_autoreflect_desc:
      "Memex가 켜져 있는 동안 읽기 전용 Reflect를 주기적으로 실행해 고립 노드·오래된 페이지·빠진 링크를 찾아냅니다.",
    s_autoreflect_interval: "주기",
    s_vault_register: "독립 Obsidian 볼트로 만들기",
    s_vault_registered: "Obsidian 볼트 준비됨",
    s_provider_desc_anthropic_cli:
      "로컬 `claude` CLI로 Claude Pro / Max 구독을 사용합니다. API 키가 필요 없습니다.",
    s_provider_desc_gemini_cli:
      "로컬 `gemini` CLI로 Google 구독을 사용합니다. API 키가 필요 없습니다.",
    s_provider_desc_codex_cli:
      "로컬 `codex` CLI로 OpenAI 구독을 사용합니다. API 키가 필요 없습니다.",
    s_provider_desc_anthropic_api:
      "api.anthropic.com에 직접 호출합니다. 키는 console.anthropic.com에서 발급합니다.",
    s_provider_desc_openai_api: "api.openai.com을 통한 GPT-5 계열.",
    s_provider_desc_google_api:
      "generativelanguage.googleapis.com을 통한 Gemini 계열.",
    s_provider_desc_builtin_local:
      "앱에 내장된 Gemma 3 1B. 설치 없이 오프라인으로 동작하며, 분류·가벼운 질문에 적합합니다. 고품질 ingest에는 클라우드 제공자를 사용하세요. 모델 © Google, Gemma Terms of Use 적용(전문 동봉).",
    s_provider_desc_ollama:
      "오픈소스 모델을 로컬에서 실행합니다. http://localhost:11434를 자동 감지합니다.",
    s_provider_desc_openrouter:
      "하나의 키로 여러 제공자 사용 (모델 비교에 유용).",
    s_provider_desc_memex_pro:
      "관리형 모델로 무제한 ingest — API 키나 CLI가 필요 없습니다. Memex Pro 계정으로 로그인하세요.",
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
    nav_views: "ビュー",
    nav_history: "履歴",
    nav_provenance: "出典",
    nav_tasks: "タスク",
    tasks_title: "タスク",
    tasks_lede: "ノート全体のチェックボックス項目を一か所にまとめました。",
    tasks_loading: "ノートをスキャン中…",
    tasks_empty: "まだタスクがありません",
    tasks_empty_hint: "任意のノートに `- [ ] …` チェックボックスを追加すると、ここに表示されます。",
    tasks_open_n: "未完了 {n}件",
    tasks_done_n: "完了 {n}件",
    tasks_all_done: "すべて完了 — 残りはありません。",
    tasks_completed: "完了 ({n})",
    nav_tags: "タグ",
    nav_study: "学習",
    nav_schedules: "スケジュール",
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
    ing_drop_multi: "{n} 件のうち最初のファイルのみ読み込みました — このフォームは一度に 1 つのソースだけ処理します。残りは 1 つずつドロップしてください。",
    ing_yt_fetch: "YouTube字幕を取得",
    ing_yt_fetching: "字幕を取得中…",
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
    hist_collapse: "折りたたむ",
    hist_expand: "展開",
    ing_run_again: "別のソースを取り込む",
    ing_live_title: "LLM がウィキを作成中…",
    ing_live_warmup: "Claude を起動中…",
    ing_live_activity: "ライブアクティビティ",
    ing_live_files: "作業したページ",
    ing_live_reads: "読込",
    ing_live_writes: "作成",
    ing_grounded: "更新すべき既存ページを{n}件マッチ",
    ing_grounded_hint:
      "重複作成ではなく既存ページを更新するよう、これらのページへ誘導しました。",
    ing_plan: "取り込み計画 {n}件",
    ing_plan_hint:
      "このソースが何を変えるか — エージェントはこの計画に従い、重複ではなく既存ページを更新します。",
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
    q_thinking: "ウィキを検索しています…",
    q_answering: "回答を作成中…",
    q_answering_from: "{n}件のページに基づいて回答を作成中…",
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
    gr_skin: "カラーモード",
    gr_skin_auto: "アプリテーマ",
    gr_skin_black: "ブラック",
    gr_skin_white: "ホワイト",
    gr_skin_galaxy: "ギャラクシー",
    gr_galaxies: "フォルダー銀河",
    gr_galaxies_hint: "フォルダーごとにゆっくり自転する銀河へ分割",
    gr_multiverse: "マルチバース",
    gr_multiverse_hint: "各プロジェクトを宇宙バブルとして表示。ひとつに飛び込むとそのプロジェクトが開く",
    gr_mv_loading: "宇宙を描いています…",
    gr_mv_none: "まだ表示できるボルトがありません。",
    gr_layout: "レイアウト",
    gr_layout_galaxy: "ギャラクシー (3D)",
    gr_layout_atlas: "アトラス (2D)",
    gr_layout_synapse: "シナプス (2D)",
    gr_layout_synapse3d: "シナプス (3D)",
    gr_recommend: "推奨設定を適用",
    gr_recommend_hint: "このレイアウトの推奨設定を適用します",
    gr_sky: "背景",
    gr_sky_stars: "星",
    gr_sky_dense: "密",
    gr_sky_grid: "グリッド",
    gr_sky_void: "空",
    gr_node_color: "ノード色",
    gr_node_color_community: "フォルダー別",
    gr_node_color_white: "ホワイト",
    gr_node_color_auto: "自動",
    gr_mono_below: "N個以上で色付け",
    gr_tl_speed: "タイムラプス速度",
    gr_scale_star: "恒星",
    gr_scale_system: "恒星系",
    gr_scale_galaxy: "銀河",
    gr_scale_cluster: "銀河団",
    gr_arrows: "矢印",
    gr_arrows_hint: "各リンクに方向を表示",
    gr_arrow_size: "矢印サイズ",
    gr_semantic_edges: "セマンティックリンク",
    gr_semantic_edges_hint: "類似ノート間に淡いエッジを表示",
    gr_edge_bundles: "バンドルストランド",
    gr_edge_bundles_hint: "2つのトピック間のリンクを1本の重み付きアークに束ねる",
    gr_fly_btn: "宇宙船モード (F)",
    gr_timelapse_record: "タイムラプス録画 (WebM)",
    gr_node_color_black: "ブラック",
    gr_cosmic: "宇宙イベント",
    gr_cosmic_hint: "ブラックホール・ワームホール (ダークテーマ)",
    gr_cosmic_freq: "イベント頻度",
    gr_click_burst: "クリックバースト",
    gr_click_burst_hint: "ノード選択時のスーパーノヴァ + 波紋",
    gr_neural_firing: "神経発火",
    gr_neural_firing_hint: "定期的にメッシュを伝う信号",
    gr_planets: "近接プラネット",
    gr_planets_hint: "近づくとノードが手続き的な惑星になる (ダーク3D)",
    gr_color_depth: "色の濃さ",
    gr_edge_tint: "リンク色",
    gr_edge_tint_grey: "グレー",
    gr_edge_tint_community: "コミュニティウェブ",
    gr_help_btn: "ジェスチャーガイド",
    gr_help_title: "ジェスチャーガイド",
    gr_help_click: "ノートにフォーカス (1ホップ)",
    gr_help_dblclick: "フォーカスを2ホップに拡大",
    gr_help_cmdclick: "ノート間の最短経路",
    gr_help_esc: "フォーカスから一段戻る",
    gr_help_fly: "宇宙船モード切替",
    gr_help_drag: "宇宙をオービット回転",
    gr_trace: "経路トレース",
    gr_trace_hint: "開始ノードをクリックし、次に終了ノードをクリック",
    gr_spaceship: "宇宙船",
    gr_spaceship_hint: "WASDで飛行 · ドラッグで方向 · ノードをクリックで情報 · Escで終了",
    gr_spaceship_exit: "終了",
    gr_speed: "速度",
    gr_close: "閉じる",
    gr_open: "ページを開く",
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
    p_sources: "出典 {n}件",
    p_src_manual: "手書きの出典",
    p_src_missing: "raw 原本なし",
    p_lint_running: "Lint 実行中 — 他のページに移動してもバックグラウンドで続行します。",
    p_lint_done: "Lint 完了",
    p_lint_failed: "Lint 失敗",
    s_title: "設定",
    s_account: "アカウント",
    s_local_user: "ローカルユーザー",
    s_no_vault: "ボールトなし",
    s_vault_path: "ボールトのパス",
    s_change: "変更…",
    q_empty_response: "(応答なし)",
    eb_title: "{area}で問題が発生しました。",
    eb_reload: "Memex を再読み込み",
    eb_retry: "再試行",
    eb_area_app: "アプリ",
    eb_area_graph: "グラフ",
    s_workspace: "ワークスペース",
    s_model: "モデル",
    s_embeddings: "セマンティック検索",
    s_embeddings_lede: "セマンティック検索・関連ノート・グラフ類似度のためのオンデバイス埋め込みインデックスを構築します。オフラインで動作。",
    s_embeddings_indexed: "ページをインデックス済み",
    s_embeddings_reindex: "今すぐ再インデックス",
    s_embeddings_indexing: "インデックス中…",
    s_embeddings_empty: "未インデックス",
    s_embeddings_loading_model: "モデル読み込み中…",
    s_embeddings_loading_model_hint: "初回は内蔵モデルを読み込みます — 数秒かかります。",
    s_embeddings_done: "{n}ページをインデックスしました",
    s_autoreindex_title: "インデックスを自動更新",
    s_autoreindex_desc: "Memexが開いている間、編集の手が止まったら変更したページを再埋め込みします。変更されたページのみ処理します。",
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
    ol_delete: "モデルを削除",
    ol_delete_confirm: "削除しますか？",
    ol_delete_yes: "削除",
    ol_deleting: "削除中…",
    ol_delete_failed: "モデルを削除できませんでした。",
    ui_close: "閉じる",
    p_lint_run: "リント実行",
    p_linting: "リント中…",
    p_lint_report: "リントレポート",
    p_dismiss: "閉じる",
    p_open_vault: "出典をスキャンするには vault を開いてください。",
    p_scanning: "vault をスキャン中…",
    p_empty: "まだ主張を含むノートがありません — 本文を追加してください。",
    p_overall: "全体",
    p_claims_cited: "件の主張が引用済み",
    p_pages_by_coverage: "ページ別の引用カバレッジ",
    rd_meta: "{date} 更新 · {words} 語 · リンク {links}",
    rd_source: "ソース",
    rd_split: "分割",
    rd_preview: "プレビュー",
    rd_backlinks_empty: "まだここにリンクするノートはありません。",
    rd_related: "関連ノート",
    rd_related_no_index: "関連ノートは、まだ作成されていないオンデバイス索引から取得します。",
    rd_related_no_index_cta: "セマンティック検索を設定",
    rd_make_cards: "カード作成",
    rd_making: "生成中…",
    rd_cards_none: "生成されたカードがありません。",
    rd_cards_made: "カードを{n}枚追加しました",
    rd_open_study: "学習を開く",
    st_title: "学習",
    st_lede:
      "ページから生成した間隔反復フラッシュカードとクイズで知識を復習しましょう。",
    st_no_decks: "デッキがありません",
    st_generate_hint: "ページを開いて「カード作成」を選ぶとデッキを生成できます。",
    st_browse_pages: "ページを見る",
    st_refresh: "更新",
    st_total: "{n}枚",
    st_due: "{n}枚復習",
    st_no_due: "すべて完了",
    st_all_decks: "すべてのデッキ",
    st_review: "復習",
    st_quiz: "クイズ",
    st_loading: "読み込み中…",
    st_progress: "{done} / {total}",
    st_source: "出典",
    st_flip: "答えを表示",
    st_grade_again: "もう一度",
    st_grade_hard: "難しい",
    st_grade_good: "普通",
    st_grade_easy: "簡単",
    st_all_done: "完了",
    st_done_sub: "{n}枚のカードを復習しました。",
    st_quiz_needs_cards:
      "クイズを行うには、まずこのデッキにカードを追加してください。",
    st_quiz_intro: "このデッキのカードから選択式クイズを生成します。",
    st_quiz_empty: "モデルが問題を返しませんでした。もう一度お試しください。",
    st_gen_quiz: "クイズを生成",
    st_generating: "生成中…",
    st_quiz_done: "クイズ完了",
    st_quiz_score: "スコア: {score} / {total}",
    st_correct: "正解",
    st_wrong: "不正解",
    st_next: "次へ",
    q_mode: "モード",
    q_mode_ask: "質問",
    q_mode_agent: "エージェント",
    ag_lede:
      "エージェントに複数ステップのタスクを任せましょう。計画し、ウィキを検索・閲覧・リンクして、出典付きで回答します。",
    ag_preset: "タスクエージェント",
    ag_preset_none: "デフォルト",
    ag_new_preset: "新規エージェント",
    ag_preset_name: "名前",
    ag_preset_prompt: "システムプロンプト",
    ag_preset_prompt_hint: "このエージェントの役割は？",
    ag_allow_write: "書き込みを許可",
    ag_write_hint: "エージェントによるページの作成/更新を許可（書き込みごとに確認）",
    ag_ph: "エージェントに複数ステップのタスクを指示…",
    ag_run: "実行",
    ag_stop: "停止",
    ag_task: "タスク",
    ag_steps: "{n}ステップ",
    ag_working: "実行中",
    ag_declined: "拒否",
    ag_stopped_limit: "ステップ上限で停止 — 部分的な回答です。",
    ag_unsupported:
      "エージェントモードには Anthropic API または OpenAI 互換プロバイダーが必要です。現在: {provider}。",
    rd_audio: "音声概要",
    au_title: "音声概要",
    au_close: "閉じる",
    au_generating: "対話を作成中…",
    au_play: "再生",
    au_pause: "一時停止",
    au_stop: "停止",
    au_turns: "{n}ターン",
    au_open_transcript: "文字起こしを開く",
    au_no_tts: "音声合成を利用できません — 文字起こしのみ表示します。",
    au_host: "ホスト",
    au_guest: "ゲスト",
    au_play_from: "ここから再生",
    pdf_page: "p. {n} / {total}",
    pdf_close: "閉じる",
    pdf_loading: "PDF を読み込み中…",
    pdf_error: "この PDF を開けませんでした。",
    pdf_highlight_cite: "ハイライトして引用",
    sc_title: "スケジュール",
    sc_lede: "アプリが開いている間、ボルトに定期ダイジェストを書き込みます。",
    sc_new: "新規スケジュール",
    sc_empty: "スケジュールはまだありません。",
    sc_run_now: "今すぐ実行",
    sc_running: "実行中…",
    sc_edit: "編集",
    sc_last_run: "最終実行 {t}",
    sc_never: "未実行",
    sc_done: "ダイジェストを書き込みました。",
    sc_open: "ダイジェストを開く",
    sc_f_title: "タイトル（例: 週次レビュー）",
    sc_f_kind: "種類",
    sc_f_cadence: "頻度",
    sc_f_prompt: "ウィキに実行するプロンプト",
    sc_f_topic: "追跡するトピック",
    sc_f_enabled: "有効",
    sc_f_notify: "通知",
    sc_f_notify_hint: "実行完了時にネイティブ通知（オプトイン）",
    sc_f_save: "保存",
    sc_f_cancel: "キャンセル",
    sc_bg_install: "バックグラウンド実行",
    sc_bg_remove: "バックグラウンド解除",
    sc_bg_hint: "アプリが閉じていてもこのスケジュールを実行 (macOS launchd)",
    ing_title_label: "タイトル",
    ing_title_ph: "例: Byte Pair Encoding",
    ing_working: "処理中…",
    q_via: "{provider} · {model} を使用",
    q_builtin_note:
      "内蔵のオフラインモデル（Gemma 3 1B）は小さく不正確な場合があります。オフラインなら Ollama で大きめのモデル（例: gemma3:4b）を、最も正確な回答には Claude をお使いください。",
    q_open_model_settings: "モデル設定",
    q_you: "あなた",
    sb_new_note: "新規ノート",
    sb_new_folder: "新規フォルダ",
    sb_rename: "名前を変更…",
    sb_today_note: "今日のノート",
    sb_new_note_root: "vault ルートに新規ノート",
    sb_delete_folder_q: "フォルダを削除しますか?",
    sb_delete_file_q: "ファイルを削除しますか?",
    cb_no_results: "結果なし",
    cb_tag_page: "ページ",
    cb_tag_file: "ファイル",
    cb_in_contents: "ページ本文内",
    cb_semantic: "関連（意味）",
    tb_lint: "リント",
    tb_toggle_sidebar: "サイドバー切替 (⌘B)",
    tb_model_picker: "質問用モデルを変更",
    gr_zoom_out: "ズームアウト",
    gr_fit: "全体表示",
    gr_zoom_in: "ズームイン",
    ov_no_git: "まだ git 履歴がありません。",
    h_open_vault: "履歴を見るには vault を開いてください。",
    tg_title: "タグ",
    tg_lede:
      "vault のフロントマターにあるすべてのタグ。タグを選ぶとそのタグが付いたページが表示され、ページへ直接移動できます。",
    tg_empty:
      "まだタグがありません — ページのフロントマターに `tags:` を追加すると、ここに集まります。",
    rf_title: "Reflect の提案",
    rf_lede:
      "Claude が vault を読み取り専用でざっと確認します: リンクすべき孤立ノード、古いページ、欠けた相互参照。",
    rf_run: "Reflect 実行",
    rf_running: "分析中…",
    rf_empty: "提案はありません — vault は十分につながっています。",
    ob_title: "Memex へようこそ",
    ob_skip: "スキップ",
    ob_back: "戻る",
    ob_next: "次へ",
    ob_finish: "完了",
    ob_vault_linked: "接続済み",
    ob_vault_none: "まだ vault が接続されていません",
    ob_s1_title: "プロジェクトを作成 / 開く",
    ob_s1_body:
      "Memex はすべてのページを、あなたが管理するフォルダにマークダウンで保存します。既存のフォルダを開くか、作成された既定の vault をそのまま使ってください。",
    ob_s1_action: "フォルダを開く…",
    ob_s2_title: "最初のソースを追加",
    ob_s2_body:
      "ファイルをドロップ、URL を貼り付け、あるいはメモを書く。Memex が読み、エンティティと概念を抽出し、出典付きのページをグラフに織り込みます。",
    ob_s2_action: "取り込みへ",
    ob_s3_title: "質問する",
    ob_s3_body:
      "ウィキに何でも聞いてください。Memex はまずあなたのページから答え、必要なときだけ原本に降ります — すべての主張に出典が付きます。",
    ob_s3_action: "質問へ",
    s_budget_title: "月間支出ガード",
    s_budget_desc:
      "今月の有料 API プロバイダーでの推定支出です。正確な請求ではなくおおまかな警報 — しきい値を設定すると超過前に警告します。",
    s_budget_threshold: "月間上限 (USD)",
    s_budget_usage: "今月",
    s_budget_total: "合計",
    s_budget_empty: "今月はまだ有料 API の使用量が記録されていません。",
    s_autoreflect_title: "自動リフレクト",
    s_autoreflect_desc:
      "Memex を開いている間、読み取り専用のリフレクトを定期的に実行し、孤立ノード・古いページ・欠けたリンクを洗い出します。",
    s_autoreflect_interval: "間隔",
    s_vault_register: "独立した Obsidian ボルトにする",
    s_vault_registered: "Obsidian ボルト準備完了",
    s_provider_desc_anthropic_cli:
      "ローカルの `claude` CLI で Claude Pro / Max サブスクリプションを使用します。API キー不要。",
    s_provider_desc_gemini_cli:
      "ローカルの `gemini` CLI で Google サブスクリプションを使用します。API キー不要。",
    s_provider_desc_codex_cli:
      "ローカルの `codex` CLI で OpenAI サブスクリプションを使用します。API キー不要。",
    s_provider_desc_anthropic_api:
      "api.anthropic.com に直接呼び出します。キーは console.anthropic.com から取得。",
    s_provider_desc_openai_api: "api.openai.com 経由の GPT-5 ファミリー。",
    s_provider_desc_google_api:
      "generativelanguage.googleapis.com 経由の Gemini ファミリー。",
    s_provider_desc_builtin_local:
      "アプリに同梱された Gemma 3 1B。セットアップ不要でオフライン動作、分類や軽い質問に最適です。高品質な取り込みにはクラウドプロバイダーを使用してください。Model © Google, Gemma Terms of Use 適用（全文同梱）。",
    s_provider_desc_ollama:
      "オープンソースモデルをローカルで実行します。http://localhost:11434 を自動検出。",
    s_provider_desc_openrouter:
      "1 つのキーで多数のプロバイダーを利用（モデル比較に便利）。",
    s_provider_desc_memex_pro:
      "マネージドモデルで無制限の取り込み — API キーや CLI は不要。Memex Pro アカウントでサインインしてください。",
    // Backfilled ja (was English-fallback): suggested links, Zotero, help,
    // query views, graph inspector/gaps, MCP SSE.
    ls_title: "リンク候補",
    ls_hint: "意味的に近いのにまだリンクされていないノートです。承認すると「## Related」の下に [[wikilink]] が追加されます。",
    ls_accept: "リンクする",
    ls_dismiss: "閉じる",
    zi_title: "Zotero からインポート",
    zi_hint: "CSL-JSON または BibTeX エクスポート（ハイライトがあれば一緒に取り込まれます）。項目はソース文書として _inbox/ に入り、取り込みパイプラインで処理されます。",
    zi_none: "そのファイルにインポート可能な項目が見つかりませんでした。",
    zi_done: "{n} 件を _inbox/ にインポートしました — 「取り込み」を実行して wiki ページに変換してください。",
    ci_title: "会話をインポート",
    ci_hint: "ChatGPT エクスポート（conversations.json）または Claude Code / Codex セッション（.jsonl）。各会話はソース文書として _inbox/ に入り、取り込みパイプラインが処理します。",
    ci_btn: "ファイルを選択…",
    ci_busy: "インポート中…",
    ci_done: "{n} 件の会話を _inbox/ にインポートしました — 「取り込み」を実行して wiki ページに変換してください。",
    ci_quarantined: "{n} 件の会話はシークレット（API キー・トークン）と思われる内容を含むため除外されました。元データで確認してください。インポートされていません。",
    ci_none: "そのファイルに会話が見つかりませんでした。",
    ci_skipped: "（{n} 件はインポート済みのためスキップ。）",
    ci_sweep_cc: "自分の Claude Code セッションをインポート",
    ci_sweep_cx: "自分の Codex セッションをインポート",
    ci_sweep_hint: "またはこのマシンにある全セッションをインポート — ~/.claude・~/.codex から。再実行しても新規・増加分のみ追加されます。",
    ci_sweep_progress: "セッションをインポート中 {done} / {total}",
    ci_sweep_tally: "インポート {i} · スキップ {s} · 失敗 {f}",
    ci_failed_summary: "{n} 件をインポートできませんでした",
    ci_retry_failed: "失敗を再試行 ({n})",
    q_empty: "wiki に何でも質問できます — 回答はあなた自身のページを引用します。",
    s_mascot: "マスコット MYCO を表示",
    s_mascot_hint: "ローダー・空の状態・About ページに表示。オフにすると静的ロゴになります。",
    hw_title: "ヘルプ",
    hw_sub: "このページのヒント",
    hw_sc_cmd: "コマンドパレット",
    hw_sc_sidebar: "サイドバーの切り替え",
    hw_sc_fly: "フライモード（グラフ）",
    hw_sc_esc: "閉じる / 選択解除",
    hw_tip_graph1: "星をドラッグするとシミュレーションがその周りで再加熱されます。",
    hw_tip_graph2: "F で宇宙船を飛ばせます。⚠ バッジを押すとリサーチブリッジ付きのギャップ分析が開きます。",
    hw_tip_graph3: "近接惑星（設定ドロワー）は間近のノートを惑星に変えます。",
    hw_tip_query1: "回答は wiki ページを引用します — 引用をクリックすると開きます。",
    hw_tip_query2: "グラフのギャップパネルからリサーチ質問をこの入力欄に下書きできます。",
    hw_tip_ingest1: "任意のファイルをドロップ、テキストを貼り付け、または Zotero エクスポートをインポートできます。",
    hw_tip_ingest2: "Web クリッパーは _inbox/ 経由でページをここに送ります（clipper/ を参照）。",
    hw_tip_views1: "フィルターは組み合わせられます — 結果は名前付きビューチップとして保存できます。",
    hw_tip_overview1: "リンク候補はまだ wikilink のない意味的なペアです — 承認または却下してください。",
    hw_tip_default: "⌘K でどこへでも移動 — ページ・アクション・意味的ヒット。",
    vw_title: "クエリビュー",
    vw_lede: "フロントマター（タイプ・確信度・ステータス・タグ・ソース）で wiki を絞り込み、よく使うレンズを保存できます。",
    vw_search: "名前で絞り込み…",
    vw_any_type: "すべてのタイプ",
    vw_any_conf: "すべての確信度",
    vw_any_status: "すべてのステータス",
    vw_any_tag: "すべてのタグ",
    vw_orphans: "孤立ページのみ",
    vw_save: "ビューを保存",
    vw_save_prompt: "このビューの名前:",
    vw_pages: "ページ",
    vw_empty: "このビューに一致するページはありません。",
    vw_col_name: "ページ",
    vw_col_type: "タイプ",
    vw_col_conf: "確信度",
    vw_col_sources: "ソース",
    vw_col_links: "リンク",
    vw_col_tags: "タグ",
    gr_insp_type: "タイプ",
    gr_insp_confidence: "確信度",
    gr_insp_status: "ステータス",
    gr_insp_connections: "接続",
    gr_insp_links_out: "リンク",
    gr_insp_backlinks: "バックリンク",
    gr_insp_tags: "タグ",
    gr_insp_open: "リーダーで開く",
    gr_insp_unresolved: "未解決のノート（ファイルなし）",
    gr_insp_none: "—",
    gr_find_ph: "ノートを検索…",
    gr_insp_path_start: "パスの起点に設定",
    gr_insp_path_anchor: "パスの起点",
    gr_insp_path_clear: "クリア",
    gr_insp_path: "パス",
    gr_insp_path_none: "このノードへのパスがありません",
    gr_insp_hops: "ホップ",
    gr_gaps_title: "ギャップ",
    gr_gaps_btn: "ギャップ分析",
    gr_gap_missing: "欠落ページ",
    gr_gap_orphans: "孤立ページ",
    gr_gap_undercited: "引用不足",
    gr_gap_lowconf: "低確信度",
    gr_gap_disputed: "係争中",
    gr_gap_islands: "未接続",
    gr_gap_none: "ギャップは見つかりませんでした",
    gr_gap_bridges: "リサーチブリッジ",
    gr_gap_ask: "このギャップについて質問",
    gr_bridge_question: "「{a}」と「{b}」に関する私のノートは意味的に関連していますが、まだリンクされていません。この 2 つのトピックを結びつけるものは何ですか？ 橋渡しとなるアイデアや、書くべきノートを提案してください。",
    gr_gap_more: "もっと見る",
    gr_key_size: "サイズ = リンク数",
    gr_key_dim: "淡色 = 低確信度",
    gr_key_amber: "橙色 = 係争中",
    gr_key_neutral: "灰色 = 未分類",
    gr_more: "他 {n} 件",
    gr_focus_trail: "フォーカストレイル",
    gr_focus_esc: "抜ける（Esc / 空白をクリック）",
    gr_preset: "レイアウト",
    gr_preset_galaxy: "ギャラクシー",
    gr_preset_loose: "疎なウェブ",
    gr_preset_dense: "密",
    gr_glow: "グロー",
    gr_motion: "アンビエントモーション",
    gr_motion_hint: "自動回転・パルス・呼吸",
    gr_advanced: "詳細設定",
    gr_loading: "星座を整列中…",
    gr_ctx_lost: "グラフィックスコンテキストが失われました。",
    gr_retry: "再構築",
    gr_perf_mode: "パフォーマンスモード — 大きなグラフではアンビエントレイヤーをオフに",
    mcp_serving: "SSE サーバー実行中",
    mcp_not_serving: "SSE サーバー停止中",
    mcp_start_btn: "サーバーを起動",
    mcp_stop_btn: "停止",
    mcp_registering: "登録中…",
  },
};
