# myco Graph 페이지 UX 감사 (key: graph)

- 대상 트리: `~/prj/karpathy-editor-build/app` (설치본과 동일 상태)
- 실행: Vite `:5473` + `?mock=1` (63 노드 / 95 연결), `?mock=1&big=1500`, `?mock=1&big=6000`
- 브라우저: headless Chromium + SwiftShader (WebGL 소프트웨어 렌더). **fps 수치는 GPU가 없어 참고용일 뿐이며 실제 Mac 성능을 대표하지 않는다.**
- 뷰포트: 1280×900, 1024×700 / 테마: dark, light / 언어: ko (일부 en 대조)
- 스크린샷: `research/shots/graph/` (아래 `shots/…`로 표기)
- 코드 인용은 `app/src/` 기준 상대 경로.
- 스크립트: `graph-lib.mjs`, `g1-overview.mjs` … `g6-ask.mjs`, 로그 `g1.log`…`g6.log`, 콘솔 로그 `graph-log-*.txt`

## 요약

Graph 페이지는 11개 룩 + 12개 레이아웃 칩이 모두 렌더되고 콘솔 에러는 0건(경고는 SwiftShader의 ReadPixels 성능 경고뿐)이다. 문제는 렌더링이 아니라 **공간·상태·설명**이다.

1. **무대(stage)가 너무 작다.** 1280×900에서 캔버스는 488×617px(창의 29%), 설정 드로어를 열면 207px, 인스펙터가 열리면 캔버스가 완전히 가려진다. 1024×700에서는 468×235px 레터박스가 되고 드로어를 열면 188px.
2. **범례가 질문을 따라가지 않는다.** 4개 질문(빈 곳/뭉침/최근/이웃)이 색·크기·밝기 인코딩을 바꾸지만 범례 푸터는 항상 "크기 = 링크 수 · 흐림 = 낮은 신뢰도 · 호박색 = 논쟁 중 · 회청 = 미분류"다. 질문별 인코딩 설명 문자열(`gr_enc_*`)은 i18n에 존재하지만 어디서도 쓰이지 않는다.
3. **상태가 보이지 않는 모드가 많다.** 경로 추적(trace) 모드, 태그/폴더 필터, 타임랩스 진행률, 녹화 중 여부는 무대 위에 아무 표시가 없다. 필터로 0개가 되면 빈 무대만 남고 빈 상태 메시지는 뜨지 않는다.
4. **선택(selected)과 포커스 프레임(focus stack)이 따로 논다.** 갭 행·검색·인스펙터 링크로 고른 노드는 브레드크럼에 남지 않고, 이전 프레임 브레드크럼이 그대로 남는다. Esc는 프레임만 닫고 인스펙터는 닫지 못한다.
5. **그래프→읽기/질문은 되지만 돌아오는 길이 없다.** 리더에는 "그래프에서 보기"가 없고(`graphLink`의 호출자는 PageGraph/uiStore뿐), Ask에서 돌아오면 선택·카메라가 사라지고 씬이 재빌드된다.
6. **용어·문체가 세 갈래.** 노드/노트/메모가 한 화면에 섞이고, 룩 설명은 해요체·한다체·합니다체·명사형이 혼재. "+175 더"와 "+12개 더"가 같은 페이지에 공존.
7. **Terrain / Block city 룩은 완성돼 있지만 UI에서 도달 불가**(프리셋은 있으나 카드/칩에 없음). 반대로 Reset 후에는 어떤 룩 카드도 활성화되지 않는다.

## 1. 레이아웃 · 공간

### G-01 무대가 창의 29%, 드로어를 열면 16% (high)
- 1280×900: `.graph-canvas` 488×617 (`g1.log` inventory.canvas). 좌 갭 레일 216 + 우 범례 레일 216 + 페이지 패딩이 폭을 먹는다. `shots/01-default-ko-dark-1280.png` — 63노드 군집이 캔버스 중앙 1/3에 몰려 있고 나머지는 별 배경.
- 설정 드로어는 무대 컬럼 **안쪽**에 280px로 열려 캔버스가 207px가 된다: `shots/03-drawer-looks.png`. 드로어+인스펙터(290px, `max-width: calc(100% - 24px)`)가 동시에 열리면 그래프가 0px 보인다: `shots/06-inspector-open.png`, `shots/62-1024-drawer-inspector.png`.
- 코드: `styles.css:3387-3395` (`.graph-body` flex, 드로어가 형제로 들어감), `styles.css:4225-4232` (`.graph-drawer` 280px), `styles.css:3623-3630` (`.graph-inspector` absolute 290px).
- Obsidian은 설정을 캔버스 위에 떠 있는 접이식 패널로 두고 캔버스 폭을 유지한다. Notion의 사이드 피커도 콘텐츠 폭을 줄이지 않는다.
- 제안: 드로어를 무대 위 오버레이(`position:absolute; right:0`)로 바꾸고, 인스펙터가 열릴 때 드로어를 자동으로 닫거나 둘을 같은 슬롯(우측 패널 1개, 탭 전환)으로 합친다. 범례 레일은 기본 접힘 + 무대 하단 스트립으로 옮겨 폭을 돌려준다.

### G-02 1024×700에서 무대가 468×235 레터박스 (high)
- 측정: `g4.log` `1024 geometry` — head 81 + bar 86(두 줄로 wrap) + note 38 = 205px가 무대 위에서 소비. 캔버스 468×235, 드로어를 열면 188×235.
- `shots/60-1024-default.png` — 우측 레일이 무대 아래로 내려오면서(`styles/ui.css:379-392` `@media (max-width:1240px)`) 범례 그룹 헤더 "wiki 55"가 고정 푸터(4줄 키)에 **반쯤 가려진다**(시각 버그). 갭 레일은 4행만 보인다.
- `shots/64-1024-crumbs.png` — 브레드크럼 92px로 잘려 "transformer-…".
- 제안: `wide` 페이지에서는 bar를 한 줄로 유지(질문 Segment만 남기고 크기/체크는 드로어 또는 오버플로 메뉴), note를 툴팁/접힘으로, 범례 스트립은 푸터를 리스트 안으로 넣거나 `max-height:22vh`를 푸터 포함 높이로 계산.

### G-03 인스펙터가 선택한 노드를 가린다 (medium)
- `shots/21-node-click-focus.png` — 클릭한 노드로 카메라가 날아간 뒤 인스펙터가 캔버스 우측 60%를 덮어 정작 그 노드는 패널 뒤에 있다.
- 코드: `PageGraph.tsx:546-550` `selectNode` → `focusNode`가 화면 중앙에 맞추고, `.graph-inspector`는 `right:12px` 고정.
- 제안: 인스펙터가 열려 있을 때 `focusNode`의 목표점을 남은 가시 영역 중심으로 오프셋하거나, 인스펙터를 좌측 갭 레일 자리에 탭으로 넣는다.

### G-04 검색 Enter로 날아간 카메라가 너무 가깝다 (medium)
- `shots/53-light-inspector.png`, `shots/92-time-question-stage.png` — 선택 링이 무대를 가득 채우고 이웃 라벨이 사라진다. 질문을 바꿔도 재-fit되지 않는다.
- 코드: `PageGraph.tsx:1842-1866` `focusFind` → `scene.focusNode`.
- 제안: focusNode 거리를 "선택 노드 + 1홉 이웃이 보이는 거리"로 계산하고, 질문 변경 시 `fit()` 옵션 제공.

## 2. 범례 · 인코딩 설명

### G-05 범례 푸터가 질문/룩에 관계없이 고정 (high)
- 11개 룩 + 4개 질문 전부에서 푸터 텍스트 동일: `g3.log` 각 look의 `legendFooter`, `g5.log` "time question legend footer".
- `shots/07-q1-time.png`(최근 무엇이 자랐나 — 색 = 최근성) vs `shots/90-neighbors-no-selection.png`(이웃 — 밝기 = 홉) 모두 같은 범례.
- 코드: `GraphLegend.tsx:86-99` 푸터가 상수. `lib/i18n.ts` ko 4117-4120 `gr_enc_orphans/clusters/time/neighbors`(질문별 설명)는 **어디서도 참조되지 않음**(`grep` 결과 0건).
- 제안: `GraphLegend`에 `question` prop을 넘겨 푸터 첫 줄을 `t.gr_enc_<question>`로 바꾸고, 연대기(strata)일 때는 "x = 마지막 수정일"을 추가.

### G-06 "이 노트의 이웃" 질문에 노트가 없으면 아무 안내가 없다 (medium)
- `shots/90-neighbors-no-selection.png` — 세그먼트만 활성, 그림 변화 없음, 카운트 없음. `g5.log` "neighbours w/o selection".
- 코드: `GraphQuestions.tsx:92-97` count undefined; `gr_q_pick`("노트를 하나 고르세요")는 미사용.
- 제안: 선택이 없을 때 무대 상단에 `gr_q_pick` 배너 + 검색창 포커스.

### G-07 클러스터 라벨이 허브 노트 이름이라 노드 라벨과 중복 (medium)
- `shots/01-crop-labels.png` — "fine-tuning"(굵은 보라, 클러스터) 바로 아래 "fine-tuning"(노드), "rlhf"도 두 번.
- 코드: `lib/clusterLabels.ts:106` `name = graph.getNodeAttribute(topId,"label") || stem(topId)`.
- 범례 행도 같은 이름(`shots/01-default…`: 범례 "transformer-archite… 14", "rlhf 11")이라 브레드크럼에서 커뮤니티 프레임과 노드 프레임을 구분할 수 없다(`g1.log` "crumbs after legend click=[transformer-architecture]").
- 제안: 클러스터 라벨에 접두/스타일 구분("◉ rlhf 외 11" 또는 폴더/토픽명), 브레드크럼 칩에 kind 아이콘.

### G-08 클러스터 라벨끼리 겹침 (medium)
- `shots/40-look-01-시그마_보드.png`, `shots/40-look-05-종이_지도.png`, `shots/40-look-08-월러스_트리.png` — "agents"와 "transformer-architecture"가 포개짐.
- 제안: 클러스터 라벨 레이어에 간단한 충돌 회피(세로 오프셋) 또는 겹치면 작은 쪽 숨김.

### G-09 범례 구조가 룩에 따라 트리/평면으로 바뀌지만 설명 없음 (low)
- 기본(auto/galaxy): "wiki 55 ▸ 클러스터" 트리(`shots/01…`). 나선 은하/시그마/종이: 평면 6행(`shots/40-look-00…`). 프리셋이 `folderGalaxies`를 함께 바꾸기 때문(`lib/graphSettings.ts:578-640`).
- 제안: 범례 헤더에 "폴더별 / 주제별" 토글 상태를 표시하거나 프리셋에서 folderGalaxies를 분리.

### G-10 "+N 더"가 막다른 길 + 형식 불일치 (medium)
- `shots/80-big-1500.png` — 갭 레일 "+175 더", 범례 "+12개 더". 클릭 불가, 펼칠 방법 없음.
- 코드: `GraphGaps.tsx:155-159` (`+{n} {t.gr_gap_more}` → "+175 더"), `GraphLegend.tsx:74-79` (`t.gr_more` "+{n}개 더").
- 제안: 하나의 문자열(`gr_more`)로 통일하고 `<button>`으로 만들어 8→32→전체 순으로 펼침, 또는 레일 내 검색.

## 3. 상태(5-state) · 막다른 길

### G-11 필터 결과 0개 = 빈 무대, 빈 상태 메시지 없음 (high)
- `shots/31-filter-zero-nodes.png` — 드로어 검색 "zzzz…" 입력 후 무대는 비네트만, 안내 없음. 갭 레일 "갭 없음", 범례 레일 사라짐. 노트 줄은 "0 노드 · 0 연결 · 이 그래프가 그리는 건 0개 노드 · 첫 실행 샘플 0개(0%) …"로 무의미한 통계를 출력.
- 코드: `PageGraph.tsx:2234` `totalNodes === 0` 조건이 **필터 전** `countAllNodes(adjacency)`를 보므로 필터 0건에는 절대 참이 안 됨. `PageGraph.tsx:852` `if (graph.order === 0) return;` 뒤에 아무 UI도 없음.
- 제안: `counts.nodes === 0 && totalNodes > 0`일 때 "필터에 맞는 노트가 없어요 — [필터 지우기]" 상태를 무대 중앙에 표시.

### G-12 활성 필터가 드로어를 닫으면 보이지 않음 (high)
- `shots/32-tag-filter.png` — 태그 #analysis 필터로 2노드만 남았지만 툴바/바에 필터 칩이 없다(`g2.log` "anyFilterIndicatorOutsideDrawer:false"). 설정은 localStorage(`myco.graph.settings.v26`)에 **영속**되므로 다음 실행에도 2노드만 보이고 이유를 알 수 없다.
- 코드: `GraphControls.tsx:330-394` 필터 UI는 드로어 안에만, `PageGraph.tsx:2058-2066` bar에는 없음.
- 제안: bar 우측에 활성 필터 칩("#analysis ×", "폴더: wiki ×", "검색: … ×")을 렌더. Obsidian은 필터 텍스트를 항상 보이는 필드에 둔다.

### G-13 경로 추적(trace) 모드가 켜져 있어도 무대에 표시가 없다 (medium)
- `g3.log` "trace on (drawer closed) → overlays:[loading-tip], cursor:auto, toolsPressed:[]", `shots/42-trace-on-drawer-closed.png`. 첫 노드를 찍은 뒤에도 "끝 노드를 고르세요" 힌트 없음(`shots/43-trace-start-picked.png`).
- 코드: `PageGraph.tsx:321-334` 상태만 있고 렌더 없음; 토글은 드로어 "모션·효과" 섹션 깊숙이(`GraphControls.tsx:752-757`) — 우주선 모드는 툴바 버튼이 있는데 trace는 없음(비대칭).
- 제안: 툴바에 trace 토글 버튼(aria-pressed) + 무대 상단 상태 배너("경로 추적: 시작 노드를 클릭하세요 → 끝 노드를 클릭하세요") + 커서 `crosshair`.

### G-14 타임랩스/녹화에 진행률·녹화 중 표시가 없다 (medium)
- `shots/29-timelapse-mid.png` — 아이콘만 ⏸로 바뀜. 녹화(`●`)는 눌러도 아무 표시 없이 끝날 때 파일이 떨어진다(`PageGraph.tsx:1681-1712`).
- `●` 아이콘은 무채색이라 녹화 버튼으로 읽히지 않음(`shots/30-focus-ring-toolbar.png`).
- 제안: 무대 하단 얇은 진행 바 + "N/63 노트" 카운터, 녹화 중엔 빨간 점 + 경과 시간, 완료 시 알림("myco-timelapse.webm 저장됨").

### G-15 멀티버스에서 질문 바·노트 줄이 그대로 남는다 (low)
- `shots/33-multiverse.png` — 레일은 사라지지만 질문 Segment/크기/체크박스와 "63 노드 · 95 연결…" 노트 줄이 그대로. 버블 라벨은 6px 수준으로 읽을 수 없음(`shots/33-crop-labels.png`).
- 코드: `PageGraph.tsx:2058-2067` bar/note가 `showMultiverse`로 게이트되지 않음.
- 제안: 멀티버스에서는 bar를 "우주 N개 · 클릭해서 들어가기"로 교체, 버블 라벨을 CSS2D 고정 크기로.

### G-16 리더로 가면 돌아올 길이 없다 (high)
- `shots/100-reader-from-graph.png` — "리더에서 열기" 후 리더에는 그래프 관련 버튼이 0개(`g6.log` graphLinks:[]). `lib/graphLink.ts`의 호출자는 `uiStore.ts`/`PageGraph.tsx`뿐 → 다른 페이지에서 그래프의 특정 노트로 들어오는 경로가 없다.
- Ask로 갔다가 사이드바로 돌아오면 선택·프레임·카메라가 사라지고 씬이 처음부터 재빌드(인트로 재생)된다(`g6.log` "back on graph: insp:false, crumbs:0, rebuild 3회"). `PageGraph.tsx:806-1324` 빌드 이펙트가 마운트마다 실행되고 `introPlayedRef`도 마운트 단위.
- 제안: 리더 헤더/Connections 레일에 "그래프에서 보기"(`openGraphAt(path)`) 추가; 그래프 페이지의 selected/focusStack/camera를 uiStore에 보관해 복귀 시 복원.

### G-17 "링크 제안" 프리필이 한 줄 입력에 잘려 보인다 (low)
- `shots/97-ask-prefilled-from-graph.png` — 두 문장짜리 질문이 single-line input에서 잘림. 자동 제출은 안 됨(의도된 듯).
- 제안: Ask 입력을 auto-grow textarea로, 또는 프리필 시 "그래프에서 가져온 질문" 칩을 위에 표시.

## 4. 선택 · 포커스 · 키보드

### G-18 선택과 포커스 프레임의 불일치 (high)
- 캔버스 클릭 = 선택 + 1홉 프레임(브레드크럼). 갭 행/검색/인스펙터 링크 클릭 = 선택만. 그래서 `shots/23-gap-label-selected.png`처럼 인스펙터는 "CLAUDE", 브레드크럼은 "transformer-architect… ×"가 동시에 보인다(`g2.log` "after gap label click: insp CLAUDE, crumbs 2").
- 코드: `PageGraph.tsx:546-550` `selectNode`(프레임 없음) vs `PageGraph.tsx:675-729` `handleNodeClick`(프레임 push).
- 제안: 선택 경로를 하나로 — `selectNode`도 프레임을 push하거나, 브레드크럼이 "포커스 프레임"과 "선택"을 두 칩으로 분리 표시.

### G-19 Esc가 인스펙터를 닫지 못한다 / 도움말도 Esc로 안 닫힘 (medium)
- `g5.log` "Esc with inspector open (find-selected): still open = 1 … 2nd Esc: still open". 프레임이 없으면 `popFrame()`이 false를 돌려주고 끝(`PageGraph.tsx:760-769`).
- 제스처 안내 팝오버도 Esc 무시(`g1.log` "help closes on Esc? false"; `GraphHelp.tsx` 키 핸들러 없음). 도움말에는 "Esc = 포커스에서 한 단계 나가기"라고 적혀 있어 기대와 어긋난다.
- 제안: Esc 우선순위를 도움말 → 인스펙터 → 프레임 → 우주선 순으로 한 핸들러에서 처리.

### G-20 더블클릭 2홉 확장을 재현하지 못함 (medium, 미확정)
- `page.mouse.click` 후 `dblclick`을 350ms 안에 보내도 브레드크럼에 "⁺²"가 붙지 않음(`g3.log` "crumbs after dblclick: [transformer-architecture]"). `graphScene.ts:5347-5371`의 pointerup 경로에서 두 번째 클릭이 drag 판정/`downAt` 초기화에 걸릴 가능성. 헤드리스 이슈일 수 있어 실기기 확인 필요.
- 제안: 실기기에서 재확인; 안 되면 더블클릭 대신 브레드크럼 칩에 "1홉 / 2홉" 토글을 둔다(더 발견 가능함).

### G-21 캔버스는 키보드로 닿을 수 없고, 레일은 탭이 너무 많다 (medium)
- `g2.log` tab sequence: 캔버스 `tabIndex=-1`, 노드 이동 단축키 없음. `gr_canvas_aria`("방향키로 노트를 옮겨 고르고, Enter로 엽니다")는 미사용 문자열.
- 갭 레일은 행마다 label + 열기/링크/수확 = 4 tab stop, 8행이면 32번 Tab을 눌러야 범례에 닿는다.
- 포커스 링 불일치: `.u-rail__grouphead`/`.u-rail__label`은 브라우저 기본 `auto/1px`, 나머지는 `2px solid accent`(`styles/ui.css:15-24`에 두 클래스가 빠져 있음).
- 제안: 캔버스에 `tabIndex=0` + 방향키로 이웃 순환·Enter 열기·Space 포커스 프레임; 레일 행 액션은 `roving tabindex`(행에서 →로 진입); 두 클래스를 포커스 링 목록에 추가.

### G-22 갭 행의 hover 액션이 이름을 가린다 (medium)
- `shots/06-inspector-open.png`, `shots/23-gap-label-selected.png`, `shots/99b-bridge-hover.png` — hover 시 라벨이 32%로 줄어 "transfo…", "CLAUD", "fine-tu…"가 되고 "수확"은 레일 밖으로 잘린다.
- 코드: `styles/ui.css:803-806` `max-width: 32%`; 레일 폭 216px(`styles.css:3401`).
- 제안: 액션을 행 아래 두 번째 줄 또는 `…` 메뉴 하나로 접고, 활성 행에만 펼친다. 폭 216px에서 3개 텍스트 버튼은 무리.

### G-23 인스펙터 헤더가 스크롤에 따라 사라진다 (low)
- `shots/94-inspector-scrolled.png`, `shots/26-path-far.png` — 제목과 × 버튼이 스크롤 아웃. 링크 행 클릭 후 scrollTop 유지(`g5.log` "after link row click scrollTop:55").
- 코드: `styles.css:3623-3644` `overflow-y:auto`, 헤더 sticky 아님.
- 제안: `.graph-insp__head { position: sticky; top: 0 }`, 노드 변경 시 scrollTop=0.

## 5. 설정 드로어 · 룩

### G-24 Terrain / Block city 룩이 UI에서 도달 불가 (medium)
- `lib/graphSettings.ts:649-668` `VIBE_PRESETS.terrain`, `.city` 존재, `lib/graphLookCopy.ts` 3개 언어 카피 존재, `PageGraph.tsx:108` SURFACE_LAYOUTS 포함. 그러나 `GraphControls.tsx:76-90` `vibeMeta`와 `421-446` 레이아웃 칩 목록에 없음.
- localStorage로 주입하면 정상 렌더: `shots/46-hidden-terrain.png`(등고선 지형, 라벨 양호), `shots/46-hidden-city.png`(블록 도시). 활성 카드 none.
- 제안: 카드 2장 추가(카피는 이미 있음) 또는 의도적 제거라면 프리셋·카피·SURFACE_LAYOUTS에서 삭제.

### G-25 Reset 후 어떤 룩도 활성이 아니고, 기본 룩으로 돌아갈 카드가 없다 (medium)
- `g2.log` "after reset active look=none", `shots/36-after-reset.png`. DEFAULT는 skin auto + layout galaxy인데 카드 "나선 은하"는 galaxy skin + spiral layout(`lib/graphSettings.ts:578-583`).
- `gr_vibe_living`("살아있는 은하 — 기본값") 문자열은 미사용.
- 제안: "기본(앱 테마)" 카드를 첫 칸에 두거나 Reset을 카드 행에 포함.

### G-26 드로어 진입점이 둘 (low)
- 툴바 ⚙(`PageGraph.tsx:2029-2045`)과 무대 우상단 ☰(`GraphControls.tsx:139-158`, `shots/40-look-00…` 우상단)이 같은 드로어를 연다. 타임랩스 재생도 툴바 + 드로어 푸터 두 곳, 우주선도 툴바 + 드로어 토글.
- 제안: 하나로. 드로어 푸터의 타임랩스는 속도 슬라이더만 남긴다.

### G-27 드로어 전체 높이 3,705px, 46개 라벨 (low)
- `g1.log` "drawer scrollHeight=3705", `shots/04-drawer-all-*.png`. 모션·효과 섹션에만 토글 13개.
- 룩 카드 11장이 세로로 늘어서 스크롤 없이는 5장만 보임(`shots/03-drawer-looks.png`).
- 제안: 룩 카드를 2열 그리드 또는 가로 스크롤 칩으로; "모션·효과"는 "잔잔함/기본/화려함" 3단 프리셋 + 고급 접기.

### G-28 "씬 재빌드 N회 · X ms" 칩은 개발 계측 (low)
- 모든 스크린샷 우측 상단. `GraphQuestions.tsx:130-134`. 사용자에게 의미 없고 "3,039.5 ms" 같은 숫자가 느리다는 인상만 준다.
- 제안: DEV 빌드에서만 표시하거나 도움말 팝오버 하단으로 이동.

### G-29 룩 첫 프레임의 fit이 너무 멀다 (medium)
- `shots/40-look-06-연대기.png`, `shots/41-chip-연대기.png` — 시간축 차트가 무대의 25%; "—2023 2024 2025 2026" 눈금이 붙어 있음. `shots/40-look-10-직조.png` — 직조 그래프가 중앙 1/6 크기. `shots/40-look-00-나선_은하.png` — 라벨 0개(`g3.log` labels:0).
- 제안: 정적 레이아웃의 `fit()` 패딩을 1.05 수준으로 줄이고, 연대기는 축 라벨 최소 간격 보장.

### G-30 라이트 테마·종이 룩에서 무대 경계가 사라짐 (low)
- `shots/52-light-paper.png` — 흰 무대 + 흰 앱 배경, 테두리 없음; ☰ 토글이 허공에 떠 있음. `shots/50-light-default.png` — auto 스킨이 라이트에서 회색 비네트로 그래프가 작고 흐림.
- 제안: `.graph-canvas-wrap`에 1px `--line` 테두리 + radius(레일 카드와 동일 스타일).

### G-31 대형 볼트에서 인스펙터/레일 정보량 (medium)
- `?big=6000`: ready 4.0s, 씬 빌드 3.0s(`g4.log`), 성능 배너 표시(`shots/80-big-6000.png`). 갭 레일 "아무도 참조 안 함 748" 중 8개만, 범례 "+27개 더". 무대는 라벨 3개뿐인 덩어리.
- 필터 토글 한 번에 재빌드 1.2–1.4s(`g4.log` "filter toggle → ready again 2344ms/5007ms") — 드로어 토글마다 전체 씬이 죽었다 살아난다. 실기기 GPU라도 빌드 ms는 CPU 작업이므로 유효.
- 제안: 필터 변경은 `hidden` 속성 토글로 처리(타임랩스가 이미 쓰는 경로 `PageGraph.tsx:1729`), 큰 볼트에서는 갭 레일을 "상위 N + 검색"으로.

## 6. 용어 · 한국어 문구 · 일관성

### G-32 노드/노트/메모 혼용 (medium)
- 같은 페이지: "노트 찾기…"(`gr_find_ph`), "63 노드"(`gr_node_count`), "고립 노드 표시"(`gr_show_orphans`), "메모 이름 표시"(`graphLookCopy.ts` ko `noteLabels`), "메모가 겹치면 점을 줄여보세요"(`nodeSizeHint`), "내가 쓴 노트 8개"(`gr_honest`). 사이드바는 "내 메모 / 새 노트".
- 제안: 사용자 대면은 "노트"로 통일, "노드"는 도움말 안에서만.

### G-33 룩 설명 문체 혼재 (low)
- `lib/i18n.ts` ko 4181-4192: "암흑물질 필라멘트 — 링크가 그림을 만든다"(한다체), "자라난 균사 매트 위에 노트를 걸었습니다"(합니다체·과거), "주제별 별자리, 깊은 우주 하늘"(명사형) vs `lib/graphLookCopy.ts:60-90` ko "…메모가 모여요"(해요체). 화면: `shots/03-drawer-looks.png`.
- "구 안의 하이퍼볼릭 스패닝 트리 (CAIDA Walrus)"는 일반 사용자에게 전문 용어.
- 제안: 해요체 한 줄로 통일("~해요/~보여요"), 학술 참조는 툴팁으로.

### G-34 페이지 eyebrow가 "더 보기" (low)
- `PageGraph.tsx:1918` `eyebrow={t.nav_tools}` → 화면 상단 "더 보기 / 그래프"(en "MORE TOOLS / Graph"). 다른 페이지는 소속 섹션명. `shots/01…` 좌상단.
- 제안: eyebrow를 "지식 지도" 같은 카테고리명으로, 또는 생략.

### G-35 인스펙터 중복 정보·버튼처럼 보이는 값 (low)
- `shots/23-gap-label-selected.png` — 배지 "인용 0"과 행 "인용 0"이 중복(`GraphInspector.tsx:110`, `164-166`). 값 배지(`high`, `active`, `technique`)가 영문 원문 그대로이고 버튼 모양이라 클릭 가능해 보인다(`.graph-insp__badge`).
- 제목은 frontmatter `title`("Attention Mechanism")인데 브레드크럼·범례·갭 행은 stem("attention-mechanism")이라 같은 노트가 두 이름으로 보인다(`GraphInspector.tsx:89`).
- 제안: 배지 하나로, 값은 i18n(높음/활성/기법), 이름은 한 가지 규칙(title 우선, 없으면 stem)으로 전 페이지 통일.

### G-36 연구 다리 행의 액션 라벨이 "링크"인데 동작은 "질문" (medium)
- `shots/99b-bridge-hover.png`, `g6.log` `bridge action label="링크" title="이 갭에 질문하기"`. `GraphGaps.tsx:108-116`이 `gr_act_link_s`를 재사용.
- 제안: `gr_gap_ask` 짧은 형("질문")을 라벨로.

### G-37 노트 줄이 같은 숫자를 두 번 말한다 (low)
- "63 노드 · 95 연결 · 이 그래프가 그리는 건 63개 노드 · …" (`GraphQuestions.tsx:58-73`, `shots/01…`). 영어도 "63 nodes · 95 links · This graph draws 63 nodes".
- 제안: 첫 항목 제거.

### G-38 미사용 i18n 키 정리 (low)
- 0 참조: `gr_canvas_aria, gr_lede, gr_q_orphans_u/clusters_u/time_u/neighbors_u, gr_q_sub_*, gr_q_pick, gr_enc_*, gr_gaps_btn, gr_gap_malformed, gr_gap_disputed, gr_display, gr_text_fade, gr_brightness, gr_recommend(_hint), gr_vibe_living(_desc), gr_pixel_nodes_hint`. 이 중 `gr_enc_*`, `gr_q_pick`, `gr_canvas_aria`는 실제 UX 공백(G-05, G-06, G-21)을 메우는 문구다.

### G-39 알림 토스트가 툴바를 덮음 (low)
- `shots/95-want-notice.png` — "수확 대상으로" 성공 토스트가 페이지 툴 버튼(▶ ● 🚀 …) 위에 겹친다.
- 제안: NoticeStack 위치를 콘텐츠 하단 또는 헤더 아래로.

### G-40 터치 타깃 32px (low)
- 툴바 IconButton 32×32(`styles/ui.css:88-94`), 갭 행 액션 quiet 버튼 ~24px 높이. 프로젝트 지침 44px 미달(데스크톱 우선이라 low).

## 7. 안정성 · 성능 관찰

- 콘솔 에러 0건(모든 런). 경고는 SwiftShader `GPU stall due to ReadPixels` 2건뿐 — 실기기 무관.
- `shots/36-after-reset.png` 드로어 위 초록 세로줄(`36-crop-glitch.png`)은 MYCO 카메오 `<video>`(VP9 webm, `MascotCameo.tsx:19,238`)가 헤드리스에서 깨진 것으로 보이며 **실기기 재현 필요, 결함으로 단정하지 않음**.
- 63노드 씬 빌드 1.0–3.0s(`씬 재빌드` 칩; 헤드리스 CPU). 룩 전환 시 ready까지 0.3–6.2s(`g3.log`). 신경계 6.2s, 시그마 5.4s, 종이 5.5s(FA2 슬라이스).
- 검색창 타이핑은 재빌드를 일으키지 않음(확인: `g4.log` "rebuild after typing" 불변) — 설계 의도대로 동작.
- 우주선 모드: HUD·속도·Esc 종료 정상(`shots/27-fly-hud.png`, `g2.log`). 전체화면 전환 시 사이드바/헤더가 사라지는데 "F" 안내 외에 돌아오는 법은 우상단 "나가기 ✕"뿐 — 충분.
- 멀티버스 진입/복귀 정상. 저장된 룩 저장/삭제 정상(삭제 확인 없음, 칩 단위라 허용).

## 8. Notion / Obsidian 사용자가 기대할 것 중 없는 것

| 기대 | 현재 | 근거 |
|---|---|---|
| 필터 텍스트가 항상 보이는 필드(Obsidian) | 드로어 안에만 | G-12 |
| 캔버스가 창을 채움, 설정은 오버레이(Obsidian) | 레일 2개 + 드로어가 폭을 먹음 | G-01, G-02 |
| 노트 hover 시 미리보기 카드(Obsidian hover preview) | hover는 하이라이트만, 툴팁 없음 | `g5.log` hover tooltip:0 |
| 로컬 그래프 ↔ 전체 그래프 왕복(Obsidian local graph) | 리더에 그래프 진입점 없음 | G-16 |
| 색 그룹을 사용자가 정의(Obsidian color groups) | 커뮤니티/폴더 자동색만 | `GraphControls.tsx:543-553` |
| 그래프 검색이 뷰를 필터(Notion/Obsidian) | 검색창은 fly-to, 필터는 드로어 — 두 검색 | `PageGraph.tsx:1823-1866` vs `GraphControls.tsx:319-328` |
| 키보드로 노드 탐색 | 없음 | G-21 |
| 되돌리기 가능한 뷰 상태(뒤로가기) | 페이지 복귀 시 초기화 | G-16 |

## 9. 우선순위 요약

| # | 항목 | impact | effort |
|---|---|---|---|
| G-01/02 | 무대 공간 회복(드로어 오버레이, 레일 접기, bar 한 줄) | high | M |
| G-05 | 질문별 범례 | high | S |
| G-11/12 | 필터 0건 빈 상태 + 활성 필터 칩 | high | S |
| G-16 | 리더→그래프 링크 + 복귀 시 상태 복원 | high | M |
| G-18/19 | 선택=프레임 단일화, Esc 우선순위 | high | S |
| G-13/14 | trace/타임랩스/녹화 상태 표시 | medium | S |
| G-21/22 | 키보드 노드 탐색, 레일 액션 접기, 포커스 링 | medium | M |
| G-24/25 | Terrain/City 카드, 기본 룩 카드 | medium | S |
| G-32/33/36/37 | 용어·문체·라벨 정리 | medium | S |
| G-07/08/29 | 클러스터 라벨 중복·겹침, 첫 fit | medium | M |
| G-31 | 필터를 hidden 토글로(재빌드 회피) | medium | L |
| 나머지 | low | S |
