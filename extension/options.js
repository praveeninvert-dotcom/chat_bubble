// Pairing token entry. Saves to chrome.storage.local, which content.js
// reads before connecting. See SPEC.md §5.
const input = document.getElementById("token-input");
const status = document.getElementById("status");
const saveBtn = document.getElementById("save-btn");

function setStatus(text) {
  status.textContent = text;
}

chrome.storage.local.get(["pairingToken"], (result) => {
  if (result.pairingToken) {
    input.value = result.pairingToken;
    setStatus("A token is currently saved.");
  } else {
    setStatus("No token saved yet.");
  }
});

saveBtn.addEventListener("click", () => {
  const token = input.value.trim();
  if (!token) {
    setStatus("Paste a token before saving.");
    return;
  }
  chrome.storage.local.set({ pairingToken: token }, () => {
    setStatus(
      "Saved. An open claude.ai tab will reconnect automatically within " +
        "about 30 seconds, or reload the tab to reconnect right away."
    );
  });
});
