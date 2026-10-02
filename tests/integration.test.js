const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const { allowNativeConsent } = require("./helpers");
const source = name => fs.readFileSync(path.join(__dirname, "..", "src", name), "utf8");
const user = { fanId: 7, fanUsername: "tester", isLoggedIn: true };
const identityHTML = `<page-footer page-context='${JSON.stringify({ identity: user })}'></page-footer>`;
const rawItem = { tralbum_id: 1, tralbum_type: "a", item_url: "https://artist.bandcamp.com/album/owned", item_title: "Owned", band_name: "Artist" };
function environment(html = "") {
  const dom = new JSDOM(html, { url: "https://artist.bandcamp.com/music", runScripts: "outside-only" });
  for (const name of ["core.js", "page-data.js", "consent.js"]) dom.window.eval(source(name));
  return dom;
}
function discographyHTML(bundle = {}, bandId = 9, show = true) {
  const band = { id: bandId };
  const data = { show_buy_full_disco: show, buyfulldisco: { enabled: 1, bundle_id: 123, price: 1, full_price: 2, tralbum_count: 44, ...bundle } };
  return `<script data-band='${JSON.stringify(band)}'></script><script data-band-currency="USD"></script><div id="pagedata" data-blob='${JSON.stringify(data)}'></div>`;
}
test("discography offer uses Bandcamp's discounted starting price and bundle purchase action", () => {
  const dom = environment(discographyHTML());
  const parse = (html, bandId = 9) => dom.window.BCPage.discography(new dom.window.DOMParser().parseFromString(html, "text/html"), "https://artist.bandcamp.com/album/owned", bandId);
  const offer = parse(discographyHTML());
  assert.equal(offer.price, 1);
  assert.equal(offer.currency, "USD");
  assert.equal(offer.count, 44);
  assert.equal(offer.url, "https://artist.bandcamp.com/album/owned?action=buy&buy_id=b123");
  assert.equal(parse(discographyHTML({ price: 0 })).price, 0);
  assert.equal(parse(discographyHTML({ enabled: 0 })), null);
  assert.equal(parse(discographyHTML({}, 9, false)), null);
  assert.equal(parse(discographyHTML({}, 10)), null);
  assert.equal(parse(discographyHTML().replace('data-band-currency="USD"', 'data-band-currency="invalid"')), null);
  for (const price of [null, "", "unavailable", -1]) assert.equal(parse(discographyHTML({ price })), null);
  dom.window.close();
});
test("discography lookup refreshes its price and does not offer a different seller's bundle", async () => {
  const dom = environment();
  let listener, calls = 0, price = 1, now = 100000000;
  dom.window.Date.now = () => now;
  dom.window.fetch = async () => { calls++; return { ok: true, text: async () => discographyHTML({ price }) }; };
  dom.window.browser = { runtime: { onMessage: { addListener: fn => { listener = fn; } } }, browserAction: { setBadgeBackgroundColor() {} } };
  dom.window.browser.storage = { local: { get: async () => ({}) } };
  allowNativeConsent(dom.window.browser);
  dom.window.eval(source("background.js"));
  const message = { type: "discography", url: "https://artist.bandcamp.com/album/owned", bandId: 9 };
  assert.equal((await listener(message, {})).offer.price, 1);
  price = 5;
  assert.equal((await listener(message, {})).offer.price, 1);
  assert.equal(calls, 1);
  assert.equal((await listener({ ...message, force: true }, {})).offer.price, 5);
  assert.equal((await listener({ ...message, bandId: 10 }, {})).offer, null);
  const before = calls;
  await listener({ ...message, bandId: 10 }, {});
  assert.equal(calls, before); // Missing offers are also cached.
  now += 10 * 60 * 1000;
  price = 8;
  assert.equal((await listener(message, {})).offer.price, 8);
  assert.equal(calls, before + 1);
  dom.window.close();
});
test("collection parser selects collection sequence, excluding wishlist data", () => {
  const blob = { fan_data: { fan_id: 7 }, collection_data: { sequence: ["a1"] }, item_cache: { collection: { a1: rawItem }, wishlist: { a2: { ...rawItem, tralbum_id: 2 } } } };
  const dom = environment(`<div id="pagedata" data-blob='${JSON.stringify(blob)}'></div>${identityHTML}`);
  assert.equal(dom.window.BCPage.identity(dom.window.document).fanId, "7");
  assert.equal(dom.window.BCPage.initial(dom.window.BCPage.collection(dom.window.document), "collection").length, 1);
  dom.window.close();
});
test("background sync atomically retains old snapshot on failure and isolates switched accounts", async () => {
  const dom = environment();
  const store = {};
  let listener, fail = false, fanId = 7, switchDuringRequest = false;
  const blob = { fan_data: { fan_id: 7 }, collection_data: { item_count: 2, last_token: "first", sequence: ["a1"], hidden_items_count: 0 }, hidden_data: { item_count: 0, sequence: [] }, item_cache: { collection: { a1: rawItem } } };
  dom.window.fetch = async url => {
    if (url.includes("collection_items")) {
      if (switchDuringRequest) fanId = 8;
      if (fail) return { ok: false, status: 503 };
      return { ok: true, json: async () => ({ items: [{ ...rawItem, tralbum_id: 2, item_url: "https://artist.bandcamp.com/album/two" }], last_token: null }) };
    }
    return { ok: true, text: async () => url === "https://bandcamp.com/" ? `<page-footer page-context='${JSON.stringify({ identity: { ...user, fanId } })}'></page-footer>` : `<div id="pagedata" data-blob='${JSON.stringify(blob)}'></div>` };
  };
  dom.window.browser = {
    storage: { local: { get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(key => key in store).map(key => [key, store[key]])), set: async value => Object.assign(store, value), clear: async () => {} } },
    runtime: { onMessage: { addListener: fn => { listener = fn; } } }, browserAction: { setBadgeBackgroundColor() {}, setBadgeText() {} }
  };
  allowNativeConsent(dom.window.browser);
  dom.window.eval(source("background.js"));
  const first = await listener({ type: "state", force: true }, {});
  assert.equal(first.snapshot.items.length, 2);
  assert.equal(first.snapshot.complete, true);
  const previous = store["collection:7"];
  fail = true;
  const failed = await listener({ type: "state", force: true }, {});
  assert.match(failed.error, /503/);
  assert.equal(store["collection:7"], previous);
  fanId = 8;
  const switched = await listener({ type: "state", force: true }, {});
  assert.equal(switched.snapshot, null);
  assert.match(switched.error, /account changed/);
  const container = await listener({ type: "state" }, { tab: { cookieStoreId: "firefox-container-1" } });
  assert.match(container.error, /non-container/);
  fanId = 7;
  switchDuringRequest = true;
  const midRefresh = await listener({ type: "state", force: true }, {});
  assert.equal(midRefresh.snapshot, undefined);
  assert.match(midRefresh.error, /account changed/);
  dom.window.close();
});
test("music grid filters load lazy artwork, highlight ownership and show the discography offer", async () => {
  const band = JSON.stringify({ id: 9, name: "Artist", is_label: false });
  const card = (id, slug, title) => `<li class="music-grid-item" data-item-id="album-${id}"><a href="/album/${slug}"><div class="art"><img class="lazy" src="/img/0.gif" data-original="https://f4.bcbits.com/img/a${id}_2.jpg" style="display:none;opacity:0"></div><p class="title">${title}</p></a></li>`;
  const dom = environment(`<style>${fs.readFileSync(path.join(__dirname, "..", "src", "content.css"), "utf8")}</style><script data-band='${band}'></script><ol id="music-grid">${card(1, "owned", "Owned")}${card(2, "alternate", "Cross-label")}${card(3, "missing", "Missing")}</ol>`);
  const { window } = dom;
  const cross = { type: "album", id: "20", url: "https://label.bandcamp.com/album/cross", artist: "Artist", title: "Cross-label" };
  const snapshot = { items: [window.BCCore.item(rawItem), cross], complete: true, updatedAt: Date.now() };
  let decisions = {};
  window.browser = { storage: { onChanged: { addListener() {} } }, runtime: {
    onMessage: { addListener() {} }, sendMessage: async message => {
      if (message.type === "state") return { user: { fanId: "7", username: "tester" }, snapshot, decisions };
      if (message.type === "discography") return { offer: { price: 1, currency: "USD", count: 44, url: "https://artist.bandcamp.com/album/owned?action=buy&buy_id=b123" } };
      if (message.type === "decision") { decisions = { ...decisions, [window.BCCore.pair({ url: message.a }, { url: message.b })]: message.value }; return { decisions }; }
      return {};
    }
  } };
  window.eval(source("content.js"));
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(window.document.querySelectorAll(".bcc-owned").length, 1);
  assert.equal(window.document.querySelectorAll(".bcc-probable").length, 1);
  const owned = window.document.querySelector('[data-item-id="album-1"]');
  const review = window.document.querySelector('[data-item-id="album-2"]');
  const missing = window.document.querySelector('[data-item-id="album-3"]');
  assert.equal(owned.classList.contains("bcc-art-owned"), true);
  assert.equal(review.classList.contains("bcc-art-probable"), true);
  assert.equal(window.getComputedStyle(owned.querySelector(".art")).backgroundColor, "rgb(215, 239, 221)");
  assert.equal(window.getComputedStyle(review.querySelector(".art")).backgroundColor, "rgb(255, 226, 163)");
  assert.equal(window.getComputedStyle(missing.querySelector(".art")).backgroundColor, "rgba(0, 0, 0, 0)");
  assert.equal(window.document.querySelector(".bcc-discography").hidden, false);
  const buy = window.document.querySelector(".bcc-discography-buy");
  assert.match(buy.textContent, /Buy digital discography — from.*USD.*1\.00/);
  assert.equal(new URL(buy.href).searchParams.get("buy_id"), "b123");
  const choose = name => [...window.document.querySelectorAll(".bcc-filters button")].find(b => b.textContent.startsWith(name)).click();
  // Simulate a lazy loader that left a placeholder after the collection arrived.
  review.querySelector("img").src = "/img/0.gif";
  const reviewBadge = review.querySelector(".bcc-status");
  const reviewDetails = reviewBadge.querySelector("details");
  const reviewControl = reviewBadge.querySelector("button");
  reviewDetails.open = true;
  reviewControl.focus();
  choose("Review");
  assert.equal(review.querySelector(".bcc-status"), reviewBadge);
  assert.equal(reviewDetails.open, true);
  assert.equal(window.document.activeElement, reviewControl);
  assert.equal(review.querySelector("img").src, "https://f4.bcbits.com/img/a2_2.jpg");
  assert.equal(review.querySelector("img").loading, "eager");
  assert.equal(window.getComputedStyle(review.querySelector("img")).display, "block");
  owned.querySelector("img").src = "/img/0.gif";
  choose("Owned");
  assert.equal(owned.querySelector("img").src, "https://f4.bcbits.com/img/a1_2.jpg");
  choose("All");
  [...window.document.querySelectorAll(".bcc-status button")].find(b => b.textContent === "Same release").click();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(window.document.querySelectorAll(".bcc-owned").length, 2);
  assert.equal(review.classList.contains("bcc-art-probable"), false);
  assert.equal(review.classList.contains("bcc-art-owned"), true);
  [...window.document.querySelectorAll(".bcc-filters button")].find(b => b.textContent.startsWith("Missing")).click();
  assert.equal(window.document.querySelectorAll(".bcc-hidden").length, 2);
  window.document.querySelector("#music-grid").insertAdjacentHTML("beforeend", card(4, "new", "New"));
  await new Promise(resolve => setTimeout(resolve, 180));
  assert.equal(window.document.querySelectorAll(".bcc-status").length, 4);
  assert.equal(window.document.querySelectorAll(".bcc-panel").length, 1);
  assert.equal(review.querySelector("details").open, true);
  assert.equal(window.document.querySelector('[data-item-id="album-4"] img').src, "https://f4.bcbits.com/img/a4_2.jpg");
  [...window.document.querySelectorAll(".bcc-status button")].find(b => b.textContent === "Undo decision").click();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(review.classList.contains("bcc-art-owned"), false);
  assert.equal(review.classList.contains("bcc-art-probable"), true);
  dom.window.close();
});
test("music page does not show a purchase button when no discography offer is available", async () => {
  const dom = environment(`<script data-band='{"id":9,"name":"Artist"}'></script><ol id="music-grid"><li class="music-grid-item" data-item-id="album-1"><a href="/album/owned"><p class="title">Owned</p></a></li></ol>`);
  dom.window.browser = { storage: { onChanged: { addListener() {} } }, runtime: { onMessage: { addListener() {} }, sendMessage: async message => message.type === "discography" ? { offer: null } : {} } };
  dom.window.eval(source("content.js"));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(dom.window.document.querySelector(".bcc-discography").hidden, true);
  assert.equal(dom.window.document.querySelector(".bcc-discography-buy"), null);
  dom.window.close();
});

test("filtering drops expired ownership observations and reacts to replacement snapshots", async () => {
  const dom = environment(`<script data-band='{"name":"Artist"}'></script><ol id="music-grid"><li class="music-grid-item" data-item-id="album-1"><a href="/album/owned"><p class="title">Owned</p></a></li></ol>`);
  const { window } = dom;
  let now = 100000000, notify;
  window.Date.now = () => now;
  const release = window.BCCore.item(rawItem);
  const snapshot = { complete: true, updatedAt: now, items: [] };
  window.browser = { storage: { onChanged: { addListener: listener => { notify = listener; } } }, runtime: {
    onMessage: { addListener() {} }, sendMessage: async message => message.type === "state" ? {
      user: { fanId: "7", username: "tester" }, snapshot, decisions: {},
      ownership: { purchase: { ...release, status: "owned", updatedAt: now - 6 * 60 * 60 * 1000 + 100 } }
    } : {}
  } };
  window.eval(source("content.js"));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(window.document.querySelectorAll(".bcc-owned").length, 1);
  now += 100;
  [...window.document.querySelectorAll(".bcc-filters button")].find(button => button.textContent.startsWith("Missing")).click();
  assert.equal(window.document.querySelectorAll(".bcc-missing").length, 1);
  assert.equal(window.document.querySelector("li").classList.contains("bcc-hidden"), false);
  notify({ "collection:7": { newValue: { ...snapshot, items: [release] } } }, "local");
  assert.equal(window.document.querySelectorAll(".bcc-owned").length, 1);
  assert.equal(window.document.querySelector("li").classList.contains("bcc-hidden"), true);
  dom.window.close();
});

test("fast artist lookups render together", async () => {
  const cards = [1, 2, 3].map(id => `<li class="music-grid-item" data-item-id="album-${id}"><a href="/album/release-${id}"><p class="title">Release ${id}</p></a></li>`).join("");
  const dom = environment(`<script data-band='{"name":"Label","is_label":true,"meets_buy_full_discography_criteria":false}'></script><ol id="music-grid">${cards}</ol>`);
  const { window } = dom;
  window.Date.now = () => 100000000;
  const snapshot = { complete: true, updatedAt: window.Date.now(), items: [1, 2, 3].map(id => ({
    type: "album", id: String(id + 10), url: `https://label.bandcamp.com/album/release-${id}`, artist: "Artist", title: `Release ${id}`
  })) };
  let matches = 0, beforeLookups, requests = 0;
  const createMatcher = window.BCCore.createMatcher;
  window.BCCore.createMatcher = (...args) => {
    const matcher = createMatcher(...args);
    const match = matcher.match;
    matcher.match = release => { matches++; return match(release); };
    return matcher;
  };
  window.browser = { storage: { onChanged: { addListener() {} } }, runtime: {
    onMessage: { addListener() {} }, sendMessage: async message => {
      if (message.type === "state") return { user: { fanId: "7", username: "tester" }, snapshot, decisions: {} };
      if (message.type === "metadata") {
        if (!requests) beforeLookups = matches;
        requests++;
        return { artist: "Artist" };
      }
      return {};
    }
  } };
  window.eval(source("content.js"));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(requests, 3);
  assert.equal(matches - beforeLookups, 3); // One grid render for all three lookup results.
  assert.equal(window.document.querySelectorAll(".bcc-probable").length, 3);
  dom.window.close();
});
