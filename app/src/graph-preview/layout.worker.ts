import { buildPreviewGraph, type GraphInput, type GraphResult } from "./model";

self.onmessage = (event: MessageEvent<GraphInput>): void => {
  let result: GraphResult;
  try {
    result = { graph: buildPreviewGraph(event.data) };
  } catch (error) {
    result = { error: error instanceof Error ? error.message : String(error) };
  }
  self.postMessage(result);
};
