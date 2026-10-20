// Toolbar popup: one optional note line, then the same clip the menu makes.
document.getElementById("clip-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await clip(tab, document.getElementById("note").value);
  window.close();
});
