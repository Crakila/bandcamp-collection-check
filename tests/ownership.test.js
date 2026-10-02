const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const { allowNativeConsent } = require("./helpers");
const source = name => fs.readFileSync(path.join(__dirname, "..", "src", name), "utf8");
const url = "https://sunset-network.bandcamp.com/album/night-love";
const nightLove = { type: "album", id: "1078771401", url, title: "Night Love", artist: "「サンセット Ｎｅｔｗｏｒｋ❾❶」﻿／Cosmic Cycler" };
function identityHTML(fanId = 7, loggedIn = true) {
  return `<page-footer page-context='${JSON.stringify({ identity: { fanId, fanUsername: "tester", isLoggedIn: loggedIn } })}'></page-footer>`;
}
function releaseHTML({ fanId = 7, purchased = true, collectPurchased = purchased, loggedIn = true, packages = null, noDigital = false, bundle = null, bundleOwned = false, hiddenBundle = false, preorder = false, subscriberOnly = false } = {}) {
  const tralbum = { url, current: { id: 1078771401, type: "album", title: "Night Love", artist: nightLove.artist }, artist: nightLove.artist, trackinfo: [], hasAudio: false, is_preorder: preorder, tralbum_subscriber_only: subscriberOnly, is_purchased: purchased, items_purchased: packages ? { packages } : null };
  const collect = { fan_id: fanId, is_purchased: collectPurchased, is_collected: true, show_collect: true };
  const bundleHTML = bundle ? `<div id="pagedata" data-blob='${JSON.stringify({ buyfulldisco: bundle })}'></div><li class="buyItem buyFullDiscography">${bundleOwned ? `<h3 class="you-own-this buyfulldisco"${hiddenBundle ? ' hidden' : ""}>You own this</h3>` : '<button data-test="buy-full-digital-discography">Buy discography</button>'}</li>` : "";
  const digitalHTML = noDigital ? "" : '<div class="buyItem digital"><h3 class="you-own-this" style="display:none">You own this</h3></div>';
  return `${identityHTML(fanId, loggedIn)}<script data-tralbum='${JSON.stringify(tralbum)}' data-tralbum-collect-info='${JSON.stringify(collect)}'></script>${digitalHTML}${bundleHTML}<div class="tralbumData"><a href="https://dmtrec.bandcamp.com/album/night-love">DMT Records release</a></div>`;
}
function environment(html = "", pageUrl = url) {
  const dom = new JSDOM(html, { url: pageUrl, runScripts: "outside-only" });
  for (const file of ["core.js", "page-data.js", "consent.js"]) dom.window.eval(source(file));
  return dom;
}
test("Night Love ownership comes from signed-in digital purchase flags, not hidden text or wishlist state", () => {
  const dom = environment();
  const parse = options => dom.window.BCPage.ownershipEvidence(new dom.window.DOMParser().parseFromString(releaseHTML(options), "text/html"), url);
  assert.equal(parse({}).owned, true);
  assert.equal(parse({ purchased: null, collectPurchased: true }).owned, true);
  assert.equal(parse({ purchased: 1, collectPurchased: null }).owned, true);
  assert.equal(parse({ purchased: false }).owned, false);
  assert.equal(parse({ purchased: null, packages: { 123: true } }).owned, null);
  assert.equal(parse({ purchased: null }).owned, null);
  assert.equal(parse({ loggedIn: false }), null);
  const mismatched = releaseHTML().replace('"fan_id":7', '"fan_id":8');
  assert.equal(dom.window.BCPage.ownershipEvidence(new dom.window.DOMParser().parseFromString(mismatched, "text/html"), url), null);
  dom.window.close();
});
test("page-verified ownership fills an unmatched collection gap and expires without marking tracks owned", () => {
  const dom = environment();
  const { BCCore } = dom.window;
  const snapshot = { complete: true, items: [{ ...nightLove, id: "123", url: "https://dmtrec.bandcamp.com/album/night-love", artist: "Different artist spelling" }] };
  assert.equal(BCCore.match(nightLove, snapshot).status, "missing");
  const ownership = { "album-1078771401": { ...nightLove, updatedAt: Date.now() } };
  assert.equal(BCCore.match(nightLove, snapshot, {}, ownership).reason, "page");
  assert.equal(BCCore.match(nightLove, null, {}, ownership).status, "owned");
  assert.equal(BCCore.match({ ...nightLove, type: "track", url: "https://sunset-network.bandcamp.com/track/night-love" }, snapshot, {}, ownership).status, "missing");
  ownership["album-1078771401"].updatedAt = Date.now() - 6 * 60 * 60 * 1000;
  assert.equal(BCCore.match(nightLove, snapshot, {}, ownership).status, "missing");
  dom.window.close();
});
const excludedBundle = { enabled: 1, bundle_id: 41560336, tralbum_count: 1, tralbums: [{ item_id: 1245366434, item_type: "a", title: "roadtrip" }] };
test("owning the full discography does not mark an excluded, empty Night Love entry owned", () => {
  // Bandcamp still emits a digital offer in JSON-LD for this empty catalogue
  // entry, even though its actual page has no digital purchase section.
  const schema = { albumRelease: [{ additionalProperty: [{ name: "item_id", value: 1078771401 }, { name: "item_type", value: "a" }], musicReleaseFormat: "DigitalFormat", offers: { price: 1, priceCurrency: "USD", availability: "OnlineOnly" } }] };
  const dom = environment(releaseHTML({ purchased: false, noDigital: true, bundle: excludedBundle, bundleOwned: true }) + `<script type="application/ld+json">${JSON.stringify(schema)}</script>`);
  const evidence = dom.window.BCPage.ownershipEvidence(dom.window.document, url);
  assert.equal(evidence.owned, false);
  assert.equal(evidence.bundleOwned, true);
  assert.equal(evidence.bundleIncludesRelease, false);
  assert.equal(evidence.availability.available, false);
  assert.equal(evidence.availability.linkedReleaseUrl, "https://dmtrec.bandcamp.com/album/night-love");
  assert.match(evidence.message, /not in its current release list/);
  const ownership = { "album-1078771401": { ...nightLove, status: "unavailable", updatedAt: Date.now() } };
  const result = dom.window.BCCore.match(nightLove, { complete: true, items: [] }, {}, ownership);
  assert.equal(result.status, "unavailable");
  assert.equal(dom.window.BCPage.digitalPrice(dom.window.document, url), null);
  assert.equal(dom.window.BCCore.match(nightLove, { complete: true, items: [nightLove] }, {}, ownership).status, "owned");
  dom.window.close();
});
test("current bundle membership alone is not evidence of an individual purchase", () => {
  const included = { ...excludedBundle, tralbums: [{ item_id: 1078771401, item_type: "a", title: "Night Love" }] };
  const dom = environment(releaseHTML({ purchased: false, noDigital: true, bundle: included, bundleOwned: true }));
  const evidence = dom.window.BCPage.ownershipEvidence(dom.window.document, url);
  assert.equal(evidence.owned, false);
  assert.equal(evidence.bundleIncludesRelease, true);
  assert.equal(evidence.availability, null);
  const hint = { "album-1078771401": { ...nightLove, status: "unchecked", updatedAt: Date.now() } };
  assert.equal(dom.window.BCCore.match(nightLove, { complete: true, items: [] }, {}, hint).status, "unchecked");
  dom.window.close();
});
test("partial bundle lists, preorders and subscriber-only releases are not classified unavailable", () => {
  for (const options of [
    { bundle: { ...excludedBundle, tralbum_count: 10 } },
    { preorder: true },
    { subscriberOnly: true }
  ]) {
    const dom = environment(releaseHTML({ purchased: false, noDigital: true, ...options }));
    assert.equal(dom.window.BCPage.releaseAvailability(dom.window.document, url), null);
    dom.window.close();
  }
  const hidden = environment(releaseHTML({ purchased: false, bundle: excludedBundle, bundleOwned: true, hiddenBundle: true }));
  assert.equal(hidden.window.BCPage.ownershipEvidence(hidden.window.document, url).bundleOwned, false);
  hidden.window.close();
});
function backgroundEnvironment() {
  const dom = environment();
  const store = { "collection:7": { complete: true, updatedAt: Date.now(), items: [] } };
  const config = { fanId: 7, releaseFanId: 7, purchased: true, loggedIn: true, switchOnRelease: false, noDigital: false, bundle: null, bundleOwned: false };
  let listener;
  dom.window.fetch = async requested => ({ ok: true, text: async () => {
    if (requested === "https://bandcamp.com/") return identityHTML(config.fanId, config.loggedIn);
    if (config.switchOnRelease) config.fanId = 8;
    return releaseHTML({ fanId: config.releaseFanId, purchased: config.purchased, noDigital: config.noDigital, bundle: config.bundle, bundleOwned: config.bundleOwned });
  } });
  dom.window.browser = {
    storage: { local: {
      get: async keys => keys == null ? { ...store } : Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(key => key in store).map(key => [key, store[key]])),
      set: async values => Object.assign(store, values),
      remove: async keys => { for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key]; }
    } },
    runtime: { onMessage: { addListener: fn => { listener = fn; } } },
    browserAction: { setBadgeBackgroundColor() {} }
  };
  allowNativeConsent(dom.window.browser);
  dom.window.eval(source("background.js"));
  return { dom, store, config, send: message => listener(message, {}) };
}
test("verified purchases are cached per fan, survive collection lookup, and clear independently of reviews", async () => {
  const env = backgroundEnvironment();
  const message = { type: "check-ownership", fanId: "7", url, id: nightLove.id, releaseType: "album" };
  const result = await env.send(message);
  assert.equal(result.owned, true);
  assert.equal(env.store["ownership:7"]["album-1078771401"].url, url);
  const state = await env.send({ type: "state" });
  assert.equal(env.dom.window.BCCore.match(nightLove, state.snapshot, state.decisions, state.ownership).status, "owned");
  env.config.purchased = false;
  assert.equal((await env.send(message)).owned, false);
  assert.equal(Object.keys(env.store["ownership:7"]).length, 0);
  env.config.purchased = true;
  await env.send(message);
  env.store["decisions:7"] = { example: "same" };
  await env.send({ type: "clear-cache" });
  assert.equal(env.store["ownership:7"], undefined);
  assert.equal(env.store["decisions:7"].example, "same");
  env.dom.window.close();
});
test("ownership verification rejects signed-out, wrong-release and switched-account responses", async () => {
  for (const scenario of ["signed-out", "wrong-fan", "switched-fan", "wrong-release"]) {
    const env = backgroundEnvironment();
    const message = { type: "check-ownership", fanId: "7", url, id: nightLove.id, releaseType: "album" };
    if (scenario === "signed-out") env.config.loggedIn = false;
    if (scenario === "wrong-fan") env.config.releaseFanId = 8;
    if (scenario === "switched-fan") env.config.switchOnRelease = true;
    if (scenario === "wrong-release") message.id = "another-release";
    const result = await env.send(message);
    assert.ok(result.error, scenario);
    assert.equal(env.store["ownership:7"], undefined, scenario);
    env.dom.window.close();
  }
});
test("bundle checks persist unavailable or uncertain status rather than a false purchase", async () => {
  const env = backgroundEnvironment();
  Object.assign(env.config, { purchased: false, noDigital: true, bundle: excludedBundle, bundleOwned: true });
  const message = { type: "check-ownership", fanId: "7", url, id: nightLove.id, releaseType: "album" };
  let result = await env.send(message);
  assert.equal(result.owned, false);
  assert.equal(env.store["ownership:7"]["album-1078771401"].status, "unavailable");
  env.config.bundle = { ...excludedBundle, tralbums: [{ item_id: 1078771401, item_type: "a" }] };
  result = await env.send(message);
  assert.equal(result.owned, false);
  assert.equal(env.store["ownership:7"]["album-1078771401"].status, "unchecked");
  env.dom.window.close();
});
test("visiting an owned release page reports ownership even though there is no music grid", async () => {
  const dom = environment(releaseHTML());
  const calls = [];
  dom.window.browser = { storage: { onChanged: { addListener() {} } }, runtime: { sendMessage: async message => { calls.push(message); return {}; } } };
  dom.window.eval(source("content.js"));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, "check-ownership");
  assert.equal(calls[0].fanId, "7");
  assert.equal(calls[0].url, url);
  dom.window.close();
});
const wait = () => new Promise(resolve => setTimeout(resolve, 20));
test("checking Night Love corrects its badge, filters, green backing and missing-price selection", async () => {
  const dom = environment(`<script data-band='{"name":"Sunset Network"}'></script><ol id="music-grid"><li class="music-grid-item" data-item-id="album-1078771401"><a href="/album/night-love"><div class="art"></div><p class="title">Night Love</p></a></li></ol>`, "https://sunset-network.bandcamp.com/music");
  let storageListener;
  let ownership = {};
  dom.window.browser = { storage: { onChanged: { addListener: fn => { storageListener = fn; } } }, runtime: { onMessage: { addListener() {} }, sendMessage: async message => {
    if (message.type === "state") return { user: { fanId: "7", username: "tester" }, snapshot: { complete: true, updatedAt: Date.now(), items: [] }, decisions: {}, ownership };
    if (message.type === "check-ownership") {
      ownership = { "album-1078771401": { ...nightLove, updatedAt: Date.now() } };
      return { fanId: "7", owned: true, ownership };
    }
    return {};
  } } };
  dom.window.eval(source("content.js"));
  await wait();
  assert.equal(dom.window.document.querySelectorAll(".bcc-missing").length, 1);
  [...dom.window.document.querySelectorAll(".bcc-status button")].find(button => button.textContent === "Check ownership").click();
  await wait();
  assert.match(dom.window.document.querySelector(".bcc-status").textContent, /Owned · verified by Bandcamp/);
  assert.equal(dom.window.document.querySelector("li").classList.contains("bcc-art-owned"), true);
  assert.equal(dom.window.document.querySelector(".bcc-pricing button").disabled, true);
  [...dom.window.document.querySelectorAll(".bcc-filters button")].find(button => button.textContent.startsWith("Missing")).click();
  assert.equal(dom.window.document.querySelector("li").classList.contains("bcc-hidden"), true);
  storageListener({ "ownership:7": { newValue: {} } }, "local");
  assert.equal(dom.window.document.querySelectorAll(".bcc-owned").length, 0);
  dom.window.close();
});
test("Night Love is unavailable, linked to its other storefront and excluded from missing prices", async () => {
  const html = `<script data-band='{"name":"Sunset Network"}'></script><ol id="music-grid"><li class="music-grid-item" data-item-id="album-1078771401"><a href="/album/night-love"><div class="art"></div><p class="title">Night Love</p></a></li></ol>`;
  const dom = environment(html, "https://sunset-network.bandcamp.com/music");
  const record = { ...nightLove, status: "unavailable", linkedReleaseUrl: "https://dmtrec.bandcamp.com/album/night-love", message: "You own the discography bundle, but this release is not in its current release list.", updatedAt: Date.now() };
  dom.window.browser = { storage: { onChanged: { addListener() {} } }, runtime: { onMessage: { addListener() {} }, sendMessage: async message => {
    if (message.type === "state") return { user: { fanId: "7", username: "tester" }, snapshot: { complete: true, updatedAt: Date.now(), items: [] }, decisions: {}, ownership: { "album-1078771401": record } };
    return {};
  } } };
  dom.window.eval(source("content.js"));
  await wait();
  assert.match(dom.window.document.querySelector(".bcc-status").textContent, /Unavailable on this storefront/);
  assert.equal(dom.window.document.querySelectorAll(".bcc-owned").length, 0);
  assert.equal(dom.window.document.querySelector(".bcc-linked-release").href, record.linkedReleaseUrl);
  assert.equal(dom.window.document.querySelector(".bcc-pricing button").disabled, true);
  [...dom.window.document.querySelectorAll(".bcc-filters button")].find(button => button.textContent.startsWith("Unavailable")).click();
  assert.equal(dom.window.document.querySelector("li").classList.contains("bcc-hidden"), false);
  [...dom.window.document.querySelectorAll(".bcc-filters button")].find(button => button.textContent.startsWith("Missing")).click();
  assert.equal(dom.window.document.querySelector("li").classList.contains("bcc-hidden"), true);
  dom.window.close();
});
