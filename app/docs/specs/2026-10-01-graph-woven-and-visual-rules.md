# Graph: bring 직조 (Woven) up to the other looks, and write the graphics rules

Owner, 2026-10-01: "그래프의 직조가 좀 이상한데, 다른 은하랑 퀄리티가 너무 차이가 나고 혼자 이상한
그래픽이야. 그래픽 룰도 같이 만들어서 앞으로 개발할 때 해당 개발에서는 참고할 수 있게끔 해줘."

The Woven look (`ribbon` in `lib/graphLookCopy.ts`, drawn by `lib/wovenGraphLayer.ts`,
`lib/wovenLayout.ts`, `lib/wovenLayout.worker.ts` and `lib/edgeBundles.ts`) is the odd one out
next to the galaxy family. Its idea stays: real links gather into strands, then fan out to each
note. Its rendering has to read as the same product as the other looks.

## Part 1: measure, then write the rules

1. Render every look the Graph page offers on the same mock vault, at 1280×900, in light and
   dark, from the same camera framing, and save the screenshots. Look at them.
2. Read the code that draws each look. Write down the values the good looks share: the
   palette and how colours are picked per galaxy and cluster, point size and its range, glow
   and bloom, line alpha and width, the background and backdrop, label typography and when
   labels show, hover and selection states, motion, and the reduced-motion behaviour. Note
   that the continuous render loop is intentional (memory: graph render loop) and must not
   become idle-when-static.
3. Write `app/docs/design/graph-visual-rules.md`. It is the reference for every future graph
   change.
   - **Shared tokens:** the actual values and where each lives in code (module and export).
   - **Rules:** written as "must" or "must not", each with its reason.
   - **New look checklist:** what to check before a look ships, with the screenshot set from
     step 1 as the method.
   - **Known exceptions:** listed explicitly.
   Measured values only, nothing invented.
4. Add one line to the repo root `CLAUDE.md`, under Rules, pointing graph work at that file.
5. Pin the rules that can be checked in code with a vitest. For example: every look takes its
   colours from the shared palette module, labels use the shared label style, and a look's
   point sizes stay inside the shared range. The test must fail when a look breaks a pinned
   rule.

## Part 2: rebuild Woven's rendering to the rules

1. List every way Woven breaks the rules, from the screenshots and the code.
2. Fix each one in Woven's own files. Reuse the shared materials, palette, labels and
   backdrop instead of Woven-only ones. Strands are drawn as soft, tapered, additive light in
   the cluster's hue, consistent with the other looks' lines, not as flat opaque ribbons.
   Keep the strand-then-fan layout idea and the existing layout worker.
3. Hover, selection, focus, search highlight, labels and the side rails behave exactly as in
   the other looks.
4. Performance: frame time at the mock vault and at the 2,000-node synthetic graph the existing
   perf tests use must not regress against HEAD. Measure it, don't assume it.

## Acceptance

- The rules doc exists, uses measured values, and `CLAUDE.md` points to it.
- The rules test passes for every look and fails on a deliberately broken look. Try it, then
  revert the break.
- Before and after screenshots of Woven next to two galaxy looks, light and dark, are
  looked at and kept under the stage's scratchpad folder. The report names what changed.
- `npm run lint`, `npx tsc -b` and `npx vitest run` are green. The graph browser checks pass
  at 1280×900 and 1024×700.
