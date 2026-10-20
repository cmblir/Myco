// myco Web Clipper — builds a myco://clip deep link from the active tab and
// opens it; the myco desktop app (which registers both the myco: and the
// legacy memx: scheme) writes
// the clip into the vault's _inbox/. No network, no storage, no tracking:
// the extension only reads the tab you explicitly clip.
//
// The toolbar button opens popup.html (an optional one-line note, then clip);
// the right-click menu clips straight away, without a note.

importScripts("clip-link.js");

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "memex-clip",
    title: "Clip to myco",
    contexts: ["page", "selection"],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "memex-clip") void clip(tab);
});
