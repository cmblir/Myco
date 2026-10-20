import { buildWovenLayout, type WovenInput } from "./wovenLayout";
self.onmessage = (event: MessageEvent<WovenInput>) => {
  try {
    const layout = buildWovenLayout(event.data);
    self.postMessage(
      { layout },
      { transfer: layout.routes.map((route) => route.points.buffer) },
    );
  } catch (error) {
    self.postMessage({
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
