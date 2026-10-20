import type { Lang } from "./i18n";

interface GraphLookCopy {
  wovenError: string;
  terrain: string;
  terrainHint: string;
  ribbon: string;
  ribbonHint: string;
  city: string;
  cityHint: string;
  compositionHint: string;
  galaxy: string;
  galaxyHint: string;
  adjusted: string;
  restore: string;
  layoutTuning: string;
  layoutSize: string;
  layoutSizeHint: string;
  spaceHint: string;
  paperHint: string;
  myceliumHint: string;
  pixelHint: string;
  glowHint: string;
  arrowFlowHint: string;
  wovenBundlesHint: string;
  noteLabels: string;
  noteLabelsHint: string;
  nodeSizeHint: string;
  linkThicknessHint: string;
}

export const GRAPH_LOOK_COPY: Record<Lang, GraphLookCopy> = {
  en: {
    wovenError: "Could not arrange the woven graph. Please retry.",
    compositionHint: "Adjust note size, link visibility, and when note names appear.",
    terrain: "Contour terrain",
    terrainHint: "Note tiles across a landscape of ridges and contour lines",
    ribbon: "Woven",
    ribbonHint: "Actual links gather into curved fibers and fan out to their notes",
    city: "Block city",
    cityHint: "Note blocks form districts connected by raised paths",
    noteLabels: "Note name visibility",
    noteLabelsHint: "Lower: names appear sooner. Higher: zoom in to see names.",
    nodeSizeHint: "Use smaller dots when notes overlap. Hover a dot to read its name.",
    linkThicknessHint: "Lower values make links quieter so notes stand out.",
    galaxy: "Spiral galaxy",
    galaxyHint:
      "A bright centre with notes gathered along sweeping spiral arms",
    adjusted: "Adjusted",
    restore: "Restore this look",
    layoutTuning: "Arrangement",
    layoutSize: "Layout size",
    layoutSizeHint:
      "Change the space between notes while keeping this arrangement.",
    spaceHint:
      "Tune the stars and sky. Only effects available in this look are shown.",
    paperHint:
      "Keep the map clear with note colours, sizes and line thickness.",
    myceliumHint:
      "Change the note dots and threads. Choose their colours under Layout.",
    pixelHint: "Use small pixel illustrations in place of smooth star dots.",
    glowHint: "Change how brightly the stars and their light appear.",
    arrowFlowHint:
      "Arrows already show the direction of links. Turn them off to use light pulses.",
    wovenBundlesHint: "Woven already gathers its links into strands, so Bundled strands stays off.",
  },
  ko: {
    wovenError: "직조 그래프를 배치하지 못했어요. 다시 시도해 주세요.",
    compositionHint: "점 크기, 연결선 두께, 노트 이름 표시를 조절해요.",
    terrain: "지형도",
    terrainHint: "등고선과 능선 위로 노트가 펼쳐진 입체 지도예요",
    ribbon: "직조",
    ribbonHint: "실제 연결선이 가닥으로 모였다가 각 노트로 펼쳐져요",
    city: "블록 도시",
    cityHint: "노트 기둥과 연결 통로가 작은 도시를 이뤄요",
    noteLabels: "노트 이름 표시",
    noteLabelsHint: "낮추면 멀리서도, 높이면 확대했을 때 이름이 보여요.",
    nodeSizeHint: "노트가 겹치면 점을 줄여보세요. 점 위에 마우스를 올리면 이름이 보여요.",
    linkThicknessHint: "낮추면 연결선이 옅어져 노트가 더 잘 보여요.",
    galaxy: "나선 은하",
    galaxyHint: "밝은 중심과 길게 감기는 나선 팔을 따라 노트가 모여요",
    adjusted: "조정됨",
    restore: "이 룩 추천값으로 복원",
    layoutTuning: "배치 조정",
    layoutSize: "배치 크기",
    layoutSizeHint: "현재 모양을 유지하면서 노트 사이의 공간을 조절해요.",
    spaceHint:
      "별과 하늘의 모습을 조절해요. 이 룩에서 사용할 수 있는 효과만 보여드려요.",
    paperHint: "점 색상과 크기, 연결선 두께로 지도를 또렷하게 정리해요.",
    myceliumHint:
      "노트 점과 연결 실의 크기를 조절해요. 색상은 배치 항목에서 바꿀 수 있어요.",
    pixelHint: "부드러운 별점 대신 작은 픽셀 그림으로 노트를 표시해요.",
    glowHint: "별과 주변 빛이 얼마나 밝게 보일지 조절해요.",
    arrowFlowHint:
      "지금은 화살표가 연결 방향을 보여줘요. 화살표를 끄면 빛의 흐름을 사용할 수 있어요.",
    wovenBundlesHint: "직조는 이미 연결선을 가닥으로 묶어 보여줘서 번들 스트랜드는 쓰지 않아요.",
  },
  ja: {
    wovenError: "グラフを配置できませんでした。再試行してください。",
    compositionHint: "ノートの大きさ、線の太さ、名前の表示を調整します。",
    terrain: "等高線の地形",
    terrainHint: "等高線と尾根の上にノートが広がる立体地図",
    ribbon: "織り",
    ribbonHint: "実際のリンクが曲線の束に集まり、各ノートへ広がります",
    city: "ブロック都市",
    cityHint: "ノートの柱と接続する通路でできた小さな都市",
    noteLabels: "ノート名の表示",
    noteLabelsHint: "低い値では遠くから、高い値では拡大したときに名前が見えます。",
    nodeSizeHint: "ノートが重なるときは点を小さく。点にカーソルを合わせると名前が見えます。",
    linkThicknessHint: "値を下げるとリンクが控えめになり、ノートが見やすくなります。",
    galaxy: "渦巻き銀河",
    galaxyHint: "明るい中心と大きな渦巻きに沿ってノートが集まります",
    adjusted: "調整済み",
    restore: "この見た目の推奨値に戻す",
    layoutTuning: "配置の調整",
    layoutSize: "配置の大きさ",
    layoutSizeHint: "今の形を保ちながら、ノート同士の間隔を調整します。",
    spaceHint:
      "星と空の見た目を調整します。この見た目で使える効果だけを表示します。",
    paperHint: "ノートの色と大きさ、線の太さで見やすい地図に整えます。",
    myceliumHint:
      "ノートの点と糸の大きさを調整します。色は配置の項目で変更できます。",
    pixelHint: "滑らかな星の点を、小さなピクセル画に置き換えます。",
    glowHint: "星とその周りの光の明るさを調整します。",
    arrowFlowHint:
      "矢印がリンクの方向を示しています。矢印をオフにすると光の流れを使えます。",
    wovenBundlesHint: "織りはリンクをすでに束ねて描くため、バンドルストランドは使いません。",
  },
};
