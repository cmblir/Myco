// i18n — EN / KO / JA. Notion-flavoured copy.

export type Lang = "en" | "ko" | "ja";

export interface Strings {
  app_name: string;
  quick_search: string;
  quick_ask: string;
  nav_workspace: string;
  nav_pages: string;
  nav_tools: string;
  nav_overview: string;
  nav_ingest: string;
  nav_query: string;
  nav_graph: string;
  db_empty: string;
  bd_title: string;
  bd_range: string;
  bd_range_all: string;
  bd_edit: string;
  bd_done: string;
  bd_add: string;
  bd_custom: string;
  bd_text: string;
  bd_heading: string;
  bd_compact: string;
  bd_compact_v: string;
  bd_compact_none: string;
  bd_empty: string;
  bd_drag: string;
  bd_configure: string;
  bd_duplicate: string;
  bd_field_title: string;
  bd_field_source: string;
  bd_field_group: string;
  bd_field_filter: string;
  bd_field_view: string;
  bd_field_time: string;
  bd_field_rule: string;
  bd_filter_none: string;
  bd_time_auto: string;
  bd_rule_risk: string;
  bd_rule_ok: string;
  bd_src_inflow: string;
  bd_src_notes: string;
  bd_src_tasks: string;
  bd_preset_mcp_daily: string;
  bd_preset_channels_daily: string;
  bd_preset_notes_by_type: string;
  bd_preset_top_tags: string;
  bd_preset_edits_daily: string;
  bd_preset_tasks_by_status: string;
  bd_preset_unsourced_stat: string;
  bd_g_day: string;
  bd_g_channel: string;
  bd_g_type: string;
  bd_g_confidence: string;
  bd_g_status: string;
  bd_g_tag: string;
  bd_v_bar: string;
  bd_v_line: string;
  bd_v_hbar: string;
  bd_v_stat: string;
  bd_v_table: string;
  bd_hide_zero: string;
  bd_json_form: string;
  bd_json_bad: string;
  bd_unknown: string; // {kind}
  bd_field_color: string;
  bd_color_default: string;
  bd_color_blue: string;
  bd_color_green: string;
  bd_color_purple: string;
  bd_color_amber: string;
  bd_color_cyan: string;
  bd_color_red: string;
  bd_detail_total: string; // {n}
  bd_board_pick: string;
  bd_new_board: string;
  bd_new_board_prompt: string;
  bd_delete_board: string;
  bd_delete_confirm: string; // {name}
  ls_title: string;
  ls_hint: string;
  ls_accept: string;
  ls_dismiss: string;
  ls_accept_all: string;
  ls_linking: string;
  ls_toast_linked: string;
  ls_toast_linked_sub: string;
  ls_toast_failed: string;
  ls_toast_retry: string;
  zi_title: string;
  zi_hint: string;
  zi_none: string;
  zi_done: string;
  ci_title: string;
  ci_hint: string;
  ci_btn: string;
  ci_busy: string;
  ci_done: string; // {n}
  ci_quarantined: string; // {n}
  ci_none: string;
  ci_skipped: string; // {n}
  ci_sweep_cc: string;
  ci_sweep_cx: string;
  ci_sweep_hint: string;
  ci_sweep_progress: string; // {done} {total}
  ci_sweep_tally: string; // {i} {s} {f}
  ci_failed_summary: string; // {n}
  ci_retry_failed: string; // {n}
  q_empty: string;
  s_mascot: string;
  s_mascot_hint: string;
  s_backup_title: string;
  s_backup_hint: string;
  s_backup_export: string;
  s_backup_import: string;
  s_backup_busy: string;
  s_backup_exported: string;
  s_backup_imported: string; // {sections}
  s_backup_import_failed: string; // {error}
  s_backup_bad_json: string;
  s_backup_section_settings: string;
  s_backup_section_ui: string;
  s_backup_section_graph: string;
  s_backup_section_savedLooks: string;
  s_backup_section_queryViews: string;
  s_backup_section_dismissedLinkSuggestions: string;
  s_backup_section_reflectIgnored: string;
  s_backup_section_budgetThresholdUsd: string;
  s_backup_confirm_title: string;
  s_backup_confirm_body: string; // {sections}
  s_backup_confirm_none: string;
  s_backup_confirm_apply: string;
  s_backup_confirm_cancel: string;
  s_backup_undo: string;
  s_backup_undo_hint: string;
  s_backup_undone: string; // {sections}
  hw_title: string;
  hw_sub: string;
  hw_sc_cmd: string;
  hw_sc_sidebar: string;
  hw_sc_fly: string;
  hw_sc_esc: string;
  hw_sc_new: string;
  hw_sc_spotlight: string;
  hw_sc_voice: string;
  hw_sc_miss: string;
  hw_sc_path: string;
  hw_sc_live_link: string;
  hw_sc_back: string;
  hw_sc_fwd: string;
  hw_tip_graph1: string;
  hw_tip_graph2: string;
  hw_tip_graph3: string;
  hw_tip_query1: string;
  hw_tip_query2: string;
  hw_tip_ingest1: string;
  hw_tip_ingest2: string;
  hw_tip_overview1: string;
  hw_tip_default: string;
  vw_lens_unsourced: string;
  vw_lens_orphans: string;
  vw_lens_disputed: string;
  vw_lens_recent: string;
  tpl_new_from: string;
  tpl_pick_title: string;
  tpl_pick_msg: string;
  tpl_empty: string;
  tpl_create_starters: string;
  tpl_creating: string;
  tpl_create_error: string;
  tpl_note_error: string;
  tpl_starter_note: string;
  tpl_starter_meeting: string;
  tpl_starter_note_body: string;
  tpl_starter_meeting_body: string;
  nav_history: string;
  nav_provenance: string;
  nav_tasks: string;
  tasks_title: string;
  tasks_lede: string;
  tasks_loading: string;
  tasks_empty: string;
  tasks_empty_hint: string;
  tasks_ph: string;
  tasks_due: string;
  tasks_add: string;
  tasks_stale: string;
  tasks_view: string;
  tasks_view_list: string;
  tasks_view_board: string;
  tasks_col_todo: string;
  tasks_col_doing: string;
  tasks_col_blocked: string;
  tasks_col_done: string;
  tasks_notify: string;
  tasks_view_calendar: string;
  tasks_cal_today: string;
  tasks_cal_undated: string;
  tasks_detail: string;
  tasks_detail_close: string;
  tasks_detail_status: string;
  tasks_detail_start: string;
  tasks_detail_scheduled: string;
  tasks_detail_priority: string;
  tasks_detail_priority_none: string;
  tasks_detail_estimate: string;
  tasks_detail_estimate_hint: string;
  tasks_detail_recur: string;
  tasks_detail_recur_hint: string;
  tasks_detail_notes: string;
  tasks_detail_notes_ph: string;
  tasks_detail_start_after_due: string;
  tasks_detail_open_note: string;
  tasks_hub: string;
  tasks_hub_heading: string;
  tasks_hub_empty: string;
  tasks_hub_written: string;
  tasks_hub_kept: string;
  tasks_compose_more: string;
  tasks_compose_category: string;
  tasks_compose_project: string;
  tasks_compose_target: string;
  tasks_compose_daily: string;
  tasks_new_roadmap: string;
  tasks_new_roadmap_ph: string;
  tasks_view_roadmap: string;
  tasks_roadmap_empty: string;
  tasks_roadmap_empty_hint: string;
  tasks_roadmap_progress: string;
  // Tray popover v3: header subtitle states, the now-card, the glass tiles.
  tray_sub_waiting_n: string; // {n}
  tray_sub_clear: string;
  tray_sub_distilling: string; // {step}
  tray_now_eyebrow: string;
  tray_toast_approved: string; // {name}
  tray_tile_waiting: string;
  tray_tile_today: string;
  tray_row_links: string;
  tray_row_reflect: string;
  tray_row_sessions: string;
  tray_card_tasks_v: string; // {n}
  tray_card_tasks_sub: string; // {n}
  tray_last24: string;
  tray_legend_hourly: string;
  dp_prev: string;
  dp_next: string;
  dp_clear: string;
  tasks_open_n: string;
  tasks_done_n: string;
  tasks_all_done: string;
  tasks_completed: string;
  nav_study: string;
  nav_settings: string;
  // Split view (two panes side by side)
  split_open: string;
  split_close: string;
  split_pick: string;
  split_resize: string;
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
  ov_stats_links: string;
  ov_stats_ratio: string;
  ov_quick: string;
  ov_stats_moved: string;
  ov_moved_none: string;
  ov_pulse_alt: string;
  ov_recent_moved: string;
  ov_recent_never: string;
  ing_title: string;
  ing_lede: string;
  ing_drop: string;
  ing_drop_or: string;
  ing_browse: string;
  ing_drop_multi: string; // {n} = count
  ing_inbox_pending: string; // {n} = pending file count
  ing_inbox_empty: string;
  ing_inbox_today: string;
  ing_inbox_unsupported_chip: string;
  ing_inbox_unsupported_line: string; // {n} = unsupported file count
  ing_yt_fetch: string;
  ing_yt_fetching: string;
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
  hist_collapse: string;
  hist_expand: string;
  ing_run_again: string;
  ing_live_title: string;
  ing_live_warmup: string;
  ing_live_activity: string;
  ing_live_earlier: string;
  ing_live_files: string;
  ing_live_reads: string;
  ing_live_writes: string;
  ing_grounded: string;
  ing_grounded_hint: string;
  ing_plan: string;
  ing_plan_hint: string;
  ingest_gate_title: string;
  ingest_gate_apply: string; // {n}
  ingest_gate_all: string;
  ingest_gate_noop_hint: string;
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
  gr_node_count: string;
  gr_edge_count: string;
  gr_all: string;
  gr_layout_spiral: string;
  gr_layout_strata: string;
  gr_layout_semantic: string;
  gr_layout_celestial: string;
  gr_layout_radial: string;
  gr_layout_walrus: string;
  mc_label: string;
  mc_dismiss: string;
  gr_layout_galaxy_s: string;
  gr_layout_synapse3d_s: string;
  gr_layout_atlas_s: string;
  // Gesture cheat-sheet popover ("?" toolbar button).
  gr_open: string;
  gr_empty_pre: string;
  gr_empty_post: string;
  // Mycelium-only relabels for the shared Motion/Forces controls (optional —
  // components fall back to English).
  // Graph node inspector (optional — components fall back to English).
  gr_insp_type: string;
  gr_insp_confidence: string;
  gr_insp_status: string;
  gr_insp_links_out: string;
  gr_insp_backlinks: string;
  gr_insp_open: string;
  gr_insp_unresolved: string;
  gr_insp_none: string;
  gr_find_ph: string;
  gr_gaps_title: string;
  gr_gap_missing: string;
  gr_gap_orphans: string;
  gr_gap_undercited: string;
  gr_gap_lowconf: string;
  gr_gap_islands: string;
  gr_gap_none: string;
  gr_gap_more: string;
  q_thinking: string;
  q_answering: string;
  q_answering_from: string;
  gr_loading: string;
  gr_title: string;
  gr_lede: string;
  gr_canvas_aria: string;
  gr_stage_hint: string;
  gr_q_lead: string;
  gr_q_orphans: string;
  gr_q_orphans_u: string;
  gr_q_sub_orphans: string;
  gr_q_clusters: string;
  gr_q_clusters_u: string;
  gr_q_sub_clusters: string;
  gr_q_time: string;
  gr_q_time_u: string;
  gr_q_sub_time: string;
  gr_q_neighbors: string;
  gr_q_neighbors_u: string;
  gr_q_sub_neighbors: string;
  gr_q_pick: string;
  gr_size: string;
  gr_size_backlinks: string;
  gr_size_cites: string;
  gr_hide_sample: string;
  gr_show_unresolved: string;
  gr_rebuilds: string;
  gr_honest_lead: string;
  gr_honest: string;
  gr_honest_sessions: string;
  gr_gap_nobacklink: string;
  gr_act_link: string;
  gr_act_harvest: string;
  gr_act_neighbors: string;
  gr_act_open_s: string;
  gr_act_link_s: string;
  gr_act_want_s: string;
  gr_insp_h: string;
  gr_insp_empty: string;
  gr_insp_cites: string;
  gr_insp_sample: string;
  gr_insp_own: string;
  gr_insp_nocite: string;
  gr_cluster_nomap: string;
  gr_cluster_map: string;
  gr_enc_orphans: string;
  gr_enc_clusters: string;
  gr_enc_time: string;
  gr_enc_neighbors: string;
  gr_link_question: string;
  gr_want_done: string;
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
  s_search_ph: string;
  s_search_empty: string; // {q}
  s_account: string;
  s_local_user: string;
  s_no_vault: string;
  s_vault_path: string;
  s_change: string;
  q_empty_response: string;
  eb_title: string; // "{area}" is substituted with eb_area_*
  eb_reload: string;
  eb_retry: string;
  eb_area_app: string;
  eb_area_graph: string;
  s_workspace: string;
  s_model: string;
  s_embeddings: string;
  s_embeddings_lede: string;
  s_embeddings_indexed: string;
  s_embeddings_reindex: string;
  s_embeddings_indexing: string;
  s_embeddings_empty: string;
  s_embeddings_loading_model: string;
  s_embeddings_loading_model_hint: string;
  s_embeddings_done: string;
  s_autoreindex_title: string;
  s_autoreindex_desc: string;
  s_providers: string;
  s_mcp: string;
  s_appearance: string;
  s_vault_known: string;
  s_ov_theme: string;
  s_ov_theme_lede: string;
  ov_theme_mycelium: string;
  s_lang: string;
  s_about: string;
  // In-app updater (Settings -> About + the app-wide banner). {v} = new version.
  up_check: string;
  up_checking: string;
  up_current: string;
  up_downloading: string; // {v}
  up_ready: string; // {v}
  up_restart: string;
  up_restart_btn: string;
  up_unconfigured: string;
  up_unavailable: string;
  up_error: string;
  up_dismiss: string;
  // Crash report viewer (Settings -> About, ROADMAP P2).
  cr_last_crash: string;
  cr_at: string; // "{time} at {location}" — {time} and {location}
  cr_copy: string;
  cr_copied: string;
  cr_note_label: string;
  cr_note_ph: string;
  cr_clear: string;
  cr_cleared: string;
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
  mcp_serving: string;
  mcp_not_serving: string;
  mcp_start_btn: string;
  mcp_stop_btn: string;
  mcp_registering: string;
  mcp_starting: string;
  mcp_connect_btn: string;
  mcp_connecting: string;
  mcp_connect_hint: string;
  s_model_lede: string;
  s_model_ingest: string;
  s_model_query: string;
  model_custom: string;
  model_disconnected: string;
  model_custom_ph: string;
  model_effort: string;
  model_fetching: string;
  s_model_recommended: string;
  s_model_ctx: string;
  // Offline (extractive) ingest — the builtin-local provider's ingest path.
  // `ing_extractive_note` / `_report_*` / `_log` are written INTO the vault
  // (wiki/source-*.md, ingest-reports/, wiki/log.md); `_hint` is the line the
  // Ingest page shows next to the model name. See lib/extractiveIngest.ts.
  ing_extractive_note: string;
  ing_extractive_report_title: string;
  ing_extractive_report_why: string;
  ing_extractive_log: string;
  ing_extractive_hint: string;
  /** The Ingest run button for the offline path — `ing_run` names Claude, and
   *  a run that calls no model must not. */
  ing_run_extractive: string;
  s_providers_lede: string;
  s_provider_connected: string;
  s_provider_disconnected: string;
  s_provider_cli_missing: string;
  s_mycopro_url: string;
  s_mycopro_key: string;
  s_mycopro_email: string;
  s_mycopro_password: string;
  s_mycopro_login: string;
  s_mycopro_logout: string;
  s_mycopro_loggedin: string;
  s_mycopro_noaccess: string;
  s_autoimport_title: string;
  s_autoimport_desc: string;
  s_autoimport_interval: string;
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
  ui_close: string;
  // Provenance page.
  p_lint_run: string;
  p_linting: string;
  p_lint_report: string;
  // Local (no-model) lint report — our own fixed strings, never model prose.
  lint_local_title: string;
  lint_local_note: string;
  lint_local_clean: string;
  lint_sec_critical: string;
  lint_sec_warning: string;
  lint_sec_info: string;
  lint_k_missing_frontmatter: string;
  lint_k_invalid_frontmatter: string;
  lint_k_dangling_citation: string;
  lint_k_source_count_mismatch: string;
  lint_k_missing_superseded_by: string;
  lint_k_missing_disputed_section: string;
  lint_k_weak_confidence: string;
  lint_k_stale_page: string;
  lint_k_hedged_claim: string;
  lint_k_orphan_page: string;
  lint_k_unresolved_link: string;
  p_dismiss: string;
  p_open_vault: string;
  p_scanning: string;
  p_empty: string;
  p_overall: string;
  p_claims_cited: string;
  p_pages_by_coverage: string;
  // Reader page.
  rd_source: string;
  rd_preview: string;
  rd_live: string;
  rd_task_toggle: string;
  rd_frontmatter_hidden: string;
  rd_backlinks_empty: string;
  rd_related: string;
  rd_related_no_index: string;
  rd_related_no_index_cta: string;
  rd_make_cards: string;
  rd_making: string;
  rd_cards_none: string;
  rd_cards_made: string;
  rd_open_study: string;
  rd_more: string;
  // Reader rail: sources & trust, connections (mockup "Manuscript").
  rd_rail: string;
  rd_rail_toggle: string;
  rd_src_title: string;
  rd_src_scanning: string;
  rd_src_no_claims: string;
  rd_src_coverage: string; // {cited} {total}
  rd_src_bar: string; // {pct}
  rd_src_none: string;
  rd_src_broken: string;
  rd_src_hand: string;
  rd_src_weight: string;
  rd_src_uncited: string; // {n}
  rd_src_all: string;
  rd_conn_title: string;
  rd_conn_empty: string;
  rd_conn_back: string;
  rd_conn_sug: string;
  rd_conn_added: string; // {name}
  // Authorship gutter + per-paragraph revert.
  rd_auth_title: string;
  rd_auth_agent: string;
  rd_auth_human: string;
  rd_auth_revert: string;
  rd_auth_locked: string;
  rd_auth_human_only: string;
  rd_auth_history: string;
  rd_auth_reverted: string;
  rd_auth_nothing: string;
  rd_auth_failed: string;
  // Uncited-claim markers.
  rd_claim_dot: string;
  rd_claim_title: string;
  rd_claim_hint: string;
  rd_claim_find: string;
  rd_claim_searching: string;
  rd_claim_none: string;
  rd_claim_added: string; // {name}
  // Editor basics (P1): CodeMirror search/completion phrases, `/` block names.
  cm_find: string;
  cm_replace_field: string;
  cm_next: string;
  cm_previous: string;
  cm_all: string;
  cm_match_case: string;
  cm_by_word: string;
  cm_regexp: string;
  cm_replace: string;
  cm_replace_all: string;
  cm_close: string;
  cm_current_match: string;
  cm_replaced_matches: string;
  cm_replaced_on_line: string;
  cm_on_line: string;
  cm_goto_line: string;
  cm_go: string;
  cm_completions: string;
  sl_h1: string;
  sl_h2: string;
  sl_h3: string;
  sl_bullet: string;
  sl_numbered: string;
  sl_todo: string;
  sl_code: string;
  sl_quote: string;
  sl_table: string;
  sl_divider: string;
  sl_date: string;
  img_unsupported: string;
  img_failed: string;
  ol_title: string;
  ol_empty: string;
  ol_untitled: string;
  ol_toggle: string;
  // Reader properties panel.
  props_title: string;
  props_add: string;
  props_key_ph: string;
  props_value_ph: string;
  props_add_confirm: string;
  props_remove: string;
  props_bad_key: string;
  props_complex: string;
  props_tags_ph: string;
  props_tag_remove: string;
  // Study page (Feature 3).
  st_title: string;
  st_lede: string;
  st_no_decks: string;
  st_generate_hint: string;
  st_browse_pages: string;
  st_refresh: string;
  st_total: string;
  st_due: string;
  st_no_due: string;
  st_all_decks: string;
  st_review: string;
  st_quiz: string;
  st_loading: string;
  st_progress: string;
  st_source: string;
  st_flip: string;
  st_grade_again: string;
  st_grade_hard: string;
  st_grade_good: string;
  st_grade_easy: string;
  st_all_done: string;
  st_done_sub: string;
  st_quiz_needs_cards: string;
  st_quiz_intro: string;
  st_quiz_empty: string;
  st_gen_quiz: string;
  st_generating: string;
  st_quiz_done: string;
  st_quiz_score: string;
  st_correct: string;
  st_wrong: string;
  st_next: string;
  // Agent mode (Feature 4).
  q_mode: string;
  q_mode_ask: string;
  q_mode_agent: string;
  ag_lede: string;
  ag_preset: string;
  ag_preset_none: string;
  ag_new_preset: string;
  ag_preset_name: string;
  ag_preset_prompt: string;
  ag_preset_prompt_hint: string;
  ag_allow_write: string;
  ag_write_hint: string;
  ag_ph: string;
  ag_run: string;
  ag_stop: string;
  ag_task: string;
  ag_steps: string;
  ag_working: string;
  ag_declined: string;
  ag_stopped_limit: string;
  ag_unsupported: string;
  // Audio overview (Feature 5).
  rd_audio: string;
  au_title: string;
  au_close: string;
  au_generating: string;
  au_needs_provider: string;
  bf_title: string;
  bf_desc: string;
  bf_waiting: string;
  bf_done: string;
  bf_skipped: string;
  bf_held: string;
  bf_promote: string;
  bf_promoted: string;
  bf_held_note: string;
  au_play: string;
  au_pause: string;
  au_stop: string;
  au_turns: string;
  au_open_transcript: string;
  au_no_tts: string;
  au_host: string;
  au_guest: string;
  au_play_from: string;
  // PDF viewer (Feature 6).
  pdf_page: string;
  pdf_close: string;
  pdf_loading: string;
  pdf_error: string;
  pdf_highlight_cite: string;
  // Ontology distillation (Task 8, Phase A) — Settings tab.
  s_distill: string;
  set_distill_loading: string;
  set_distill_lede: string;
  set_distill_enabled_title: string;
  set_distill_enabled_desc: string;
  set_distill_intensity: string;
  set_distill_intensity_conservative: string;
  set_distill_intensity_standard: string;
  set_distill_intensity_aggressive: string;
  set_distill_gate: string;
  set_distill_gate_strict: string;
  set_distill_gate_normal: string;
  set_distill_gate_loose: string;
  set_distill_count_trigger: string;
  set_distill_ttl: string;
  set_distill_budget: string;
  set_distill_idle_minutes: string;
  set_distill_maturation: string;
  // Phase B LLM-layer knobs (final-review Important 2).
  set_distill_llm_digest_days: string;
  set_distill_llm_ingest_budget: string;
  set_distill_profile_injection_title: string;
  set_distill_profile_injection_desc: string;
  set_distill_status_title: string;
  set_distill_backlog: string;
  set_distill_pending: string;
  set_distill_trend_shrinking: string;
  set_distill_trend_growing: string;
  set_distill_trend_flat: string;
  set_distill_run_now: string;
  set_distill_running: string;
  set_distill_report: string;
  set_distill_busy: string;
  set_distill_undo: string;
  set_distill_undoing: string;
  set_distill_undo_result: string;
  set_runs_title: string;
  // Defects C/D/E/G (2026-08 distill visibility fixes).
  set_distill_gate_pending: string; // {n} {min}
  set_distill_digest_extractive: string;
  set_distill_quarantined: string; // {n} {path}
  // Cooperative stop for the LLM chain (Stop button, Settings distill tab).
  set_distill_stop: string;
  set_distill_stopping: string;
  set_distill_stopped: string; // {step}
  set_distill_step_run: string;
  set_distill_step_digest: string;
  set_distill_step_ingest: string;
  set_distill_step_maps: string;
  set_distill_step_weekly: string;
  set_distill_step_monthly: string;
  set_distill_step_resurface: string;
  // ROADMAP P1 — weekly rollup count for the distill tab.
  set_distill_weekly_rollups: string;
  set_distill_monthly_rollups: string; // {n}
  // ROADMAP P2 — archive storage panel (sessions/ + daily/ archives only).
  set_archive_title: string;
  set_archive_lede: string;
  set_archive_measure: string;
  set_archive_measuring: string;
  set_archive_empty: string;
  set_archive_total: string; // {files} {size} {buckets}
  set_archive_tree_sessions: string;
  set_archive_tree_daily: string;
  set_archive_tree_weekly: string;
  set_archive_packed: string;
  set_archive_older_than: string; // {n}
  set_archive_compress: string;
  set_archive_compressing: string;
  set_archive_compressed: string; // {buckets} {files} {size}
  set_archive_nothing_old: string; // {n}
  set_archive_failed: string; // {list}
  set_archive_restore: string;
  set_archive_restoring: string;
  set_archive_restored: string; // {n} {bucket}
  // profile.md editor, in the Distill tab (Phase B, Task 5).
  set_profile_title: string;
  set_profile_lede: string;
  set_profile_role: string;
  set_profile_goals: string;
  set_profile_interests: string;
  set_profile_style: string;
  set_profile_save: string;
  set_profile_saving: string;
  set_profile_saved: string;
  // Feedback surface — sidebar badge, Overview card, proposal page (Task 9).
  nav_feedback: string;
  ov_distill_last_run: string; // {t}
  ov_distill_never: string;
  ov_distill_llm_queued: string;
  ov_distill_done: string; // {a} {d} {w} {p}
  ov_distill_done_months: string; // {m} — appended clause, only when > 0
  ov_distill_done_none: string;
  pf_title: string;
  pf_lede: string;
  pf_empty: string;
  pf_kind_admit: string;
  pf_kind_archive: string;
  pf_kind_delete: string;
  pf_kind_draft_map: string;
  pf_created: string;
  pf_expand: string;
  pf_collapse: string;
  pf_approve: string;
  pf_dismiss: string;
  pf_confirm_title: string;
  pf_confirm_msg: string; // {n}
  pf_confirm_msg_draft_map: string;
  pf_retry: string;
  pf_apply_failed: string;
  // Quarantine review tab (ROADMAP P0) — _inbox/quarantine/ items the
  // admission gate held back, with their verdict sidecar rendered as prose.
  pf_tab_proposals: string;
  pf_tab_quarantine: string; // {n}
  qz_empty: string;
  qz_lede: string;
  qz_verdict_offtopic: string; // {numbers}
  qz_verdict_sim: string; // {sim}
  qz_verdict_sim_vs: string; // {sim} {min}
  qz_verdict_nearest: string; // {topic}
  qz_verdict_unknown: string;
  qz_expires_in: string; // {n}
  qz_expires_due: string;
  qz_expires_unknown: string;
  qz_restore: string;
  qz_delete: string;
  qz_keep: string; // {n}
  qz_confirm_delete_title: string;
  qz_confirm_delete_msg: string; // {name}
  tb_activity_quarantine: string; // {n}
  tb_activity_gone: string;
  // Ingest page.
  ing_title_label: string;
  ing_title_ph: string;
  ing_working: string;
  // Deterministic ingest validator (Phase 1f) — optional; fall back to English.
  ingest_no_changes: string;
  ingest_validation_failed: string;
  ingest_validation_warnings: string;
  // Harvest queue (Overview → 수확대): the hero, the exclusion table, queue
  // rows, the plan gate, the completion toast and the empty state.
  hq_title: string; // {n} — rendered bold
  hq_lede: string; // {total} {distinct}
  hq_never_run: string;
  hq_progress: string; // {done} {left} {shown}
  hq_kpi_label: string;
  hq_harvest_btn: string; // {n}
  hq_select_all: string;
  hq_clear_all: string;
  hq_est_none: string; // {base}
  hq_est: string; // {n} {base} {goal}
  hq_excluded_line: string; // {n}
  hq_ex_col_reason: string;
  hq_ex_col_count: string;
  hq_ex_col_why: string;
  hq_ex_duplicate: string;
  hq_ex_duplicate_why: string;
  hq_ex_boilerplate: string;
  hq_ex_boilerplate_why: string;
  hq_ex_too_small: string;
  hq_ex_too_small_why: string;
  hq_ex_too_large: string;
  hq_ex_too_large_why: string;
  hq_ex_already_harvested: string;
  hq_ex_already_harvested_why: string;
  hq_ex_note: string;
  hq_row_select: string; // {name} — checkbox aria-label
  hq_near: string; // {score}
  hq_unclustered: string;
  hq_cites_plus: string; // {n}
  hq_preview: string;
  hq_collapse: string;
  hq_will_copy: string;
  hq_will_cluster: string;
  hq_will_cites: string;
  hq_wont: string; // {rel}
  hq_plan_title: string;
  hq_plan_sub: string; // {n} {kb}
  hq_plan_copy: string; // {n}
  hq_plan_pass: string;
  hq_plan_cites: string; // {base} {goal} {n}
  hq_plan_note: string;
  hq_plan_cancel: string;
  hq_plan_run: string;
  hq_plan_running: string; // {done} {total}
  hq_done_title: string; // {n}
  hq_done_sub: string; // {base} {goal}
  hq_done_partial: string; // {copied} {ingested}
  hq_failed: string;
  hq_empty_title: string;
  hq_empty_body: string; // {distinct}
  hq_empty_cta: string;
  hq_loading: string;
  hq_error: string;
  hq_retry: string;
  // Judgement stage (Ingest): a refused source is one toast, not a file.
  ing_refused_title: string; // {reason}
  ing_logged_title: string; // {reason}
  ing_noop_reason: string;
  ing_gate_none_reason: string;
  // Sieve (Ingest page): the 5-step rail, the judgement tile, verdict rows,
  // the exclusion line, intake channels, the backfill panel.
  sv_rail_label: string;
  sv_step_intake: string;
  sv_step_judge: string;
  sv_step_gate: string;
  sv_step_run: string;
  sv_step_backfill: string;
  sv_today_n: string; // {n}
  sv_tally: string; // {d} {l} {h}
  sv_waiting: string;
  sv_reviewing: string;
  sv_idle: string;
  sv_running: string;
  sv_done: string;
  sv_failed: string;
  sv_queue_n: string; // {n}
  sv_judge_eyebrow: string;
  sv_judge_title: string;
  sv_judge_lede: string;
  sv_meta_session: string; // {n}
  sv_meta_saved: string; // {n}
  sv_drop: string;
  sv_drop_sub: string;
  sv_log: string;
  sv_log_sub: string;
  sv_harvest: string;
  sv_harvest_sub: string;
  sv_dz_sub: string;
  sv_verdicts_title: string;
  sv_verdicts_empty: string;
  sv_out_drop: string;
  sv_out_noop: string;
  sv_out_log: string;
  sv_out_harvest: string;
  sv_excl_line: string; // {n}
  sv_excl_none: string;
  sv_excl_col_rule: string;
  sv_excl_col_count: string;
  sv_excl_col_last: string;
  sv_channels: string;
  sv_ch_sessions: string;
  sv_ch_clipper: string;
  sv_ch_mcp: string;
  sv_ch_zotero: string;
  sv_ch_inbox: string;
  sv_ch_manual: string;
  sv_bf_eyebrow: string;
  sv_bf_eligible: string;
  sv_bf_eligible_sub: string;
  sv_bf_total: string;
  sv_bf_distinct: string;
  sv_bf_batch_label: string;
  sv_bf_cost: string; // {calls} {n}
  sv_bf_skipped: string; // {n}
  // Query page.
  q_via: string;
  q_via_retrieval: string;
  q_builtin_note: string;
  q_builtin_extractive_note: string;
  q_open_model_settings: string;
  q_stale_index: string;
  q_retrieval_failed: string;
  q_extractive_label: string;
  q_extractive_empty: string;
  q_extractive_stale: string;
  q_extractive_failed: string;
  // Time-aware Ask (Q4 item 8): parsed-period chip + range-scoped empty copy.
  q_range_chip: string;
  q_range_empty: string;
  // Per-citation confidence band + source tier chips (ROADMAP P1).
  q_cite_conf_high: string;
  q_cite_conf_medium: string;
  q_cite_conf_low: string;
  q_cite_conf_lexical: string;
  q_cite_conf_tip: string;
  q_cite_conf_lexical_tip: string;
  q_cite_tier_note: string;
  q_cite_tier_map: string;
  q_cite_tier_digest: string;
  q_cite_tier_rollup: string;
  q_cite_tier_monthly: string;
  q_cite_tier_session: string;
  q_cite_tier_source: string;
  q_cite_list_label: string;
  q_uncited_row: string; // {n}
  // "Set up your profile" hint chip, Ask mode (Phase B, Task 5).
  ask_profile_hint: string;
  ask_profile_hint_cta: string;
  ask_profile_hint_dismiss: string;
  q_chip_done: string;
  q_chip_error: string;
  q_you: string;
  q_miss_btn: string;
  // Ask renewal (mockup "Strata"): scope segment, retrieval stepper, source
  // ladder with tier priors, abstention card, archived-session opt-in.
  q_scope_label: string;
  q_scope_wiki: string;
  q_scope_sessions: string;
  q_scope_all: string;
  q_scope_help: string;
  q_scope_chip: string; // {scope}
  q_trace_title: string;
  q_trace_toggle: string;
  q_trace_candidates: string;
  q_trace_candidates_sub: string;
  q_trace_bm25: string;
  q_trace_bm25_sub: string;
  q_trace_dense: string;
  q_trace_dense_sub: string;
  q_trace_rrf: string;
  q_trace_rrf_sub: string;
  q_trace_cap: string;
  q_trace_cap_sub: string; // {k}
  q_trace_floor: string;
  q_trace_floor_sub: string; // {floor}
  q_trace_cold: string;
  q_trace_cold_on: string;
  q_trace_cold_off: string;
  q_trace_cold_on_sub: string;
  q_trace_cold_off_sub: string;
  q_trace_params: string; // {floor}
  q_cite_aria: string; // {n} {stem} {sim} {tier}
  q_cite_sim_none: string;
  q_ladder_title: string;
  q_ladder_hint: string;
  q_ladder_count: string; // {n} {c}
  q_ladder_lead_same: string;
  q_ladder_lead_moved: string; // {stem} {tier} {before} {after}
  q_ladder_up: string; // {n}
  q_ladder_down: string; // {n}
  q_ladder_same: string;
  q_ladder_archived: string;
  q_ladder_sr: string;
  q_prior_advanced: string;
  q_prior_title: string;
  q_prior_formula: string;
  q_prior_app: string;
  q_prior_defaults: string;
  q_prior_next: string;
  q_prior_slider: string; // {tier}
  q_abstain_title: string;
  q_abstain_sub: string; // {q} {n} {floor}
  q_abstain_near: string;
  q_abstain_none: string;
  q_abstain_lexical: string;
  q_abstain_gauge_note: string; // {floor}
  q_abstain_floor_tick: string; // {floor}
  q_abstain_harvest: string;
  q_abstain_harvested: string;
  q_abstain_widen: string;
  q_abstain_foot: string;
  q_abstain_receipt: string;
  s_archived_sessions_title: string;
  s_archived_sessions_desc: string;
  // Sidebar.
  sb_new_note: string;
  sb_new_folder: string;
  sb_rename: string;
  sb_today_note: string;
  sb_new_note_msg: string;
  sb_new_note_ph: string;
  sb_delete_folder_q: string;
  sb_delete_file_q: string;
  sb_favorites: string;
  sb_recent: string;
  sb_fav_add: string;
  sb_fav_remove: string;
  sb_move_to: string;
  sb_move_title: string;
  sb_move_root: string;
  sb_delete_n: string;
  sb_delete_n_q: string;
  sb_delete_msg: string;
  sb_delete_one_msg: string;
  sb_selected: string;
  sb_clear_selection: string;
  sb_new_folder_msg: string;
  sb_rename_msg: string;
  sb_empty_vault: string;
  sb_no_vault: string;
  // Command bar.
  cb_no_results: string;
  cb_tag_page: string;
  cb_tag_file: string;
  cb_tag_action: string;
  cb_in_contents: string;
  cb_semantic: string;
  cb_exact: string;
  cb_operator_hint: string;
  cb_miss_hint: string;
  cb_miss_done: string;
  // Stipe shell (W4-B): sidebar badges, ⌘K lenses, status strip, settings shell.
  sb_harvest_badge: string;
  sb_proposals_badge: string;
  cb_tag_lens: string;
  sb_status: string;
  sb_st_vault: string;
  sb_st_index: string;
  sb_st_model: string;
  sb_st_on: string;
  sb_st_off: string;
  sb_st_mcp_down: string;
  sb_st_lagging: string;
  sb_st_simulate: string;
  s_val_on: string;
  s_val_off: string;
  s_changed_only: string;
  s_search_clear: string;
  s_show_all: string;
  s_total_count: string;
  // Topbar.
  tb_lint: string;
  tb_toggle_sidebar: string;
  tb_back: string;
  tb_forward: string;
  tb_model_picker: string;
  tb_model_ready: string;
  tb_model_offline: string;
  tb_model_open_settings: string;
  // Topbar activity chip + popover.
  tb_activity_label: string;
  tb_activity_n: string; // {n}
  tb_activity_running: string;
  tb_activity_links: string; // {n}
  tb_activity_reflect: string; // {n}
  tb_activity_applying: string;
  tb_activity_mcp_on: string;
  tb_activity_mcp_off: string;
  tb_activity_tasks: string;
  tb_activity_tasks_more: string; // {n}
  // Pending map proposals, approvable straight from the activity surfaces.
  tb_activity_map_notes: string; // {n}
  tb_activity_map_wait: string;
  // "Today's inflow" section (activity popover + tray panel + native menu).
  tb_inflow_header: string;
  tb_inflow_sessions: string;
  tb_inflow_last_sweep: string; // {t}
  tb_inflow_auto: string; // {m}
  tb_inflow_mcp: string;
  tb_inflow_mcp_count: string; // {n}
  tb_inflow_mcp_top: string; // {tool}
  tb_inflow_since_launch: string;
  tb_inflow_inbox: string;
  /** Bucket label for an _inbox file whose frontmatter names no source. */
  tb_inflow_source_unknown: string;
  tb_inflow_view: string;
  tb_inflow_spark_caption: string;
  tb_inflow_summary: string; // {s} {m} {i}
  // Menu bar tray + OS notifications.
  tray_open: string;
  tray_quit: string;
  s_tray_resident_title: string;
  s_tray_resident_desc: string;
  // Global-shortcut spotlight (the ask-from-anywhere window) + its Settings row.
  spot_placeholder: string;
  spot_thinking: string;
  spot_hint_enter: string;
  spot_hint_open: string;
  spot_no_vault: string;
  spot_busy: string;
  // Spotlight voice quick-capture (W3–6 item 9).
  voice_btn_label: string;
  voice_hint_recording: string;
  voice_saved_chip: string; // {rel}
  voice_whisper_missing: string;
  voice_model_progress: string;
  voice_transcribe_progress: string; // {pct}
  voice_mic_denied: string;
  voice_no_input: string;
  voice_stage_transcribing: string;
  voice_stage_saving: string;
  s_spot_title: string;
  s_spot_desc: string;
  s_spot_record: string;
  s_spot_recording: string;
  s_spot_disable: string;
  s_spot_ok: string; // {k}
  s_spot_failed: string; // {k}
  s_spot_off: string;
  notif_distill_done_title: string;
  notif_distill_done_body: string; // {p} {d} {w}
  notif_distill_done_months: string; // {m} — appended clause, only when > 0
  notif_quarantine_title: string;
  notif_quarantine_body: string; // {n}
  // Graph toolbar.
  // Overview / History empty states.
  h_open_vault: string;
  // Reflect suggestions panel (FEAT-06).
  rf_title: string;
  rf_lede: string;
  rf_run: string;
  rf_running: string;
  /** Names reflect in the activity surfaces (topbar chip, tray) — rf_running
   *  alone ("분석 중…") does not say WHAT is analysing. */
  rf_running_label: string;
  /** Completion line on the panel, like the distill card's outcome line. */
  rf_done: string; // {n}
  rf_empty: string;
  rf_extractive: string;
  // Extractive reflect's two mechanical findings. Written by reflectStore (not
  // a model), so unlike LLM output they must speak the UI's language. {page}
  // is a vault-relative path, {target} an unresolved [[wikilink]] name.
  rf_item_orphan: string; // {page}
  rf_item_unresolved: string; // {page} {target}
  // Applying reflect findings. Only unresolved links are applyable (the page
  // gets created); an orphan can only be opened, since where to link it from is
  // judgment no rule supplies.
  rf_create_missing: string;
  rf_create_progress: string; // {done} {total}
  rf_create_result: string; // {n}
  rf_create_failed: string; // {target}
  rf_create_one: string;
  rf_open_page: string;
  rf_ignore_one: string;
  // First-run onboarding wizard (UX-01) — optional; components fall back to EN.
  ob_title: string;
  ob_skip: string;
  ob_back: string;
  ob_next: string;
  ob_finish: string;
  ob_vault_linked: string;
  ob_vault_none: string;
  ob_s1_title: string;
  ob_s1_body: string;
  ob_s1_action: string;
  ob_sovereignty: string;
  ob_s2_title: string;
  ob_s2_body: string;
  ob_s2_action: string;
  ob_s3_title: string;
  ob_s3_body: string;
  ob_s3_action: string;
  ob_demo_start: string;
  ob_seed_offer: string;
  ob_seed_do: string;
  ob_indexing_local: string;
  ob_s2_progress: string; // {done} {total}
  ob_s2_indexed: string; // {n}
  ob_s2_failed: string;
  ob_first_question: string;
  ob_first_question_sessions: string;
  ob_ask_now: string;
  // Import-first onboarding (steps 1 and 3 of the 5-step wizard).
  ob_imp_title: string;
  ob_imp_body: string;
  ob_imp_claude: string;
  ob_imp_codex: string;
  ob_imp_progress: string; // {done} {total}
  ob_imp_done: string; // {n}
  ob_imp_quarantined: string; // {n}
  ob_imp_skip_hint: string;
  ob_hist_title: string;
  ob_hist_already: string;
  ob_hist_skip_hint: string;
  // Budget guard (OPS-03) — optional; components fall back to English.
  s_budget_title: string;
  s_budget_desc: string;
  s_budget_threshold: string;
  s_budget_usage: string;
  s_budget_total: string;
  s_budget_empty: string;
  // Auto-reflect (FEAT-06) — optional; components fall back to English.
  s_autoreflect_title: string;
  s_autoreflect_desc: string;
  s_autoreflect_interval: string;
  // Independent Obsidian vault (MP-10) — optional; fall back to English.
  s_vault_register: string;
  s_vault_registered: string;
  // Provider blurbs (Task 2) — optional; fall back to the English `desc:`.
  s_provider_desc_anthropic_cli: string;
  s_provider_desc_gemini_cli: string;
  s_provider_desc_codex_cli: string;
  s_provider_desc_anthropic_api: string;
  s_provider_desc_openai_api: string;
  s_provider_desc_google_api: string;
  s_provider_desc_builtin_local: string;
  s_provider_desc_ollama: string;
  s_provider_desc_openrouter: string;
  s_provider_desc_myco_pro: string;
  // Vault git history (Q4 item 1) — optional; fall back to English.
  vh_banner_title: string;
  vh_banner_desc: string;
  vh_enable: string;
  vh_later: string;
  vh_setting_title: string;
  vh_setting_desc: string;
  // Redaction PII mode (Q4 item 13, mockup M8-b) — optional; fall back to English.
  set_pii_title: string;
  set_pii_desc: string;
  set_pii_warn: string;
  set_pii_quarantine: string;
  // Retro raw/ audit (Q4 item 14, mockup M8-c) — optional; fall back to English.
  set_audit_title: string;
  set_audit_rescan: string;
  set_audit_clean: string; // {n} {m}
  set_audit_history_only: string;
  set_audit_note: string;
  // Morning-Report band (Q4 item 2) — optional; fall back to English.
  ov_since_eyebrow: string;
  ov_since_title: string; // {runs} {pages}
  ov_since_quiet: string;
  ov_suspect_title: string;
  ov_suspect_clean: string;
  ov_view_runs: string;
  // Contradiction queue (Q4 item 15) — optional; fall back to English.
  contra_title: string;
  contra_disputed: string;
  contra_stale: string; // {t}
  contra_mark_active: string;
  contra_mark_superseded: string;
  contra_open_page: string;
  contra_open_target: string;
  contra_ignore: string;
  contra_clean: string;
  // Resurface rows + daily ritual card (Q4 items 10–11) — optional; fall back
  // to English.
  rs_header: string;
  rs_open: string;
  rs_snooze: string;
  rs_ignore: string;
  rs_similarity: string; // {s}
  rs_last_open: string; // {t}
  rs_floor_note: string; // {f}
  ritual_title: string;
  ritual_due: string; // {n}
  ritual_start: string;
  // Run drill-in on History (W3–6 item 6).
  history_runs_title: string;
  history_run_open_why: string;
  history_no_commit: string;
  history_diff_too_large: string;
  history_status_added: string;
  history_status_modified: string;
  history_status_renamed: string;
  history_status_deleted: string;
  // Authorship badge + human-only sidebar filter (Q4 item 16).
  auth_badge_human: string; // {h} {a}
  auth_badge_last_human: string; // {t}
  auth_filter_pill: string;
  // Agent write-confirm diff (W3–6 item 7).
  agent_confirm_title: string;
  agent_confirm_create_title: string;
  agent_confirm_hint: string;
  // Menu-bar notch surface (components/NotchPanel.tsx), design sheet S1–S10.
  // Chrome only — filenames, progress detail and result summaries arrive as
  // data, already translated by whoever produced them.
  notch_peek: string;
  notch_peek_body: string;
  notch_drop: string;
  notch_accepted: string;
  notch_accepted_next: string;
  notch_accepted_next_sub: string;
  notch_running: string; // {t}
  notch_running_read: string;
  notch_running_pages: string;
  notch_done: string;
  notch_done_open: string;
  notch_done_collapse: string;
  notch_capture: string;
  notch_capture_save: string;
  notch_capture_voice: string;
  notch_capture_saved: string;
  notch_recording: string; // {t}
  // Peek's two one-click actions, and the recording card's own chrome: the
  // silent-mic lip, the 800 ms cancelled beat, and the two key hints, which
  // are BUTTONS now (the notch panel is non-activating — a hint the mouse
  // cannot press leaves an esc-less surface if key focus was refused).
  notch_rec: string;
  notch_note: string;
  notch_cancelled: string;
  notch_no_sound: string;
  notch_hint_cancel: string;
  notch_hint_save: string;
  notch_rejected: string;
  notch_rejected_body: string; // {ext}
  notch_rejected_accepts: string;
  notch_rejected_list: string;
  notch_unsupported: string; // {ext} — notchDrop's unsupported-drop reason
  notch_write_failed: string;
  // Settings toggle for the notch surface (macOS).
  s_notch_title: string;
  s_notch_desc: string;
}

export const STRINGS: Record<Lang, Strings> = {
  en: {
    app_name: "myco",
    quick_search: "Search or jump to…",
    quick_ask: "Ask the wiki",
    nav_workspace: "Workspace",
    nav_pages: "Pages",
    nav_tools: "Tools",
    nav_overview: "Today",
    nav_ingest: "Ingest",
    nav_query: "Ask",
    nav_graph: "Graph",
    db_empty: "Nothing to chart yet.",
    bd_title: "My board",
    bd_range: "Range",
    bd_range_all: "All",
    bd_edit: "Edit board",
    bd_done: "Done",
    bd_add: "Add widget",
    bd_custom: "Custom question…",
    bd_text: "Text (markdown)",
    bd_heading: "Heading",
    bd_compact: "Layout",
    bd_compact_v: "Pack upward",
    bd_compact_none: "Keep whitespace",
    bd_empty: "Add your first chart — MCP inflow, tags, tasks…",
    bd_drag: "Drag",
    bd_configure: "Configure",
    bd_duplicate: "Duplicate",
    bd_field_title: "Title",
    bd_field_source: "Source",
    bd_field_group: "Group by",
    bd_field_filter: "Filter",
    bd_field_view: "View",
    bd_field_time: "Range",
    bd_field_rule: "Color rule",
    bd_filter_none: "None",
    bd_time_auto: "Auto (board)",
    bd_rule_risk: "red",
    bd_rule_ok: "green",
    bd_src_inflow: "Inflow",
    bd_src_notes: "Notes",
    bd_src_tasks: "Tasks",
    bd_preset_mcp_daily: "MCP inflow by day",
    bd_preset_channels_daily: "Inflow by channel (stacked)",
    bd_preset_notes_by_type: "Notes by type",
    bd_preset_top_tags: "Top tags",
    bd_preset_edits_daily: "Edits per day",
    bd_preset_tasks_by_status: "Tasks by status",
    bd_preset_unsourced_stat: "Unsourced pages (stat)",
    bd_g_day: "By day",
    bd_g_channel: "By channel",
    bd_g_type: "By type",
    bd_g_confidence: "By confidence",
    bd_g_status: "By status",
    bd_g_tag: "By tag",
    bd_v_bar: "Bars",
    bd_v_line: "Line",
    bd_v_hbar: "Rows",
    bd_v_stat: "Number",
    bd_v_table: "Table",
    bd_hide_zero: "Hide when zero",
    bd_json_form: "Form",
    bd_json_bad: "Not valid JSON — fix it or switch back to the form.",
    bd_unknown: "Unknown widget type “{kind}” — kept as saved.",
    bd_field_color: "Color",
    bd_color_default: "Default",
    bd_color_blue: "Blue",
    bd_color_green: "Green",
    bd_color_purple: "Purple",
    bd_color_amber: "Amber",
    bd_color_cyan: "Cyan",
    bd_color_red: "Red",
    bd_detail_total: "Total {n}",
    bd_board_pick: "Board",
    bd_new_board: "New board",
    bd_new_board_prompt: "Board name:",
    bd_delete_board: "Delete board",
    bd_delete_confirm: "Delete board “{name}”?",
    ls_title: "Suggested links",
    ls_hint:
      "Semantically close notes that aren't linked yet. Accept to add a [[wikilink]] under \u201c## Related\u201d.",
    ls_accept: "Link them",
    ls_dismiss: "Dismiss",
    ls_accept_all: "Accept all",
    ls_linking: "Linking…",
    ls_toast_linked: "{n} links added",
    ls_toast_linked_sub: "[[wikilink]] under ## Related",
    ls_toast_failed: "Couldn't add the links",
    ls_toast_retry: "Retry",
    zi_title: "Import from Zotero",
    zi_hint:
      "CSL-JSON or BibTeX export (highlights come along when present). Items land in _inbox/ as source docs for the ingest pipeline.",
    zi_none: "No importable items found in that file.",
    zi_done:
      "Imported {n} item(s) into _inbox/ — run Ingest to turn them into wiki pages.",
    ci_title: "Import a conversation",
    ci_hint:
      "A ChatGPT export (conversations.json) or a Claude Code / Codex session (.jsonl). Each conversation lands in _inbox/ as a source doc for the ingest pipeline.",
    ci_btn: "Choose a file…",
    ci_busy: "Importing…",
    ci_done:
      "Imported {n} conversation(s) into _inbox/ — run Ingest to turn them into wiki pages.",
    ci_quarantined:
      "{n} conversation(s) were held back because they contain what looks like a secret (API key, token). Review them at the source; they were not imported.",
    ci_none: "No conversations found in that file.",
    ci_skipped: " ({n} already imported, skipped.)",
    ci_sweep_cc: "Import my Claude Code sessions",
    ci_sweep_cx: "Import my Codex sessions",
    ci_sweep_hint:
      "Or import every session already on this machine — from ~/.claude and ~/.codex. Re-running only adds new and grown sessions.",
    ci_sweep_progress: "Importing session {done} of {total}",
    ci_sweep_tally: "imported {i} · skipped {s} · {f} failed",
    ci_failed_summary: "{n} couldn’t be imported",
    ci_retry_failed: "Retry failed ({n})",
    q_empty: "Ask the wiki anything — answers cite your own pages.",
    s_mascot: "Show MYCO, the mascot",
    s_mascot_hint:
      "Loaders, empty states and the About page. Off = static logo.",
    s_backup_title: "Settings & looks",
    s_backup_hint:
      "Providers, automation, appearance and graph looks travel with this file. API keys, the vault path and this device's identity never do.",
    s_backup_export: "Export…",
    s_backup_import: "Import…",
    s_backup_busy: "Working…",
    s_backup_exported: "Settings exported.",
    s_backup_imported: "Restored: {sections}",
    s_backup_import_failed: "Import failed: {error}",
    s_backup_bad_json: "That file isn't valid JSON.",
    s_backup_section_settings: "app settings",
    s_backup_section_ui: "appearance",
    s_backup_section_graph: "graph look",
    s_backup_section_savedLooks: "saved graph looks",
    s_backup_section_queryViews: "saved views",
    s_backup_section_dismissedLinkSuggestions: "dismissed link suggestions",
    s_backup_section_reflectIgnored: "reflect ignored items",
    s_backup_section_budgetThresholdUsd: "budget alert threshold",
    s_backup_confirm_title: "Replace these settings?",
    s_backup_confirm_body:
      "This file replaces: {sections}. Everything it replaces is kept in memory, so you can undo it until you quit myco.",
    s_backup_confirm_none:
      "This file carries no settings this version can restore — importing it would change nothing.",
    s_backup_confirm_apply: "Replace",
    s_backup_confirm_cancel: "Cancel",
    s_backup_undo: "Undo import",
    s_backup_undo_hint:
      "Your previous settings are held in memory until you quit myco.",
    s_backup_undone: "Put back: {sections}",
    hw_title: "Help",
    hw_sub: "Tips for this page",
    hw_sc_cmd: "Command palette",
    hw_sc_sidebar: "Toggle sidebar",
    hw_sc_fly: "Fly mode (graph)",
    hw_sc_esc: "Close / deselect",
    hw_sc_new: "New note",
    hw_sc_spotlight: "Ask from anywhere",
    hw_sc_voice: "Voice capture (Spotlight / notch)",
    hw_sc_miss: "Log a search that missed",
    hw_sc_path: "Shortest path between two notes (graph)",
    hw_sc_live_link: "Open the wikilink under the pointer (Live editor)",
    hw_sc_back: "Back",
    hw_sc_fwd: "Forward",
    hw_tip_graph1: "Pick a question — the encoding changes, the layout does not.",
    hw_tip_graph2:
      "The gaps column is the answer list: open, draft a link, or send it to harvest.",
    hw_tip_graph3:
      "Hide the sample vault to see only the notes you wrote.",
    hw_tip_query1: "Answers cite wiki pages — click a citation to open it.",
    hw_tip_query2:
      "The graph's gap panel can draft research questions into this box.",
    hw_tip_ingest1: "Drop any file, paste text, or import a Zotero export.",
    hw_tip_ingest2:
      "The web clipper sends pages here through _inbox/ (see clipper/).",
    hw_tip_overview1:
      "Suggested links are semantic pairs with no wikilink yet — accept or dismiss.",
    hw_tip_default: "⌘K jumps anywhere — pages, actions, semantic hits.",
    vw_lens_unsourced: "No sources",
    vw_lens_orphans: "Orphans",
    vw_lens_disputed: "Disputed",
    vw_lens_recent: "Recently changed",
    tpl_new_from: "New note from template…",
    tpl_pick_title: "Choose a template",
    tpl_pick_msg:
      "Templates are plain .md files in templates/ in your vault. {{date}}, {{time}} and {{title}} are filled in.",
    tpl_empty:
      "No templates yet. Create templates/ with two starters (note, meeting) you can edit.",
    tpl_create_starters: "Create templates folder",
    tpl_creating: "Creating…",
    tpl_create_error: "Could not create templates: {err}",
    tpl_note_error: "Could not create the note from the template: {err}",
    tpl_starter_note: "note",
    tpl_starter_meeting: "meeting",
    tpl_starter_note_body: "## Summary\n\n## Details\n\n## Sources\n",
    tpl_starter_meeting_body:
      "> {{date}} {{time}}\n\n## Attendees\n\n## Agenda\n\n## Notes\n\n## Action items\n\n- [ ] \n",
    nav_history: "History",
    nav_provenance: "Provenance",
    nav_tasks: "Tasks",
    tasks_title: "Tasks",
    tasks_lede: "Every checkbox item across your notes, gathered in one place.",
    tasks_loading: "Scanning notes…",
    tasks_empty: "No tasks yet",
    tasks_empty_hint:
      "Add a `- [ ] …` checkbox to any note and it will show up here.",
    tasks_ph: "What do you have to do?",
    tasks_due: "Due date",
    tasks_add: "Add",
    tasks_stale:
      "That note changed since the list was built, so it has been refreshed. Try again.",
    tasks_view: "View",
    tasks_view_list: "List",
    tasks_view_board: "Board",
    tasks_col_todo: "To do",
    tasks_col_doing: "In progress",
    tasks_col_blocked: "Blocked",
    tasks_col_done: "Done",
    tasks_notify:
      "Notify me about due tasks — a morning digest, plus a reminder for tasks that name a time",
    tasks_view_calendar: "Calendar",
    tasks_cal_today: "Today",
    tasks_cal_undated: "No due date ({n})",
    tasks_detail: "Task",
    tasks_detail_close: "Close",
    tasks_detail_status: "Status",
    tasks_detail_start: "Start",
    tasks_detail_scheduled: "Scheduled",
    tasks_detail_priority: "Priority",
    tasks_detail_priority_none: "None",
    tasks_detail_estimate: "Estimate",
    tasks_detail_estimate_hint: "Use a duration like 90m, 1.5h, 2d or 1w.",
    tasks_detail_recur: "Repeat",
    tasks_detail_notes: "Notes",
    tasks_detail_notes_ph: "Details, links, context…",
    tasks_detail_recur_hint:
      "myco schedules \u201cevery day/week/month/year\u201d and \u201cevery 2 weeks\u201d. Any other rule stays in your note, untouched.",
    tasks_detail_start_after_due:
      "The start is after the due date, so this task shows on its due day. Your dates are left exactly as written.",
    tasks_detail_open_note: "Open {page}",
    tasks_hub: "Update month pages",
    tasks_hub_heading: "{month} schedule",
    tasks_hub_empty: "_Nothing scheduled this month._",
    tasks_hub_written: "Updated {n} month page(s).",
    tasks_hub_kept: "Left {n} page(s) alone — you have taken them over.",
    tasks_compose_more: "Details",
    tasks_compose_category: "Category",
    tasks_compose_project: "Project",
    tasks_compose_target: "Add to",
    tasks_compose_daily: "Today's daily note",
    tasks_new_roadmap: "＋ New roadmap…",
    tasks_new_roadmap_ph: "Roadmap title",
    tasks_view_roadmap: "Roadmap",
    tasks_roadmap_empty: "No roadmaps yet",
    tasks_roadmap_empty_hint:
      "A roadmap is a wiki page (wiki/roadmaps/…) of milestones and checkboxes — create one and its items show up across Tasks.",
    tasks_roadmap_progress: "{done}/{total} done",
    tray_sub_waiting_n: "{n} waiting for you",
    tray_sub_clear: "Nothing waiting",
    tray_sub_distilling: "Distilling · {step}",
    tray_now_eyebrow: "Awaiting approval",
    tray_toast_approved: "{name} approved",
    tray_tile_waiting: "Waiting",
    tray_tile_today: "Today",
    tray_row_links: "Suggested links",
    tray_row_reflect: "Reflect suggestions",
    tray_row_sessions: "Sessions · inbox",
    tray_card_tasks_v: "{n} today",
    tray_card_tasks_sub: "{n} overdue",
    tray_last24: "Last 24 hours",
    tray_legend_hourly: "by hour",
    dp_prev: "Previous month",
    dp_next: "Next month",
    dp_clear: "Clear date",
    tasks_open_n: "{n} open",
    tasks_done_n: "{n} done",
    tasks_all_done: "All caught up — nothing open.",
    tasks_completed: "Completed ({n})",
    nav_study: "Study",
    nav_settings: "Settings",
    split_open: "Split view",
    split_close: "Close split view",
    split_pick: "Second pane",
    split_resize: "Resize panes",
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
      "myco turns every paper, article and note you ingest into a cross-linked, fully-cited knowledge graph — kept in plain markdown so you stay in control.",
    ov_cta_ingest: "Ingest a source",
    ov_cta_ask: "Ask the wiki",
    ov_stats_pages: "Pages",
    ov_stats_links: "Links",
    ov_stats_ratio: "Wiki-only answers",
    ov_quick: "Jump back in",
    ov_stats_moved: "moved this week",
    ov_moved_none: "Nothing written in the last 7 days",
    ov_pulse_alt: "{pages} pages, {links} links, {moved} touched this week",
    ov_recent_moved: "Recently moved",
    ov_recent_never: "No notes have changed yet.",
    ing_title: "Ingest",
    ing_lede:
      "Drop a file, paste a URL, or write a note. myco will route it through Claude, extract entities and concepts, write a source page, and weave it into the graph.",
    ing_drop: "Drop a file here",
    ing_drop_or: "or paste a URL",
    ing_browse: "Browse files…",
    ing_drop_multi:
      "Loaded the first of {n} files — this form takes one source at a time. Drop the rest one by one.",
    ing_inbox_pending: "Waiting in _inbox ({n})",
    ing_inbox_empty: "Nothing waiting — arrivals have already been ingested.",
    ing_inbox_today: "today",
    ing_inbox_unsupported_chip: "unsupported",
    ing_inbox_unsupported_line: "{n} unsupported — left in place.",
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
    ing_live_earlier: "…{n} earlier",
    ing_live_files: "Pages touched",
    ing_live_reads: "read",
    ing_live_writes: "written",
    ing_grounded: "Matched {n} existing page(s) to update",
    ing_grounded_hint:
      "The source was steered to these pages so it updates them instead of duplicating.",
    ing_plan: "Ingest plan ({n})",
    ing_plan_hint:
      "What the source will change — the agent follows this, updating existing pages instead of duplicating.",
    ingest_gate_title: "Ingest plan — choose what to apply",
    ingest_gate_apply: "Apply {n} selected",
    ingest_gate_all: "Everything as planned",
    ingest_gate_noop_hint:
      "NOOP items are already covered by the wiki — unchecked by default.",
    ing_cancel: "Cancel",
    ing_cancelled: "Ingest cancelled",
    ing_preview_open: "Open page",
    ing_preview_close: "Close preview",
    ing_preview_writing: "Still being written — try again in a moment.",
    ing_chip_done: "Ingest done",
    ing_chip_error: "Ingest failed",
    q_title: "Ask the wiki",
    q_lede:
      "myco answers from your wiki first, then reaches into raw sources only when needed. Every claim ships with a citation.",
    q_ph: "What is BPE? How does midtraining differ from finetuning?",
    q_send: "Ask",
    q_recent: "Recent questions",
    q_answer: "Answer",
    q_sources_used: "Sources used",
    q_wiki: "wiki",
    q_raw: "raw",
    gr_node_count: "nodes",
    gr_edge_count: "links",
    gr_all: "all",
    gr_layout_spiral: "Spiral galaxy",
    gr_layout_strata: "Chronicle",
    gr_layout_semantic: "Semantic map",
    gr_layout_celestial: "Celestial sphere",
    gr_layout_radial: "Radial orbit",
    gr_layout_walrus: "Walrus tree",
    mc_label: "MYCO tip",
    mc_dismiss: "Dismiss",
    gr_layout_galaxy_s: "Galaxy",
    gr_layout_synapse3d_s: "Synapse",
    gr_layout_atlas_s: "Atlas",
    gr_open: "Open page",
    gr_empty_pre: "No wikilinks found in the vault yet. Add some ",
    gr_empty_post: " to see the graph grow.",
    gr_insp_type: "Type",
    gr_insp_confidence: "Confidence",
    gr_insp_status: "Status",
    gr_insp_links_out: "Links",
    gr_insp_backlinks: "Backlinks",
    gr_insp_open: "Open in reader",
    gr_insp_unresolved: "Unresolved note (no file yet)",
    gr_insp_none: "—",
    gr_find_ph: "Find a note…",
    gr_gaps_title: "Gaps",
    gr_gap_missing: "Missing pages",
    gr_gap_orphans: "Orphans",
    gr_gap_undercited: "Under-cited",
    gr_gap_lowconf: "Low confidence",
    gr_gap_islands: "Disconnected",
    gr_gap_none: "No gaps found",
    gr_gap_more: "more",
    q_thinking: "searching the wiki…",
    q_answering: "answering…",
    q_answering_from: "answering from {n} pages…",
    gr_loading: "aligning constellations…",
    gr_title: "Survey",
    gr_lede: "One map, four questions. Picking a question changes the encoding — colour, size, dimming — never the layout, so the answers stay comparable.",
    gr_canvas_aria: "Vault link map. Arrow keys move the selection, Enter opens the note.",
    gr_stage_hint: "One layout · a question changes the encoding only",
    gr_q_lead: "What this screen answers",
    gr_q_orphans: "Where is it empty",
    gr_q_orphans_u: "gaps",
    gr_q_sub_orphans: "orphans {orphans} · unresolved {unresolved} · no backlink {nobacklink}",
    gr_q_clusters: "What clumps together",
    gr_q_clusters_u: "clusters",
    gr_q_sub_clusters: "{nomap} without a map page · {map} with one",
    gr_q_time: "What grew lately",
    gr_q_time_u: "in 30 days",
    gr_q_sub_time: "the {sample} sample notes are frozen at install time",
    gr_q_neighbors: "This note's neighbours",
    gr_q_neighbors_u: "2 hops",
    gr_q_sub_neighbors: "2 hops from the selected note",
    gr_q_pick: "Pick a note first",
    gr_size: "Node size",
    gr_size_backlinks: "size = backlinks",
    gr_size_cites: "size = citations",
    gr_hide_sample: "Hide the {n} sample notes",
    gr_show_unresolved: "Show unresolved links",
    gr_rebuilds: "scene rebuilds {n} · {ms} ms",
    gr_honest_lead: "This graph draws {n} nodes",
    gr_honest: "first-run sample {sample} ({pct}%) · your own notes {own} · unresolved {unresolved}. Notes carrying a citation: {cited}.",
    gr_honest_sessions: "{n} session transcripts are NOT here — sessions/ is excluded by graphData's NON_KNOWLEDGE_FOLDERS.",
    gr_gap_nobacklink: "Nobody links here",
    gr_act_link: "Suggest links",
    gr_act_harvest: "Mark as wanted",
    gr_act_neighbors: "Show its neighbours",
    gr_act_open_s: "open",
    gr_act_link_s: "link",
    gr_act_want_s: "want",
    gr_insp_h: "Note",
    gr_insp_empty: "Pick a note to see its links, citations, trust — and the ways out of this screen.",
    gr_insp_cites: "Citations",
    gr_insp_sample: "first-run sample",
    gr_insp_own: "your note",
    gr_insp_nocite: "no citation",
    gr_cluster_nomap: "no map page",
    gr_cluster_map: "has a map page",
    gr_enc_orphans: "colour = category · size = links · dim = already connected",
    gr_enc_clusters: "block = cluster · dashed = no map page · dotted line = unlinked but related",
    gr_enc_time: "colour = last edited (one ramp) · dim = untouched for 6 months",
    gr_enc_neighbors: "brightness = hop distance (0 and 1 lit, 2 dim, the rest nearly invisible)",
    gr_link_question: "\"{a}\" sits unconnected in my vault. Which of my notes should link to it, and what would the link say?",
    gr_want_done: "Logged \"{n}\" as a wanted topic",
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
    p_lint_running:
      "Lint is running — you can keep browsing; it continues in the background.",
    p_lint_done: "Lint done",
    p_lint_failed: "Lint failed",
    s_title: "Settings",
    s_search_ph: "Search settings",
    s_search_empty: "No settings match “{q}”",
    s_account: "Account",
    s_local_user: "Local user",
    s_no_vault: "no vault",
    s_vault_path: "Vault path",
    s_change: "Change…",
    q_empty_response: "(empty response)",
    eb_title: "Something went wrong in {area}.",
    eb_reload: "Reload myco",
    eb_retry: "Try again",
    eb_area_app: "the app",
    eb_area_graph: "the graph",
    s_workspace: "Workspace",
    s_model: "Model",
    s_embeddings: "Semantic search",
    s_embeddings_lede:
      "Build an on-device embedding index for semantic search, related notes, and graph similarity. Runs offline.",
    s_embeddings_indexed: "pages indexed",
    s_embeddings_reindex: "Reindex now",
    s_embeddings_indexing: "Indexing…",
    s_embeddings_empty: "Not indexed yet",
    s_embeddings_loading_model: "Loading model…",
    s_embeddings_loading_model_hint:
      "First run loads the bundled model — this takes a few seconds.",
    s_embeddings_done: "Indexed {n} pages",
    s_autoreindex_title: "Keep the index up to date",
    s_autoreindex_desc:
      'myco already re-embeds pages you edit in the background, live, whether this is on or off. Turning this on also re-runs a full "Reindex now" sweep automatically a little while after the vault goes quiet, as a backstop.',
    s_providers: "Connections",
    s_appearance: "Appearance",
    s_vault_known: "Vaults myco already knows",
    s_ov_theme: "Overview background",
    s_ov_theme_lede:
      "The living background on the Overview page. Named after the graph's layouts; not linked to them.",
    ov_theme_mycelium: "Mycelium",
    s_lang: "Language",
    s_about: "About",
    up_check: "Check for updates",
    up_checking: "Checking for updates…",
    up_current: "myco is up to date",
    up_downloading: "Downloading myco {v} in the background…",
    up_ready: "myco {v} is ready",
    up_restart: "Restart myco to apply",
    up_restart_btn: "Restart now",
    up_unconfigured: "No update channel configured",
    up_unavailable: "No update channel for this platform yet",
    up_error: "Update check failed",
    up_dismiss: "Dismiss",
    cr_last_crash: "Last crash",
    cr_at: "{time} at {location}",
    cr_copy: "Copy a bug report",
    cr_copied: "Copied",
    cr_note_label: "What were you doing? (optional)",
    cr_note_ph: "e.g. editing a page and hit save",
    cr_clear: "Clear crash log",
    cr_cleared: "Cleared",
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
    mcp_serving: "MCP server running",
    mcp_not_serving: "MCP server stopped",
    mcp_start_btn: "Start server",
    mcp_stop_btn: "Stop",
    mcp_registering: "Registering…",
    mcp_starting: "MCP server starting…",
    mcp_connect_btn: "Connect to Claude Code",
    mcp_connecting: "Connecting…",
    mcp_connect_hint: "Or run this once in a terminal:",
    mcp_offline_note:
      "The app hosts the SSE server while it's open and follows your active vault.",
    mcp_not_found:
      "MCP server files are missing from this build. Reinstall the latest myco.",
    s_model_lede:
      "myco uses Claude by default. You can switch models for ingest, queries, or both — each task can use a different model.",
    s_model_ingest: "Ingest model",
    s_model_query: "Query model",
    model_custom: "Custom\u2026",
    model_disconnected: "(not connected)",
    model_effort: "Reasoning effort",
    model_custom_ph: "model id",
    model_fetching: "fetching model list\u2026",
    s_model_recommended: "Recommended",
    s_model_ctx: "context",
    ing_extractive_note:
      "Extractive summary — every line below is quoted verbatim from `raw/{slug}.md`. No model read this source, so nothing here is paraphrased and nothing is inferred.",
    ing_extractive_report_title: "Extractive ingest: {title}",
    ing_extractive_report_why:
      "This run used the built-in offline path. Passages were quoted verbatim from the source and cited, tags were reused from the vault's existing tags, and the related pages came from the local embedding index. **No model was called.** `confidence` is `low` because nothing summarised the source — re-running with a connected provider can replace the page.",
    ing_extractive_log:
      "{date} — extractive ingest of [[source-{slug}]] ({title}), no model call",
    ing_extractive_hint:
      "Extractive — quotes your source verbatim and makes no model call.",
    ing_run_extractive: "Ingest extractively",
    s_providers_lede:
      "Bring your own provider. myco never sees your keys — they're stored locally.",
    s_provider_connected: "Connected",
    s_provider_disconnected: "Not connected",
    s_provider_cli_missing: "CLI not installed",
    s_mycopro_url: "Service URL",
    s_mycopro_key: "License key",
    s_mycopro_email: "Email",
    s_mycopro_password: "Password",
    s_mycopro_login: "Log in",
    s_mycopro_logout: "Log out",
    s_mycopro_loggedin: "Logged in as",
    s_mycopro_noaccess: "No active access yet",
    s_autoimport_title: "Auto-collect CLI sessions",
    s_autoimport_desc:
      "While myco is open, periodically sweep Claude Code / Codex conversations into sessions/, where Ask can search and quote them. Trivial sessions and already-imported ones are skipped. Sessions are never queued for paid ingest — they are logs, not wiki pages.",
    s_autoimport_interval: "Every",
    s_autoingest_title: "Auto-ingest inbox",
    s_autoingest_desc:
      "While myco is open, periodically ingest sources you drop into the vault's _inbox/ folder.",
    s_autoingest_interval: "Every",
    s_provider_connect: "Connect",
    s_provider_disconnect: "Disconnect",
    s_provider_test: "Test",
    s_lang_lede:
      "myco's UI and Claude's drafting language are independent — write English notes from a Korean UI if you like.",
    s_lang_ui: "Interface",
    s_lang_drafts: "Drafting language (Claude)",
    s_appearance_lede: "Theme follows your system by default.",
    s_appearance_light: "Light",
    s_appearance_dark: "Dark",
    s_appearance_system: "System",
    s_about_built:
      "myco is a thin client over a local Obsidian vault and the Claude Code CLI. Pages are plain markdown — your knowledge stays yours.",
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
    lint_local_title: "Wiki lint — local pass",
    lint_local_note:
      "Deterministic checks only — no model was used. Free-form fixes and " +
      '"concepts mentioned but not linked" need a connected provider.',
    lint_local_clean: "No issues found.",
    lint_sec_critical: "Critical",
    lint_sec_warning: "Warning",
    lint_sec_info: "Info",
    lint_k_missing_frontmatter:
      "Frontmatter — add the required fields (title, type, created, confidence, status).",
    lint_k_invalid_frontmatter:
      "Invalid frontmatter value — use one of the allowed values.",
    lint_k_dangling_citation:
      "Dangling citation — add the raw/ source, or remove the [^src-…] reference.",
    lint_k_source_count_mismatch:
      "Stale source_count — set it to the number of distinct citations.",
    lint_k_missing_superseded_by:
      "Superseded page — add superseded_by pointing at the page that replaces it.",
    lint_k_missing_disputed_section:
      "Disputed page — add a `## Disputed` section explaining the conflict.",
    lint_k_weak_confidence:
      "confidence: high on fewer than two sources — cite another source, or lower the confidence.",
    lint_k_stale_page:
      "Active but untouched for over 30 days — revisit it, or change its status.",
    lint_k_hedged_claim:
      "General claim on a single source — add a source, or narrow the claim.",
    lint_k_orphan_page:
      "Orphan — no page links here; link it from a related page.",
    lint_k_unresolved_link:
      "Unresolved wikilink — create the page, or fix the link name.",
    p_dismiss: "dismiss",
    p_open_vault: "Open a vault to scan provenance.",
    p_scanning: "Scanning vault…",
    p_empty: "No claim-bearing notes yet — add some prose.",
    p_overall: "Overall",
    p_claims_cited: "claims cited",
    p_pages_by_coverage: "Pages, by claim coverage",
    rd_source: "Source",
    rd_preview: "Preview",
    rd_live: "Live",
    rd_task_toggle: "Toggle task",
    rd_frontmatter_hidden: "Frontmatter hidden — edit in Properties or Source",
    rd_backlinks_empty: "No notes link here yet.",
    rd_related: "Related",
    rd_related_no_index:
      "Related notes come from an on-device index that hasn't been built yet.",
    rd_related_no_index_cta: "Set up semantic search",
    rd_make_cards: "Make cards",
    rd_making: "Generating…",
    rd_cards_none: "No cards generated.",
    rd_cards_made: "{n} cards added",
    rd_open_study: "Open study",
    rd_more: "More",
    rd_rail: "Note rail",
    rd_rail_toggle: "Show or hide the note rail",
    rd_src_title: "Sources & trust",
    rd_src_scanning: "Reading the vault's citations…",
    rd_src_no_claims: "No claims to ground yet.",
    rd_src_coverage: "{cited} of {total} claims carry a citation",
    rd_src_bar: "Citation coverage {pct} percent",
    rd_src_none: "Nothing backs this note. The system will not invent a source.",
    rd_src_broken: "no raw/ file — broken citation",
    rd_src_hand: "hand-written",
    rd_src_weight: "Trust weight Ask applies to this layer",
    rd_src_uncited: "{n} claims with no source",
    rd_src_all: "Full coverage",
    rd_conn_title: "Connections",
    rd_conn_empty: "Nothing links here yet.",
    rd_conn_back: "Backlink",
    rd_conn_sug: "Suggested",
    rd_conn_added: "[[{name}]] added under ## Related",
    rd_auth_title: "Who wrote this paragraph",
    rd_auth_agent: "Written by the agent",
    rd_auth_human: "Written by you",
    rd_auth_revert: "Revert this paragraph",
    rd_auth_locked:
      "More than one commit wrote this paragraph — there is no single version to go back to.",
    rd_auth_human_only: "No agent edit here to revert.",
    rd_auth_history: "See it in history",
    rd_auth_reverted: "Paragraph reverted",
    rd_auth_nothing: "The earlier revision already holds this paragraph.",
    rd_auth_failed: "That revision could not be read.",
    rd_claim_dot: "This paragraph cites nothing",
    rd_claim_title: "Claim with no source",
    rd_claim_hint: "Nothing in this paragraph points at a source.",
    rd_claim_find: "Find a source",
    rd_claim_searching: "Searching the vault…",
    rd_claim_none: "Nothing in the vault supports this — leaving it uncited.",
    rd_claim_added: "Cited [[{name}]]",
    // Editor basics (P1): CodeMirror search/completion phrases, `/` block names.
    cm_find: "Find",
    cm_replace_field: "Replace",
    cm_next: "next",
    cm_previous: "previous",
    cm_all: "all",
    cm_match_case: "match case",
    cm_by_word: "by word",
    cm_regexp: "regexp",
    cm_replace: "replace",
    cm_replace_all: "replace all",
    cm_close: "close",
    cm_current_match: "current match",
    cm_replaced_matches: "replaced $ matches",
    cm_replaced_on_line: "replaced match on line $",
    cm_on_line: "on line",
    cm_goto_line: "Go to line",
    cm_go: "go",
    cm_completions: "Completions",
    sl_h1: "Heading 1",
    sl_h2: "Heading 2",
    sl_h3: "Heading 3",
    sl_bullet: "Bulleted list",
    sl_numbered: "Numbered list",
    sl_todo: "To-do",
    sl_code: "Code block",
    sl_quote: "Quote",
    sl_table: "Table",
    sl_divider: "Divider",
    sl_date: "Today's date",
    img_unsupported: "Only PNG, JPEG, GIF and WebP images can be inserted",
    img_failed: "Image could not be saved: {error}",
    ol_title: "Outline",
    ol_empty: "No headings yet",
    ol_untitled: "(untitled)",
    ol_toggle: "Show or hide the outline",
    props_title: "Properties",
    props_add: "Add property",
    props_key_ph: "key",
    props_value_ph: "value",
    props_add_confirm: "Add",
    props_remove: "Remove {key}",
    props_bad_key:
      "Key must start with a letter, use only letters, digits, _ or -, and not already exist",
    props_complex: "Complex value — edit in source",
    props_tags_ph: "Add tag…",
    props_tag_remove: "Remove tag",
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
    au_needs_provider:
      "Audio overview writes new prose, so it needs an AI provider. Pick one under Settings → Model.",
    bf_title: "Session backfill",
    bf_desc: "Your coding sessions are archived but never became wiki pages. Promote a batch into the ingest queue — the normal pass turns them into cited notes.",
    bf_waiting: "waiting",
    bf_done: "wikified",
    bf_skipped: "too short",
    bf_held: "too large",
    bf_promote: "Queue the next {n}",
    bf_promoted: "{n} sessions queued for ingest",
    bf_held_note: "{n} sessions are too large for a single pass and are being held, not skipped.",
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
    s_distill: "Distill",
    set_distill_loading: "Loading…",
    set_distill_lede:
      "Periodically folds new pages into the wiki's ontology, archiving what's been absorbed and proposing merges for the rest.",
    set_distill_enabled_title: "Automatic distillation",
    set_distill_enabled_desc:
      "While myco is open and you're idle, distill the backlog on its own schedule.",
    set_distill_intensity: "Intensity",
    set_distill_intensity_conservative: "Conservative",
    set_distill_intensity_standard: "Standard",
    set_distill_intensity_aggressive: "Aggressive",
    set_distill_gate: "Gate preset",
    set_distill_gate_strict: "Strict",
    set_distill_gate_normal: "Normal",
    set_distill_gate_loose: "Loose",
    set_distill_count_trigger: "Backlog count trigger",
    set_distill_ttl: "Quarantine TTL (days)",
    set_distill_budget: "Run budget (items)",
    set_distill_idle_minutes: "Idle minutes",
    set_distill_maturation: "Maturation (hours)",
    set_distill_llm_digest_days: "Digest days per run",
    set_distill_llm_ingest_budget:
      "LLM item budget per run (ingest + map drafts combined)",
    set_distill_profile_injection_title: "Profile injection",
    set_distill_profile_injection_desc:
      "Send profile.md to configured AI providers as Ask/ingest context. Off keeps the profile local-only.",
    set_distill_status_title: "Status",
    set_distill_backlog: "Backlog: {n}",
    set_distill_pending: "{n} pending proposals",
    set_distill_trend_shrinking: "shrinking",
    set_distill_trend_growing: "growing",
    set_distill_trend_flat: "flat",
    set_distill_run_now: "Distill now",
    set_distill_running: "Distilling…",
    set_distill_report:
      "Archived {a}, trashed {tr}, {p} proposals — backlog now {b}",
    set_distill_busy: "A distill run is already in progress.",
    set_distill_undo: "Undo this run",
    set_distill_undoing: "Undoing…",
    set_distill_undo_result: "Reversed {n} changes",
    set_runs_title: "Past runs",
    set_distill_gate_pending: "Distill waiting: wiki pages {n}/{min}",
    set_distill_digest_extractive:
      "Session digest ran extractively (quoted highlights, no LLM). Connect a query provider under Settings → Model (Query) for summarized digests.",
    set_distill_quarantined: "{n} items awaiting review in {path}",
    set_distill_stop: "Stop",
    set_distill_stopping: "Stopping after the current step…",
    set_distill_stopped: "Stopped after {step}",
    set_distill_step_run: "the core pass",
    set_distill_step_digest: "the session digest",
    set_distill_step_ingest: "the full-tier ingest",
    set_distill_step_maps: "the map drafts",
    set_distill_step_weekly: "the weekly rollup",
    set_distill_step_monthly: "the monthly rollup",
    set_distill_step_resurface: "the resurface picks",
    set_distill_weekly_rollups: "{n} weekly rollups written to weekly/",
    set_distill_monthly_rollups: "{n} monthly rollups written to monthly/",
    set_archive_title: "Archive storage",
    set_archive_lede:
      "Digested sessions and rolled-up daily notes are kept forever in sessions/archive/ and daily/archive/. Compressing an old bucket packs it into a single zip you can restore at any time. raw/ is never touched.",
    set_archive_measure: "Measure",
    set_archive_measuring: "Measuring…",
    set_archive_empty: "Nothing archived yet.",
    set_archive_total: "{files} files, {size} across {buckets} buckets",
    set_archive_tree_sessions: "Sessions",
    set_archive_tree_daily: "Daily",
    set_archive_tree_weekly: "Weekly",
    set_archive_packed: "compressed",
    set_archive_older_than: "Compress buckets older than {n} months",
    set_archive_compress: "Compress",
    set_archive_compressing: "Compressing…",
    set_archive_compressed:
      "Compressed {buckets} buckets ({files} files), reclaimed {size}",
    set_archive_nothing_old: "Nothing is older than {n} months.",
    set_archive_failed: "Left untouched: {list}",
    set_archive_restore: "Restore",
    set_archive_restoring: "Restoring…",
    set_archive_restored: "Restored {n} files to {bucket}",
    set_profile_title: "Profile",
    set_profile_lede:
      "Personalizes distillation and Ask/ingest context. Written to profile.md; sent to configured AI providers when injection is on.",
    set_profile_role: "Role",
    set_profile_goals: "Goals (one per line)",
    set_profile_interests: "Interests (one per line)",
    set_profile_style: "Working style",
    set_profile_save: "Save",
    set_profile_saving: "Saving…",
    set_profile_saved: "Saved",
    nav_feedback: "Harvest box",
    ov_distill_last_run: "Last run {t}",
    ov_distill_never: "No runs yet",
    ov_distill_llm_queued:
      "Full-tier ingest & map drafts waiting — connect a provider (the digest runs locally)",
    ov_distill_done:
      "Distill finished — archived {a} · {d} days digested · {w} weeks rolled up · {p} proposals",
    ov_distill_done_months: " · {m} monthly rollups",
    ov_distill_done_none: "Distill finished — nothing to process",
    pf_title: "Harvest box",
    pf_lede:
      "Proposals the distillation engine wrote while folding new pages into the wiki — review and apply, or dismiss.",
    pf_empty: "No pending proposals.",
    pf_kind_admit: "Admit cluster",
    pf_kind_archive: "Archive batch",
    pf_kind_delete: "Delete batch",
    pf_kind_draft_map: "Draft topic map",
    pf_created: "Created",
    pf_expand: "Expand",
    pf_collapse: "Collapse",
    pf_approve: "Approve",
    pf_dismiss: "Dismiss",
    pf_confirm_title: "Apply this proposal?",
    pf_confirm_msg: "{n} file(s) will be moved or archived.",
    pf_confirm_msg_draft_map: "Drafts the topic map (1 LLM call).",
    pf_retry: "Retry",
    pf_apply_failed: "Apply failed — retry",
    pf_tab_proposals: "Proposals",
    pf_tab_quarantine: "Quarantine {n}",
    qz_empty: "Nothing in quarantine.",
    qz_lede:
      "Items the admission gate judged off-topic. They are held, not deleted — restore what belongs, trash what doesn't.",
    qz_verdict_offtopic: "Off-topic: {numbers}",
    qz_verdict_sim: "similarity {sim}",
    qz_verdict_sim_vs: "similarity {sim} vs threshold {min}",
    qz_verdict_nearest: "(nearest topic: {topic})",
    qz_verdict_unknown: "No verdict recorded for this item.",
    qz_expires_in: "{n} days left",
    qz_expires_due: "Expired — the next run may move it to trash",
    qz_expires_unknown: "No expiry recorded",
    qz_restore: "Restore to vault",
    qz_delete: "Delete",
    qz_keep: "Keep {n} more days",
    qz_confirm_delete_title: "Delete this item?",
    qz_confirm_delete_msg:
      "{name} goes to the system trash (recoverable from there).",
    tb_activity_quarantine: "{n} awaiting review",
    tb_activity_gone: "That is no longer there — it was already handled.",
    ing_title_label: "Title",
    ing_title_ph: "e.g. Byte Pair Encoding",
    ing_working: "working…",
    ingest_no_changes:
      "WARNING: the model finished but no wiki pages were created or updated. The source was saved to raw/{slug}.md, but nothing was ingested into the wiki. Check the model output above, or try the Claude Code (CLI) provider.",
    ingest_validation_failed:
      "Ingest validation failed — the following issues must be fixed before this ingest can be accepted:",
    ingest_validation_warnings: "Validation warnings (non-blocking):",
    hq_title: "{n} sessions are worth a wiki page",
    hq_lede:
      "{total} session files → {distinct} distinct bodies · 8 KB–200 KB · nearest wiki cluster first. sessions/ is only read; a copy goes to _inbox/.",
    hq_never_run:
      "Never harvested before — every page below would be a first.",
    hq_progress:
      "{done} harvested so far — {shown} of {left} still eligible, newest first.",
    hq_kpi_label: "citations",
    hq_harvest_btn: "Harvest {n}",
    hq_select_all: "Select all",
    hq_clear_all: "Clear all",
    hq_est_none: "Nothing selected — citations stay at {base}",
    hq_est: "{n} wiki pages · citations {base} → {goal}",
    hq_excluded_line:
      "{n} duplicates and boilerplate excluded automatically — the queue is already sieved",
    hq_ex_col_reason: "Excluded because",
    hq_ex_col_count: "count",
    hq_ex_col_why: "Rule",
    hq_ex_duplicate: "Identical body",
    hq_ex_duplicate_why:
      "Same body fingerprint as an earlier file. Measured: the two most-copied bodies were 269 + 267 copies of one 4-word transcript.",
    hq_ex_boilerplate: "Boilerplate",
    hq_ex_boilerplate_why: "Prompt scaffolding with no conversation left in it.",
    hq_ex_too_small: "Under 8 KB",
    hq_ex_too_small_why:
      "Below the wikify floor (backfill.rs::MIN_BYTES). Overlaps with the duplicates above.",
    hq_ex_too_large: "Held (over 200 KB)",
    hq_ex_too_large_why:
      "Held, not skipped — split it and it returns to the queue (backfill.rs::MAX_BYTES).",
    hq_ex_already_harvested: "Already harvested",
    hq_ex_already_harvested_why: "A copy already went through the inbox pass.",
    hq_ex_note:
      "Excluding writes no files. sessions/ stays exactly as it is; only the verdicts are recorded.",
    hq_row_select: "Select for harvest: {name}",
    hq_near: "proximity {score}",
    hq_unclustered: "no nearby page yet",
    hq_cites_plus: "citations +{n}",
    hq_preview: "Preview",
    hq_collapse: "Collapse",
    hq_will_copy: "Copied to",
    hq_will_cluster: "Nearest cluster",
    hq_will_cites: "Citations",
    hq_wont:
      "Not created: any new source file. The original {rel} is copied, never modified.",
    hq_plan_title: "Execution plan — nothing has been created yet",
    hq_plan_sub:
      "{n} sessions selected ({kb}). No file is created until you press Run.",
    hq_plan_copy: "Copy {n} sessions into _inbox/ — the originals stay in sessions/",
    hq_plan_pass:
      "One inbox ingest pass per copy — retrieval grounding → planner → writing agent",
    hq_plan_cites: "Citations {base} → {goal} (estimated, +{n})",
    hq_plan_note:
      "The pass archives each copy it consumes; sessions/ is never written to.",
    hq_plan_cancel: "Cancel",
    hq_plan_run: "Run",
    hq_plan_running: "Running — {done} of {total} done",
    hq_done_title: "{n} harvested",
    hq_done_sub: "citations {base} → {goal}",
    hq_done_partial:
      "{copied} copied · {ingested} ingested — the rest wait in _inbox/",
    hq_failed: "Harvest failed",
    hq_empty_title: "Nothing left to promote",
    hq_empty_body:
      "{distinct} distinct bodies and none eligible right now. Held sessions (over 200 KB) and new conversations past 8 KB come back to this queue.",
    hq_empty_cta: "Bring in a source",
    hq_loading: "Scanning sessions/…",
    hq_error: "Could not read the session archive",
    hq_retry: "Retry",
    ing_refused_title: "Nothing to keep — not saved · {reason}",
    ing_logged_title: "Kept the original only · {reason}",
    ing_noop_reason: "plan: every item NOOP — the wiki already covers this",
    ing_gate_none_reason: "nothing approved at the plan gate",
    sv_rail_label: "Pipeline",
    sv_step_intake: "Intake",
    sv_step_judge: "Judgement",
    sv_step_gate: "Plan gate",
    sv_step_run: "Run",
    sv_step_backfill: "Backfill queue",
    sv_today_n: "{n} today",
    sv_tally: "drop {d} · log {l} · harvest {h}",
    sv_waiting: "waiting",
    sv_reviewing: "reviewing",
    sv_idle: "idle",
    sv_running: "running",
    sv_done: "done",
    sv_failed: "failed",
    sv_queue_n: "{n} waiting",
    sv_judge_eyebrow: "2 · Judgement — the centre of this screen",
    sv_judge_title: "Judgement",
    sv_judge_lede:
      "Every arrival is sorted into drop / log / harvest BEFORE a file exists. A drop is zero files, zero model calls and one judgement-log line.",
    sv_meta_session: "this session: {n} judged",
    sv_meta_saved: "model calls saved {n}",
    sv_drop: "drop",
    sv_drop_sub: "0 files created",
    sv_log: "log",
    sv_log_sub: "kept in raw/ · no model",
    sv_harvest: "harvest",
    sv_harvest_sub: "to the plan gate",
    sv_dz_sub:
      "Drop a text or markdown file anywhere on this window — the file exists only after the verdict.",
    sv_verdicts_title: "Verdicts",
    sv_verdicts_empty:
      "Nothing judged this session yet — drop a file or paste text above.",
    sv_out_drop: "0 files · 0 model calls",
    sv_out_noop: "0 files · 1 model call",
    sv_out_log: "raw/ 1 · wiki 0",
    sv_out_harvest: "ingested",
    sv_excl_line: "{n} refused this session — see why",
    sv_excl_none: "Nothing refused this session",
    sv_excl_col_rule: "Rule",
    sv_excl_col_count: "count",
    sv_excl_col_last: "Last reason",
    sv_channels: "Intake channels",
    sv_ch_sessions: "Session sweep",
    sv_ch_clipper: "Web clipper",
    sv_ch_mcp: "MCP tools",
    sv_ch_zotero: "Zotero · files",
    sv_ch_inbox: "_inbox queue",
    sv_ch_manual: "manual",
    sv_bf_eyebrow: "5 · Backfill queue — the largest unopened input",
    sv_bf_eligible: "worth harvesting",
    sv_bf_eligible_sub: "8 KB ≤ size ≤ 200 KB",
    sv_bf_total: "archive total",
    sv_bf_distinct: "distinct bodies",
    sv_bf_batch_label: "batch size",
    sv_bf_cost:
      "model calls ≈ {calls} (plan {n} + write {n}) · judged first, so duplicates cost nothing",
    sv_bf_skipped: "{n} skipped",
    q_via: "via {provider} · {model}",
    q_via_retrieval:
      "via local semantic search — answers quote your notes verbatim (no model)",
    q_builtin_note:
      "The built-in offline model (Gemma 3 1B) is compact and can be inaccurate. For better offline answers, run a larger model via Ollama (e.g. gemma3:4b); for the most reliable answers, use Claude.",
    q_builtin_extractive_note:
      "Answers show the top matching passages from your notes. For a synthesized answer, pick an AI provider under Model settings.",
    q_open_model_settings: "Model settings",
    q_stale_index:
      "This answer used the whole vault instead of the search index, which is out of date after a model update.",
    q_retrieval_failed:
      "The search index could not be reached, so this answer skipped semantic search and read the vault directly instead. If it keeps happening, run “Reindex now” under Model settings.",
    q_extractive_label: "From your notes (top matches, verbatim)",
    q_extractive_empty:
      "Nothing relevant found in the wiki index. Try rephrasing, or run “Reindex now” under Model settings.",
    q_extractive_stale:
      "The search index predates a model update, so it can't be searched. Run “Reindex now” under Model settings, then ask again.",
    q_extractive_failed:
      "The search index could not be reached, so no passages could be retrieved. If it keeps happening, run “Reindex now” under Model settings.",
    q_range_chip: "Period: {s} – {e}",
    q_range_empty: "No answer found in the records for that period.",
    q_cite_conf_high: "strong match",
    q_cite_conf_medium: "moderate match",
    q_cite_conf_low: "weak match",
    q_cite_conf_lexical: "keyword match",
    q_cite_conf_tip:
      "{page} — similarity {sim} (dense cosine; passages below {floor} are not shown)",
    q_cite_conf_lexical_tip:
      "{page} — keyword match only, so there is no similarity score for it",
    q_cite_tier_note: "your note",
    q_cite_tier_map: "drafted map",
    q_cite_tier_digest: "daily digest",
    q_cite_tier_rollup: "weekly rollup",
    q_cite_tier_monthly: "monthly rollup",
    q_cite_tier_session: "session log",
    q_cite_tier_source: "imported source",
    q_cite_list_label: "Citation confidence and source",
    q_uncited_row: "Reviewed but not quoted · {n}",
    ask_profile_hint:
      "Set up your profile so Ask can tailor answers to your role and interests.",
    ask_profile_hint_cta: "Set up profile",
    ask_profile_hint_dismiss: "Dismiss",
    q_chip_done: "Answer ready",
    q_chip_error: "Answer failed",
    q_you: "you",
    q_miss_btn: "Not what you expected? Log it",
    // Ask renewal (mockup "Strata").
    q_scope_label: "Search scope",
    q_scope_wiki: "Wiki",
    q_scope_sessions: "Sessions",
    q_scope_all: "All",
    q_scope_help:
      "Wiki searches your notes, maps and digests. Sessions searches the conversation logs — archived ones too, once enabled under Settings › Semantic search. All searches both.",
    q_scope_chip: "Scope · {scope}",
    q_trace_title: "Retrieval path",
    q_trace_toggle: "Step by step",
    q_trace_candidates: "candidates",
    q_trace_candidates_sub: "pages in the index",
    q_trace_bm25: "BM25",
    q_trace_bm25_sub: "keyword-only hits (no cosine)",
    q_trace_dense: "vector",
    q_trace_dense_sub: "hits with a cosine",
    q_trace_rrf: "RRF",
    q_trace_rrf_sub: "k=60 rank fusion — not a confidence",
    q_trace_cap: "cap",
    q_trace_cap_sub: "at most {k} chunks, 2 per page",
    q_trace_floor: "floor",
    q_trace_floor_sub: "cosine below {floor}",
    q_trace_cold: "archived",
    q_trace_cold_on: "in",
    q_trace_cold_off: "out",
    q_trace_cold_on_sub: "sessions/archive/ is searched in the session scope",
    q_trace_cold_off_sub: "sessions/archive/ stays out (Settings › Semantic search)",
    q_trace_params:
      "BM25 k1=1.2 · b=0.75 · RRF k=60 · floor {floor} — retrieval.rs as it runs. The RRF score orders hits; it is not a confidence.",
    q_cite_aria: "Citation {n} — {stem}, relevance {sim}, {tier}",
    q_cite_sim_none: "keywords only",
    q_ladder_title: "Source ladder",
    q_ladder_hint: "Hover or focus a citation number to light up the line that backs it.",
    q_ladder_count: "{n} sources · {c} quoted",
    q_ladder_lead_same: "Tier weights do not change the order for this question.",
    q_ladder_lead_moved: "{stem} ({tier}) — rank {before} unweighted, {after} with weights.",
    q_ladder_up: "up {n} with tier weights",
    q_ladder_down: "down {n} with tier weights",
    q_ladder_same: "no rank change",
    q_ladder_archived: "archived",
    q_ladder_sr:
      "Each row shows the cosine relevance, the tier weight, RRF × weight = final score, and the rank change against the unweighted order.",
    q_prior_advanced: "Advanced",
    q_prior_title: "Tier prior",
    q_prior_formula: "final = RRF × weight",
    q_prior_app: "Current app behaviour (all 1.00)",
    q_prior_defaults: "Suggested defaults",
    q_prior_next: "Applies from the next question; the ladders above preview it now.",
    q_prior_slider: "{tier} tier weight",
    q_abstain_title: "There is no evidence in the vault to answer this.",
    q_abstain_sub:
      "“{q}” — no passage in {n} indexed pages clears the relevance floor {floor}. Stopping here instead of inventing a plausible sentence.",
    q_abstain_near: "Closest misses — all below the floor",
    q_abstain_none: "Neither the keyword arm nor the vector arm brought anything back.",
    q_abstain_lexical: "keywords only",
    q_abstain_gauge_note:
      "The red tick is the floor {floor}. “Keywords only” is a lexical hit with no cosine — on its own it is not evidence.",
    q_abstain_floor_tick: "floor {floor}",
    q_abstain_harvest: "Make this question a harvest target",
    q_abstain_harvested: "Queued for harvest · 1",
    q_abstain_widen: "Widen to sessions and search again",
    q_abstain_foot: "Abstaining is an answer — a recorded gap is one a later harvest can fill.",
    q_abstain_receipt: "No files created. Logged once to the recall-miss log.",
    s_archived_sessions_title: "Search archived sessions too",
    s_archived_sessions_desc:
      "The session scope also searches sessions/archive/ — the cold tier the index normally leaves out. Turning it on re-indexes.",
    sb_new_note: "New note",
    sb_new_folder: "New folder",
    sb_rename: "Rename…",
    sb_today_note: "Today's note",
    sb_new_note_msg: "Note title (.md is added automatically)",
    sb_new_note_ph: "untitled",
    sb_delete_folder_q: "Delete folder?",
    sb_delete_file_q: "Delete file?",
    sb_favorites: "Favorites",
    sb_recent: "Recently edited",
    sb_fav_add: "Add to favorites",
    sb_fav_remove: "Remove from favorites",
    sb_move_to: "Move to…",
    sb_move_title: "Move {n} item(s) to",
    sb_move_root: "Vault root",
    sb_delete_n: "Delete {n} items",
    sb_delete_n_q: "Delete {n} items?",
    sb_delete_msg: "{n} item(s) will move to the Trash.",
    sb_delete_one_msg: "“{name}” will move to the Trash.",
    sb_selected: "{n} selected",
    sb_clear_selection: "Clear selection",
    sb_new_folder_msg: "Folder name",
    sb_rename_msg: "Rename “{name}” to:",
    sb_empty_vault: "Empty vault",
    sb_no_vault: "No vault selected",
    cb_no_results: "No results",
    cb_tag_page: "page",
    cb_tag_file: "file",
    cb_tag_action: "action",
    cb_in_contents: "In page contents",
    cb_semantic: "Related (semantic)",
    cb_exact: "Exact match",
    cb_operator_hint: "Quotes for exact match · path: · tag: · type: · status: · confidence:",
    cb_miss_hint: "Didn't find it? ⌥⏎ logs this search to the eval set.",
    cb_miss_done: "Logged to the eval set.",
    sb_harvest_badge: "{n} sessions ready to harvest",
    sb_proposals_badge: "{n} proposals awaiting review",
    cb_tag_lens: "lens",
    sb_status: "Status",
    sb_st_vault: "Vault",
    sb_st_index: "Index",
    sb_st_model: "Model",
    sb_st_on: "running",
    sb_st_off: "stopped",
    sb_st_mcp_down:
      "The MCP server is stopped — agents and Claude Code cannot reach this vault.",
    sb_st_lagging: "{n} wiki pages are outside the index — Ask cannot find them.",
    sb_st_simulate: "Simulate failure",
    s_val_on: "On",
    s_val_off: "Off",
    s_changed_only: "Changed only",
    s_search_clear: "Clear search",
    s_show_all: "Show every setting",
    s_total_count: "{n} of {all} settings",
    tb_lint: "Lint",
    tb_toggle_sidebar: "Toggle sidebar (⌘B)",
    tb_back: "Back (⌘[)",
    tb_forward: "Forward (⌘])",
    tb_model_picker: "Model status",
    tb_model_ready: "ready",
    tb_model_offline: "offline",
    tb_model_open_settings: "Open model settings",
    tb_activity_label: "Background activity",
    tb_activity_n: "Activity {n}",
    tb_activity_running: "Running",
    tb_activity_links: "{n} suggested links",
    tb_activity_reflect: "{n} reflect suggestions",
    tb_activity_applying: "Applying proposal…",
    tb_activity_mcp_on: "MCP server running",
    tb_activity_mcp_off: "MCP server off",
    tb_activity_tasks: "Tasks due",
    tb_activity_tasks_more: "+{n} more",
    tb_activity_map_notes: "{n} notes",
    tb_activity_map_wait:
      "Approving is saved, but the draft needs a query model — the local one can't write maps.",
    tb_inflow_header: "Today's inflow",
    tb_inflow_sessions: "Sessions swept",
    tb_inflow_last_sweep: "last sweep {t}",
    tb_inflow_auto: "auto {m} min",
    tb_inflow_mcp: "MCP tool calls",
    tb_inflow_mcp_count: "{n}",
    tb_inflow_mcp_top: "top: {tool}",
    tb_inflow_since_launch: "since app launch",
    tb_inflow_inbox: "_inbox arrivals",
    tb_inflow_source_unknown: "unknown",
    tb_inflow_view: "View →",
    tb_inflow_spark_caption:
      "Last 24h · purple = sessions/inbox · blue = MCP calls",
    tb_inflow_summary: "Today: sessions +{s} · MCP {m} · inbox +{i}",
    tray_open: "Open myco",
    tray_quit: "Quit myco",
    s_tray_resident_title: "Keep running in the menu bar",
    s_tray_resident_desc:
      "Closing the window hides it instead of quitting — myco stays in the menu bar and background work keeps going. Quit from the tray menu.",
    spot_placeholder: "Ask the wiki…",
    spot_thinking: "asking…",
    spot_hint_enter: "Enter to ask · Esc to close",
    spot_hint_open: "Click a citation to open that note in myco.",
    spot_no_vault: "Open a vault in myco first — there is nothing to ask yet.",
    spot_busy: "myco is still answering the previous question.",
    voice_btn_label: "Voice capture",
    voice_hint_recording: "⏎ save · esc cancel",
    voice_saved_chip: "{rel} — joins the next ingest",
    voice_whisper_missing:
      "preparing voice recognition — the speech model downloads once (~190 MB) on first use. If this keeps failing, reinstall myco.",
    voice_model_progress: "downloading the voice model — one time, {pct}%",
    voice_transcribe_progress: "Transcribing… {pct}%",
    voice_mic_denied:
      "The microphone is not available — allow myco to use it in System Settings.",
    voice_no_input: "No sound is coming in — check the microphone",
    voice_stage_transcribing: "Transcribing…",
    voice_stage_saving: "Saving note…",
    s_spot_title: "Ask from anywhere",
    s_spot_desc:
      "A global shortcut opens a small ask window over whatever you are doing. It answers through the same Ask path as the app, so citations open the note.",
    s_spot_record: "Change shortcut",
    s_spot_recording: "Press the new combination…",
    s_spot_disable: "Turn off",
    s_spot_ok: "Registered — press {k} anywhere.",
    s_spot_failed:
      "{k} could NOT be registered — another app is most likely already using it. Pick a different combination.",
    s_spot_off: "Off — no global shortcut is registered.",
    notif_distill_done_title: "Distill finished",
    notif_distill_done_body:
      "{p} proposals · {d} session days digested · {w} weeks rolled up",
    notif_distill_done_months: " · {m} monthly rollups",
    notif_quarantine_title: "New quarantine items",
    notif_quarantine_body:
      "{n} items are waiting for review in _inbox/quarantine.",
    h_open_vault: "Open a vault to see history.",
    rf_title: "Reflect suggestions",
    rf_lede:
      "Claude's read-only pass over the vault: orphans to link, stale pages, and missing cross-references.",
    rf_run: "Reflect",
    rf_running: "Reflecting…",
    rf_running_label: "Reflect running…",
    rf_done: "Reflect finished — suggestions: {n}",
    rf_empty: "No suggestions — the vault looks well-connected.",
    rf_extractive:
      "Extractive pass (built-in model, no LLM) — link-graph facts only: orphan pages and unresolved links.",
    rf_item_orphan:
      "{page}: orphan — no other page links to it; add a [[wikilink]] from a related page.",
    rf_item_unresolved:
      "{page}: links to [[{target}]], which has no page — create it or fix the link.",
    rf_create_missing: "Create missing pages",
    rf_create_progress: "{done}/{total}",
    rf_create_result: "Pages created: {n}",
    rf_create_failed: "Stopped at [[{target}]] — could not create it.",
    rf_create_one: "Create this page",
    rf_open_page: "Open page",
    rf_ignore_one: "Stop reporting this",
    ob_title: "Welcome to myco",
    ob_skip: "Skip",
    ob_back: "Back",
    ob_next: "Next",
    ob_finish: "Done",
    ob_vault_linked: "Linked",
    ob_vault_none: "No vault linked yet",
    ob_s1_title: "Create or open a project",
    ob_s1_body:
      "myco keeps every page as plain markdown in a folder you control. Open an existing folder, or keep the default vault myco just created for you.",
    ob_s1_action: "Open a folder…",
    ob_sovereignty:
      "Plain markdown · raw/ is never modified · shares a folder with Obsidian — delete myco and keep everything.",
    ob_s2_title: "Add your first source",
    ob_s2_body:
      "Drop a file, paste a URL, or write a note. myco reads it, extracts entities and concepts, and weaves a cited page into your graph.",
    ob_s2_action: "Go to Ingest",
    ob_s3_title: "Ask a question",
    ob_s3_body:
      "Ask the wiki anything. myco answers from your pages first and reaches into raw sources only when needed — every claim ships with a citation.",
    ob_s3_action: "Go to Ask",
    ob_demo_start: "Start with a demo vault",
    ob_seed_offer:
      "That folder is empty. Want a few demo notes to try things on?",
    ob_seed_do: "Add demo notes",
    ob_indexing_local: "The index is built on this device only.",
    ob_s2_progress: "{done} of {total} notes",
    ob_s2_indexed: "{n} notes indexed",
    ob_s2_failed: "Indexing didn't finish",
    ob_first_question: "What topics do these notes cover most?",
    ob_first_question_sessions: "What did I work on last week?",
    ob_ask_now: "Ask it",
    ob_imp_title: "Bring your history",
    ob_imp_body:
      "myco can import your Claude Code and Codex sessions. They index on this device only — searching and asking about them is free.",
    ob_imp_claude: "Import Claude Code sessions",
    ob_imp_codex: "Import Codex sessions",
    ob_imp_progress: "{done} of {total} files",
    ob_imp_done: "{n} sessions imported",
    ob_imp_quarantined: "{n} held back (possible secrets)",
    ob_imp_skip_hint: "Nothing to import? Just continue.",
    ob_hist_title: "Keep a history?",
    ob_hist_already: "History is already on for this vault.",
    ob_hist_skip_hint: "You can turn this on later from Overview.",
    s_budget_title: "Monthly spend guard",
    s_budget_desc:
      "Estimated spend across paid API providers this month. A rough tripwire, not billing — set a threshold to get warned before you cross it.",
    s_budget_threshold: "Monthly limit (USD)",
    s_budget_usage: "This month",
    s_budget_total: "Total",
    s_budget_empty: "No paid-API usage tracked yet this month.",
    s_autoreflect_title: "Auto-reflect",
    s_autoreflect_desc:
      "While myco is open, periodically run a read-only reflect pass to surface orphans, stale pages, and missing links.",
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
      "Compact multilingual embedder (e5-small-ko, 40 MB) bundled inside the app. Works offline with zero setup; Ask answers extractively from your notes via semantic search. No local chat model ships — use a cloud provider for ingest, classification, and generation.",
    s_provider_desc_ollama:
      "Run open-source models locally. Auto-detects http://localhost:11434.",
    s_provider_desc_openrouter:
      "One key for many providers (useful for model comparison).",
    s_provider_desc_myco_pro:
      "Unlimited ingest on a managed model — no API key or CLI needed. Sign in with your myco Pro account.",
    vh_banner_title: "Vault history is off",
    vh_banner_desc:
      "Turn it on to see agent changes word by word and undo them.",
    vh_enable: "Turn on history",
    vh_later: "Later",
    vh_setting_title: "Vault history (git)",
    vh_setting_desc:
      "Creates a local git repo inside the vault. Agent commits and your edits are recorded as different authors. Nothing leaves this machine.",
    set_pii_title: "When PII is detected",
    set_pii_desc:
      "With Quarantine, sources containing emails or phone numbers stay in _inbox instead of being written to permanent storage. Secrets like API keys are always blocked either way.",
    set_pii_warn: "Warn only",
    set_pii_quarantine: "Quarantine",
    set_audit_title: "raw/ secret audit",
    set_audit_rescan: "Rescan",
    set_audit_clean: "{n} files · {m} in history — 0 secrets",
    set_audit_history_only: "History only",
    set_audit_note:
      "The audit is read-only. The app never rewrites raw/; cleanup follows the documented procedure.",
    ov_since_eyebrow: "Since you were last here",
    ov_since_title: "{runs} distill runs, {pages} pages moved",
    ov_since_quiet: "All quiet since your last visit.",
    ov_suspect_title: "Suspect pages",
    ov_suspect_clean: "Every checked page looks sound.",
    ov_view_runs: "View runs",
    contra_title: "Contradictions",
    contra_disputed: "Page is flagged disputed",
    contra_stale: "Cites {t} (superseded)",
    contra_mark_active: "Resolve: active",
    contra_mark_superseded: "Mark superseded",
    contra_open_page: "Open linking page",
    contra_open_target: "Open target",
    contra_ignore: "Ignore",
    contra_clean: "No contradictions.",
    rs_header: "Meet again",
    rs_open: "Open",
    rs_snooze: "In a week",
    rs_ignore: "Ignore",
    rs_similarity: "similarity {s}",
    rs_last_open: "last opened {t}",
    rs_floor_note: "Frequent ignores raise the bar · now {f}",
    ritual_title: "Today's reunions",
    ritual_due: "{n} review cards are due",
    ritual_start: "Start review",
    history_runs_title: "Runs",
    history_run_open_why: "WHY report",
    history_no_commit:
      "This run happened while history (git) was off — showing the file list only.",
    history_diff_too_large: "Too large to diff",
    history_status_added: "Added",
    // Distill renames ARE moves (archive/trash relocations), so the label
    // says what happened to the page, not the git status letter.
    history_status_modified: "Modified",
    history_status_renamed: "Moved",
    history_status_deleted: "Deleted",
    auth_badge_human: "Human {h}% · Agent {a}%",
    auth_badge_last_human: "Last human touch {t}",
    auth_filter_pill: "Human only (on record)",
    agent_confirm_title: "The agent wants to update a page",
    agent_confirm_create_title: "The agent wants to create a page",
    agent_confirm_hint: "Allowing this writes the change below to your vault.",
    notch_peek: "Drop it — or click to jot",
    notch_peek_body: "Files · links · selected text",
    notch_drop: "Release to drop",
    notch_accepted: "Got it",
    notch_accepted_next: "next",
    notch_accepted_next_sub: "ingest reads it shortly",
    notch_running: "Ingesting · {t}",
    notch_running_read: "reading",
    notch_running_pages: "pages",
    notch_done: "Done",
    notch_done_open: "⏎ open",
    notch_done_collapse: "closes in 4s",
    notch_capture: "Quick note",
    notch_capture_save: "⏎ daily note",
    notch_capture_voice: "⌥M voice",
    notch_capture_saved: "Saved",
    notch_recording: "Recording · {t}",
    notch_rec: "Record",
    notch_note: "Note",
    notch_cancelled: "Cancelled",
    notch_no_sound: "No sound",
    notch_hint_cancel: "esc cancel",
    notch_hint_save: "⏎ save",
    notch_rejected: "Could not take it",
    notch_rejected_body: "This format is not readable yet ({ext})",
    notch_rejected_accepts: "accepts",
    notch_rejected_list: "PDF · documents · sheets · HTML · images · audio",
    notch_unsupported: "This format is not readable yet ({ext})",
    notch_write_failed:
      "Could not save the drop — try again or use 소스 가져오기",
    s_notch_title: "Notch drop surface",
    s_notch_desc:
      "Show a drop target under the menu-bar notch — files dropped there land in _inbox for ingest to read.",
  },
  ko: {
    app_name: "myco",
    quick_search: "검색하거나 이동…",
    quick_ask: "위키에 질문하기",
    nav_workspace: "워크스페이스",
    nav_pages: "페이지",
    nav_tools: "도구",
    nav_overview: "오늘",
    nav_ingest: "가져오기",
    nav_query: "질문",
    nav_graph: "그래프",
    db_empty: "아직 그릴 데이터가 없습니다.",
    bd_title: "내 보드",
    bd_range: "기간",
    bd_range_all: "전체",
    bd_edit: "보드 편집",
    bd_done: "완료",
    bd_add: "위젯 추가",
    bd_custom: "직접 질문 만들기…",
    bd_text: "텍스트 (마크다운)",
    bd_heading: "제목 구분",
    bd_compact: "배치",
    bd_compact_v: "위로 붙이기",
    bd_compact_none: "여백 유지",
    bd_empty: "첫 차트를 추가하세요 — MCP 유입, 태그, 작업…",
    bd_drag: "끌기",
    bd_configure: "설정",
    bd_duplicate: "복제",
    bd_field_title: "제목",
    bd_field_source: "소스",
    bd_field_group: "그룹",
    bd_field_filter: "필터",
    bd_field_view: "보기",
    bd_field_time: "기간",
    bd_field_rule: "색 규칙",
    bd_filter_none: "없음",
    bd_time_auto: "자동 (보드 기간)",
    bd_rule_risk: "빨강",
    bd_rule_ok: "초록",
    bd_src_inflow: "유입",
    bd_src_notes: "노트",
    bd_src_tasks: "작업",
    bd_preset_mcp_daily: "MCP 일별 유입",
    bd_preset_channels_daily: "채널별 유입 (스택)",
    bd_preset_notes_by_type: "종류별 노트",
    bd_preset_top_tags: "자주 쓴 태그",
    bd_preset_edits_daily: "일별 수정",
    bd_preset_tasks_by_status: "작업 상태",
    bd_preset_unsourced_stat: "출처 없는 페이지 (숫자)",
    bd_g_day: "일별",
    bd_g_channel: "채널별",
    bd_g_type: "종류별",
    bd_g_confidence: "신뢰도별",
    bd_g_status: "상태별",
    bd_g_tag: "태그별",
    bd_v_bar: "막대",
    bd_v_line: "선",
    bd_v_hbar: "가로 막대",
    bd_v_stat: "숫자",
    bd_v_table: "표",
    bd_hide_zero: "0이면 숨김",
    bd_json_form: "폼",
    bd_json_bad: "JSON이 올바르지 않습니다 — 고치거나 폼으로 돌아가세요.",
    bd_unknown: "알 수 없는 위젯 타입 “{kind}” — 저장된 그대로 보존됩니다.",
    bd_field_color: "색",
    bd_color_default: "기본",
    bd_color_blue: "파랑",
    bd_color_green: "초록",
    bd_color_purple: "보라",
    bd_color_amber: "앰버",
    bd_color_cyan: "시안",
    bd_color_red: "빨강",
    bd_detail_total: "합계 {n}",
    bd_board_pick: "보드",
    bd_new_board: "새 보드",
    bd_new_board_prompt: "보드 이름:",
    bd_delete_board: "보드 삭제",
    bd_delete_confirm: "“{name}” 보드를 삭제할까요?",
    ls_title: "제안된 연결",
    ls_hint:
      "의미상 가깝지만 아직 연결되지 않은 노트들입니다. 수락하면 \u201c## Related\u201d 아래에 [[위키링크]]가 추가됩니다.",
    ls_accept: "연결하기",
    ls_dismiss: "무시",
    ls_accept_all: "모두 수락",
    ls_linking: "링크 중",
    ls_toast_linked: "링크 {n}개 추가됨",
    ls_toast_linked_sub: "## Related 아래에 [[wikilink]]",
    ls_toast_failed: "링크를 추가하지 못했습니다",
    ls_toast_retry: "다시 시도",
    zi_title: "Zotero에서 가져오기",
    zi_hint:
      "CSL-JSON 또는 BibTeX 내보내기 파일(하이라이트 포함 시 함께). 항목은 _inbox/에 소스 문서로 저장됩니다.",
    zi_none: "가져올 항목을 찾지 못했습니다.",
    zi_done:
      "{n}개 항목을 _inbox/로 가져왔습니다 — Ingest를 실행해 위키 페이지로 만드세요.",
    ci_title: "대화 가져오기",
    ci_hint:
      "ChatGPT 내보내기(conversations.json) 또는 Claude Code / Codex 세션(.jsonl). 각 대화가 소스 문서로 _inbox/에 들어가 ingest 파이프라인이 처리합니다.",
    ci_btn: "파일 선택…",
    ci_busy: "가져오는 중…",
    ci_done:
      "{n}개 대화를 _inbox/로 가져왔습니다 — Ingest를 실행해 위키 페이지로 만드세요.",
    ci_quarantined:
      "{n}개 대화가 시크릿(API 키·토큰)으로 보이는 내용을 포함해 제외됐습니다. 원본에서 확인하세요. 가져오지 않았습니다.",
    ci_none: "그 파일에서 대화를 찾지 못했습니다.",
    ci_skipped: " ({n}개는 이미 가져와 건너뜀.)",
    ci_sweep_cc: "내 Claude Code 세션 가져오기",
    ci_sweep_cx: "내 Codex 세션 가져오기",
    ci_sweep_hint:
      "또는 이 컴퓨터에 이미 있는 모든 세션을 가져옵니다 — ~/.claude·~/.codex에서. 다시 실행해도 새로 생기거나 늘어난 세션만 추가됩니다.",
    ci_sweep_progress: "세션 가져오는 중 {done} / {total}",
    ci_sweep_tally: "가져옴 {i} · 건너뜀 {s} · 실패 {f}",
    ci_failed_summary: "{n}개를 가져오지 못했습니다",
    ci_retry_failed: "실패 재시도 ({n})",
    q_empty: "위키에 무엇이든 물어보세요 — 답변은 당신의 페이지를 인용합니다.",
    s_mascot: "마스코트 MYCO 표시",
    s_mascot_hint:
      "로더·빈 화면·정보 페이지에 등장합니다. 끄면 정적 로고로 대체됩니다.",
    s_backup_title: "설정 및 룩",
    s_backup_hint:
      "공급자, 자동화, 외관, 그래프 룩이 이 파일에 담깁니다. API 키, 볼트 경로, 이 기기의 식별 정보는 담기지 않습니다.",
    s_backup_export: "내보내기…",
    s_backup_import: "가져오기…",
    s_backup_busy: "처리 중…",
    s_backup_exported: "설정을 내보냈습니다.",
    s_backup_imported: "복원됨: {sections}",
    s_backup_import_failed: "가져오기 실패: {error}",
    s_backup_bad_json: "유효한 JSON 파일이 아닙니다.",
    s_backup_section_settings: "앱 설정",
    s_backup_section_ui: "외관",
    s_backup_section_graph: "그래프 룩",
    s_backup_section_savedLooks: "저장된 그래프 룩",
    s_backup_section_queryViews: "저장된 뷰",
    s_backup_section_dismissedLinkSuggestions: "숨긴 링크 제안",
    s_backup_section_reflectIgnored: "돌아보기 무시 항목",
    s_backup_section_budgetThresholdUsd: "예산 알림 기준",
    s_backup_confirm_title: "이 설정들을 교체할까요?",
    s_backup_confirm_body:
      "이 파일이 교체하는 항목: {sections}. 교체되는 값은 메모리에 보관되므로 myco를 종료하기 전까지 되돌릴 수 있습니다.",
    s_backup_confirm_none:
      "이 파일에는 이 버전이 복원할 수 있는 설정이 없습니다 — 가져와도 바뀌는 것이 없습니다.",
    s_backup_confirm_apply: "교체",
    s_backup_confirm_cancel: "취소",
    s_backup_undo: "가져오기 되돌리기",
    s_backup_undo_hint: "이전 설정은 myco를 종료할 때까지 메모리에 보관됩니다.",
    s_backup_undone: "되돌림: {sections}",
    hw_title: "도움말",
    hw_sub: "이 페이지의 팁",
    hw_sc_cmd: "커맨드 팔레트",
    hw_sc_sidebar: "사이드바 토글",
    hw_sc_fly: "비행 모드 (그래프)",
    hw_sc_esc: "닫기 / 선택 해제",
    hw_sc_new: "새 노트",
    hw_sc_spotlight: "어디서나 질문",
    hw_sc_voice: "음성 캡처 (Spotlight / 노치)",
    hw_sc_miss: "놓친 검색 기록",
    hw_sc_path: "두 노트 사이 최단 경로 (그래프)",
    hw_sc_live_link: "포인터 아래 위키링크 열기 (실시간 편집기)",
    hw_sc_back: "뒤로",
    hw_sc_fwd: "앞으로",
    hw_tip_graph1: "질문을 고르면 인코딩만 바뀝니다 — 좌표는 그대로입니다.",
    hw_tip_graph2:
      "빈 곳 목록이 곧 답입니다: 열기 · 링크 제안 · 수확 대상으로.",
    hw_tip_graph3: "샘플 숨기기를 켜면 내가 쓴 노트만 남습니다.",
    hw_tip_query1:
      "답변은 위키 페이지를 인용합니다 — 인용을 클릭해 열어보세요.",
    hw_tip_query2:
      "그래프의 갭 패널이 연구 질문을 이 입력창에 담아줄 수 있습니다.",
    hw_tip_ingest1:
      "파일 드롭, 텍스트 붙여넣기, Zotero 가져오기 모두 가능합니다.",
    hw_tip_ingest2:
      "웹 클리퍼는 _inbox/를 통해 페이지를 이곳으로 보냅니다 (clipper/ 참고).",
    hw_tip_overview1:
      "제안된 연결은 아직 링크되지 않은 의미상 유사 쌍입니다 — 수락하거나 무시하세요.",
    hw_tip_default: "⌘K로 어디든 이동 — 페이지·액션·시맨틱 검색.",
    vw_lens_unsourced: "출처 없음",
    vw_lens_orphans: "고립",
    vw_lens_disputed: "분쟁 중",
    vw_lens_recent: "최근 변경",
    tpl_new_from: "템플릿으로 새 노트…",
    tpl_pick_title: "템플릿 선택",
    tpl_pick_msg:
      "템플릿은 볼트의 templates/ 폴더에 있는 .md 파일입니다. {{date}}, {{time}}, {{title}}이 채워집니다.",
    tpl_empty:
      "아직 템플릿이 없습니다. templates/ 폴더와 수정 가능한 시작 템플릿 2개(노트, 회의록)를 만듭니다.",
    tpl_create_starters: "템플릿 폴더 만들기",
    tpl_creating: "만드는 중…",
    tpl_create_error: "템플릿을 만들지 못했습니다: {err}",
    tpl_note_error: "템플릿으로 노트를 만들지 못했습니다: {err}",
    tpl_starter_note: "노트",
    tpl_starter_meeting: "회의록",
    tpl_starter_note_body: "## 요약\n\n## 내용\n\n## 출처\n",
    tpl_starter_meeting_body:
      "> {{date}} {{time}}\n\n## 참석자\n\n## 안건\n\n## 논의 내용\n\n## 액션 아이템\n\n- [ ] \n",
    nav_history: "히스토리",
    nav_provenance: "출처",
    nav_tasks: "할 일",
    tasks_title: "할 일",
    tasks_lede: "노트 전체의 체크박스 항목을 한곳에 모았습니다.",
    tasks_loading: "노트 스캔 중…",
    tasks_empty: "아직 할 일이 없습니다",
    tasks_empty_hint:
      "아무 노트에나 `- [ ] …` 체크박스를 추가하면 여기에 표시됩니다.",
    tasks_ph: "무엇을 해야 하나요?",
    tasks_due: "마감일",
    tasks_add: "추가",
    tasks_stale:
      "목록을 만든 뒤 노트가 바뀌어서 새로 읽었습니다. 다시 시도해 주세요.",
    tasks_view: "보기",
    tasks_view_list: "목록",
    tasks_view_board: "보드",
    tasks_col_todo: "할 일",
    tasks_col_doing: "진행",
    tasks_col_blocked: "보류",
    tasks_col_done: "완료",
    tasks_notify: "마감 알림 받기 — 아침 요약과, 시각을 적은 항목의 개별 알림",
    tasks_view_calendar: "캘린더",
    tasks_cal_today: "오늘",
    tasks_cal_undated: "마감일 없음 ({n})",
    tasks_detail: "할 일",
    tasks_detail_close: "닫기",
    tasks_detail_status: "상태",
    tasks_detail_start: "시작",
    tasks_detail_scheduled: "작업 예정",
    tasks_detail_priority: "우선순위",
    tasks_detail_priority_none: "없음",
    tasks_detail_estimate: "예상 시간",
    tasks_detail_estimate_hint: "90m, 1.5h, 2d, 1w 같은 형식으로 적어 주세요.",
    tasks_detail_recur: "반복",
    tasks_detail_notes: "상세 내용",
    tasks_detail_notes_ph: "세부 내용, 링크, 맥락…",
    tasks_detail_recur_hint:
      "myco가 계산하는 규칙은 \u201cevery day/week/month/year\u201d와 \u201cevery 2 weeks\u201d입니다. 그 밖의 규칙은 노트에 그대로 남습니다.",
    tasks_detail_start_after_due:
      "시작일이 마감일보다 늦어서 마감일에만 표시됩니다. 적어 둔 날짜는 그대로 둡니다.",
    tasks_detail_open_note: "{page} 열기",
    tasks_hub: "일정 페이지 갱신",
    tasks_hub_heading: "{month} 일정",
    tasks_hub_empty: "_이 달에 예정된 일이 없습니다._",
    tasks_hub_written: "월 페이지 {n}개를 갱신했습니다.",
    tasks_hub_kept: "{n}개는 직접 관리하고 있어 그대로 두었습니다.",
    tasks_compose_more: "자세히",
    tasks_compose_category: "카테고리",
    tasks_compose_project: "프로젝트",
    tasks_compose_target: "추가할 위치",
    tasks_compose_daily: "오늘 데일리 노트",
    tasks_new_roadmap: "＋ 새 로드맵…",
    tasks_new_roadmap_ph: "로드맵 제목",
    tasks_view_roadmap: "로드맵",
    tasks_roadmap_empty: "아직 로드맵이 없습니다",
    tasks_roadmap_empty_hint:
      "로드맵은 마일스톤과 체크박스로 된 위키 페이지(wiki/roadmaps/…)입니다 — 만들면 항목이 할 일 전체에 나타납니다.",
    tasks_roadmap_progress: "{done}/{total} 완료",
    tray_sub_waiting_n: "{n}건이 기다려요",
    tray_sub_clear: "기다리는 건 없어요",
    tray_sub_distilling: "증류 중 · {step}",
    tray_now_eyebrow: "승인 대기",
    tray_toast_approved: "{name} 승인됨",
    tray_tile_waiting: "기다리는 것",
    tray_tile_today: "오늘",
    tray_row_links: "제안된 링크",
    tray_row_reflect: "Reflect 제안",
    tray_row_sessions: "세션 · inbox",
    tray_card_tasks_v: "오늘 {n}",
    tray_card_tasks_sub: "지연 {n}",
    tray_last24: "최근 24시간",
    tray_legend_hourly: "시간별",
    dp_prev: "이전 달",
    dp_next: "다음 달",
    dp_clear: "날짜 지우기",
    tasks_open_n: "미완 {n}개",
    tasks_done_n: "완료 {n}개",
    tasks_all_done: "모두 완료 — 남은 항목이 없습니다.",
    tasks_completed: "완료 ({n})",
    nav_study: "학습",
    nav_settings: "설정",
    split_open: "화면 분할",
    split_close: "분할 닫기",
    split_pick: "두 번째 창",
    split_resize: "창 크기 조절",
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
      "myco는 가져온 모든 논문·아티클·노트를 인용 기반으로 연결된 지식 그래프로 만듭니다. 모든 페이지는 마크다운이라, 통제권은 항상 당신에게 있습니다.",
    ov_cta_ingest: "소스 가져오기",
    ov_cta_ask: "위키에 질문",
    ov_stats_pages: "페이지",
    ov_stats_links: "연결",
    ov_stats_ratio: "위키만으로 답변",
    ov_quick: "이어서 보기",
    ov_stats_moved: "이번 주 움직임",
    ov_moved_none: "최근 7일간 쓴 것 없음",
    ov_pulse_alt: "페이지 {pages}개, 연결 {links}개, 이번 주 {moved}개 움직임",
    ov_recent_moved: "최근 움직인 노트",
    ov_recent_never: "아직 바뀐 노트가 없습니다.",
    ing_title: "가져오기",
    ing_lede:
      "파일을 드롭하거나 URL을 붙여넣거나 메모를 입력하세요. Claude가 읽고, 엔티티와 개념을 추출하고, 소스 페이지를 만들고, 그래프에 엮어 넣습니다.",
    ing_drop: "여기에 파일 드롭",
    ing_drop_or: "또는 URL 붙여넣기",
    ing_browse: "파일 선택…",
    ing_drop_multi:
      "{n}개 중 첫 파일만 불러왔습니다 — 이 폼은 한 번에 하나의 소스만 처리합니다. 나머지는 하나씩 드롭하세요.",
    ing_inbox_pending: "_inbox 대기 중 ({n})",
    ing_inbox_empty:
      "대기 중인 파일이 없습니다 — 도착분은 이미 처리되었습니다.",
    ing_inbox_today: "오늘",
    ing_inbox_unsupported_chip: "미지원",
    ing_inbox_unsupported_line: "미지원 {n}건 — 그대로 둡니다.",
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
    ing_live_earlier: "이전 {n}건",
    ing_live_files: "작업한 페이지",
    ing_live_reads: "읽음",
    ing_live_writes: "작성",
    ing_grounded: "갱신할 기존 페이지 {n}개 매칭",
    ing_grounded_hint:
      "이 페이지들로 유도해 중복 생성 대신 기존 페이지를 갱신하도록 했습니다.",
    ing_plan: "인제스트 계획 {n}개",
    ing_plan_hint:
      "이 소스가 무엇을 바꿀지 — 에이전트가 이 계획을 따라 중복 대신 기존 페이지를 갱신합니다.",
    ingest_gate_title: "인제스트 계획 — 적용할 항목을 고르세요",
    ingest_gate_apply: "{n}개만 적용",
    ingest_gate_all: "이 계획대로 전부",
    ingest_gate_noop_hint:
      "NOOP 항목은 이미 위키에 반영되어 있어 기본으로 해제되어 있습니다.",
    ing_cancel: "취소",
    ing_cancelled: "가져오기가 취소되었습니다",
    ing_preview_open: "페이지 열기",
    ing_preview_close: "미리보기 닫기",
    ing_preview_writing: "아직 작성 중입니다 — 잠시 후 다시 눌러보세요.",
    ing_chip_done: "가져오기 완료",
    ing_chip_error: "가져오기 실패",
    q_title: "위키에 질문하기",
    q_lede:
      "myco는 먼저 위키에서 답을 찾고, 부족할 때만 원본 소스로 들어갑니다. 모든 주장에는 인용이 따라옵니다.",
    q_ph: "BPE는 무엇인가요? 미드트레이닝은 파인튜닝과 어떻게 다른가요?",
    q_send: "질문하기",
    q_recent: "최근 질문",
    q_answer: "답변",
    q_sources_used: "참조된 소스",
    q_wiki: "위키",
    q_raw: "원본",
    gr_node_count: "노드",
    gr_edge_count: "연결",
    gr_all: "전체",
    gr_layout_spiral: "나선 은하",
    gr_layout_strata: "연대기",
    gr_layout_semantic: "의미 지도",
    gr_layout_celestial: "천구 별자리",
    gr_layout_radial: "동심 궤도",
    gr_layout_walrus: "월러스 트리",
    mc_label: "MYCO 팁",
    mc_dismiss: "닫기",
    gr_layout_galaxy_s: "은하",
    gr_layout_synapse3d_s: "시냅스",
    gr_layout_atlas_s: "아틀라스",
    gr_open: "페이지 열기",
    gr_empty_pre: "아직 위키링크가 없습니다. ",
    gr_empty_post: " 를 추가하면 그래프가 자랍니다.",
    gr_insp_type: "유형",
    gr_insp_confidence: "신뢰도",
    gr_insp_status: "상태",
    gr_insp_links_out: "나가는 링크",
    gr_insp_backlinks: "백링크",
    gr_insp_open: "리더에서 열기",
    gr_insp_unresolved: "미해결 노트 (파일 없음)",
    gr_insp_none: "—",
    gr_find_ph: "노트 찾기…",
    gr_gaps_title: "갭",
    gr_gap_missing: "없는 페이지",
    gr_gap_orphans: "고립 노드",
    gr_gap_undercited: "인용 부족",
    gr_gap_lowconf: "낮은 신뢰도",
    gr_gap_islands: "끊긴 클러스터",
    gr_gap_none: "갭 없음",
    gr_gap_more: "더",
    q_thinking: "위키를 탐색하는 중…",
    q_answering: "답변 작성 중…",
    q_answering_from: "{n}개 페이지를 근거로 답변 작성 중…",
    gr_loading: "별자리를 정렬하는 중…",
    gr_title: "측량",
    gr_lede: "지도는 하나, 질문은 넷. 질문을 고르면 바뀌는 것은 인코딩(색·크기·흐림)이지 레이아웃이 아니라서, 답끼리 비교가 된다.",
    gr_canvas_aria: "볼트 링크 지도. 방향키로 노트를 옮겨 고르고, Enter 로 엽니다.",
    gr_stage_hint: "한 가지 레이아웃 · 질문이 바꾸는 건 인코딩뿐",
    gr_q_lead: "이 화면이 답하는 질문",
    gr_q_orphans: "어디가 비었나",
    gr_q_orphans_u: "빈 곳",
    gr_q_sub_orphans: "고아 {orphans} · 미해결 {unresolved} · 무백링크 {nobacklink}",
    gr_q_clusters: "무엇이 뭉쳐 있나",
    gr_q_clusters_u: "클러스터",
    gr_q_sub_clusters: "지도 없는 클러스터 {nomap} · 지도 있는 {map}",
    gr_q_time: "최근 무엇이 자랐나",
    gr_q_time_u: "30일 내",
    gr_q_sub_time: "샘플 {sample}개는 설치일에 고정",
    gr_q_neighbors: "이 노트의 이웃",
    gr_q_neighbors_u: "2홉 이웃",
    gr_q_sub_neighbors: "선택한 노트 기준 2홉",
    gr_q_pick: "노트를 하나 고르세요",
    gr_size: "노드 크기 기준",
    gr_size_backlinks: "크기 = 백링크",
    gr_size_cites: "크기 = 인용",
    gr_hide_sample: "샘플 {n}개 숨기기",
    gr_show_unresolved: "미해결 링크 표시",
    gr_rebuilds: "씬 재빌드 {n}회 · {ms} ms",
    gr_honest_lead: "이 그래프가 그리는 건 {n}개 노드",
    gr_honest: "첫 실행 샘플 {sample}개({pct}%) · 내가 쓴 노트 {own}개 · 미해결 {unresolved}개. 인용을 가진 노트는 {cited}개.",
    gr_honest_sessions: "세션 {n}건은 여기에 없다 — sessions/ 는 graphData 의 NON_KNOWLEDGE_FOLDERS 에서 구조적으로 빠진다.",
    gr_gap_nobacklink: "아무도 참조 안 함",
    gr_act_link: "링크 제안",
    gr_act_harvest: "수확 대상으로",
    gr_act_neighbors: "이 노트의 이웃만 보기",
    gr_act_open_s: "열기",
    gr_act_link_s: "링크",
    gr_act_want_s: "수확",
    gr_insp_h: "노트",
    gr_insp_empty: "노트를 하나 고르면 링크·인용·신뢰도와 여기서 나가는 행동이 열립니다.",
    gr_insp_cites: "인용",
    gr_insp_sample: "첫 실행 샘플",
    gr_insp_own: "내 노트",
    gr_insp_nocite: "인용 0",
    gr_cluster_nomap: "지도 없음",
    gr_cluster_map: "지도 있음",
    gr_enc_orphans: "색 = 카테고리 · 크기 = 링크 수 · 흐림 = 이미 연결됨",
    gr_enc_clusters: "블록 = 클러스터 · 점선 테두리 = 지도 페이지 없음 · 점선 = 안 이어진 인접 주제",
    gr_enc_time: "색 = 최근 수정(단일 램프) · 흐림 = 6개월 이상 방치",
    gr_enc_neighbors: "밝기 = 홉 거리(0·1 밝게, 2 흐리게, 그 밖 거의 안 보임)",
    gr_link_question: "볼트에서 \"{a}\" 가 연결되지 않은 채로 있습니다. 어떤 노트가 여기에 링크해야 하고, 그 링크는 무슨 말을 해야 할까요?",
    gr_want_done: "\"{n}\" 을(를) 필요한 주제로 기록했습니다",
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
    p_lint_running:
      "Lint 실행 중 — 다른 페이지로 이동해도 백그라운드에서 계속됩니다.",
    p_lint_done: "Lint 완료",
    p_lint_failed: "Lint 실패",
    s_title: "설정",
    s_search_ph: "설정 검색",
    s_search_empty: "“{q}”에 해당하는 설정이 없습니다",
    s_account: "계정",
    s_local_user: "로컬 사용자",
    s_no_vault: "볼트 없음",
    s_vault_path: "볼트 경로",
    s_change: "변경…",
    q_empty_response: "(응답 없음)",
    eb_title: "{area}에서 문제가 발생했습니다.",
    eb_reload: "myco 다시 불러오기",
    eb_retry: "다시 시도",
    eb_area_app: "앱",
    eb_area_graph: "그래프",
    s_workspace: "워크스페이스",
    s_model: "모델",
    s_embeddings: "의미 검색",
    s_embeddings_lede:
      "의미 검색·관련 노트·그래프 유사도를 위한 온디바이스 임베딩 인덱스를 만듭니다. 오프라인 동작.",
    s_embeddings_indexed: "페이지 인덱싱됨",
    s_embeddings_reindex: "지금 재인덱스",
    s_embeddings_indexing: "인덱싱 중…",
    s_embeddings_empty: "아직 인덱스 없음",
    s_embeddings_loading_model: "모델 로딩 중…",
    s_embeddings_loading_model_hint:
      "첫 실행에는 내장 모델을 불러옵니다 — 몇 초 걸립니다.",
    s_embeddings_done: "{n}개 페이지 인덱싱 완료",
    s_autoreindex_title: "인덱스 자동 최신화",
    s_autoreindex_desc:
      '이 설정과 무관하게 myco는 편집한 페이지를 이미 백그라운드에서 실시간으로 다시 임베딩합니다. 이 옵션을 켜면 볼트가 잠잠해진 뒤 잠시 후 "지금 재인덱스"와 같은 전체 재인덱스를 안전장치로 자동 실행합니다.',
    s_providers: "연결",
    s_appearance: "테마",
    s_vault_known: "myco가 이미 아는 보관함",
    s_ov_theme: "개요 배경",
    s_ov_theme_lede:
      "개요 페이지의 살아있는 배경입니다. 그래프 레이아웃 이름을 그대로 쓰지만 연동되지는 않습니다.",
    ov_theme_mycelium: "균사",
    s_lang: "언어",
    s_about: "정보",
    up_check: "업데이트 확인",
    up_checking: "업데이트 확인 중…",
    up_current: "최신 버전입니다",
    up_downloading: "myco {v} 를 백그라운드에서 내려받는 중…",
    up_ready: "myco {v} 준비 완료",
    up_restart: "다시 시작하면 적용됩니다",
    up_restart_btn: "지금 다시 시작",
    up_unconfigured: "업데이트 채널이 설정되지 않았습니다",
    up_unavailable: "이 플랫폼용 업데이트 채널이 아직 없습니다",
    up_error: "업데이트 확인 실패",
    up_dismiss: "닫기",
    cr_last_crash: "마지막 충돌",
    cr_at: "{time} · {location}",
    cr_copy: "버그 리포트 복사",
    cr_copied: "복사됨",
    cr_note_label: "무엇을 하고 있었나요? (선택)",
    cr_note_ph: "예: 페이지를 편집하다 저장 버튼을 눌렀어요",
    cr_clear: "충돌 로그 지우기",
    cr_cleared: "지워짐",
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
      "myco가 꺼져 있어도 동작 — Claude가 서버를 직접 띄웁니다.",
    mcp_not_found:
      "이 빌드에 MCP 서버 파일이 없습니다. 최신 myco를 다시 설치하세요.",
    mcp_serving: "MCP 서버 실행 중",
    mcp_not_serving: "MCP 서버 중지됨",
    mcp_starting: "MCP 서버 시작 중…",
    mcp_connect_btn: "Claude Code에 연결",
    mcp_connecting: "연결 중…",
    mcp_connect_hint: "또는 터미널에서 한 번 실행:",
    mcp_start_btn: "서버 시작",
    mcp_stop_btn: "중지",
    mcp_registering: "등록 중…",
    s_model_lede:
      "myco는 기본적으로 Claude를 사용합니다. 가져오기와 질문에 서로 다른 모델을 지정할 수 있습니다.",
    s_model_ingest: "가져오기용 모델",
    s_model_query: "질문용 모델",
    model_custom: "직접 입력\u2026",
    model_disconnected: "(연결 안 됨)",
    model_effort: "추론 강도",
    model_custom_ph: "모델 ID",
    model_fetching: "모델 목록 가져오는 중\u2026",
    s_model_recommended: "추천",
    s_model_ctx: "컨텍스트",
    ing_extractive_note:
      "발췌 요약 — 아래 문장은 모두 `raw/{slug}.md`에서 그대로 인용한 것입니다. 이 소스를 읽은 모델이 없으므로, 바꿔 쓴 문장도 추론한 내용도 없습니다.",
    ing_extractive_report_title: "발췌 가져오기: {title}",
    ing_extractive_report_why:
      "이번 실행은 내장 오프라인 경로를 사용했습니다. 소스의 문장을 그대로 인용해 출처를 달았고, 태그는 보관함에 이미 있는 것만 재사용했으며, 관련 페이지는 로컬 임베딩 색인에서 가져왔습니다. **모델은 호출하지 않았습니다.** 소스를 요약한 주체가 없으므로 `confidence`는 `low`입니다. 모델을 연결하고 다시 실행하면 이 페이지를 대체할 수 있습니다.",
    ing_extractive_log:
      "{date} — [[source-{slug}]] ({title}) 발췌 가져오기, 모델 호출 없음",
    ing_extractive_hint:
      "발췌 방식 — 소스를 그대로 인용하며 모델을 호출하지 않습니다.",
    ing_run_extractive: "발췌로 가져오기",
    s_providers_lede:
      "원하는 제공자를 연결하세요. 키는 로컬에만 저장되며, myco 서버는 절대 보지 못합니다.",
    s_provider_connected: "연결됨",
    s_provider_disconnected: "미연결",
    s_provider_cli_missing: "CLI 설치 안 됨",
    s_mycopro_url: "서비스 URL",
    s_mycopro_key: "라이선스 키",
    s_mycopro_email: "이메일",
    s_mycopro_password: "비밀번호",
    s_mycopro_login: "로그인",
    s_mycopro_logout: "로그아웃",
    s_mycopro_loggedin: "로그인:",
    s_mycopro_noaccess: "활성 구독 없음",
    s_autoimport_title: "CLI 세션 자동 수집",
    s_autoimport_desc:
      "myco가 켜져 있는 동안 Claude Code / Codex 대화를 주기적으로 sessions/로 가져옵니다. Ask가 그 내용을 검색해 인용합니다. 짧은 잡음 세션과 이미 가져온 세션은 건너뜁니다. 세션은 유료 인게스트 대상이 아닙니다 — 위키가 아니라 기록이기 때문입니다.",
    s_autoimport_interval: "주기",
    s_autoingest_title: "인박스 자동 인게스트",
    s_autoingest_desc:
      "myco가 켜져 있는 동안 vault의 _inbox/ 폴더에 넣은 소스를 주기적으로 인게스트합니다.",
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
      "myco는 로컬 Obsidian 볼트와 Claude Code CLI 위에서 동작하는 얇은 클라이언트입니다. 페이지는 마크다운 — 당신의 지식은 당신의 것입니다.",
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
    lint_local_title: "위키 린트 — 로컬 패스",
    lint_local_note:
      "모델 없이 규칙 기반 검사만 수행했습니다. 자유 서술형 수정 제안과 " +
      '"언급됐지만 링크되지 않은 개념" 검사는 연결된 프로바이더가 필요합니다.',
    lint_local_clean: "문제를 찾지 못했습니다.",
    lint_sec_critical: "치명적",
    lint_sec_warning: "경고",
    lint_sec_info: "정보",
    lint_k_missing_frontmatter:
      "frontmatter — 필수 필드(title, type, created, confidence, status)를 추가하세요.",
    lint_k_invalid_frontmatter:
      "frontmatter 값이 잘못됨 — 허용된 값 중 하나를 사용하세요.",
    lint_k_dangling_citation:
      "끊어진 인용 — raw/ 원문을 추가하거나 [^src-…] 참조를 제거하세요.",
    lint_k_source_count_mismatch:
      "source_count가 실제와 다름 — 서로 다른 인용 개수로 맞추세요.",
    lint_k_missing_superseded_by:
      "대체된 문서 — 대체한 문서를 가리키는 superseded_by를 추가하세요.",
    lint_k_missing_disputed_section:
      "이견 있는 문서 — 충돌 내용을 설명하는 `## Disputed` 섹션을 추가하세요.",
    lint_k_weak_confidence:
      "출처 2개 미만인데 confidence: high — 출처를 더 인용하거나 confidence를 낮추세요.",
    lint_k_stale_page:
      "active인데 30일 넘게 수정 없음 — 다시 살펴보거나 status를 바꾸세요.",
    lint_k_hedged_claim:
      "출처 1개로 일반화한 서술 — 출처를 추가하거나 주장 범위를 좁히세요.",
    lint_k_orphan_page:
      "고아 문서 — 들어오는 링크가 없습니다. 관련 문서에서 링크하세요.",
    lint_k_unresolved_link:
      "해석되지 않는 위키링크 — 문서를 만들거나 링크 이름을 고치세요.",
    p_dismiss: "닫기",
    p_open_vault: "출처를 스캔하려면 vault를 여세요.",
    p_scanning: "vault 스캔 중…",
    p_empty: "아직 주장이 담긴 노트가 없습니다 — 본문을 추가해 보세요.",
    p_overall: "전체",
    p_claims_cited: "주장 인용됨",
    p_pages_by_coverage: "페이지별 인용 커버리지",
    rd_source: "소스",
    rd_preview: "미리보기",
    rd_live: "실시간",
    rd_task_toggle: "할 일 완료 전환",
    rd_frontmatter_hidden: "frontmatter 숨김 — 속성 패널 또는 소스에서 편집",
    rd_backlinks_empty: "아직 여기로 연결된 노트가 없습니다.",
    rd_related: "관련 노트",
    rd_related_no_index:
      "관련 노트는 아직 만들지 않은 온디바이스 인덱스에서 나옵니다.",
    rd_related_no_index_cta: "의미 검색 설정하기",
    rd_make_cards: "카드 만들기",
    rd_making: "생성 중…",
    rd_cards_none: "생성된 카드가 없습니다.",
    rd_cards_made: "카드 {n}개 추가됨",
    rd_open_study: "학습 열기",
    rd_more: "더 보기",
    rd_rail: "노트 레일",
    rd_rail_toggle: "노트 레일 표시/숨기기",
    rd_src_title: "출처와 신뢰",
    rd_src_scanning: "볼트의 인용을 읽는 중…",
    rd_src_no_claims: "아직 근거를 붙일 주장이 없습니다.",
    rd_src_coverage: "주장 {total}줄 중 {cited}줄에 인용",
    rd_src_bar: "인용 커버리지 {pct} 퍼센트",
    rd_src_none: "이 노트에는 근거가 하나도 없습니다. 없는 출처를 지어내지 않습니다.",
    rd_src_broken: "raw/ 원본 없음 — 끊긴 인용",
    rd_src_hand: "직접 작성",
    rd_src_weight: "묻기가 이 계층에 적용하는 신뢰 가중치",
    rd_src_uncited: "미인용 주장 {n}건",
    rd_src_all: "전체 커버리지",
    rd_conn_title: "연결",
    rd_conn_empty: "아직 연결이 없습니다.",
    rd_conn_back: "백링크",
    rd_conn_sug: "제안",
    rd_conn_added: "## Related 에 [[{name}]] 추가",
    rd_auth_title: "이 문단을 쓴 사람",
    rd_auth_agent: "에이전트가 씀",
    rd_auth_human: "사람이 씀",
    rd_auth_revert: "이 문단 되돌리기",
    rd_auth_locked: "이 문단은 두 개 이상의 커밋이 썼습니다 — 돌아갈 판이 하나가 아닙니다.",
    rd_auth_human_only: "되돌릴 에이전트 편집이 없습니다.",
    rd_auth_history: "기록에서 보기",
    rd_auth_reverted: "문단을 이전 판으로 되돌렸습니다",
    rd_auth_nothing: "이전 판에도 이 문단이 그대로 있습니다.",
    rd_auth_failed: "이전 판을 읽지 못했습니다.",
    rd_claim_dot: "이 문단에는 근거가 없습니다",
    rd_claim_title: "출처 없는 주장",
    rd_claim_hint: "이 문단은 아무것도 가리키지 않습니다.",
    rd_claim_find: "출처 찾기",
    rd_claim_searching: "볼트 검색 중…",
    rd_claim_none: "볼트에 근거가 없습니다 — 근거 없음으로 남깁니다.",
    rd_claim_added: "[[{name}]] 로 근거를 달았습니다",
    // Editor basics (P1): CodeMirror search/completion phrases, `/` block names.
    cm_find: "찾기",
    cm_replace_field: "바꾸기",
    cm_next: "다음",
    cm_previous: "이전",
    cm_all: "모두",
    cm_match_case: "대소문자 구분",
    cm_by_word: "단어 단위",
    cm_regexp: "정규식",
    cm_replace: "바꾸기",
    cm_replace_all: "모두 바꾸기",
    cm_close: "닫기",
    cm_current_match: "현재 일치 항목",
    cm_replaced_matches: "$개 항목을 바꿨습니다",
    cm_replaced_on_line: "$번째 줄의 항목을 바꿨습니다",
    cm_on_line: "줄",
    cm_goto_line: "줄 이동",
    cm_go: "이동",
    cm_completions: "자동 완성",
    sl_h1: "제목 1",
    sl_h2: "제목 2",
    sl_h3: "제목 3",
    sl_bullet: "글머리 기호 목록",
    sl_numbered: "번호 목록",
    sl_todo: "할 일",
    sl_code: "코드 블록",
    sl_quote: "인용",
    sl_table: "표",
    sl_divider: "구분선",
    sl_date: "오늘 날짜",
    img_unsupported: "PNG, JPEG, GIF, WebP 이미지만 넣을 수 있습니다",
    img_failed: "이미지를 저장하지 못했습니다: {error}",
    ol_title: "개요",
    ol_empty: "아직 제목이 없습니다",
    ol_untitled: "(제목 없음)",
    ol_toggle: "개요 표시/숨기기",
    props_title: "속성",
    props_add: "속성 추가",
    props_key_ph: "키",
    props_value_ph: "값",
    props_add_confirm: "추가",
    props_remove: "{key} 제거",
    props_bad_key: "키는 영문자로 시작해 영문·숫자·_·-만 사용할 수 있으며 이미 있는 키는 쓸 수 없습니다",
    props_complex: "복합 값 — 소스에서 편집하세요",
    props_tags_ph: "태그 추가…",
    props_tag_remove: "태그 제거",
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
    au_needs_provider:
      "오디오 개요는 글을 새로 쓰는 기능이라 AI 프로바이더가 필요합니다. 설정 → 모델에서 선택하세요.",
    bf_title: "세션 백필",
    bf_desc: "코딩 세션이 아카이브에만 쌓이고 위키가 되지 못했습니다. 한 묶음씩 ingest 큐로 올리면 평소 파이프라인이 인용된 노트로 만듭니다.",
    bf_waiting: "대기",
    bf_done: "위키화됨",
    bf_skipped: "너무 짧음",
    bf_held: "너무 큼",
    bf_promote: "다음 {n}개 올리기",
    bf_promoted: "세션 {n}개를 ingest 큐에 올렸습니다",
    bf_held_note: "{n}개는 한 번에 처리하기엔 너무 커서 건너뛴 게 아니라 보류 중입니다.",
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
    s_distill: "증류",
    set_distill_loading: "불러오는 중…",
    set_distill_lede:
      "새로 들어온 페이지를 위키의 온톨로지에 주기적으로 편입시켜, 흡수된 것은 보관하고 나머지는 병합을 제안합니다.",
    set_distill_enabled_title: "자동 증류",
    set_distill_enabled_desc:
      "myco가 열려 있고 자리를 비웠을 때, 자체 일정에 따라 백로그를 증류합니다.",
    set_distill_intensity: "강도",
    set_distill_intensity_conservative: "보수",
    set_distill_intensity_standard: "표준",
    set_distill_intensity_aggressive: "적극",
    set_distill_gate: "게이트 프리셋",
    set_distill_gate_strict: "엄격",
    set_distill_gate_normal: "보통",
    set_distill_gate_loose: "느슨",
    set_distill_count_trigger: "백로그 개수 트리거",
    set_distill_ttl: "격리 TTL (일)",
    set_distill_budget: "실행 예산 (항목 수)",
    set_distill_idle_minutes: "유휴 시간 (분)",
    set_distill_maturation: "숙성 시간 (시간)",
    set_distill_llm_digest_days: "실행당 다이제스트 일수",
    set_distill_llm_ingest_budget:
      "실행당 LLM 항목 예산 (인제스트 + 지도 초안 합산)",
    set_distill_profile_injection_title: "프로필 주입",
    set_distill_profile_injection_desc:
      "profile.md를 Ask/인제스트 컨텍스트로 설정된 AI 프로바이더에 전송합니다. 끄면 프로필은 로컬에만 남습니다.",
    set_distill_status_title: "상태",
    set_distill_backlog: "백로그: {n}",
    set_distill_pending: "대기 중인 제안 {n}건",
    set_distill_trend_shrinking: "줄어드는 중",
    set_distill_trend_growing: "늘어나는 중",
    set_distill_trend_flat: "변화 없음",
    set_distill_run_now: "지금 증류",
    set_distill_running: "증류 중…",
    set_distill_report: "보관 {a}건, 폐기 {tr}건, 제안 {p}건 — 백로그 {b}건",
    set_distill_busy: "이미 증류가 진행 중입니다.",
    set_distill_undo: "이 실행 되돌리기",
    set_distill_undoing: "되돌리는 중…",
    set_distill_undo_result: "{n}건 되돌림",
    set_runs_title: "지난 실행",
    set_distill_gate_pending: "증류 대기: 위키 페이지 {n}/{min}",
    set_distill_digest_extractive:
      "세션 다이제스트를 추출 방식으로 실행했습니다 (LLM 없이 인용 발췌). 요약 다이제스트를 원하면 설정 → 모델(쿼리)에서 프로바이더를 연결하세요.",
    set_distill_quarantined: "{path}에 검토 대기 중인 항목 {n}건",
    set_distill_stop: "중지",
    set_distill_stopping: "현재 단계 후 중지…",
    set_distill_stopped: "{step} 후 중지됨",
    set_distill_step_run: "코어 패스",
    set_distill_step_digest: "세션 다이제스트",
    set_distill_step_ingest: "전체 계층 인제스트",
    set_distill_step_maps: "맵 초안",
    set_distill_step_weekly: "주간 롤업",
    set_distill_step_monthly: "월간 롤업",
    set_distill_step_resurface: "다시 만나기 후보",
    set_distill_weekly_rollups: "weekly/에 주간 롤업 {n}건 작성",
    set_distill_monthly_rollups: "monthly/에 월간 롤업 {n}건 작성",
    set_archive_title: "아카이브 용량",
    set_archive_lede:
      "다이제스트된 세션과 롤업된 일간 노트는 sessions/archive/, daily/archive/에 영구 보관됩니다. 오래된 버킷을 압축하면 zip 하나로 묶이며 언제든 복원할 수 있습니다. raw/는 건드리지 않습니다.",
    set_archive_measure: "측정",
    set_archive_measuring: "측정 중…",
    set_archive_empty: "아직 보관된 항목이 없습니다.",
    set_archive_total: "버킷 {buckets}개, 파일 {files}개, {size}",
    set_archive_tree_sessions: "세션",
    set_archive_tree_daily: "일간",
    set_archive_tree_weekly: "주간",
    set_archive_packed: "압축됨",
    set_archive_older_than: "{n}개월 이상 지난 버킷 압축",
    set_archive_compress: "압축",
    set_archive_compressing: "압축 중…",
    set_archive_compressed:
      "버킷 {buckets}개(파일 {files}개) 압축, {size} 확보",
    set_archive_nothing_old: "{n}개월 이상 지난 버킷이 없습니다.",
    set_archive_failed: "그대로 둔 버킷: {list}",
    set_archive_restore: "복원",
    set_archive_restoring: "복원 중…",
    set_archive_restored: "{bucket}에 파일 {n}개 복원",
    set_profile_title: "프로필",
    set_profile_lede:
      "증류와 Ask/인제스트 컨텍스트를 개인화합니다. profile.md에 저장되며, 주입이 켜져 있으면 설정된 AI 프로바이더로 전송됩니다.",
    set_profile_role: "역할",
    set_profile_goals: "목표 (줄바꿈으로 구분)",
    set_profile_interests: "관심사 (줄바꿈으로 구분)",
    set_profile_style: "작업 스타일",
    set_profile_save: "저장",
    set_profile_saving: "저장 중…",
    set_profile_saved: "저장됨",
    nav_feedback: "수확함",
    ov_distill_last_run: "마지막 실행 {t}",
    ov_distill_never: "아직 실행 기록 없음",
    ov_distill_llm_queued:
      "본문 승격·맵 제안 대기 — 프로바이더 연결 필요 (다이제스트는 로컬로 실행됨)",
    ov_distill_done:
      "증류 완료 — 아카이브 {a}건 · 다이제스트 {d}일 · 주간 롤업 {w}건 · 제안 {p}건",
    ov_distill_done_months: " · 월간 롤업 {m}건",
    ov_distill_done_none: "증류 완료 — 처리할 항목 없음",
    pf_title: "수확함",
    pf_lede:
      "증류 엔진이 새 페이지를 위키의 온톨로지에 접어넣으며 작성한 제안입니다 — 검토 후 적용하거나 무시하세요.",
    pf_empty: "대기 중인 제안이 없습니다.",
    pf_kind_admit: "클러스터 수용",
    pf_kind_archive: "일괄 보관",
    pf_kind_delete: "일괄 삭제",
    pf_kind_draft_map: "토픽 맵 작성",
    pf_created: "생성",
    pf_expand: "펼치기",
    pf_collapse: "접기",
    pf_approve: "승인",
    pf_dismiss: "무시",
    pf_confirm_title: "이 제안을 적용할까요?",
    pf_confirm_msg: "{n}개 파일이 이동되거나 보관됩니다.",
    pf_confirm_msg_draft_map: "지도 초안을 생성합니다 (LLM 호출 1회).",
    pf_retry: "재시도",
    pf_apply_failed: "적용 실패 — 재시도",
    pf_tab_proposals: "제안",
    pf_tab_quarantine: "격리 {n}",
    qz_empty: "격리된 항목이 없습니다.",
    qz_lede:
      "심사 게이트가 주제에서 벗어났다고 판단한 항목입니다. 삭제된 게 아니라 보관 중이니, 필요한 것은 되돌리고 아닌 것은 버리세요.",
    qz_verdict_offtopic: "주제 불일치: {numbers}",
    qz_verdict_sim: "유사도 {sim}",
    qz_verdict_sim_vs: "유사도 {sim} · 기준 {min}",
    qz_verdict_nearest: "(가장 가까운 주제: {topic})",
    qz_verdict_unknown: "이 항목에는 판정 기록이 없습니다.",
    qz_expires_in: "{n}일 남음",
    qz_expires_due: "기한 만료 — 다음 실행에서 휴지통으로 옮겨질 수 있습니다",
    qz_expires_unknown: "만료 기한 기록 없음",
    qz_restore: "볼트로 복원",
    qz_delete: "삭제",
    qz_keep: "{n}일 더 보관",
    qz_confirm_delete_title: "이 항목을 삭제할까요?",
    qz_confirm_delete_msg:
      "{name}을(를) 시스템 휴지통으로 옮깁니다(복구 가능).",
    tb_activity_quarantine: "검토 대기 {n}건",
    tb_activity_gone: "그 항목은 이미 처리되어 사라졌습니다.",
    ing_title_label: "제목",
    ing_title_ph: "예: Byte Pair Encoding",
    ing_working: "작업 중…",
    ingest_no_changes:
      "경고: 모델이 작업을 마쳤지만 위키 페이지가 생성되거나 수정되지 않았습니다. 원본은 raw/{slug}.md에 저장되었지만 위키에는 반영되지 않았습니다. 위 모델 출력을 확인하거나 Claude Code(CLI) 제공자를 사용해 보세요.",
    ingest_validation_failed:
      "인제스트 검증 실패 — 다음 문제를 해결해야 인제스트를 수락할 수 있습니다:",
    ingest_validation_warnings: "검증 경고(차단하지 않음):",
    hq_title: "세션 {n}개가 위키에 들어갈 만합니다",
    hq_lede:
      "세션 파일 {total}개 → 서로 다른 본문 {distinct}개 · 8 KB–200 KB · 가까운 위키 클러스터 순. sessions/는 읽기만 하고 복사본이 _inbox/로 갑니다.",
    hq_never_run: "한 번도 수확된 적이 없습니다 — 아래 페이지가 전부 첫 수확입니다.",
    hq_progress: "지금까지 {done}개 수확 — 남은 후보 {left}개 중 {shown}개, 최신순.",
    hq_kpi_label: "인용",
    hq_harvest_btn: "{n}개 수확",
    hq_select_all: "전체 선택",
    hq_clear_all: "전체 해제",
    hq_est_none: "고른 세션이 없습니다 — 인용 {base} 그대로",
    hq_est: "위키 페이지 {n} · 인용 {base} → {goal}",
    hq_excluded_line:
      "중복·보일러플레이트 {n}건 자동 제외 — 큐는 이미 걸러진 상태입니다",
    hq_ex_col_reason: "제외 사유",
    hq_ex_col_count: "건수",
    hq_ex_col_why: "판정 근거",
    hq_ex_duplicate: "동일 본문",
    hq_ex_duplicate_why:
      "먼저 본 파일과 본문 지문이 같음. 실측: 최다 중복 두 건은 4단어 대화록의 사본 269 + 267개였습니다.",
    hq_ex_boilerplate: "보일러플레이트",
    hq_ex_boilerplate_why: "대화 없이 프롬프트 틀만 남은 파일.",
    hq_ex_too_small: "분량 미달 (8 KB 미만)",
    hq_ex_too_small_why:
      "위키화 하한 미달 (backfill.rs::MIN_BYTES). 위 중복과 겹칩니다.",
    hq_ex_too_large: "보류 (200 KB 초과)",
    hq_ex_too_large_why:
      "건너뛴 것이 아니라 보류 — 나눠 넣으면 큐로 돌아옵니다 (backfill.rs::MAX_BYTES).",
    hq_ex_already_harvested: "이미 수확됨",
    hq_ex_already_harvested_why: "복사본이 이미 인제스트 패스를 거쳤습니다.",
    hq_ex_note:
      "제외는 파일을 하나도 만들지 않습니다. 원본 sessions/는 그대로 두고 판정 결과만 기록됩니다.",
    hq_row_select: "수확 대상 선택: {name}",
    hq_near: "근접도 {score}",
    hq_unclustered: "가까운 페이지 없음",
    hq_cites_plus: "인용 +{n}",
    hq_preview: "미리보기",
    hq_collapse: "접기",
    hq_will_copy: "복사 위치",
    hq_will_cluster: "붙을 클러스터",
    hq_will_cites: "인용",
    hq_wont:
      "만들지 않는 것: 새 소스 파일 0개. 원본 {rel}은 복사만 되고 수정되지 않습니다.",
    hq_plan_title: "실행 계획 — 아직 아무것도 만들지 않았습니다",
    hq_plan_sub:
      "선택한 {n}개 세션 ({kb}). 실행을 누르기 전까지 파일은 하나도 생기지 않습니다.",
    hq_plan_copy: "세션 {n}개를 _inbox/로 복사 — 원본은 sessions/에 그대로",
    hq_plan_pass:
      "복사본마다 인제스트 패스 1회 — 검색 그라운딩 → 플래너 → 작성 에이전트",
    hq_plan_cites: "인용 {base} → {goal} (예상, +{n})",
    hq_plan_note:
      "패스는 소비한 복사본을 보관 처리합니다. sessions/에는 쓰지 않습니다.",
    hq_plan_cancel: "취소",
    hq_plan_run: "실행",
    hq_plan_running: "실행 중 — {total}개 중 {done}개 완료",
    hq_done_title: "{n}개 수확 완료",
    hq_done_sub: "인용 {base} → {goal}",
    hq_done_partial:
      "{copied}개 복사 · {ingested}개 인제스트 — 나머지는 _inbox/에서 대기",
    hq_failed: "수확 실패",
    hq_empty_title: "승격 대상이 남지 않았습니다",
    hq_empty_body:
      "서로 다른 본문 {distinct}개 중 지금 승격할 것이 없습니다. 보류(200 KB 초과) 세션과 8 KB를 넘는 새 대화는 다시 이 큐로 들어옵니다.",
    hq_empty_cta: "소스 가져오기",
    hq_loading: "sessions/ 훑는 중…",
    hq_error: "세션 아카이브를 읽지 못했습니다",
    hq_retry: "다시 시도",
    ing_refused_title: "내용이 없어 저장하지 않았습니다 · {reason}",
    ing_logged_title: "원본만 보관했습니다 · {reason}",
    ing_noop_reason: "계획 전부 NOOP — 위키에 더할 것이 없습니다",
    ing_gate_none_reason: "계획 게이트에서 승인된 항목 없음",
    sv_rail_label: "파이프라인 진행 상태",
    sv_step_intake: "유입",
    sv_step_judge: "판정",
    sv_step_gate: "계획 게이트",
    sv_step_run: "실행",
    sv_step_backfill: "백필 큐",
    sv_today_n: "오늘 {n}건",
    sv_tally: "버림 {d} · 기록 {l} · 수확 {h}",
    sv_waiting: "대기 중",
    sv_reviewing: "검토 중",
    sv_idle: "유휴",
    sv_running: "실행 중",
    sv_done: "완료",
    sv_failed: "실패",
    sv_queue_n: "{n}건 대기",
    sv_judge_eyebrow: "2 · 판정 — 이 화면의 중심",
    sv_judge_title: "판정",
    sv_judge_lede:
      "모든 유입은 파일을 만들기 전에 버림 / 기록 / 수확으로 분류됩니다. 버림은 파일 0개, 모델 호출 0회, 판정 로그 한 줄만 남습니다.",
    sv_meta_session: "이번 세션 판정 {n}건",
    sv_meta_saved: "아낀 모델 호출 {n}회",
    sv_drop: "버림",
    sv_drop_sub: "생성 파일 0개",
    sv_log: "기록",
    sv_log_sub: "raw/ 보관 · 모델 0회",
    sv_harvest: "수확",
    sv_harvest_sub: "계획 게이트로",
    sv_dz_sub:
      "이 창 어디에나 텍스트·마크다운 파일을 놓으세요 — 판정 뒤에야 파일이 생성됩니다.",
    sv_verdicts_title: "판정 결과",
    sv_verdicts_empty:
      "이번 세션에서 판정한 항목이 없습니다 — 위에 파일을 놓거나 텍스트를 붙여넣으세요.",
    sv_out_drop: "파일 0개 · 모델 0회",
    sv_out_noop: "파일 0개 · 모델 1회",
    sv_out_log: "raw/ 1개 · 위키 0개",
    sv_out_harvest: "인제스트 완료",
    sv_excl_line: "이번 세션 {n}건 자동 제외 — 이유 보기",
    sv_excl_none: "이번 세션 제외 0건",
    sv_excl_col_rule: "판정 규칙",
    sv_excl_col_count: "건수",
    sv_excl_col_last: "최근 사유",
    sv_channels: "유입 채널",
    sv_ch_sessions: "세션 스윕",
    sv_ch_clipper: "웹 클리퍼",
    sv_ch_mcp: "MCP 도구",
    sv_ch_zotero: "Zotero · 파일",
    sv_ch_inbox: "_inbox 대기열",
    sv_ch_manual: "수동",
    sv_bf_eyebrow: "5 · 백필 큐 — 이 화면에서 가장 큰 미개봉 입력",
    sv_bf_eligible: "수확 가치 있음",
    sv_bf_eligible_sub: "8 KB ≤ 크기 ≤ 200 KB",
    sv_bf_total: "아카이브 총계",
    sv_bf_distinct: "서로 다른 본문",
    sv_bf_batch_label: "배치 크기",
    sv_bf_cost:
      "모델 호출 ≈ {calls}회 (계획 {n} + 작성 {n}) · 판정을 먼저 거치므로 중복은 비용 0",
    sv_bf_skipped: "{n}건 건너뜀",
    q_via: "{provider} · {model} 사용",
    q_via_retrieval:
      "로컬 시맨틱 검색 기반 — 답변은 내 노트 원문 인용 (모델 미사용)",
    q_builtin_note:
      "내장 오프라인 모델(Gemma 3 1B)은 작아서 부정확할 수 있습니다. 오프라인이라면 Ollama로 더 큰 모델(예: gemma3:4b)을 돌려보고, 가장 정확한 답변은 Claude를 쓰세요.",
    q_builtin_extractive_note:
      "답변은 내 노트에서 가장 일치하는 구절을 그대로 보여줍니다. 정리된 답변이 필요하면 모델 설정에서 AI 프로바이더를 선택하세요.",
    q_open_model_settings: "모델 설정",
    q_stale_index:
      "이 답변은 검색 인덱스 대신 전체 볼트를 사용했습니다 — 모델 업데이트 이후 인덱스가 오래되었습니다.",
    q_retrieval_failed:
      "검색 인덱스에 접근할 수 없어, 이 답변은 의미 검색을 건너뛰고 볼트를 직접 읽어 작성했습니다. 계속 반복되면 모델 설정에서 ‘지금 재인덱스’를 실행해 보세요.",
    q_extractive_label: "내 노트에서 찾음 (상위 일치 원문)",
    q_extractive_empty:
      "위키 인덱스에서 관련 내용을 찾지 못했습니다. 질문을 바꿔 보거나, 모델 설정에서 “지금 재인덱스”를 실행해 보세요.",
    q_extractive_stale:
      "검색 인덱스가 모델 업데이트 이전에 만들어져 검색할 수 없습니다. 모델 설정에서 “지금 재인덱스”를 실행한 뒤 다시 질문해 주세요.",
    q_extractive_failed:
      "검색 인덱스에 접근할 수 없어 관련 구절을 가져오지 못했습니다. 계속되면 모델 설정에서 “지금 재인덱스”를 실행해 주세요.",
    q_range_chip: "기간: {s} – {e}",
    q_range_empty: "해당 기간의 기록에서 답을 찾지 못했습니다.",
    q_cite_conf_high: "일치도 높음",
    q_cite_conf_medium: "일치도 보통",
    q_cite_conf_low: "일치도 낮음",
    q_cite_conf_lexical: "키워드 일치",
    q_cite_conf_tip:
      "{page} — 유사도 {sim} (임베딩 코사인, {floor} 미만 구절은 표시하지 않음)",
    q_cite_conf_lexical_tip:
      "{page} — 키워드로만 일치해 유사도 점수가 없습니다",
    q_cite_tier_note: "내가 쓴 노트",
    q_cite_tier_map: "초안 지도",
    q_cite_tier_digest: "일일 요약",
    q_cite_tier_rollup: "주간 요약",
    q_cite_tier_monthly: "월간 요약",
    q_cite_tier_session: "세션 로그",
    q_cite_tier_source: "가져온 원문",
    q_cite_list_label: "인용 신뢰도와 출처 종류",
    q_uncited_row: "검토했지만 인용하지 않음 · {n}",
    ask_profile_hint:
      "프로필을 설정하면 Ask가 역할과 관심사에 맞춰 답변합니다.",
    ask_profile_hint_cta: "프로필 설정",
    ask_profile_hint_dismiss: "닫기",
    q_chip_done: "답변 완료",
    q_chip_error: "답변 실패",
    q_you: "나",
    q_miss_btn: "기대한 답이 아니었나요? 기록하기",
    // Ask renewal (mockup "Strata").
    q_scope_label: "검색 범위",
    q_scope_wiki: "위키",
    q_scope_sessions: "세션",
    q_scope_all: "전체",
    q_scope_help:
      "위키는 노트·맵·다이제스트를, 세션은 대화 기록을 검색합니다 — 설정 › 시맨틱 검색에서 켜면 아카이브된 세션까지 훑습니다. 전체는 둘 다입니다.",
    q_scope_chip: "범위 · {scope}",
    q_trace_title: "검색 경로",
    q_trace_toggle: "단계별 보기",
    q_trace_candidates: "후보",
    q_trace_candidates_sub: "색인된 페이지",
    q_trace_bm25: "BM25",
    q_trace_bm25_sub: "어휘 전용 히트 (코사인 없음)",
    q_trace_dense: "벡터",
    q_trace_dense_sub: "코사인이 있는 히트",
    q_trace_rrf: "RRF",
    q_trace_rrf_sub: "k=60 순위 융합 — 신뢰도가 아님",
    q_trace_cap: "상한",
    q_trace_cap_sub: "최대 {k}청크 · 페이지당 2",
    q_trace_floor: "바닥선",
    q_trace_floor_sub: "코사인 {floor} 미만",
    q_trace_cold: "냉동",
    q_trace_cold_on: "포함",
    q_trace_cold_off: "제외",
    q_trace_cold_on_sub: "세션 범위에서 sessions/archive/까지 검색",
    q_trace_cold_off_sub: "sessions/archive/는 제외 (설정 › 시맨틱 검색)",
    q_trace_params:
      "BM25 k1=1.2 · b=0.75 · RRF k=60 · 바닥선 {floor} — retrieval.rs 그대로. RRF 점수는 순위 값이라 신뢰도가 아닙니다.",
    q_cite_aria: "인용 {n} — {stem}, 관련도 {sim}, {tier}",
    q_cite_sim_none: "키워드만",
    q_ladder_title: "출처 사다리",
    q_ladder_hint: "인용 번호에 마우스를 올리거나 포커스하면 그 문장을 뒷받침한 줄이 켜집니다.",
    q_ladder_count: "{n}개 · 인용 {c}개",
    q_ladder_lead_same: "이 질문에서는 계층 가중치가 순위를 바꾸지 않습니다.",
    q_ladder_lead_moved: "{stem} ({tier}) — 가중치 없이는 {before}위, 켜면 {after}위.",
    q_ladder_up: "계층 가중치로 {n}칸 상승",
    q_ladder_down: "계층 가중치로 {n}칸 하락",
    q_ladder_same: "순위 변화 없음",
    q_ladder_archived: "아카이브",
    q_ladder_sr:
      "각 행은 코사인 관련도, 계층 가중치, RRF × 가중치 = 최종 점수, 가중치 없는 순서 대비 순위 변화를 보여줍니다.",
    q_prior_advanced: "고급",
    q_prior_title: "계층 사전확률",
    q_prior_formula: "최종 = RRF × 가중치",
    q_prior_app: "앱 현재 동작 (전부 1.00)",
    q_prior_defaults: "제안 기본값",
    q_prior_next: "다음 질문부터 적용됩니다 — 위의 사다리는 지금 미리 보여줍니다.",
    q_prior_slider: "{tier} 계층 가중치",
    q_abstain_title: "이 질문에 답할 근거가 볼트에 없습니다.",
    q_abstain_sub:
      "“{q}” — 색인된 {n}쪽 중 관련도 바닥선 {floor}을 넘은 구절이 없습니다. 그럴듯한 문장을 지어내는 대신 여기서 멈춥니다.",
    q_abstain_near: "가장 가까웠던 것들 — 전부 바닥선 아래",
    q_abstain_none: "어휘·의미 어느 쪽도 아무것도 가져오지 못했습니다.",
    q_abstain_lexical: "키워드만",
    q_abstain_gauge_note:
      "붉은 눈금이 바닥선 {floor}입니다. “키워드만”은 코사인이 없는 어휘 전용 히트로, 단독으로는 근거가 되지 못합니다.",
    q_abstain_floor_tick: "바닥선 {floor}",
    q_abstain_harvest: "이 질문을 수확 대상으로",
    q_abstain_harvested: "수확 큐에 등록됨 · 1건",
    q_abstain_widen: "세션까지 넓혀 다시 검색",
    q_abstain_foot: "기권도 답입니다 — 기록된 공백은 다음 수확이 채울 수 있습니다.",
    q_abstain_receipt: "파일 0개 생성. 회수 실패 로그에 1건 기록했습니다.",
    s_archived_sessions_title: "아카이브된 세션도 검색",
    s_archived_sessions_desc:
      "세션 범위가 sessions/archive/까지 검색합니다 — 색인이 평소 제외하는 냉동 계층입니다. 켜면 다시 색인합니다.",
    sb_new_note: "새 노트",
    sb_new_folder: "새 폴더",
    sb_rename: "이름 바꾸기…",
    sb_today_note: "오늘의 노트",
    sb_new_note_msg: "노트 제목 (.md는 자동으로 붙습니다)",
    sb_new_note_ph: "제목 없음",
    sb_delete_folder_q: "폴더를 삭제할까요?",
    sb_delete_file_q: "파일을 삭제할까요?",
    sb_favorites: "즐겨찾기",
    sb_recent: "최근 수정",
    sb_fav_add: "즐겨찾기에 추가",
    sb_fav_remove: "즐겨찾기에서 제거",
    sb_move_to: "이동…",
    sb_move_title: "항목 {n}개 이동",
    sb_move_root: "볼트 루트",
    sb_delete_n: "{n}개 항목 삭제",
    sb_delete_n_q: "{n}개 항목을 삭제할까요?",
    sb_delete_msg: "항목 {n}개가 휴지통으로 이동합니다.",
    sb_delete_one_msg: "“{name}”이(가) 휴지통으로 이동합니다.",
    sb_selected: "{n}개 선택",
    sb_clear_selection: "선택 해제",
    sb_new_folder_msg: "폴더 이름",
    sb_rename_msg: "“{name}”의 새 이름:",
    sb_empty_vault: "빈 볼트",
    sb_no_vault: "선택된 볼트가 없습니다",
    cb_no_results: "결과 없음",
    cb_tag_page: "페이지",
    cb_tag_file: "파일",
    cb_tag_action: "동작",
    cb_in_contents: "페이지 본문에서",
    cb_semantic: "관련 (의미)",
    cb_exact: "정확 일치",
    cb_operator_hint: "따옴표는 정확 일치 · path: · tag: · type: · status: · confidence:",
    cb_miss_hint:
      "기대한 문서가 없나요? ⌥⏎ 로 이 검색을 평가 세트에 기록합니다.",
    cb_miss_done: "평가 세트에 기록했습니다.",
    sb_harvest_badge: "수확 후보 세션 {n}건",
    sb_proposals_badge: "승격 제안 {n}건 대기",
    cb_tag_lens: "렌즈",
    sb_status: "상태",
    sb_st_vault: "볼트",
    sb_st_index: "인덱스",
    sb_st_model: "모델",
    sb_st_on: "실행 중",
    sb_st_off: "중단됨",
    sb_st_mcp_down:
      "MCP 서버가 멈췄습니다 — 에이전트와 Claude Code가 이 볼트에 닿을 수 없습니다.",
    sb_st_lagging: "위키 {n}개가 인덱스 밖에 있습니다 — 질문에서 검색되지 않습니다.",
    sb_st_simulate: "고장 시뮬레이션",
    s_val_on: "켜짐",
    s_val_off: "꺼짐",
    s_changed_only: "변경된 설정만",
    s_search_clear: "검색어 지우기",
    s_show_all: "전체 설정 보기",
    s_total_count: "설정 {all}개 중 {n}개",
    tb_lint: "린트",
    tb_toggle_sidebar: "사이드바 토글 (⌘B)",
    tb_back: "뒤로 (⌘[)",
    tb_forward: "앞으로 (⌘])",
    tb_model_picker: "모델 상태",
    tb_model_ready: "준비됨",
    tb_model_offline: "오프라인",
    tb_model_open_settings: "모델 설정 열기",
    tb_activity_label: "백그라운드 활동",
    tb_activity_n: "활동 {n}",
    tb_activity_running: "진행 중",
    tb_activity_links: "제안된 링크 {n}개",
    tb_activity_reflect: "Reflect 제안 {n}개",
    tb_activity_applying: "제안 적용 중…",
    tb_activity_mcp_on: "MCP 서버 실행 중",
    tb_activity_mcp_off: "MCP 서버 꺼짐",
    tb_activity_tasks: "할 일",
    tb_activity_tasks_more: "+{n}개 더",
    tb_activity_map_notes: "노트 {n}개",
    tb_activity_map_wait:
      "승인은 저장되지만 초안 작성에는 질의 모델이 필요합니다 — 로컬 모델은 맵을 쓰지 못합니다.",
    tb_inflow_header: "오늘 들어온 것",
    tb_inflow_sessions: "세션 수집",
    tb_inflow_last_sweep: "마지막 수집 {t}",
    tb_inflow_auto: "자동 {m}분",
    tb_inflow_mcp: "MCP 도구 호출",
    tb_inflow_mcp_count: "{n}회",
    tb_inflow_mcp_top: "최다: {tool}",
    tb_inflow_since_launch: "앱 실행 이후",
    tb_inflow_inbox: "_inbox 도착",
    tb_inflow_source_unknown: "출처 미표기",
    tb_inflow_view: "보기 →",
    tb_inflow_spark_caption:
      "최근 24시간 · 보라 = 세션/inbox · 파랑 = MCP 호출",
    tb_inflow_summary: "오늘: 세션 +{s} · MCP {m}회 · 인박스 +{i}",
    tray_open: "myco 열기",
    tray_quit: "myco 종료",
    s_tray_resident_title: "메뉴 막대에 상주",
    s_tray_resident_desc:
      "창을 닫아도 종료하지 않고 숨깁니다 — myco가 메뉴 막대에 남아 백그라운드 작업을 계속합니다. 종료는 트레이 메뉴에서.",
    spot_placeholder: "위키에 질문…",
    spot_thinking: "질문 중…",
    spot_hint_enter: "Enter로 질문 · Esc로 닫기",
    spot_hint_open: "인용을 클릭하면 myco에서 해당 노트를 엽니다.",
    spot_no_vault:
      "myco에서 볼트를 먼저 열어주세요 — 아직 질문할 대상이 없습니다.",
    spot_busy: "myco가 이전 질문에 아직 답하고 있습니다.",
    voice_btn_label: "음성 캡처",
    voice_hint_recording: "⏎ 저장 · esc 취소",
    voice_saved_chip: "{rel} — 다음 인제스트에 합류합니다",
    voice_whisper_missing:
      "음성 인식 준비 중 — 첫 사용 시 음성 모델(~190MB)을 한 번만 내려받습니다. 계속 실패하면 myco를 재설치해 주세요.",
    voice_model_progress: "음성 모델 받는 중 — 최초 1회, {pct}%",
    voice_transcribe_progress: "받아쓰는 중… {pct}%",
    voice_mic_denied:
      "마이크를 사용할 수 없습니다 — 시스템 설정에서 myco의 마이크 접근을 허용해주세요.",
    voice_no_input: "소리가 들어오지 않습니다 — 마이크를 확인하세요",
    voice_stage_transcribing: "받아쓰는 중…",
    voice_stage_saving: "노트 저장 중…",
    s_spot_title: "어디서나 질문",
    s_spot_desc:
      "전역 단축키로 지금 하던 작업 위에 작은 질문 창을 띄웁니다. 앱의 Ask와 완전히 같은 경로로 답하므로 인용을 누르면 노트가 열립니다.",
    s_spot_record: "단축키 변경",
    s_spot_recording: "새 조합을 눌러주세요…",
    s_spot_disable: "사용 안 함",
    s_spot_ok: "등록됨 — 어디서나 {k}를 누르세요.",
    s_spot_failed:
      "{k}를 등록하지 못했습니다 — 다른 앱이 이미 쓰고 있을 가능성이 큽니다. 다른 조합을 선택하세요.",
    s_spot_off: "꺼짐 — 등록된 전역 단축키가 없습니다.",
    notif_distill_done_title: "증류 완료",
    notif_distill_done_body:
      "제안 {p}건 · 세션 다이제스트 {d}일치 · 주간 롤업 {w}건",
    notif_distill_done_months: " · 월간 롤업 {m}건",
    notif_quarantine_title: "새 격리 항목",
    notif_quarantine_body:
      "{n}개 항목이 _inbox/quarantine에서 검토를 기다립니다.",
    h_open_vault: "히스토리를 보려면 vault를 여세요.",
    rf_title: "Reflect 제안",
    rf_lede:
      "Claude가 vault를 읽기 전용으로 훑어 제안합니다: 연결할 고립 노드, 오래된 페이지, 빠진 교차 참조.",
    rf_run: "Reflect 실행",
    rf_running: "분석 중…",
    rf_running_label: "Reflect 분석 중…",
    rf_done: "Reflect 완료 — 제안 {n}개",
    rf_empty: "제안이 없습니다 — vault가 잘 연결되어 있습니다.",
    rf_extractive:
      "추출 기반 결과 (내장 모델, LLM 없음) — 링크 그래프 사실만: 고아 페이지와 미해결 링크.",
    rf_item_orphan:
      "{page}: 고아 페이지 — 아무 페이지도 이 페이지를 링크하지 않습니다. 관련 페이지에서 [[위키링크]]를 추가하세요.",
    rf_item_unresolved:
      "{page}: [[{target}]]를 링크하지만 그런 페이지가 없습니다. 페이지를 만들거나 링크를 고치세요.",
    rf_create_missing: "빠진 페이지 만들기",
    rf_create_progress: "{done}/{total}",
    rf_create_result: "만든 페이지: {n}개",
    rf_create_failed: "[[{target}]]에서 중단 — 만들지 못했습니다.",
    rf_create_one: "이 페이지 만들기",
    rf_open_page: "페이지 열기",
    rf_ignore_one: "이 항목 다시 알리지 않기",
    ob_title: "myco에 오신 것을 환영합니다",
    ob_skip: "건너뛰기",
    ob_back: "이전",
    ob_next: "다음",
    ob_finish: "완료",
    ob_vault_linked: "연결됨",
    ob_vault_none: "아직 연결된 vault가 없습니다",
    ob_s1_title: "프로젝트 만들기 또는 열기",
    ob_s1_body:
      "myco는 모든 페이지를 당신이 관리하는 폴더에 마크다운으로 보관합니다. 기존 폴더를 열거나, 방금 만들어진 기본 vault를 그대로 사용하세요.",
    ob_s1_action: "폴더 열기…",
    ob_sovereignty:
      "플레인 마크다운 · raw/는 절대 수정되지 않음 · Obsidian과 같은 폴더 공유 — myco를 지워도 전부 남습니다.",
    ob_s2_title: "첫 소스 추가하기",
    ob_s2_body:
      "파일을 드롭하거나 URL을 붙여넣거나 메모를 쓰세요. myco가 읽고, 엔티티와 개념을 추출해 인용이 달린 페이지를 그래프에 엮습니다.",
    ob_s2_action: "가져오기로 이동",
    ob_s3_title: "질문하기",
    ob_s3_body:
      "위키에 무엇이든 물어보세요. myco는 먼저 당신의 페이지에서 답하고 필요할 때만 원본으로 들어갑니다 — 모든 주장에는 인용이 따라옵니다.",
    ob_s3_action: "질문으로 이동",
    ob_demo_start: "데모 볼트로 시작",
    ob_seed_offer: "그 폴더는 비어 있습니다. 데모 노트를 채워 둘까요?",
    ob_seed_do: "데모 노트 채우기",
    ob_indexing_local: "인덱스는 이 기기에서만 만들어집니다.",
    ob_s2_progress: "노트 {total}개 중 {done}개",
    ob_s2_indexed: "노트 {n}개를 인덱싱했습니다",
    ob_s2_failed: "인덱싱을 마치지 못했습니다",
    ob_first_question: "이 노트들에서 가장 자주 다룬 주제는?",
    ob_first_question_sessions: "지난주에 무슨 작업을 했지?",
    ob_ask_now: "물어보기",
    ob_imp_title: "쌓아둔 기록 가져오기",
    ob_imp_body:
      "Claude Code·Codex 세션을 가져올 수 있습니다. 이 기기에서만 인덱싱되며, 검색과 질문에는 비용이 들지 않습니다.",
    ob_imp_claude: "Claude Code 세션 가져오기",
    ob_imp_codex: "Codex 세션 가져오기",
    ob_imp_progress: "파일 {total}개 중 {done}개",
    ob_imp_done: "세션 {n}개를 가져왔습니다",
    ob_imp_quarantined: "{n}건 보류 (시크릿 의심)",
    ob_imp_skip_hint: "가져올 게 없다면 그냥 계속하세요.",
    ob_hist_title: "변경 이력을 남길까요?",
    ob_hist_already: "이 vault는 이미 이력이 켜져 있습니다.",
    ob_hist_skip_hint: "나중에 개요 화면에서 켤 수 있습니다.",
    s_budget_title: "월 지출 가드",
    s_budget_desc:
      "이번 달 유료 API 제공자에서의 예상 지출입니다. 정확한 청구가 아닌 대략적 경보로, 임계값을 설정하면 초과 전에 경고합니다.",
    s_budget_threshold: "월 한도 (USD)",
    s_budget_usage: "이번 달",
    s_budget_total: "합계",
    s_budget_empty: "이번 달 추적된 유료 API 사용량이 없습니다.",
    s_autoreflect_title: "자동 Reflect",
    s_autoreflect_desc:
      "myco가 켜져 있는 동안 읽기 전용 Reflect를 주기적으로 실행해 고립 노드·오래된 페이지·빠진 링크를 찾아냅니다.",
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
      "앱에 내장된 경량 다국어 임베더(e5-small-ko, 40MB). 설치 없이 오프라인으로 동작하며, Ask는 시맨틱 검색으로 내 노트 원문을 그대로 답변합니다. 로컬 챗 모델은 번들하지 않음 — ingest·분류·생성은 클라우드 제공자를 사용하세요.",
    s_provider_desc_ollama:
      "오픈소스 모델을 로컬에서 실행합니다. http://localhost:11434를 자동 감지합니다.",
    s_provider_desc_openrouter:
      "하나의 키로 여러 제공자 사용 (모델 비교에 유용).",
    s_provider_desc_myco_pro:
      "관리형 모델로 무제한 ingest — API 키나 CLI가 필요 없습니다. myco Pro 계정으로 로그인하세요.",
    vh_banner_title: "볼트 이력이 아직 꺼져 있습니다",
    vh_banner_desc:
      "켜면 에이전트가 바꾼 것을 단어 단위로 보고 되돌릴 수 있습니다.",
    vh_enable: "이력 켜기",
    vh_later: "나중에",
    vh_setting_title: "볼트 이력 (git)",
    vh_setting_desc:
      "볼트 안에 로컬 git 저장소를 만듭니다. 에이전트 커밋과 직접 편집이 서로 다른 작성자로 기록되며, 이 기기를 떠나지 않습니다.",
    set_pii_title: "개인정보(PII) 감지 시",
    set_pii_desc:
      "격리를 선택하면 이메일·전화번호가 감지된 소스는 영구 보관소에 기록되지 않고 _inbox에 남습니다. API 키 같은 시크릿은 선택과 무관하게 항상 차단됩니다.",
    set_pii_warn: "경고만",
    set_pii_quarantine: "격리",
    set_audit_title: "raw/ 시크릿 감사",
    set_audit_rescan: "다시 스캔",
    set_audit_clean: "파일 {n}개 · 이력 {m}개 — 시크릿 0건",
    set_audit_history_only: "이력에만 존재",
    set_audit_note:
      "감사는 읽기 전용입니다. raw/는 앱이 고쳐 쓰지 않으며, 정리는 문서의 절차를 따릅니다.",
    ov_since_eyebrow: "다녀오신 사이",
    ov_since_title: "증류 {runs}회, 페이지 {pages}개가 움직였습니다",
    ov_since_quiet: "다녀오신 사이 조용했습니다.",
    ov_suspect_title: "의심 페이지",
    ov_suspect_clean: "점검한 페이지 모두 이상 없습니다.",
    ov_view_runs: "런 보기",
    contra_title: "모순",
    contra_disputed: "분쟁 표시된 페이지입니다",
    contra_stale: "{t}(superseded)를 인용 중입니다",
    contra_mark_active: "해소: active",
    contra_mark_superseded: "superseded로",
    contra_open_page: "링크 페이지 열기",
    contra_open_target: "대상 열기",
    contra_ignore: "무시",
    contra_clean: "모순이 없습니다.",
    rs_header: "다시 만나기",
    rs_open: "열기",
    rs_snooze: "일주일 뒤",
    rs_ignore: "무시",
    rs_similarity: "유사도 {s}",
    rs_last_open: "마지막 열람 {t}",
    rs_floor_note: "무시가 잦으면 기준을 올립니다 · 현재 {f}",
    ritual_title: "오늘의 재회",
    ritual_due: "복습 카드 {n}장이 기한입니다",
    ritual_start: "복습 시작",
    history_runs_title: "실행",
    history_run_open_why: "WHY 리포트",
    history_no_commit:
      "이 실행은 이력(git)이 꺼진 상태에서 돌았습니다 — 파일 목록만 보여드립니다.",
    history_diff_too_large: "파일이 커서 차이를 표시하지 못합니다",
    history_status_added: "추가",
    history_status_modified: "수정",
    history_status_renamed: "이동",
    history_status_deleted: "삭제",
    auth_badge_human: "사람 {h}% · 에이전트 {a}%",
    auth_badge_last_human: "마지막 사람 손길 {t}",
    auth_filter_pill: "기록상 사람만",
    agent_confirm_title: "에이전트가 페이지를 수정하려 합니다",
    agent_confirm_create_title: "에이전트가 새 페이지를 만들려 합니다",
    agent_confirm_hint: "허용하면 아래 변경이 볼트에 기록됩니다.",
    notch_peek: "떨구거나, 클릭해서 메모",
    notch_peek_body: "파일 · 링크 · 선택한 텍스트",
    notch_drop: "여기에 놓으세요",
    notch_accepted: "받았습니다",
    notch_accepted_next: "다음",
    notch_accepted_next_sub: "인제스트가 곧 읽습니다",
    notch_running: "인제스트 중 · {t}",
    notch_running_read: "읽는 중",
    notch_running_pages: "페이지",
    notch_done: "완료",
    notch_done_open: "⏎ 열기",
    notch_done_collapse: "4초 후 접힘",
    notch_capture: "빠른 기록",
    notch_capture_save: "⏎ 데일리 노트",
    notch_capture_voice: "⌥M 음성",
    notch_capture_saved: "저장했습니다",
    notch_recording: "녹음 중 · {t}",
    notch_rec: "녹음",
    notch_note: "메모",
    notch_cancelled: "취소됨",
    notch_no_sound: "소리가 없습니다",
    notch_hint_cancel: "esc 취소",
    notch_hint_save: "⏎ 저장",
    notch_rejected: "받지 못했습니다",
    notch_rejected_body: "이 형식은 아직 읽지 못합니다 ({ext})",
    notch_rejected_accepts: "가능",
    notch_rejected_list: "PDF · 문서 · 표 · HTML · 이미지 · 음성",
    notch_unsupported: "이 형식은 아직 읽지 못합니다 ({ext})",
    notch_write_failed:
      "저장하지 못했습니다 — 다시 시도하거나 소스 가져오기를 사용하세요",
    s_notch_title: "노치 드롭 표면",
    s_notch_desc:
      "메뉴 막대 노치 아래에 드롭 표면을 표시합니다 — 떨어뜨린 파일은 _inbox로 들어가 인제스트가 읽습니다.",
  },
  ja: {
    app_name: "myco",
    quick_search: "検索 / 移動…",
    quick_ask: "ウィキに質問",
    nav_workspace: "ワークスペース",
    nav_pages: "ページ",
    nav_tools: "ツール",
    nav_overview: "今日",
    nav_ingest: "取り込み",
    nav_query: "質問",
    nav_graph: "グラフ",
    db_empty: "まだ描くデータがありません。",
    bd_title: "マイボード",
    bd_range: "期間",
    bd_range_all: "全体",
    bd_edit: "ボードを編集",
    bd_done: "完了",
    bd_add: "ウィジェット追加",
    bd_custom: "カスタム質問…",
    bd_text: "テキスト (マークダウン)",
    bd_heading: "見出し",
    bd_compact: "配置",
    bd_compact_v: "上に詰める",
    bd_compact_none: "余白を保つ",
    bd_empty: "最初のチャートを追加 — MCP流入・タグ・タスク…",
    bd_drag: "ドラッグ",
    bd_configure: "設定",
    bd_duplicate: "複製",
    bd_field_title: "タイトル",
    bd_field_source: "ソース",
    bd_field_group: "グループ",
    bd_field_filter: "フィルタ",
    bd_field_view: "表示",
    bd_field_time: "期間",
    bd_field_rule: "色ルール",
    bd_filter_none: "なし",
    bd_time_auto: "自動 (ボード期間)",
    bd_rule_risk: "赤",
    bd_rule_ok: "緑",
    bd_src_inflow: "流入",
    bd_src_notes: "ノート",
    bd_src_tasks: "タスク",
    bd_preset_mcp_daily: "MCP 日別流入",
    bd_preset_channels_daily: "チャネル別流入 (積み上げ)",
    bd_preset_notes_by_type: "種類別ノート",
    bd_preset_top_tags: "よく使うタグ",
    bd_preset_edits_daily: "日別編集",
    bd_preset_tasks_by_status: "タスク状況",
    bd_preset_unsourced_stat: "出典なしページ (数値)",
    bd_g_day: "日別",
    bd_g_channel: "チャネル別",
    bd_g_type: "種類別",
    bd_g_confidence: "信頼度別",
    bd_g_status: "状態別",
    bd_g_tag: "タグ別",
    bd_v_bar: "棒",
    bd_v_line: "線",
    bd_v_hbar: "横棒",
    bd_v_stat: "数値",
    bd_v_table: "表",
    bd_hide_zero: "0なら非表示",
    bd_json_form: "フォーム",
    bd_json_bad: "JSON が不正です — 修正するかフォームに戻ってください。",
    bd_unknown: "不明なウィジェット型 “{kind}” — 保存どおり保持します。",
    bd_field_color: "色",
    bd_color_default: "既定",
    bd_color_blue: "青",
    bd_color_green: "緑",
    bd_color_purple: "紫",
    bd_color_amber: "琥珀",
    bd_color_cyan: "シアン",
    bd_color_red: "赤",
    bd_detail_total: "合計 {n}",
    bd_board_pick: "ボード",
    bd_new_board: "新しいボード",
    bd_new_board_prompt: "ボード名:",
    bd_delete_board: "ボードを削除",
    bd_delete_confirm: "ボード“{name}”を削除しますか？",
    nav_history: "履歴",
    nav_provenance: "出典",
    nav_tasks: "タスク",
    tasks_title: "タスク",
    tasks_lede: "ノート全体のチェックボックス項目を一か所にまとめました。",
    tasks_loading: "ノートをスキャン中…",
    tasks_empty: "まだタスクがありません",
    tasks_empty_hint:
      "任意のノートに `- [ ] …` チェックボックスを追加すると、ここに表示されます。",
    tasks_ph: "何をしますか？",
    tasks_due: "期限",
    tasks_add: "追加",
    tasks_stale:
      "リスト作成後にノートが変更されたため、読み直しました。もう一度お試しください。",
    tasks_view: "表示",
    tasks_view_list: "リスト",
    tasks_view_board: "ボード",
    tasks_col_todo: "未着手",
    tasks_col_doing: "進行中",
    tasks_col_blocked: "保留",
    tasks_col_done: "完了",
    tasks_notify:
      "期限の通知を受け取る — 朝のまとめと、時刻を書いた項目の個別リマインダー",
    tasks_view_calendar: "カレンダー",
    tasks_cal_today: "今日",
    tasks_cal_undated: "期限なし ({n})",
    tasks_detail: "タスク",
    tasks_detail_close: "閉じる",
    tasks_detail_status: "ステータス",
    tasks_detail_start: "開始",
    tasks_detail_scheduled: "着手予定",
    tasks_detail_priority: "優先度",
    tasks_detail_priority_none: "なし",
    tasks_detail_estimate: "見積り",
    tasks_detail_estimate_hint:
      "90m, 1.5h, 2d, 1w のような形式で入力してください。",
    tasks_detail_recur: "繰り返し",
    tasks_detail_notes: "詳細メモ",
    tasks_detail_notes_ph: "詳細・リンク・文脈…",
    tasks_detail_recur_hint:
      "myco が計算できるのは \u201cevery day/week/month/year\u201d と \u201cevery 2 weeks\u201d です。それ以外の規則はノートにそのまま残ります。",
    tasks_detail_start_after_due:
      "開始日が期限より後なので、期限の日にのみ表示します。書かれた日付はそのままにします。",
    tasks_detail_open_note: "{page} を開く",
    tasks_hub: "月ページを更新",
    tasks_hub_heading: "{month} の予定",
    tasks_hub_empty: "_この月に予定はありません。_",
    tasks_hub_written: "月ページ {n} 件を更新しました。",
    tasks_hub_kept: "{n} 件は自分で管理しているため、そのままにしました。",
    tasks_compose_more: "詳細",
    tasks_compose_category: "カテゴリ",
    tasks_compose_project: "プロジェクト",
    tasks_compose_target: "追加先",
    tasks_compose_daily: "今日のデイリーノート",
    tasks_new_roadmap: "＋ 新しいロードマップ…",
    tasks_new_roadmap_ph: "ロードマップのタイトル",
    tasks_view_roadmap: "ロードマップ",
    tasks_roadmap_empty: "ロードマップはまだありません",
    tasks_roadmap_empty_hint:
      "ロードマップはマイルストーンとチェックボックスの wiki ページ（wiki/roadmaps/…）です。作成すると項目がタスク全体に表示されます。",
    tasks_roadmap_progress: "{done}/{total} 完了",
    tray_sub_waiting_n: "{n} 件が待っています",
    tray_sub_clear: "待っているものはありません",
    tray_sub_distilling: "蒸留中 · {step}",
    tray_now_eyebrow: "承認待ち",
    tray_toast_approved: "{name} を承認しました",
    tray_tile_waiting: "待っているもの",
    tray_tile_today: "今日",
    tray_row_links: "リンク提案",
    tray_row_reflect: "Reflect の提案",
    tray_row_sessions: "セッション · inbox",
    tray_card_tasks_v: "今日 {n}",
    tray_card_tasks_sub: "超過 {n}",
    tray_last24: "直近24時間",
    tray_legend_hourly: "時間別",
    dp_prev: "前の月",
    dp_next: "次の月",
    dp_clear: "日付をクリア",
    tasks_open_n: "未完了 {n}件",
    tasks_done_n: "完了 {n}件",
    tasks_all_done: "すべて完了 — 残りはありません。",
    tasks_completed: "完了 ({n})",
    nav_study: "学習",
    nav_settings: "設定",
    split_open: "画面分割",
    split_close: "分割を閉じる",
    split_pick: "2つ目のペイン",
    split_resize: "ペインのサイズ変更",
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
      "myco は取り込んだ論文・記事・ノートを、引用付きの知識グラフへと織り上げます。すべてはマークダウン — あなたの知識は、あなたの手の中に。",
    ov_cta_ingest: "ソースを取り込む",
    ov_cta_ask: "ウィキに質問",
    ov_stats_pages: "ページ",
    ov_stats_links: "リンク",
    ov_stats_ratio: "ウィキだけで回答",
    ov_quick: "続きから",
    ov_stats_moved: "今週の動き",
    ov_moved_none: "直近 7 日間の記述なし",
    ov_pulse_alt: "ページ {pages} 件、リンク {links} 件、今週 {moved} 件が更新",
    ov_recent_moved: "最近動いたノート",
    ov_recent_never: "まだ変更されたノートはありません。",
    ing_title: "取り込み",
    ing_lede:
      "ファイルをドロップ、URL を貼り付け、あるいはメモを書く。Claude が読み、エンティティと概念を抽出し、ソースページを作成し、グラフに織り込みます。",
    ing_drop: "ここにファイルをドロップ",
    ing_drop_or: "または URL を貼り付け",
    ing_browse: "ファイルを選択…",
    ing_drop_multi:
      "{n} 件のうち最初のファイルのみ読み込みました — このフォームは一度に 1 つのソースだけ処理します。残りは 1 つずつドロップしてください。",
    ing_inbox_pending: "_inbox 待機中（{n}）",
    ing_inbox_empty:
      "待機中のファイルはありません — 到着分は取り込み済みです。",
    ing_inbox_today: "今日",
    ing_inbox_unsupported_chip: "未対応",
    ing_inbox_unsupported_line: "未対応 {n} 件 — そのまま残します。",
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
    ing_live_earlier: "以前の {n} 件",
    ing_live_files: "作業したページ",
    ing_live_reads: "読込",
    ing_live_writes: "作成",
    ing_grounded: "更新すべき既存ページを{n}件マッチ",
    ing_grounded_hint:
      "重複作成ではなく既存ページを更新するよう、これらのページへ誘導しました。",
    ing_plan: "取り込み計画 {n}件",
    ing_plan_hint:
      "このソースが何を変えるか — エージェントはこの計画に従い、重複ではなく既存ページを更新します。",
    ingest_gate_title: "取り込み計画 — 適用する項目を選んでください",
    ingest_gate_apply: "{n}件のみ適用",
    ingest_gate_all: "この計画どおりすべて",
    ingest_gate_noop_hint:
      "NOOP項目はすでにウィキに反映済みのため、初期状態では未選択です。",
    ing_cancel: "キャンセル",
    ing_cancelled: "取り込みをキャンセルしました",
    ing_preview_open: "ページを開く",
    ing_preview_close: "プレビューを閉じる",
    ing_preview_writing: "まだ書き込み中です — 少し待ってからもう一度。",
    ing_chip_done: "取り込み完了",
    ing_chip_error: "取り込み失敗",
    q_title: "ウィキに質問",
    q_lede:
      "myco はまずウィキから答え、必要なときだけ原本に降りていきます。すべての主張に出典が付きます。",
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
    gr_node_count: "ノード",
    gr_edge_count: "リンク",
    gr_all: "すべて",
    gr_layout_spiral: "渦巻銀河",
    gr_layout_strata: "年代記",
    gr_layout_semantic: "意味マップ",
    gr_layout_celestial: "天球星座",
    gr_layout_radial: "同心軌道",
    gr_layout_walrus: "ウォルラスツリー",
    mc_label: "MYCO ヒント",
    mc_dismiss: "閉じる",
    gr_layout_galaxy_s: "銀河",
    gr_layout_synapse3d_s: "シナプス",
    gr_layout_atlas_s: "アトラス",
    gr_open: "ページを開く",
    gr_empty_pre: "まだウィキリンクがありません。",
    gr_empty_post: " を追加するとグラフが育ちます。",
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
    p_lint_running:
      "Lint 実行中 — 他のページに移動してもバックグラウンドで続行します。",
    p_lint_done: "Lint 完了",
    p_lint_failed: "Lint 失敗",
    s_title: "設定",
    s_search_ph: "設定を検索",
    s_search_empty: "「{q}」に一致する設定はありません",
    s_account: "アカウント",
    s_local_user: "ローカルユーザー",
    s_no_vault: "ボールトなし",
    s_vault_path: "ボールトのパス",
    s_change: "変更…",
    q_empty_response: "(応答なし)",
    eb_title: "{area}で問題が発生しました。",
    eb_reload: "myco を再読み込み",
    eb_retry: "再試行",
    eb_area_app: "アプリ",
    eb_area_graph: "グラフ",
    s_workspace: "ワークスペース",
    s_model: "モデル",
    s_embeddings: "セマンティック検索",
    s_embeddings_lede:
      "セマンティック検索・関連ノート・グラフ類似度のためのオンデバイス埋め込みインデックスを構築します。オフラインで動作。",
    s_embeddings_indexed: "ページをインデックス済み",
    s_embeddings_reindex: "今すぐ再インデックス",
    s_embeddings_indexing: "インデックス中…",
    s_embeddings_empty: "未インデックス",
    s_embeddings_loading_model: "モデル読み込み中…",
    s_embeddings_loading_model_hint:
      "初回は内蔵モデルを読み込みます — 数秒かかります。",
    s_embeddings_done: "{n}ページをインデックスしました",
    s_autoreindex_title: "インデックスを自動更新",
    s_autoreindex_desc:
      "この設定に関係なく、mycoは編集したページをすでにバックグラウンドでリアルタイムに再埋め込みしています。これをオンにすると、保管庫の変更が落ち着いてしばらくしてから「今すぐ再インデックス」と同じ全体の再インデックスを保険として自動実行します。",
    s_providers: "接続",
    s_appearance: "外観",
    s_vault_known: "myco が把握しているヴォールト",
    s_ov_theme: "概要の背景",
    s_ov_theme_lede:
      "概要ページの生きた背景です。グラフのレイアウト名をそのまま使いますが、連動はしません。",
    ov_theme_mycelium: "菌糸",
    s_lang: "言語",
    s_about: "myco について",
    up_check: "更新を確認",
    up_checking: "更新を確認中…",
    up_current: "myco は最新です",
    up_downloading: "myco {v} をバックグラウンドでダウンロード中…",
    up_ready: "myco {v} の準備ができました",
    up_restart: "再起動すると適用されます",
    up_restart_btn: "今すぐ再起動",
    up_unconfigured: "更新チャンネルが設定されていません",
    up_unavailable: "このプラットフォーム向けの更新チャンネルはまだありません",
    up_error: "更新の確認に失敗しました",
    up_dismiss: "閉じる",
    cr_last_crash: "直近のクラッシュ",
    cr_at: "{time} · {location}",
    cr_copy: "バグレポートをコピー",
    cr_copied: "コピーしました",
    cr_note_label: "何をしていましたか？（任意）",
    cr_note_ph: "例: ページを編集して保存を押した",
    cr_clear: "クラッシュログを消去",
    cr_cleared: "消去しました",
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
      "myco を閉じていても動作 — Claude がサーバーを自分で起動します。",
    mcp_not_found:
      "このビルドに MCP サーバーファイルがありません。最新の myco を再インストールしてください。",
    s_model_lede:
      "myco は標準で Claude を使います。取り込みと質問で別々のモデルを指定できます。",
    s_model_ingest: "取り込み用モデル",
    s_model_query: "質問用モデル",
    model_custom: "カスタム\u2026",
    model_disconnected: "(未接続)",
    model_effort: "推論の強度",
    model_custom_ph: "モデルID",
    model_fetching: "モデル一覧を取得中\u2026",
    s_model_recommended: "推奨",
    s_model_ctx: "コンテキスト",
    ing_extractive_note:
      "抜粋要約 — 以下の行はすべて `raw/{slug}.md` からそのまま引用したものです。このソースを読んだモデルはないため、言い換えも推測もありません。",
    ing_extractive_report_title: "抜粋取り込み: {title}",
    ing_extractive_report_why:
      "この実行は内蔵のオフライン経路を使いました。ソースの文をそのまま引用して出典を付け、タグはボールトにすでにあるものだけを再利用し、関連ページはローカルの埋め込みインデックスから取得しました。**モデルは呼び出していません。** ソースを要約した主体がないため `confidence` は `low` です。モデルを接続して再実行すればこのページを置き換えられます。",
    ing_extractive_log:
      "{date} — [[source-{slug}]]（{title}）を抜粋取り込み、モデル呼び出しなし",
    ing_extractive_hint:
      "抜粋方式 — ソースをそのまま引用し、モデルを呼び出しません。",
    ing_run_extractive: "抜粋で取り込む",
    s_providers_lede:
      "好きなプロバイダーを接続してください。キーはローカル保存 — myco のサーバーには届きません。",
    s_provider_connected: "接続済み",
    s_provider_disconnected: "未接続",
    s_provider_cli_missing: "CLI 未インストール",
    s_mycopro_url: "サービス URL",
    s_mycopro_key: "ライセンスキー",
    s_mycopro_email: "メール",
    s_mycopro_password: "パスワード",
    s_mycopro_login: "ログイン",
    s_mycopro_logout: "ログアウト",
    s_mycopro_loggedin: "ログイン中:",
    s_mycopro_noaccess: "有効なアクセスなし",
    s_autoimport_title: "CLIセッション自動収集",
    s_autoimport_desc:
      "mycoを開いている間、Claude Code / Codex の会話を定期的に sessions/ へ取り込み、Ask が検索・引用できるようにします。ごく短いセッションと取り込み済みのものはスキップされます。セッションは有料の取り込み対象にはなりません — ウィキではなく記録だからです。",
    s_autoimport_interval: "間隔",
    s_autoingest_title: "受信トレイ自動取り込み",
    s_autoingest_desc:
      "mycoを開いている間、vaultの_inbox/フォルダに入れたソースを定期的に取り込みます。",
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
      "myco はローカルの Obsidian ボルトと Claude Code CLI 上に立つ薄いクライアントです。ページはマークダウン — あなたの知識はあなたのもの。",
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
    ol_not_running_body_pre:
      "Spotlight から Ollama アプリを起動（またはターミナルで ",
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
    lint_local_title: "Wiki リント — ローカルパス",
    lint_local_note:
      "モデルを使わない決定的なチェックのみです。自由記述の修正案と" +
      "「言及されているのにリンクされていない概念」の検出には接続済みプロバイダーが必要です。",
    lint_local_clean: "問題は見つかりませんでした。",
    lint_sec_critical: "重大",
    lint_sec_warning: "警告",
    lint_sec_info: "情報",
    lint_k_missing_frontmatter:
      "frontmatter — 必須フィールド（title, type, created, confidence, status）を追加してください。",
    lint_k_invalid_frontmatter:
      "frontmatter の値が不正 — 許可された値のいずれかを使ってください。",
    lint_k_dangling_citation:
      "リンク切れの引用 — raw/ の原文を追加するか、[^src-…] 参照を削除してください。",
    lint_k_source_count_mismatch:
      "source_count が実態と不一致 — 異なる引用の数に合わせてください。",
    lint_k_missing_superseded_by:
      "置き換えられたページ — 置き換えたページを指す superseded_by を追加してください。",
    lint_k_missing_disputed_section:
      "異論のあるページ — 対立点を説明する `## Disputed` セクションを追加してください。",
    lint_k_weak_confidence:
      "出典 2 件未満で confidence: high — 出典を増やすか confidence を下げてください。",
    lint_k_stale_page:
      "active のまま 30 日以上未更新 — 見直すか status を変更してください。",
    lint_k_hedged_claim:
      "出典 1 件で一般化した記述 — 出典を追加するか主張の範囲を狭めてください。",
    lint_k_orphan_page:
      "孤立ページ — リンク元がありません。関連ページからリンクしてください。",
    lint_k_unresolved_link:
      "解決できない wikilink — ページを作成するか、リンク名を修正してください。",
    p_dismiss: "閉じる",
    p_open_vault: "出典をスキャンするには vault を開いてください。",
    p_scanning: "vault をスキャン中…",
    p_empty: "まだ主張を含むノートがありません — 本文を追加してください。",
    p_overall: "全体",
    p_claims_cited: "件の主張が引用済み",
    p_pages_by_coverage: "ページ別の引用カバレッジ",
    rd_source: "ソース",
    rd_preview: "プレビュー",
    rd_live: "ライブ",
    rd_task_toggle: "タスクの完了を切り替え",
    rd_frontmatter_hidden: "frontmatter は非表示 — プロパティまたはソースで編集",
    rd_backlinks_empty: "まだここにリンクするノートはありません。",
    rd_related: "関連ノート",
    rd_related_no_index:
      "関連ノートは、まだ作成されていないオンデバイス索引から取得します。",
    rd_related_no_index_cta: "セマンティック検索を設定",
    rd_make_cards: "カード作成",
    rd_making: "生成中…",
    rd_cards_none: "生成されたカードがありません。",
    rd_cards_made: "カードを{n}枚追加しました",
    rd_open_study: "学習を開く",
    rd_more: "その他",
    rd_rail: "ノートレール",
    rd_rail_toggle: "ノートレールの表示/非表示",
    rd_src_title: "出典と信頼度",
    rd_src_scanning: "ボールトの引用を読み込み中…",
    rd_src_no_claims: "根拠を付ける主張がまだありません。",
    rd_src_coverage: "主張 {total} 件のうち {cited} 件に引用",
    rd_src_bar: "引用カバレッジ {pct} パーセント",
    rd_src_none: "このノートには根拠がありません。存在しない出典は作りません。",
    rd_src_broken: "raw/ の原本なし — 切れた引用",
    rd_src_hand: "手書き",
    rd_src_weight: "問い合わせがこの層に適用する信頼度の重み",
    rd_src_uncited: "未引用の主張 {n} 件",
    rd_src_all: "全体のカバレッジ",
    rd_conn_title: "つながり",
    rd_conn_empty: "まだつながりがありません。",
    rd_conn_back: "被リンク",
    rd_conn_sug: "提案",
    rd_conn_added: "## Related に [[{name}]] を追加しました",
    rd_auth_title: "この段落を書いた人",
    rd_auth_agent: "エージェントが記述",
    rd_auth_human: "あなたが記述",
    rd_auth_revert: "この段落を元に戻す",
    rd_auth_locked: "この段落は複数のコミットが書いています — 戻すべき版が一つに定まりません。",
    rd_auth_human_only: "元に戻すエージェントの編集はありません。",
    rd_auth_history: "履歴で見る",
    rd_auth_reverted: "段落を以前の版に戻しました",
    rd_auth_nothing: "以前の版にもこの段落がそのまま残っています。",
    rd_auth_failed: "以前の版を読み取れませんでした。",
    rd_claim_dot: "この段落には根拠がありません",
    rd_claim_title: "出典のない主張",
    rd_claim_hint: "この段落は何も指していません。",
    rd_claim_find: "出典を探す",
    rd_claim_searching: "ボールトを検索中…",
    rd_claim_none: "ボールトに根拠が見つかりません — 未引用のままにします。",
    rd_claim_added: "[[{name}]] を根拠として付けました",
    // Editor basics (P1): CodeMirror search/completion phrases, `/` block names.
    cm_find: "検索",
    cm_replace_field: "置換",
    cm_next: "次",
    cm_previous: "前",
    cm_all: "すべて",
    cm_match_case: "大文字小文字を区別",
    cm_by_word: "単語単位",
    cm_regexp: "正規表現",
    cm_replace: "置換",
    cm_replace_all: "すべて置換",
    cm_close: "閉じる",
    cm_current_match: "現在の一致",
    cm_replaced_matches: "$件を置換しました",
    cm_replaced_on_line: "$行目の一致を置換しました",
    cm_on_line: "行",
    cm_goto_line: "行へ移動",
    cm_go: "移動",
    cm_completions: "補完",
    sl_h1: "見出し1",
    sl_h2: "見出し2",
    sl_h3: "見出し3",
    sl_bullet: "箇条書き",
    sl_numbered: "番号付きリスト",
    sl_todo: "チェックボックス",
    sl_code: "コードブロック",
    sl_quote: "引用",
    sl_table: "表",
    sl_divider: "区切り線",
    sl_date: "今日の日付",
    img_unsupported: "挿入できるのはPNG・JPEG・GIF・WebP画像のみです",
    img_failed: "画像を保存できませんでした: {error}",
    ol_title: "アウトライン",
    ol_empty: "見出しはまだありません",
    ol_untitled: "(無題)",
    ol_toggle: "アウトラインの表示/非表示",
    props_title: "プロパティ",
    props_add: "プロパティを追加",
    props_key_ph: "キー",
    props_value_ph: "値",
    props_add_confirm: "追加",
    props_remove: "{key} を削除",
    props_bad_key: "キーは英字で始まり英数字・_・-のみ使用でき、既存のキーは使えません",
    props_complex: "複合値 — ソースで編集してください",
    props_tags_ph: "タグを追加…",
    props_tag_remove: "タグを削除",
    st_title: "学習",
    st_lede:
      "ページから生成した間隔反復フラッシュカードとクイズで知識を復習しましょう。",
    st_no_decks: "デッキがありません",
    st_generate_hint:
      "ページを開いて「カード作成」を選ぶとデッキを生成できます。",
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
    ag_write_hint:
      "エージェントによるページの作成/更新を許可（書き込みごとに確認）",
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
    au_needs_provider:
      "音声概要は文章を新しく書く機能なので、AIプロバイダーが必要です。設定 → モデルで選択してください。",
    bf_title: "セッション・バックフィル",
    bf_desc: "コーディングセッションはアーカイブされるだけでウィキになっていません。一括で ingest キューへ送ると、通常のパスが引用付きノートにします。",
    bf_waiting: "待機",
    bf_done: "ウィキ化済み",
    bf_skipped: "短すぎ",
    bf_held: "大きすぎ",
    bf_promote: "次の {n} 件を送る",
    bf_promoted: "{n} 件を ingest キューに送りました",
    bf_held_note: "{n} 件は一度に処理するには大きすぎるため、スキップではなく保留しています。",
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
    s_distill: "蒸留",
    set_distill_loading: "読み込み中…",
    set_distill_lede:
      "新しく入ったページを定期的にウィキのオントロジーへ取り込み、吸収済みのものはアーカイブし、残りは統合を提案します。",
    set_distill_enabled_title: "自動蒸留",
    set_distill_enabled_desc:
      "mycoが開いていてアイドル状態のとき、独自のスケジュールでバックログを蒸留します。",
    set_distill_intensity: "強度",
    set_distill_intensity_conservative: "保守的",
    set_distill_intensity_standard: "標準",
    set_distill_intensity_aggressive: "積極的",
    set_distill_gate: "ゲートプリセット",
    set_distill_gate_strict: "厳格",
    set_distill_gate_normal: "通常",
    set_distill_gate_loose: "緩め",
    set_distill_count_trigger: "バックログ件数トリガー",
    set_distill_ttl: "隔離TTL（日）",
    set_distill_budget: "実行予算（件数）",
    set_distill_idle_minutes: "アイドル時間（分）",
    set_distill_maturation: "熟成時間（時間）",
    set_distill_llm_digest_days: "実行あたりのダイジェスト日数",
    set_distill_llm_ingest_budget:
      "実行あたりのLLM項目予算（インジェスト+マップ草案合算）",
    set_distill_profile_injection_title: "プロフィール注入",
    set_distill_profile_injection_desc:
      "profile.mdをAsk/インジェストのコンテキストとして設定済みのAIプロバイダーに送信します。オフにするとプロフィールはローカルのみに保持されます。",
    set_distill_status_title: "状態",
    set_distill_backlog: "バックログ: {n}",
    set_distill_pending: "保留中の提案 {n}件",
    set_distill_trend_shrinking: "減少中",
    set_distill_trend_growing: "増加中",
    set_distill_trend_flat: "変化なし",
    set_distill_run_now: "今すぐ蒸留",
    set_distill_running: "蒸留中…",
    set_distill_report:
      "アーカイブ{a}件、破棄{tr}件、提案{p}件 — バックログ{b}件",
    set_distill_busy: "蒸留は既に実行中です。",
    set_distill_undo: "この実行を元に戻す",
    set_distill_undoing: "元に戻しています…",
    set_distill_undo_result: "{n}件を元に戻しました",
    set_runs_title: "過去の実行",
    set_distill_gate_pending: "蒸留待機中: ウィキページ {n}/{min}",
    set_distill_digest_extractive:
      "セッションダイジェストを抽出方式で実行しました（LLMなしの引用抜粋）。要約ダイジェストには設定 → モデル（クエリ）でプロバイダーを接続してください。",
    set_distill_quarantined: "{path} に確認待ちの項目が{n}件あります",
    set_distill_stop: "停止",
    set_distill_stopping: "現在のステップの後に停止します…",
    set_distill_stopped: "{step}の後に停止しました",
    set_distill_step_run: "コアパス",
    set_distill_step_digest: "セッションダイジェスト",
    set_distill_step_ingest: "フル階層インジェスト",
    set_distill_step_maps: "マップ下書き",
    set_distill_step_weekly: "週次ロールアップ",
    set_distill_step_monthly: "月次ロールアップ",
    set_distill_step_resurface: "再会候補",
    set_distill_weekly_rollups: "weekly/ に週次ロールアップを{n}件作成",
    set_distill_monthly_rollups: "monthly/ に月次ロールアップを{n}件作成",
    set_archive_title: "アーカイブ容量",
    set_archive_lede:
      "ダイジェスト済みセッションとロールアップ済みデイリーノートは sessions/archive/ と daily/archive/ に永続保存されます。古いバケットを圧縮すると 1 つの zip にまとめられ、いつでも復元できます。raw/ には一切触れません。",
    set_archive_measure: "測定",
    set_archive_measuring: "測定中…",
    set_archive_empty: "まだアーカイブはありません。",
    set_archive_total: "バケット{buckets}個、ファイル{files}件、{size}",
    set_archive_tree_sessions: "セッション",
    set_archive_tree_daily: "デイリー",
    set_archive_tree_weekly: "ウィークリー",
    set_archive_packed: "圧縮済み",
    set_archive_older_than: "{n}ヶ月より古いバケットを圧縮",
    set_archive_compress: "圧縮",
    set_archive_compressing: "圧縮中…",
    set_archive_compressed:
      "バケット{buckets}個（ファイル{files}件）を圧縮し、{size}を回収しました",
    set_archive_nothing_old: "{n}ヶ月より古いバケットはありません。",
    set_archive_failed: "そのままにしたバケット: {list}",
    set_archive_restore: "復元",
    set_archive_restoring: "復元中…",
    set_archive_restored: "{bucket} にファイル{n}件を復元しました",
    set_profile_title: "プロフィール",
    set_profile_lede:
      "蒸留とAsk/インジェストのコンテキストを個人化します。profile.mdに保存され、注入がオンの場合は設定済みのAIプロバイダーに送信されます。",
    set_profile_role: "役割",
    set_profile_goals: "目標（1行に1件）",
    set_profile_interests: "興味・関心（1行に1件）",
    set_profile_style: "作業スタイル",
    set_profile_save: "保存",
    set_profile_saving: "保存中…",
    set_profile_saved: "保存しました",
    nav_feedback: "収穫箱",
    ov_distill_last_run: "最終実行 {t}",
    ov_distill_never: "まだ実行されていません",
    ov_distill_llm_queued:
      "フル階層インジェスト・マップ草案は待機中 — プロバイダーの接続が必要（ダイジェストはローカルで実行）",
    ov_distill_done:
      "蒸留完了 — アーカイブ{a}件 · ダイジェスト{d}日 · 週次ロールアップ{w}件 · 提案{p}件",
    ov_distill_done_months: " · 月次ロールアップ{m}件",
    ov_distill_done_none: "蒸留完了 — 処理する項目なし",
    pf_title: "収穫箱",
    pf_lede:
      "蒸留エンジンが新しいページをウィキのオントロジーに取り込む際に書き出した提案です — レビューして適用するか、却下してください。",
    pf_empty: "保留中の提案はありません。",
    pf_kind_admit: "クラスタの受け入れ",
    pf_kind_archive: "一括アーカイブ",
    pf_kind_delete: "一括削除",
    pf_kind_draft_map: "トピックマップの作成",
    pf_created: "作成日",
    pf_expand: "展開",
    pf_collapse: "折りたたむ",
    pf_approve: "承認",
    pf_dismiss: "却下",
    pf_confirm_title: "この提案を適用しますか?",
    pf_confirm_msg: "{n}件のファイルが移動またはアーカイブされます。",
    pf_confirm_msg_draft_map:
      "トピックマップの草稿を作成します（LLM呼び出し1回）。",
    pf_retry: "再試行",
    pf_apply_failed: "適用に失敗しました — 再試行",
    pf_tab_proposals: "提案",
    pf_tab_quarantine: "隔離 {n}",
    qz_empty: "隔離中の項目はありません。",
    qz_lede:
      "審査ゲートがトピック外と判定した項目です。削除ではなく保留なので、必要なものは戻し、不要なものは破棄してください。",
    qz_verdict_offtopic: "トピック外: {numbers}",
    qz_verdict_sim: "類似度 {sim}",
    qz_verdict_sim_vs: "類似度 {sim} · しきい値 {min}",
    qz_verdict_nearest: "（最も近いトピック: {topic}）",
    qz_verdict_unknown: "この項目には判定の記録がありません。",
    qz_expires_in: "残り{n}日",
    qz_expires_due: "期限切れ — 次回の実行でゴミ箱に移る可能性があります",
    qz_expires_unknown: "期限の記録なし",
    qz_restore: "ボルトへ復元",
    qz_delete: "削除",
    qz_keep: "さらに{n}日保管",
    qz_confirm_delete_title: "この項目を削除しますか？",
    qz_confirm_delete_msg:
      "{name} をシステムのゴミ箱に移動します（復元可能）。",
    tb_activity_quarantine: "確認待ち{n}件",
    tb_activity_gone: "その項目はすでに処理され、ありません。",
    ing_title_label: "タイトル",
    ing_title_ph: "例: Byte Pair Encoding",
    ing_working: "処理中…",
    ingest_no_changes:
      "警告: モデルは処理を完了しましたが、ウィキページが作成・更新されませんでした。ソースは raw/{slug}.md に保存されましたが、ウィキには反映されていません。上のモデル出力を確認するか、Claude Code (CLI) プロバイダーをお試しください。",
    ingest_validation_failed:
      "取り込み検証に失敗しました — 次の問題を解決しないと取り込みは受け付けられません:",
    ingest_validation_warnings: "検証の警告(処理は続行されます):",
    hq_title: "セッション{n}件がWikiページになる価値があります",
    hq_lede:
      "セッションファイル{total}件 → 異なる本文{distinct}件 · 8 KB–200 KB · 近いWikiクラスター順。sessions/は読むだけで、コピーが_inbox/に入ります。",
    hq_never_run: "まだ一度も収穫されていません — 下のページはすべて初めての収穫です。",
    hq_progress: "これまでに{done}件収穫 — 残り{left}件のうち{shown}件、新しい順。",
    hq_kpi_label: "引用",
    hq_harvest_btn: "{n}件を収穫",
    hq_select_all: "すべて選択",
    hq_clear_all: "すべて解除",
    hq_est_none: "選択なし — 引用は{base}のまま",
    hq_est: "Wikiページ{n} · 引用 {base} → {goal}",
    hq_excluded_line:
      "重複・定型文{n}件を自動除外 — キューはすでにふるいにかけてあります",
    hq_ex_col_reason: "除外理由",
    hq_ex_col_count: "件数",
    hq_ex_col_why: "判定根拠",
    hq_ex_duplicate: "同一本文",
    hq_ex_duplicate_why:
      "先に見たファイルと本文の指紋が同じ。実測: 最多重複の2件は4語の対話録のコピー269 + 267件でした。",
    hq_ex_boilerplate: "定型文",
    hq_ex_boilerplate_why: "会話が残っておらずプロンプトの枠だけのファイル。",
    hq_ex_too_small: "分量不足 (8 KB未満)",
    hq_ex_too_small_why:
      "Wiki化の下限未満 (backfill.rs::MIN_BYTES)。上の重複と重なります。",
    hq_ex_too_large: "保留 (200 KB超)",
    hq_ex_too_large_why:
      "飛ばしたのではなく保留 — 分割すればキューに戻ります (backfill.rs::MAX_BYTES)。",
    hq_ex_already_harvested: "収穫済み",
    hq_ex_already_harvested_why: "コピーがすでにインジェストのパスを通りました。",
    hq_ex_note:
      "除外はファイルを一つも作りません。元のsessions/はそのままで、判定結果だけが記録されます。",
    hq_row_select: "収穫対象を選択: {name}",
    hq_near: "近接度 {score}",
    hq_unclustered: "近いページなし",
    hq_cites_plus: "引用 +{n}",
    hq_preview: "プレビュー",
    hq_collapse: "たたむ",
    hq_will_copy: "コピー先",
    hq_will_cluster: "つなぐクラスター",
    hq_will_cites: "引用",
    hq_wont:
      "作らないもの: 新しいソースファイル0件。元の{rel}はコピーされるだけで変更されません。",
    hq_plan_title: "実行計画 — まだ何も作っていません",
    hq_plan_sub:
      "選択したセッション{n}件 ({kb})。実行を押すまでファイルは一つも作られません。",
    hq_plan_copy: "セッション{n}件を_inbox/にコピー — 元はsessions/にそのまま",
    hq_plan_pass:
      "コピーごとにインジェストのパス1回 — 検索グラウンディング → プランナー → 執筆エージェント",
    hq_plan_cites: "引用 {base} → {goal} (見積もり、+{n})",
    hq_plan_note:
      "パスは消費したコピーをアーカイブします。sessions/には書き込みません。",
    hq_plan_cancel: "キャンセル",
    hq_plan_run: "実行",
    hq_plan_running: "実行中 — {total}件中{done}件完了",
    hq_done_title: "{n}件を収穫しました",
    hq_done_sub: "引用 {base} → {goal}",
    hq_done_partial:
      "{copied}件コピー · {ingested}件インジェスト — 残りは_inbox/で待機",
    hq_failed: "収穫に失敗しました",
    hq_empty_title: "昇格できるものが残っていません",
    hq_empty_body:
      "異なる本文{distinct}件のうち、今昇格できるものはありません。保留(200 KB超)のセッションと8 KBを超える新しい会話はこのキューに戻ってきます。",
    hq_empty_cta: "ソースを取り込む",
    hq_loading: "sessions/ を走査中…",
    hq_error: "セッションのアーカイブを読めませんでした",
    hq_retry: "再試行",
    ing_refused_title: "保存する内容がありません — 保存しませんでした · {reason}",
    ing_logged_title: "原本だけ保管しました · {reason}",
    ing_noop_reason: "計画がすべてNOOP — Wikiに加えるものがありません",
    ing_gate_none_reason: "計画ゲートで承認された項目なし",
    sv_rail_label: "パイプラインの進行状況",
    sv_step_intake: "流入",
    sv_step_judge: "判定",
    sv_step_gate: "計画ゲート",
    sv_step_run: "実行",
    sv_step_backfill: "バックフィルキュー",
    sv_today_n: "今日{n}件",
    sv_tally: "破棄 {d} · 記録 {l} · 収穫 {h}",
    sv_waiting: "待機中",
    sv_reviewing: "確認中",
    sv_idle: "アイドル",
    sv_running: "実行中",
    sv_done: "完了",
    sv_failed: "失敗",
    sv_queue_n: "{n}件待機",
    sv_judge_eyebrow: "2 · 判定 — この画面の中心",
    sv_judge_title: "判定",
    sv_judge_lede:
      "すべての流入は、ファイルを作る前に破棄 / 記録 / 収穫に分類されます。破棄はファイル0件、モデル呼び出し0回、判定ログ1行だけを残します。",
    sv_meta_session: "このセッションの判定 {n}件",
    sv_meta_saved: "節約したモデル呼び出し {n}回",
    sv_drop: "破棄",
    sv_drop_sub: "作成ファイル0件",
    sv_log: "記録",
    sv_log_sub: "raw/に保管 · モデル0回",
    sv_harvest: "収穫",
    sv_harvest_sub: "計画ゲートへ",
    sv_dz_sub:
      "このウィンドウのどこにでもテキスト・Markdownファイルをドロップ — ファイルは判定の後にだけ作られます。",
    sv_verdicts_title: "判定結果",
    sv_verdicts_empty:
      "このセッションではまだ判定した項目がありません — 上にファイルをドロップするかテキストを貼り付けてください。",
    sv_out_drop: "ファイル0件 · モデル0回",
    sv_out_noop: "ファイル0件 · モデル1回",
    sv_out_log: "raw/ 1件 · Wiki 0件",
    sv_out_harvest: "インジェスト完了",
    sv_excl_line: "このセッションで{n}件を自動除外 — 理由を見る",
    sv_excl_none: "このセッションの除外0件",
    sv_excl_col_rule: "判定ルール",
    sv_excl_col_count: "件数",
    sv_excl_col_last: "直近の理由",
    sv_channels: "流入チャネル",
    sv_ch_sessions: "セッションスイープ",
    sv_ch_clipper: "Webクリッパー",
    sv_ch_mcp: "MCPツール",
    sv_ch_zotero: "Zotero · ファイル",
    sv_ch_inbox: "_inboxキュー",
    sv_ch_manual: "手動",
    sv_bf_eyebrow: "5 · バックフィルキュー — この画面で最大の未開封の入力",
    sv_bf_eligible: "収穫価値あり",
    sv_bf_eligible_sub: "8 KB ≤ サイズ ≤ 200 KB",
    sv_bf_total: "アーカイブ総計",
    sv_bf_distinct: "異なる本文",
    sv_bf_batch_label: "バッチサイズ",
    sv_bf_cost:
      "モデル呼び出し ≈ {calls}回 (計画 {n} + 執筆 {n}) · 先に判定を通るので重複はコスト0",
    sv_bf_skipped: "{n}件スキップ",
    q_via: "{provider} · {model} を使用",
    q_via_retrieval:
      "ローカルセマンティック検索 — 回答はノートの原文引用（モデル不使用）",
    q_builtin_note:
      "内蔵のオフラインモデル（Gemma 3 1B）は小さく不正確な場合があります。オフラインなら Ollama で大きめのモデル（例: gemma3:4b）を、最も正確な回答には Claude をお使いください。",
    q_builtin_extractive_note:
      "回答はノート内の最も一致する箇所をそのまま表示します。まとめた回答が必要な場合は、モデル設定でAIプロバイダーを選択してください。",
    q_open_model_settings: "モデル設定",
    q_stale_index:
      "この回答は検索インデックスの代わりにボルト全体を使用しました — モデル更新後にインデックスが古くなっています。",
    q_retrieval_failed:
      "検索インデックスに接続できなかったため、この回答はセマンティック検索を行わずボルトを直接読んで作成されました。続く場合はモデル設定の「今すぐ再インデックス」を実行してください。",
    q_extractive_label: "ノートからの抜粋（上位一致・原文）",
    q_extractive_empty:
      "ウィキのインデックスに該当する内容が見つかりませんでした。質問を言い換えるか、モデル設定の「今すぐ再インデックス」を実行してください。",
    q_extractive_stale:
      "検索インデックスがモデル更新前のものだったため、検索できませんでした。モデル設定の「今すぐ再インデックス」を実行してから、もう一度質問してください。",
    q_extractive_failed:
      "検索インデックスに接続できず、該当する箇所を取得できませんでした。続く場合は、モデル設定の「今すぐ再インデックス」を実行してください。",
    q_range_chip: "期間: {s} – {e}",
    q_range_empty: "該当期間の記録から答えは見つかりませんでした。",
    q_cite_conf_high: "一致度 高",
    q_cite_conf_medium: "一致度 中",
    q_cite_conf_low: "一致度 低",
    q_cite_conf_lexical: "キーワード一致",
    q_cite_conf_tip:
      "{page} — 類似度 {sim}（埋め込みコサイン。{floor} 未満の箇所は表示しません）",
    q_cite_conf_lexical_tip:
      "{page} — キーワードのみの一致のため、類似度スコアはありません",
    q_cite_tier_note: "自分のノート",
    q_cite_tier_map: "下書きマップ",
    q_cite_tier_digest: "日次ダイジェスト",
    q_cite_tier_rollup: "週次まとめ",
    q_cite_tier_monthly: "月次まとめ",
    q_cite_tier_session: "セッションログ",
    q_cite_tier_source: "取り込んだ原文",
    q_cite_list_label: "引用の一致度と出典の種類",
    q_uncited_row: "確認したが引用せず · {n}",
    ask_profile_hint:
      "プロフィールを設定すると、Askが役割や興味・関心に合わせて回答します。",
    ask_profile_hint_cta: "プロフィールを設定",
    ask_profile_hint_dismiss: "閉じる",
    q_chip_done: "回答完了",
    q_chip_error: "回答失敗",
    q_you: "あなた",
    q_miss_btn: "期待した答えと違いますか？記録する",
    // Ask renewal (mockup "Strata").
    q_scope_label: "検索範囲",
    q_scope_wiki: "ウィキ",
    q_scope_sessions: "セッション",
    q_scope_all: "すべて",
    q_scope_help:
      "ウィキはノート・マップ・ダイジェストを、セッションは会話ログを検索します — 設定 › セマンティック検索で有効にするとアーカイブ済みセッションも対象です。すべては両方です。",
    q_scope_chip: "範囲 · {scope}",
    q_trace_title: "検索経路",
    q_trace_toggle: "ステップ表示",
    q_trace_candidates: "候補",
    q_trace_candidates_sub: "インデックス内のページ",
    q_trace_bm25: "BM25",
    q_trace_bm25_sub: "語彙のみのヒット（コサインなし）",
    q_trace_dense: "ベクトル",
    q_trace_dense_sub: "コサインのあるヒット",
    q_trace_rrf: "RRF",
    q_trace_rrf_sub: "k=60 順位融合 — 信頼度ではない",
    q_trace_cap: "上限",
    q_trace_cap_sub: "最大 {k} チャンク · ページあたり 2",
    q_trace_floor: "下限",
    q_trace_floor_sub: "コサイン {floor} 未満",
    q_trace_cold: "アーカイブ",
    q_trace_cold_on: "含む",
    q_trace_cold_off: "除外",
    q_trace_cold_on_sub: "セッション範囲で sessions/archive/ も検索",
    q_trace_cold_off_sub: "sessions/archive/ は除外（設定 › セマンティック検索）",
    q_trace_params:
      "BM25 k1=1.2 · b=0.75 · RRF k=60 · 下限 {floor} — retrieval.rs そのまま。RRF スコアは順位値であり信頼度ではありません。",
    q_cite_aria: "引用 {n} — {stem}、関連度 {sim}、{tier}",
    q_cite_sim_none: "キーワードのみ",
    q_ladder_title: "出典ラダー",
    q_ladder_hint: "引用番号にホバーまたはフォーカスすると、その文を裏付ける行が点灯します。",
    q_ladder_count: "{n} 件 · 引用 {c} 件",
    q_ladder_lead_same: "この質問では階層の重みが順位を変えません。",
    q_ladder_lead_moved: "{stem}（{tier}）— 重みなしで {before} 位、重み付きで {after} 位。",
    q_ladder_up: "階層の重みで {n} 段上昇",
    q_ladder_down: "階層の重みで {n} 段下降",
    q_ladder_same: "順位変化なし",
    q_ladder_archived: "アーカイブ",
    q_ladder_sr:
      "各行はコサイン関連度、階層の重み、RRF × 重み = 最終スコア、重みなしの順序に対する順位変化を示します。",
    q_prior_advanced: "詳細",
    q_prior_title: "階層の事前確率",
    q_prior_formula: "最終 = RRF × 重み",
    q_prior_app: "現在のアプリ動作（すべて 1.00）",
    q_prior_defaults: "提案の既定値",
    q_prior_next: "次の質問から適用されます — 上のラダーは今プレビューしています。",
    q_prior_slider: "{tier} 階層の重み",
    q_abstain_title: "この質問に答える根拠がボールトにありません。",
    q_abstain_sub:
      "「{q}」— インデックス済み {n} ページのうち、関連度の下限 {floor} を超える箇所がありません。もっともらしい文を作らず、ここで止まります。",
    q_abstain_near: "最も近かったもの — すべて下限未満",
    q_abstain_none: "語彙・意味のどちらも何も返しませんでした。",
    q_abstain_lexical: "キーワードのみ",
    q_abstain_gauge_note:
      "赤い目印が下限 {floor} です。「キーワードのみ」はコサインのない語彙ヒットで、単独では根拠になりません。",
    q_abstain_floor_tick: "下限 {floor}",
    q_abstain_harvest: "この質問を収穫対象に",
    q_abstain_harvested: "収穫キューに登録済み · 1 件",
    q_abstain_widen: "セッションまで広げて再検索",
    q_abstain_foot: "棄権も答えです — 記録された空白は次の収穫が埋められます。",
    q_abstain_receipt: "ファイル作成 0 件。想起ミスのログに 1 件記録しました。",
    s_archived_sessions_title: "アーカイブ済みセッションも検索",
    s_archived_sessions_desc:
      "セッション範囲が sessions/archive/ も検索します — インデックスが通常除外する冷たい階層です。有効にすると再インデックスします。",
    sb_new_note: "新規ノート",
    sb_new_folder: "新規フォルダ",
    sb_rename: "名前を変更…",
    sb_today_note: "今日のノート",
    sb_new_note_msg: "ノートのタイトル（.md は自動で付きます）",
    sb_new_note_ph: "無題",
    sb_delete_folder_q: "フォルダを削除しますか?",
    sb_delete_file_q: "ファイルを削除しますか?",
    sb_favorites: "お気に入り",
    sb_recent: "最近編集",
    sb_fav_add: "お気に入りに追加",
    sb_fav_remove: "お気に入りから削除",
    sb_move_to: "移動…",
    sb_move_title: "{n}件を移動",
    sb_move_root: "ボルトのルート",
    sb_delete_n: "{n}件を削除",
    sb_delete_n_q: "{n}件を削除しますか?",
    sb_delete_msg: "{n}件をゴミ箱に移動します。",
    sb_delete_one_msg: "「{name}」をゴミ箱に移動します。",
    sb_selected: "{n}件選択",
    sb_clear_selection: "選択解除",
    sb_new_folder_msg: "フォルダー名",
    sb_rename_msg: "「{name}」の新しい名前:",
    sb_empty_vault: "空のボルト",
    sb_no_vault: "ボルトが選択されていません",
    cb_no_results: "結果なし",
    cb_tag_page: "ページ",
    cb_tag_file: "ファイル",
    cb_tag_action: "操作",
    cb_in_contents: "ページ本文内",
    cb_semantic: "関連（意味）",
    cb_exact: "完全一致",
    cb_operator_hint: "引用符で完全一致 · path: · tag: · type: · status: · confidence:",
    cb_miss_hint: "見つかりませんか？ ⌥⏎ でこの検索を評価セットに記録します。",
    cb_miss_done: "評価セットに記録しました。",
    sb_harvest_badge: "収穫候補セッション {n}件",
    sb_proposals_badge: "昇格提案 {n}件待ち",
    cb_tag_lens: "レンズ",
    sb_status: "ステータス",
    sb_st_vault: "ボルト",
    sb_st_index: "インデックス",
    sb_st_model: "モデル",
    sb_st_on: "実行中",
    sb_st_off: "停止",
    sb_st_mcp_down:
      "MCP サーバーが停止しています — エージェントと Claude Code はこのボルトに到達できません。",
    sb_st_lagging: "ウィキ {n} ページがインデックス外です — 質問で検索されません。",
    sb_st_simulate: "故障シミュレーション",
    s_val_on: "オン",
    s_val_off: "オフ",
    s_changed_only: "変更した設定のみ",
    s_search_clear: "検索をクリア",
    s_show_all: "すべての設定を表示",
    s_total_count: "設定 {all} 件中 {n} 件",
    tb_lint: "リント",
    tb_toggle_sidebar: "サイドバー切替 (⌘B)",
    tb_back: "戻る (⌘[)",
    tb_forward: "進む (⌘])",
    tb_model_picker: "モデル状況",
    tb_model_ready: "準備完了",
    tb_model_offline: "オフライン",
    tb_model_open_settings: "モデル設定を開く",
    tb_activity_label: "バックグラウンド活動",
    tb_activity_n: "活動 {n}",
    tb_activity_running: "実行中",
    tb_activity_links: "リンク提案 {n}件",
    tb_activity_reflect: "Reflect の提案 {n}件",
    tb_activity_applying: "提案を適用中…",
    tb_activity_mcp_on: "MCPサーバー稼働中",
    tb_activity_mcp_off: "MCPサーバー停止",
    tb_activity_tasks: "期限のタスク",
    tb_activity_tasks_more: "+{n}件",
    tb_activity_map_notes: "ノート{n}件",
    tb_activity_map_wait:
      "承認は保存されますが、草案の作成にはクエリモデルが必要です — ローカルモデルはマップを書けません。",
    tb_inflow_header: "今日入ってきたもの",
    tb_inflow_sessions: "セッション取り込み",
    tb_inflow_last_sweep: "最終取り込み {t}",
    tb_inflow_auto: "自動 {m}分",
    tb_inflow_mcp: "MCPツール呼び出し",
    tb_inflow_mcp_count: "{n}回",
    tb_inflow_mcp_top: "最多: {tool}",
    tb_inflow_since_launch: "アプリ起動後",
    tb_inflow_inbox: "_inbox 到着",
    tb_inflow_source_unknown: "出典なし",
    tb_inflow_view: "表示 →",
    tb_inflow_spark_caption:
      "直近24時間 · 紫 = セッション/inbox · 青 = MCP呼び出し",
    tb_inflow_summary: "今日: セッション +{s} · MCP {m}回 · インボックス +{i}",
    tray_open: "mycoを開く",
    tray_quit: "mycoを終了",
    s_tray_resident_title: "メニューバーに常駐",
    s_tray_resident_desc:
      "ウィンドウを閉じても終了せず隠します — mycoはメニューバーに残り、バックグラウンド処理を続けます。終了はトレイメニューから。",
    spot_placeholder: "ウィキに質問…",
    spot_thinking: "質問中…",
    spot_hint_enter: "Enterで質問 · Escで閉じる",
    spot_hint_open: "引用をクリックすると myco でそのノートを開きます。",
    spot_no_vault:
      "先に myco でボールトを開いてください — まだ質問する対象がありません。",
    spot_busy: "myco はまだ前の質問に答えています。",
    voice_btn_label: "音声キャプチャ",
    voice_hint_recording: "⏎ 保存 · esc キャンセル",
    voice_saved_chip: "{rel} — 次のインジェストに合流します",
    voice_whisper_missing:
      "音声認識を準備中 — 初回のみ音声モデル(~190MB)をダウンロードします。失敗が続く場合は myco を再インストールしてください。",
    voice_model_progress: "音声モデルを取得中 — 初回のみ、{pct}%",
    voice_transcribe_progress: "文字起こし中… {pct}%",
    voice_mic_denied:
      "マイクを使用できません — システム設定で myco のマイク使用を許可してください。",
    voice_no_input: "音声が入力されていません — マイクを確認してください",
    voice_stage_transcribing: "文字起こし中…",
    voice_stage_saving: "ノートを保存中…",
    s_spot_title: "どこからでも質問",
    s_spot_desc:
      "グローバルショートカットで、作業中の画面の上に小さな質問ウィンドウを開きます。アプリの Ask と同じ経路で答えるため、引用をクリックするとノートが開きます。",
    s_spot_record: "ショートカットを変更",
    s_spot_recording: "新しい組み合わせを押してください…",
    s_spot_disable: "オフにする",
    s_spot_ok: "登録済み — どこでも {k} を押してください。",
    s_spot_failed:
      "{k} を登録できませんでした — 他のアプリが既に使用している可能性が高いです。別の組み合わせを選んでください。",
    s_spot_off: "オフ — グローバルショートカットは登録されていません。",
    notif_distill_done_title: "蒸留完了",
    notif_distill_done_body:
      "提案 {p}件 · セッションダイジェスト {d}日分 · 週次ロールアップ {w}件",
    notif_distill_done_months: " · 月次ロールアップ{m}件",
    notif_quarantine_title: "新しい隔離アイテム",
    notif_quarantine_body: "{n}件が _inbox/quarantine でレビュー待ちです。",
    h_open_vault: "履歴を見るには vault を開いてください。",
    rf_title: "Reflect の提案",
    rf_lede:
      "Claude が vault を読み取り専用でざっと確認します: リンクすべき孤立ノード、古いページ、欠けた相互参照。",
    rf_run: "Reflect 実行",
    rf_running: "分析中…",
    rf_running_label: "Reflect 分析中…",
    rf_done: "Reflect 完了 — 提案 {n}件",
    rf_empty: "提案はありません — vault は十分につながっています。",
    rf_extractive:
      "抽出ベースの結果(内蔵モデル、LLMなし)— リンクグラフの事実のみ: 孤立ページと未解決リンク。",
    rf_item_orphan:
      "{page}: 孤立ページ — どのページからもリンクされていません。関連ページから [[ウィキリンク]] を追加してください。",
    rf_item_unresolved:
      "{page}: [[{target}]] へリンクしていますが、そのページはありません。作成するか、リンクを修正してください。",
    rf_create_missing: "不足しているページを作成",
    rf_create_progress: "{done}/{total}",
    rf_create_result: "作成したページ: {n}件",
    rf_create_failed: "[[{target}]] で中断 — 作成できませんでした。",
    rf_create_one: "このページを作成",
    rf_open_page: "ページを開く",
    rf_ignore_one: "この項目を今後表示しない",
    ob_title: "myco へようこそ",
    ob_skip: "スキップ",
    ob_back: "戻る",
    ob_next: "次へ",
    ob_finish: "完了",
    ob_vault_linked: "接続済み",
    ob_vault_none: "まだ vault が接続されていません",
    ob_s1_title: "プロジェクトを作成 / 開く",
    ob_s1_body:
      "myco はすべてのページを、あなたが管理するフォルダにマークダウンで保存します。既存のフォルダを開くか、作成された既定の vault をそのまま使ってください。",
    ob_s1_action: "フォルダを開く…",
    ob_sovereignty:
      "プレーンなマークダウン · raw/ は決して変更されません · Obsidian と同じフォルダを共有 — myco を消してもすべて残ります。",
    ob_s2_title: "最初のソースを追加",
    ob_s2_body:
      "ファイルをドロップ、URL を貼り付け、あるいはメモを書く。myco が読み、エンティティと概念を抽出し、出典付きのページをグラフに織り込みます。",
    ob_s2_action: "取り込みへ",
    ob_s3_title: "質問する",
    ob_s3_body:
      "ウィキに何でも聞いてください。myco はまずあなたのページから答え、必要なときだけ原本に降ります — すべての主張に出典が付きます。",
    ob_s3_action: "質問へ",
    ob_demo_start: "デモ・ボールトで始める",
    ob_seed_offer: "そのフォルダは空です。デモノートを入れておきますか？",
    ob_seed_do: "デモノートを追加",
    ob_indexing_local: "インデックスはこの端末だけで作られます。",
    ob_s2_progress: "ノート {total} 件中 {done} 件",
    ob_s2_indexed: "ノート {n} 件をインデックスしました",
    ob_s2_failed: "インデックス作成が完了しませんでした",
    ob_first_question: "これらのノートで最も多く扱っている話題は？",
    ob_first_question_sessions: "先週は何の作業をした？",
    ob_ask_now: "質問する",
    ob_imp_title: "これまでの記録を取り込む",
    ob_imp_body:
      "Claude Code・Codex のセッションを取り込めます。この端末だけでインデックスされ、検索や質問は無料です。",
    ob_imp_claude: "Claude Code セッションを取り込む",
    ob_imp_codex: "Codex セッションを取り込む",
    ob_imp_progress: "ファイル {total} 件中 {done} 件",
    ob_imp_done: "セッション {n} 件を取り込みました",
    ob_imp_quarantined: "{n} 件を保留（シークレットの疑い）",
    ob_imp_skip_hint: "取り込むものがなければそのまま進んでください。",
    ob_hist_title: "変更履歴を残しますか？",
    ob_hist_already: "この vault では履歴が既に有効です。",
    ob_hist_skip_hint: "後で概要画面から有効にできます。",
    s_budget_title: "月間支出ガード",
    s_budget_desc:
      "今月の有料 API プロバイダーでの推定支出です。正確な請求ではなくおおまかな警報 — しきい値を設定すると超過前に警告します。",
    s_budget_threshold: "月間上限 (USD)",
    s_budget_usage: "今月",
    s_budget_total: "合計",
    s_budget_empty: "今月はまだ有料 API の使用量が記録されていません。",
    s_autoreflect_title: "自動リフレクト",
    s_autoreflect_desc:
      "myco を開いている間、読み取り専用のリフレクトを定期的に実行し、孤立ノード・古いページ・欠けたリンクを洗い出します。",
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
      "アプリに同梱された軽量多言語エンベッダー（e5-small-ko、40MB）。セットアップ不要でオフライン動作、Ask はセマンティック検索でノートの原文をそのまま回答します。ローカルチャットモデルは同梱されません — 取り込み・分類・生成にはクラウドプロバイダーを使用してください。",
    s_provider_desc_ollama:
      "オープンソースモデルをローカルで実行します。http://localhost:11434 を自動検出。",
    s_provider_desc_openrouter:
      "1 つのキーで多数のプロバイダーを利用（モデル比較に便利）。",
    s_provider_desc_myco_pro:
      "マネージドモデルで無制限の取り込み — API キーや CLI は不要。myco Pro アカウントでサインインしてください。",
    // Backfilled ja (was English-fallback): suggested links, Zotero, help,
    // query views, graph inspector/gaps, MCP SSE.
    ls_title: "リンク候補",
    ls_hint:
      "意味的に近いのにまだリンクされていないノートです。承認すると「## Related」の下に [[wikilink]] が追加されます。",
    ls_accept: "リンクする",
    ls_dismiss: "閉じる",
    ls_accept_all: "すべて承認",
    ls_linking: "リンク中",
    ls_toast_linked: "リンクを{n}件追加",
    ls_toast_linked_sub: "## Related の下に [[wikilink]]",
    ls_toast_failed: "リンクを追加できませんでした",
    ls_toast_retry: "再試行",
    zi_title: "Zotero からインポート",
    zi_hint:
      "CSL-JSON または BibTeX エクスポート（ハイライトがあれば一緒に取り込まれます）。項目はソース文書として _inbox/ に入り、取り込みパイプラインで処理されます。",
    zi_none: "そのファイルにインポート可能な項目が見つかりませんでした。",
    zi_done:
      "{n} 件を _inbox/ にインポートしました — 「取り込み」を実行して wiki ページに変換してください。",
    ci_title: "会話をインポート",
    ci_hint:
      "ChatGPT エクスポート（conversations.json）または Claude Code / Codex セッション（.jsonl）。各会話はソース文書として _inbox/ に入り、取り込みパイプラインが処理します。",
    ci_btn: "ファイルを選択…",
    ci_busy: "インポート中…",
    ci_done:
      "{n} 件の会話を _inbox/ にインポートしました — 「取り込み」を実行して wiki ページに変換してください。",
    ci_quarantined:
      "{n} 件の会話はシークレット（API キー・トークン）と思われる内容を含むため除外されました。元データで確認してください。インポートされていません。",
    ci_none: "そのファイルに会話が見つかりませんでした。",
    ci_skipped: "（{n} 件はインポート済みのためスキップ。）",
    ci_sweep_cc: "自分の Claude Code セッションをインポート",
    ci_sweep_cx: "自分の Codex セッションをインポート",
    ci_sweep_hint:
      "またはこのマシンにある全セッションをインポート — ~/.claude・~/.codex から。再実行しても新規・増加分のみ追加されます。",
    ci_sweep_progress: "セッションをインポート中 {done} / {total}",
    ci_sweep_tally: "インポート {i} · スキップ {s} · 失敗 {f}",
    ci_failed_summary: "{n} 件をインポートできませんでした",
    ci_retry_failed: "失敗を再試行 ({n})",
    q_empty:
      "wiki に何でも質問できます — 回答はあなた自身のページを引用します。",
    s_mascot: "マスコット MYCO を表示",
    s_mascot_hint:
      "ローダー・空の状態・About ページに表示。オフにすると静的ロゴになります。",
    s_backup_title: "設定とルック",
    s_backup_hint:
      "プロバイダー・自動化・外観・グラフのルックがこのファイルに含まれます。API キー、vault のパス、この端末の識別情報は含まれません。",
    s_backup_export: "エクスポート…",
    s_backup_import: "インポート…",
    s_backup_busy: "処理中…",
    s_backup_exported: "設定をエクスポートしました。",
    s_backup_imported: "復元しました: {sections}",
    s_backup_import_failed: "インポートに失敗しました: {error}",
    s_backup_bad_json: "有効な JSON ファイルではありません。",
    s_backup_section_settings: "アプリ設定",
    s_backup_section_ui: "外観",
    s_backup_section_graph: "グラフの見た目",
    s_backup_section_savedLooks: "保存したグラフの見た目",
    s_backup_section_queryViews: "保存したビュー",
    s_backup_section_dismissedLinkSuggestions: "非表示にしたリンク提案",
    s_backup_section_reflectIgnored: "リフレクトの非表示項目",
    s_backup_section_budgetThresholdUsd: "予算アラートのしきい値",
    s_backup_confirm_title: "これらの設定を置き換えますか？",
    s_backup_confirm_body:
      "このファイルが置き換える対象: {sections}。置き換えられる値はメモリに保持されるため、myco を終了するまでは元に戻せます。",
    s_backup_confirm_none:
      "このファイルには、このバージョンで復元できる設定が含まれていません — インポートしても何も変わりません。",
    s_backup_confirm_apply: "置き換える",
    s_backup_confirm_cancel: "キャンセル",
    s_backup_undo: "インポートを元に戻す",
    s_backup_undo_hint:
      "以前の設定は myco を終了するまでメモリに保持されます。",
    s_backup_undone: "元に戻しました: {sections}",
    hw_title: "ヘルプ",
    hw_sub: "このページのヒント",
    hw_sc_cmd: "コマンドパレット",
    hw_sc_sidebar: "サイドバーの切り替え",
    hw_sc_fly: "フライモード（グラフ）",
    hw_sc_esc: "閉じる / 選択解除",
    hw_sc_new: "新規ノート",
    hw_sc_spotlight: "どこからでも質問",
    hw_sc_voice: "音声キャプチャ (Spotlight / ノッチ)",
    hw_sc_miss: "外れた検索を記録",
    hw_sc_path: "2つのノート間の最短経路 (グラフ)",
    hw_sc_live_link: "ポインター下のウィキリンクを開く（ライブ編集）",
    hw_sc_back: "戻る",
    hw_sc_fwd: "進む",
    hw_tip_graph1: "質問を選ぶと符号化だけが変わります — 座標はそのままです。",
    hw_tip_graph2:
      "空白の一覧が答えです: 開く · リンク提案 · 収穫対象へ。",
    hw_tip_graph3: "サンプルを隠すと自分が書いたノートだけが残ります。",
    hw_tip_query1:
      "回答は wiki ページを引用します — 引用をクリックすると開きます。",
    hw_tip_query2:
      "グラフのギャップパネルからリサーチ質問をこの入力欄に下書きできます。",
    hw_tip_ingest1:
      "任意のファイルをドロップ、テキストを貼り付け、または Zotero エクスポートをインポートできます。",
    hw_tip_ingest2:
      "Web クリッパーは _inbox/ 経由でページをここに送ります（clipper/ を参照）。",
    hw_tip_overview1:
      "リンク候補はまだ wikilink のない意味的なペアです — 承認または却下してください。",
    hw_tip_default: "⌘K でどこへでも移動 — ページ・アクション・意味的ヒット。",
    vw_lens_unsourced: "出典なし",
    vw_lens_orphans: "孤立",
    vw_lens_disputed: "係争中",
    vw_lens_recent: "最近の変更",
    tpl_new_from: "テンプレートから新規ノート…",
    tpl_pick_title: "テンプレートを選択",
    tpl_pick_msg:
      "テンプレートはボールトの templates/ にある .md ファイルです。{{date}}、{{time}}、{{title}} が置き換えられます。",
    tpl_empty:
      "テンプレートはまだありません。編集できる2つのスターター（ノート、会議メモ）と templates/ を作成します。",
    tpl_create_starters: "テンプレートフォルダを作成",
    tpl_creating: "作成中…",
    tpl_create_error: "テンプレートを作成できませんでした: {err}",
    tpl_note_error: "テンプレートからノートを作成できませんでした: {err}",
    tpl_starter_note: "ノート",
    tpl_starter_meeting: "会議メモ",
    tpl_starter_note_body: "## 要約\n\n## 詳細\n\n## 出典\n",
    tpl_starter_meeting_body:
      "> {{date}} {{time}}\n\n## 参加者\n\n## アジェンダ\n\n## メモ\n\n## アクションアイテム\n\n- [ ] \n",
    gr_insp_type: "タイプ",
    gr_insp_confidence: "確信度",
    gr_insp_status: "ステータス",
    gr_insp_links_out: "リンク",
    gr_insp_backlinks: "バックリンク",
    gr_insp_open: "リーダーで開く",
    gr_insp_unresolved: "未解決のノート（ファイルなし）",
    gr_insp_none: "—",
    gr_find_ph: "ノートを検索…",
    gr_gaps_title: "ギャップ",
    gr_gap_missing: "欠落ページ",
    gr_gap_orphans: "孤立ページ",
    gr_gap_undercited: "引用不足",
    gr_gap_lowconf: "低確信度",
    gr_gap_islands: "未接続",
    gr_gap_none: "ギャップは見つかりませんでした",
    gr_gap_more: "もっと見る",
    gr_loading: "星座を整列中…",
    gr_title: "測量",
    gr_lede: "地図は一つ、問いは四つ。問いを選ぶと変わるのはエンコード（色・大きさ・かすみ）でレイアウトではないので、答え同士を比べられます。",
    gr_canvas_aria: "ボルトのリンク地図。矢印キーでノートを選び、Enter で開きます。",
    gr_stage_hint: "レイアウトは一つ · 問いが変えるのはエンコードだけ",
    gr_q_lead: "この画面が答える問い",
    gr_q_orphans: "どこが空いているか",
    gr_q_orphans_u: "空き",
    gr_q_sub_orphans: "孤立 {orphans} · 未解決 {unresolved} · 被リンク0 {nobacklink}",
    gr_q_clusters: "何がまとまっているか",
    gr_q_clusters_u: "クラスタ",
    gr_q_sub_clusters: "地図なし {nomap} · 地図あり {map}",
    gr_q_time: "最近何が育ったか",
    gr_q_time_u: "30日以内",
    gr_q_sub_time: "サンプル {sample} 件はインストール日に固定",
    gr_q_neighbors: "このノートの隣人",
    gr_q_neighbors_u: "2ホップ",
    gr_q_sub_neighbors: "選択したノートから2ホップ",
    gr_q_pick: "ノートを一つ選んでください",
    gr_size: "ノードの大きさ",
    gr_size_backlinks: "大きさ = 被リンク",
    gr_size_cites: "大きさ = 引用",
    gr_hide_sample: "サンプル {n} 件を隠す",
    gr_show_unresolved: "未解決リンクを表示",
    gr_rebuilds: "シーン再構築 {n} 回 · {ms} ms",
    gr_honest_lead: "このグラフが描くのは {n} ノード",
    gr_honest: "初回サンプル {sample} 件（{pct}%）· 自分のノート {own} 件 · 未解決 {unresolved} 件。引用を持つノートは {cited} 件。",
    gr_honest_sessions: "セッション {n} 件はここにありません — sessions/ は graphData の NON_KNOWLEDGE_FOLDERS で構造的に除外されます。",
    gr_gap_nobacklink: "誰も参照していない",
    gr_act_link: "リンクを提案",
    gr_act_harvest: "必要な話題として記録",
    gr_act_neighbors: "隣人だけ表示",
    gr_act_open_s: "開く",
    gr_act_link_s: "リンク",
    gr_act_want_s: "記録",
    gr_insp_h: "ノート",
    gr_insp_empty: "ノートを選ぶと、リンク・引用・信頼度と、この画面から出る操作が開きます。",
    gr_insp_cites: "引用",
    gr_insp_sample: "初回サンプル",
    gr_insp_own: "自分のノート",
    gr_insp_nocite: "引用 0",
    gr_cluster_nomap: "地図なし",
    gr_cluster_map: "地図あり",
    gr_enc_orphans: "色 = カテゴリ · 大きさ = リンク数 · かすみ = すでに接続済み",
    gr_enc_clusters: "ブロック = クラスタ · 破線 = 地図ページなし · 点線 = 未接続の近い話題",
    gr_enc_time: "色 = 最終更新（単一ランプ）· かすみ = 半年以上放置",
    gr_enc_neighbors: "明るさ = ホップ距離（0・1 は明るく、2 はかすみ、それ以外はほぼ不可視）",
    gr_link_question: "ボルトの中で「{a}」が接続されないままです。どのノートがここにリンクすべきで、そのリンクは何を言うべきでしょうか？",
    gr_want_done: "「{n}」を必要な話題として記録しました",
    mcp_serving: "MCP サーバー実行中",
    mcp_not_serving: "MCP サーバー停止中",
    mcp_starting: "MCP サーバー起動中…",
    mcp_connect_btn: "Claude Code に接続",
    mcp_connecting: "接続中…",
    mcp_connect_hint: "またはターミナルで一度実行:",
    mcp_start_btn: "サーバーを起動",
    mcp_stop_btn: "停止",
    mcp_registering: "登録中…",
    vh_banner_title: "ボールト履歴はオフです",
    vh_banner_desc:
      "オンにすると、エージェントの変更を単語単位で確認し、元に戻せます。",
    vh_enable: "履歴をオンにする",
    vh_later: "後で",
    vh_setting_title: "ボールト履歴 (git)",
    vh_setting_desc:
      "ボールト内にローカル git リポジトリを作成します。エージェントのコミットとあなたの編集は別の作成者として記録され、この端末の外には出ません。",
    set_pii_title: "個人情報(PII)検出時",
    set_pii_desc:
      "「隔離」を選ぶと、メールアドレスや電話番号を含むソースは恒久保存に書き込まれず _inbox に残ります。API キーなどのシークレットは選択に関係なく常にブロックされます。",
    set_pii_warn: "警告のみ",
    set_pii_quarantine: "隔離",
    set_audit_title: "raw/ シークレット監査",
    set_audit_rescan: "再スキャン",
    set_audit_clean: "ファイル {n} 件 · 履歴 {m} 件 — シークレット 0 件",
    set_audit_history_only: "履歴のみに存在",
    set_audit_note:
      "監査は読み取り専用です。raw/ をアプリが書き換えることはなく、整理は文書の手順に従います。",
    ov_since_eyebrow: "前回から",
    ov_since_title: "蒸留 {runs} 回、ページ {pages} 件が動きました",
    ov_since_quiet: "前回から変化はありません。",
    ov_suspect_title: "要確認ページ",
    ov_suspect_clean: "確認したページに問題はありません。",
    ov_view_runs: "実行を見る",
    contra_title: "矛盾",
    contra_disputed: "disputed と印されたページです",
    contra_stale: "{t}(superseded)を引用しています",
    contra_mark_active: "解消: active",
    contra_mark_superseded: "superseded にする",
    contra_open_page: "リンク元を開く",
    contra_open_target: "対象を開く",
    contra_ignore: "無視",
    contra_clean: "矛盾はありません。",
    rs_header: "再会",
    rs_open: "開く",
    rs_snooze: "1週間後",
    rs_ignore: "無視",
    rs_similarity: "類似度 {s}",
    rs_last_open: "最終閲覧 {t}",
    rs_floor_note: "無視が続くと基準を上げます · 現在 {f}",
    ritual_title: "今日の再会",
    ritual_due: "復習カード {n} 枚が期限です",
    ritual_start: "復習を始める",
    history_runs_title: "実行",
    history_run_open_why: "WHYレポート",
    history_no_commit:
      "この実行は履歴 (git) が無効の状態で行われました — ファイル一覧のみ表示します。",
    history_diff_too_large: "ファイルが大きいため差分を表示できません",
    history_status_added: "追加",
    history_status_modified: "変更",
    history_status_renamed: "移動",
    history_status_deleted: "削除",
    auth_badge_human: "人 {h}% · エージェント {a}%",
    auth_badge_last_human: "人による最終編集 {t}",
    auth_filter_pill: "記録上 人のみ",
    agent_confirm_title: "エージェントがページを更新しようとしています",
    agent_confirm_create_title:
      "エージェントが新しいページを作成しようとしています",
    agent_confirm_hint: "許可すると、以下の変更がボールトに書き込まれます。",
    notch_peek: "ドロップ — またはクリックでメモ",
    notch_peek_body: "ファイル · リンク · 選択テキスト",
    notch_drop: "ここに置いてください",
    notch_accepted: "受け取りました",
    notch_accepted_next: "次",
    notch_accepted_next_sub: "まもなく取り込みが読みます",
    notch_running: "取り込み中 · {t}",
    notch_running_read: "読み込み中",
    notch_running_pages: "ページ",
    notch_done: "完了",
    notch_done_open: "⏎ 開く",
    notch_done_collapse: "4秒後に閉じます",
    notch_capture: "クイックメモ",
    notch_capture_save: "⏎ デイリーノート",
    notch_capture_voice: "⌥M 音声",
    notch_capture_saved: "保存しました",
    notch_recording: "録音中 · {t}",
    notch_rec: "録音",
    notch_note: "メモ",
    notch_cancelled: "キャンセル",
    notch_no_sound: "音がありません",
    notch_hint_cancel: "esc キャンセル",
    notch_hint_save: "⏎ 保存",
    notch_rejected: "受け取れませんでした",
    notch_rejected_body: "この形式はまだ読めません ({ext})",
    notch_rejected_accepts: "対応",
    notch_rejected_list: "PDF · 文書 · 表 · HTML · 画像 · 音声",
    notch_unsupported: "この形式はまだ読めません ({ext})",
    notch_write_failed:
      "保存できませんでした — もう一度試すか、ソース取り込みを使用してください",
    s_notch_title: "ノッチのドロップ面",
    s_notch_desc:
      "メニューバーのノッチ下にドロップ面を表示します — ドロップしたファイルは _inbox に入り、取り込みが読みます。",
  },
};
