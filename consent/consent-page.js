"use strict";
const status = document.querySelector("#status");
async function show() {
  const result = await browser.runtime.sendMessage({ type: "consent-state" });
  if (result.error) throw new Error(result.error);
  status.textContent = result.allowed ? "Bandcamp access is enabled." : "Bandcamp access is disabled. No collection, ownership or pricing requests will be made by the add-on.";
  if (result.native && !result.nativeAllowed) status.textContent += " Firefox has not granted the required data permissions. Enable them in the add-on’s Firefox settings.";
  if (result.permissionCheckFailed) status.textContent += " Firefox's data permissions could not be checked. Reload this page and retry.";
  document.querySelector("#enable").disabled = result.allowed || result.permissionCheckFailed || (result.native && !result.nativeAllowed);
  document.querySelector("#pause").textContent = result.allowed ? "Pause Bandcamp access" : "Keep access disabled";
}
for (const [id, message] of [
  ["enable", { type: "set-consent", allowed: true }],
  ["pause", { type: "set-consent", allowed: false }],
  ["delete", { type: "clear-data" }]
]) document.querySelector(`#${id}`).addEventListener("click", async event => {
  event.target.disabled = true;
  try {
    const result = await browser.runtime.sendMessage(message);
    if (result.error) throw new Error(result.error);
    await show();
    if (id === "delete") status.textContent += " Saved collection data and review decisions have been deleted.";
  } catch (error) { status.textContent = error.message; }
  finally { if (id !== "enable") event.target.disabled = false; }
});
show().catch(error => { status.textContent = error.message; });
