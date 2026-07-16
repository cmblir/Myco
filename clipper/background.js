// Memex Web Clipper — builds a memx://clip deep link from the active tab and
// opens it; the Memex desktop app (which registered the memx: scheme) writes
// the clip into the vault's _inbox/. No network, no storage, no tracking:
// the extension only reads the tab you explicitly clip.

const MAX_SELECTION = 20000;

function clipUrl(tab, selection) {
  const p = new URLSearchParams();
  if (tab.url && /^https?:\/\//.test(tab.url)) p.set("url", tab.url);
  if (tab.title) p.set("title", tab.title.slice(0, 300));
  if (selection) p.set("selection", selection.slice(0, MAX_SELECTION));
  return `memx://clip?${p.toString()}`;
}

async function grabSelection(tabId) {
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => window.getSelection()?.toString() ?? "",
    });
    return res?.result ?? "";
  } catch {
    return ""; // restricted page (chrome://, store, …)
  }
}

async function clip(tab) {
  if (!tab?.id) return;
  const selection = await grabSelection(tab.id);
  const url = clipUrl(tab, selection);
  // Navigating a tab to a custom scheme hands off to the OS handler (Memex).
  await chrome.tabs.update(tab.id, { url });
}

chrome.action.onClicked.addListener((tab) => void clip(tab));

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "memex-clip",
    title: "Clip to Memex",
    contexts: ["page", "selection"],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "memex-clip") void clip(tab);
});
