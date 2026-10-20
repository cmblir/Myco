// The popup a Live table's row and column handles open (./table.ts): the
// block menu's card (.block-menu), its items buttons. The arrows move
// between them, Escape or Tab closes it and gives the caret back, and so
// does focus leaving it.

export interface MenuItem {
  label: string;
  run(): void;
  /** Shown, but it cannot run (the last row's 행 삭제). */
  off?: boolean;
  /** A choice in a labelled group: this one is the current one. */
  checked?: boolean;
}

/** Items under an optional label; a labelled group is one choice, its
 *  items side by side (정렬: 왼쪽 / 가운데 / 오른쪽). */
export interface MenuGroup {
  label?: string;
  items: MenuItem[];
}

/** The menu's element, not yet placed. `close` runs once it should go:
 *  `refocus` when a key closed it, so the caret goes back. An item's click
 *  closes the menu, then runs the item. */
export function popupMenu(
  label: string,
  groups: readonly MenuGroup[],
  close: (refocus: boolean) => void,
): HTMLElement {
  const menu = document.createElement("div");
  menu.className = "block-menu tbl-menu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", label);
  for (const g of groups) {
    let into: HTMLElement = menu;
    if (g.label) {
      const group = document.createElement("div");
      group.setAttribute("role", "group");
      group.setAttribute("aria-label", g.label);
      const head = document.createElement("div");
      head.className = "block-menu__head";
      head.textContent = g.label;
      into = document.createElement("div");
      into.className = "tbl-menu__seg";
      group.append(head, into);
      menu.append(group);
    }
    for (const it of g.items) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "block-menu__item";
      b.textContent = it.label;
      b.disabled = !!it.off;
      if (it.checked === undefined) b.setAttribute("role", "menuitem");
      else {
        b.setAttribute("role", "menuitemradio");
        b.setAttribute("aria-checked", String(it.checked));
      }
      b.addEventListener("click", () => {
        close(false);
        it.run();
      });
      into.append(b);
    }
  }
  const buttons = () => [
    ...menu.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
  ];
  const STEP: Record<string, number> = {
    ArrowDown: 1,
    ArrowRight: 1,
    ArrowUp: -1,
    ArrowLeft: -1,
  };
  menu.addEventListener("keydown", (e) => {
    const list = buttons();
    const step = STEP[e.key];
    if (step) {
      e.preventDefault();
      const i = list.indexOf(e.target as HTMLButtonElement);
      list[(i + step + list.length) % list.length]?.focus();
    } else if (e.key === "Escape" || e.key === "Tab") {
      e.preventDefault();
      close(true);
    }
    e.stopPropagation();
  });
  menu.addEventListener("focusout", (e) => {
    if (!(e.relatedTarget instanceof Node && menu.contains(e.relatedTarget)))
      close(false);
  });
  return menu;
}

/** The menu's first item that can run takes the focus. */
export const focusMenu = (menu: HTMLElement): void =>
  menu.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
