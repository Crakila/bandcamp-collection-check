"use strict";
const status = document.querySelector("#status");
const accountInfo = document.querySelector("#account");
let user;
async function show(force = false) {
  status.textContent = "Checking account and collection…";
  const result = await browser.runtime.sendMessage({ type: "state", force });
  user = result.user;
  accountInfo.textContent = user ? `Signed in as ${user.username}` : "";
  status.textContent = result.error || (result.snapshot ? `${result.snapshot.items.length} cached releases${result.snapshot.complete ? "" : " (incomplete)"}. Updated ${new Date(result.snapshot.updatedAt).toLocaleString()}.` : "No collection cached.");
  return result;
}
async function updatePage() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab) try { await browser.tabs.sendMessage(tab.id, { type: "refresh-page" }); } catch { /* No music grid in this tab. */ }
}
for (const [id, action] of [
  ["privacy", async () => {
    const result = await browser.runtime.sendMessage({ type: "open-privacy" });
    if (result.error) throw new Error(result.error);
  }],
  ["refresh", async () => { await show(true); await updatePage(); }],
  ["clear", async () => {
    const result = await browser.runtime.sendMessage({ type: "clear-cache" });
    if (result.error) throw new Error(result.error);
    status.textContent = "Collection cache cleared. Refresh to retrieve it again.";
  }],
  ["reset", async () => {
    const result = await browser.runtime.sendMessage({ type: "reset-decisions" });
    if (result.error) throw new Error(result.error);
    status.textContent = "Review decisions reset for this account.";
  }]
]) document.querySelector(`#${id}`).addEventListener("click", async event => {
  event.target.disabled = true;
  try { await action(); } catch (error) { status.textContent = error.message; }
  finally { event.target.disabled = false; }
});
show().catch(error => { status.textContent = error.message; });
