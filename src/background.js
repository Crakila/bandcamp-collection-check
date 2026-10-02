"use strict";
const TTL = 6 * 60 * 60 * 1000;
let queue = Promise.resolve();
let epoch = 0;
let progress = "";
const releaseMetadata = new Map();
const discographyOffers = new Map();
const digitalPrices = new Map();
let pricingQueue = Promise.resolve();
const activeRequests = new Set();
async function requireConsent() {
  if (!(await BCConsent.state(browser)).allowed) {
    const error = new Error("Bandcamp access is paused. Open Privacy & access to review the policy and enable access.");
    error.consentRequired = true;
    throw error;
  }
}
function cancelRequests() {
  epoch++;
  progress = "";
  for (const controller of activeRequests) controller.abort();
}
function localPage(sender) {
  if (!sender.url?.startsWith(browser.runtime.getURL(""))) throw new Error("Access settings can only be changed from the extension's privacy page.");
}
async function request(url, options = {}) {
  const token = epoch;
  await requireConsent();
  if (token !== epoch) throw new Error("Bandcamp request cancelled.");
  const target = new URL(url);
  if (target.protocol !== "https:" || !(target.hostname === "bandcamp.com" || target.hostname.endsWith(".bandcamp.com"))) throw new Error("Only Bandcamp requests are supported.");
  const controller = new AbortController();
  activeRequests.add(controller);
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(url, { ...options, credentials: "include", cache: "no-store", signal: controller.signal });
    if (!response.ok) throw new Error(`Bandcamp request failed (${response.status}). Try refreshing later.`);
    return response;
  } finally { clearTimeout(timer); activeRequests.delete(controller); }
}
async function documentAt(url) { return new DOMParser().parseFromString(await (await request(url)).text(), "text/html"); }
async function account() {
  const user = BCPage.identity(await documentAt("https://bandcamp.com/"));
  if (!user) throw new Error("Sign in to a Bandcamp fan account in a regular browser tab, then refresh.");
  return user;
}
async function sync(user, token) {
  const data = BCPage.collection(await documentAt(`https://bandcamp.com/${encodeURIComponent(user.username)}`));
  if (String(data.fan_data.fan_id) !== user.fanId) throw new Error("Bandcamp account changed. Refresh again.");
  const all = [];
  const hiddenCount = data.hidden_data?.item_count ?? data.collection_data.hidden_items_count;
  const kinds = [["collection", data.collection_data.item_count], ["hidden", hiddenCount]];
  let complete = true;
  for (const [kind, count] of kinds) {
    if (kind === "hidden" && !Number.isInteger(count)) { complete = false; continue; }
    const items = await BCCore.paginate({
      initial: BCPage.initial(data, kind), count, cursor: data[`${kind}_data`]?.last_token ?? null,
      getKey: raw => BCCore.key(BCCore.item(raw)) || JSON.stringify(raw),
      progress: (loaded, total) => { progress = `Loading ${kind}: ${loaded} / ${total}`; },
      fetchPage: async cursor => {
        if (token !== epoch) throw new Error("Refresh cancelled.");
        const response = await request(`https://bandcamp.com/api/fancollection/1/${kind === "hidden" ? "hidden" : "collection"}_items`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fan_id: Number(user.fanId), older_than_token: cursor, count: 100 })
        });
        return response.json();
      }
    });
    all.push(...items);
  }
  const current = await account();
  if (current.fanId !== user.fanId || token !== epoch) throw new Error("Account changed or refresh cancelled. Refresh again.");
  const unique = new Map();
  for (const raw of all) {
    const item = BCCore.item(raw);
    if (!item.type || !item.id || !item.url) { complete = false; continue; }
    unique.set(BCCore.key(item), item);
  }
  const snapshot = { ...user, items: [...unique.values()], complete, updatedAt: Date.now() };
  await browser.storage.local.set({ [`collection:${user.fanId}`]: snapshot });
  return snapshot;
}
async function state(force = false, token = epoch) {
  const user = await account();
  if (token !== epoch) throw new Error("Collection refresh cancelled.");
  const storageKey = `collection:${user.fanId}`;
  const stored = await browser.storage.local.get([storageKey, `decisions:${user.fanId}`, `ownership:${user.fanId}`]);
  let snapshot = stored[storageKey] || null;
  let error = "";
  if (force || !snapshot || Date.now() - snapshot.updatedAt >= TTL) {
    try { snapshot = await sync(user, token); } catch (e) { error = e.message; } finally { progress = ""; }
    // A refresh error may itself be caused by an account switch. Do not expose
    // the previous account's snapshot unless the session is still the same.
    const current = await account();
    if (current.fanId !== user.fanId) throw new Error("Bandcamp account changed. Refresh again.");
  }
  if (token !== epoch) throw new Error("Collection refresh cancelled.");
  return { user, snapshot, decisions: stored[`decisions:${user.fanId}`] || {}, ownership: BCCore.freshOwnership(stored[`ownership:${user.fanId}`] || {}), error };
}
async function handle(message, sender, token = epoch) {
  if (sender.tab && (sender.tab.incognito || (sender.tab.cookieStoreId && sender.tab.cookieStoreId !== "firefox-default"))) throw new Error("Use a regular, non-container tab for collection checks.");
  if (!["consent-state", "open-privacy", "set-consent", "clear-data", "clear-cache", "badge", "progress"].includes(message.type)) {
    await requireConsent();
    if (token !== epoch) throw new Error("Bandcamp operation cancelled.");
  }
  switch (message.type) {
    case "consent-state": return BCConsent.state(browser);
    case "open-privacy": await browser.tabs.create({ url: browser.runtime.getURL("consent/consent.html"), active: true }); return {};
    case "set-consent": {
      localPage(sender);
      if (typeof message.allowed !== "boolean") throw new Error("Invalid access choice.");
      const consent = await BCConsent.state(browser);
      if (message.allowed && consent.permissionCheckFailed) throw new Error("Firefox's data permissions could not be checked. Reload the privacy page and retry.");
      if (message.allowed && consent.native && !consent.nativeAllowed) throw new Error("Enable the required data permissions in Firefox's add-on settings first.");
      if (!message.allowed) cancelRequests();
      await browser.storage.local.set({ [BCConsent.KEY]: { version: BCConsent.VERSION, allowed: message.allowed } });
      return BCConsent.state(browser);
    }
    case "clear-data": {
      localPage(sender);
      cancelRequests();
      const stored = await browser.storage.local.get(null);
      await browser.storage.local.remove(Object.keys(stored).filter(key => /^(collection|ownership|decisions):/.test(key)));
      releaseMetadata.clear(); discographyOffers.clear(); digitalPrices.clear();
      return {};
    }
    case "state": return state(Boolean(message.force), token);
    case "progress": return { progress };
    case "badge":
      if (sender.tab) await browser.browserAction.setBadgeText({ tabId: sender.tab.id, text: message.count == null ? "" : String(message.count) });
      return {};
    case "check-ownership": {
      const token = epoch;
      const user = await account();
      if (user.fanId !== message.fanId) throw new Error("Account changed. Refresh before checking ownership.");
      const url = BCCore.canonical(message.url);
      if (!url) throw new Error("Invalid release URL.");
      const evidence = BCPage.ownershipEvidence(await documentAt(url), url);
      if (!evidence || evidence.fanId !== user.fanId) throw new Error("Bandcamp did not provide ownership data for this account. Open the release page and retry.");
      if ((message.id && String(message.id) !== evidence.release.id) || (message.releaseType && message.releaseType !== evidence.release.type)) throw new Error("Bandcamp returned a different release. Refresh the page and retry.");
      const current = await account();
      if (current.fanId !== user.fanId || token !== epoch) throw new Error("Account changed or ownership check cancelled. Refresh again.");
      const storageKey = `ownership:${user.fanId}`;
      const ownership = BCCore.freshOwnership((await browser.storage.local.get(storageKey))[storageKey] || {});
      if (evidence.owned === true) ownership[BCCore.key(evidence.release)] = { ...evidence.release, status: "owned", updatedAt: Date.now() };
      if (evidence.owned === false) {
        for (const [key, release] of Object.entries(ownership)) {
          if (key === BCCore.key(evidence.release) || release.url === url) delete ownership[key];
        }
      }
      const key = BCCore.key(evidence.release);
      const existingPurchase = ownership[key] && (ownership[key].status == null || ownership[key].status === "owned");
      if (evidence.owned !== true && !existingPurchase) {
        if (evidence.availability?.available === false) ownership[key] = { ...evidence.release, status: "unavailable", message: evidence.message, linkedReleaseUrl: evidence.availability.linkedReleaseUrl, updatedAt: Date.now() };
        else if (evidence.bundleOwned && evidence.bundleIncludesRelease !== false) ownership[key] = { ...evidence.release, status: "unchecked", message: evidence.message, updatedAt: Date.now() };
      }
      if (evidence.owned != null || ownership[key]?.status === "unavailable" || ownership[key]?.status === "unchecked") await browser.storage.local.set({ [storageKey]: ownership });
      return { fanId: user.fanId, owned: evidence.owned, ownership, availability: evidence.availability, bundleOwned: evidence.bundleOwned, bundleIncludesRelease: evidence.bundleIncludesRelease, message: evidence.message };
    }
    case "decision": {
      const user = await account();
      if (user.fanId !== message.fanId) throw new Error("Account changed. Refresh before reviewing matches.");
      if (!["same", "different", "reset"].includes(message.value)) throw new Error("Invalid review decision.");
      const a = BCCore.canonical(message.a), b = BCCore.canonical(message.b);
      if (!a || !b) throw new Error("Invalid release URLs.");
      const storageKey = `decisions:${user.fanId}`;
      const decisions = (await browser.storage.local.get(storageKey))[storageKey] || {};
      const pair = BCCore.pair({ url: a }, { url: b });
      if (message.value === "reset") delete decisions[pair]; else decisions[pair] = message.value;
      await browser.storage.local.set({ [storageKey]: decisions });
      return { decisions };
    }
    case "clear-cache": {
      epoch++;
      const stored = await browser.storage.local.get(null);
      await browser.storage.local.remove(Object.keys(stored).filter(key => key.startsWith("collection:") || key.startsWith("ownership:")));
      return {};
    }
    case "reset-decisions": {
      const user = await account();
      await browser.storage.local.remove(`decisions:${user.fanId}`);
      return {};
    }
    case "digital-price": {
      const url = BCCore.canonical(message.url);
      if (!url) throw new Error("Invalid release URL.");
      const cached = digitalPrices.get(url);
      if (!message.force && cached && Date.now() - cached.updatedAt < 10 * 60 * 1000) return { offer: cached.offer };
      const offer = BCPage.digitalPrice(await documentAt(url), url);
      digitalPrices.set(url, { offer, updatedAt: Date.now() });
      if (digitalPrices.size > 1000) digitalPrices.delete(digitalPrices.keys().next().value);
      return { offer };
    }
    case "discography": {
      const url = BCCore.canonical(message.url);
      if (!url) throw new Error("Invalid release URL.");
      const cacheKey = JSON.stringify([url, message.bandId]);
      const cached = discographyOffers.get(cacheKey);
      if (!message.force && cached && Date.now() - cached.updatedAt < 10 * 60 * 1000) return { offer: cached.offer };
      const offer = BCPage.discography(await documentAt(url), url, message.bandId);
      discographyOffers.set(cacheKey, { offer, updatedAt: Date.now() });
      if (discographyOffers.size > 100) discographyOffers.delete(discographyOffers.keys().next().value);
      return { offer };
    }
    case "metadata": {
      const url = BCCore.canonical(message.url);
      if (!url) throw new Error("Invalid release URL.");
      if (releaseMetadata.has(url)) return releaseMetadata.get(url);
      const doc = await documentAt(url);
      const tralbum = BCPage.jsonAttribute(doc, "[data-tralbum]", "data-tralbum");
      if (!tralbum?.artist) throw new Error("Artist metadata unavailable for this release.");
      const result = { artist: tralbum.artist, title: tralbum.current?.title || "" };
      releaseMetadata.set(url, result);
      if (releaseMetadata.size > 500) releaseMetadata.delete(releaseMetadata.keys().next().value);
      return result;
    }
    default: throw new Error("Unknown extension request.");
  }
}
browser.runtime.onMessage.addListener((message, sender) => {
  if (!message || typeof message.type !== "string") return;
  const token = epoch;
  // Large catalogues are priced one page at a time, independently of account
  // sync/review requests, so pricing does not block the rest of the extension.
  if (message.type === "digital-price") {
    const task = pricingQueue.then(() => handle(message, sender, token)).catch(errorResult);
    pricingQueue = task.then(() => {});
    return task;
  }
  if (["progress", "badge", "clear-cache", "discography", "consent-state", "open-privacy", "set-consent", "clear-data"].includes(message.type)) return handle(message, sender, token).catch(errorResult);
  const task = queue.then(() => handle(message, sender, token)).catch(errorResult);
  queue = task.then(() => {});
  return task;
});
function errorResult(error) { return { error: error.message, consentRequired: Boolean(error.consentRequired) }; }
browser.runtime.onInstalled?.addListener(async () => {
  try {
    const consent = await BCConsent.state(browser);
    if (!consent.allowed && !consent.choiceRecorded) await browser.tabs.create({ url: browser.runtime.getURL("consent/consent.html"), active: true });
  } catch { /* The toolbar always provides access to the privacy page. */ }
});
browser.browserAction.setBadgeBackgroundColor({ color: "#16738a" });
