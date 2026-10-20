// i18n — EN / KO / JA. Notion-flavoured copy.

import { EVERYDAY_STRINGS, type EverydayStrings } from "./everydayCopy";

export type Lang = "en" | "ko" | "ja";

export interface Strings extends EverydayStrings {
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
  bd_deleted: string; // {name}
  bd_board_exists: string; // {name}
  bd_name_refused: string; // {name}
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
  ci_partial: string; // {i} {s} {f}
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
  // Settings → Appearance: myco roams the screen while long work runs, and
  // now and then on a short walk.
  s_roam: string;
  s_roam_hint: string;
  // The 3D myco (components/Myco3D.tsx): its canvas label, loading line, and
  // the line under the still picture when the screen cannot draw 3D.
  myco3d_label: string;
  myco3d_loading: string;
  myco3d_error: string;
  // Settings › Appearance: the 3D myco card and its black / white switch.
  s_myco3d: string;
  s_myco3d_hint: string;
  s_myco3d_skin: string;
  s_myco3d_black: string;
  s_myco3d_white: string;
  // The video view of the card (components/MycoSpin.tsx): its label, the
  // line under the still when the video cannot play, and the Video | 3D switch.
  myco_spin_label: string;
  myco_spin_error: string;
  s_myco3d_view: string;
  s_myco3d_video: string;
  s_myco3d_model: string;
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
  hw_sc_live_link_touch: string;
  hw_sc_back: string;
  hw_sc_fwd: string;
  hw_md: string;
  hw_sc_bold: string;
  hw_sc_italic: string;
  hw_sc_code: string;
  hw_sc_link: string;
  hw_sc_highlight: string;
  hw_sc_slash: string;
  hw_sc_wikilink: string;
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
  tasks_compose_category_ph: string;
  tasks_compose_project_ph: string;
  tasks_detail_estimate_ph: string;
  tasks_detail_recur_ph: string;
  tasks_due_named: string;
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
  /** First Tab stop: jumps past the sidebar to the page title. */
  skip_to_content: string;
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
  home_links_today: string;
  home_links_more: string;
  home_links_cites: string;
  home_links_none: string;
  home_links_updated: string;
  ing_title: string;
  ing_lede: string;
  ing_drop: string;
  ing_drop_or: string;
  ing_browse: string;
  ing_image_capability_unavailable: string;
  ing_source_authority_changed: string;
  ing_source_credential_unavailable: string;
  ing_drop_multi: string; // {n} = count
  ing_inbox_pending: string; // {n} = pending file count
  ing_inbox_empty: string;
  ing_inbox_today: string;
  ing_inbox_unsupported_chip: string;
  ing_inbox_unsupported_line: string; // {n} = unsupported file count
  ing_yt_fetch: string;
  ing_yt_fetching: string;
  ing_web_fetch: string;
  ing_web_fetching: string;
  ing_web_rule_visible: string;
  ing_web_rule_private: string;
  ing_web_rule_keep: string;
  ing_web_pii_warn: string;
  ing_web_err_bad_url: string;
  ing_web_err_scheme: string;
  ing_web_err_credentials: string;
  ing_web_err_blocked: string;
  ing_web_err_resolve: string;
  ing_web_err_redirect: string;
  ing_web_err_redirects: string;
  ing_web_err_status: string; // {n} = HTTP status
  ing_web_err_not_html: string;
  ing_web_err_too_large: string;
  ing_web_err_timeout: string;
  ing_web_err_network: string;
  ing_web_err_empty: string;
  ing_web_err_secret: string;
  ing_web_err_pii: string;
  ing_web_err_scan: string;
  ing_guard_secret: string;
  ing_guard_pii: string;
  ing_guard_scan: string;
  ing_guard_pii_warn: string;
  ing_web_err_other: string;
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
  ingest_gate_all: string; // {n}
  ingest_gate_noop_hint: string;
  ing_cancel: string;
  ing_cancelled: string;
  ing_gate_title: string;
  ing_gate_waiting: string;
  ing_clear: string;
  ing_touched_n: string; // {n}
  ing_refused_more: string;
  // UX S35: a short note offered a note instead of a refusal, the clock at
  // the plan gate, the pasted source kept under the gate, the developer
  // channels behind 고급, and the touch-pointer headline.
  ing_short_title: string;
  ing_short_daily: string;
  ing_short_new: string;
  ing_short_new_failed: string;
  ing_gate_paused: string;
  ing_gate_source: string;
  ing_more_advanced: string;
  ing_pick_file: string;
  ing_preview_open: string;
  ing_preview_close: string;
  ing_preview_writing: string;
  ing_chip_done: string;
  ing_chip_error: string;
  q_title: string;
  q_lede: string;
  q_send: string;
  q_recent: string;
  q_answer: string;
  q_sources_used: string;
  q_wiki: string;
  q_raw: string;
  gr_title: string;
  gr_lede: string;
  gr_canvas_aria: string;
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
  gr_summary: string; // {own} {gaps}
  gr_details: string;
  gr_gap_nobacklink: string;
  gr_act_link: string;
  gr_act_harvest: string;
  gr_act_neighbors: string;
  gr_act_open_s: string;
  gr_act_link_s: string;
  gr_act_want_s: string;
  gr_insp_cites: string;
  gr_insp_sample: string;
  gr_insp_own: string;
  gr_insp_nocite: string;
  gr_enc_orphans: string;
  gr_enc_clusters: string;
  gr_enc_time: string;
  gr_enc_neighbors: string;
  gr_enc_strata: string;
  gr_link_question: string;
  gr_want_done: string;
  gr_legend: string;
  gr_filter: string;
  gr_filter_folder: string;
  gr_filter_search: string;
  gr_filter_remove: string;
  gr_filter_empty: string;
  gr_filter_clear: string;
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
  gr_skin: string;
  gr_skin_auto: string;
  gr_skin_black: string;
  gr_skin_white: string;
  gr_skin_galaxy: string;
  gr_skin_web: string;
  gr_recency: string;
  gr_recency_hint: string;
  gr_minimap: string;
  gr_minimap_hint: string;
  gr_layout_spiral: string;
  gr_layout_strata: string;
  gr_layout_semantic: string;
  gr_semantic_missing: string;
  gr_layout_celestial: string;
  gr_layout_radial: string;
  gr_layout_walrus: string;
  gr_layout_mycelium: string;
  gr_skin_sigma: string;
  gr_skin_mycelium: string;
  gr_mycelium_dim: string;
  gr_mycelium_3d: string;
  gr_mycelium_2d: string;
  gr_myc_node_color: string;
  gr_myc_hypha_color: string;
  gr_myc_bg: string;
  gr_myc_bg_loam: string;
  gr_myc_bg_void: string;
  gr_myc_bg_soil: string;
  gr_myc_bg_paper: string;
  gr_myc_bg_grid: string;
  gr_myc_bg_custom: string;
  gr_vibes: string;
  gr_vibe_living: string;
  gr_vibe_sigma: string;
  gr_vibe_cosmicweb: string;
  gr_vibe_neural: string;
  gr_vibe_planetarium: string;
  gr_vibe_paper: string;
  gr_vibe_chronicle: string;
  gr_vibe_nebula: string;
  gr_vibe_living_desc: string;
  gr_vibe_sigma_desc: string;
  gr_vibe_cosmicweb_desc: string;
  gr_vibe_neural_desc: string;
  gr_vibe_planetarium_desc: string;
  gr_vibe_paper_desc: string;
  gr_vibe_chronicle_desc: string;
  gr_vibe_nebula_desc: string;
  gr_vibe_walrus: string;
  gr_vibe_mycelium: string;
  gr_vibe_walrus_desc: string;
  gr_vibe_mycelium_desc: string;
  gr_looks: string;
  gr_appearance: string;
  gr_motion_fx: string;
  gr_mascot_cameo: string;
  gr_mascot_cameo_hint: string;
  mc_label: string;
  mc_dismiss: string;
  mc_tip_drag: string;
  mc_tip_path: string;
  mc_tip_fly: string;
  mc_tip_looks: string;
  mc_tip_timelapse: string;
  mc_tip_multiverse: string;
  mc_tip_minimap: string;
  mc_tip_recency: string;
  mc_tip_save: string;
  mc_tip_chronicle: string;
  gr_saved: string;
  gr_saved_apply: string;
  gr_saved_delete: string;
  gr_saved_empty: string;
  gr_saved_name_ph: string;
  gr_saved_save: string;
  gr_layout_3d: string;
  gr_layout_2d: string;
  gr_layout_galaxy_s: string;
  gr_layout_synapse3d_s: string;
  gr_layout_atlas_s: string;
  gr_layout_synapse_s: string;
  gr_cinematic: string;
  gr_cinematic_hint: string;
  gr_flow: string;
  gr_flow_hint: string;
  gr_galaxies: string;
  gr_galaxies_hint: string;
  gr_multiverse: string;
  gr_multiverse_hint: string;
  gr_mv_loading: string;
  gr_mv_none: string;
  gr_layout: string;
  gr_layout_galaxy: string;
  gr_layout_atlas: string;
  gr_layout_synapse: string;
  gr_layout_synapse3d: string;
  gr_recommend: string;
  gr_recommend_hint: string;
  gr_sky: string;
  gr_sky_stars: string;
  gr_sky_dense: string;
  gr_sky_grid: string;
  gr_sky_void: string;
  gr_node_color: string;
  gr_node_color_community: string;
  gr_node_color_white: string;
  gr_node_color_auto: string;
  gr_mono_below: string;
  gr_tl_speed: string;
  gr_scale_star: string;
  gr_scale_system: string;
  gr_scale_galaxy: string;
  gr_scale_cluster: string;
  gr_arrows: string;
  gr_arrows_hint: string;
  gr_arrow_size: string;
  gr_semantic_edges: string;
  gr_semantic_edges_hint: string;
  gr_edge_bundles: string;
  gr_edge_bundles_hint: string;
  gr_fly_btn: string;
  gr_timelapse_record: string;
  gr_node_color_black: string;
  gr_cosmic: string;
  gr_cosmic_hint: string;
  gr_cosmic_freq: string;
  gr_click_burst: string;
  gr_click_burst_hint: string;
  gr_neural_firing: string;
  gr_neural_firing_hint: string;
  gr_planets: string;
  gr_planets_hint: string;
  gr_pixel_nodes: string;
  gr_pixel_nodes_hint: string;
  gr_color_depth: string;
  gr_edge_tint: string;
  gr_edge_tint_grey: string;
  gr_edge_tint_community: string;
  // Gesture cheat-sheet popover ("?" toolbar button).
  gr_help_btn: string;
  /** Graph toolbar menu holding every action but zoom and fit (UX S44). */
  gr_more_menu: string;
  /** Graph canvas accessible name: note count, then the selected note. */
  gr_canvas_label: string;
  gr_canvas_label_sel: string;
  gr_help_title: string;
  gr_help_click: string;
  gr_help_dblclick: string;
  gr_help_cmdclick: string;
  gr_help_esc: string;
  gr_help_fly: string;
  gr_help_drag: string;
  gr_help_rails: string;
  // Folding the Survey's gaps / legend rails to an edge tab ({name} = the
  // rail's own title, gr_gaps_title / gr_legend), and the drawer's row for it.
  gr_rail_fold: string;
  gr_rail_open: string;
  gr_panels: string;
  gr_trace: string;
  gr_trace_hint: string;
  gr_spaceship: string;
  gr_spaceship_hint: string;
  gr_spaceship_exit: string;
  gr_speed: string;
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
  // Mycelium-only relabels for the shared Motion/Forces controls (optional —
  // components fall back to English).
  gr_motion_hint_myc: string;
  gr_myc_forces_hint: string;
  gr_myc_spread: string;
  gr_myc_branch: string;
  // Graph node inspector (optional — components fall back to English).
  gr_insp_type: string;
  gr_insp_confidence: string;
  gr_insp_status: string;
  gr_insp_connections: string;
  gr_insp_links_out: string;
  gr_insp_backlinks: string;
  gr_insp_tags: string;
  gr_insp_open: string;
  gr_insp_back: string;
  gr_not_in_graph: string;
  gr_insp_unresolved: string;
  gr_insp_none: string;
  gr_find_ph: string;
  gr_insp_path_start: string;
  gr_insp_path_anchor: string;
  gr_insp_path_clear: string;
  gr_insp_path: string;
  gr_insp_path_none: string;
  gr_insp_hops: string;
  gr_gaps_title: string;
  /** The graph on a phone (UX S53). */
  gr_tools: string;
  /** Settings on a phone: back from a section to the list (UX S54). */
  s_back_list: string;
  gr_rails_sheet: string;
  gr_legend_empty: string;
  gr_gesture_hint: string;
  gr_gesture_ok: string;
  gr_gaps_btn: string;
  gr_gap_missing: string;
  gr_gap_malformed: string;
  gr_gap_orphans: string;
  gr_gap_undercited: string;
  gr_gap_lowconf: string;
  gr_gap_disputed: string;
  gr_gap_islands: string;
  gr_gap_none: string;
  gr_gap_bridges: string;
  gr_gap_ask: string;
  gr_bridge_question: string;
  q_thinking: string;
  q_answering: string;
  q_answering_from: string;
  gr_key_size: string;
  gr_key_dim: string;
  gr_key_amber: string;
  gr_key_neutral: string;
  gr_more: string; // "+{n} more": rows beyond a rail's shown cap (gaps, legend)
  gr_focus_trail: string;
  gr_focus_esc: string;
  gr_preset: string;
  gr_preset_galaxy: string;
  gr_preset_loose: string;
  gr_preset_dense: string;
  gr_glow: string;
  gr_motion: string;
  gr_motion_hint: string;
  gr_advanced: string;
  gr_loading: string;
  gr_ctx_lost: string;
  gr_retry: string;
  gr_perf_mode: string;
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
  eb_home: string;
  eb_details: string;
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
  s_storage_title: string;
  s_storage_desc: string;
  s_storage_where: string;
  s_storage_icloud: string;
  s_storage_dropbox: string;
  s_storage_unread: string;
  s_storage_unread_none: string;
  s_storage_unread_n: string;
  s_storage_checking: string;
  s_storage_unread_hint: string;
  s_storage_history: string;
  s_storage_last_save: string;
  s_storage_no_save: string;
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
  model_apply_custom: string;
  model_effort: string;
  model_fetching: string;
  s_model_recommended: string;
  s_model_use_recommended: string;
  s_model_choose_own: string;
  /** Under a disabled "Use the recommended setting": its provider is not connected. */
  s_model_recommended_needs: string;
  s_model_ctx: string;
  // Offline (extractive) ingest — the builtin-local provider's ingest path.
  // `ing_extractive_note` / `_report_*` / `_log` are written INTO the vault
  // (wiki/source-*.md, ingest-reports/, wiki/log.md); `_hint` is the line the
  // Ingest page shows next to the model name. See lib/extractiveIngest.ts.
  ing_extractive_note: string;
  local_transform_note: string;
  local_transform_fallback_note: string;
  local_transform_report_why: string;
  ing_local_transform_hint: string;
  ing_run_local_transform: string;
  ing_extractive_report_title: string;
  ing_extractive_report_why: string;
  ing_extractive_log: string;
  ing_extractive_hint: string;
  ing_extractive_pending: string;
  set_distill_evidence_pending: string;
  workflow_pending: string;
  workflow_partial: string;
  workflow_stopped: string;
  session_compile_label: string;
  session_compile_progress: string;
  session_compile_stopping: string;
  session_compile_preparation: string;
  session_queue_title: string;
  session_queue_refresh: string;
  session_queue_idle: string;
  session_queue_failed: string;
  session_queue_empty: string;
  session_queue_count: string;
  session_queue_running: string;
  session_queue_completed: string;
  session_queue_superseded: string;
  session_queue_unknown: string;
  session_queue_runtime_review: string;
  session_queue_conditions_review: string;
  session_queue_reason_other: string;
  session_queue_details: string;
  session_queue_preparation: string;
  session_queue_incomplete: string;
  session_queue_model_failed: string;
  session_queue_processing_failed: string;
  workflow_failed: string;
  workflow_skipped: string;
  workflow_review_retry: string;
  workflow_retry_hint: string;
  /** The Ingest run button for the offline path — `ing_run` names Claude, and
   *  a run that calls no model must not. */
  ing_run_extractive: string;
  s_providers_lede: string;
  s_provider_connected: string;
  s_provider_disconnected: string;
  s_provider_error: string; // {name}
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
  s_provider_kind_cli: string;
  s_provider_kind_api: string;
  s_provider_kind_local: string;
  s_provider_name_builtin_local: string;
  s_provider_key_ph: string;
  s_provider_key_save: string;
  s_provider_checking_ollama: string;
  s_provider_keychain_note: string;
  s_lang_lede: string;
  s_lang_ui: string;
  s_lang_drafts: string;
  s_appearance_lede: string;
  s_appearance_light: string;
  s_appearance_dark: string;
  s_appearance_system: string;
  s_text_size: string;
  s_text_size_desc: string;
  s_text_size_system: string;
  s_text_size_custom: string;
  s_text_size_small: string;
  s_text_size_medium: string;
  s_text_size_large: string;
  s_text_size_sample: string;
  s_about_built: string;
  dlg_cancel: string;
  dlg_ok: string;
  dlg_create: string;
  dlg_delete: string;
  dlg_rename: string;
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
  rd_source_active: string;
  rd_back_to_write: string;
  rd_raw_read_only: string;
  /** S41: the button over a selection in a raw/ original. */
  rd_quote_to_daily: string;
  /** S41 part B: the selection's cloze-card button, its group and sheet. */
  rd_quote_to_card: string;
  rd_quote_actions: string;
  rd_quote_card_none: string;
  rd_quote_card_title: string;
  rd_quote_card_msg: string;
  rd_quote_pick_title: string;
  rd_quote_pick_msg: string;
  rd_quote_pick_front: string;
  rd_quote_pick_empty: string;
  rd_loading: string;
  rd_not_found: string;
  rd_not_found_sub: string;
  rd_unreadable: string;
  rd_find_note: string;
  rd_go_home: string;
  rd_type_note: string;
  rd_save_failed: string;
  rd_retry_save: string;
  rd_copy_draft: string;
  rd_draft_copied: string;
  rd_draft_copy_failed: string;
  rd_original_baseline: string;
  rd_current_file: string;
  rd_recovery_draft: string;
  rd_retry_file_read: string;
  rd_copy_baseline: string;
  rd_baseline_copied: string;
  rd_baseline_copy_failed: string;
  rd_recovered_draft: string;
  rd_reload_draft: string;
  rd_reload_draft_title: string;
  rd_reload_draft_confirm: string;
  rd_reloading_draft: string;
  rd_draft_reloaded: string;
  rd_draft_reload_failed: string;
  rd_saving: string;
  rd_saved: string;
  rd_save_pending: string;
  rd_not_saved: string;
  rd_task_toggle: string;
  rd_frontmatter_hidden: string;
  /** Live: placeholder of the caret's empty line. */
  live_ph_block: string;
  live_sources: string;
  /** S24: the start chips under an empty note's hint (group label, then
   *  a daily note's three starters; a body's `${}` is the caret). */
  start_chips_label: string;
  start_day_todo: string;
  start_day_todo_body: string;
  start_day_meeting: string;
  start_day_meeting_body: string;
  start_day_thoughts: string;
  start_day_thoughts_body: string;
  rd_toc_empty: string;
  rd_embed_loading: string;
  rd_embed_missing: string;
  /** A ```chart that cannot be drawn (lib/blocks/chart.ts). */
  ch_err_type: string;
  ch_err_line: string; // {n}
  ch_err_data: string;
  ch_err_table: string;
  ch_err_number: string; // {value}
  /** A ```mermaid mermaid could not read; its message follows (lib/blocks/mermaid.ts). */
  mm_err: string;
  /** An untitled callout's title: its kind (lib/blocks/callout.ts). */
  callout_kind_note: string;
  callout_kind_tip: string;
  callout_kind_info: string;
  callout_kind_warning: string;
  callout_kind_danger: string;
  callout_kind_success: string;
  callout_kind_quote: string;
  callout_kind_important: string;
  callout_kind_caution: string;
  callout_kind_question: string;
  rd_backlinks_empty: string;
  rd_related: string;
  rd_related_no_index: string;
  rd_related_no_index_cta: string;
  rd_make_cards: string;
  rd_making: string;
  rd_cards_none: string;
  rd_cards_made: string;
  rd_open_study: string;
  rd_cards_preview_title: string;
  rd_cards_preview_msg: string;
  rd_cards_save: string;
  rd_cards_dupe: string;
  rd_cards_ai_tag: string;
  rd_cards_all_dupes: string;
  rd_cards_none_picked: string;
  rd_more: string;
  rd_ask_note: string;
  // Reader rail: sources & trust, connections (mockup "Manuscript").
  rd_rail: string;
  rd_view_graph: string;
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
  rd_conn_backs: string; // Connections sub-header, a count beside it
  rd_conn_sug: string;
  rd_conn_added: string; // {name}
  // Authorship gutter + per-paragraph revert.
  rd_auth_show: string;
  rd_auth_hide: string;
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
  sl_h4: string;
  sl_bullet: string;
  sl_numbered: string;
  sl_todo: string;
  sl_code: string;
  sl_quote: string;
  sl_table: string;
  sl_divider: string;
  sl_date: string;
  sl_callout: string;
  sl_toggle: string;
  sl_link: string;
  sl_image: string;
  sl_embed: string;
  sl_sec_basic: string;
  sl_sec_media: string;
  sl_sec_records: string;
  sl_sec_advanced: string;
  sl_sec_templates: string;
  sl_sec_plugins: string;
  pl_renderer_missing: string;
  sl_no_results: string;
  sl_text: string;
  bm_search: string;
  bm_turn_into: string;
  bm_actions: string;
  bm_duplicate: string;
  bm_delete: string;
  bm_move_up: string;
  bm_move_down: string;
  bm_ask: string;
  bm_handle: string;
  /** Touch block menu and keyboard toolbar (UX S51). */
  bm_indent: string;
  bm_outdent: string;
  tb_label: string;
  tb_undo: string;
  tb_wikilink: string;
  tb_tag: string;
  tb_todo: string;
  tb_heading: string;
  tb_add: string;
  tb_hide: string;
  tb_bold: string;
  tb_italic: string;
  tb_highlight: string;
  tb_code: string;
  tb_link: string;
  /** A Live table (lib/blocks/table.ts): an empty header cell's
   *  placeholder ({n} = the column's number), drawn by CSS, never written. */
  tbl_col_ph: string;
  tbl_add_row: string;
  tbl_add_col: string;
  tbl_row_menu: string;
  tbl_col_menu: string;
  tbl_menu: string;
  tbl_row_above: string;
  tbl_row_below: string;
  tbl_col_left: string;
  tbl_col_right: string;
  tbl_row_delete: string;
  tbl_col_delete: string;
  tbl_align: string;
  tbl_align_left: string;
  tbl_align_center: string;
  tbl_align_right: string;
  /** A fenced block's toolbar and panel in Live (lib/blocks/fencePanel.ts):
   *  {name} is the block's name (sl_chart, sl_math, …). */
  fb_edit: string;
  fb_delete: string;
  fb_done: string;
  fb_panel: string;
  fb_text: string;
  mm_f_code: string;
  mt_f_tex: string;
  /** A chart's panel (lib/blocks/chartPanel.ts). */
  ch_f_type: string;
  ch_f_bar: string;
  ch_f_line: string;
  ch_f_pie: string;
  ch_f_title: string;
  ch_f_data: string;
  ch_f_from_table: string;
  ch_f_inline: string;
  ch_f_table: string;
  ch_f_pick: string;
  ch_f_new_table: string;
  ch_f_missing: string;
  ch_f_table_n: string; // {n}
  ch_f_layout: string;
  ch_f_columns: string;
  ch_f_rows: string;
  ch_f_labels: string;
  ch_f_series: string;
  ch_f_values: string;
  ch_f_add_series: string;
  ch_f_remove_series: string;
  /** A query block's panel (lib/blocks/queryPanel.ts). */
  qb_f_path: string;
  qb_f_tag: string;
  qb_f_type: string;
  qb_f_sort: string;
  qb_f_limit: string;
  qb_f_advanced: string;
  qb_f_line: string;
  qb_sort_default: string;
  qb_sort_name: string;
  qb_sort_name_desc: string;
  qb_sort_modified: string;
  qb_sort_modified_asc: string;
  qb_sort_links: string;
  qb_sort_sources: string;
  qb_sort_type: string;
  ins_link: string;
  ins_quote: string;
  sl_in_notes: string;
  sl_onthisday: string;
  sl_toc: string;
  sl_chart: string;
  /** The title of the chart `/chart` inserts (lib/blocks/chart.ts). */
  ch_sample_title: string;
  sl_mermaid: string;
  /** The flowchart `/mermaid` inserts: mermaid source, labels translated
   *  (lib/blocks/mermaid.ts). */
  mm_sample: string;
  sl_math: string;
  otd_title: string;
  otd_all: string;
  otd_none: string;
  otd_keys: string;
  /** Query blocks (lib/blocks/query.ts). */
  sl_query: string;
  sl_onthisday_query: string;
  /** S29: one line each for the slash items that read alike. */
  sl_hint_recall: string;
  sl_hint_query: string;
  sl_hint_onthisday: string;
  sl_hint_onthisday_query: string;
  qb_hint: string;
  qb_loading: string;
  qb_empty: string;
  qb_failed: string;
  qb_bad: string;
  qb_bake: string;
  qb_bake_title: string;
  qb_col_name: string;
  qb_col_type: string;
  qb_col_status: string;
  qb_col_updated: string;
  qb_untyped: string;
  sl_recall: string;
  rc_title: string;
  rc_search: string;
  rc_hint: string;
  rc_none: string;
  rc_stale: string;
  rc_failed: string;
  rc_no_index: string;
  rc_range: string;
  rc_embed: string;
  rc_keys: string;
  sl_ask: string;
  rc_ask: string;
  rc_ask_title: string;
  rc_ask_hint: string;
  rc_ask_keys: string;
  rc_ask_ready: string;
  editor_insert_wait: string;
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
  st_load_failed: string;
  ing_auto_failed: string;
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
  st_quiz_none: string;
  st_ungrounded: string;
  st_ungrounded_hint: string;
  st_archive: string;
  st_archive_hint: string;
  st_archived: string;
  st_archive_failed: string;
  st_gen_quiz: string;
  st_generating: string;
  st_quiz_done: string;
  st_quiz_score: string;
  st_correct: string;
  st_wrong: string;
  st_next: string;
  st_def_front: string;
  st_section_front: string;
  st_today_title: string;
  st_grade_forgot: string;
  st_grade_remembered: string;
  st_next_review: string; // {when} {n}
  st_keys_hint: string; // {n}
  st_save_failed: string;
  st_deck_save_failed: string;
  st_deck_read_failed: string;
  st_deck_changed: string;
  st_deck_partial: string;
  s_study_lede: string;
  s_ai_cards_title: string;
  s_ai_cards_desc: string;
  s_ai_cards_needs: string;
  s_fine_grades_title: string;
  s_fine_grades_desc: string;
  s_plugins: string;
  s_plugins_lede: string;
  pl_trust_title: string;
  pl_trust_desc: string;
  pl_trust_btn: string;
  pl_trusted: string;
  pl_untrust_btn: string;
  pl_installed: string;
  pl_reload: string;
  pl_loading: string;
  pl_empty: string;
  pl_no_vault: string;
  pl_load_failed: string;
  pl_enable: string;
  pl_off_until_trusted: string;
  pl_slash_items: string;
  pl_fences: string;
  pl_renderer_absent: string;
  pl_fence_builtin: string;
  pl_fence_taken: string;
  pl_invalid: string;
  /** Under a folder that is not a plugin; the validator's reason folds under `pl_details`. */
  pl_load_one_failed: string;
  pl_details: string;
  pl_err_missing: string;
  pl_err_outside: string;
  pl_err_too_large: string;
  pl_err_unreadable: string;
  pl_err_json: string;
  pl_err_field: string;
  pl_err_id: string;
  pl_err_renderer: string;
  pl_err_slash: string;
  pl_err_permission: string;
  pl_code: string;
  pl_calls: string;
  pl_calls_none: string;
  pl_ask_title: string;
  pl_ask_desc: string;
  pl_ask_nothing: string;
  pl_allow: string;
  pl_revoke_hint: string;
  pl_sc_insert: string;
  pl_sc_replace: string;
  pl_sc_selection: string;
  pl_sc_read: string;
  pl_sc_recall: string;
  pl_sc_search: string;
  pl_sc_notify: string;
  pl_run_timeout: string;
  pl_run_failed: string;
  pl_run_stopped: string;
  pl_run_busy: string;
  pl_run_calls: string;
  pl_run_no_main: string;
  rd_cards_ai_failed: string;
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
  ag_open_providers: string;
  // Audio overview (Feature 5).
  rd_audio: string;
  au_title: string;
  au_close: string;
  au_generating: string;
  au_needs_provider: string;
  au_source_failed: string;
  au_generation_failed: string;
  au_publication_failed: string;
  au_publication_partial: string;
  au_cancel_failed: string;
  au_stop_generation: string;
  au_stopped: string;
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
  ov_distill_done: string; // {d} {w} {p}
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
  // What Approve does, by kind (UX S20). {n} = the files it moves.
  pf_outcome_admit: string;
  /** An old raw/ archive proposal (before 2026-10-03): nothing to approve. */
  pf_retired: string;
  pf_outcome_delete: string;
  pf_confirm_msg_draft_map: string;
  pf_retry: string;
  pf_apply_failed: string;
  pf_map_needs_writer: string;
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
  qz_expires_due_ask: string;
  qz_expires_unknown: string;
  qz_restore: string;
  qz_delete: string;
  qz_keep: string; // {n}
  qz_confirm_delete_title: string;
  qz_confirm_delete_msg: string; // {name}
  // Spec 2026-10-02 결정 10: the tab groups items by why they were set aside
  // and handles a group at once, behind an in-page confirmation.
  qz_group_myco: string;
  qz_group_agent: string;
  qz_group_hello: string;
  qz_group_empty: string;
  qz_group_other: string;
  qz_restore_all: string;
  qz_trash_all: string;
  qz_confirm_restore_all_title: string; // {n}
  qz_confirm_restore_all_msg: string; // {group}
  qz_confirm_trash_all_title: string; // {n}
  qz_confirm_trash_all_msg: string; // {group}
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
  hq_read_partial: string;
  hq_read_lower_bound: string; // {n}
  // Collapsed working state: harvested before and candidates remain, so the
  // hero stands down to one row (harvestSurface → "working").
  hq_mini_line: string; // {left} {done}
  hq_mini_fold: string;
  // Judgement stage (Ingest): a refused source is one toast, not a file.
  ing_refused_title: string; // {reason}
  ing_logged_title: string; // {reason}
  ing_noop_reason: string;
  ing_raw_reused: string; // {path}
  ing_raw_name_shared: string; // {path}
  ing_dec_update: string;
  ing_dec_add: string;
  ing_dec_merge: string;
  ing_dec_noop: string;
  ing_gate_none_reason: string;
  // Sieve (Ingest page): the 5-step rail, the judgement tile, verdict rows,
  // the exclusion line, intake channels, the backfill panel.
  sv_rail_label: string;
  sv_state_reading: string;
  sv_state_choosing: string;
  sv_state_done: string;
  sv_details: string;
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
  sv_cancelled: string;
  sv_nothing_added: string;
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
  q_source_changed: string;
  q_model_selection_changed: string;
  q_activity_failed: string;
  q_activity_incomplete: string;
  q_activity_summary_failed: string;
  q_answer_review_failed: string;
  q_activity_insufficient_evidence: string;
  q_activity_coverage: string; // {scanned} {sources}
  q_activity_limited: string;
  q_local_fallback_timeout: string;
  q_local_fallback_unavailable: string;
  q_local_fallback_prompt: string;
  q_local_fallback_rejected: string;
  q_local_fallback_incomplete: string;
  q_local_fallback_failed: string;
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
  q_miss_done: string;
  q_miss_failed: string;
  // The Ask → note loop (UX audit A1): quote a passage into a note, copy the
  // answer as markdown.
  q_quote_to_note: string;
  q_copy_answer: string;
  q_copied: string;
  q_copy_failed: string;
  q_quote_pick_note: string;
  /** Reader header chip while an Ask turn is active (A3). */
  q_back_to_ask: string;
  /** Turn chip: retrieval ran with the previous question prepended (A2). */
  q_followup_chip: string;
  // Ask renewal (mockup "Strata"): scope segment, retrieval stepper, source
  // ladder with tier priors, abstention card, archived-session opt-in.
  q_scope_label: string;
  q_scope_wiki: string;
  q_scope_sessions: string;
  q_scope_all: string;
  q_scope_wiki_hint: string;
  q_scope_sessions_hint: string;
  q_scope_all_hint: string;
  q_scope_chip: string; // {scope}
  q_note_scope_chip: string; // {note}
  q_note_scope_hint: string;
  q_note_scope_clear: string;
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
  q_more_passages: string; // {n}
  q_fewer_passages: string;
  q_jump_to_question: string;
  q_ladder_count: string; // {n} {c}
  q_ladder_all: string; // {n}
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
  q_abstain_sub: string;
  q_abstain_sub_none: string;
  q_abstain_details: string;
  q_abstain_numbers: string; // {n} {floor}
  q_abstain_range_numbers: string; // {s} {e} {floor}
  q_abstain_note: string;
  q_abstain_noted: string;
  q_abstain_note_line: string; // {q}
  q_abstain_near: string;
  q_abstain_none: string;
  q_abstain_lexical: string;
  q_abstain_gauge_note: string; // {floor}
  q_abstain_floor_tick: string; // {floor}
  q_abstain_harvest: string;
  q_abstain_harvested: string;
  q_abstain_widen: string;
  q_abstain_range_sub: string; // {s} {e}
  q_abstain_widen_range: string;
  q_abstain_receipt: string;
  // Ask history, retry, stop (UX S36).
  q_history: string;
  q_history_search: string;
  q_history_none: string;
  q_history_cited: string; // {n}
  q_history_abstained: string;
  q_history_failed: string;
  q_history_load_failed: string;
  q_retry: string;
  q_stop: string;
  q_elapsed: string; // {time}
  q_stopped: string;
  q_stopped_sub: string;
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
  sb_row_menu: string;
  sb_edited: string;
  sb_n_items: string;
  // Deletion policy. Legacy settings keep recoverable deletion.
  delete_policy_wait: string;
  set_delete_title: string;
  set_delete_desc: string;
  set_delete_trash: string;
  set_delete_permanent: string;
  set_delete_enable_msg: string;
  delete_permanent_msg: string;
  delete_permanent_one_msg: string;
  qz_expires_due_permanent: string;
  deleted_count: string;
  delete_undo_limit: string;
  sb_delete_msg: string;
  sb_delete_one_msg: string;
  sb_selected: string;
  sb_clear_selection: string;
  sb_new_folder_msg: string;
  sb_rename_msg: string;
  sb_empty_vault: string;
  sb_no_vault: string;
  // My notes vs the folders myco keeps (UX backlog S15, lib/vaultAreas).
  sb_managed: string;
  /** The page tree's name for screen readers (role="tree"). */
  sb_tree: string;
  sb_managed_hint: string;
  sb_agent_mark: string;
  area_raw: string;
  area_sessions: string;
  area_cards: string;
  area_ingest_reports: string;
  area_work: string;
  area_inbox: string;
  area_templates: string;
  area_audio: string;
  area_claude: string;
  // Command bar.
  cb_no_results: string;
  cb_create_q: string; // {q}
  cb_ask_q: string; // {q}
  cb_group_actions: string;
  cb_group_recent: string;
  cb_group_today: string;
  tabbar_label: string;
  cb_group_week: string;
  cb_group_goto: string;
  cb_group_lenses: string;
  cb_tag_page: string;
  cb_tag_file: string;
  cb_tag_note: string;
  cb_tag_action: string;
  cb_in_contents: string;
  cb_semantic: string;
  cb_exact: string;
  cb_operator_hint: string;
  cb_miss_hint: string;
  cb_miss_done: string;
  cb_placeholder: string;
  cb_key_open: string;
  cb_key_miss: string;
  cb_results_n: string; // {n}
  // ⌘K chips (UX backlog S23) and the sidebar's Tags group.
  cb_chips_label: string;
  cb_chip_tag: string;
  cb_chip_folder: string;
  cb_chip_type: string;
  sb_tags: string;
  sb_tag_chip: string; // {tag} {n}
  // Stipe shell (W4-B): sidebar badges, ⌘K lenses, status strip, settings shell.
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
  sb_st_reindex: string;
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
  // Long runs the Topbar reports: live in the activity chip, then a
  // done/failed pill until the page that explains the run is visited.
  tb_harvest_running: string;
  tb_harvest_copying: string;
  tb_harvest_done: string;
  tb_harvest_error: string;
  tb_distill_done: string;
  tb_distill_error: string;
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
  // "Today's inflow" section (activity popover + tray panel + native menu).
  tb_inflow_header: string;
  tb_inflow_sessions: string;
  tb_inflow_last_sweep: string; // {t}
  tb_inflow_sweep_incomplete: string;
  tb_inflow_sweep_failed: string;
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
  /** Spotlight answer's disclosure over each note's similarity (UX S14.7). */
  spot_details: string;
  /** One quoted note's row there; {stem}, {pct}. */
  spot_sim: string;
  spot_open_ask: string;
  spot_open_ask_btn: string;
  spot_no_vault: string;
  spot_busy: string;
  // Spotlight voice quick-capture (W3–6 item 9).
  voice_btn_label: string;
  voice_hint_recording: string;
  capture_inbox_receipt: string; // {rel}
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
  gr_zoom_out: string;
  gr_fit: string;
  gr_zoom_in: string;
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
  /** Completion line on the panel: done, the time, the run's count. */
  rf_done: string; // {time} {n}
  rf_failed: string;
  /** The list after every row was acted on (or a run that found nothing). */
  rf_empty: string;
  rf_extractive: string;
  // Extractive reflect's two mechanical findings. Written by reflectStore (not
  // a model), so unlike LLM output they must speak the UI's language. {page}
  // is the note's name (no folder), {target} the missing note's name.
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
  // First-run onboarding wizard (UX-01; three steps since UX S18).
  ob_title: string;
  ob_skip: string;
  ob_back: string;
  ob_next: string;
  ob_finish: string;
  ob_step: string; // {n} {total}
  ob_vault_linked: string;
  ob_vault_none: string;
  ob_s1_title: string;
  ob_s1_body: string;
  ob_s1_action: string;
  ob_demo_start: string;
  ob_note_title: string;
  ob_note_body: string;
  ob_note_name: string;
  ob_note_ph: string;
  ob_note_file: string;
  ob_note_loaded: string; // {name}
  ob_note_skip_hint: string;
  ob_note_exists: string;
  ob_note_failed: string; // {error}
  ob_note_load_failed: string; // {error}
  ob_seed_do: string;
  ob_s3_title: string;
  ob_s3_body: string;
  ob_ask_label: string;
  ob_first_question: string;
  ob_first_question_note: string; // {title}
  ob_ask_now: string;
  ob_index_title: string;
  ob_index_progress: string; // {done} {total}
  ob_index_failed: string;
  // Home guide card: what the wizard no longer asks a new user (UX S18).
  ob_guide_title: string;
  ob_imp_title: string;
  ob_imp_body: string;
  ob_imp_claude: string;
  ob_imp_codex: string;
  ob_imp_progress: string; // {done} {total}
  ob_imp_done: string; // {n}
  ob_imp_quarantined: string; // {n}
  ob_hist_title: string;
  ob_hist_body: string;
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
  // Home notices (spec 2026-10-02): the bell in Home's title row, its
  // popover, and the plain line for each lint message (overviewReport.ts).
  hn_label: string;
  hn_label_n: string; // {n}
  hn_empty: string;
  hn_loading: string;
  hn_error: string;
  hn_changes: string;
  hn_check: string;
  hn_contra: string;
  hn_see_all: string;
  hn_contra_open: string;
  chk_no_frontmatter: string;
  chk_no_type: string;
  chk_bad_type: string;
  chk_superseded: string;
  chk_disputed: string;
  chk_citation: string;
  chk_footnote: string;
  chk_source_count: string;
  chk_source_count_nan: string;
  chk_confidence: string;
  chk_other: string;
  ov_view_runs: string;
  // Overview arrange mode (components/OverviewArrange.tsx) — the page's own
  // blocks moved and resized like the board's widgets.
  ovl_edit: string;
  ovl_done: string;
  ovl_reset: string;
  ovl_reset_done: string;
  ovl_hint: string;
  ovl_span: string;
  ovl_span_full: string;
  ovl_move: string; // {block}
  ovl_moved: string; // {block} {index} {total}
  ovl_vacant: string;
  ovl_b_pulse: string;
  ovl_b_harvest: string;
  // Contradiction queue (Q4 item 15) — optional; fall back to English.
  contra_title: string;
  contra_disputed: string;
  contra_stale: string; // {t}
  contra_mark_active: string;
  contra_mark_superseded: string;
  contra_open_page: string;
  contra_open_target: string;
  contra_ignore: string;
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
  ritual_keep: string;
  ritual_later: string;
  // Home ask-or-capture band (UX S7).
  home_ask_ph: string;
  home_ask_keys: string;
  home_ask_send: string;
  home_capture_send: string;
  home_captured: string;
  home_capture_failed: string;
  home_open_daily: string;
  home_greet_morning: string;
  home_greet_afternoon: string;
  home_greet_evening: string;
  // Reader ‹ › on a daily note (UX S7).
  rd_day_prev: string;
  rd_day_next: string;
  // Run drill-in on History (W3–6 item 6).
  history_runs_title: string;
  history_run_open_why: string;
  /** S29: a run's kind, before its date (lib/runList runTitle). */
  history_run_kind_digest: string;
  history_run_kind_llm: string;
  history_run_kind_distill: string;
  history_undo_q: string;
  history_undo_msg: string;
  history_no_commit: string;
  history_diff_too_large: string;
  history_status_added: string;
  history_status_modified: string;
  history_status_renamed: string;
  history_status_deleted: string;
  // Authorship badge + human-only sidebar filter (Q4 item 16).
  auth_badge_human: string; // {h} {a}
  auth_badge_last_human: string; // {t}
  rd_auth_section: string;
  auth_filter_pill: string;
  /** The pill's tooltip: what turning it on does. */
  auth_filter_hint: string;
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
  notch_failed: string; // a running job that ended in a failure
  notch_capture: string;
  notch_capture_save: string;
  notch_capture_voice: string;
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
  // The agenda: decisions waiting, shown collapsed as a count and offered as
  // rows on hover (lib/notchAgenda). The proposal and link rows reuse the
  // app's own words for those actions (pf_approve / ls_accept / …) so the
  // notch never invents a second name for the same decision.
  notch_waiting: string; // {n} — the collapsed mark's accessible name
  notch_agenda_harvest_title: string;
  notch_agenda_links_title: string; // {n}
  notch_agenda_links_all: string;
  notch_agenda_harvest_sub: string; // {n}
  notch_agenda_harvest: string; // {n} — the row's one button
  notch_agenda_dropped: string; // the 1.5s beat after a no
  // Settings toggle for the notch surface (macOS).
  s_notch_title: string;
  s_notch_desc: string;
  // Tidy (정리): the sheet, its entry points and Settings → 내 공간 → 정리.
  tidy_btn: string;
  tidy_btn_title: string;
  tidy_cmd: string;
  tidy_title: string;
  tidy_lede: string;
  tidy_loading: string;
  tidy_empty: string;
  tidy_error: string;
  tidy_retry: string;
  tidy_g_titles: string;
  tidy_g_titles_desc: string;
  tidy_g_links: string;
  tidy_g_links_desc: string;
  tidy_g_move: string;
  tidy_g_move_desc: string;
  tidy_removed: string;
  tidy_show_all: string; // {n}
  tidy_show_less: string;
  tidy_skipped: string; // {n}
  tidy_apply: string; // {n}
  tidy_applying: string;
  tidy_done: string; // {n}
  tidy_failed: string; // {n}
  tidy_undo: string;
  tidy_undoing: string;
  tidy_undone: string; // {n}
  tidy_undo_skipped: string;
  tidy_changed: string;
  tidy_rescan: string;
  tidy_s_desc: string;
  tidy_s_run: string;
  tidy_s_history: string;
  tidy_s_last: string; // {when} {n}
  tidy_s_last_undone: string;
  tidy_s_none: string;
}

export const STRINGS: Record<Lang, Strings> = {
  en: {
    ...EVERYDAY_STRINGS.en,
    app_name: "myco",
    quick_search: "Search or jump to…",
    quick_ask: "Ask the wiki",
    nav_workspace: "Workspace",
    nav_pages: "My notes",
    nav_tools: "More tools",
    nav_overview: "Home",
    nav_ingest: "Add sources",
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
    bd_deleted: "Board “{name}” deleted",
    bd_board_exists: "Board “{name}” already exists, so it opened",
    bd_name_refused: "“{name}” can’t be a board name",
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
    ci_partial: "Import incomplete · imported {i} · skipped {s} · failed {f}. Review held or failed sources below.",
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
    q_empty: "Ask about what you have saved. Each answer links to your notes.",
    s_mascot: "Show MYCO, the mascot",
    s_mascot_hint:
      "Loaders, empty states and the About page. Off = static logo.",
    s_roam: "Roam the screen while working",
    s_roam_hint:
      "While long work runs, MYCO hops out of the notch and around your screen, then goes back in when it is done. Now and then it also takes a short walk on its own. It stays in the notch with Reduce motion on, a full-screen app in front, or the screen locked.",
    myco3d_label: "myco in 3D. Drag or use the arrow keys to turn it. Home turns it back to the front.",
    myco3d_loading: "Getting myco ready…",
    myco3d_error: "This screen can't show 3D, so here is myco as a picture.",
    s_myco3d: "myco in 3D",
    s_myco3d_hint: "A black or a white myco you can turn around. Drag it, or click it and use the arrow keys.",
    s_myco3d_skin: "Color",
    s_myco3d_black: "Black",
    s_myco3d_white: "White",
    myco_spin_label:
      "myco turning around. Drag sideways or use the left and right arrow keys to turn it. Home turns it back to the front.",
    myco_spin_error: "The video can't play here, so here is myco as a picture.",
    s_myco3d_view: "View",
    s_myco3d_video: "Video",
    s_myco3d_model: "3D",
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
    hw_sc_live_link: "Open a link in a note. To edit it, move into it with the arrow keys",
    hw_sc_live_link_touch: "Open a link in a note. To edit it, tap just beside it and move the cursor in",
    hw_sc_back: "Back",
    hw_sc_fwd: "Forward",
    hw_md: "Markdown · in the editor",
    hw_sc_bold: "Bold (again: off)",
    hw_sc_italic: "Italic",
    hw_sc_code: "Inline code on a selection",
    hw_sc_link: "Link the selection to a note",
    hw_sc_highlight: "Highlight",
    hw_sc_slash: "Blocks menu",
    hw_sc_wikilink: "Link a note by name",
    hw_tip_graph1: "Drag a star and the simulation re-heats around it.",
    hw_tip_graph2:
      "F flies the spaceship; the settings drawer holds the layouts, skins and near-field planets.",
    hw_tip_graph3:
      "Pick a question above — the encoding changes, the layout does not — and work the gaps column on the left.",
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
    tasks_compose_category_ph: "e.g. work",
    tasks_compose_project_ph: "e.g. a project note",
    tasks_detail_estimate_ph: "e.g. 2d",
    tasks_detail_recur_ph: "e.g. every week",
    tasks_due_named: "Due {date}",
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
    skip_to_content: "Skip to content",
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
    ov_recent_moved: "Recent notes",
    ov_recent_never: "Your notes will appear here. Add a source or write your first note above.",
    home_links_today: "Linked today:",
    home_links_more: " and {n} more",
    home_links_cites: "New citations: {n}",
    home_links_none: "Nothing newly linked today",
    home_links_updated: "Updates when a note is saved",
    ing_title: "Ingest",
    ing_lede:
      "Drop a file, paste a URL, or write a note. myco will route it through Claude, extract entities and concepts, write a source page, and weave it into the graph.",
    ing_drop: "Drop a file here",
    ing_drop_or: "or paste a URL",
    ing_browse: "Browse files…",
    ing_image_capability_unavailable:
      "Image input support has not been verified for the selected Harvest and Compilation model. Use a text source or check Model settings. Choosing an external vision model is optional.",
    ing_source_authority_changed:
      "The open vault or Harvest and Compilation permission changed or could not be verified. Check Model settings and retry from the current screen.",
    ing_source_credential_unavailable:
      "Credentials for the selected Harvest and Compilation model are unavailable. Check Model settings or use a text source. External models are optional.",
    ing_drop_multi:
      "Loaded the first of {n} files — this form takes one source at a time. Drop the rest one by one.",
    ing_inbox_pending: "Waiting in _inbox ({n})",
    ing_inbox_empty: "Nothing waiting — arrivals have already been ingested.",
    ing_inbox_today: "today",
    ing_inbox_unsupported_chip: "unsupported",
    ing_inbox_unsupported_line: "{n} unsupported — left in place.",
    ing_yt_fetch: "Fetch YouTube transcript",
    ing_yt_fetching: "Fetching transcript…",
    ing_web_fetch: "Import this page",
    ing_web_fetching: "Importing page…",
    ing_web_rule_visible: "Only text anyone can see is imported — paywalled or sign-in pages won't work.",
    ing_web_rule_private: "Links to your own computer or a home or office network are never opened.",
    ing_web_rule_keep: "The page text replaces the link in the box; nothing is saved until you press the button below.",
    ing_web_pii_warn: "Heads-up: this page contains personal details such as phone numbers or emails.",
    ing_web_err_bad_url: "That doesn't look like a web address.",
    ing_web_err_scheme: "Only http:// and https:// links can be imported.",
    ing_web_err_credentials: "Links with a name and password in them are not opened.",
    ing_web_err_blocked: "This link points to your own computer or a private network, so it was not opened.",
    ing_web_err_resolve: "Couldn't find that site. Check the address.",
    ing_web_err_redirect: "The site sent us on to an address that can't be followed.",
    ing_web_err_redirects: "The site sent us on to another address too many times.",
    ing_web_err_status: "The site answered with an error ({n}).",
    ing_web_err_not_html: "This link isn't a web page — it may be a PDF or another file.",
    ing_web_err_too_large: "The page is bigger than 5 MB.",
    ing_web_err_timeout: "The site took too long to answer.",
    ing_web_err_network: "Couldn't connect. Check your internet connection.",
    ing_web_err_empty: "No readable text was found on that page.",
    ing_web_err_secret: "The page contains what looks like a password or key, so it was not imported.",
    ing_web_err_pii: "The page contains personal details and personal info is set to Quarantine, so it was not imported.",
    ing_web_err_scan: "Couldn't check the page for passwords or personal details, so it was not imported.",
    ing_guard_secret: "The text contains what looks like a password or key, so nothing was saved. Remove it and run again.",
    ing_guard_pii: "The text contains personal details and personal info is set to Quarantine, so nothing was saved.",
    ing_guard_scan: "Couldn't check the text for passwords or personal details, so nothing was saved.",
    ing_guard_pii_warn: "Heads-up: this text contains personal details such as phone numbers or emails. It will be kept as is.",
    ing_web_err_other: "Couldn't import the page.",
    ing_paste_url_ph: "https://example.com/paper.pdf",
    ing_or_paste: "Or paste raw text",
    ing_paste_ph: "Paste an article, your notes, or a conversation…",
    ing_run: "Organize source",
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
    ingest_gate_apply: "Apply only the {n} selected",
    ingest_gate_all: "Apply all ({n})",
    ingest_gate_noop_hint:
      "“Already there” items are in the wiki already, so they start unchecked.",
    ing_cancel: "Cancel",
    ing_cancelled: "Ingest cancelled",
    ing_gate_title: "Reviewing the plan — choose what to apply",
    ing_gate_waiting:
      "Waiting for your choice. Writing starts once you pick what to apply.",
    ing_clear: "Clear text",
    ing_touched_n: "{n} page(s) updated",
    ing_refused_more: "Paste more",
    ing_short_title: "Short notes can go straight into your notes",
    ing_short_daily: "Write in today's note",
    ing_short_new: "Save as a new note",
    ing_short_new_failed: "Could not save the note",
    ing_gate_paused: "Waiting for your choice",
    ing_gate_source: "What you pasted",
    ing_more_advanced: "Advanced",
    ing_pick_file: "Choose a file",
    ing_preview_open: "Open page",
    ing_preview_close: "Close preview",
    ing_preview_writing: "Still being written — try again in a moment.",
    ing_chip_done: "Ingest done",
    ing_chip_error: "Ingest failed",
    q_title: "Ask your notes",
    q_lede:
      "myco answers from your wiki first, then reaches into raw sources only when needed. Every claim ships with a citation.",
    q_send: "Ask",
    q_recent: "Recent questions",
    q_answer: "Answer",
    q_sources_used: "Sources used",
    q_wiki: "wiki",
    q_raw: "raw",
    gr_title: "Graph",
    gr_lede:
      "Pages and the links between them. Drag nodes to feel the simulation pull, click a node to open it, open the settings panel to tune.",
    gr_canvas_aria: "Vault link map. Arrow keys move the selection, Enter opens the note.",
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
    gr_q_neighbors_u: "2 steps",
    gr_q_sub_neighbors: "up to 2 steps from the selected note",
    gr_q_pick: "Pick a note first",
    gr_size: "Node size",
    gr_size_backlinks: "size = backlinks",
    gr_size_cites: "size = citations",
    gr_hide_sample: "Hide the {n} sample notes",
    gr_show_unresolved: "Show unresolved links",
    gr_rebuilds: "scene rebuilds {n} · {ms} ms",
    gr_honest_lead: "This graph draws {n} nodes",
    gr_honest: "first-run sample {sample} ({pct}%) · your own notes {own} · unresolved {unresolved}. Notes carrying a citation: {cited}.",
    gr_honest_sessions: "{n} archived sessions are excluded; this map shows notes and their links.",
    gr_summary: "{own} of your notes, {gaps} missing links",
    gr_details: "Details",
    gr_gap_nobacklink: "Nobody links here",
    gr_act_link: "Suggest links",
    gr_act_harvest: "Mark as wanted",
    gr_act_neighbors: "Show its neighbours",
    gr_act_open_s: "open",
    gr_act_link_s: "link",
    gr_act_want_s: "want",
    gr_insp_cites: "Citations",
    gr_insp_sample: "first-run sample",
    gr_insp_own: "your note",
    gr_insp_nocite: "no citation",
    gr_enc_orphans: "colour = category · size = links · dim = already connected",
    gr_enc_clusters: "block = cluster · dashed = no map page · dotted line = unlinked but related",
    gr_enc_time: "colour = last edited (one ramp) · ring = within 30 days · dim = untouched for 90 days",
    gr_enc_neighbors: "closer is brighter (the note and its direct links lit, 2 steps away dim, the rest nearly invisible)",
    gr_enc_strata: "x = last edited (oldest left) · band = cluster",
    gr_link_question: "\"{a}\" sits unconnected in my vault. Which of my notes should link to it, and what would the link say?",
    gr_want_done: "Logged \"{n}\" as a wanted topic",
    gr_legend: "Legend",
    gr_filter: "Filter",
    gr_filter_folder: "folder: {f}",
    gr_filter_search: "search: {q}",
    gr_filter_remove: "Remove filter {f}",
    gr_filter_empty: "No note matches the filters",
    gr_filter_clear: "Clear filters",
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
    gr_skin_web: "Cosmic web",
    gr_recency: "Recency glow",
    gr_recency_hint: "Recently edited notes burn hotter",
    gr_minimap: "Minimap",
    gr_minimap_hint: "Corner chart of the whole galaxy; click to fly",
    gr_layout_spiral: "Spiral galaxy",
    gr_layout_strata: "Chronicle",
    gr_layout_semantic: "Semantic map",
    gr_layout_celestial: "Celestial sphere",
    gr_layout_radial: "Radial orbit",
    gr_layout_walrus: "Walrus tree",
    gr_layout_mycelium: "Mycelium mat",
    gr_skin_sigma: "Sigma",
    gr_skin_mycelium: "Mycelium",
    gr_mycelium_dim: "Mycelium view",
    gr_mycelium_3d: "3D",
    gr_mycelium_2d: "2D",
    gr_myc_node_color: "Node colour",
    gr_myc_hypha_color: "Hyphae colour",
    gr_myc_bg: "Background",
    gr_myc_bg_loam: "Loam",
    gr_myc_bg_void: "Void",
    gr_myc_bg_soil: "Soil",
    gr_myc_bg_paper: "Paper",
    gr_myc_bg_grid: "Grid",
    gr_myc_bg_custom: "Custom background",
    gr_vibes: "One-tap looks",
    gr_vibe_living: "Living galaxy",
    gr_vibe_sigma: "Sigma board",
    gr_vibe_cosmicweb: "Cosmic web",
    gr_vibe_neural: "Neural",
    gr_vibe_planetarium: "Planetarium",
    gr_vibe_paper: "Paper atlas",
    gr_vibe_chronicle: "Chronicle",
    gr_vibe_nebula: "Meaning nebula",
    gr_vibe_living_desc: "The default — a glowing, breathing star map",
    gr_vibe_sigma_desc: "A still dark map with topic colours and fine connections",
    gr_vibe_cosmicweb_desc: "Dark-matter filaments; the links are the picture",
    gr_vibe_neural_desc: "A firing nervous system in the void",
    gr_vibe_planetarium_desc: "Constellations per topic under a deep-space sky",
    gr_vibe_paper_desc: "A print-like territory map on white paper",
    gr_vibe_chronicle_desc: "Time strata — the vault read as history",
    gr_vibe_nebula_desc: "Notes clustered by meaning (embeddings)",
    gr_vibe_walrus: "Walrus tree",
    gr_vibe_mycelium: "Mycelium",
    gr_vibe_walrus_desc:
      "A hyperbolic spanning tree in a sphere (CAIDA Walrus)",
    gr_vibe_mycelium_desc: "A grown fungal mat, with the notes hung on it",
    gr_looks: "Looks",
    gr_appearance: "Appearance",
    gr_motion_fx: "Motion & effects",
    gr_mascot_cameo: "MYCO cameo",
    gr_mascot_cameo_hint: "MYCO drifts in now and then with a feature tip",
    mc_label: "MYCO tip",
    mc_dismiss: "Dismiss",
    mc_tip_drag:
      "Drag any star and the simulation re-heats \u2014 its neighbours follow, then spring back.",
    mc_tip_path:
      "Cmd/Ctrl-click two notes to light the shortest path between them.",
    mc_tip_fly:
      "Press F to pilot a spaceship through your vault \u2014 WASD to fly, Esc to land.",
    mc_tip_looks:
      "Open the settings panel and tap a Look \u2014 Sigma, Paper, Neural, Planetarium\u2026",
    mc_tip_timelapse:
      "Play the Timelapse to watch your vault build itself in the order you wrote it.",
    mc_tip_multiverse:
      "Turn on Multiverse to see every project as its own glowing universe-bubble.",
    mc_tip_minimap:
      "That corner minimap? Click anywhere on it to fly the camera there.",
    mc_tip_recency:
      "Recently edited notes burn hotter \u2014 the graph maps where your attention is.",
    mc_tip_save:
      "Tuned a look you love? Name it under Saved looks and recall it with one tap.",
    mc_tip_chronicle:
      "Try the Chronicle layout \u2014 your notes laid out along a real time axis.",
    gr_saved: "Saved looks",
    gr_saved_apply: "Apply this saved look",
    gr_saved_delete: "Delete",
    gr_saved_empty: "Save the current settings to recall them later.",
    gr_saved_name_ph: "Name this look\u2026",
    gr_saved_save: "Save",
    gr_layout_3d: "3D \u2014 orbit in space",
    gr_layout_2d: "2D \u2014 flat map",
    gr_layout_galaxy_s: "Galaxy",
    gr_layout_synapse3d_s: "Synapse",
    gr_layout_atlas_s: "Atlas",
    gr_layout_synapse_s: "Synapse (flat)",
    gr_cinematic: "Cinematic finish",
    gr_cinematic_hint: "Film grain, vignette, lens streaks, anti-aliasing",
    gr_flow: "Edge flow",
    gr_flow_hint: "Light pulses ride links source \u2192 target",
    gr_semantic_missing:
      "Semantic map needs the embedding index — run Reindex under Settings \u2192 Model, then reopen. Showing the spiral instead.",
    gr_galaxies: "Folder galaxies",
    gr_galaxies_hint:
      "Split the vault into one slowly rotating galaxy per folder",
    gr_multiverse: "Multiverse",
    gr_multiverse_hint:
      "Show every project as its own universe-bubble; fly into one to open it",
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
    gr_edge_bundles_hint:
      "Merge links between two topics into one weighted arc",
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
    gr_pixel_nodes: "Pixel nodes",
    gr_pixel_nodes_hint: "16x16 pixel-art sprites instead of glowing dots",
    gr_color_depth: "Colour depth",
    gr_edge_tint: "Link colour",
    gr_edge_tint_grey: "Grey",
    gr_edge_tint_community: "Community webs",
    gr_help_btn: "Gestures & keys",
    gr_more_menu: "More",
    gr_canvas_label: "{n} notes",
    gr_canvas_label_sel: "{n} notes, selected: {name}",
    gr_help_title: "Gestures & keys",
    gr_help_click: "Focus a note (its direct links)",
    gr_help_dblclick: "Widen focus to 2 steps",
    gr_help_cmdclick: "Shortest path between notes",
    gr_help_esc: "Close the top panel, or step out of the focus",
    gr_help_fly: "Toggle spaceship mode",
    gr_help_drag: "Orbit the cosmos",
    gr_help_rails: "Collapse or expand the gaps / legend panel",
    gr_rail_fold: "Collapse {name}",
    gr_rail_open: "Expand {name}",
    gr_panels: "Panels",
    gr_trace: "Trace path",
    gr_trace_hint: "Click a start node, then an end node",
    gr_spaceship: "Spaceship",
    gr_spaceship_hint:
      "WASD fly · drag to steer · click a node for info · Esc exit",
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
    gr_myc_spread: "Mat spread",
    gr_myc_branch: "Branch density",
    gr_myc_forces_hint:
      "Mycelium is grown, not simulated: these two sliders reshape the mat.",
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
    gr_insp_back: "Back to {n}",
    gr_not_in_graph: "This note is not in the graph right now: a filter or an excluded folder hides it.",
    gr_insp_unresolved: "Unresolved note (no file yet)",
    gr_insp_none: "—",
    gr_find_ph: "Find a note…",
    gr_insp_path_start: "Set as path start",
    gr_insp_path_anchor: "Path start",
    gr_insp_path_clear: "clear",
    gr_insp_path: "Path",
    gr_insp_path_none: "No path to this node",
    gr_insp_hops: "steps",
    gr_gaps_title: "Gaps",
    gr_tools: "Graph tools",
    s_back_list: "All settings",
    gr_rails_sheet: "Gaps and legend",
    gr_legend_empty: "Nothing to list yet.",
    gr_gesture_hint: "Drag to look around, pinch to zoom, tap a star to see its neighbours.",
    gr_gesture_ok: "Got it",
    gr_gaps_btn: "Gap analysis",
    gr_gap_missing: "Missing pages",
    gr_gap_malformed: "Malformed links",
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
    gr_motion_hint_myc: "Slow 3D auto-orbit (3D view only)",
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
    p_lint_running:
      "Lint is running — you can keep browsing; it continues in the background.",
    p_lint_done: "Lint done",
    p_lint_failed: "Lint failed",
    s_title: "Settings",
    s_search_ph: "Search settings",
    s_search_empty: "No settings match “{q}”",
    s_account: "My space",
    s_local_user: "Local user",
    s_no_vault: "no vault",
    s_vault_path: "Notes folder",
    s_change: "Change…",
    q_empty_response: "(empty response)",
    eb_title: "Something went wrong in {area}.",
    eb_reload: "Reload myco",
    eb_retry: "Try again",
    eb_area_app: "the app",
    eb_area_graph: "the graph",
    eb_home: "Go to Home",
    eb_details: "Details",
    s_workspace: "Workspace",
    s_model: "AI settings",
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
    s_providers: "AI connections",
    s_appearance: "Appearance",
    s_vault_known: "Vaults myco already knows",
    s_storage_title: "Storage",
    s_storage_desc: "Where this vault lives, what myco could not read, and when it last saved.",
    s_storage_where: "Location",
    s_storage_icloud: "iCloud Drive",
    s_storage_dropbox: "Dropbox",
    s_storage_unread: "Not downloaded or unreadable",
    s_storage_unread_none: "None",
    s_storage_unread_n: "{n} files",
    s_storage_checking: "Checking…",
    s_storage_unread_hint: "myco could not read these, so links and the graph may leave them out. Once a file is downloaded or fixed, myco reads it again — at the latest when the vault is opened again.",
    s_storage_history: "Vault history",
    s_storage_last_save: "Last saved",
    s_storage_no_save: "Nothing saved yet this session",
    s_ov_theme: "Overview background",
    s_ov_theme_lede:
      "The living background behind the greeting and the ask box on Home, also shown under Review & organize. Named after the graph's layouts; not linked to them.",
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
    s_mcp: "External tools (MCP)",
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
      "myco uses local models by default. Select a model for each task; external models are optional and run only when you connect and select them.",
    s_model_ingest: "Ingest model",
    s_model_query: "Query model",
    model_custom: "Custom\u2026",
    model_disconnected: "(not connected)",
    model_effort: "Reasoning effort",
    model_custom_ph: "model id",
    model_apply_custom: "Apply model",
    model_fetching: "fetching model list\u2026",
    s_model_recommended: "Recommended",
    s_model_use_recommended: "Use the recommended setting",
    s_model_choose_own: "Choose myself",
    s_model_recommended_needs: "Prepare the local model above to run it. No external account is required.",
    s_model_ctx: "context",
    ing_extractive_note:
      "Extractive summary — every line below is quoted verbatim from `raw/{slug}.md`. No model read this source, so nothing here is paraphrased and nothing is inferred.",
    ing_extractive_report_title: "Extractive ingest: {title}",
    local_transform_note: "Local preview from {selected}/{total} chunks · {model} · low confidence",
    local_transform_fallback_note: "Local preview unavailable · {model}; source quotes retained",
    local_transform_report_why: "A local model produced a bounded preview; all source evidence was retained. Tags and related links remain deterministic.",
    ing_local_transform_hint: "This computer creates a summary draft and retains source quotes. Review the draft's claims.",
    ing_run_local_transform: "Add summary and source quotes",
    ing_extractive_report_why:
      "This run used the built-in offline path. Passages were quoted verbatim from the source and cited, tags were reused from the vault's existing tags, and the related pages came from the local embedding index. **No model was called.** `confidence` is `low` because nothing summarised the source — re-running with a connected provider can replace the page.",
    ing_extractive_log:
      "{date} — extractive ingest of [[source-{slug}]] ({title}), no model call",
    ing_extractive_hint:
      "Extractive — quotes your source verbatim and makes no model call.",
    ing_run_extractive: "Ingest extractively",
    ing_extractive_pending: "{n} source passages remain. The next run continues from here; the original stays in place.",
    set_distill_evidence_pending: "{n} sources still have passages to organize. Run again to continue; their records remain available.",
    workflow_pending: "Waiting to continue",
    workflow_partial: "Partially completed",
    workflow_stopped: "Stopped",
    session_compile_label: "Session organization",
    session_compile_progress: "{processed}/{total} sections processed",
    session_compile_stopping: "Confirming stop…",
    session_compile_preparation: "Session organization · prepare the selected local model",
    session_queue_title: "Session organization queue",
    session_queue_refresh: "Refresh list",
    session_queue_idle: "Open a folder to view its session organization queue.",
    session_queue_failed: "Could not read the queue. Refresh the list to try again.",
    session_queue_empty: "No unfinished session organization work.",
    session_queue_count: "{total} unfinished work items · showing {shown}",
    session_queue_running: "In progress",
    session_queue_completed: "Processing completed",
    session_queue_superseded: "Replaced by a newer revision",
    session_queue_unknown: "Status needs checking",
    session_queue_runtime_review: "The previous run requires a fresh review.",
    session_queue_conditions_review: "Saved work requires review under the current organization rules.",
    session_queue_reason_other: "The saved reason is available in details.",
    session_queue_details: "Details",
    session_queue_preparation: "The selected model is not ready for session organization.",
    session_queue_incomplete: "Some sections or their review remain unfinished.",
    session_queue_model_failed: "The selected model could not finish this run.",
    session_queue_processing_failed: "Processing failed; the saved reason is available in details.",
    workflow_failed: "Could not finish",
    workflow_skipped: "Nothing to process",
    workflow_review_retry: "Review and retry",
    workflow_retry_hint: "Check the cause below, then retry the remaining work.",
    s_providers_lede:
      "Bring your own provider. myco never sees your keys — they're stored locally.",
    s_provider_connected: "Connected",
    s_provider_disconnected: "Not connected",
    s_provider_error: "Couldn't update {name}",
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
    s_autoingest_title: "Auto-organize inbox and sessions",
    s_autoingest_desc:
      "While myco is open, organize inbox sources and session updates received from connected tools using your selected ingest provider. Updates to the same conversation keep one summary page.",
    s_autoingest_interval: "Every",
    s_provider_connect: "Connect",
    s_provider_disconnect: "Disconnect",
    s_provider_test: "Test",
    s_provider_kind_cli: "Installed app",
    s_provider_kind_api: "API key",
    s_provider_kind_local: "On this computer",
    s_provider_name_builtin_local: "Built-in (offline)",
    s_provider_key_ph: "Paste API key",
    s_provider_key_save: "Save",
    s_provider_checking_ollama: "Checking Ollama…",
    s_provider_keychain_note: "API keys are stored in your OS keychain (macOS Keychain / Windows Credential Manager / Secret Service), not in plaintext on disk.",
    s_lang_lede:
      "myco's UI and Claude's drafting language are independent — write English notes from a Korean UI if you like.",
    s_lang_ui: "Interface",
    s_lang_drafts: "Drafting language (Claude)",
    s_appearance_lede: "Theme follows your system by default.",
    s_appearance_light: "Light",
    s_appearance_dark: "Dark",
    s_appearance_system: "System",
    s_text_size: "Text size",
    s_text_size_desc: "How big note and answer text reads.",
    s_text_size_system: "Follow system settings",
    s_text_size_custom: "Choose myself",
    s_text_size_small: "Small",
    s_text_size_medium: "Medium",
    s_text_size_large: "Large",
    s_text_size_sample: "Notes and answers read at this size.",
    s_about_built:
      "myco is a thin client over a local Obsidian vault and the Claude Code CLI. Pages are plain markdown — your knowledge stays yours.",
    dlg_cancel: "Cancel",
    dlg_ok: "OK",
    dlg_create: "Create",
    dlg_delete: "Delete",
    dlg_rename: "Rename",
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
    rd_source: "Edit Markdown source",
    rd_source_active: "Editing Markdown source",
    rd_back_to_write: "Close Markdown source",
    rd_raw_read_only: "This imported original is read-only. Select a sentence to quote it in today's note.",
    rd_quote_to_daily: "Quote in today's note",
    rd_quote_to_card: "Make a card",
    rd_quote_actions: "Selected text",
    rd_quote_card_none:
      "No card can be made from this selection. Select one whole sentence.",
    rd_quote_card_title: "Cards from this sentence",
    rd_quote_card_msg: "Each card is the selected sentence word for word, with one term left blank. Saving also puts the sentence in today's note with its source; the checked cards go to {deck}.",
    rd_quote_pick_title: "Pick the word to blank out",
    rd_quote_pick_msg: "This sentence has no bold text or wikilink, so pick the word the card asks for. Saving also puts the sentence in today's note with its source; the card goes to {deck}.",
    rd_quote_pick_front: "Card front",
    rd_quote_pick_empty: "No word picked yet.",
    rd_loading: "Opening the note…",
    rd_not_found: "This note could not be found",
    rd_not_found_sub: "It may have been moved, renamed or deleted.",
    rd_unreadable: "This note could not be opened",
    rd_find_note: "Search notes",
    rd_go_home: "Go to Home",
    rd_type_note: "note",
    rd_save_failed: "Saving this draft to the file has not been confirmed. Copy any changes you want to keep, or reload the file and merge your changes manually.",
    rd_retry_save: "Save again",
    rd_copy_draft: "Copy draft",
    rd_draft_copied: "Draft copied",
    rd_draft_copy_failed: "Could not copy the draft",
    rd_original_baseline: "Original editing baseline",
    rd_current_file: "Last read file contents",
    rd_recovery_draft: "Local recovery draft",
    rd_retry_file_read: "Retry reading file",
    rd_copy_baseline: "Copy original baseline",
    rd_baseline_copied: "Original baseline copied",
    rd_baseline_copy_failed: "Could not copy the original baseline",
    rd_recovered_draft: "A local recovery draft and its original editing baseline are available. Saving the draft to the current file has not been confirmed. Compare the original baseline and current file before reloading and merging your changes manually.",
    rd_reload_draft: "Discard draft and reload",
    rd_reload_draft_title: "Discard the draft and reload the file?",
    rd_reload_draft_confirm: "Copy any changes you want to keep first. Once the file is read successfully, its latest contents will replace this unsaved draft. You can then paste and manually merge your copied changes.",
    rd_reloading_draft: "Reloading…",
    rd_draft_reloaded: "The latest file has been loaded. Paste the changes you want to keep from your copied draft to merge them manually.",
    rd_draft_reload_failed: "Could not reload the file. The draft has been preserved.",
    rd_saving: "Saving…",
    rd_saved: "Saved",
    rd_save_pending: "Waiting to autosave…",
    rd_not_saved: "Not saved",
    rd_task_toggle: "Toggle task",
    rd_frontmatter_hidden: "Note details · Edit in Note info",
    live_ph_block: "Type '/' for blocks",
    live_sources: "Sources",
    start_chips_label: "Start with",
    start_day_todo: "Today's tasks",
    start_day_todo_body: "## Today's tasks\n- [ ] ${}",
    start_day_meeting: "Meeting notes",
    start_day_meeting_body: "## Meeting notes\n- Who: ${}\n- Notes: ",
    start_day_thoughts: "Thinking it through",
    start_day_thoughts_body: "## Thoughts\n- ${}",
    rd_toc_empty: "No headings yet",
    rd_embed_loading: "Loading…",
    rd_embed_missing: "Section not found",
    ch_err_type: "Chart type must be bar, line or pie",
    ch_err_line: "Line {n} is not “key: value”",
    ch_err_data: "This chart has no data: under Edit, choose a table or type the values",
    ch_err_table: "The table this chart reads is not in this note",
    ch_err_number: "“{value}” is not a number",
    mm_err: "Mermaid could not draw this diagram",
    callout_kind_note: "Note",
    callout_kind_tip: "Tip",
    callout_kind_info: "Info",
    callout_kind_warning: "Warning",
    callout_kind_danger: "Danger",
    callout_kind_success: "Success",
    callout_kind_quote: "Quote",
    callout_kind_important: "Important",
    callout_kind_caution: "Caution",
    callout_kind_question: "Question",
    rd_backlinks_empty: "No notes link here yet.",
    rd_related: "Related",
    rd_related_no_index:
      "Related notes come from an on-device index that hasn't been built yet.",
    rd_related_no_index_cta: "Set up semantic search",
    rd_make_cards: "Make cards",
    rd_making: "Generating…",
    rd_cards_none:
      "No cards can be made from this note — it needs sentences with a citation, bold text or a wikilink.",
    rd_cards_made: "{n} cards added",
    rd_open_study: "Open study",
    rd_cards_preview_title: "Cards from this note",
    rd_cards_preview_msg: "Each card quotes this note word for word. Uncheck any you don't want; the rest are saved to {deck}.",
    rd_cards_save: "Save",
    rd_cards_dupe: "Already in the deck",
    rd_cards_ai_tag: "AI draft",
    rd_cards_all_dupes: "Every card from this note is already in {deck}.",
    rd_cards_none_picked: "No cards were checked, so nothing was saved.",
    rd_more: "More",
    rd_ask_note: "Ask this note",
    rd_rail: "Note info",
    rd_view_graph: "View in graph",
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
    rd_conn_backs: "Backlinks",
    rd_conn_sug: "Suggested",
    rd_conn_added: "[[{name}]] added under ## Related",
    rd_auth_show: "Show authorship marks",
    rd_auth_hide: "Hide authorship marks",
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
    sl_h4: "Heading 4",
    sl_bullet: "Bulleted list",
    sl_numbered: "Numbered list",
    sl_todo: "To-do",
    sl_code: "Code block",
    sl_quote: "Quote",
    sl_table: "Table",
    sl_divider: "Divider",
    sl_date: "Today's date",
    sl_callout: "Callout",
    sl_toggle: "Toggle list",
    sl_link: "Link to note",
    sl_image: "Image",
    sl_embed: "Embed a note",
    sl_sec_basic: "Basic blocks",
    sl_sec_media: "Media",
    sl_sec_records: "Records",
    sl_sec_advanced: "Advanced",
    sl_sec_templates: "Templates",
    sl_sec_plugins: "Plugins",
    pl_renderer_missing: "This version has no {renderer} renderer, so the block shows as code.",
    sl_no_results: "No results",
    sl_text: "Text",
    bm_search: "Search actions…",
    bm_turn_into: "Turn into",
    bm_actions: "Actions",
    bm_duplicate: "Duplicate",
    bm_delete: "Delete",
    bm_move_up: "Move up",
    bm_move_down: "Move down",
    bm_ask: "Ask about this block",
    bm_handle: "Block menu",
    bm_indent: "Indent",
    bm_outdent: "Outdent",
    tb_label: "Editing tools",
    tb_undo: "Undo",
    tb_wikilink: "Link a note",
    tb_tag: "Tag",
    tb_todo: "To-do",
    tb_heading: "Heading",
    tb_add: "Add a block",
    tb_hide: "Hide keyboard",
    tb_bold: "Bold",
    tb_italic: "Italic",
    tb_highlight: "Highlight",
    tb_code: "Code",
    tb_link: "Make a link",
    tbl_col_ph: "Column {n}",
    tbl_add_row: "Add a row",
    tbl_add_col: "Add a column",
    tbl_row_menu: "Row menu",
    tbl_col_menu: "Column menu",
    tbl_menu: "Table menu",
    tbl_row_above: "Add row above",
    tbl_row_below: "Add row below",
    tbl_col_left: "Add column left",
    tbl_col_right: "Add column right",
    tbl_row_delete: "Delete row",
    tbl_col_delete: "Delete column",
    tbl_align: "Align",
    tbl_align_left: "Left",
    tbl_align_center: "Center",
    tbl_align_right: "Right",
    fb_edit: "Edit",
    fb_delete: "Delete",
    fb_done: "Done",
    fb_panel: "Edit {name}",
    fb_text: "Content",
    mm_f_code: "Diagram code",
    mt_f_tex: "Formula (TeX)",
    ch_f_type: "Type",
    ch_f_bar: "Bar",
    ch_f_line: "Line",
    ch_f_pie: "Pie",
    ch_f_title: "Title",
    ch_f_data: "Data",
    ch_f_from_table: "A table in this note",
    ch_f_inline: "Inline data",
    ch_f_table: "Table",
    ch_f_pick: "Choose a table",
    ch_f_new_table: "New table",
    ch_f_missing: "A table not in this note",
    ch_f_table_n: "Table {n}",
    ch_f_layout: "Layout",
    ch_f_columns: "Columns",
    ch_f_rows: "Rows",
    ch_f_labels: "Labels",
    ch_f_series: "Series {n}",
    ch_f_values: "Values",
    ch_f_add_series: "Add series",
    ch_f_remove_series: "Remove series {n}",
    qb_f_path: "Folder",
    qb_f_tag: "Tag",
    qb_f_type: "Type",
    qb_f_sort: "Sort",
    qb_f_limit: "Max results",
    qb_f_advanced: "Advanced",
    qb_f_line: "Query",
    qb_sort_default: "Default (name)",
    qb_sort_name: "Name A→Z",
    qb_sort_name_desc: "Name Z→A",
    qb_sort_modified: "Recently modified",
    qb_sort_modified_asc: "Least recently modified",
    qb_sort_links: "Most links",
    qb_sort_sources: "Most sources",
    qb_sort_type: "By type",
    ins_link: "Insert link at cursor",
    ins_quote: "Insert quote at cursor",
    sl_in_notes: "In notes",
    sl_onthisday: "On this day",
    sl_toc: "Table of contents",
    sl_chart: "Chart",
    ch_sample_title: "Sample chart",
    sl_mermaid: "Diagram",
    mm_sample:
      "flowchart LR\n  A[Idea] --> B{Worth keeping?}\n  B -->|Yes| C[Write a note]\n  B -->|No| D[Let it go]",
    sl_math: "Math block",
    otd_title: "{date} in past years",
    otd_all: "Insert all {n} as links",
    otd_none: "No daily notes from {date} in past years.",
    otd_keys: "↵ insert · esc close",
    sl_query: "Query",
    sl_onthisday_query: "On this day (query)",
    sl_hint_recall: "Find a past note and put its text here, once",
    sl_hint_query: "A list of notes matching what you set, kept up to date",
    sl_hint_onthisday: "Pick a note from this date in past years and put it here, once",
    sl_hint_onthisday_query: "A list of notes from this date in past years, kept up to date",
    qb_hint: 'Write a query: "phrase", tag:, type:, status:, confidence:, path:, sort:, limit:, view:',
    qb_loading: "Running the query…",
    qb_empty: "No pages match this query.",
    qb_failed: "The query could not run: {error}",
    qb_bad: "Unknown option: {token}",
    qb_bake: "Bake links",
    qb_bake_title: "Write these pages into the note as a list of links (replaces the last bake)",
    qb_col_name: "Name",
    qb_col_type: "Type",
    qb_col_status: "Status",
    qb_col_updated: "Updated",
    qb_untyped: "No type",
    sl_recall: "Recall a record",
    rc_title: "Recall from your notes",
    rc_search: "Search past records… e.g. “decision last week”",
    rc_hint: "Type what you remember — the quote comes back verbatim, with its source.",
    rc_none: "No record is close enough to this.",
    rc_stale: "The search index is out of date — reindex it in Model settings.",
    rc_failed: "The search index could not be reached.",
    rc_no_index: "No search index yet — set up semantic search in Settings.",
    rc_range: "Dated {start} – {end}",
    rc_embed: "Embed instead (![[…]])",
    rc_keys: "↵ quote · ⌘↵ embed · tab scope · esc close",
    sl_ask: "Ask the vault",
    rc_ask: "Ask a question…",
    rc_ask_title: "Ask your notes",
    rc_ask_hint:
      "Type a question and press Enter — the answer is your notes' own lines with their sources, inserted as a callout.",
    rc_ask_keys: "↵ ask / insert · ↑↓ scroll · tab scope · esc close",
    rc_ask_ready: "Enter inserts it",
    editor_insert_wait:
      "This note is still being prepared. Nothing was inserted; try again in a moment.",
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
      "Cards made from sentences in the notes you read, shown again just as you start to forget them.",
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
    st_load_failed: "Could not load study cards.",
    ing_auto_failed: "Could not process pending sources.",
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
    st_quiz_none: "Not enough fill-in-the-blank cards for a quiz: each question needs a blanked term and two other terms to choose from. Make cards from a note with bold or linked terms.",
    st_ungrounded: "Ungrounded: {n}",
    st_ungrounded_hint: "These cards name no source note, or their answer is not in it.",
    st_archive: "Archive",
    st_archive_hint: "Moves the deck to cards/archive/. Move it back to restore it.",
    st_archived: "Moved {name} to cards/archive/",
    st_archive_failed: "Could not archive the deck",
    st_gen_quiz: "Generate quiz",
    st_generating: "Generating…",
    st_quiz_done: "Quiz complete",
    st_quiz_score: "Score: {score} / {total}",
    st_correct: "Correct",
    st_wrong: "Not quite",
    st_next: "Next",
    st_def_front: "What is {title}?",
    st_section_front: "{title} › {heading}",
    st_today_title: "Today's review",
    st_grade_forgot: "Forgot",
    st_grade_remembered: "Remembered",
    st_next_review: "Next review {when}: {n} due",
    st_keys_hint: "Space shows the answer; 1–{n} grades it.",
    st_save_failed: "Could not save this review",
    st_deck_save_failed: "Could not save the study cards",
    st_deck_read_failed: "Could not read this deck. Reopen it or try again.",
    st_deck_changed: "The deck or vault changed. Reopen the deck before saving.",
    st_deck_partial: "The file may already be saved, but its result could not be confirmed. Check the deck before trying again.",
    s_study_lede: "How Make cards and the quiz turn your notes into study material.",
    s_ai_cards_title: "Make cards with AI (experimental)",
    s_ai_cards_desc: "Off: every card and quiz question quotes your note word for word, with no model. On: a connected chat model drafts more, and any whose answer is not found verbatim in the note is dropped.",
    s_ai_cards_needs: "Needs a connected chat model (Settings → Model). Until then cards stay extractive.",
    s_fine_grades_title: "Grade in detail",
    s_fine_grades_desc: "On: grade each review card Again, Hard, Good or Easy. Off: two buttons, Forgot and Remembered.",
    s_plugins: "Plugins",
    s_plugins_lede: "Plugins from this vault's .myco/plugins/ folder. A plugin adds / menu items and uses code-block renderers built into myco. One with a main.js also runs its own code, in a sandbox, and only once you allow the calls it lists: it cannot write files or read raw/, and the app's security policy (CSP) leaves it no network except the app's own files and an Ollama server on this computer (localhost:11434).",
    pl_trust_title: "Vault trust",
    pl_trust_desc: "Until you trust this vault, every plugin in it stays off. This applies on this device only, and you can take it back at any time.",
    pl_trust_btn: "Trust this vault's plugins",
    pl_trusted: "This vault's plugins are trusted on this device.",
    pl_untrust_btn: "Stop trusting",
    pl_installed: "Installed plugins",
    pl_reload: "Read again",
    pl_loading: "Reading plugins…",
    pl_empty: "No plugins in .myco/plugins/ yet. A plugin is a folder there holding one manifest.json.",
    pl_no_vault: "Open a vault to see its plugins.",
    pl_load_failed: "Plugins could not be read: {error}",
    pl_enable: "Use {name}",
    pl_off_until_trusted: "Off until you trust this vault",
    pl_slash_items: "/ items",
    pl_fences: "Code blocks",
    pl_renderer_absent: "not in this version",
    pl_fence_builtin: "ignored: myco has its own",
    pl_fence_taken: "ignored: {id} uses it",
    pl_invalid: "Not loaded",
    pl_load_one_failed: "This plugin couldn't be loaded.",
    pl_details: "Details",
    pl_err_missing: "This folder has no manifest.json.",
    pl_err_outside: "This plugin links outside .myco/plugins/, so it was not read.",
    pl_err_too_large: "manifest.json is larger than 64 KB.",
    pl_err_unreadable: "manifest.json could not be read as text.",
    pl_err_json: "manifest.json is not a JSON object.",
    pl_err_field: "{field} is missing or not valid.",
    pl_err_id: "id \"{value}\" must be the folder's name, in lower-case letters, digits, . _ or -.",
    pl_err_renderer: "{field}: \"{value}\" is not a renderer. Use one of {renderers}.",
    pl_err_slash: "{field} needs exactly one of template, fence or command.",
    pl_err_permission: "{field}: \"{value}\" is not a call myco allows. Use one of {calls}.",
    pl_code: "Runs its own code (main.js) in a sandbox",
    pl_calls: "Calls",
    pl_calls_none: "none",
    pl_ask_title: "Let {name} run its code?",
    pl_ask_desc: "Its main.js runs in a sandbox, apart from your files: it cannot write anything and reads only pages under wiki/. While one of its / commands runs, it can:",
    pl_ask_nothing: "Nothing else: it asks for no calls.",
    pl_allow: "Allow and turn on",
    pl_revoke_hint: "Turning it off takes these calls back; turning it on asks again.",
    pl_sc_insert: "insert text at the caret",
    pl_sc_replace: "replace the selected text",
    pl_sc_selection: "read the selected text and the caret's line",
    pl_sc_read: "read pages under wiki/",
    pl_sc_recall: "search your notes by meaning",
    pl_sc_search: "search your notes' text",
    pl_sc_notify: "show a notice",
    pl_run_timeout: "{name} ran longer than {seconds} seconds and was stopped.",
    pl_run_failed: "{name} could not finish the command",
    pl_run_stopped: "{name} failed {count} times in a row and is stopped. Turn it off and on in Settings → Plugins to try again.",
    pl_run_busy: "{name} is still running the last command.",
    pl_run_calls: "{name} made more than {count} calls in one command and was stopped.",
    pl_run_no_main: "{name}'s main.js could not be read",
    rd_cards_ai_failed: "AI cards could not be made",
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
      "The selected Agent route has no verified tool runner ({provider}). Check Model settings; external models are optional.",
    ag_open_providers: "Open Model settings",
    rd_audio: "Audio overview",
    au_title: "Audio overview",
    au_close: "Close",
    au_generating: "Writing the dialogue…",
    au_needs_provider:
      "Choose a supported Audio model in Settings → Model. Local models are the default; external models are optional.",
    au_source_failed: "Could not admit the selected saved notes. Check the notes and Audio model settings, then retry.",
    au_generation_failed: "The selected Audio model did not produce a valid dialogue. Check Model settings and retry.",
    au_publication_failed: "Could not confirm transcript publication. Check the selected notes and existing audio files before retrying.",
    au_publication_partial: "Publication is incomplete. The draft and file at {path} are retained; inspect the file before retrying.",
    au_cancel_failed: "Could not confirm Audio cancellation. Check the current job before retrying.",
    au_stop_generation: "Stop generating",
    au_stopped: "Audio cancellation requested.",
    bf_title: "Bring in past sessions",
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
    s_distill: "Automatic organization",
    set_distill_loading: "Loading…",
    set_distill_lede:
      "Periodically scores how well new notes fit your vault, quarantines sessions no person wrote, writes digests of your sessions, and archives sessions once they are digested. It never changes the originals in raw/.",
    set_distill_enabled_title: "Automatic distillation",
    set_distill_enabled_desc:
      "While myco is open, it tidies up on its own once you have not touched it for the idle minutes below and the backlog has reached the count trigger. It runs at most once an hour. No run, automatic or manual, changes the raw/ folder.",
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
      "Trashed {tr}, {p} proposals — backlog now {b}",
    set_distill_busy:
      "A distill run or an inbox auto-ingest pass is already in progress.",
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
    set_archive_failed: "Incomplete buckets; available copies retained: {list}",
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
    nav_feedback: "Review suggestions",
    ov_distill_last_run: "Last run {t}",
    ov_distill_never: "No runs yet",
    ov_distill_llm_queued:
      "Organization steps are waiting. Check the selected model and retry.",
    ov_distill_done:
      "Distill finished — {d} days digested · {w} weeks rolled up · {p} proposals",
    ov_distill_done_months: " · {m} monthly rollups",
    ov_distill_done_none: "Distill finished — nothing to process",
    pf_title: "Harvest box",
    pf_lede:
      "Suggestions from automatic organization: take in new notes that have gathered into a topic, delete sources you no longer need, or draft a topic map. Review each one, then approve or dismiss it.",
    pf_empty: "No pending proposals.",
    pf_kind_admit: "Admit cluster",
    pf_kind_archive: "Archive batch",
    pf_kind_delete: "Delete batch",
    pf_kind_draft_map: "Draft topic map",
    pf_created: "Created",
    pf_expand: "Show details",
    pf_collapse: "Hide details",
    pf_approve: "Approve",
    pf_dismiss: "Dismiss",
    pf_confirm_title: "Apply this proposal?",
    pf_outcome_admit: "Restores {n} quarantined item(s) to the vault.",
    pf_retired: "No longer needed — the originals stay as they are",
    pf_outcome_delete: "Moves {n} quarantined item(s) to the trash.",
    pf_confirm_msg_draft_map: "Drafts a topic map (one model call).",
    pf_retry: "Retry",
    pf_apply_failed: "Apply failed — retry",
    pf_map_needs_writer: "Writing a topic map needs a model that can write",
    pf_tab_proposals: "Proposals",
    pf_tab_quarantine: "Quarantine {n}",
    qz_empty: "Nothing in quarantine.",
    qz_lede:
      "Items automatic organization set aside: sessions no person wrote, and items it judged off-topic. They are held, not deleted — restore what belongs, trash what doesn't.",
    qz_verdict_offtopic: "Off-topic: {numbers}",
    qz_verdict_sim: "similarity {sim}",
    qz_verdict_sim_vs: "similarity {sim} vs threshold {min}",
    qz_verdict_nearest: "(nearest topic: {topic})",
    qz_verdict_unknown: "No verdict recorded for this item.",
    qz_expires_in: "{n} days left",
    qz_expires_due: "Expired — the next run may move it to trash",
    qz_expires_due_ask: "Expired — the next run asks you under Proposals before deleting it",
    qz_expires_unknown: "No expiry recorded",
    qz_restore: "Restore to vault",
    qz_delete: "Delete",
    qz_keep: "Keep {n} more days",
    qz_confirm_delete_title: "Delete this item?",
    qz_confirm_delete_msg:
      "{name} goes to the system trash (recoverable from there).",
    qz_group_myco: "Records of myco calling a model",
    qz_group_agent: "Agent task prompts",
    qz_group_hello: "Connection tests",
    qz_group_empty: "Empty sessions",
    qz_group_other: "Other items",
    qz_restore_all: "Restore all",
    qz_trash_all: "Trash all",
    qz_confirm_restore_all_title: "Restore all {n}?",
    qz_confirm_restore_all_msg:
      "Everything in “{group}” goes back where it came from and won't be set aside again.",
    qz_confirm_trash_all_title: "Trash all {n}?",
    qz_confirm_trash_all_msg:
      "Everything in “{group}” goes to the system trash (recoverable from there).",
    tb_activity_quarantine: "{n} awaiting review",
    tb_activity_gone: "That is no longer there — it was already handled.",
    ing_title_label: "Title",
    ing_title_ph: "e.g. An article I read today",
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
      "Process each copy's evidence in bounded batches and connect it to the wiki",
    hq_plan_cites: "Citations {base} → {goal} (estimated, +{n})",
    hq_plan_note:
      "The pass archives each copy it consumes; sessions/ is never written to.",
    hq_plan_cancel: "Cancel",
    hq_plan_run: "Run",
    hq_plan_running: "Running — {done} of {total} done",
    hq_done_title: "{n} harvested",
    hq_done_sub: "citations {base} → {goal}",
    hq_done_partial:
      "{copied} sources ready · {ingested} completed — the rest wait in _inbox/",
    hq_failed: "Harvest failed",
    hq_empty_title: "Nothing left to promote",
    hq_empty_body:
      "{distinct} distinct bodies and none eligible right now. Held sessions (over 200 KB) and new conversations past 8 KB come back to this queue.",
    hq_empty_cta: "Bring in a source",
    hq_loading: "Scanning sessions/…",
    hq_error: "Could not read the session archive",
    hq_retry: "Retry",
    hq_read_partial: "Some sessions could not be checked. Counts are lower bounds; retry to check the remaining files.",
    hq_read_lower_bound: "at least {n}",
    hq_mini_line: "{left} candidates left · {done} harvested so far",
    hq_mini_fold: "Collapse the harvest queue",
    ing_refused_title: "Nothing to keep — not saved · {reason}",
    ing_logged_title: "Kept the original only · {reason}",
    ing_noop_reason: "every item in the plan is already in the wiki",
    ing_raw_reused: "The same text is already saved at {path}, so no new copy was made.",
    ing_raw_name_shared:
      "the same text is already at {path}, but another original has that name too, so a summary would overwrite the other one's",
    ing_dec_update: "Edit",
    ing_dec_add: "New",
    ing_dec_merge: "Merge",
    ing_dec_noop: "Already there",
    ing_gate_none_reason: "nothing was picked from the plan",
    sv_rail_label: "Pipeline",
    sv_state_reading: "Reading",
    sv_state_choosing: "Your turn to choose",
    sv_state_done: "Done",
    sv_details: "Details",
    sv_step_intake: "Intake",
    sv_step_judge: "Judgement",
    sv_step_gate: "Plan",
    sv_step_run: "Run",
    sv_step_backfill: "Waiting",
    sv_today_n: "{n} today",
    sv_tally: "drop {d} · log {l} · harvest {h}",
    sv_waiting: "waiting",
    sv_reviewing: "reviewing",
    sv_idle: "idle",
    sv_running: "running",
    sv_done: "done",
    sv_failed: "failed",
    sv_cancelled: "cancelled",
    sv_nothing_added: "no notes added",
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
    sv_harvest_sub: "to the plan review",
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
    sv_bf_eyebrow: "5 · Waiting — the largest unopened input",
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
      "E5 searches locally. With the optional Qwen model installed and selected, Ask summarizes retrieved passages on this Mac; otherwise it quotes the originals.",
    q_builtin_extractive_note:
      "Answers quote matching passages. For local summaries, install and select Qwen under Model settings.",
    q_open_model_settings: "Model settings",
    q_stale_index:
      "This answer used the whole vault instead of the search index, which is out of date after a model update.",
    q_retrieval_failed:
      "The search index could not be reached, so this answer skipped semantic search and read the vault directly instead. If it keeps happening, run “Reindex now” under Model settings.",
    q_extractive_label: "From your notes (top matches, verbatim)",
    q_extractive_empty:
      "Nothing relevant found in the wiki index. Try rephrasing, or run “Reindex now” under Model settings.",
    q_extractive_stale:
      "The semantic index predates a model update, and keyword search found no verified passages. Run “Reindex now” under Model settings, then ask again.",
    q_extractive_failed:
      "The search index could not be reached, so no passages could be retrieved. If it keeps happening, run “Reindex now” under Model settings.",
    q_source_changed:
      "The source passages changed or could not be verified. Retry to search the current notes.",
    q_model_selection_changed: "The selected model or its permission changed, so this answer was stopped. Check the model selection and retry.",
    q_activity_failed: "The local model could not select a period or finish the activity summary. Check that the selected chat model is ready, then retry.",
    q_activity_incomplete: "Some records could not be checked for the selected period. Retry with the same scope and period.",
    q_activity_summary_failed: "Records were found for the selected period, but the activity summary could not be completed. Retry with the same period.",
    q_answer_review_failed: "The answer could not pass review against the original records. Retry or narrow the question.",
    q_activity_insufficient_evidence: "Records were found, but they did not provide enough supported activity for this question. Check the scope and period, or retry.",
    q_activity_coverage: "Scanned {scanned} pages · {sources} citation pages",
    q_activity_limited: "This summary covers selected records, so some activities may be missing.",
    q_local_fallback_timeout:
      "The local answer was not ready in time. The retrieved source passages are quoted below.",
    q_local_fallback_unavailable:
      "The selected local model could not be used to write an answer. The retrieved source passages are quoted below.",
    q_local_fallback_prompt:
      "The retrieved passages could not be prepared for a local answer. The retrieved source passages are quoted below.",
    q_local_fallback_rejected:
      "The local answer did not pass validation. The retrieved source passages are quoted below.",
    q_local_fallback_incomplete:
      "The local answer could not be completed. The retrieved source passages are quoted below.",
    q_local_fallback_failed:
      "A local answer could not be written. The retrieved source passages are quoted below.",
    q_range_chip: "Period: {s} – {e}",
    q_range_empty: "I couldn't find this in your notes from that period",
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
    q_miss_done: "Logged",
    q_miss_failed: "Couldn't log this question",
    q_quote_to_note: "Quote in note",
    q_copy_answer: "Copy answer",
    q_copied: "Copied",
    q_copy_failed: "Couldn't copy to the clipboard",
    q_quote_pick_note: "Pick the note to quote into",
    q_back_to_ask: "Back to the question",
    q_followup_chip: "Continues the previous question",
    // Ask renewal (mockup "Strata").
    q_scope_label: "Search scope",
    q_scope_wiki: "My notes",
    q_scope_sessions: "Conversations",
    q_scope_all: "All evidence",
    q_scope_wiki_hint: "Searches your tidied notes, maps and daily summaries",
    q_scope_sessions_hint: "Searches the chats you had with AI tools",
    q_scope_all_hint: "Searches your notes and your conversations together",
    q_scope_chip: "Scope · {scope}",
    q_note_scope_chip: "This note · {note}",
    q_note_scope_hint: "Searches only this note and the notes it links to or from",
    q_note_scope_clear: "Stop asking only this note",
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
    q_more_passages: "More passages ({n})",
    q_fewer_passages: "Fewer passages",
    q_jump_to_question: "Ask a follow-up",
    q_ladder_count: "{n} sources · {c} quoted",
    q_ladder_all: "See all {n} sources",
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
    q_abstain_title: "I couldn't find this in your notes",
    q_abstain_sub: "Some notes were similar, but none came close enough to answer",
    q_abstain_sub_none: "None of your notes is about anything like this yet",
    q_abstain_details: "Details",
    q_abstain_numbers:
      "No passage in {n} indexed pages reaches the relevance floor {floor}. myco stopped here rather than invent a plausible sentence.",
    q_abstain_range_numbers:
      "Nothing recorded between {s} and {e} reaches the relevance floor {floor}. myco stopped here rather than invent a plausible sentence.",
    q_abstain_note: "Write this question in today's note",
    q_abstain_noted: "Written in today's note",
    q_abstain_note_line: "Question: {q}",
    q_abstain_near: "Closest misses — none close enough to answer",
    q_abstain_none: "Neither the keyword arm nor the vector arm brought anything back.",
    q_abstain_lexical: "keywords only",
    q_abstain_gauge_note:
      "The red tick is the floor {floor}. “Keywords only” is a lexical hit with no cosine — on its own it is not evidence.",
    q_abstain_floor_tick: "floor {floor}",
    q_abstain_harvest: "Mark as a question to fill later",
    q_abstain_harvested: "Marked to fill later",
    q_abstain_widen: "Search wider",
    q_abstain_range_sub: "Nothing written between {s} and {e} came close enough to answer",
    q_abstain_widen_range: "Search again without the period",
    q_abstain_receipt: "Added to the list of questions to fill later",
    q_history: "History",
    q_history_search: "Search past questions",
    q_history_none: "No past question matches.",
    q_history_cited: "Notes: {n}",
    q_history_abstained: "Not in notes",
    q_history_failed: "Failed",
    q_history_load_failed: "Couldn't read the question history.",
    q_retry: "Retry",
    q_stop: "Stop answering",
    q_elapsed: "Elapsed {time}",
    q_stopped: "Stopped",
    q_stopped_sub: "You stopped this answer before it came back.",
    s_archived_sessions_title: "Search archived sessions too",
    s_archived_sessions_desc:
      "The session scope also searches sessions/archive/ — the cold tier the index normally leaves out. Turning it on re-indexes.",
    sb_new_note: "New note",
    sb_new_folder: "New folder",
    sb_rename: "Rename…",
    sb_today_note: "Today's note",
    sb_new_note_msg: "What would you like to call this note?",
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
    sb_row_menu: "{name} menu",
    sb_edited: "Edited {date}",
    sb_n_items: "{n} items",
    delete_policy_wait: "Wait for deletion settings to finish loading or saving, then try again.",
    set_delete_title: "Deletion method",
    set_delete_desc: "Choose what happens when myco deletes an item, manually or during automatic cleanup. Raw originals and items requiring approval keep their existing protections.",
    set_delete_trash: "Move to Trash",
    set_delete_permanent: "Delete permanently",
    set_delete_enable_msg: "Future deletions will bypass Trash. Automatic cleanup also removes old copies proven to belong to myco. Deleted items cannot be restored from Trash or by undoing a run. Enable this?",
    delete_permanent_msg: "{n} item(s) will be permanently deleted. They cannot be restored from Trash.",
    delete_permanent_one_msg: "“{name}” will be permanently deleted. It cannot be restored from Trash.",
    qz_expires_due_permanent: "Expired — the next run may permanently delete this item",
    deleted_count: "{n} permanently deleted",
    delete_undo_limit: "Permanently deleted files cannot be restored by undoing this run.",
    sb_delete_msg: "{n} item(s) will move to the Trash.",
    sb_delete_one_msg: "“{name}” will move to the Trash.",
    sb_selected: "{n} selected",
    sb_clear_selection: "Clear selection",
    sb_new_folder_msg: "Folder name",
    sb_rename_msg: "Rename “{name}” to:",
    sb_empty_vault: "Empty vault",
    sb_no_vault: "No vault selected",
    sb_managed: "Managed by myco",
    sb_tree: "Notes and folders",
    sb_managed_hint: "To tell apart the notes myco wrote, turn on Vault history in Settings.",
    sb_agent_mark: "by myco",
    area_raw: "Original source",
    area_sessions: "Session log",
    area_cards: "Study cards",
    area_ingest_reports: "Ingest report",
    area_work: "Organizing candidate",
    area_inbox: "Waiting to be added",
    area_templates: "Template",
    area_audio: "Voice recording",
    area_claude: "Agent instructions",
    cb_no_results: "No results",
    cb_create_q: "Create “{q}”",
    cb_ask_q: "Ask the wiki: {q}",
    cb_group_actions: "Actions",
    cb_group_recent: "Recent",
    cb_group_today: "Today",
    tabbar_label: "Main",
    cb_group_week: "Previous 7 days",
    cb_group_goto: "Go to",
    cb_group_lenses: "Lenses",
    cb_tag_page: "page",
    cb_tag_file: "file",
    cb_tag_note: "note",
    cb_tag_action: "action",
    cb_in_contents: "In page contents",
    cb_semantic: "Related (semantic)",
    cb_exact: "Exact match",
    cb_operator_hint: "Quotes for exact match · path: · tag: · type: · status: · confidence:",
    cb_miss_hint: "Didn't find it? ⌥⏎ logs this search to the eval set.",
    cb_miss_done: "Logged to the eval set.",
    cb_placeholder: "Find a note or jump",
    cb_key_open: "open",
    cb_key_miss: "log a missed search",
    cb_results_n: "{n} results",
    cb_chips_label: "Narrow by",
    cb_chip_tag: "Tag",
    cb_chip_folder: "Folder",
    cb_chip_type: "Type",
    sb_tags: "Tags",
    sb_tag_chip: "{tag}, {n} notes",
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
    sb_st_lagging: "Ask can’t find {n} of your notes",
    sb_st_reindex: "Index again",
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
    tb_harvest_running: "Harvesting…",
    tb_harvest_copying: "Copying sources…",
    tb_harvest_done: "Harvest done",
    tb_harvest_error: "Harvest failed",
    tb_distill_done: "Distill done",
    tb_distill_error: "Distill failed",
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
    tb_inflow_header: "Today's inflow",
    tb_inflow_sessions: "Sessions swept",
    tb_inflow_last_sweep: "last sweep {t}",
    tb_inflow_sweep_incomplete: "latest sweep incomplete — review imports",
    tb_inflow_sweep_failed: "latest sweep failed — retry imports",
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
    spot_details: "Details",
    spot_sim: "{stem} · {pct} similar to your question",
    spot_open_ask: "The details are on myco's Ask page.",
    spot_open_ask_btn: "Open in Ask",
    spot_no_vault: "Open a vault in myco first — there is nothing to ask yet.",
    spot_busy: "myco is still answering the previous question.",
    voice_btn_label: "Voice capture",
    voice_hint_recording: "⏎ save · esc cancel",
    capture_inbox_receipt: "{rel} — joins the next ingest",
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
    gr_zoom_out: "Zoom out",
    gr_fit: "Fit",
    gr_zoom_in: "Zoom in",
    h_open_vault: "Open a vault to see history.",
    rf_title: "Reflect suggestions",
    rf_lede:
      "Reads your notes without changing them and points out notes nothing links to, old notes and links to notes that don't exist.",
    rf_run: "Run Reflect",
    rf_running: "Running…",
    rf_running_label: "Reflect running…",
    rf_done: "Done · {time} · {n} found",
    rf_failed: "Reflect couldn't run.",
    rf_empty: "All tidied up.",
    rf_extractive:
      "Found by the built-in model, which looks only at how notes link, not at what they say.",
    rf_item_orphan: "{page} — no note links to it",
    rf_item_unresolved: "{page} — links to '{target}', which doesn't exist yet",
    rf_create_missing: "Create missing notes",
    rf_create_progress: "{done}/{total}",
    rf_create_result: "Notes created: {n}",
    rf_create_failed: "Stopped at '{target}' — could not create it.",
    rf_create_one: "Create this note",
    rf_open_page: "Open note",
    rf_ignore_one: "Stop reporting this",
    ob_title: "Welcome to myco",
    ob_skip: "Skip",
    ob_back: "Back",
    ob_next: "Next",
    ob_finish: "Done",
    ob_step: "{n}/{total}",
    ob_vault_linked: "Linked",
    ob_vault_none: "No vault linked yet",
    ob_s1_title: "Choose a folder for your notes",
    ob_s1_body:
      "Your notes are plain markdown files in a folder on this device (your vault), and they stay there even if you delete myco.",
    ob_s1_action: "Choose a folder…",
    ob_demo_start: "Start with a demo vault",
    ob_note_title: "Write your first note",
    ob_note_body:
      "Jot down a thought, or bring in a file's text. The first line becomes the title.",
    ob_note_name: "First note",
    ob_note_ph: "e.g. What I learned this week",
    ob_note_file: "Import from a file…",
    ob_note_loaded: "Added the text of {name}. Edit it before saving if you like.",
    ob_note_skip_hint: "Nothing to write yet? Just press Next.",
    ob_note_exists: "A note with that name already exists. Try a different first line.",
    ob_note_failed: "Couldn't save the note: {error}",
    ob_note_load_failed: "Couldn't read that file: {error}",
    ob_seed_do: "Add demo notes",
    ob_s3_title: "Ask your notes a question",
    ob_s3_body:
      "The answer comes from your own notes, with where each part came from.",
    ob_ask_label: "Question",
    ob_first_question: "What topics do these notes cover most?",
    ob_first_question_note: "What did I write about {title}?",
    ob_ask_now: "Ask it",
    ob_index_title: "Reading your notes…",
    ob_index_progress: "{done} of {total} notes",
    ob_index_failed: "Indexing didn't finish",
    ob_guide_title: "More you can set up",
    ob_imp_title: "Bring in your sessions",
    ob_imp_body:
      "myco can import your Claude Code and Codex sessions. They index on this device only — searching and asking about them is free.",
    ob_imp_claude: "Import Claude Code sessions",
    ob_imp_codex: "Import Codex sessions",
    ob_imp_progress: "{done} of {total} files",
    ob_imp_done: "{n} sessions imported",
    ob_imp_quarantined: "{n} held back (possible secrets)",
    ob_hist_title: "Keep a vault history",
    ob_hist_body: "Turn it on to see agent changes word by word and undo them.",
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
      "Bundled Korean E5 and BM25 search offline. Optional Qwen3.5 4B answers questions; 2B adds reviewable import previews. Source quotes are preserved. Local organization uses the selected local import model when available.",
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
    hn_label: "Notices",
    hn_label_n: "Notices: {n} to look at",
    hn_empty: "Nothing needs you right now.",
    hn_loading: "Checking your notes…",
    hn_error: "Notices could not be checked.",
    hn_changes: "Changed while you were away",
    hn_check: "Notes to check",
    hn_contra: "Notes that disagree",
    hn_see_all: "See all",
    hn_contra_open: "Review them",
    chk_no_frontmatter: "The note has no info block (frontmatter)",
    chk_no_type: "The note doesn't say what kind it is (type)",
    chk_bad_type: "The note's kind (type) isn't one myco knows",
    chk_superseded: "Marked as replaced, but not by which note",
    chk_disputed: "Marked as disputed, but doesn't say what differs",
    chk_citation: "A citation points to a source the note doesn't list",
    chk_footnote: "A listed source is never cited in the text",
    chk_source_count: "The source count doesn't match the citations",
    chk_source_count_nan: "The source count isn't a number",
    chk_confidence: "The stated confidence doesn't fit its sources",
    chk_other: "Something in this note is worth a look",
    ov_view_runs: "View runs",
    ovl_edit: "Arrange blocks",
    ovl_done: "Done arranging",
    ovl_reset: "Default layout",
    ovl_reset_done: "Back to the default layout.",
    ovl_hint:
      "Drag a handle, or focus one and use the arrow keys. Pick a width for each block.",
    ovl_span: "Width",
    ovl_span_full: "Full",
    ovl_move: "Move {block} — arrow keys change its position",
    ovl_moved: "{block}: {index} of {total}",
    ovl_vacant: "Nothing to show right now.",
    ovl_b_pulse: "Vault pulse",
    ovl_b_harvest: "Harvest queue",
    contra_title: "Contradictions",
    contra_disputed: "Two notes say different things here",
    contra_stale: "Cites {t}, which is out of date",
    contra_mark_active: "Mark as settled",
    contra_mark_superseded: "Mark as out of date",
    contra_open_page: "Open this note",
    contra_open_target: "Open the cited note",
    contra_ignore: "Ignore",
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
    ritual_keep: "Keep",
    ritual_later: "Later",
    home_ask_ph: "Ask your notes, or jot something down…",
    home_ask_keys: "Enter to ask · ⌘Enter to add to today's note",
    home_ask_send: "Ask",
    home_capture_send: "Add to today's note",
    home_captured: "Added to today's note",
    home_capture_failed: "Could not add to today's note",
    home_open_daily: "Open",
    home_greet_morning: "Good morning",
    home_greet_afternoon: "Good afternoon",
    home_greet_evening: "Good evening",
    rd_day_prev: "Yesterday",
    rd_day_next: "Tomorrow",
    history_runs_title: "Runs",
    history_run_open_why: "WHY report",
    history_run_kind_digest: "Session digest",
    history_run_kind_llm: "Model pass",
    history_run_kind_distill: "Auto-organize",
    history_undo_q: "Undo this run?",
    history_undo_msg:
      "Archived or trashed notes return only if their recoverable copies still exist; permanently deleted files cannot be restored. Pages created by the run are deleted. Files changed since the run are skipped.",
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
    rd_auth_section: "Authorship",
    auth_filter_pill: "Human only (on record)",
    auth_filter_hint: "Hide the notes myco has edited, going by their history",
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
    notch_failed: "Did not finish",
    notch_capture: "Quick note",
    notch_capture_save: "⏎ today's note",
    notch_capture_voice: "⌥M voice",
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
    notch_waiting: "{n} waiting for you",
    notch_agenda_harvest_title: "Harvest queue",
    notch_agenda_links_title: "{n} suggested links",
    notch_agenda_links_all: "Link all",
    notch_agenda_harvest_sub: "{n} sessions worth a page",
    notch_agenda_harvest: "Harvest {n}",
    notch_agenda_dropped: "Dropped",
    s_notch_title: "Notch drop surface",
    s_notch_desc:
      "Show a drop target under the menu-bar notch — files dropped there land in _inbox for ingest to read.",
    tidy_btn: "Tidy",
    tidy_btn_title: "Propose readable names and working links for session pages",
    tidy_cmd: "Tidy the vault",
    tidy_title: "Tidy the vault",
    tidy_lede: "Readable names for session pages, and links that lead somewhere. Nothing is written until you apply, and it can be undone.",
    tidy_loading: "Looking through the vault…",
    tidy_empty: "Nothing to tidy",
    tidy_error: "Could not read the vault",
    tidy_retry: "Try again",
    tidy_g_titles: "Give readable titles",
    tidy_g_titles_desc: "From each session's first prompt, its agent and its date.",
    tidy_g_links: "Fix broken links",
    tidy_g_links_desc: "A Related link to a session points at its summary; one with no summary is removed.",
    tidy_g_move: "Gather session summaries",
    tidy_g_move_desc: "Moves them into wiki/sessions/<month>/. Links keep working.",
    tidy_removed: "removed",
    tidy_show_all: "Show all {n}",
    tidy_show_less: "Show fewer",
    tidy_skipped: "{n} skipped — no transcript found",
    tidy_apply: "Apply to {n} files",
    tidy_applying: "Applying…",
    tidy_done: "Tidied {n} files",
    tidy_failed: "{n} could not be written:",
    tidy_undo: "Undo",
    tidy_undoing: "Undoing…",
    tidy_undone: "Restored {n} files",
    tidy_undo_skipped: "Left as they are — changed since the run:",
    tidy_changed: "Left as they are — changed after the scan:",
    tidy_rescan: "Scan again",
    tidy_s_desc: "Readable names for session pages and links that resolve — previewed before anything is written, and undoable.",
    tidy_s_run: "Tidy…",
    tidy_s_history: "Tidy history",
    tidy_s_last: "Last run {when} · {n} files",
    tidy_s_last_undone: "undone",
    tidy_s_none: "No run yet",
  },
  ko: {
    ...EVERYDAY_STRINGS.ko,
    app_name: "myco",
    quick_search: "검색하거나 이동…",
    quick_ask: "위키에 질문하기",
    nav_workspace: "워크스페이스",
    nav_pages: "내 노트",
    nav_tools: "더 보기",
    nav_overview: "홈",
    nav_ingest: "자료 추가",
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
    bd_deleted: "“{name}” 보드를 삭제했습니다",
    bd_board_exists: "“{name}” 보드가 이미 있어 그 보드를 열었습니다",
    bd_name_refused: "“{name}”은(는) 보드 이름으로 쓸 수 없습니다",
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
      "{n}개 항목을 _inbox/로 가져왔습니다 — 자료 추가에서 위키 페이지로 만드세요.",
    ci_title: "대화 가져오기",
    ci_hint:
      "ChatGPT 내보내기(conversations.json) 또는 Claude Code / Codex 세션(.jsonl). 각 대화가 소스 문서로 _inbox/에 들어가 자료 추가 과정에서 처리됩니다.",
    ci_btn: "파일 선택…",
    ci_busy: "가져오는 중…",
    ci_done:
      "{n}개 대화를 _inbox/로 가져왔습니다 — 자료 추가에서 위키 페이지로 만드세요.",
    ci_partial: "가져오기 미완료 · 가져옴 {i} · 건너뜀 {s} · 실패 {f}. 제외되거나 실패한 자료를 확인해 주세요.",
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
    q_empty: "저장한 내용이 궁금하면 물어보세요. 답변과 함께 관련 노트를 보여드려요.",
    s_mascot: "마스코트 MYCO 표시",
    s_mascot_hint:
      "로더·빈 화면·정보 페이지에 등장합니다. 끄면 정적 로고로 대체됩니다.",
    s_roam: "작업하는 동안 화면을 돌아다니기",
    s_roam_hint:
      "오래 걸리는 작업을 하는 동안 MYCO가 노치에서 나와 화면을 돌아다니다가, 작업이 끝나면 노치로 돌아갑니다. 작업이 없을 때도 가끔 잠깐 나와서 산책합니다. ‘동작 줄이기’를 켰거나, 전체 화면 앱을 쓰는 중이거나, 화면이 잠겨 있으면 노치에 그대로 있습니다.",
    myco3d_label: "3D로 본 myco. 끌거나 화살표 키로 돌려 보세요. Home 키를 누르면 앞모습으로 돌아와요.",
    myco3d_loading: "myco를 준비하는 중…",
    myco3d_error: "이 화면에서는 3D를 보여 줄 수 없어서 그림으로 보여 드려요.",
    s_myco3d: "입체 myco",
    s_myco3d_hint: "까만 myco와 하얀 myco를 이리저리 돌려 볼 수 있어요. 끌거나, 누른 다음 화살표 키를 쓰세요.",
    s_myco3d_skin: "색",
    s_myco3d_black: "블랙",
    s_myco3d_white: "화이트",
    myco_spin_label:
      "빙글 도는 myco. 옆으로 끌거나 왼쪽·오른쪽 화살표 키로 돌려 보세요. Home 키를 누르면 앞모습으로 돌아와요.",
    myco_spin_error: "여기서는 영상을 틀 수 없어서 그림으로 보여 드려요.",
    s_myco3d_view: "보기",
    s_myco3d_video: "영상",
    s_myco3d_model: "입체",
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
    hw_sc_live_link: "노트 속 링크 열기. 고치려면 방향키로 링크 안에 들어가세요",
    hw_sc_live_link_touch: "노트 속 링크 열기. 고치려면 링크 바로 옆을 누르고 커서를 안으로 옮기세요",
    hw_sc_back: "뒤로",
    hw_sc_fwd: "앞으로",
    hw_md: "마크다운 · 편집기에서",
    hw_sc_bold: "굵게 (다시 누르면 해제)",
    hw_sc_italic: "기울임",
    hw_sc_code: "선택한 글자를 인라인 코드로",
    hw_sc_link: "선택한 글자를 노트 링크로",
    hw_sc_highlight: "형광펜",
    hw_sc_slash: "블록 메뉴",
    hw_sc_wikilink: "이름으로 노트 연결",
    hw_tip_graph1: "별을 드래그하면 시뮬레이션이 주변에서 다시 살아납니다.",
    hw_tip_graph2:
      "F 키로 우주선을 탑니다. 레이아웃 · 스킨 · 근접 행성은 설정 서랍에 있습니다.",
    hw_tip_graph3:
      "위에서 질문을 고르면 인코딩만 바뀌고, 왼쪽 빈 곳 목록이 곧 답입니다.",
    hw_tip_query1:
      "답변은 위키 페이지를 인용합니다 — 인용을 클릭해 열어보세요.",
    hw_tip_query2:
      "그래프의 ‘연결이 빠진 곳’ 패널이 연구 질문을 이 입력창에 담아줄 수 있습니다.",
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
    tasks_col_blocked: "막힘",
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
    tasks_detail_estimate_hint: "2일, 3시간, 30분 또는 90m, 2d 같은 형식으로 적어 주세요.",
    tasks_detail_recur: "반복",
    tasks_detail_notes: "상세 내용",
    tasks_detail_notes_ph: "세부 내용, 링크, 맥락…",
    tasks_detail_recur_hint:
      "myco가 계산하는 규칙은 매일·매주·매달·매년, \u20182주마다\u2019 같은 반복입니다(every week처럼 적어도 됩니다). 그 밖의 규칙은 노트에 그대로 남습니다.",
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
    tasks_compose_category_ph: "예: 업무",
    tasks_compose_project_ph: "예: 프로젝트 노트 이름",
    tasks_detail_estimate_ph: "예: 2일",
    tasks_detail_recur_ph: "예: 매주",
    tasks_due_named: "마감 {date}",
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
    tray_sub_distilling: "정리 중 · {step}",
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
    skip_to_content: "본문으로 건너뛰기",
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
      "myco는 추가한 모든 논문·아티클·노트를 인용 기반으로 연결된 지식 그래프로 만듭니다. 모든 페이지는 마크다운이라, 통제권은 항상 당신에게 있습니다.",
    ov_cta_ingest: "자료 추가하기",
    ov_cta_ask: "위키에 질문",
    ov_stats_pages: "페이지",
    ov_stats_links: "연결",
    ov_stats_ratio: "위키만으로 답변",
    ov_quick: "이어서 보기",
    ov_stats_moved: "이번 주 움직임",
    ov_moved_none: "최근 7일간 쓴 것 없음",
    ov_pulse_alt: "페이지 {pages}개, 연결 {links}개, 이번 주 {moved}개 움직임",
    ov_recent_moved: "최근 노트",
    ov_recent_never: "아직 노트가 없어요. 위에서 자료를 추가하거나 첫 노트를 써 보세요.",
    home_links_today: "오늘 새로 이어진 노트:",
    home_links_more: " 외 {n}쌍",
    home_links_cites: "새 인용 {n}개",
    home_links_none: "오늘은 아직 새로 이어진 노트가 없어요",
    home_links_updated: "노트를 저장하면 갱신돼요",
    ing_title: "자료 추가",
    ing_lede:
      "파일을 드롭하거나 URL을 붙여넣거나 노트를 쓰세요. Claude가 읽고, 엔티티와 개념을 추출하고, 소스 페이지를 만들고, 그래프에 엮어 넣습니다.",
    ing_drop: "여기에 파일 드롭",
    ing_drop_or: "또는 URL 붙여넣기",
    ing_browse: "파일 선택…",
    ing_image_capability_unavailable:
      "선택한 수확·세션 정리 모델의 이미지 입력 지원이 확인되지 않았어요. 텍스트 자료를 사용하거나 모델 설정을 확인해 주세요. 외부 이미지 모델은 원하는 경우에만 선택하세요.",
    ing_source_authority_changed:
      "열린 볼트나 수확·세션 정리 실행 권한이 바뀌었거나 확인할 수 없어요. 모델 설정을 확인하고 현재 화면에서 다시 시도해 주세요.",
    ing_source_credential_unavailable:
      "선택한 수확·세션 정리 모델의 연결 인증 정보를 사용할 수 없어요. 모델 설정을 확인하거나 텍스트 자료를 사용해 주세요. 외부 모델은 선택 사항입니다.",
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
    ing_web_fetch: "이 페이지 불러오기",
    ing_web_fetching: "페이지 불러오는 중…",
    ing_web_rule_visible: "누구나 볼 수 있는 글만 불러옵니다. 유료 기사나 로그인해야 보이는 글은 안 됩니다.",
    ing_web_rule_private: "내 컴퓨터나 집·회사 안의 주소는 열지 않습니다.",
    ing_web_rule_keep: "불러온 글이 칸 속 링크 자리에 들어오고, 아래 버튼을 누르기 전에는 저장되지 않습니다.",
    ing_web_pii_warn: "이 페이지에는 전화번호나 이메일 같은 개인정보가 있습니다.",
    ing_web_err_bad_url: "웹 주소 모양이 아닙니다.",
    ing_web_err_scheme: "http:// 또는 https:// 주소만 불러올 수 있습니다.",
    ing_web_err_credentials: "이름과 비밀번호가 들어 있는 주소는 열지 않습니다.",
    ing_web_err_blocked: "내 컴퓨터나 내부 네트워크를 가리키는 주소라 열지 않았습니다.",
    ing_web_err_resolve: "사이트를 찾지 못했습니다. 주소를 확인해 주세요.",
    ing_web_err_redirect: "사이트가 따라갈 수 없는 주소로 넘겼습니다.",
    ing_web_err_redirects: "사이트가 다른 주소로 너무 여러 번 넘겼습니다.",
    ing_web_err_status: "사이트가 오류로 답했습니다({n}).",
    ing_web_err_not_html: "웹 페이지가 아닙니다. PDF나 다른 파일일 수 있습니다.",
    ing_web_err_too_large: "페이지가 5MB보다 큽니다.",
    ing_web_err_timeout: "사이트가 너무 오래 답하지 않았습니다.",
    ing_web_err_network: "연결하지 못했습니다. 인터넷 연결을 확인해 주세요.",
    ing_web_err_empty: "그 페이지에서 읽을 글을 찾지 못했습니다.",
    ing_web_err_secret: "페이지에 비밀번호나 키처럼 보이는 내용이 있어 불러오지 않았습니다.",
    ing_web_err_pii: "페이지에 개인정보가 있고, 개인정보 감지 시 '격리'로 설정되어 있어 불러오지 않았습니다.",
    ing_web_err_scan: "비밀번호나 개인정보가 있는지 확인하지 못해 불러오지 않았습니다.",
    ing_guard_secret: "글에 비밀번호나 키처럼 보이는 내용이 있어 저장하지 않았습니다. 그 부분을 지우고 다시 실행해 주세요.",
    ing_guard_pii: "글에 개인정보가 있고, 개인정보 감지 시 '격리'로 설정되어 있어 저장하지 않았습니다.",
    ing_guard_scan: "비밀번호나 개인정보가 있는지 확인하지 못해 저장하지 않았습니다.",
    ing_guard_pii_warn: "이 글에는 전화번호나 이메일 같은 개인정보가 있습니다. 그대로 보관됩니다.",
    ing_web_err_other: "페이지를 불러오지 못했습니다.",
    ing_paste_url_ph: "https://example.com/paper.pdf",
    ing_or_paste: "또는 원문 붙여넣기",
    ing_paste_ph: "기사, 노트, 대화 내용을 붙여넣으세요…",
    ing_run: "자료 정리하기",
    ing_recent: "최근 추가한 자료",
    ing_pipeline: "파이프라인",
    ing_step_read: "소스 읽기",
    ing_step_summarize: "요약",
    ing_step_extract: "엔티티·개념 추출",
    ing_step_link: "기존 페이지와 교차 연결",
    ing_step_lint: "린트 및 로그 기록",
    ing_step_claude: "Claude가 위키를 작성",
    ing_step_refresh: "인덱스·그래프 갱신",
    ing_success_title: "자료 추가 완료",
    ing_success_sub: "위키가 갱신되었습니다 · {time}",
    ing_open_index: "위키 인덱스 열기",
    ing_open_report: "자료 추가 보고서 열기",
    hist_collapse: "접기",
    hist_expand: "펼치기",
    ing_run_again: "다른 자료 추가",
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
    ing_plan: "자료 추가 계획 {n}개",
    ing_plan_hint:
      "이 소스가 무엇을 바꿀지 — 에이전트가 이 계획을 따라 중복 대신 기존 페이지를 갱신합니다.",
    ingest_gate_title: "자료 추가 계획 — 적용할 항목을 고르세요",
    ingest_gate_apply: "고른 {n}개만 적용",
    ingest_gate_all: "전부 적용({n}개)",
    ingest_gate_noop_hint:
      "‘이미 있음’ 항목은 위키에 이미 들어 있어 처음부터 선택을 해제해 두었어요.",
    ing_cancel: "취소",
    ing_cancelled: "자료 추가가 취소되었습니다",
    ing_gate_title: "계획 검토 중 — 적용할 항목을 고르세요",
    ing_gate_waiting:
      "선택을 기다리고 있습니다. 적용할 항목을 고르면 작성을 시작합니다.",
    ing_clear: "내용 지우기",
    ing_touched_n: "{n}페이지 갱신",
    ing_refused_more: "내용 더 붙여넣기",
    ing_short_title: "짧은 글은 노트로 바로 저장할 수 있어요",
    ing_short_daily: "오늘의 노트에 적기",
    ing_short_new: "새 노트로 저장",
    ing_short_new_failed: "노트를 저장하지 못했어요",
    ing_gate_paused: "선택을 기다리는 중",
    ing_gate_source: "붙여 넣은 원문",
    ing_more_advanced: "고급",
    ing_pick_file: "파일 고르기",
    ing_preview_open: "페이지 열기",
    ing_preview_close: "미리보기 닫기",
    ing_preview_writing: "아직 작성 중입니다 — 잠시 후 다시 눌러보세요.",
    ing_chip_done: "자료 추가 완료",
    ing_chip_error: "자료 추가 실패",
    q_title: "내 노트에 질문하기",
    q_lede:
      "myco는 먼저 위키에서 답을 찾고, 부족할 때만 원본 소스로 들어갑니다. 모든 주장에는 인용이 따라옵니다.",
    q_send: "질문하기",
    q_recent: "최근 질문",
    q_answer: "답변",
    q_sources_used: "참조된 소스",
    q_wiki: "위키",
    q_raw: "원본",
    gr_title: "그래프",
    gr_lede:
      "페이지와 그 사이의 연결. 노트를 드래그하면 시뮬레이션이 따라옵니다. 우측 설정 패널에서 필터/디스플레이/포스를 조정하세요.",
    gr_canvas_aria: "볼트 링크 지도. 방향키로 노트를 옮겨 고르고, Enter 로 엽니다.",
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
    gr_q_neighbors_u: "두 단계 이웃",
    gr_q_sub_neighbors: "선택한 노트에서 두 단계까지",
    gr_q_pick: "노트를 하나 고르세요",
    gr_size: "점 크기 기준",
    gr_size_backlinks: "크기 = 백링크",
    gr_size_cites: "크기 = 인용",
    gr_hide_sample: "샘플 {n}개 숨기기",
    gr_show_unresolved: "미해결 링크 표시",
    gr_rebuilds: "씬 재빌드 {n}회 · {ms} ms",
    gr_honest_lead: "이 그래프가 그리는 건 노트 {n}개",
    gr_honest: "첫 실행 샘플 {sample}개({pct}%) · 내가 쓴 노트 {own}개 · 미해결 {unresolved}개. 인용을 가진 노트는 {cited}개.",
    gr_honest_sessions: "보관된 대화 {n}건은 제외하고 노트와 연결을 보여줘요.",
    gr_summary: "내 노트 {own}개, 연결이 빠진 곳 {gaps}개",
    gr_details: "자세히",
    gr_gap_nobacklink: "아무도 참조 안 함",
    gr_act_link: "링크 제안",
    gr_act_harvest: "수확 대상으로",
    gr_act_neighbors: "이 노트의 이웃만 보기",
    gr_act_open_s: "열기",
    gr_act_link_s: "링크",
    gr_act_want_s: "수확",
    gr_insp_cites: "인용",
    gr_insp_sample: "첫 실행 샘플",
    gr_insp_own: "내 노트",
    gr_insp_nocite: "인용 0",
    gr_enc_orphans: "색 = 카테고리 · 크기 = 링크 수 · 흐림 = 이미 연결됨",
    gr_enc_clusters: "블록 = 클러스터 · 점선 테두리 = 지도 페이지 없음 · 점선 = 안 이어진 인접 주제",
    gr_enc_time: "색 = 최근 수정(단일 램프) · 링 = 30일 내 · 흐림 = 90일 이상 방치",
    gr_enc_neighbors: "가까울수록 밝게 (고른 노트와 바로 이웃은 밝게, 두 단계 건너는 흐리게, 그 밖은 거의 안 보임)",
    gr_enc_strata: "가로 = 마지막 수정일(왼쪽이 오래됨) · 띠 = 클러스터",
    gr_link_question: "볼트에서 \"{a}\" 가 연결되지 않은 채로 있습니다. 어떤 노트가 여기에 링크해야 하고, 그 링크는 무슨 말을 해야 할까요?",
    gr_want_done: "\"{n}\" 을(를) 필요한 주제로 기록했습니다",
    gr_legend: "범례",
    gr_filter: "필터",
    gr_filter_folder: "폴더: {f}",
    gr_filter_search: "검색: {q}",
    gr_filter_remove: "필터 해제: {f}",
    gr_filter_empty: "필터에 맞는 노트가 없어요",
    gr_filter_clear: "필터 지우기",
    gr_node_count: "노트",
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
    gr_show_orphans: "고립 노트 표시",
    gr_show_orphans_hint: "연결이 없는 노트",
    gr_existing_only: "존재하는 파일만",
    gr_existing_only_hint: "미해결 [[위키링크]] 숨김",
    gr_skin: "색상 모드",
    gr_skin_auto: "앱 테마",
    gr_skin_black: "블랙",
    gr_skin_white: "화이트",
    gr_skin_galaxy: "은하계",
    gr_skin_web: "우주 그물",
    gr_recency: "최근성 발광",
    gr_recency_hint: "최근 수정한 노트가 더 뜨겁게 빛납니다",
    gr_minimap: "미니맵",
    gr_minimap_hint: "은하 전체 차트 — 클릭하면 그 지점으로 이동",
    gr_layout_spiral: "나선 은하",
    gr_layout_strata: "연대기",
    gr_layout_semantic: "의미 지도",
    gr_layout_celestial: "천구 별자리",
    gr_layout_radial: "동심 궤도",
    gr_layout_walrus: "월러스 트리",
    gr_layout_mycelium: "균사 매트",
    gr_skin_sigma: "시그마",
    gr_skin_mycelium: "균사",
    gr_mycelium_dim: "균사 보기",
    gr_mycelium_3d: "3D",
    gr_mycelium_2d: "2D",
    gr_myc_node_color: "점 색상",
    gr_myc_hypha_color: "균사 색상",
    gr_myc_bg: "배경",
    gr_myc_bg_loam: "부엽토",
    gr_myc_bg_void: "암흑",
    gr_myc_bg_soil: "황토",
    gr_myc_bg_paper: "종이",
    gr_myc_bg_grid: "그리드",
    gr_myc_bg_custom: "사용자 지정 배경",
    gr_vibes: "원탭 룩",
    gr_vibe_living: "살아있는 은하",
    gr_vibe_sigma: "시그마 보드",
    gr_vibe_cosmicweb: "우주 그물",
    gr_vibe_neural: "신경계",
    gr_vibe_planetarium: "플라네타륨",
    gr_vibe_paper: "종이 지도",
    gr_vibe_chronicle: "연대기",
    gr_vibe_nebula: "의미 성운",
    gr_vibe_living_desc: "앱 테마를 따르는 기본 별 지도예요. 숨 쉬듯 천천히 움직여요",
    gr_vibe_sigma_desc: "어두운 바탕에 주제별 색과 가는 연결선으로 지도를 펼쳐요",
    gr_vibe_cosmicweb_desc: "암흑물질 필라멘트처럼 이어진 연결선이 그림을 만들어요",
    gr_vibe_neural_desc: "어둠 속에서 신호가 신경망처럼 연결을 타고 번져요",
    gr_vibe_planetarium_desc: "깊은 우주 하늘에 주제마다 별자리가 떠요",
    gr_vibe_paper_desc: "흰 종이에 인쇄한 영역 지도처럼 보여요",
    gr_vibe_chronicle_desc: "노트를 시간 지층으로 쌓아서 볼트를 역사처럼 읽어요",
    gr_vibe_nebula_desc: "뜻이 비슷한 노트끼리 모여서 성운을 이뤄요",
    gr_vibe_walrus: "월러스 트리",
    gr_vibe_mycelium: "균사",
    gr_vibe_walrus_desc: "CAIDA Walrus 방식으로 노트를 잇는 나무를 공 안에 펼쳐요",
    gr_vibe_mycelium_desc: "자라난 균사 매트 위에 노트가 매달려요",
    gr_looks: "룩",
    gr_appearance: "외형",
    gr_motion_fx: "모션·효과",
    gr_mascot_cameo: "MYCO 카메오",
    gr_mascot_cameo_hint: "가끔 MYCO가 기능 팁과 함께 등장",
    mc_label: "MYCO 팁",
    mc_dismiss: "닫기",
    mc_tip_drag:
      "아무 별이나 드래그하면 시뮬레이션이 다시 데워집니다 \u2014 이웃이 따라오다 튕겨 돌아와요.",
    mc_tip_path: "두 노트를 Cmd/Ctrl-클릭하면 사이의 최단 경로가 빛납니다.",
    mc_tip_fly:
      "F를 누르면 볼트를 우주선으로 비행 \u2014 WASD로 날고 Esc로 착륙.",
    mc_tip_looks:
      "설정 패널을 열고 룩을 탭하세요 \u2014 Sigma, Paper, Neural, Planetarium\u2026",
    mc_tip_timelapse:
      "타임랩스를 재생하면 작성한 순서대로 볼트가 스스로 자라납니다.",
    mc_tip_multiverse:
      "멀티버스를 켜면 각 프로젝트가 저마다 빛나는 우주 버블로 보입니다.",
    mc_tip_minimap:
      "구석의 미니맵 \u2014 아무 데나 클릭하면 카메라가 그곳으로 날아갑니다.",
    mc_tip_recency:
      "최근 편집한 노트일수록 더 뜨겁게 타올라 \u2014 그래프가 당신의 관심을 지도로 그립니다.",
    mc_tip_save:
      "마음에 드는 룩을 튜닝했나요? 저장된 룩에 이름을 붙여 한 번에 불러오세요.",
    mc_tip_chronicle:
      "연대기 레이아웃을 써보세요 \u2014 노트가 실제 시간축을 따라 놓입니다.",
    gr_saved: "저장된 룩",
    gr_saved_apply: "이 저장된 룩 적용",
    gr_saved_delete: "삭제",
    gr_saved_empty: "현재 설정을 저장해 두면 나중에 불러올 수 있습니다.",
    gr_saved_name_ph: "룩 이름\u2026",
    gr_saved_save: "저장",
    gr_layout_3d: "3D \u2014 공간 궤도",
    gr_layout_2d: "2D \u2014 평면 지도",
    gr_layout_galaxy_s: "은하",
    gr_layout_synapse3d_s: "시냅스",
    gr_layout_atlas_s: "아틀라스",
    gr_layout_synapse_s: "시냅스 (평면)",
    gr_cinematic: "시네마틱 마감",
    gr_cinematic_hint: "필름 그레인·비네트·렌즈 스트릭·안티앨리어싱",
    gr_flow: "엣지 흐름",
    gr_flow_hint: "링크를 따라 빛 펄스가 출발\u2192도착 방향으로 흐름",
    gr_semantic_missing:
      "의미 지도는 임베딩 인덱스가 필요합니다 — 설정 \u2192 모델에서 재색인 후 다시 열어주세요. 지금은 나선 배치로 표시합니다.",
    gr_galaxies: "폴더 은하계",
    gr_galaxies_hint: "폴더마다 하나씩, 천천히 자전하는 은하계로 분리",
    gr_multiverse: "멀티버스",
    gr_multiverse_hint:
      "모든 프로젝트를 각자의 우주 버블로 표시. 하나로 날아 들어가면 그 프로젝트가 열림",
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
    gr_node_color: "점 색상",
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
    gr_click_burst_hint: "노트 선택 시 슈퍼노바 + 파동",
    gr_neural_firing: "신경 발화",
    gr_neural_firing_hint: "주기적으로 메시를 타고 흐르는 신호",
    gr_planets: "근접 행성",
    gr_planets_hint: "가까운 노트가 절차적 행성이 됨 (다크 3D)",
    gr_pixel_nodes: "픽셀 노트",
    gr_pixel_nodes_hint: "발광 점 대신 16x16 픽셀아트 스프라이트로 표시",
    gr_color_depth: "색 짙기",
    gr_edge_tint: "링크 색상",
    gr_edge_tint_grey: "회색",
    gr_edge_tint_community: "커뮤니티 웹",
    gr_help_btn: "제스처 안내",
    gr_more_menu: "더 보기",
    gr_canvas_label: "노트 {n}개",
    gr_canvas_label_sel: "노트 {n}개, 선택: {name}",
    gr_help_title: "제스처 안내",
    gr_help_click: "노트에 포커스 (바로 이웃까지)",
    gr_help_dblclick: "포커스를 두 단계 이웃까지 넓히기",
    gr_help_cmdclick: "노트 사이 최단 경로",
    gr_help_esc: "위에 열린 창을 닫거나 포커스에서 한 단계 나가기",
    gr_help_fly: "우주선 모드 전환",
    gr_help_drag: "우주 궤도 회전",
    gr_help_rails: "연결이 빠진 곳 / 범례 패널 접기·펼치기",
    gr_rail_fold: "{name} 접기",
    gr_rail_open: "{name} 펼치기",
    gr_panels: "패널",
    gr_trace: "경로 추적",
    gr_trace_hint: "시작 노트를 누른 뒤 끝 노트를 누르세요",
    gr_spaceship: "우주선 비행",
    gr_spaceship_hint:
      "WASD 이동 · 드래그로 방향 · 노트 클릭해 정보 · Esc 종료",
    gr_spaceship_exit: "나가기",
    gr_speed: "속도",
    gr_close: "닫기",
    gr_open: "페이지 열기",
    gr_text_fade: "라벨 페이드 임계",
    gr_node_size: "점 크기",
    gr_link_thickness: "링크 두께",
    gr_brightness: "밝기",
    gr_center_force: "중심력",
    gr_repel_force: "반발력",
    gr_link_force: "링크 장력",
    gr_link_distance: "링크 거리",
    gr_cluster_force: "뭉침 강도",
    gr_myc_spread: "균사 확산",
    gr_myc_branch: "분기 밀도",
    gr_myc_forces_hint:
      "균사는 시뮬레이션이 아니라 자라나는 방식입니다: 이 두 슬라이더가 균사체의 형태를 바꿉니다.",
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
    gr_insp_back: "{n} 노트로 돌아가기",
    gr_not_in_graph: "이 노트는 지금 그래프에 없어요. 필터나 제외된 폴더 때문일 수 있어요.",
    gr_insp_unresolved: "미해결 노트 (파일 없음)",
    gr_insp_none: "—",
    gr_find_ph: "노트 찾기…",
    gr_insp_path_start: "경로 시작점으로",
    gr_insp_path_anchor: "경로 시작점",
    gr_insp_path_clear: "지우기",
    gr_insp_path: "경로",
    gr_insp_path_none: "이 노트까지 경로 없음",
    gr_insp_hops: "단계",
    gr_gaps_title: "연결이 빠진 곳",
    gr_tools: "그래프 도구",
    s_back_list: "설정 목록",
    gr_rails_sheet: "빈 곳과 범례",
    gr_legend_empty: "아직 보여 줄 것이 없습니다.",
    gr_gesture_hint: "끌어서 둘러보고, 두 손가락으로 확대하고, 별을 누르면 이웃이 보입니다.",
    gr_gesture_ok: "알겠어요",
    gr_gaps_btn: "연결이 빠진 곳 찾기",
    gr_gap_missing: "없는 페이지",
    gr_gap_malformed: "형식 오류 링크",
    gr_gap_orphans: "고립 노트",
    gr_gap_undercited: "인용 부족",
    gr_gap_lowconf: "낮은 신뢰도",
    gr_gap_disputed: "논쟁",
    gr_gap_islands: "끊긴 클러스터",
    gr_gap_none: "연결이 빠진 곳 없음",
    gr_gap_bridges: "연구 다리",
    gr_gap_ask: "이 빈 곳에 질문하기",
    gr_bridge_question:
      '"{a}"와(과) "{b}"에 대한 내 노트들은 의미상 가깝지만 아직 연결되어 있지 않습니다. 두 주제를 잇는 것은 무엇인가요? 다리가 될 아이디어나 작성할 노트를 제안해 주세요.',
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
    gr_motion_hint_myc: "느린 3D 자동 회전 (3D 보기에서만)",
    gr_advanced: "고급",
    gr_loading: "별자리를 정렬하는 중…",
    gr_ctx_lost: "그래픽 컨텍스트가 끊어졌습니다.",
    gr_retry: "다시 그리기",
    gr_perf_mode: "성능 모드 — 큰 그래프에서는 배경 효과를 끕니다",
    h_title: "히스토리",
    h_lede:
      "자료를 추가할 때마다 WHY 보고서가 남습니다. 각 실행이 무엇을 만들고 바꿨는지 최신순으로 봅니다.",
    h_created: "생성",
    h_modified: "수정",
    h_empty:
      "아직 자료 추가 기록이 없습니다 — 자료를 추가하면 보고서가 여기에 쌓입니다.",
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
    s_account: "내 공간",
    s_local_user: "로컬 사용자",
    s_no_vault: "볼트 없음",
    s_vault_path: "볼트 폴더",
    s_change: "변경…",
    q_empty_response: "(응답 없음)",
    eb_title: "{area}에서 문제가 발생했습니다.",
    eb_reload: "myco 다시 불러오기",
    eb_retry: "다시 시도",
    eb_area_app: "앱",
    eb_area_graph: "그래프",
    eb_home: "홈으로",
    eb_details: "자세히",
    s_workspace: "워크스페이스",
    s_model: "AI 설정",
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
    s_providers: "AI 연결",
    s_appearance: "테마",
    s_vault_known: "myco가 이미 아는 볼트",
    s_storage_title: "저장 상태",
    s_storage_desc: "볼트가 어디 있는지, 읽지 못한 파일이 있는지, 마지막으로 언제 저장했는지 보여 줍니다.",
    s_storage_where: "위치",
    s_storage_icloud: "iCloud Drive",
    s_storage_dropbox: "Dropbox",
    s_storage_unread: "내려받지 않았거나 읽지 못한 파일",
    s_storage_unread_none: "없음",
    s_storage_unread_n: "{n}개",
    s_storage_checking: "확인하는 중…",
    s_storage_unread_hint: "myco가 이 파일을 읽지 못해 링크와 그래프에서 빠질 수 있어요. 내려받거나 고치면 다시 읽습니다. 늦어도 볼트를 다시 열 때 읽어요.",
    s_storage_history: "볼트 이력",
    s_storage_last_save: "마지막 저장",
    s_storage_no_save: "이번 실행에서는 아직 저장하지 않았어요",
    s_ov_theme: "개요 배경",
    s_ov_theme_lede:
      "홈 화면의 인사말과 질문 입력창 뒤에 흐르는 살아 있는 배경이며, '검토하고 정리하기' 안에서도 보입니다. 그래프 레이아웃 이름을 그대로 쓰지만 연동되지는 않습니다.",
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
    s_mcp: "외부 도구 연결 (MCP)",
    mcp_lede:
      "이 볼트를 Claude Code·Claude Desktop에 MCP 도구로 노출합니다. 아래 명령으로 한 번만 등록하면, 이 앱이 꺼져 있어도 모든 Claude 세션에서 동작합니다.",
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
      "myco는 기본적으로 로컬 모델을 사용합니다. 작업별로 모델을 지정할 수 있으며, 외부 모델은 직접 연결하고 선택했을 때만 사용합니다.",
    s_model_ingest: "자료 추가용 모델",
    s_model_query: "질문용 모델",
    model_custom: "직접 입력\u2026",
    model_disconnected: "(연결 안 됨)",
    model_effort: "추론 강도",
    model_custom_ph: "모델 ID",
    model_apply_custom: "모델 적용",
    model_fetching: "모델 목록 가져오는 중\u2026",
    s_model_recommended: "추천",
    s_model_use_recommended: "추천 설정 사용",
    s_model_choose_own: "직접 고르기",
    s_model_recommended_needs: "위에서 로컬 모델을 준비하면 실행할 수 있어요. 외부 계정은 필요하지 않아요.",
    s_model_ctx: "컨텍스트",
    ing_extractive_note:
      "발췌 요약 — 아래 문장은 모두 `raw/{slug}.md`에서 그대로 인용한 것입니다. 이 소스를 읽은 모델이 없으므로, 바꿔 쓴 문장도 추론한 내용도 없습니다.",
    ing_extractive_report_title: "발췌 방식 자료 추가: {title}",
    local_transform_note: "전체 {total}개 구절 중 {selected}개로 만든 로컬 요약 · {model} · 확인 필요",
    local_transform_fallback_note: "로컬 요약을 만들지 못했습니다 · {model}; 원문 인용을 보존했습니다",
    local_transform_report_why: "로컬 모델로 제한된 범위의 요약을 만들고 전체 원문 근거를 보존했습니다. 태그와 관련 링크는 기존 규칙으로 처리했습니다.",
    ing_local_transform_hint: "이 컴퓨터에서 요약 초안을 만들고 원문 인용을 보존합니다. 요약 내용을 확인하세요.",
    ing_run_local_transform: "요약·원문 인용 추가",
    ing_extractive_report_why:
      "이번 실행은 내장 오프라인 경로를 사용했습니다. 소스의 문장을 그대로 인용해 출처를 달았고, 태그는 볼트에 이미 있는 것만 재사용했으며, 관련 페이지는 로컬 임베딩 색인에서 가져왔습니다. **모델은 호출하지 않았습니다.** 소스를 요약한 주체가 없으므로 `confidence`는 `low`입니다. 모델을 연결하고 다시 실행하면 이 페이지를 대체할 수 있습니다.",
    ing_extractive_log:
      "{date} — [[source-{slug}]] ({title}) 발췌 방식 자료 추가, 모델 호출 없음",
    ing_extractive_hint:
      "발췌 방식 — 소스를 그대로 인용하며 모델을 호출하지 않습니다.",
    ing_run_extractive: "발췌 방식으로 추가",
    ing_extractive_pending: "원문 {n}개 구간이 남았습니다. 다음 실행에서 이어서 정리하며 원문은 보존합니다.",
    set_distill_evidence_pending: "자료 {n}개에 정리할 구간이 남았습니다. 다시 실행하면 이어서 정리하며 기록은 계속 검색할 수 있습니다.",
    workflow_pending: "처리 대기",
    workflow_partial: "일부만 완료",
    workflow_stopped: "중지됨",
    session_compile_label: "세션 정리",
    session_compile_progress: "처리한 구간 {processed}/{total}",
    session_compile_stopping: "중지 확인 중…",
    session_compile_preparation: "세션 정리 · 선택한 로컬 모델 준비 필요",
    session_queue_title: "세션 정리 작업",
    session_queue_refresh: "목록 새로 고침",
    session_queue_idle: "폴더를 열면 세션 정리 상태를 확인할 수 있습니다.",
    session_queue_failed: "정리 목록을 불러오지 못했습니다. 목록을 새로 고쳐 다시 확인해 주세요.",
    session_queue_empty: "미완료 세션 정리 작업이 없습니다.",
    session_queue_count: "미완료 작업 {total}개 · 현재 {shown}개 표시",
    session_queue_running: "진행 중",
    session_queue_completed: "처리 완료",
    session_queue_superseded: "새 자료로 대체됨",
    session_queue_unknown: "상태 확인 필요",
    session_queue_runtime_review: "이전 실행을 이어가려면 새 검토가 필요합니다.",
    session_queue_conditions_review: "현재 정리 조건에 맞는 새 검토가 필요합니다.",
    session_queue_reason_other: "저장된 사유를 세부 정보에서 확인할 수 있습니다.",
    session_queue_details: "세부 정보",
    session_queue_preparation: "선택한 모델로 세션을 정리할 준비가 필요합니다.",
    session_queue_incomplete: "아직 정리하거나 검토할 구간이 남아 있습니다.",
    session_queue_model_failed: "선택한 모델이 이번 실행을 완료하지 못했습니다.",
    session_queue_processing_failed: "처리를 완료하지 못했습니다. 세부 정보에서 사유를 확인해 주세요.",
    workflow_failed: "완료하지 못함",
    workflow_skipped: "처리할 작업 없음",
    workflow_review_retry: "확인하고 다시 시도",
    workflow_retry_hint: "아래 원인을 확인한 뒤 남은 작업을 다시 시도해 주세요.",
    s_providers_lede:
      "원하는 제공자를 연결하세요. 키는 로컬에만 저장되며, myco 서버는 절대 보지 못합니다.",
    s_provider_connected: "연결됨",
    s_provider_disconnected: "미연결",
    s_provider_error: "{name} 설정을 바꾸지 못했습니다",
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
      "myco가 켜져 있는 동안 Claude Code / Codex 대화를 주기적으로 sessions/로 가져옵니다. Ask가 그 내용을 검색해 인용합니다. 짧은 잡음 세션과 이미 가져온 세션은 건너뜁니다. 세션은 유료 자료 추가 대상이 아닙니다 — 위키가 아니라 기록이기 때문입니다.",
    s_autoimport_interval: "주기",
    s_autoingest_title: "받은 자료와 세션 자동 정리",
    s_autoingest_desc:
      "myco가 켜져 있는 동안 인박스 자료와 연결된 도구에서 받은 세션 변경을 선택한 정리 모델로 정리합니다. 같은 대화의 변경은 하나의 요약 페이지에 반영합니다.",
    s_autoingest_interval: "주기",
    s_provider_connect: "연결",
    s_provider_disconnect: "해제",
    s_provider_test: "테스트",
    s_provider_kind_cli: "설치한 프로그램",
    s_provider_kind_api: "API 키",
    s_provider_kind_local: "내 컴퓨터",
    s_provider_name_builtin_local: "내장 (오프라인)",
    s_provider_key_ph: "API 키 붙여넣기",
    s_provider_key_save: "저장",
    s_provider_checking_ollama: "Ollama 확인 중…",
    s_provider_keychain_note: "API 키는 디스크에 그대로 저장하지 않고, 운영체제의 키체인(macOS 키체인 / Windows 자격 증명 관리자 / Secret Service)에 보관합니다.",
    s_lang_lede:
      "UI 언어와 Claude의 작성 언어는 별개입니다. 한국어 UI에서 영어 노트를 만들어도 좋습니다.",
    s_lang_ui: "인터페이스",
    s_lang_drafts: "작성 언어 (Claude)",
    s_appearance_lede: "기본값은 시스템을 따릅니다.",
    s_appearance_light: "라이트",
    s_appearance_dark: "다크",
    s_appearance_system: "시스템",
    s_text_size: "글자 크기",
    s_text_size_desc: "노트와 답변 글자를 얼마나 크게 볼지 정합니다.",
    s_text_size_system: "시스템 설정 따르기",
    s_text_size_custom: "직접 고르기",
    s_text_size_small: "작게",
    s_text_size_medium: "보통",
    s_text_size_large: "크게",
    s_text_size_sample: "노트와 답변이 이 크기로 보입니다.",
    s_about_built:
      "myco는 로컬 Obsidian 볼트와 Claude Code CLI 위에서 동작하는 얇은 클라이언트입니다. 페이지는 마크다운 — 당신의 지식은 당신의 것입니다.",
    dlg_cancel: "취소",
    dlg_ok: "확인",
    dlg_create: "만들기",
    dlg_delete: "삭제",
    dlg_rename: "이름 바꾸기",
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
    p_open_vault: "출처를 스캔하려면 볼트를 여세요.",
    p_scanning: "볼트 스캔 중…",
    p_empty: "아직 주장이 담긴 노트가 없습니다 — 본문을 추가해 보세요.",
    p_overall: "전체",
    p_claims_cited: "주장 인용됨",
    p_pages_by_coverage: "페이지별 인용 커버리지",
    rd_source: "마크다운 원문 편집",
    rd_source_active: "마크다운 원문 편집 중",
    rd_back_to_write: "원문 편집 닫기",
    rd_raw_read_only: "가져온 원본 파일은 읽기만 가능합니다. 문장을 고르면 출처와 함께 오늘의 노트에 옮길 수 있어요.",
    rd_quote_to_daily: "오늘의 노트로 옮기기",
    rd_quote_to_card: "카드로 만들기",
    rd_quote_actions: "고른 문장",
    rd_quote_card_none:
      "이 부분으로는 카드를 만들 수 없어요. 문장 하나를 통째로 골라 주세요.",
    rd_quote_card_title: "이 문장으로 만든 카드",
    rd_quote_card_msg: "카드는 고른 문장을 그대로 쓰고 낱말 하나만 빈칸으로 둬요. 저장하면 이 문장이 출처와 함께 오늘의 노트에도 들어가고, 체크한 카드는 {deck}에 저장돼요.",
    rd_quote_pick_title: "빈칸으로 만들 낱말 고르기",
    rd_quote_pick_msg: "이 문장에는 굵은 글씨나 위키링크가 없어요. 카드에서 물어볼 낱말을 하나 눌러 주세요. 저장하면 이 문장이 출처와 함께 오늘의 노트에도 들어가고, 카드는 {deck}에 저장돼요.",
    rd_quote_pick_front: "카드 앞면",
    rd_quote_pick_empty: "아직 고른 낱말이 없어요.",
    rd_loading: "노트를 여는 중…",
    rd_not_found: "노트를 찾을 수 없습니다",
    rd_not_found_sub: "옮겨졌거나 이름이 바뀌었거나 삭제되었을 수 있어요.",
    rd_unreadable: "노트를 열 수 없습니다",
    rd_find_note: "노트 검색",
    rd_go_home: "홈으로",
    rd_type_note: "노트",
    rd_save_failed: "이 초안의 파일 저장을 확인하지 못했어요. 보관할 변경을 복사하거나, 파일을 다시 읽고 필요한 변경을 직접 병합해 주세요.",
    rd_retry_save: "다시 저장",
    rd_copy_draft: "초안 복사",
    rd_draft_copied: "초안을 복사했습니다",
    rd_draft_copy_failed: "초안을 복사하지 못했습니다",
    rd_original_baseline: "편집을 시작한 원문",
    rd_current_file: "마지막으로 읽은 파일 내용",
    rd_recovery_draft: "복구할 로컬 초안",
    rd_retry_file_read: "파일 다시 읽기",
    rd_copy_baseline: "편집을 시작한 원문 복사",
    rd_baseline_copied: "편집을 시작한 원문을 복사했습니다",
    rd_baseline_copy_failed: "편집을 시작한 원문을 복사하지 못했습니다",
    rd_recovered_draft: "복구할 로컬 초안과 편집을 시작한 원문이 있어요. 현재 파일에 초안이 저장되었는지는 확인되지 않았어요. 편집을 시작한 원문과 현재 파일을 비교한 뒤, 파일을 다시 읽고 필요한 변경을 직접 병합해 주세요.",
    rd_reload_draft: "초안을 버리고 다시 읽기",
    rd_reload_draft_title: "초안을 버리고 파일을 다시 읽을까요?",
    rd_reload_draft_confirm: "보관할 변경은 먼저 복사해 주세요. 파일을 성공적으로 읽으면 저장되지 않은 현재 초안을 최신 파일 내용으로 바꿔요. 복사한 내용은 이후 직접 붙여넣어 병합할 수 있어요.",
    rd_reloading_draft: "다시 읽는 중…",
    rd_draft_reloaded: "최신 파일을 다시 읽었습니다. 복사한 초안에서 필요한 내용을 직접 붙여넣어 병합하세요.",
    rd_draft_reload_failed: "파일을 다시 읽지 못했습니다. 초안은 보관되어 있습니다.",
    rd_saving: "저장 중…",
    rd_saved: "저장됨",
    rd_save_pending: "자동 저장 대기 중…",
    rd_not_saved: "저장 필요",
    rd_task_toggle: "할 일 완료 전환",
    rd_frontmatter_hidden: "노트 속성 · 노트 정보에서 수정",
    live_ph_block: "'/'를 입력해 블록 선택",
    live_sources: "출처",
    start_chips_label: "이렇게 시작하기",
    start_day_todo: "오늘 할 일",
    start_day_todo_body: "## 오늘 할 일\n- [ ] ${}",
    start_day_meeting: "회의 기록",
    start_day_meeting_body: "## 회의 기록\n- 참석: ${}\n- 내용: ",
    start_day_thoughts: "생각 정리",
    start_day_thoughts_body: "## 생각 정리\n- ${}",
    rd_toc_empty: "아직 제목이 없습니다",
    rd_embed_loading: "불러오는 중…",
    rd_embed_missing: "섹션을 찾을 수 없습니다",
    ch_err_type: "차트 type은 bar, line, pie 중 하나여야 합니다",
    ch_err_line: "{n}번째 줄이 “key: value” 형식이 아닙니다",
    ch_err_data: "차트에 데이터가 없습니다: 편집에서 표를 고르거나 값을 직접 입력하세요",
    ch_err_table: "이 차트가 읽던 표가 이 노트에 없습니다",
    ch_err_number: "“{value}”은(는) 숫자가 아닙니다",
    mm_err: "Mermaid가 이 다이어그램을 그리지 못했습니다",
    callout_kind_note: "노트",
    callout_kind_tip: "팁",
    callout_kind_info: "정보",
    callout_kind_warning: "경고",
    callout_kind_danger: "위험",
    callout_kind_success: "성공",
    callout_kind_quote: "인용",
    callout_kind_important: "중요",
    callout_kind_caution: "주의",
    callout_kind_question: "질문",
    rd_backlinks_empty: "아직 여기로 연결된 노트가 없습니다.",
    rd_related: "관련 노트",
    rd_related_no_index:
      "관련 노트는 아직 만들지 않은 온디바이스 인덱스에서 나옵니다.",
    rd_related_no_index_cta: "의미 검색 설정하기",
    rd_make_cards: "카드 만들기",
    rd_making: "생성 중…",
    rd_cards_none:
      "이 노트에서는 카드를 만들 수 없어요. 인용, 굵은 글씨, 위키링크가 있는 문장이 필요해요.",
    rd_cards_made: "카드 {n}개 추가됨",
    rd_open_study: "학습 열기",
    rd_cards_preview_title: "이 노트에서 만든 카드",
    rd_cards_preview_msg: "모든 카드는 이 노트의 문장을 그대로 옮겼어요. 원하지 않는 카드는 체크를 해제하세요. 나머지는 {deck}에 저장돼요.",
    rd_cards_save: "저장",
    rd_cards_dupe: "이미 덱에 있음",
    rd_cards_ai_tag: "AI 초안",
    rd_cards_all_dupes: "이 노트의 카드는 모두 이미 {deck}에 있어요.",
    rd_cards_none_picked: "선택한 카드가 없어서 저장하지 않았어요.",
    rd_more: "더 보기",
    rd_ask_note: "이 노트에 묻기",
    rd_rail: "노트 정보",
    rd_view_graph: "그래프에서 보기",
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
    rd_conn_backs: "백링크",
    rd_conn_sug: "제안",
    rd_conn_added: "## Related 에 [[{name}]] 추가",
    rd_auth_show: "작성자 표시 켜기",
    rd_auth_hide: "작성자 표시 끄기",
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
    sl_h4: "제목 4",
    sl_bullet: "글머리 기호 목록",
    sl_numbered: "번호 목록",
    sl_todo: "할 일",
    sl_code: "코드 블록",
    sl_quote: "인용",
    sl_table: "표",
    sl_divider: "구분선",
    sl_date: "오늘 날짜",
    sl_callout: "콜아웃",
    sl_toggle: "토글 목록",
    sl_link: "노트 링크",
    sl_image: "이미지",
    sl_embed: "노트 임베드",
    sl_sec_basic: "기본 블록",
    sl_sec_media: "미디어",
    sl_sec_records: "기록",
    sl_sec_advanced: "고급",
    sl_sec_templates: "템플릿",
    sl_sec_plugins: "플러그인",
    pl_renderer_missing: "이 버전에는 {renderer} 렌더러가 없어 코드로 표시합니다.",
    sl_no_results: "결과 없음",
    sl_text: "텍스트",
    bm_search: "블록 작업 검색…",
    bm_turn_into: "전환",
    bm_actions: "작업",
    bm_duplicate: "복제",
    bm_delete: "삭제",
    bm_move_up: "위로 이동",
    bm_move_down: "아래로 이동",
    bm_ask: "이 블록으로 질문하기",
    bm_handle: "블록 메뉴",
    bm_indent: "들여쓰기",
    bm_outdent: "내어쓰기",
    tb_label: "편집 도구",
    tb_undo: "되돌리기",
    tb_wikilink: "노트 연결",
    tb_tag: "태그",
    tb_todo: "할 일",
    tb_heading: "제목",
    tb_add: "블록 추가",
    tb_hide: "키보드 내리기",
    tb_bold: "굵게",
    tb_italic: "기울임",
    tb_highlight: "형광펜",
    tb_code: "코드",
    tb_link: "링크로 만들기",
    tbl_col_ph: "열 {n}",
    tbl_add_row: "행 추가",
    tbl_add_col: "열 추가",
    tbl_row_menu: "행 메뉴",
    tbl_col_menu: "열 메뉴",
    tbl_menu: "표 메뉴",
    tbl_row_above: "위에 행 추가",
    tbl_row_below: "아래에 행 추가",
    tbl_col_left: "왼쪽에 열 추가",
    tbl_col_right: "오른쪽에 열 추가",
    tbl_row_delete: "행 삭제",
    tbl_col_delete: "열 삭제",
    tbl_align: "정렬",
    tbl_align_left: "왼쪽",
    tbl_align_center: "가운데",
    tbl_align_right: "오른쪽",
    fb_edit: "편집",
    fb_delete: "삭제",
    fb_done: "완료",
    fb_panel: "{name} 편집",
    fb_text: "내용",
    mm_f_code: "다이어그램 코드",
    mt_f_tex: "수식 (TeX)",
    ch_f_type: "종류",
    ch_f_bar: "막대",
    ch_f_line: "선",
    ch_f_pie: "원",
    ch_f_title: "제목",
    ch_f_data: "데이터",
    ch_f_from_table: "이 노트의 표",
    ch_f_inline: "직접 입력",
    ch_f_table: "표",
    ch_f_pick: "표를 고르세요",
    ch_f_new_table: "새 표 만들기",
    ch_f_missing: "이 노트에 없는 표",
    ch_f_table_n: "표 {n}",
    ch_f_layout: "방향",
    ch_f_columns: "열",
    ch_f_rows: "행",
    ch_f_labels: "항목",
    ch_f_series: "계열 {n}",
    ch_f_values: "값",
    ch_f_add_series: "계열 추가",
    ch_f_remove_series: "계열 {n} 삭제",
    qb_f_path: "폴더",
    qb_f_tag: "태그",
    qb_f_type: "종류",
    qb_f_sort: "정렬",
    qb_f_limit: "개수",
    qb_f_advanced: "고급",
    qb_f_line: "쿼리",
    qb_sort_default: "기본 (이름순)",
    qb_sort_name: "이름순",
    qb_sort_name_desc: "이름 역순",
    qb_sort_modified: "최근 수정순",
    qb_sort_modified_asc: "오래된 수정순",
    qb_sort_links: "링크 많은 순",
    qb_sort_sources: "출처 많은 순",
    qb_sort_type: "종류순",
    ins_link: "커서 위치에 링크 넣기",
    ins_quote: "커서 위치에 인용 넣기",
    sl_in_notes: "노트 내용에서",
    sl_onthisday: "오늘의 과거",
    sl_toc: "목차",
    sl_chart: "차트",
    ch_sample_title: "예시 차트",
    sl_mermaid: "다이어그램",
    mm_sample:
      "flowchart LR\n  A[아이디어] --> B{남길 만한가?}\n  B -->|예| C[노트로 쓰기]\n  B -->|아니요| D[흘려보내기]",
    sl_math: "수식",
    otd_title: "지난 해의 {date}",
    otd_all: "{n}개 모두 링크로 넣기",
    otd_none: "지난 해의 {date} 일간 노트가 없습니다.",
    otd_keys: "↵ 넣기 · esc 닫기",
    sl_query: "쿼리",
    sl_onthisday_query: "과거의 오늘 쿼리",
    sl_hint_recall: "지난 노트를 찾아 그 내용을 한 번 넣어요",
    sl_hint_query: "정한 조건에 맞는 노트 목록을 두고 늘 새로 보여 줘요",
    sl_hint_onthisday: "지난해 오늘 쓴 노트를 골라 한 번 넣어요",
    sl_hint_onthisday_query: "지난해 오늘 쓴 노트 목록을 두고 늘 새로 보여 줘요",
    qb_hint: '쿼리를 입력하세요: "문구", tag:, type:, status:, confidence:, path:, sort:, limit:, view:',
    qb_loading: "쿼리 실행 중…",
    qb_empty: "이 쿼리에 맞는 페이지가 없습니다.",
    qb_failed: "쿼리를 실행하지 못했습니다: {error}",
    qb_bad: "알 수 없는 옵션: {token}",
    qb_bake: "링크로 저장",
    qb_bake_title: "지금 결과를 링크 목록으로 노트에 씁니다 (이전에 저장한 목록은 교체)",
    qb_col_name: "이름",
    qb_col_type: "유형",
    qb_col_status: "상태",
    qb_col_updated: "수정일",
    qb_untyped: "유형 없음",
    sl_recall: "기록 찾기",
    rc_title: "지난 기록에서 인용",
    rc_search: "지난 기록 찾기… 예: 지난주 결정",
    rc_hint: "기억나는 내용을 적으세요 — 원문 그대로, 출처와 함께 인용합니다.",
    rc_none: "이 내용과 충분히 가까운 기록이 없어요.",
    rc_stale: "검색 색인이 오래됐습니다 — 모델 설정에서 다시 색인하세요.",
    rc_failed: "검색 색인에 연결하지 못했습니다.",
    rc_no_index: "아직 검색 색인이 없습니다 — 설정에서 시맨틱 검색을 켜세요.",
    rc_range: "{start} – {end} 기간",
    rc_embed: "임베드로 넣기 (![[…]])",
    rc_keys: "↵ 인용 · ⌘↵ 임베드 · tab 범위 · esc 닫기",
    sl_ask: "볼트에 질문",
    rc_ask: "질문을 입력…",
    rc_ask_title: "노트에 질문",
    rc_ask_hint:
      "질문을 적고 Enter — 답은 노트의 원문 그대로, 출처와 함께 콜아웃으로 들어갑니다.",
    rc_ask_keys: "↵ 질문 / 넣기 · ↑↓ 스크롤 · tab 범위 · esc 닫기",
    rc_ask_ready: "Enter로 넣기",
    editor_insert_wait:
      "노트를 아직 준비 중입니다. 내용을 넣지 않았어요. 잠시 후 다시 시도해 주세요.",
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
    props_complex: "복합 값 — 원문에서 편집하세요",
    props_tags_ph: "태그 추가…",
    props_tag_remove: "태그 제거",
    st_title: "학습",
    st_lede:
      "읽은 노트에서 문장을 골라 카드로 만들고, 잊을 때쯤 다시 보여 줘요.",
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
    st_load_failed: "학습 카드를 불러오지 못했어요.",
    ing_auto_failed: "대기 중인 자료를 처리하지 못했어요.",
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
    st_quiz_none: "퀴즈를 만들 빈칸 카드가 부족해요. 문제마다 빈칸 용어와 고를 수 있는 다른 용어 두 개가 필요해요. 굵은 글씨나 위키링크가 있는 노트에서 카드를 만들어 보세요.",
    st_ungrounded: "근거 없는 카드 {n}장",
    st_ungrounded_hint: "출처 노트가 없거나, 답이 그 노트에 없는 카드입니다.",
    st_archive: "보관하기",
    st_archive_hint: "덱을 cards/archive/로 옮깁니다. 다시 옮기면 복원됩니다.",
    st_archived: "{name} 덱을 cards/archive/로 옮겼어요",
    st_archive_failed: "덱을 보관하지 못했어요",
    st_gen_quiz: "퀴즈 생성",
    st_generating: "생성 중…",
    st_quiz_done: "퀴즈 완료",
    st_quiz_score: "점수: {score} / {total}",
    st_correct: "정답",
    st_wrong: "오답",
    st_next: "다음",
    st_def_front: "{title}의 핵심은 무엇인가요?",
    st_section_front: "{title} › {heading}",
    st_today_title: "오늘 복습",
    st_grade_forgot: "기억 안 남",
    st_grade_remembered: "기억남",
    st_next_review: "다음 복습: {when} {n}장",
    st_keys_hint: "Space를 누르면 정답을 보고, 숫자 1–{n}로 평가해요.",
    st_save_failed: "복습 결과를 저장하지 못했어요",
    st_deck_save_failed: "학습 카드를 저장하지 못했어요",
    st_deck_read_failed: "덱을 읽지 못했어요. 다시 열거나 재시도해 주세요.",
    st_deck_changed: "덱이나 볼트가 바뀌었어요. 덱을 다시 연 뒤 저장해 주세요.",
    st_deck_partial: "파일이 이미 저장됐을 수 있지만 결과를 확인하지 못했어요. 덱을 확인한 뒤 다시 시도해 주세요.",
    s_study_lede: "카드 만들기와 퀴즈가 노트로 학습 자료를 만드는 방식입니다.",
    s_ai_cards_title: "AI로 카드 만들기 (실험적)",
    s_ai_cards_desc: "끄면 모델 없이 노트의 문장을 그대로 옮겨 카드와 퀴즈를 만듭니다. 켜면 연결된 채팅 모델이 더 만들고, 답이 노트에 그대로 없는 것은 버립니다.",
    s_ai_cards_needs: "연결된 채팅 모델이 필요합니다 (설정 → 모델). 그 전까지는 노트 문장으로만 카드를 만듭니다.",
    s_fine_grades_title: "세밀하게 평가",
    s_fine_grades_desc: "켜면 복습 카드를 다시, 어려움, 보통, 쉬움 네 단계로 평가해요. 끄면 기억 안 남과 기억남 두 버튼으로 평가해요.",
    s_plugins: "플러그인",
    s_plugins_lede: "이 볼트의 .myco/plugins/ 폴더에 있는 플러그인입니다. 플러그인은 / 메뉴 항목을 더하고 myco에 내장된 코드 블록 렌더러를 씁니다. main.js가 있는 플러그인은 자기 코드를 샌드박스에서 실행하며, 그 코드가 요청하는 호출을 허용해야만 켜집니다. 이 코드는 파일을 쓰거나 raw/를 읽을 수 없고, 앱의 보안 정책(CSP)에 따라 앱 자체의 파일과 이 컴퓨터의 Ollama 서버(localhost:11434) 말고는 네트워크에 닿지 못합니다.",
    pl_trust_title: "볼트 신뢰",
    pl_trust_desc: "이 볼트를 신뢰하기 전에는 볼트의 플러그인이 모두 꺼져 있습니다. 이 기기에만 적용되며 언제든 되돌릴 수 있습니다.",
    pl_trust_btn: "이 볼트의 플러그인 신뢰",
    pl_trusted: "이 기기에서 이 볼트의 플러그인을 신뢰하고 있습니다.",
    pl_untrust_btn: "신뢰 해제",
    pl_installed: "설치된 플러그인",
    pl_reload: "다시 읽기",
    pl_loading: "플러그인을 읽는 중…",
    pl_empty: ".myco/plugins/에 아직 플러그인이 없습니다. 플러그인은 그 안에 manifest.json 하나가 든 폴더입니다.",
    pl_no_vault: "볼트를 열면 그 볼트의 플러그인이 보입니다.",
    pl_load_failed: "플러그인을 읽지 못했습니다: {error}",
    pl_enable: "{name} 사용",
    pl_off_until_trusted: "볼트를 신뢰할 때까지 꺼짐",
    pl_slash_items: "/ 항목",
    pl_fences: "코드 블록",
    pl_renderer_absent: "이 버전에 없음",
    pl_fence_builtin: "무시됨: myco 기본 블록",
    pl_fence_taken: "무시됨: {id}에서 사용 중",
    pl_invalid: "불러오지 않음",
    pl_load_one_failed: "이 플러그인을 불러오지 못했어요.",
    pl_details: "자세히",
    pl_err_missing: "이 폴더에 manifest.json이 없습니다.",
    pl_err_outside: "이 플러그인은 .myco/plugins/ 밖을 가리키는 링크라서 읽지 않았습니다.",
    pl_err_too_large: "manifest.json이 64KB보다 큽니다.",
    pl_err_unreadable: "manifest.json을 텍스트로 읽을 수 없습니다.",
    pl_err_json: "manifest.json이 JSON 객체가 아닙니다.",
    pl_err_field: "{field} 값이 없거나 올바르지 않습니다.",
    pl_err_id: "id \"{value}\"는 폴더 이름과 같아야 하며 영문 소문자, 숫자, . _ -만 쓸 수 있습니다.",
    pl_err_renderer: "{field} 값 \"{value}\"는 렌더러가 아닙니다. {renderers} 중 하나를 쓰세요.",
    pl_err_slash: "{field}에는 template, fence, command 중 하나만 있어야 합니다.",
    pl_err_permission: "{field} 값 \"{value}\"는 myco가 허용하는 호출이 아닙니다. {calls} 중에서 고르세요.",
    pl_code: "자기 코드(main.js)를 샌드박스에서 실행",
    pl_calls: "호출",
    pl_calls_none: "없음",
    pl_ask_title: "{name}의 코드를 실행할까요?",
    pl_ask_desc: "main.js는 파일과 떨어진 샌드박스에서 실행되어 아무것도 쓸 수 없고 wiki/ 아래 페이지만 읽습니다. 이 플러그인의 / 명령이 실행되는 동안 할 수 있는 일은 다음과 같습니다.",
    pl_ask_nothing: "그 밖에는 아무것도 할 수 없습니다. 요청한 호출이 없습니다.",
    pl_allow: "허용하고 켜기",
    pl_revoke_hint: "끄면 이 호출 권한을 거둬들이고, 다시 켜면 다시 묻습니다.",
    pl_sc_insert: "커서 자리에 글 넣기",
    pl_sc_replace: "선택한 글 바꾸기",
    pl_sc_selection: "선택한 글과 커서가 있는 줄 읽기",
    pl_sc_read: "wiki/ 아래 페이지 읽기",
    pl_sc_recall: "노트를 의미로 찾기",
    pl_sc_search: "노트 본문에서 찾기",
    pl_sc_notify: "알림 띄우기",
    pl_run_timeout: "{name} 플러그인이 {seconds}초 넘게 실행되어 멈췄습니다.",
    pl_run_failed: "{name} 플러그인이 명령을 끝내지 못했습니다",
    pl_run_stopped: "{name} 플러그인이 연속 {count}번 실패해 멈췄습니다. 다시 쓰려면 설정 → 플러그인에서 껐다가 켜세요.",
    pl_run_busy: "{name} 플러그인이 아직 이전 명령을 실행하고 있습니다.",
    pl_run_calls: "{name} 플러그인이 명령 한 번에 {count}번 넘게 호출해 멈췄습니다.",
    pl_run_no_main: "{name} 플러그인의 main.js를 읽지 못했습니다",
    rd_cards_ai_failed: "AI 카드를 만들지 못했어요",
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
      "현재 Agent 선택({provider})의 도구 실행기는 검증되지 않았습니다. 모델 설정에서 확인하세요. 외부 모델은 선택 사항입니다.",
    ag_open_providers: "모델 설정 열기",
    rd_audio: "오디오 개요",
    au_title: "오디오 개요",
    au_close: "닫기",
    au_generating: "대화 작성 중…",
    au_needs_provider:
      "설정 → 모델에서 지원되는 오디오 모델을 선택하세요. 로컬 모델이 기본이며 외부 모델은 선택 사항입니다.",
    au_source_failed: "선택한 저장 노트를 사용할 수 없습니다. 노트와 오디오 모델 설정을 확인한 뒤 다시 시도하세요.",
    au_generation_failed: "선택한 오디오 모델이 올바른 대화를 만들지 못했습니다. 모델 설정을 확인한 뒤 다시 시도하세요.",
    au_publication_failed: "대본 저장을 확인하지 못했습니다. 선택한 노트와 기존 오디오 파일을 확인한 뒤 다시 시도하세요.",
    au_publication_partial: "저장이 완료되지 않았습니다. 초안과 {path} 파일은 보존했습니다. 파일을 확인한 뒤 다시 시도하세요.",
    au_cancel_failed: "오디오 취소를 확인하지 못했습니다. 현재 작업을 확인한 뒤 다시 시도하세요.",
    au_stop_generation: "생성 중지",
    au_stopped: "오디오 생성 중지를 요청했습니다.",
    bf_title: "지난 대화 모아 넣기",
    bf_desc: "코딩 세션이 아카이브에만 쌓이고 위키가 되지 못했습니다. 한 묶음씩 자료 추가 대기열에 올리면 평소 파이프라인이 인용된 노트로 만듭니다.",
    bf_waiting: "대기",
    bf_done: "위키화됨",
    bf_skipped: "너무 짧음",
    bf_held: "너무 큼",
    bf_promote: "다음 {n}개 올리기",
    bf_promoted: "세션 {n}개를 자료 추가 대기열에 올렸습니다",
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
    s_distill: "자동 정리",
    set_distill_loading: "불러오는 중…",
    set_distill_lede:
      "새로 들어온 노트가 볼트와 얼마나 맞는지 주기적으로 점수를 매기고, 사람이 쓰지 않은 세션은 격리해 두고, 세션 요약을 쓰고, 요약이 끝난 세션은 보관해요. raw/ 안의 원본은 절대 바꾸지 않아요.",
    set_distill_enabled_title: "자동 정리",
    set_distill_enabled_desc:
      "myco가 열려 있을 때 아래 '유휴 시간'만큼 아무 조작이 없고 쌓인 항목이 '백로그 개수 트리거' 이상이면 저절로 정리해요. 한 시간에 한 번까지만 돌아요. 자동이든 직접 누르든, 정리는 raw/ 폴더를 건드리지 않아요.",
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
      "실행당 LLM 항목 예산 (자료 추가 + 지도 초안 합산)",
    set_distill_profile_injection_title: "프로필 주입",
    set_distill_profile_injection_desc:
      "profile.md를 Ask/자료 추가 컨텍스트로 설정된 AI 프로바이더에 전송합니다. 끄면 프로필은 로컬에만 남습니다.",
    set_distill_status_title: "상태",
    set_distill_backlog: "백로그: {n}",
    set_distill_pending: "대기 중인 제안 {n}건",
    set_distill_trend_shrinking: "줄어드는 중",
    set_distill_trend_growing: "늘어나는 중",
    set_distill_trend_flat: "변화 없음",
    set_distill_run_now: "지금 정리",
    set_distill_running: "정리 중…",
    set_distill_report: "폐기 {tr}건, 제안 {p}건 — 백로그 {b}건",
    set_distill_busy: "이미 정리나 인박스 자료 자동 추가가 진행 중입니다.",
    set_distill_undo: "이 실행 되돌리기",
    set_distill_undoing: "되돌리는 중…",
    set_distill_undo_result: "{n}건 되돌림",
    set_runs_title: "지난 실행",
    set_distill_gate_pending: "정리 대기: 위키 페이지 {n}/{min}",
    set_distill_digest_extractive:
      "세션 다이제스트를 추출 방식으로 실행했습니다 (LLM 없이 인용 발췌). 요약 다이제스트를 원하면 설정 → 모델(쿼리)에서 프로바이더를 연결하세요.",
    set_distill_quarantined: "{path}에 검토 대기 중인 항목 {n}건",
    set_distill_stop: "중지",
    set_distill_stopping: "현재 단계 후 중지…",
    set_distill_stopped: "{step} 후 중지됨",
    set_distill_step_run: "코어 패스",
    set_distill_step_digest: "세션 다이제스트",
    set_distill_step_ingest: "전체 계층 자료 추가",
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
    set_archive_failed: "완료하지 못한 버킷 · 남아 있는 사본 보존: {list}",
    set_archive_restore: "복원",
    set_archive_restoring: "복원 중…",
    set_archive_restored: "{bucket}에 파일 {n}개 복원",
    set_profile_title: "프로필",
    set_profile_lede:
      "정리와 Ask/자료 추가 컨텍스트를 개인화합니다. profile.md에 저장되며, 주입이 켜져 있으면 설정된 AI 프로바이더로 전송됩니다.",
    set_profile_role: "역할",
    set_profile_goals: "목표 (줄바꿈으로 구분)",
    set_profile_interests: "관심사 (줄바꿈으로 구분)",
    set_profile_style: "작업 스타일",
    set_profile_save: "저장",
    set_profile_saving: "저장 중…",
    set_profile_saved: "저장됨",
    nav_feedback: "정리 제안",
    ov_distill_last_run: "마지막 실행 {t}",
    ov_distill_never: "아직 실행 기록 없음",
    ov_distill_llm_queued:
      "정리 작업이 대기 중입니다. 선택한 모델의 상태를 확인한 뒤 다시 시도해 주세요.",
    ov_distill_done:
      "정리 완료 — 다이제스트 {d}일 · 주간 롤업 {w}건 · 제안 {p}건",
    ov_distill_done_months: " · 월간 롤업 {m}건",
    ov_distill_done_none: "정리 완료 — 처리할 항목 없음",
    pf_title: "수확함",
    pf_lede:
      "자동 정리가 남긴 제안이에요. 새로 모인 노트를 주제로 받아들이거나, 필요 없어진 자료를 삭제하거나, 주제 지도를 만들자는 내용이에요. 살펴보고 승인하거나 무시하세요.",
    pf_empty: "대기 중인 제안이 없습니다.",
    pf_kind_admit: "클러스터 수용",
    pf_kind_archive: "일괄 보관",
    pf_kind_delete: "일괄 삭제",
    pf_kind_draft_map: "토픽 맵 작성",
    pf_created: "생성",
    pf_expand: "내용 보기",
    pf_collapse: "접기",
    pf_approve: "승인",
    pf_dismiss: "무시",
    pf_confirm_title: "이 제안을 적용할까요?",
    pf_outcome_admit: "격리된 자료 {n}개를 볼트로 되돌립니다.",
    pf_retired: "더 이상 필요 없어요 — 원본은 그대로 둡니다",
    pf_outcome_delete: "격리된 자료 {n}개를 휴지통으로 옮깁니다.",
    pf_confirm_msg_draft_map: "주제 지도 초안을 씁니다 (모델을 한 번 씁니다).",
    pf_retry: "재시도",
    pf_apply_failed: "적용 실패 — 재시도",
    pf_map_needs_writer: "주제 지도를 쓰려면 글을 쓰는 모델이 필요해요",
    pf_tab_proposals: "제안",
    pf_tab_quarantine: "격리 {n}",
    qz_empty: "격리된 항목이 없습니다.",
    qz_lede:
      "자동 정리가 따로 떼어 둔 항목이에요. 사람이 쓰지 않은 세션과 주제에서 벗어났다고 본 항목이 여기 모여요. 지운 게 아니라 보관 중이니, 필요한 것은 되돌리고 아닌 것은 버리세요.",
    qz_verdict_offtopic: "주제 불일치: {numbers}",
    qz_verdict_sim: "유사도 {sim}",
    qz_verdict_sim_vs: "유사도 {sim} · 기준 {min}",
    qz_verdict_nearest: "(가장 가까운 주제: {topic})",
    qz_verdict_unknown: "이 항목에는 판정 기록이 없습니다.",
    qz_expires_in: "{n}일 남음",
    qz_expires_due: "기한 만료 — 다음 실행에서 휴지통으로 옮겨질 수 있습니다",
    qz_expires_due_ask: "기한 만료 — 다음 실행 때 지우기 전에 제안 탭에서 먼저 묻습니다",
    qz_expires_unknown: "만료 기한 기록 없음",
    qz_restore: "볼트로 복원",
    qz_delete: "삭제",
    qz_keep: "{n}일 더 보관",
    qz_confirm_delete_title: "이 항목을 삭제할까요?",
    qz_confirm_delete_msg:
      "{name}을(를) 시스템 휴지통으로 옮깁니다(복구 가능).",
    qz_group_myco: "myco가 모델을 부른 기록",
    qz_group_agent: "에이전트 작업 프롬프트",
    qz_group_hello: "연결 테스트",
    qz_group_empty: "빈 세션",
    qz_group_other: "그 밖의 항목",
    qz_restore_all: "모두 되돌리기",
    qz_trash_all: "모두 버리기",
    qz_confirm_restore_all_title: "{n}개를 모두 되돌릴까요?",
    qz_confirm_restore_all_msg:
      "‘{group}’에 있는 항목을 원래 있던 자리로 돌려놓아요. 되돌린 항목은 다시 격리하지 않아요.",
    qz_confirm_trash_all_title: "{n}개를 모두 버릴까요?",
    qz_confirm_trash_all_msg:
      "‘{group}’에 있는 항목을 시스템 휴지통으로 옮겨요. 휴지통에서 다시 꺼낼 수 있어요.",
    tb_activity_quarantine: "검토 대기 {n}건",
    tb_activity_gone: "그 항목은 이미 처리되어 사라졌습니다.",
    ing_title_label: "제목",
    ing_title_ph: "예: 오늘 읽은 기사",
    ing_working: "작업 중…",
    ingest_no_changes:
      "경고: 모델이 작업을 마쳤지만 위키 페이지가 생성되거나 수정되지 않았습니다. 원본은 raw/{slug}.md에 저장되었지만 위키에는 반영되지 않았습니다. 위 모델 출력을 확인하거나 Claude Code(CLI) 제공자를 사용해 보세요.",
    ingest_validation_failed:
      "자료 추가 검증 실패 — 다음 문제를 해결해야 이 자료를 추가할 수 있습니다:",
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
    hq_ex_already_harvested_why: "복사본이 이미 자료 추가를 거쳤습니다.",
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
      "복사본의 근거를 배치로 이어서 처리하고 위키에 연결",
    hq_plan_cites: "인용 {base} → {goal} (예상, +{n})",
    hq_plan_note:
      "패스는 소비한 복사본을 보관 처리합니다. sessions/에는 쓰지 않습니다.",
    hq_plan_cancel: "취소",
    hq_plan_run: "실행",
    hq_plan_running: "실행 중 — {total}개 중 {done}개 완료",
    hq_done_title: "{n}개 수확 완료",
    hq_done_sub: "인용 {base} → {goal}",
    hq_done_partial:
      "처리 대상 {copied}개 · {ingested}개 완료 — 나머지는 _inbox/에서 대기",
    hq_failed: "수확 실패",
    hq_empty_title: "승격 대상이 남지 않았습니다",
    hq_empty_body:
      "서로 다른 본문 {distinct}개 중 지금 승격할 것이 없습니다. 보류(200 KB 초과) 세션과 8 KB를 넘는 새 대화는 다시 이 큐로 들어옵니다.",
    hq_empty_cta: "자료 추가하기",
    hq_loading: "sessions/ 훑는 중…",
    hq_error: "세션 아카이브를 읽지 못했습니다",
    hq_retry: "다시 시도",
    hq_read_partial: "일부 세션을 확인하지 못했습니다. 수치는 확인된 최소값입니다. 남은 파일을 확인하려면 다시 시도해 주세요.",
    hq_read_lower_bound: "최소 {n}",
    hq_mini_line: "남은 후보 {left}개 · 지금까지 {done}개 수확",
    hq_mini_fold: "수확대 접기",
    ing_refused_title: "내용이 없어 저장하지 않았습니다 · {reason}",
    ing_logged_title: "원본만 보관했습니다 · {reason}",
    ing_noop_reason: "계획의 모든 항목이 이미 위키에 있어요",
    ing_raw_reused: "같은 내용이 이미 {path}에 있어서 새로 저장하지 않았어요.",
    ing_raw_name_shared:
      "같은 내용이 이미 {path}에 있는데, 다른 원본도 같은 이름이라 요약을 만들면 그쪽 요약을 덮어써요",
    ing_dec_update: "고침",
    ing_dec_add: "새로 만듦",
    ing_dec_merge: "합침",
    ing_dec_noop: "이미 있음",
    ing_gate_none_reason: "계획에서 고른 항목이 없어요",
    sv_rail_label: "파이프라인 진행 상태",
    sv_state_reading: "읽는 중",
    sv_state_choosing: "고를 차례",
    sv_state_done: "끝",
    sv_details: "세부 정보",
    sv_step_intake: "유입",
    sv_step_judge: "판정",
    sv_step_gate: "계획",
    sv_step_run: "실행",
    sv_step_backfill: "대기 자료",
    sv_today_n: "오늘 {n}건",
    sv_tally: "버림 {d} · 기록 {l} · 수확 {h}",
    sv_waiting: "대기 중",
    sv_reviewing: "검토 중",
    sv_idle: "유휴",
    sv_running: "실행 중",
    sv_done: "완료",
    sv_failed: "실패",
    sv_cancelled: "취소됨",
    sv_nothing_added: "추가한 노트 없음",
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
    sv_harvest_sub: "계획 검토로",
    sv_dz_sub:
      "이 창 어디에나 텍스트·마크다운 파일을 놓으세요 — 판정 뒤에야 파일이 생성됩니다.",
    sv_verdicts_title: "판정 결과",
    sv_verdicts_empty:
      "이번 세션에서 판정한 항목이 없습니다 — 위에 파일을 놓거나 텍스트를 붙여넣으세요.",
    sv_out_drop: "파일 0개 · 모델 0회",
    sv_out_noop: "파일 0개 · 모델 1회",
    sv_out_log: "raw/ 1개 · 위키 0개",
    sv_out_harvest: "추가됨",
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
    sv_bf_eyebrow: "5 · 대기 자료 — 이 화면에서 가장 큰 미개봉 입력",
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
      "E5로 로컬 검색합니다. 선택 설치한 Qwen 모델을 사용하면 이 Mac에서 찾은 원문을 종합하며, 그 외에는 원문을 인용합니다.",
    q_builtin_extractive_note:
      "답변은 일치하는 원문을 인용합니다. 로컬에서 종합한 답변은 모델 설정에서 Qwen을 설치하고 선택하세요.",
    q_open_model_settings: "모델 설정",
    q_stale_index:
      "이 답변은 검색 인덱스 대신 전체 볼트를 사용했습니다 — 모델 업데이트 이후 인덱스가 오래되었습니다.",
    q_retrieval_failed:
      "검색 인덱스에 접근할 수 없어, 이 답변은 의미 검색을 건너뛰고 볼트를 직접 읽어 작성했습니다. 계속 반복되면 모델 설정에서 ‘지금 재인덱스’를 실행해 보세요.",
    q_extractive_label: "내 노트에서 찾음 (상위 일치 원문)",
    q_extractive_empty:
      "위키 인덱스에서 관련 내용을 찾지 못했습니다. 질문을 바꿔 보거나, 모델 설정에서 “지금 재인덱스”를 실행해 보세요.",
    q_extractive_stale:
      "의미 검색 인덱스가 모델 업데이트 이전에 만들어졌고, 키워드 검색에서도 확인된 구절을 찾지 못했습니다. 모델 설정에서 “지금 재인덱스”를 실행한 뒤 다시 질문해 주세요.",
    q_extractive_failed:
      "검색 인덱스에 접근할 수 없어 관련 구절을 가져오지 못했습니다. 계속되면 모델 설정에서 “지금 재인덱스”를 실행해 주세요.",
    q_source_changed:
      "원문이 바뀌었거나 확인할 수 없어 답변을 중단했어요. 다시 시도하여 현재 노트를 검색해 주세요.",
    q_model_selection_changed: "선택한 모델이나 실행 권한이 바뀌어 답변을 중단했어요. 모델 선택을 확인하고 다시 시도해 주세요.",
    q_activity_failed: "로컬 모델이 기간을 정하거나 활동 정리를 끝내지 못했어요. 선택한 대화 모델이 준비되어 있는지 확인하고 다시 시도해 주세요.",
    q_activity_incomplete: "선택한 기간의 기록을 모두 확인하지 못했어요. 같은 범위와 기간으로 다시 시도해 주세요.",
    q_activity_summary_failed: "선택한 기간의 기록을 찾았지만 활동 정리를 끝내지 못했어요. 같은 기간으로 다시 시도해 주세요.",
    q_answer_review_failed: "답변을 원문과 대조해 통과시키지 못했어요. 다시 시도하거나 질문 범위를 좁혀 주세요.",
    q_activity_insufficient_evidence: "기록은 찾았지만 질문을 뒷받침할 활동을 충분히 확인하지 못했어요. 범위와 기간을 확인하거나 다시 시도해 주세요.",
    q_activity_coverage: "검색한 페이지 {scanned}개 · 인용 페이지 {sources}개",
    q_activity_limited: "선택된 기록을 정리한 답변이라 일부 활동이 빠질 수 있어요.",
    q_local_fallback_timeout:
      "로컬 답변이 시간 안에 준비되지 않았어요. 아래에는 검색된 원문을 그대로 인용했습니다.",
    q_local_fallback_unavailable:
      "선택한 로컬 모델을 사용할 수 없어 답변을 작성하지 못했어요. 아래에는 검색된 원문을 그대로 인용했습니다.",
    q_local_fallback_prompt:
      "찾은 원문으로 로컬 답변을 준비하지 못했어요. 아래에는 검색된 원문을 그대로 인용했습니다.",
    q_local_fallback_rejected:
      "로컬 답변이 검증을 통과하지 못했어요. 아래에는 검색된 원문을 그대로 인용했습니다.",
    q_local_fallback_incomplete:
      "로컬 답변을 끝까지 작성하지 못했어요. 아래에는 검색된 원문을 그대로 인용했습니다.",
    q_local_fallback_failed:
      "로컬 답변을 작성하지 못했어요. 아래에는 검색된 원문을 그대로 인용했습니다.",
    q_range_chip: "기간: {s} – {e}",
    q_range_empty: "그 기간의 노트에서 이 내용을 찾지 못했어요",
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
    q_miss_done: "기록됨",
    q_miss_failed: "이 질문을 기록하지 못했습니다",
    q_quote_to_note: "노트에 인용",
    q_copy_answer: "답변 복사",
    q_copied: "복사됨",
    q_copy_failed: "클립보드에 복사하지 못했습니다",
    q_quote_pick_note: "인용을 붙일 노트를 고르세요",
    q_back_to_ask: "질문으로",
    q_followup_chip: "이전 질문 이어서",
    // Ask renewal (mockup "Strata").
    q_scope_label: "검색 범위",
    q_scope_wiki: "내 노트",
    q_scope_sessions: "대화 기록",
    q_scope_all: "모든 자료",
    q_scope_wiki_hint: "정리된 노트와 맵, 일일 요약에서 찾아요",
    q_scope_sessions_hint: "AI 도구와 나눈 대화에서 찾아요",
    q_scope_all_hint: "내 노트와 대화 기록을 함께 찾아요",
    q_scope_chip: "범위 · {scope}",
    q_note_scope_chip: "이 노트 · {note}",
    q_note_scope_hint: "이 노트와 바로 이어진 노트에서만 찾아요",
    q_note_scope_clear: "이 노트에만 묻기 그만두기",
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
    q_more_passages: "구절 더 보기({n})",
    q_fewer_passages: "구절 접기",
    q_jump_to_question: "이어서 묻기",
    q_ladder_count: "{n}개 · 인용 {c}개",
    q_ladder_all: "출처 {n}개 모두 보기",
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
    q_abstain_title: "내 노트에서 이 내용을 찾지 못했어요",
    q_abstain_sub: "비슷한 노트는 있었지만 답이 될 만큼 가깝지 않았어요",
    q_abstain_sub_none: "이 질문과 닮은 노트가 아직 없어요",
    q_abstain_details: "자세히",
    q_abstain_numbers:
      "색인된 {n}쪽 가운데 관련도 바닥선 {floor}에 닿은 구절이 없어요. 그럴듯한 문장을 지어내지 않고 여기서 멈췄어요.",
    q_abstain_range_numbers:
      "{s} – {e} 사이의 기록 가운데 관련도 바닥선 {floor}에 닿은 구절이 없어요. 그럴듯한 문장을 지어내지 않고 여기서 멈췄어요.",
    q_abstain_note: "이 질문을 오늘의 노트에 적어 두기",
    q_abstain_noted: "오늘의 노트에 적어 두었어요",
    q_abstain_note_line: "질문: {q}",
    q_abstain_near: "가장 가까웠던 것들 — 답이 될 만큼 가깝지는 않았어요",
    q_abstain_none: "어휘·의미 어느 쪽도 아무것도 가져오지 못했습니다.",
    q_abstain_lexical: "키워드만",
    q_abstain_gauge_note:
      "붉은 눈금이 바닥선 {floor}입니다. “키워드만”은 코사인이 없는 어휘 전용 히트로, 단독으로는 근거가 되지 못합니다.",
    q_abstain_floor_tick: "바닥선 {floor}",
    q_abstain_harvest: "나중에 채울 질문으로 표시",
    q_abstain_harvested: "나중에 채울 질문으로 표시했어요",
    q_abstain_widen: "범위 넓혀 다시 찾기",
    q_abstain_range_sub: "{s} – {e} 사이의 노트에는 답이 될 만큼 가까운 구절이 없었어요",
    q_abstain_widen_range: "기간 없이 다시 찾기",
    q_abstain_receipt: "나중에 채울 질문 목록에 남겼어요",
    q_history: "기록",
    q_history_search: "지난 질문 찾기",
    q_history_none: "맞는 지난 질문이 없어요.",
    q_history_cited: "노트 {n}개",
    q_history_abstained: "못 찾음",
    q_history_failed: "오류",
    q_history_load_failed: "질문 기록을 읽지 못했어요.",
    q_retry: "다시 시도",
    q_stop: "답 멈추기",
    q_elapsed: "{time} 경과",
    q_stopped: "멈춤",
    q_stopped_sub: "답이 오기 전에 멈췄어요.",
    s_archived_sessions_title: "아카이브된 세션도 검색",
    s_archived_sessions_desc:
      "세션 범위가 sessions/archive/까지 검색합니다 — 색인이 평소 제외하는 냉동 계층입니다. 켜면 다시 색인합니다.",
    sb_new_note: "새 노트",
    sb_new_folder: "새 폴더",
    sb_rename: "이름 바꾸기…",
    sb_today_note: "오늘의 노트",
    sb_new_note_msg: "노트 제목을 정해 주세요.",
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
    sb_row_menu: "{name} 메뉴",
    sb_edited: "{date} 수정",
    sb_n_items: "{n}개 항목",
    delete_policy_wait: "삭제 설정을 불러오거나 저장하는 중입니다. 완료 후 다시 시도하세요.",
    set_delete_title: "삭제 방식",
    set_delete_desc: "myco의 수동 삭제와 자동 정리에 적용됩니다. 원본 보호와 삭제 전 승인이 필요한 항목의 규칙은 유지됩니다.",
    set_delete_trash: "휴지통으로 이동",
    set_delete_permanent: "즉시 영구 삭제",
    set_delete_enable_msg: "앞으로 휴지통을 거치지 않고 삭제합니다. 자동 정리 시 myco가 만든 것으로 확인되는 기존 휴지통 사본도 정리합니다. 삭제한 항목은 휴지통이나 실행 되돌리기로 복원할 수 없습니다. 켤까요?",
    delete_permanent_msg: "항목 {n}개를 영구 삭제합니다. 휴지통에서 복원할 수 없습니다.",
    delete_permanent_one_msg: "“{name}”을(를) 영구 삭제합니다. 휴지통에서 복원할 수 없습니다.",
    qz_expires_due_permanent: "기한 지남 — 다음 정리 때 영구 삭제될 수 있습니다",
    deleted_count: "{n}개 영구 삭제",
    delete_undo_limit: "영구 삭제한 파일은 이 실행을 되돌려도 복원할 수 없습니다.",
    sb_delete_msg: "항목 {n}개가 휴지통으로 이동합니다.",
    sb_delete_one_msg: "“{name}”이(가) 휴지통으로 이동합니다.",
    sb_selected: "{n}개 선택",
    sb_clear_selection: "선택 해제",
    sb_new_folder_msg: "폴더 이름",
    sb_rename_msg: "“{name}”의 새 이름:",
    sb_empty_vault: "빈 볼트",
    sb_no_vault: "선택된 볼트가 없습니다",
    sb_managed: "myco가 관리하는 폴더",
    sb_tree: "노트와 폴더",
    sb_managed_hint: "myco가 쓴 노트를 구분하려면 설정에서 볼트 이력을 켜세요.",
    sb_agent_mark: "myco가 씀",
    area_raw: "원본",
    area_sessions: "세션 기록",
    area_cards: "학습 카드",
    area_ingest_reports: "자료 추가 보고서",
    area_work: "정리 후보",
    area_inbox: "추가 대기 자료",
    area_templates: "템플릿",
    area_audio: "음성 녹음",
    area_claude: "에이전트 지침",
    cb_no_results: "결과 없음",
    cb_create_q: "“{q}” 노트 만들기",
    cb_ask_q: "위키에 질문: {q}",
    cb_group_actions: "동작",
    cb_group_recent: "최근",
    cb_group_today: "오늘",
    tabbar_label: "주요 메뉴",
    cb_group_week: "지난 7일",
    cb_group_goto: "이동",
    cb_group_lenses: "렌즈",
    cb_tag_page: "페이지",
    cb_tag_file: "파일",
    cb_tag_note: "노트",
    cb_tag_action: "동작",
    cb_in_contents: "페이지 본문에서",
    cb_semantic: "관련 (의미)",
    cb_exact: "정확 일치",
    cb_operator_hint: "따옴표는 정확 일치 · path: · tag: · type: · status: · confidence:",
    cb_miss_hint:
      "기대한 문서가 없나요? ⌥⏎ 로 이 검색을 평가 세트에 기록합니다.",
    cb_miss_done: "평가 세트에 기록했습니다.",
    cb_placeholder: "노트 찾기 또는 이동",
    cb_key_open: "열기",
    cb_key_miss: "놓친 검색 기록",
    cb_results_n: "{n}건",
    cb_chips_label: "좁혀 찾기",
    cb_chip_tag: "태그",
    cb_chip_folder: "폴더",
    cb_chip_type: "종류",
    sb_tags: "태그",
    sb_tag_chip: "{tag}, 노트 {n}개",
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
    sb_st_lagging: "질문에서 찾지 못하는 노트가 {n}개 있어요",
    sb_st_reindex: "다시 색인",
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
    tb_harvest_running: "수확 중",
    tb_harvest_copying: "원본 복사 중…",
    tb_harvest_done: "수확 완료",
    tb_harvest_error: "수확 실패",
    tb_distill_done: "정리 완료",
    tb_distill_error: "정리 실패",
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
    tb_inflow_header: "오늘 들어온 것",
    tb_inflow_sessions: "세션 수집",
    tb_inflow_last_sweep: "마지막 수집 {t}",
    tb_inflow_sweep_incomplete: "최근 수집 미완료 — 가져오기를 확인해 주세요",
    tb_inflow_sweep_failed: "최근 수집 실패 — 가져오기를 다시 시도해 주세요",
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
    spot_details: "자세히",
    spot_sim: "{stem} · 질문과 {pct} 비슷해요",
    spot_open_ask: "자세한 내용은 myco의 질문 페이지에서 볼 수 있어요.",
    spot_open_ask_btn: "질문 페이지에서 보기",
    spot_no_vault:
      "myco에서 볼트를 먼저 열어주세요 — 아직 질문할 대상이 없습니다.",
    spot_busy: "myco가 이전 질문에 아직 답하고 있습니다.",
    voice_btn_label: "음성 캡처",
    voice_hint_recording: "⏎ 저장 · esc 취소",
    capture_inbox_receipt: "{rel} — 다음 자료 추가 때 함께 처리됩니다",
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
    notif_distill_done_title: "정리 완료",
    notif_distill_done_body:
      "제안 {p}건 · 세션 다이제스트 {d}일치 · 주간 롤업 {w}건",
    notif_distill_done_months: " · 월간 롤업 {m}건",
    notif_quarantine_title: "새 격리 항목",
    notif_quarantine_body:
      "{n}개 항목이 _inbox/quarantine에서 검토를 기다립니다.",
    gr_zoom_out: "축소",
    gr_fit: "맞춤",
    gr_zoom_in: "확대",
    h_open_vault: "히스토리를 보려면 볼트를 여세요.",
    rf_title: "Reflect 제안",
    rf_lede:
      "노트를 고치지 않고 읽기만 해서, 아무 노트도 연결하지 않은 노트, 오래된 노트, 없는 노트로 가는 연결을 알려 드려요.",
    rf_run: "Reflect 실행",
    rf_running: "실행 중…",
    rf_running_label: "Reflect 실행 중…",
    rf_done: "완료 · {time} · 제안 {n}개",
    rf_failed: "Reflect를 실행하지 못했어요.",
    rf_empty: "모두 정리했어요.",
    rf_extractive:
      "내장 모델이 찾은 결과예요. 노트끼리 어떻게 연결됐는지만 보고, 내용은 판단하지 않아요.",
    rf_item_orphan: "{page} — 아무 노트도 연결하지 않은 노트",
    rf_item_unresolved: "{page} — '{target}' 노트가 아직 없어요",
    rf_create_missing: "없는 노트 만들기",
    rf_create_progress: "{done}/{total}",
    rf_create_result: "만든 노트: {n}개",
    rf_create_failed: "'{target}'에서 멈췄어요 — 만들지 못했어요.",
    rf_create_one: "이 노트 만들기",
    rf_open_page: "노트 열기",
    rf_ignore_one: "이 항목 다시 알리지 않기",
    ob_title: "myco에 오신 것을 환영해요",
    ob_skip: "건너뛰기",
    ob_back: "이전",
    ob_next: "다음",
    ob_finish: "완료",
    ob_step: "{n}/{total}",
    ob_vault_linked: "연결됨",
    ob_vault_none: "아직 연결된 볼트가 없어요",
    ob_s1_title: "노트를 둘 폴더 고르기",
    ob_s1_body:
      "노트는 이 기기의 폴더(볼트)에 마크다운 파일로 저장되고, myco를 지워도 그대로 남아요.",
    ob_s1_action: "폴더 고르기…",
    ob_demo_start: "데모 볼트로 시작",
    ob_note_title: "첫 노트 쓰기",
    ob_note_body:
      "떠오른 생각을 적거나 파일 내용을 가져오세요. 첫 줄이 노트 제목이 돼요.",
    ob_note_name: "첫 노트",
    ob_note_ph: "예: 이번 주에 배운 것",
    ob_note_file: "파일에서 가져오기…",
    ob_note_loaded: "{name} 내용을 넣었어요. 저장하기 전에 고쳐도 돼요.",
    ob_note_skip_hint: "지금 쓸 게 없다면 그냥 다음을 누르세요.",
    ob_note_exists: "같은 이름의 노트가 이미 있어요. 첫 줄을 바꿔 보세요.",
    ob_note_failed: "노트를 저장하지 못했어요: {error}",
    ob_note_load_failed: "그 파일을 읽지 못했어요: {error}",
    ob_seed_do: "데모 노트 채우기",
    ob_s3_title: "노트에 질문해 보기",
    ob_s3_body: "답은 내 노트에서 찾아 어디서 왔는지와 함께 보여 줘요.",
    ob_ask_label: "질문",
    ob_first_question: "이 노트들에서 가장 자주 다룬 주제는?",
    ob_first_question_note: "{title}에 대해 뭐라고 적었지?",
    ob_ask_now: "물어보기",
    ob_index_title: "노트를 읽고 있어요…",
    ob_index_progress: "노트 {total}개 중 {done}개",
    ob_index_failed: "인덱싱을 마치지 못했어요",
    ob_guide_title: "더 해 볼 수 있는 것",
    ob_imp_title: "쌓아 둔 세션 가져오기",
    ob_imp_body:
      "Claude Code·Codex 세션을 가져올 수 있어요. 이 기기에서만 인덱싱하니 검색하고 질문해도 비용이 들지 않아요.",
    ob_imp_claude: "Claude Code 세션 가져오기",
    ob_imp_codex: "Codex 세션 가져오기",
    ob_imp_progress: "파일 {total}개 중 {done}개",
    ob_imp_done: "세션 {n}개를 가져왔어요",
    ob_imp_quarantined: "{n}건 보류 (시크릿 의심)",
    ob_hist_title: "볼트 이력 남기기",
    ob_hist_body: "켜면 에이전트가 바꾼 내용을 단어 단위로 보고 되돌릴 수 있어요.",
    s_budget_title: "월 지출 가드",
    s_budget_desc:
      "이번 달 유료 API 제공자에서의 예상 지출입니다. 정확한 청구가 아닌 대략적 경보로, 임계값을 설정하면 초과 전에 경고합니다.",
    s_budget_threshold: "월 한도 (USD)",
    s_budget_usage: "이번 달",
    s_budget_total: "합계",
    s_budget_empty: "이번 달 추적된 유료 API 사용량이 없습니다.",
    s_autoreflect_title: "자동 Reflect",
    s_autoreflect_desc:
      "myco가 켜져 있는 동안 읽기 전용 Reflect를 주기적으로 실행해 고립된 노트·오래된 페이지·빠진 링크를 찾아냅니다.",
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
      "내장 한국어 E5와 BM25로 오프라인 검색합니다. 별도 설치한 Qwen3.5 4B는 질문 답변, 2B는 확인할 자료 추가 요약에 사용합니다. 원문 인용을 보존하며, 로컬 정리는 선택된 로컬 자료 추가 모델이 있으면 사용합니다.",
    s_provider_desc_ollama:
      "오픈소스 모델을 로컬에서 실행합니다. http://localhost:11434를 자동 감지합니다.",
    s_provider_desc_openrouter:
      "하나의 키로 여러 제공자 사용 (모델 비교에 유용).",
    s_provider_desc_myco_pro:
      "관리형 모델로 자료 추가 무제한 — API 키나 CLI가 필요 없습니다. myco Pro 계정으로 로그인하세요.",
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
    hn_label: "알림",
    hn_label_n: "알림: 살펴볼 것 {n}개",
    hn_empty: "지금 살펴볼 알림이 없어요.",
    hn_loading: "노트를 확인하고 있어요…",
    hn_error: "알림을 확인하지 못했어요.",
    hn_changes: "다녀오신 사이 바뀐 노트",
    hn_check: "확인이 필요한 노트",
    hn_contra: "내용이 서로 다른 노트",
    hn_see_all: "모두 보기",
    hn_contra_open: "확인하기",
    chk_no_frontmatter: "노트 정보(머리말)가 없어요",
    chk_no_type: "종류(type)가 적혀 있지 않아요",
    chk_bad_type: "종류(type) 값이 알 수 없는 값이에요",
    chk_superseded: "새 노트로 바뀌었다고 적혀 있지만 어느 노트인지 없어요",
    chk_disputed: "내용이 엇갈린다고 적혀 있지만 무엇이 다른지 없어요",
    chk_citation: "인용한 출처가 노트에 적혀 있지 않아요",
    chk_footnote: "적어 둔 출처를 본문에서 쓰지 않아요",
    chk_source_count: "출처 수와 인용 수가 달라요",
    chk_source_count_nan: "출처 수가 숫자가 아니에요",
    chk_confidence: "적힌 확신 정도가 출처와 맞지 않아요",
    chk_other: "한번 살펴볼 부분이 있어요",
    ov_view_runs: "런 보기",
    ovl_edit: "배치 편집",
    ovl_done: "배치 완료",
    ovl_reset: "기본 배치로",
    ovl_reset_done: "기본 배치로 되돌렸습니다.",
    ovl_hint:
      "손잡이를 끌거나, 손잡이에 포커스를 두고 화살표 키로 옮기세요. 블록마다 너비를 고를 수 있습니다.",
    ovl_span: "너비",
    ovl_span_full: "전체",
    ovl_move: "{block} 이동 — 화살표 키로 위치를 바꿉니다",
    ovl_moved: "{block}: {index}/{total}",
    ovl_vacant: "지금은 표시할 내용이 없습니다.",
    ovl_b_pulse: "볼트 맥박",
    ovl_b_harvest: "수확 대기열",
    contra_title: "모순",
    contra_disputed: "두 노트의 내용이 서로 달라요",
    contra_stale: "더는 맞지 않는 노트({t})를 인용하고 있어요",
    contra_mark_active: "해결됨으로 표시",
    contra_mark_superseded: "옛 내용으로 표시",
    contra_open_page: "이 노트 열기",
    contra_open_target: "인용한 노트 열기",
    contra_ignore: "무시",
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
    ritual_keep: "다시 보기",
    ritual_later: "나중에",
    home_ask_ph: "노트에 물어보거나, 떠오른 생각을 적어 보세요",
    home_ask_keys: "Enter 질문하기 · ⌘Enter 오늘의 노트에 적기",
    home_ask_send: "질문하기",
    home_capture_send: "오늘의 노트에 적기",
    home_captured: "오늘의 노트에 적었어요",
    home_capture_failed: "오늘의 노트에 적지 못했어요",
    home_open_daily: "열기",
    home_greet_morning: "좋은 아침이에요",
    home_greet_afternoon: "좋은 오후예요",
    home_greet_evening: "좋은 저녁이에요",
    rd_day_prev: "어제",
    rd_day_next: "내일",
    history_runs_title: "실행",
    history_run_open_why: "WHY 보고서",
    history_run_kind_digest: "대화 기록 요약",
    history_run_kind_llm: "모델 정리",
    history_run_kind_distill: "자동 정리",
    history_undo_q: "이 실행을 되돌릴까요?",
    history_undo_msg:
      "보관하거나 휴지통으로 옮긴 노트는 복원 사본이 남아 있을 때만 돌아갑니다. 영구 삭제한 파일은 복원할 수 없습니다. 새로 만든 페이지는 삭제하고, 실행 뒤에 고친 파일은 건너뜁니다.",
    history_no_commit:
      "이 실행은 이력(git)이 꺼진 상태에서 돌았습니다 — 파일 목록만 보여드립니다.",
    history_diff_too_large: "파일이 커서 차이를 표시하지 못합니다",
    history_status_added: "추가",
    history_status_modified: "수정",
    history_status_renamed: "이동",
    history_status_deleted: "삭제",
    auth_badge_human: "사람 {h}% · 에이전트 {a}%",
    auth_badge_last_human: "마지막 사람 손길 {t}",
    rd_auth_section: "작성자",
    auth_filter_pill: "기록상 사람만",
    auth_filter_hint: "기록상 myco가 고친 적 있는 노트를 목록에서 숨겨요",
    agent_confirm_title: "에이전트가 페이지를 수정하려 합니다",
    agent_confirm_create_title: "에이전트가 새 페이지를 만들려 합니다",
    agent_confirm_hint: "허용하면 아래 변경이 볼트에 기록됩니다.",
    notch_peek: "놓거나 눌러서 적기",
    notch_peek_body: "파일 · 링크 · 선택한 텍스트",
    notch_drop: "여기에 놓으세요",
    notch_accepted: "받았습니다",
    notch_accepted_next: "다음",
    notch_accepted_next_sub: "곧 자료로 추가됩니다",
    notch_running: "자료 추가 중 · {t}",
    notch_running_read: "읽는 중",
    notch_running_pages: "페이지",
    notch_done: "완료",
    notch_done_open: "⏎ 열기",
    notch_done_collapse: "4초 후 접힘",
    notch_failed: "끝내지 못했습니다",
    notch_capture: "빠른 기록",
    notch_capture_save: "⏎ 오늘의 노트",
    notch_capture_voice: "⌥M 음성",
    notch_recording: "녹음 중 · {t}",
    notch_rec: "녹음",
    notch_note: "노트",
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
      "저장하지 못했습니다 — 다시 시도하거나 자료 추가를 사용하세요",
    notch_waiting: "{n}건 기다립니다",
    notch_agenda_harvest_title: "수확 대기",
    notch_agenda_links_title: "제안된 연결 {n}개",
    notch_agenda_links_all: "모두 연결",
    notch_agenda_harvest_sub: "위키에 들어갈 만한 세션 {n}개",
    notch_agenda_harvest: "{n}개 수확",
    notch_agenda_dropped: "버렸습니다",
    s_notch_title: "노치 드롭 표면",
    s_notch_desc:
      "메뉴 막대 노치 아래에 드롭 표면을 표시합니다 — 떨어뜨린 파일은 _inbox로 들어가 자료로 추가됩니다.",
    tidy_btn: "정리",
    tidy_btn_title: "세션 페이지의 읽을 수 있는 이름과 이어지는 링크를 제안합니다",
    tidy_cmd: "볼트 정리 (Tidy)",
    tidy_title: "볼트 정리",
    tidy_lede: "세션 페이지에 읽을 수 있는 이름을 붙이고 끊어진 링크를 고칩니다. 적용하기 전에는 아무것도 쓰지 않으며, 되돌릴 수 있습니다.",
    tidy_loading: "볼트를 살펴보는 중…",
    tidy_empty: "정리할 것이 없습니다",
    tidy_error: "볼트를 읽지 못했습니다",
    tidy_retry: "다시 시도",
    tidy_g_titles: "읽을 수 있는 제목 붙이기",
    tidy_g_titles_desc: "세션의 첫 요청, 에이전트, 날짜로 만듭니다.",
    tidy_g_links: "끊어진 링크 고치기",
    tidy_g_links_desc: "Related의 세션 링크를 그 요약 페이지로 바꾸고, 요약이 없는 링크는 지웁니다.",
    tidy_g_move: "세션 요약 모으기",
    tidy_g_move_desc: "wiki/sessions/<월>/ 폴더로 옮깁니다. 링크는 그대로 이어집니다.",
    tidy_removed: "삭제",
    tidy_show_all: "{n}개 모두 보기",
    tidy_show_less: "접기",
    tidy_skipped: "전사본을 찾지 못해 건너뜀 {n}개",
    tidy_apply: "파일 {n}개에 적용",
    tidy_applying: "적용하는 중…",
    tidy_done: "파일 {n}개를 정리했습니다",
    tidy_failed: "{n}개는 쓰지 못했습니다:",
    tidy_undo: "되돌리기",
    tidy_undoing: "되돌리는 중…",
    tidy_undone: "파일 {n}개를 되돌렸습니다",
    tidy_undo_skipped: "실행 후 바뀌어 그대로 둔 파일:",
    tidy_changed: "살펴본 뒤에 바뀌어 그대로 둔 파일:",
    tidy_rescan: "다시 살펴보기",
    tidy_s_desc: "세션 페이지에 읽을 수 있는 이름을 붙이고 링크를 고칩니다. 쓰기 전에 미리 보여 주고, 되돌릴 수 있습니다.",
    tidy_s_run: "정리…",
    tidy_s_history: "정리 기록",
    tidy_s_last: "최근 실행 {when} · 파일 {n}개",
    tidy_s_last_undone: "되돌림",
    tidy_s_none: "아직 실행한 적 없음",
  },
  ja: {
    ...EVERYDAY_STRINGS.ja,
    app_name: "myco",
    quick_search: "検索 / 移動…",
    quick_ask: "ウィキに質問",
    nav_workspace: "ワークスペース",
    nav_pages: "自分のノート",
    nav_tools: "その他のツール",
    nav_overview: "ホーム",
    nav_ingest: "資料を追加",
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
    bd_deleted: "ボード“{name}”を削除しました",
    bd_board_exists: "ボード“{name}”は既にあるため、それを開きました",
    bd_name_refused: "“{name}”はボード名に使えません",
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
    tasks_compose_category_ph: "例: 仕事",
    tasks_compose_project_ph: "例: プロジェクトのノート名",
    tasks_detail_estimate_ph: "例: 2d",
    tasks_detail_recur_ph: "例: every week",
    tasks_due_named: "期限 {date}",
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
    skip_to_content: "本文へスキップ",
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
    ov_recent_moved: "最近のノート",
    ov_recent_never: "ノートはここに表示されます。上から資料を追加するか、最初のノートを書きましょう。",
    home_links_today: "今日つながったノート:",
    home_links_more: "、ほか{n}組",
    home_links_cites: "新しい引用 {n}件",
    home_links_none: "今日はまだ新しくつながったノートはありません",
    home_links_updated: "ノートを保存すると更新されます",
    ing_title: "取り込み",
    ing_lede:
      "ファイルをドロップ、URL を貼り付け、あるいはメモを書く。Claude が読み、エンティティと概念を抽出し、ソースページを作成し、グラフに織り込みます。",
    ing_drop: "ここにファイルをドロップ",
    ing_drop_or: "または URL を貼り付け",
    ing_browse: "ファイルを選択…",
    ing_image_capability_unavailable:
      "選択した収穫・セッション整理モデルの画像入力対応は確認されていません。テキスト資料を使うか、モデル設定を確認してください。外部画像モデルの選択は任意です。",
    ing_source_authority_changed:
      "開いている保管庫、または収穫・セッション整理の実行権限が変わったか、確認できません。モデル設定を確認し、現在の画面から再試行してください。",
    ing_source_credential_unavailable:
      "選択した収穫・セッション整理モデルの認証情報を利用できません。モデル設定を確認するか、テキスト資料を使ってください。外部モデルの利用は任意です。",
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
    ing_web_fetch: "このページを取り込む",
    ing_web_fetching: "ページを取り込み中…",
    ing_web_rule_visible: "誰でも見られる文章だけを取り込みます。有料記事やログインが必要なページは取り込めません。",
    ing_web_rule_private: "自分のパソコンや自宅・社内ネットワークのアドレスは開きません。",
    ing_web_rule_keep: "取り込んだ文章が欄のリンクと置き換わり、下のボタンを押すまで保存されません。",
    ing_web_pii_warn: "このページには電話番号やメールなどの個人情報が含まれています。",
    ing_web_err_bad_url: "Webアドレスの形ではありません。",
    ing_web_err_scheme: "http:// または https:// のリンクだけ取り込めます。",
    ing_web_err_credentials: "名前とパスワードを含むリンクは開きません。",
    ing_web_err_blocked: "自分のパソコンや内部ネットワークを指すアドレスなので開きませんでした。",
    ing_web_err_resolve: "サイトが見つかりませんでした。アドレスを確認してください。",
    ing_web_err_redirect: "サイトがたどれないアドレスへ転送しました。",
    ing_web_err_redirects: "サイトが別のアドレスへ転送する回数が多すぎます。",
    ing_web_err_status: "サイトがエラーを返しました({n})。",
    ing_web_err_not_html: "Webページではありません。PDFなどのファイルかもしれません。",
    ing_web_err_too_large: "ページが5MBより大きいです。",
    ing_web_err_timeout: "サイトの応答に時間がかかりすぎました。",
    ing_web_err_network: "接続できませんでした。インターネット接続を確認してください。",
    ing_web_err_empty: "そのページに読める文章が見つかりませんでした。",
    ing_web_err_secret: "パスワードやキーのような内容があるため、取り込みませんでした。",
    ing_web_err_pii: "個人情報があり、個人情報の検出時が「隔離」に設定されているため、取り込みませんでした。",
    ing_web_err_scan: "パスワードや個人情報の確認ができなかったため、取り込みませんでした。",
    ing_guard_secret: "パスワードやキーのような内容があるため、保存しませんでした。その部分を消してから、もう一度実行してください。",
    ing_guard_pii: "個人情報があり、個人情報の検出時が「隔離」に設定されているため、保存しませんでした。",
    ing_guard_scan: "パスワードや個人情報の確認ができなかったため、保存しませんでした。",
    ing_guard_pii_warn: "この文章には電話番号やメールなどの個人情報が含まれています。そのまま保管されます。",
    ing_web_err_other: "ページを取り込めませんでした。",
    ing_paste_url_ph: "https://example.com/paper.pdf",
    ing_or_paste: "原文を貼り付け",
    ing_paste_ph: "記事、メモ、会話の内容を貼り付けてください…",
    ing_run: "資料を整理",
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
    ingest_gate_apply: "選んだ{n}件だけ適用",
    ingest_gate_all: "すべて適用（{n}件）",
    ingest_gate_noop_hint:
      "「反映済み」の項目はすでにウィキにあるため、最初から選択を外しています。",
    ing_cancel: "キャンセル",
    ing_cancelled: "取り込みをキャンセルしました",
    ing_gate_title: "計画を確認中 — 適用する項目を選んでください",
    ing_gate_waiting:
      "選択を待っています。適用する項目を選ぶと書き込みを始めます。",
    ing_clear: "内容を消去",
    ing_touched_n: "{n}ページを更新",
    ing_refused_more: "内容をさらに貼り付ける",
    ing_short_title: "短いメモはそのままノートに保存できます",
    ing_short_daily: "今日のノートに書く",
    ing_short_new: "新しいノートとして保存",
    ing_short_new_failed: "ノートを保存できませんでした",
    ing_gate_paused: "選択を待っています",
    ing_gate_source: "貼り付けた原文",
    ing_more_advanced: "詳細",
    ing_pick_file: "ファイルを選ぶ",
    ing_preview_open: "ページを開く",
    ing_preview_close: "プレビューを閉じる",
    ing_preview_writing: "まだ書き込み中です — 少し待ってからもう一度。",
    ing_chip_done: "取り込み完了",
    ing_chip_error: "取り込み失敗",
    q_title: "ノートに質問する",
    q_lede:
      "myco はまずウィキから答え、必要なときだけ原本に降りていきます。すべての主張に出典が付きます。",
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
    gr_canvas_aria: "ボルトのリンク地図。矢印キーでノートを選び、Enter で開きます。",
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
    gr_q_neighbors_u: "2ステップ",
    gr_q_sub_neighbors: "選択したノートから2ステップまで",
    gr_q_pick: "ノートを一つ選んでください",
    gr_size: "ノードの大きさ",
    gr_size_backlinks: "大きさ = 被リンク",
    gr_size_cites: "大きさ = 引用",
    gr_hide_sample: "サンプル {n} 件を隠す",
    gr_show_unresolved: "未解決リンクを表示",
    gr_rebuilds: "シーン再構築 {n} 回 · {ms} ms",
    gr_honest_lead: "このグラフが描くのは {n} ノード",
    gr_honest: "初回サンプル {sample} 件（{pct}%）· 自分のノート {own} 件 · 未解決 {unresolved} 件。引用を持つノートは {cited} 件。",
    gr_honest_sessions: "保存された会話 {n} 件を除き、ノートとリンクを表示します。",
    gr_summary: "自分のノート {own} 件、つながりが欠けている所 {gaps} 件",
    gr_details: "詳細",
    gr_gap_nobacklink: "誰も参照していない",
    gr_act_link: "リンクを提案",
    gr_act_harvest: "必要な話題として記録",
    gr_act_neighbors: "隣人だけ表示",
    gr_act_open_s: "開く",
    gr_act_link_s: "リンク",
    gr_act_want_s: "記録",
    gr_insp_cites: "引用",
    gr_insp_sample: "初回サンプル",
    gr_insp_own: "自分のノート",
    gr_insp_nocite: "引用 0",
    gr_enc_orphans: "色 = カテゴリ · 大きさ = リンク数 · かすみ = すでに接続済み",
    gr_enc_clusters: "ブロック = クラスタ · 破線 = 地図ページなし · 点線 = 未接続の近い話題",
    gr_enc_time: "色 = 最終更新（単一ランプ）· リング = 30日以内 · かすみ = 90日以上放置",
    gr_enc_neighbors: "近いほど明るく（ノートと直接の隣は明るく、2 ステップ先はかすかに、それ以外はほぼ見えない）",
    gr_enc_strata: "横 = 最終更新（左が古い）· 帯 = クラスタ",
    gr_link_question: "ボルトの中で「{a}」が接続されないままです。どのノートがここにリンクすべきで、そのリンクは何を言うべきでしょうか？",
    gr_want_done: "「{n}」を必要な話題として記録しました",
    gr_legend: "凡例",
    gr_filter: "フィルター",
    gr_filter_folder: "フォルダ: {f}",
    gr_filter_search: "検索: {q}",
    gr_filter_remove: "フィルターを外す: {f}",
    gr_filter_empty: "フィルターに合うノートがありません",
    gr_filter_clear: "フィルターを解除",
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
    gr_skin_web: "宇宙の網",
    gr_recency: "最近さグロー",
    gr_recency_hint: "最近編集したノートほど熱く光ります",
    gr_minimap: "ミニマップ",
    gr_minimap_hint: "銀河全体のチャート — クリックでその地点へ",
    gr_layout_spiral: "渦巻銀河",
    gr_layout_strata: "年代記",
    gr_layout_semantic: "意味マップ",
    gr_layout_celestial: "天球星座",
    gr_layout_radial: "同心軌道",
    gr_layout_walrus: "ウォルラスツリー",
    gr_layout_mycelium: "菌糸マット",
    gr_skin_sigma: "シグマ",
    gr_skin_mycelium: "菌糸",
    gr_mycelium_dim: "菌糸ビュー",
    gr_mycelium_3d: "3D",
    gr_mycelium_2d: "2D",
    gr_myc_node_color: "ノードの色",
    gr_myc_hypha_color: "菌糸の色",
    gr_myc_bg: "背景",
    gr_myc_bg_loam: "腐葉土",
    gr_myc_bg_void: "漆黒",
    gr_myc_bg_soil: "黄土",
    gr_myc_bg_paper: "紙",
    gr_myc_bg_grid: "グリッド",
    gr_myc_bg_custom: "カスタム背景",
    gr_vibes: "ワンタップルック",
    gr_vibe_living: "生きた銀河",
    gr_vibe_sigma: "シグマボード",
    gr_vibe_cosmicweb: "宇宙の網",
    gr_vibe_neural: "神経系",
    gr_vibe_planetarium: "プラネタリウム",
    gr_vibe_paper: "紙の地図",
    gr_vibe_chronicle: "クロニクル",
    gr_vibe_nebula: "意味の星雲",
    gr_vibe_living_desc: "デフォルト — 輝き呼吸する星図",
    gr_vibe_sigma_desc: "暗い背景にトピック別の色と細いリンクを描く静かな地図",
    gr_vibe_cosmicweb_desc: "暗黒物質フィラメント — リンクが絵を描く",
    gr_vibe_neural_desc: "虚空で発火する神経系",
    gr_vibe_planetarium_desc: "トピックごとの星座、深宇宙の空",
    gr_vibe_paper_desc: "白い紙の印刷物のような領域地図",
    gr_vibe_chronicle_desc: "時間の地層 — ボルトを歴史として読む",
    gr_vibe_nebula_desc: "意味(埋め込み)でクラスタ化されたノート",
    gr_vibe_walrus: "ウォルラスツリー",
    gr_vibe_mycelium: "菌糸",
    gr_vibe_walrus_desc: "球体内の双曲スパニングツリー (CAIDA Walrus)",
    gr_vibe_mycelium_desc: "育った菌糸マットにノートを掛けています",
    gr_looks: "ルック",
    gr_appearance: "外観",
    gr_motion_fx: "モーション・効果",
    gr_mascot_cameo: "MYCO カメオ",
    gr_mascot_cameo_hint: "時々 MYCO が機能ヒントと共に登場",
    mc_label: "MYCO ヒント",
    mc_dismiss: "閉じる",
    mc_tip_drag:
      "どの星でもドラッグするとシミュレーションが再加熱 \u2014 隣接ノードが追従し弾んで戻ります。",
    mc_tip_path: "2つのノートを Cmd/Ctrl-クリックすると最短経路が光ります。",
    mc_tip_fly:
      "F を押すとボルトを宇宙船で飛行 \u2014 WASD で飛び Esc で着陸。",
    mc_tip_looks:
      "設定パネルを開いてルックをタップ \u2014 Sigma, Paper, Neural, Planetarium\u2026",
    mc_tip_timelapse:
      "タイムラプスを再生すると書いた順にボルトが自ら育ちます。",
    mc_tip_multiverse:
      "マルチバースをオンにすると各プロジェクトが輝く宇宙バブルに。",
    mc_tip_minimap:
      "隅のミニマップ \u2014 どこでもクリックするとカメラがそこへ飛びます。",
    mc_tip_recency:
      "最近編集したノートほど熱く燃える \u2014 グラフがあなたの関心を地図化します。",
    mc_tip_save:
      "気に入ったルックを調整した？保存ルックに名前を付けてワンタップで呼び出し。",
    mc_tip_chronicle:
      "年代記レイアウトを試して \u2014 ノートが実際の時間軸に沿って並びます。",
    gr_saved: "保存したルック",
    gr_saved_apply: "この保存ルックを適用",
    gr_saved_delete: "削除",
    gr_saved_empty: "現在の設定を保存すると後で呼び出せます。",
    gr_saved_name_ph: "ルック名\u2026",
    gr_saved_save: "保存",
    gr_layout_3d: "3D \u2014 宇宙を周回",
    gr_layout_2d: "2D \u2014 平面地図",
    gr_layout_galaxy_s: "銀河",
    gr_layout_synapse3d_s: "シナプス",
    gr_layout_atlas_s: "アトラス",
    gr_layout_synapse_s: "シナプス (平面)",
    gr_cinematic: "シネマティック仕上げ",
    gr_cinematic_hint: "フィルムグレイン・ビネット・レンズストリーク・AA",
    gr_flow: "エッジフロー",
    gr_flow_hint: "リンクに沿って光のパルスが始点\u2192終点へ流れる",
    gr_semantic_missing:
      "意味マップには埋め込みインデックスが必要です — 設定 \u2192 モデルで再イン<デックス後に開き直してください。今は渦巻で表示します。",
    gr_galaxies: "フォルダー銀河",
    gr_galaxies_hint: "フォルダーごとにゆっくり自転する銀河へ分割",
    gr_multiverse: "マルチバース",
    gr_multiverse_hint:
      "各プロジェクトを宇宙バブルとして表示。ひとつに飛び込むとそのプロジェクトが開く",
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
    gr_edge_bundles_hint:
      "2つのトピック間のリンクを1本の重み付きアークに束ねる",
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
    gr_pixel_nodes: "ピクセルノード",
    gr_pixel_nodes_hint: "光る点の代わりに16x16ピクセルアートで表示",
    gr_color_depth: "色の濃さ",
    gr_edge_tint: "リンク色",
    gr_edge_tint_grey: "グレー",
    gr_edge_tint_community: "コミュニティウェブ",
    gr_help_btn: "ジェスチャーガイド",
    gr_more_menu: "その他",
    gr_canvas_label: "ノート {n} 件",
    gr_canvas_label_sel: "ノート {n} 件、選択中: {name}",
    gr_help_title: "ジェスチャーガイド",
    gr_help_click: "ノートにフォーカス（直接の隣まで）",
    gr_help_dblclick: "フォーカスを2ステップ先まで広げる",
    gr_help_cmdclick: "ノート間の最短経路",
    gr_help_esc: "上に開いたパネルを閉じるか、フォーカスから一段戻る",
    gr_help_fly: "宇宙船モード切替",
    gr_help_drag: "宇宙をオービット回転",
    gr_help_rails: "ギャップ/凡例パネルを折りたたむ・展開する",
    gr_rail_fold: "{name}を折りたたむ",
    gr_rail_open: "{name}を展開",
    gr_panels: "パネル",
    gr_trace: "経路トレース",
    gr_trace_hint: "開始ノードをクリックし、次に終了ノードをクリック",
    gr_spaceship: "宇宙船",
    gr_spaceship_hint:
      "WASDで飛行 · ドラッグで方向 · ノードをクリックで情報 · Escで終了",
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
    gr_myc_spread: "菌糸の広がり",
    gr_myc_branch: "分岐密度",
    gr_myc_forces_hint:
      "菌糸はシミュレーションではなく成長する仕組みです。この2つのスライダーが菌糸マットの形を変えます。",
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
    p_lint_running:
      "Lint 実行中 — 他のページに移動してもバックグラウンドで続行します。",
    p_lint_done: "Lint 完了",
    p_lint_failed: "Lint 失敗",
    s_title: "設定",
    s_search_ph: "設定を検索",
    s_search_empty: "「{q}」に一致する設定はありません",
    s_account: "自分のスペース",
    s_local_user: "ローカルユーザー",
    s_no_vault: "ボールトなし",
    s_vault_path: "ノートの保存先",
    s_change: "変更…",
    q_empty_response: "(応答なし)",
    eb_title: "{area}で問題が発生しました。",
    eb_reload: "myco を再読み込み",
    eb_retry: "再試行",
    eb_area_app: "アプリ",
    eb_area_graph: "グラフ",
    eb_home: "ホームへ",
    eb_details: "詳細",
    s_workspace: "ワークスペース",
    s_model: "AI 設定",
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
    s_providers: "AI 接続",
    s_appearance: "外観",
    s_vault_known: "myco が把握しているヴォールト",
    s_storage_title: "保存状態",
    s_storage_desc: "ボールトの場所、読めなかったファイル、最後に保存した時刻を表示します。",
    s_storage_where: "場所",
    s_storage_icloud: "iCloud Drive",
    s_storage_dropbox: "Dropbox",
    s_storage_unread: "未ダウンロードまたは読めないファイル",
    s_storage_unread_none: "なし",
    s_storage_unread_n: "{n} 件",
    s_storage_checking: "確認中…",
    s_storage_unread_hint: "myco はこれらを読めなかったため、リンクとグラフから抜けることがあります。ダウンロードまたは修正すると、遅くともボールトを開き直したときに読み込みます。",
    s_storage_history: "ボールト履歴",
    s_storage_last_save: "最終保存",
    s_storage_no_save: "この起動ではまだ保存していません",
    s_ov_theme: "概要の背景",
    s_ov_theme_lede:
      "ホームのあいさつと質問欄の後ろに流れる生きた背景で、「確認・整理する」の中にも表示されます。グラフのレイアウト名をそのまま使いますが、連動はしません。",
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
    s_mcp: "外部ツール連携 (MCP)",
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
      "myco は標準でローカルモデルを使います。作業ごとにモデルを選べます。外部モデルは接続して選択した場合にのみ使用します。",
    s_model_ingest: "取り込み用モデル",
    s_model_query: "質問用モデル",
    model_custom: "カスタム\u2026",
    model_disconnected: "(未接続)",
    model_effort: "推論の強度",
    model_custom_ph: "モデルID",
    model_apply_custom: "モデルを適用",
    model_fetching: "モデル一覧を取得中\u2026",
    s_model_recommended: "推奨",
    s_model_use_recommended: "おすすめの設定を使う",
    s_model_choose_own: "自分で選ぶ",
    s_model_recommended_needs: "上でローカルモデルを準備すると実行できます。外部アカウントは不要です。",
    s_model_ctx: "コンテキスト",
    ing_extractive_note:
      "抜粋要約 — 以下の行はすべて `raw/{slug}.md` からそのまま引用したものです。このソースを読んだモデルはないため、言い換えも推測もありません。",
    ing_extractive_report_title: "抜粋取り込み: {title}",
    local_transform_note: "全{total}件中{selected}件の原文から作成したローカル要約 · {model} · 要確認",
    local_transform_fallback_note: "ローカル要約を作成できませんでした · {model}；原文の引用を保持しました",
    local_transform_report_why: "ローカルモデルで限定範囲の要約を作成し、原文の根拠をすべて保持しました。タグと関連リンクは既存の規則で処理しました。",
    ing_local_transform_hint: "このコンピュータで要約案を作成し、原文引用を保持します。要約の内容を確認してください。",
    ing_run_local_transform: "要約と原文引用を追加",
    ing_extractive_report_why:
      "この実行は内蔵のオフライン経路を使いました。ソースの文をそのまま引用して出典を付け、タグはボールトにすでにあるものだけを再利用し、関連ページはローカルの埋め込みインデックスから取得しました。**モデルは呼び出していません。** ソースを要約した主体がないため `confidence` は `low` です。モデルを接続して再実行すればこのページを置き換えられます。",
    ing_extractive_log:
      "{date} — [[source-{slug}]]（{title}）を抜粋取り込み、モデル呼び出しなし",
    ing_extractive_hint:
      "抜粋方式 — ソースをそのまま引用し、モデルを呼び出しません。",
    ing_run_extractive: "抜粋で取り込む",
    ing_extractive_pending: "原文の {n} 区間が残っています。次回はここから続行し、原文を保持します。",
    set_distill_evidence_pending: "{n} 件の資料に未整理の区間があります。再実行で続行し、記録は引き続き検索できます。",
    workflow_pending: "続行待ち",
    workflow_partial: "一部のみ完了",
    workflow_stopped: "停止しました",
    session_compile_label: "セッション整理",
    session_compile_progress: "処理済み区間 {processed}/{total}",
    session_compile_stopping: "停止を確認中…",
    session_compile_preparation: "セッション整理 · 選択したローカルモデルの準備が必要",
    session_queue_title: "セッション整理の作業",
    session_queue_refresh: "一覧を更新",
    session_queue_idle: "フォルダーを開くとセッション整理の状態を確認できます。",
    session_queue_failed: "整理一覧を読み込めませんでした。一覧を更新して再確認してください。",
    session_queue_empty: "未完了のセッション整理作業はありません。",
    session_queue_count: "未完了の作業 {total} 件 · 現在 {shown} 件を表示",
    session_queue_running: "進行中",
    session_queue_completed: "処理完了",
    session_queue_superseded: "新しい資料に置き換え済み",
    session_queue_unknown: "状態の確認が必要",
    session_queue_runtime_review: "以前の実行を続けるには新しいレビューが必要です。",
    session_queue_conditions_review: "現在の整理条件で新しいレビューが必要です。",
    session_queue_reason_other: "保存された理由を詳細で確認できます。",
    session_queue_details: "詳細",
    session_queue_preparation: "選択したモデルでセッションを整理する準備が必要です。",
    session_queue_incomplete: "整理またはレビューが未完了の区間があります。",
    session_queue_model_failed: "選択したモデルが今回の実行を完了できませんでした。",
    session_queue_processing_failed: "処理を完了できませんでした。詳細で理由を確認してください。",
    workflow_failed: "完了できませんでした",
    workflow_skipped: "処理する作業はありません",
    workflow_review_retry: "確認して再試行",
    workflow_retry_hint: "以下の原因を確認し、残りの作業を再試行してください。",
    s_providers_lede:
      "好きなプロバイダーを接続してください。キーはローカル保存 — myco のサーバーには届きません。",
    s_provider_connected: "接続済み",
    s_provider_disconnected: "未接続",
    s_provider_error: "{name} の設定を変更できませんでした",
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
    s_autoingest_title: "受信資料とセッションの自動整理",
    s_autoingest_desc:
      "mycoを開いている間、受信資料と接続したツールからのセッション更新を、選択した取り込みモデルで整理します。同じ会話の更新は一つの要約ページに反映します。",
    s_autoingest_interval: "間隔",
    s_provider_connect: "接続",
    s_provider_disconnect: "解除",
    s_provider_test: "テスト",
    s_provider_kind_cli: "インストール済みアプリ",
    s_provider_kind_api: "API キー",
    s_provider_kind_local: "このコンピューター",
    s_provider_name_builtin_local: "内蔵（オフライン）",
    s_provider_key_ph: "API キーを貼り付け",
    s_provider_key_save: "保存",
    s_provider_checking_ollama: "Ollama を確認しています…",
    s_provider_keychain_note: "API キーはディスクに平文では保存されず、OS のキーチェーン(macOS キーチェーン / Windows 資格情報マネージャー / Secret Service)に保存されます。",
    s_lang_lede:
      "UI 言語と Claude の作成言語は独立。日本語 UI から英語のノートを書いても OK です。",
    s_lang_ui: "インターフェース",
    s_lang_drafts: "作成言語 (Claude)",
    s_appearance_lede: "既定はシステム設定に従います。",
    s_appearance_light: "ライト",
    s_appearance_dark: "ダーク",
    s_appearance_system: "システム",
    s_text_size: "文字の大きさ",
    s_text_size_desc: "ノートと回答の文字の大きさを決めます。",
    s_text_size_system: "システム設定に従う",
    s_text_size_custom: "自分で選ぶ",
    s_text_size_small: "小",
    s_text_size_medium: "中",
    s_text_size_large: "大",
    s_text_size_sample: "ノートと回答はこの大きさで表示されます。",
    s_about_built:
      "myco はローカルの Obsidian ボルトと Claude Code CLI 上に立つ薄いクライアントです。ページはマークダウン — あなたの知識はあなたのもの。",
    dlg_cancel: "キャンセル",
    dlg_ok: "OK",
    dlg_create: "作成",
    dlg_delete: "削除",
    dlg_rename: "名前を変更",
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
    rd_source: "Markdown原文を編集",
    rd_source_active: "Markdown原文を編集中",
    rd_back_to_write: "原文の編集を閉じる",
    rd_raw_read_only: "取り込んだ原本は読み取り専用です。文を選ぶと、出典付きで今日のノートに写せます。",
    rd_quote_to_daily: "今日のノートに写す",
    rd_quote_to_card: "カードにする",
    rd_quote_actions: "選んだ文",
    rd_quote_card_none:
      "この部分からはカードを作れません。文を一つ丸ごと選んでください。",
    rd_quote_card_title: "この文から作ったカード",
    rd_quote_card_msg: "カードは選んだ文をそのまま使い、語を一つだけ空欄にします。保存すると、この文が出典付きで今日のノートにも入り、チェックしたカードは {deck} に保存されます。",
    rd_quote_pick_title: "空欄にする語を選ぶ",
    rd_quote_pick_msg: "この文には太字もウィキリンクもないので、カードで問う語を一つ押して選んでください。保存すると、この文が出典付きで今日のノートにも入り、カードは {deck} に保存されます。",
    rd_quote_pick_front: "カードの表",
    rd_quote_pick_empty: "まだ語を選んでいません。",
    rd_loading: "ノートを開いています…",
    rd_not_found: "ノートが見つかりません",
    rd_not_found_sub: "移動、名前の変更、または削除された可能性があります。",
    rd_unreadable: "ノートを開けません",
    rd_find_note: "ノートを検索",
    rd_go_home: "ホームへ",
    rd_type_note: "ノート",
    rd_save_failed: "この下書きがファイルに保存されたか確認できませんでした。残したい変更をコピーするか、ファイルを再読込して変更を手動で統合してください。",
    rd_retry_save: "もう一度保存",
    rd_copy_draft: "下書きをコピー",
    rd_draft_copied: "下書きをコピーしました",
    rd_draft_copy_failed: "下書きをコピーできませんでした",
    rd_original_baseline: "編集開始時の原文",
    rd_current_file: "最後に読み込んだファイル内容",
    rd_recovery_draft: "復旧用のローカル下書き",
    rd_retry_file_read: "ファイルの読込を再試行",
    rd_copy_baseline: "編集開始時の原文をコピー",
    rd_baseline_copied: "編集開始時の原文をコピーしました",
    rd_baseline_copy_failed: "編集開始時の原文をコピーできませんでした",
    rd_recovered_draft: "復旧用のローカル下書きと編集開始時の原文があります。現在のファイルへの保存は確認されていません。原文と現在のファイルを比較してから、再読込して必要な変更を手動で統合してください。",
    rd_reload_draft: "下書きを破棄して再読込",
    rd_reload_draft_title: "下書きを破棄してファイルを再読込しますか？",
    rd_reload_draft_confirm: "残したい変更を先にコピーしてください。読込に成功すると、未保存の下書きを最新のファイル内容に置き換えます。その後、コピーした変更を貼り付けて手動で統合できます。",
    rd_reloading_draft: "再読込中…",
    rd_draft_reloaded: "最新のファイルを読み込みました。コピーした下書きから必要な変更を貼り付け、手動で統合してください。",
    rd_draft_reload_failed: "ファイルを再読込できませんでした。下書きは保持されています。",
    rd_saving: "保存中…",
    rd_saved: "保存済み",
    rd_save_pending: "自動保存を待機中…",
    rd_not_saved: "未保存",
    rd_task_toggle: "タスクの完了を切り替え",
    rd_frontmatter_hidden: "ノートの詳細 · ノート情報で編集",
    live_ph_block: "「/」でブロックを選択",
    live_sources: "出典",
    start_chips_label: "ここから始める",
    start_day_todo: "今日やること",
    start_day_todo_body: "## 今日やること\n- [ ] ${}",
    start_day_meeting: "会議メモ",
    start_day_meeting_body: "## 会議メモ\n- 参加: ${}\n- 内容: ",
    start_day_thoughts: "考えの整理",
    start_day_thoughts_body: "## 考えの整理\n- ${}",
    rd_toc_empty: "見出しはまだありません",
    rd_embed_loading: "読み込み中…",
    rd_embed_missing: "セクションが見つかりません",
    ch_err_type: "グラフの type は bar・line・pie のいずれかにしてください",
    ch_err_line: "{n} 行目が「key: value」の形式ではありません",
    ch_err_data: "グラフにデータがありません。編集で表を選ぶか、値を直接入力してください",
    ch_err_table: "このグラフが読む表がこのノートにありません",
    ch_err_number: "「{value}」は数値ではありません",
    mm_err: "Mermaid でこの図を描けませんでした",
    callout_kind_note: "ノート",
    callout_kind_tip: "ヒント",
    callout_kind_info: "情報",
    callout_kind_warning: "警告",
    callout_kind_danger: "危険",
    callout_kind_success: "成功",
    callout_kind_quote: "引用",
    callout_kind_important: "重要",
    callout_kind_caution: "注意",
    callout_kind_question: "質問",
    rd_backlinks_empty: "まだここにリンクするノートはありません。",
    rd_related: "関連ノート",
    rd_related_no_index:
      "関連ノートは、まだ作成されていないオンデバイス索引から取得します。",
    rd_related_no_index_cta: "セマンティック検索を設定",
    rd_make_cards: "カード作成",
    rd_making: "生成中…",
    rd_cards_none:
      "このノートからはカードを作れません。引用・太字・ウィキリンクのある文が必要です。",
    rd_cards_made: "カードを{n}枚追加しました",
    rd_open_study: "学習を開く",
    rd_cards_preview_title: "このノートから作ったカード",
    rd_cards_preview_msg: "どのカードもこのノートの文をそのまま使っています。不要なカードはチェックを外してください。残りは {deck} に保存されます。",
    rd_cards_save: "保存",
    rd_cards_dupe: "デッキに登録済み",
    rd_cards_ai_tag: "AI 下書き",
    rd_cards_all_dupes: "このノートのカードはすべて {deck} にあります。",
    rd_cards_none_picked: "チェックしたカードがないため、保存しませんでした。",
    rd_more: "その他",
    rd_ask_note: "このノートに質問",
    rd_rail: "ノート情報",
    rd_view_graph: "グラフで見る",
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
    rd_conn_backs: "被リンク",
    rd_conn_sug: "提案",
    rd_conn_added: "## Related に [[{name}]] を追加しました",
    rd_auth_show: "執筆者マークを表示",
    rd_auth_hide: "執筆者マークを非表示",
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
    sl_h4: "見出し4",
    sl_bullet: "箇条書き",
    sl_numbered: "番号付きリスト",
    sl_todo: "チェックボックス",
    sl_code: "コードブロック",
    sl_quote: "引用",
    sl_table: "表",
    sl_divider: "区切り線",
    sl_date: "今日の日付",
    sl_callout: "コールアウト",
    sl_toggle: "トグルリスト",
    sl_link: "ノートへのリンク",
    sl_image: "画像",
    sl_embed: "ノートを埋め込む",
    sl_sec_basic: "基本ブロック",
    sl_sec_media: "メディア",
    sl_sec_records: "記録",
    sl_sec_advanced: "高度なブロック",
    sl_sec_templates: "テンプレート",
    sl_sec_plugins: "プラグイン",
    pl_renderer_missing: "このバージョンには {renderer} レンダラーがないため、コードとして表示します。",
    sl_no_results: "該当なし",
    sl_text: "テキスト",
    bm_search: "アクションを検索…",
    bm_turn_into: "ブロックタイプの変換",
    bm_actions: "アクション",
    bm_duplicate: "複製",
    bm_delete: "削除",
    bm_move_up: "上へ移動",
    bm_move_down: "下へ移動",
    bm_ask: "このブロックで質問",
    bm_handle: "ブロックメニュー",
    bm_indent: "インデント",
    bm_outdent: "インデント解除",
    tb_label: "編集ツール",
    tb_undo: "元に戻す",
    tb_wikilink: "ノートをリンク",
    tb_tag: "タグ",
    tb_todo: "ToDo",
    tb_heading: "見出し",
    tb_add: "ブロックを追加",
    tb_hide: "キーボードを閉じる",
    tb_bold: "太字",
    tb_italic: "斜体",
    tb_highlight: "ハイライト",
    tb_code: "コード",
    tb_link: "リンクにする",
    tbl_col_ph: "列 {n}",
    tbl_add_row: "行を追加",
    tbl_add_col: "列を追加",
    tbl_row_menu: "行のメニュー",
    tbl_col_menu: "列のメニュー",
    tbl_menu: "表のメニュー",
    tbl_row_above: "上に行を追加",
    tbl_row_below: "下に行を追加",
    tbl_col_left: "左に列を追加",
    tbl_col_right: "右に列を追加",
    tbl_row_delete: "行を削除",
    tbl_col_delete: "列を削除",
    tbl_align: "配置",
    tbl_align_left: "左",
    tbl_align_center: "中央",
    tbl_align_right: "右",
    fb_edit: "編集",
    fb_delete: "削除",
    fb_done: "完了",
    fb_panel: "{name}を編集",
    fb_text: "内容",
    mm_f_code: "図のコード",
    mt_f_tex: "数式 (TeX)",
    ch_f_type: "種類",
    ch_f_bar: "棒",
    ch_f_line: "折れ線",
    ch_f_pie: "円",
    ch_f_title: "タイトル",
    ch_f_data: "データ",
    ch_f_from_table: "このノートの表",
    ch_f_inline: "直接入力",
    ch_f_table: "表",
    ch_f_pick: "表を選択",
    ch_f_new_table: "新しい表を作成",
    ch_f_missing: "このノートにない表",
    ch_f_table_n: "表 {n}",
    ch_f_layout: "向き",
    ch_f_columns: "列",
    ch_f_rows: "行",
    ch_f_labels: "項目",
    ch_f_series: "系列 {n}",
    ch_f_values: "値",
    ch_f_add_series: "系列を追加",
    ch_f_remove_series: "系列 {n} を削除",
    qb_f_path: "フォルダ",
    qb_f_tag: "タグ",
    qb_f_type: "種類",
    qb_f_sort: "並べ替え",
    qb_f_limit: "件数",
    qb_f_advanced: "詳細",
    qb_f_line: "クエリ",
    qb_sort_default: "既定（名前順）",
    qb_sort_name: "名前順",
    qb_sort_name_desc: "名前の逆順",
    qb_sort_modified: "更新が新しい順",
    qb_sort_modified_asc: "更新が古い順",
    qb_sort_links: "リンクが多い順",
    qb_sort_sources: "出典が多い順",
    qb_sort_type: "種類順",
    ins_link: "カーソル位置にリンクを挿入",
    ins_quote: "カーソル位置に引用を挿入",
    sl_in_notes: "ノートの内容から",
    sl_onthisday: "過去の今日",
    sl_toc: "目次",
    sl_chart: "グラフ",
    ch_sample_title: "サンプルグラフ",
    sl_mermaid: "ダイアグラム",
    mm_sample:
      "flowchart LR\n  A[アイデア] --> B{残す価値がある?}\n  B -->|はい| C[ノートに書く]\n  B -->|いいえ| D[手放す]",
    sl_math: "数式",
    otd_title: "過去の年の{date}",
    otd_all: "{n}件すべてリンクで挿入",
    otd_none: "過去の年の{date}のデイリーノートはありません。",
    otd_keys: "↵ 挿入 · esc 閉じる",
    sl_query: "クエリ",
    sl_onthisday_query: "過去の今日（クエリ）",
    sl_hint_recall: "過去のノートを探して、その内容を一度だけ入れます",
    sl_hint_query: "決めた条件に合うノートの一覧を置き、いつも最新に保ちます",
    sl_hint_onthisday: "過去の同じ日のノートを選んで、一度だけ入れます",
    sl_hint_onthisday_query: "過去の同じ日のノートの一覧を置き、いつも最新に保ちます",
    qb_hint: 'クエリを入力: "語句", tag:, type:, status:, confidence:, path:, sort:, limit:, view:',
    qb_loading: "クエリを実行中…",
    qb_empty: "このクエリに一致するページはありません。",
    qb_failed: "クエリを実行できませんでした: {error}",
    qb_bad: "不明なオプション: {token}",
    qb_bake: "リンクで保存",
    qb_bake_title: "今の結果をリンク一覧としてノートに書き込みます（前回の一覧は置き換え）",
    qb_col_name: "名前",
    qb_col_type: "タイプ",
    qb_col_status: "ステータス",
    qb_col_updated: "更新日",
    qb_untyped: "タイプなし",
    sl_recall: "記録を探す",
    rc_title: "過去の記録から引用",
    rc_search: "過去の記録を検索… 例: 先週の決定",
    rc_hint: "覚えている内容を入力 — 原文のまま、出典付きで引用します。",
    rc_none: "これに十分近い記録はありません。",
    rc_stale: "検索インデックスが古くなっています — モデル設定で再インデックスしてください。",
    rc_failed: "検索インデックスに接続できませんでした。",
    rc_no_index: "検索インデックスがまだありません — 設定でセマンティック検索を有効にしてください。",
    rc_range: "{start} – {end} の期間",
    rc_embed: "埋め込みで挿入 (![[…]])",
    rc_keys: "↵ 引用 · ⌘↵ 埋め込み · tab 範囲 · esc 閉じる",
    sl_ask: "ノートに質問",
    rc_ask: "質問を入力…",
    rc_ask_title: "ノートに質問",
    rc_ask_hint:
      "質問を入力して Enter — 答えはノートの原文のまま、出典付きのコールアウトとして入ります。",
    rc_ask_keys: "↵ 質問 / 挿入 · ↑↓ スクロール · tab 範囲 · esc 閉じる",
    rc_ask_ready: "Enterで挿入",
    editor_insert_wait:
      "ノートを準備中です。まだ挿入されていません。少し待ってからもう一度お試しください。",
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
      "読んだノートの文をカードにして、忘れかけた頃にもう一度見せます。",
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
    st_load_failed: "学習カードを読み込めませんでした。",
    ing_auto_failed: "保留中の資料を処理できませんでした。",
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
    st_quiz_none: "クイズに使える穴埋めカードが足りません。各問題には空欄の用語と、選択肢になる別の用語が2つ必要です。太字やウィキリンクのあるノートからカードを作ってください。",
    st_ungrounded: "根拠のないカード{n}枚",
    st_ungrounded_hint: "出典ノートがない、または答えがそのノートにないカードです。",
    st_archive: "アーカイブ",
    st_archive_hint: "デッキを cards/archive/ に移動します。戻せば復元できます。",
    st_archived: "{name} を cards/archive/ に移動しました",
    st_archive_failed: "デッキをアーカイブできませんでした",
    st_gen_quiz: "クイズを生成",
    st_generating: "生成中…",
    st_quiz_done: "クイズ完了",
    st_quiz_score: "スコア: {score} / {total}",
    st_correct: "正解",
    st_wrong: "不正解",
    st_next: "次へ",
    st_def_front: "{title}とは？",
    st_section_front: "{title} › {heading}",
    st_today_title: "今日の復習",
    st_grade_forgot: "覚えていない",
    st_grade_remembered: "覚えていた",
    st_next_review: "次の復習：{when} {n}枚",
    st_keys_hint: "Space で答えを表示し、1–{n} で評価します。",
    st_save_failed: "復習の結果を保存できませんでした",
    st_deck_save_failed: "学習カードを保存できませんでした",
    st_deck_read_failed: "デッキを読み込めませんでした。開き直すか、もう一度お試しください。",
    st_deck_changed: "デッキまたは保管庫が変わりました。デッキを開き直してから保存してください。",
    st_deck_partial: "ファイルは保存済みの可能性がありますが、結果を確認できませんでした。デッキを確認してから再試行してください。",
    s_study_lede: "カード作成とクイズがノートから学習素材を作る方法です。",
    s_ai_cards_title: "AIでカードを作成（実験的）",
    s_ai_cards_desc: "オフ：モデルを使わず、ノートの文をそのまま使ってカードとクイズを作ります。オン：接続したチャットモデルが追加で作り、答えがノートにそのまま見つからないものは破棄します。",
    s_ai_cards_needs: "接続したチャットモデルが必要です（設定 → モデル）。それまではノートの文だけでカードを作ります。",
    s_fine_grades_title: "細かく評価",
    s_fine_grades_desc: "オン：復習カードを「もう一度・難しい・普通・簡単」の4段階で評価します。オフ：「覚えていない」「覚えていた」の2つのボタンで評価します。",
    s_plugins: "プラグイン",
    s_plugins_lede: "このボールトの .myco/plugins/ フォルダーにあるプラグインです。プラグインは / メニュー項目を追加し、myco 内蔵のコードブロック表示を使います。main.js のあるプラグインは自分のコードをサンドボックスで実行し、それが求める呼び出しを許可したときだけ有効になります。このコードはファイルを書き込めず raw/ も読めません。アプリのセキュリティポリシー（CSP）により、ネットワークはアプリ自身のファイルとこのコンピューターの Ollama サーバー（localhost:11434）にしか届きません。",
    pl_trust_title: "ボールトの信頼",
    pl_trust_desc: "このボールトを信頼するまで、その中のプラグインはすべてオフのままです。この端末だけに適用され、いつでも取り消せます。",
    pl_trust_btn: "このボールトのプラグインを信頼",
    pl_trusted: "この端末でこのボールトのプラグインを信頼しています。",
    pl_untrust_btn: "信頼を解除",
    pl_installed: "インストール済みのプラグイン",
    pl_reload: "再読み込み",
    pl_loading: "プラグインを読み込み中…",
    pl_empty: ".myco/plugins/ にはまだプラグインがありません。プラグインは manifest.json を1つ入れたフォルダーです。",
    pl_no_vault: "ボールトを開くとそのプラグインが表示されます。",
    pl_load_failed: "プラグインを読み込めませんでした: {error}",
    pl_enable: "{name} を使う",
    pl_off_until_trusted: "ボールトを信頼するまでオフ",
    pl_slash_items: "/ 項目",
    pl_fences: "コードブロック",
    pl_renderer_absent: "このバージョンにはありません",
    pl_fence_builtin: "無視: myco の組み込みブロック",
    pl_fence_taken: "無視: {id} が使用中",
    pl_invalid: "読み込まれていません",
    pl_load_one_failed: "このプラグインを読み込めませんでした。",
    pl_details: "詳細",
    pl_err_missing: "このフォルダーに manifest.json がありません。",
    pl_err_outside: "このプラグインは .myco/plugins/ の外へのリンクなので、読み込みませんでした。",
    pl_err_too_large: "manifest.json が 64 KB を超えています。",
    pl_err_unreadable: "manifest.json をテキストとして読み込めません。",
    pl_err_json: "manifest.json が JSON オブジェクトではありません。",
    pl_err_field: "{field} がないか、正しくありません。",
    pl_err_id: "id \"{value}\" はフォルダー名と同じで、英小文字・数字・. _ - だけにしてください。",
    pl_err_renderer: "{field} の値 \"{value}\" はレンダラーではありません。{renderers} のいずれかを使ってください。",
    pl_err_slash: "{field} には template、fence、command のどれか一つだけが必要です。",
    pl_err_permission: "{field} の値 \"{value}\" は myco が許可する呼び出しではありません。{calls} から選んでください。",
    pl_code: "自分のコード（main.js）をサンドボックスで実行",
    pl_calls: "呼び出し",
    pl_calls_none: "なし",
    pl_ask_title: "{name} のコードを実行しますか？",
    pl_ask_desc: "main.js はファイルから切り離されたサンドボックスで実行され、何も書き込めず、wiki/ 以下のページだけを読みます。このプラグインの / コマンドの実行中にできるのは次のことです。",
    pl_ask_nothing: "ほかには何もできません。求めている呼び出しはありません。",
    pl_allow: "許可して有効にする",
    pl_revoke_hint: "無効にするとこれらの呼び出しの許可を取り消し、再び有効にするときにもう一度確認します。",
    pl_sc_insert: "カーソル位置に文字を挿入する",
    pl_sc_replace: "選択した文字を置き換える",
    pl_sc_selection: "選択した文字とカーソルのある行を読む",
    pl_sc_read: "wiki/ 以下のページを読む",
    pl_sc_recall: "ノートを意味で検索する",
    pl_sc_search: "ノートの本文を検索する",
    pl_sc_notify: "通知を表示する",
    pl_run_timeout: "{name} は {seconds} 秒を超えて実行されたため停止しました。",
    pl_run_failed: "{name} はコマンドを完了できませんでした",
    pl_run_stopped: "{name} は {count} 回続けて失敗したため停止しました。もう一度使うには、設定 → プラグインで無効にしてから有効にしてください。",
    pl_run_busy: "{name} はまだ前のコマンドを実行しています。",
    pl_run_calls: "{name} は 1 回のコマンドで {count} 回を超えて呼び出したため停止しました。",
    pl_run_no_main: "{name} の main.js を読めませんでした",
    rd_cards_ai_failed: "AIカードを作成できませんでした",
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
      "現在の Agent 選択（{provider}）には検証済みのツール実行機構がありません。モデル設定を確認してください。外部モデルは任意です。",
    ag_open_providers: "モデル設定を開く",
    rd_audio: "音声概要",
    au_title: "音声概要",
    au_close: "閉じる",
    au_generating: "対話を作成中…",
    au_needs_provider:
      "設定 → モデルで対応する音声モデルを選択してください。ローカルモデルが既定で、外部モデルは任意です。",
    au_source_failed: "選択した保存済みノートを使用できません。ノートと音声モデル設定を確認して再試行してください。",
    au_generation_failed: "選択した音声モデルが有効な対話を生成できませんでした。モデル設定を確認して再試行してください。",
    au_publication_failed: "文字起こしの保存を確認できませんでした。選択したノートと既存の音声ファイルを確認して再試行してください。",
    au_publication_partial: "保存が完了していません。下書きと {path} のファイルは保持しています。ファイルを確認してから再試行してください。",
    au_cancel_failed: "音声処理の取消を確認できませんでした。現在の処理を確認してから再試行してください。",
    au_stop_generation: "生成を停止",
    au_stopped: "音声生成の停止をリクエストしました。",
    bf_title: "過去のセッションを取り込む",
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
    s_distill: "自動整理",
    set_distill_loading: "読み込み中…",
    set_distill_lede:
      "新しく入ったノートがボールトにどれだけ合うかを定期的に採点し、人が書いていないセッションは隔離し、セッションの要約を書き、要約が済んだセッションはアーカイブへ移します。raw/ の元の資料は決して変更しません。",
    set_distill_enabled_title: "自動蒸留",
    set_distill_enabled_desc:
      "mycoが開いている間、下の「アイドル時間」のあいだ操作がなく、バックログが「バックログ件数トリガー」以上になると自動で整理します。実行は1時間に1回までです。自動でも手動でも、整理はraw/フォルダに触れません。",
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
      "破棄{tr}件、提案{p}件 — バックログ{b}件",
    set_distill_busy: "蒸留か受信トレイ自動取り込みが既に実行中です。",
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
    set_archive_failed: "未完了のバケット・残っているコピーを保持: {list}",
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
    nav_feedback: "整理の提案",
    ov_distill_last_run: "最終実行 {t}",
    ov_distill_never: "まだ実行されていません",
    ov_distill_llm_queued:
      "整理作業は待機中です。選択したモデルを確認して再試行してください。",
    ov_distill_done:
      "蒸留完了 — ダイジェスト{d}日 · 週次ロールアップ{w}件 · 提案{p}件",
    ov_distill_done_months: " · 月次ロールアップ{m}件",
    ov_distill_done_none: "蒸留完了 — 処理する項目なし",
    pf_title: "収穫箱",
    pf_lede:
      "自動整理が残した提案です。新しく集まったノートをトピックとして受け入れる、不要になった資料を削除する、トピックマップを作る、といった内容です。確認して承認するか却下してください。",
    pf_empty: "保留中の提案はありません。",
    pf_kind_admit: "クラスタの受け入れ",
    pf_kind_archive: "一括アーカイブ",
    pf_kind_delete: "一括削除",
    pf_kind_draft_map: "トピックマップの作成",
    pf_created: "作成日",
    pf_expand: "内容を見る",
    pf_collapse: "閉じる",
    pf_approve: "承認",
    pf_dismiss: "却下",
    pf_confirm_title: "この提案を適用しますか?",
    pf_outcome_admit: "隔離された資料 {n} 件をボルトへ戻します。",
    pf_retired: "もう必要ありません — 元の資料はそのまま残します",
    pf_outcome_delete: "隔離された資料 {n} 件をゴミ箱へ移します。",
    pf_confirm_msg_draft_map: "トピックマップの下書きを作ります（モデルを1回使います）。",
    pf_retry: "再試行",
    pf_apply_failed: "適用に失敗しました — 再試行",
    pf_map_needs_writer: "トピックマップを書くには、文章を書けるモデルが必要です",
    pf_tab_proposals: "提案",
    pf_tab_quarantine: "隔離 {n}",
    qz_empty: "隔離中の項目はありません。",
    qz_lede:
      "自動整理が取り分けた項目です。人が書いていないセッションと、トピック外と判断した項目がここに集まります。削除ではなく保留なので、必要なものは戻し、不要なものは破棄してください。",
    qz_verdict_offtopic: "トピック外: {numbers}",
    qz_verdict_sim: "類似度 {sim}",
    qz_verdict_sim_vs: "類似度 {sim} · しきい値 {min}",
    qz_verdict_nearest: "（最も近いトピック: {topic}）",
    qz_verdict_unknown: "この項目には判定の記録がありません。",
    qz_expires_in: "残り{n}日",
    qz_expires_due: "期限切れ — 次回の実行でゴミ箱に移る可能性があります",
    qz_expires_due_ask: "期限切れ — 次回の実行で、削除する前に「提案」タブで確認します",
    qz_expires_unknown: "期限の記録なし",
    qz_restore: "ボルトへ復元",
    qz_delete: "削除",
    qz_keep: "さらに{n}日保管",
    qz_confirm_delete_title: "この項目を削除しますか？",
    qz_confirm_delete_msg:
      "{name} をシステムのゴミ箱に移動します（復元可能）。",
    qz_group_myco: "myco がモデルを呼び出した記録",
    qz_group_agent: "エージェントの作業プロンプト",
    qz_group_hello: "接続テスト",
    qz_group_empty: "空のセッション",
    qz_group_other: "その他の項目",
    qz_restore_all: "すべて戻す",
    qz_trash_all: "すべて捨てる",
    qz_confirm_restore_all_title: "{n}件をすべて戻しますか？",
    qz_confirm_restore_all_msg:
      "「{group}」の項目を元の場所に戻します。戻した項目は二度と隔離しません。",
    qz_confirm_trash_all_title: "{n}件をすべて捨てますか？",
    qz_confirm_trash_all_msg:
      "「{group}」の項目をシステムのゴミ箱に移動します。ゴミ箱から元に戻せます。",
    tb_activity_quarantine: "確認待ち{n}件",
    tb_activity_gone: "その項目はすでに処理され、ありません。",
    ing_title_label: "タイトル",
    ing_title_ph: "例：今日読んだ記事",
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
      "各コピーの根拠を制限付きバッチで処理し、ウィキに接続",
    hq_plan_cites: "引用 {base} → {goal} (見積もり、+{n})",
    hq_plan_note:
      "パスは消費したコピーをアーカイブします。sessions/には書き込みません。",
    hq_plan_cancel: "キャンセル",
    hq_plan_run: "実行",
    hq_plan_running: "実行中 — {total}件中{done}件完了",
    hq_done_title: "{n}件を収穫しました",
    hq_done_sub: "引用 {base} → {goal}",
    hq_done_partial:
      "処理対象{copied}件 · 完了{ingested}件 — 残りは_inbox/で待機",
    hq_failed: "収穫に失敗しました",
    hq_empty_title: "昇格できるものが残っていません",
    hq_empty_body:
      "異なる本文{distinct}件のうち、今昇格できるものはありません。保留(200 KB超)のセッションと8 KBを超える新しい会話はこのキューに戻ってきます。",
    hq_empty_cta: "ソースを取り込む",
    hq_loading: "sessions/ を走査中…",
    hq_error: "セッションのアーカイブを読めませんでした",
    hq_retry: "再試行",
    hq_read_partial: "一部のセッションを確認できませんでした。件数は確認済みの下限です。残りのファイルを確認するには再試行してください。",
    hq_read_lower_bound: "少なくとも{n}",
    hq_mini_line: "残り候補{left}件 · これまでに{done}件収穫",
    hq_mini_fold: "収穫キューを折りたたむ",
    ing_refused_title: "保存する内容がありません — 保存しませんでした · {reason}",
    ing_logged_title: "原本だけ保管しました · {reason}",
    ing_noop_reason: "計画の項目はすべてウィキに反映済みです",
    ing_raw_reused: "同じ内容がすでに {path} にあるため、新しく保存しませんでした。",
    ing_raw_name_shared:
      "同じ内容がすでに {path} にありますが、別の原本も同じ名前なので、要約を作るとそちらの要約を上書きしてしまいます",
    ing_dec_update: "修正",
    ing_dec_add: "新規作成",
    ing_dec_merge: "統合",
    ing_dec_noop: "反映済み",
    ing_gate_none_reason: "計画から選ばれた項目はありません",
    sv_rail_label: "パイプラインの進行状況",
    sv_state_reading: "読んでいます",
    sv_state_choosing: "選ぶ番です",
    sv_state_done: "完了",
    sv_details: "詳細",
    sv_step_intake: "流入",
    sv_step_judge: "判定",
    sv_step_gate: "計画",
    sv_step_run: "実行",
    sv_step_backfill: "待機中の資料",
    sv_today_n: "今日{n}件",
    sv_tally: "破棄 {d} · 記録 {l} · 収穫 {h}",
    sv_waiting: "待機中",
    sv_reviewing: "確認中",
    sv_idle: "アイドル",
    sv_running: "実行中",
    sv_done: "完了",
    sv_failed: "失敗",
    sv_cancelled: "キャンセル済み",
    sv_nothing_added: "追加したノートなし",
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
    sv_harvest_sub: "計画の確認へ",
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
    sv_bf_eyebrow: "5 · 待機中の資料 — この画面で最大の未開封の入力",
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
      "E5でローカル検索します。追加のQwenモデルをインストールして選択すると、このMacで検索した原文をまとめます。それ以外は原文を引用します。",
    q_builtin_extractive_note:
      "回答は一致した原文を引用します。ローカルでまとめた回答には、モデル設定でQwenをインストールして選択してください。",
    q_open_model_settings: "モデル設定",
    q_stale_index:
      "この回答は検索インデックスの代わりにボルト全体を使用しました — モデル更新後にインデックスが古くなっています。",
    q_retrieval_failed:
      "検索インデックスに接続できなかったため、この回答はセマンティック検索を行わずボルトを直接読んで作成されました。続く場合はモデル設定の「今すぐ再インデックス」を実行してください。",
    q_extractive_label: "ノートからの抜粋（上位一致・原文）",
    q_extractive_empty:
      "ウィキのインデックスに該当する内容が見つかりませんでした。質問を言い換えるか、モデル設定の「今すぐ再インデックス」を実行してください。",
    q_extractive_stale:
      "意味検索の索引がモデル更新前のもので、キーワード検索でも確認済みの抜粋が見つかりませんでした。モデル設定の「今すぐ再インデックス」を実行してから、もう一度質問してください。",
    q_extractive_failed:
      "検索インデックスに接続できず、該当する箇所を取得できませんでした。続く場合は、モデル設定の「今すぐ再インデックス」を実行してください。",
    q_source_changed:
      "原文が変わったか確認できなかったため、回答を停止しました。再試行して現在のノートを検索してください。",
    q_model_selection_changed: "選択したモデルまたは実行権限が変わったため回答を停止しました。モデルの選択を確認して再試行してください。",
    q_activity_failed: "ローカルモデルが期間を選択するか活動の要約を完成できませんでした。選択した会話モデルの準備を確認して再試行してください。",
    q_activity_incomplete: "選択した期間の記録をすべて確認できませんでした。同じ範囲と期間で再試行してください。",
    q_activity_summary_failed: "選択した期間の記録は見つかりましたが、活動の要約を完成できませんでした。同じ期間で再試行してください。",
    q_answer_review_failed: "回答を元の記録と照合して確認できませんでした。再試行するか質問の範囲を絞ってください。",
    q_activity_insufficient_evidence: "記録は見つかりましたが、この質問を裏付ける活動を十分に確認できませんでした。範囲と期間を確認するか、再試行してください。",
    q_activity_coverage: "{scanned}ページを検索 · 引用元{sources}ページ",
    q_activity_limited: "選択した記録の要約のため、一部の活動が含まれない場合があります。",
    q_local_fallback_timeout:
      "ローカル回答が時間内に準備できませんでした。以下に検索した原文をそのまま引用しています。",
    q_local_fallback_unavailable:
      "選択したローカルモデルを使用できず、回答を作成できませんでした。以下に検索した原文をそのまま引用しています。",
    q_local_fallback_prompt:
      "検索した原文をローカル回答のために準備できませんでした。以下に検索した原文をそのまま引用しています。",
    q_local_fallback_rejected:
      "ローカル回答が検証を通過しませんでした。以下に検索した原文をそのまま引用しています。",
    q_local_fallback_incomplete:
      "ローカル回答を最後まで作成できませんでした。以下に検索した原文をそのまま引用しています。",
    q_local_fallback_failed:
      "ローカル回答を作成できませんでした。以下に検索した原文をそのまま引用しています。",
    q_range_chip: "期間: {s} – {e}",
    q_range_empty: "その期間のノートには、この内容が見つかりませんでした",
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
    q_miss_done: "記録済み",
    q_miss_failed: "この質問を記録できませんでした",
    q_quote_to_note: "ノートに引用",
    q_copy_answer: "回答をコピー",
    q_copied: "コピーしました",
    q_copy_failed: "クリップボードにコピーできませんでした",
    q_quote_pick_note: "引用を貼るノートを選んでください",
    q_back_to_ask: "質問へ",
    q_followup_chip: "前の質問に続けて",
    // Ask renewal (mockup "Strata").
    q_scope_label: "検索範囲",
    q_scope_wiki: "自分のノート",
    q_scope_sessions: "会話の記録",
    q_scope_all: "すべての資料",
    q_scope_wiki_hint: "整理したノートとマップ、日次まとめから探します",
    q_scope_sessions_hint: "AI ツールとの会話から探します",
    q_scope_all_hint: "ノートと会話の記録をまとめて探します",
    q_scope_chip: "範囲 · {scope}",
    q_note_scope_chip: "このノート · {note}",
    q_note_scope_hint: "このノートと直接つながったノートだけから探します",
    q_note_scope_clear: "このノートだけに質問するのをやめる",
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
    q_more_passages: "抜粋をもっと見る({n})",
    q_fewer_passages: "抜粋をたたむ",
    q_jump_to_question: "続けて質問する",
    q_ladder_count: "{n} 件 · 引用 {c} 件",
    q_ladder_all: "出典 {n} 件をすべて見る",
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
    q_abstain_title: "ノートの中に、この内容は見つかりませんでした",
    q_abstain_sub: "似たノートはありましたが、答えになるほど近いものはありませんでした",
    q_abstain_sub_none: "この質問に近いノートは、まだありません",
    q_abstain_details: "詳しく",
    q_abstain_numbers:
      "インデックス済み {n} ページのうち、関連度の下限 {floor} に届く箇所はありません。もっともらしい文を作らず、ここで止まりました。",
    q_abstain_range_numbers:
      "{s}〜{e} の記録には、関連度の下限 {floor} に届く箇所はありません。もっともらしい文を作らず、ここで止まりました。",
    q_abstain_note: "この質問を今日のノートに書き留める",
    q_abstain_noted: "今日のノートに書き留めました",
    q_abstain_note_line: "質問: {q}",
    q_abstain_near: "最も近かったもの — 答えになるほど近くはありませんでした",
    q_abstain_none: "語彙・意味のどちらも何も返しませんでした。",
    q_abstain_lexical: "キーワードのみ",
    q_abstain_gauge_note:
      "赤い目印が下限 {floor} です。「キーワードのみ」はコサインのない語彙ヒットで、単独では根拠になりません。",
    q_abstain_floor_tick: "下限 {floor}",
    q_abstain_harvest: "あとで埋める質問として残す",
    q_abstain_harvested: "あとで埋める質問として残しました",
    q_abstain_widen: "範囲を広げて探し直す",
    q_abstain_range_sub: "{s}〜{e} のノートには、答えになるほど近い箇所がありませんでした",
    q_abstain_widen_range: "期間を外して探し直す",
    q_abstain_receipt: "あとで埋める質問の一覧に残しました",
    q_history: "履歴",
    q_history_search: "過去の質問を探す",
    q_history_none: "一致する過去の質問はありません。",
    q_history_cited: "ノート{n}件",
    q_history_abstained: "見つからず",
    q_history_failed: "エラー",
    q_history_load_failed: "質問の履歴を読み込めませんでした。",
    q_retry: "再試行",
    q_stop: "回答を停止",
    q_elapsed: "経過 {time}",
    q_stopped: "停止",
    q_stopped_sub: "回答が届く前に停止しました。",
    s_archived_sessions_title: "アーカイブ済みセッションも検索",
    s_archived_sessions_desc:
      "セッション範囲が sessions/archive/ も検索します — インデックスが通常除外する冷たい階層です。有効にすると再インデックスします。",
    sb_new_note: "新規ノート",
    sb_new_folder: "新規フォルダ",
    sb_rename: "名前を変更…",
    sb_today_note: "今日のノート",
    sb_new_note_msg: "ノートのタイトルを入力してください。",
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
    sb_row_menu: "{name} のメニュー",
    sb_edited: "{date} に更新",
    sb_n_items: "{n}件",
    delete_policy_wait: "削除設定の読み込み・保存が終わってから再試行してください。",
    set_delete_title: "削除方法",
    set_delete_desc: "mycoの手動削除と自動整理に適用します。原本の保護と削除前に承認が必要な項目の規則は維持されます。",
    set_delete_trash: "ゴミ箱に移動",
    set_delete_permanent: "すぐに完全削除",
    set_delete_enable_msg: "今後はゴミ箱を経由せずに削除します。自動整理ではmycoが作成したと確認できる過去のゴミ箱コピーも削除します。削除した項目はゴミ箱や実行の取り消しで復元できません。有効にしますか?",
    delete_permanent_msg: "{n}件を完全削除します。ゴミ箱から復元できません。",
    delete_permanent_one_msg: "「{name}」を完全削除します。ゴミ箱から復元できません。",
    qz_expires_due_permanent: "期限切れ — 次の整理で完全削除される場合があります",
    deleted_count: "{n}件を完全削除",
    delete_undo_limit: "完全削除したファイルはこの実行を取り消しても復元できません。",
    sb_delete_msg: "{n}件をゴミ箱に移動します。",
    sb_delete_one_msg: "「{name}」をゴミ箱に移動します。",
    sb_selected: "{n}件選択",
    sb_clear_selection: "選択解除",
    sb_new_folder_msg: "フォルダー名",
    sb_rename_msg: "「{name}」の新しい名前:",
    sb_empty_vault: "空のボルト",
    sb_no_vault: "ボルトが選択されていません",
    sb_managed: "mycoの管理フォルダ",
    sb_tree: "ノートとフォルダ",
    sb_managed_hint: "mycoが書いたノートを見分けるには、設定でボールト履歴をオンにしてください。",
    sb_agent_mark: "mycoが作成",
    area_raw: "原本",
    area_sessions: "セッション記録",
    area_cards: "学習カード",
    area_ingest_reports: "取り込みレポート",
    area_work: "整理の候補",
    area_inbox: "追加待ちの資料",
    area_templates: "テンプレート",
    area_audio: "音声録音",
    area_claude: "エージェント向け指示",
    cb_no_results: "結果なし",
    cb_create_q: "「{q}」を作成",
    cb_ask_q: "ウィキに質問: {q}",
    cb_group_actions: "アクション",
    cb_group_recent: "最近",
    cb_group_today: "今日",
    tabbar_label: "メインメニュー",
    cb_group_week: "過去7日間",
    cb_group_goto: "移動",
    cb_group_lenses: "レンズ",
    cb_tag_page: "ページ",
    cb_tag_file: "ファイル",
    cb_tag_note: "ノート",
    cb_tag_action: "操作",
    cb_in_contents: "ページ本文内",
    cb_semantic: "関連（意味）",
    cb_exact: "完全一致",
    cb_operator_hint: "引用符で完全一致 · path: · tag: · type: · status: · confidence:",
    cb_miss_hint: "見つかりませんか？ ⌥⏎ でこの検索を評価セットに記録します。",
    cb_miss_done: "評価セットに記録しました。",
    cb_placeholder: "ノートを探す・移動",
    cb_key_open: "開く",
    cb_key_miss: "見逃した検索を記録",
    cb_results_n: "{n}件",
    cb_chips_label: "絞り込み",
    cb_chip_tag: "タグ",
    cb_chip_folder: "フォルダ",
    cb_chip_type: "種類",
    sb_tags: "タグ",
    sb_tag_chip: "{tag}、ノート{n}件",
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
    sb_st_lagging: "質問で見つけられないノートが {n} 件あります",
    sb_st_reindex: "インデックスし直す",
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
    tb_harvest_running: "収穫中…",
    tb_harvest_copying: "ソースをコピー中…",
    tb_harvest_done: "収穫完了",
    tb_harvest_error: "収穫に失敗しました",
    tb_distill_done: "蒸留完了",
    tb_distill_error: "蒸留に失敗しました",
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
    tb_inflow_header: "今日入ってきたもの",
    tb_inflow_sessions: "セッション取り込み",
    tb_inflow_last_sweep: "最終取り込み {t}",
    tb_inflow_sweep_incomplete: "直近の取り込みが未完了 — インポートを確認してください",
    tb_inflow_sweep_failed: "直近の取り込みに失敗 — インポートを再試行してください",
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
    spot_details: "詳しく",
    spot_sim: "{stem} · 質問との近さ {pct}",
    spot_open_ask: "詳しくは myco の質問ページで確認できます。",
    spot_open_ask_btn: "質問ページで見る",
    spot_no_vault:
      "先に myco でボールトを開いてください — まだ質問する対象がありません。",
    spot_busy: "myco はまだ前の質問に答えています。",
    voice_btn_label: "音声キャプチャ",
    voice_hint_recording: "⏎ 保存 · esc キャンセル",
    capture_inbox_receipt: "{rel} — 次のインジェストに合流します",
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
    gr_zoom_out: "ズームアウト",
    gr_fit: "全体表示",
    gr_zoom_in: "ズームイン",
    h_open_vault: "履歴を見るには vault を開いてください。",
    rf_title: "Reflect の提案",
    rf_lede:
      "ノートを変更せずに読み、どのノートからもリンクされていないノート、古いノート、存在しないノートへのリンクを知らせます。",
    rf_run: "Reflect 実行",
    rf_running: "実行中…",
    rf_running_label: "Reflect 実行中…",
    rf_done: "完了 · {time} · 提案 {n}件",
    rf_failed: "Reflect を実行できませんでした。",
    rf_empty: "すべて片付きました。",
    rf_extractive:
      "内蔵モデルが見つけた結果です。ノート同士のつながりだけを見て、内容は判断しません。",
    rf_item_orphan: "{page} — どのノートからもリンクされていないノート",
    rf_item_unresolved: "{page} — 「{target}」のノートはまだありません",
    rf_create_missing: "ないノートを作成",
    rf_create_progress: "{done}/{total}",
    rf_create_result: "作成したノート: {n}件",
    rf_create_failed: "「{target}」で中断 — 作成できませんでした。",
    rf_create_one: "このノートを作成",
    rf_open_page: "ノートを開く",
    rf_ignore_one: "この項目を今後表示しない",
    ob_title: "myco へようこそ",
    ob_skip: "スキップ",
    ob_back: "戻る",
    ob_next: "次へ",
    ob_finish: "完了",
    ob_step: "{n}/{total}",
    ob_vault_linked: "接続済み",
    ob_vault_none: "まだボールトが接続されていません",
    ob_s1_title: "ノートを置くフォルダを選ぶ",
    ob_s1_body:
      "ノートはこの端末のフォルダ（ボールト）にマークダウンファイルとして保存され、myco を消してもそのまま残ります。",
    ob_s1_action: "フォルダを選ぶ…",
    ob_demo_start: "デモ・ボールトで始める",
    ob_note_title: "最初のノートを書く",
    ob_note_body:
      "思いついたことを書くか、ファイルの内容を取り込みます。最初の行がノートのタイトルになります。",
    ob_note_name: "最初のノート",
    ob_note_ph: "例: 今週学んだこと",
    ob_note_file: "ファイルから取り込む…",
    ob_note_loaded: "{name} の内容を入れました。保存する前に直してもかまいません。",
    ob_note_skip_hint: "今は書くことがなければ、そのまま「次へ」を押してください。",
    ob_note_exists: "同じ名前のノートがすでにあります。最初の行を変えてみてください。",
    ob_note_failed: "ノートを保存できませんでした: {error}",
    ob_note_load_failed: "そのファイルを読み込めませんでした: {error}",
    ob_seed_do: "デモノートを追加",
    ob_s3_title: "ノートに質問してみる",
    ob_s3_body: "答えは自分のノートから探し、どこから来たかを添えて表示します。",
    ob_ask_label: "質問",
    ob_first_question: "これらのノートで最も多く扱っている話題は？",
    ob_first_question_note: "{title}について何を書いた？",
    ob_ask_now: "質問する",
    ob_index_title: "ノートを読んでいます…",
    ob_index_progress: "ノート {total} 件中 {done} 件",
    ob_index_failed: "インデックス作成が完了しませんでした",
    ob_guide_title: "ほかに設定できること",
    ob_imp_title: "これまでのセッションを取り込む",
    ob_imp_body:
      "Claude Code・Codex のセッションを取り込めます。この端末だけでインデックスされ、検索や質問は無料です。",
    ob_imp_claude: "Claude Code セッションを取り込む",
    ob_imp_codex: "Codex セッションを取り込む",
    ob_imp_progress: "ファイル {total} 件中 {done} 件",
    ob_imp_done: "セッション {n} 件を取り込みました",
    ob_imp_quarantined: "{n} 件を保留（シークレットの疑い）",
    ob_hist_title: "ボールト履歴を残す",
    ob_hist_body: "オンにすると、エージェントの変更を単語単位で確認し、元に戻せます。",
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
      "内蔵の韓国語E5とBM25でオフライン検索します。別途導入するQwen3.5 4Bは質問の回答、2Bは確認する取り込み要約に使います。原文引用を保持し、ローカル整理は選択済みのローカル取り込みモデルがあれば使います。",
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
    ci_partial: "取り込み未完了 · 取り込み {i} · スキップ {s} · 失敗 {f}。保留または失敗した資料を確認してください。",
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
      "保存した内容について質問してください。回答と一緒に関連するノートを表示します。",
    s_mascot: "マスコット MYCO を表示",
    s_mascot_hint:
      "ローダー・空の状態・About ページに表示。オフにすると静的ロゴになります。",
    s_roam: "作業中は画面を歩き回る",
    s_roam_hint:
      "時間のかかる作業のあいだ、MYCO がノッチから出て画面を跳ね回り、終わるとノッチに戻ります。作業がないときも、ときどき少しだけ散歩に出ます。「視差効果を減らす」がオンのとき、フルスクリーンのアプリを使っているとき、画面がロックされているときはノッチにとどまります。",
    myco3d_label: "3D の myco。ドラッグか矢印キーで回せます。Home キーで正面に戻ります。",
    myco3d_loading: "myco を準備しています…",
    myco3d_error: "この画面では 3D を表示できないため、画像でお見せしています。",
    s_myco3d: "立体の myco",
    s_myco3d_hint: "黒い myco と白い myco を回して見られます。ドラッグするか、クリックして矢印キーを使ってください。",
    s_myco3d_skin: "色",
    s_myco3d_black: "ブラック",
    s_myco3d_white: "ホワイト",
    myco_spin_label:
      "くるりと回る myco。横にドラッグするか、左右の矢印キーで回せます。Home キーで正面に戻ります。",
    myco_spin_error: "ここでは動画を再生できないため、画像でお見せしています。",
    s_myco3d_view: "表示",
    s_myco3d_video: "動画",
    s_myco3d_model: "立体",
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
    hw_sc_live_link: "ノートのリンクを開く。直すときは矢印キーでリンクの中へ",
    hw_sc_live_link_touch: "ノートのリンクを開く。直すときはリンクのすぐ横をタップしてカーソルを中へ",
    hw_sc_back: "戻る",
    hw_sc_fwd: "進む",
    hw_md: "Markdown · エディタ内",
    hw_sc_bold: "太字（もう一度で解除）",
    hw_sc_italic: "斜体",
    hw_sc_code: "選択をインラインコードに",
    hw_sc_link: "選択をノートへのリンクに",
    hw_sc_highlight: "ハイライト",
    hw_sc_slash: "ブロックメニュー",
    hw_sc_wikilink: "名前でノートをリンク",
    hw_tip_graph1: "星をドラッグするとシミュレーションが周囲で再び動き出します。",
    hw_tip_graph2:
      "F キーで宇宙船に乗れます。レイアウト・スキン・近接惑星は設定ドロワーにあります。",
    hw_tip_graph3:
      "上で問いを選ぶと符号化だけが変わり、左の空白の一覧がその答えです。",
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
    gr_insp_connections: "接続",
    gr_insp_links_out: "リンク",
    gr_insp_backlinks: "バックリンク",
    gr_insp_tags: "タグ",
    gr_insp_open: "リーダーで開く",
    gr_insp_back: "{n} に戻る",
    gr_not_in_graph: "このノートは今グラフにありません。フィルターか除外フォルダーが原因かもしれません。",
    gr_insp_unresolved: "未解決のノート（ファイルなし）",
    gr_insp_none: "—",
    gr_find_ph: "ノートを検索…",
    gr_insp_path_start: "パスの起点に設定",
    gr_insp_path_anchor: "パスの起点",
    gr_insp_path_clear: "クリア",
    gr_insp_path: "パス",
    gr_insp_path_none: "このノードへのパスがありません",
    gr_insp_hops: "ステップ",
    gr_gaps_title: "ギャップ",
    gr_tools: "グラフツール",
    s_back_list: "設定一覧",
    gr_rails_sheet: "ギャップと凡例",
    gr_legend_empty: "まだ表示するものがありません。",
    gr_gesture_hint: "ドラッグで見回し、ピンチで拡大、星をタップすると近くのノートが見えます。",
    gr_gesture_ok: "わかりました",
    gr_gaps_btn: "ギャップ分析",
    gr_gap_missing: "欠落ページ",
    gr_gap_malformed: "不正な形式のリンク",
    gr_gap_orphans: "孤立ページ",
    gr_gap_undercited: "引用不足",
    gr_gap_lowconf: "低確信度",
    gr_gap_disputed: "係争中",
    gr_gap_islands: "未接続",
    gr_gap_none: "ギャップは見つかりませんでした",
    gr_gap_bridges: "リサーチブリッジ",
    gr_gap_ask: "このギャップについて質問",
    gr_bridge_question:
      "「{a}」と「{b}」に関する私のノートは意味的に関連していますが、まだリンクされていません。この 2 つのトピックを結びつけるものは何ですか？ 橋渡しとなるアイデアや、書くべきノートを提案してください。",
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
    gr_motion_hint_myc: "ゆっくりした3D自動回転（3Dビューのみ）",
    gr_advanced: "詳細設定",
    gr_loading: "星座を整列中…",
    gr_ctx_lost: "グラフィックスコンテキストが失われました。",
    gr_retry: "再構築",
    gr_perf_mode:
      "パフォーマンスモード — 大きなグラフではアンビエントレイヤーをオフに",
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
    hn_label: "お知らせ",
    hn_label_n: "お知らせ：確認すること {n} 件",
    hn_empty: "いま確認が必要なことはありません。",
    hn_loading: "ノートを確認しています…",
    hn_error: "お知らせを確認できませんでした。",
    hn_changes: "前回から変わったノート",
    hn_check: "確認が必要なノート",
    hn_contra: "内容が食い違うノート",
    hn_see_all: "すべて表示",
    hn_contra_open: "確認する",
    chk_no_frontmatter: "ノート情報（フロントマター）がありません",
    chk_no_type: "種類（type）が書かれていません",
    chk_bad_type: "種類（type）の値が不明です",
    chk_superseded: "置き換え済みとありますが、どのノートかが書かれていません",
    chk_disputed: "異論ありとありますが、何が違うかが書かれていません",
    chk_citation: "引用している出典がノートに書かれていません",
    chk_footnote: "書かれた出典が本文で使われていません",
    chk_source_count: "出典の数と引用の数が合いません",
    chk_source_count_nan: "出典の数が数字ではありません",
    chk_confidence: "書かれた確信度が出典と合いません",
    chk_other: "確認したほうがよい箇所があります",
    ov_view_runs: "実行を見る",
    ovl_edit: "配置を編集",
    ovl_done: "配置を完了",
    ovl_reset: "既定の配置に戻す",
    ovl_reset_done: "既定の配置に戻しました。",
    ovl_hint:
      "ハンドルをドラッグするか、フォーカスして矢印キーで動かします。ブロックごとに幅を選べます。",
    ovl_span: "幅",
    ovl_span_full: "全幅",
    ovl_move: "{block} を移動 — 矢印キーで位置を変えます",
    ovl_moved: "{block}: {index}/{total}",
    ovl_vacant: "今は表示するものがありません。",
    ovl_b_pulse: "ボルトの脈",
    ovl_b_harvest: "収穫キュー",
    contra_title: "矛盾",
    contra_disputed: "二つのノートの内容が食い違っています",
    contra_stale: "古くなったノート（{t}）を引用しています",
    contra_mark_active: "解決済みにする",
    contra_mark_superseded: "古い内容にする",
    contra_open_page: "このノートを開く",
    contra_open_target: "引用先のノートを開く",
    contra_ignore: "無視",
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
    ritual_keep: "もう一度見る",
    ritual_later: "あとで",
    home_ask_ph: "ノートに質問するか、思いついたことをメモ…",
    home_ask_keys: "Enter で質問 · ⌘Enter で今日のノートに追加",
    home_ask_send: "質問する",
    home_capture_send: "今日のノートに追加",
    home_captured: "今日のノートに追加しました",
    home_capture_failed: "今日のノートに追加できませんでした",
    home_open_daily: "開く",
    home_greet_morning: "おはようございます",
    home_greet_afternoon: "こんにちは",
    home_greet_evening: "こんばんは",
    rd_day_prev: "昨日",
    rd_day_next: "明日",
    history_runs_title: "実行",
    history_run_open_why: "WHY レポート",
    history_run_kind_digest: "会話記録のまとめ",
    history_run_kind_llm: "モデルによる整理",
    history_run_kind_distill: "自動整理",
    history_undo_q: "この実行を元に戻しますか？",
    history_undo_msg:
      "アーカイブ・ゴミ箱に移したノートは復元コピーが残っている場合のみ戻ります。完全削除したファイルは復元できません。作成したページは削除し、実行後に変更したファイルはスキップします。",
    history_no_commit:
      "この実行は履歴 (git) が無効の状態で行われました — ファイル一覧のみ表示します。",
    history_diff_too_large: "ファイルが大きいため差分を表示できません",
    history_status_added: "追加",
    history_status_modified: "変更",
    history_status_renamed: "移動",
    history_status_deleted: "削除",
    auth_badge_human: "人 {h}% · エージェント {a}%",
    auth_badge_last_human: "人による最終編集 {t}",
    rd_auth_section: "作成者",
    auth_filter_pill: "記録上 人のみ",
    auth_filter_hint: "記録上 myco が編集したことのあるノートを一覧から隠します",
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
    notch_failed: "完了できませんでした",
    notch_capture: "クイックメモ",
    notch_capture_save: "⏎ 今日のノート",
    notch_capture_voice: "⌥M 音声",
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
    notch_waiting: "{n}件 待っています",
    notch_agenda_harvest_title: "収穫待ち",
    notch_agenda_links_title: "提案されたリンク{n}件",
    notch_agenda_links_all: "すべてリンク",
    notch_agenda_harvest_sub: "ページになる価値のあるセッション{n}件",
    notch_agenda_harvest: "{n}件を収穫",
    notch_agenda_dropped: "破棄しました",
    s_notch_title: "ノッチのドロップ面",
    s_notch_desc:
      "メニューバーのノッチ下にドロップ面を表示します — ドロップしたファイルは _inbox に入り、取り込みが読みます。",
    tidy_btn: "整理",
    tidy_btn_title: "セッションページに読みやすい名前とつながるリンクを提案します",
    tidy_cmd: "ボールトを整理 (Tidy)",
    tidy_title: "ボールトを整理",
    tidy_lede: "セッションページに読みやすい名前を付け、切れたリンクを直します。適用するまで何も書き込まず、元に戻せます。",
    tidy_loading: "ボールトを確認しています…",
    tidy_empty: "整理するものはありません",
    tidy_error: "ボールトを読み込めませんでした",
    tidy_retry: "再試行",
    tidy_g_titles: "読みやすいタイトルを付ける",
    tidy_g_titles_desc: "セッションの最初の依頼、エージェント、日付から作ります。",
    tidy_g_links: "切れたリンクを直す",
    tidy_g_links_desc: "Related のセッションリンクを要約ページに向け、要約のないリンクは削除します。",
    tidy_g_move: "セッション要約をまとめる",
    tidy_g_move_desc: "wiki/sessions/<月>/ に移動します。リンクはそのまま使えます。",
    tidy_removed: "削除",
    tidy_show_all: "{n}件すべて表示",
    tidy_show_less: "折りたたむ",
    tidy_skipped: "トランスクリプトが見つからずスキップ {n}件",
    tidy_apply: "{n}件のファイルに適用",
    tidy_applying: "適用しています…",
    tidy_done: "{n}件のファイルを整理しました",
    tidy_failed: "{n}件は書き込めませんでした:",
    tidy_undo: "元に戻す",
    tidy_undoing: "元に戻しています…",
    tidy_undone: "{n}件のファイルを元に戻しました",
    tidy_undo_skipped: "実行後に変更されたため、そのままにしたファイル:",
    tidy_changed: "確認した後に変更されたため、そのままにしたファイル:",
    tidy_rescan: "もう一度確認",
    tidy_s_desc: "セッションページに読みやすい名前を付け、リンクを直します。書き込む前にプレビューし、元に戻せます。",
    tidy_s_run: "整理…",
    tidy_s_history: "整理の記録",
    tidy_s_last: "前回 {when} · {n}件",
    tidy_s_last_undone: "元に戻し済み",
    tidy_s_none: "まだ実行していません",
  },
};
