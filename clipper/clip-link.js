// Shared by the service worker (importScripts) and the popup (<script>):
// the myco://clip deep link and the selection grab.

const MAX_SELECTION = 20000;
const MAX_NOTE = 500;

function clipUrl(tab, selection, note) {
  const p = new URLSearchParams();
  if (tab.url && /^https?:\/\//.test(tab.url)) p.set("url", tab.url);
  if (tab.title) p.set("title", tab.title.slice(0, 300));
  if (selection) p.set("selection", selection.slice(0, MAX_SELECTION));
  // Why it was saved: the app quotes it as the clip's first line.
  const n = (note || "").trim();
  if (n) p.set("note", n.slice(0, MAX_NOTE));
  return `myco://clip?${p.toString()}`;
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

async function clip(tab, note) {
  if (!tab?.id) return;
  const selection = await grabSelection(tab.id);
  // Navigating a tab to a custom scheme hands off to the OS handler (myco).
  await chrome.tabs.update(tab.id, { url: clipUrl(tab, selection, note) });
}
