// One Korean word per concept across the ko UI: 볼트 (vault), 노트 (note),
// 자료 추가 (ingest), 정리 (distill), 막힘 (blocked), 원문 (source mode). The
// same Home page once said 볼트, 보관함 and "vault" for one folder, and the
// ingest page said 자료 추가, 가져오기 and 인제스트 for one action. This keeps
// those variants out.
//
// It also keeps the engine's own words off everyday screens (UX S14): 바닥선
// (the relevance floor), 코사인, 게이트, 백필, NOOP, 온톨로지 and 홉. They may
// stay only under a 자세히 / 검색 세부정보 disclosure or in an advanced
// setting, each listed in ALLOW with where it shows.

import { describe, expect, it } from "vitest";
import { GRAPH_LOOK_COPY } from "./graphLookCopy";
import { STRINGS } from "./i18n";
import { INTAKE_COPY } from "./intakeCopy";
import { SETTINGS_NAVIGATION_COPY } from "./settingsNavigationCopy";
import { SETTINGS_SAVE_COPY } from "./settingsSaveCopy";
import { VAULT_ACCESS_COPY } from "./vaultAccessCopy";

// 메모리 (memory) is another word; 노드 is the graph term for a note.
const BANNED =
  /\bvault\b|ingest|인제스트|인게스트|보관함|메모(?!리)|노드|증류|바닥선|코사인|게이트|백필|NOOP|온톨로지|홉/i;

// 가져오기 stays the word for import (Zotero, conversations, backups). On the
// ingest page and its reports it was a second name for 자료 추가.
const INGEST_KEYS = /^(ing|ingest|h)_/;
const IMPORT_WORD = /가져오기|가져온/;

// Keys that must keep a matching word, with the reason.
const ALLOW = new Set<string>([
  "ing_yt_fetch", // "YouTube 자막 가져오기" fetches a transcript; it is not an ingest
  // AbstainCard's 자세히: the page count, the floor and the near-miss gauge.
  "q_abstain_numbers",
  "q_abstain_range_numbers",
  "q_abstain_gauge_note",
  "q_abstain_floor_tick",
  // Ask's 검색 세부정보: the retrieval stepper and the source ladder's numbers.
  "q_trace_bm25_sub",
  "q_trace_dense_sub",
  "q_trace_floor",
  "q_trace_floor_sub",
  "q_trace_params",
  "q_ladder_sr",
  "q_cite_conf_tip",
  // Settings › 자동 정리: the admission gate's strictness preset.
  "set_distill_gate",
]);

/** Every ko value, flattened, as [key, text] with code spans and {placeholders}
 * removed — those are identifiers, not Korean copy. */
function koEntries(): [string, string][] {
  const modules: [string, object][] = [
    ["", STRINGS.ko],
    ["intake.", INTAKE_COPY.ko],
    ["look.", GRAPH_LOOK_COPY.ko],
    ["settingsNav.", SETTINGS_NAVIGATION_COPY.ko],
    ["settingsSave.", SETTINGS_SAVE_COPY.ko],
    ["vaultAccess.", VAULT_ACCESS_COPY.ko],
  ];
  return modules.flatMap(([prefix, table]) =>
    Object.entries(table).map(([k, v]: [string, unknown]): [string, string] => [
      prefix + k,
      (Array.isArray(v) ? v.join(" ") : String(v))
        .replace(/`[^`]*`/g, "")
        .replace(/\{[^}]*\}/g, ""),
    ]),
  );
}

/** `key: text` for every entry that says a banned word outside ALLOW. */
function bannedOffenders(entries: [string, string][]): string[] {
  return entries.filter(([k, v]) => !ALLOW.has(k) && BANNED.test(v)).map(([k, v]) => `${k}: ${v}`);
}

describe("ko glossary", () => {
  it("never says vault, ingest, 인제스트, 보관함, 메모, 노드 or 증류, nor the engine's words", () => {
    expect(bannedOffenders(koEntries())).toEqual([]);
  });

  it("names the key that says an engine word on an everyday screen", () => {
    // The acceptance check: 바닥선 in a plain ko key fails with that key's name.
    expect(bannedOffenders([["q_title", "바닥선 아래"]])).toEqual(["q_title: 바닥선 아래"]);
    // Under 자세히 it may stay.
    expect(bannedOffenders([["q_abstain_numbers", "바닥선 0.42"]])).toEqual([]);
  });

  it("calls an ingest 자료 추가 on the ingest page and its reports, not 가져오기", () => {
    const offenders = koEntries()
      .filter(([k, v]) => INGEST_KEYS.test(k) && !ALLOW.has(k) && IMPORT_WORD.test(v))
      .map(([k, v]) => `${k}: ${v}`);
    expect(offenders).toEqual([]);
  });

  // The sweep once made both read 자료 추가 완료 on one result screen.
  it("keeps a harvested row's outcome apart from the ingest banner", () => {
    for (const lang of Object.keys(STRINGS) as (keyof typeof STRINGS)[]) {
      expect(STRINGS[lang].sv_out_harvest, lang).not.toBe(
        STRINGS[lang].ing_success_title,
      );
    }
  });

  it("names the words that a ban cannot catch", () => {
    const ko = STRINGS.ko;
    expect({
      nav_ingest: ko.nav_ingest,
      ing_title: ko.ing_title,
      ing_success_title: ko.ing_success_title,
      tasks_col_blocked: ko.tasks_col_blocked,
      s_distill: ko.s_distill,
      set_distill_run_now: ko.set_distill_run_now,
      rd_source: ko.rd_source,
      props_complex: ko.props_complex,
    }).toEqual({
      nav_ingest: "자료 추가",
      ing_title: "자료 추가",
      ing_success_title: "자료 추가 완료",
      tasks_col_blocked: "막힘",
      s_distill: "자동 정리",
      set_distill_run_now: "지금 정리",
      rd_source: "마크다운 원문 편집",
      props_complex: "복합 값 — 원문에서 편집하세요",
    });
  });
});

// UX S14.6: the Ask box suggested "BPE는 무엇인가요? 미드트레이닝은…", the
// owner's own research vocabulary, and the suggestions page explained itself
// with "온톨로지". The Ask box now offers the Home chips' examples.
describe("everyday copy in every language", () => {
  const all = (["en", "ko", "ja"] as const).flatMap((lang) =>
    Object.entries(STRINGS[lang]).map(([k, v]) => [`${lang}.${k}`, String(v)] as const),
  );

  it("suggests no research jargon as an example question", () => {
    const offenders = all
      .filter(([, v]) => /\bBPE\b|midtraining|미드트레이닝|ミッドトレーニング/i.test(v))
      .map(([k, v]) => `${k}: ${v}`);
    expect(offenders).toEqual([]);
  });

  it("explains the suggestions page without ontology or a distillation engine", () => {
    for (const lang of ["en", "ko", "ja"] as const) {
      expect(STRINGS[lang].pf_lede).not.toMatch(/ontology|온톨로지|オントロジー|distillation engine|蒸留エンジン/i);
    }
    expect(STRINGS.ko.pf_lede).toBe(
      "자동 정리가 남긴 제안이에요. 새로 모인 노트를 주제로 받아들이거나, 필요 없어진 자료를 삭제하거나, 주제 지도를 만들자는 내용이에요. 살펴보고 승인하거나 무시하세요.",
    );
  });

  // The cards are admit-cluster, archive, delete and topic-map proposals,
  // under 승인 / 무시 buttons. "Merge or connect" described none of them,
  // and an archive or delete read as a merge invites a careless 승인.
  it("says what the suggestions do, with the buttons' own verbs", () => {
    for (const lang of ["en", "ko", "ja"] as const) {
      const s = STRINGS[lang];
      expect(s.pf_lede.toLowerCase(), lang).toContain(s.pf_approve.toLowerCase());
      expect(s.pf_lede.toLowerCase(), lang).toContain(s.pf_dismiss.toLowerCase());
      expect(s.pf_lede, lang).not.toMatch(/합치|이어 보|fitting .* in with|まとめたり|つないだり/i);
    }
  });
});

// S19: Home's contradiction rows spoke in frontmatter values ("해소: active",
// "superseded로"); in ko and ja they say what is going on instead.
describe("contradiction rows", () => {
  it("never show the status values themselves in ko or ja", () => {
    for (const lang of ["ko", "ja"] as const) {
      const rows = Object.entries(STRINGS[lang]).filter(([k]) => k.startsWith("contra_"));
      const raw = rows.filter(([, v]) => /active|superseded|disputed/i.test(String(v)));
      expect(raw, lang).toEqual([]);
    }
  });
});
