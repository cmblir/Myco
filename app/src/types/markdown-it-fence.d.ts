declare module "markdown-it/lib/rules_block/fence.mjs" {
  import type StateBlock from "markdown-it/lib/rules_block/state_block.mjs";
  const fence: (
    state: StateBlock,
    startLine: number,
    endLine: number,
    silent: boolean,
  ) => boolean;
  export default fence;
}
