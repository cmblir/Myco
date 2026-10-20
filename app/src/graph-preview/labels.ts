import type { Point, PreviewNode } from "./model";

interface Label extends Point {
  text: string;
}
interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Prioritize the active note and avoid overlapping approximate text bounds. */
export function placeLabels(
  nodes: PreviewNode[],
  positions: Record<string, Point>,
  active: string | null,
): Map<string, Label> {
  const occupied: Box[] = [];
  const labels = new Map<string, Label>();
  const ranked = [...nodes].sort(
    (a, b) =>
      Number(b.id === active) - Number(a.id === active) || b.degree - a.degree,
  );
  for (const node of ranked) {
    const point = positions[node.id];
    if (!point || labels.size >= 20) continue;
    const text =
      node.label.length > 27 ? `${node.label.slice(0, 26)}…` : node.label;
    const width = text.length * 5.7;
    for (const offset of [
      { x: 12, y: 4 },
      { x: -width - 12, y: 4 },
      { x: -width / 2, y: -14 },
      { x: -width / 2, y: 23 },
    ]) {
      const box = {
        left: point.x + offset.x - 3,
        right: point.x + offset.x + width + 3,
        top: point.y + offset.y - 12,
        bottom: point.y + offset.y + 4,
      };
      if (
        occupied.some(
          (other) =>
            box.left < other.right &&
            box.right > other.left &&
            box.top < other.bottom &&
            box.bottom > other.top,
        )
      )
        continue;
      labels.set(node.id, { ...offset, text });
      occupied.push(box);
      break;
    }
  }
  return labels;
}
