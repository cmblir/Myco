// Cluster names for the "무엇이 뭉쳐 있나" question — one per sized community,
// drawn by the canvas on the cluster's hull. Label text v1 = the community's
// top-degree note name: free and identical to what the legend used to show, so
// the two never disagreed. v2 (LLM topics): resolveClusterTopic() asks the
// bundled local model for a 1-3 word topic (cached by member set, serialized,
// heavily sanitized) and the caller upgrades the text in place when it
// arrives. The fallback never waits on it and survives every failure mode.
//
// Pure (no DOM, no renderer) — the old three.js CSS2D wrapper is gone.
import { stem, type VaultGraph } from "./graphData";
import { resolveClusterTopic } from "./clusterTopics";

/** Communities smaller than this are dust, not a topic worth naming. */
export const MIN_CLUSTER_MEMBERS = 3;
/** How many (size-ranked) clusters get an LLM topic — the model is shared
 * with chat/ingest and each call is a serialized local_query. */
export const MAX_TOPIC_UPGRADES = 6;

export interface ClusterLabel {
  community: number;
  memberIds: string[];
  /** Top-degree member's note name until a topic upgrades it. */
  text: string;
  color: string;
}

/** Every sized community, biggest first, named after its highest-degree member. */
export function clusterLabels(graph: VaultGraph): ClusterLabel[] {
  const members = new Map<number, string[]>();
  const top = new Map<number, { id: string; deg: number }>();
  graph.forEachNode((id, a) => {
    if (a.community < 0) return;
    (members.get(a.community) ?? members.set(a.community, []).get(a.community)!).push(id);
    const cur = top.get(a.community);
    if (!cur || a.deg > cur.deg) top.set(a.community, { id, deg: a.deg });
  });
  return [...members.entries()]
    .filter(([, ids]) => ids.length >= MIN_CLUSTER_MEMBERS)
    .sort((a, b) => b[1].length - a[1].length || a[0] - b[0])
    .map(([community, memberIds]) => {
      const hub = top.get(community)!;
      return {
        community,
        memberIds,
        text: stem(hub.id),
        color: graph.getNodeAttribute(hub.id, "color"),
      };
    });
}

/** Ask the local model for a topic name for the biggest clusters; `onTopic`
 * fires per cluster as (if ever) one resolves. */
export function upgradeClusterTopics(
  labels: ClusterLabel[],
  graph: VaultGraph,
  onTopic: (community: number, topic: string) => void,
): void {
  for (const l of labels.slice(0, MAX_TOPIC_UPGRADES)) {
    const byDeg = [...l.memberIds].sort(
      (a, b) => graph.getNodeAttribute(b, "deg") - graph.getNodeAttribute(a, "deg"),
    );
    void resolveClusterTopic(l.memberIds, byDeg).then((topic) => {
      if (topic) onTopic(l.community, topic);
    });
  }
}
