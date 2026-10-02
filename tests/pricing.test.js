const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const { allowNativeConsent } = require("./helpers");
const source = name => fs.readFileSync(path.join(__dirname, "..", "src", name), "utf8");
function environment(html = "") {
  const dom = new JSDOM(html, { url: "https://businesscasual87.bandcamp.com/music", runScripts: "outside-only" });
  for (const name of ["core.js", "page-data.js", "consent.js"]) dom.window.eval(source(name));
  return dom;
}
function priceHTML({ type = "a", price = 0, nonzero = 7, availability = "OnlineOnly" } = {}) {
  const current = { id: 1, type: type === "a" ? "album" : "track", minimum_price_nonzero: nonzero };
  const product = (itemType, value, format = "DigitalFormat") => ({ additionalProperty: [{ name: "item_id", value: 1 }, { name: "item_type", value: itemType }], musicReleaseFormat: format, offers: { price: value, priceCurrency: "USD", priceSpecification: { minPrice: value }, availability } });
  const schema = { albumRelease: [product("p", 15, "CassetteFormat"), product("b", 3), product("i", 5), product(type, price)] };
  return `<script data-tralbum='${JSON.stringify({ current })}'></script><script type="application/ld+json">${JSON.stringify(schema)}</script>`;
}
test("digital pricing selects only the exact digital release, separating zero and paid minimums", () => {
  const dom = environment();
  const parse = options => dom.window.BCPage.digitalPrice(new dom.window.DOMParser().parseFromString(priceHTML(options), "text/html"), "https://businesscasual87.bandcamp.com/album/goodbye-future-funk");
  const free = parse({});
  assert.equal(free.price, 0);
  assert.equal(free.paidPrice, 7);
  assert.equal(parse({ type: "t", price: 1 }).price, 1);
  assert.equal(parse({ price: 8 }).paidPrice, 8);
  assert.equal(parse({ price: 0, nonzero: null }).paidPrice, null);
  assert.equal(parse({ price: null }), null);
  assert.equal(parse({ availability: "SoldOut" }), null);
  dom.window.close();
});
test("background price requests are cached and serialized separately from collection requests", async () => {
  const dom = environment();
  let listener, active = 0, maxActive = 0, calls = 0, now = 100000000;
  dom.window.Date.now = () => now;
  dom.window.fetch = async () => {
    calls++; active++; maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--;
    return { ok: true, text: async () => priceHTML() };
  };
  dom.window.browser = { runtime: { onMessage: { addListener: fn => { listener = fn; } } }, browserAction: { setBadgeBackgroundColor() {} } };
  dom.window.browser.storage = { local: { get: async () => ({}) } };
  allowNativeConsent(dom.window.browser);
  dom.window.eval(source("background.js"));
  const message = url => ({ type: "digital-price", url: `https://businesscasual87.bandcamp.com/album/${url}` });
  const results = await Promise.all([listener(message("one"), {}), listener(message("two"), {})]);
  assert.equal(results[0].offer.price, 0);
  assert.equal(maxActive, 1);
  await listener(message("one"), {});
  assert.equal(calls, 2);
  await listener({ ...message("one"), force: true }, {});
  assert.equal(calls, 3);
  now += 10 * 60 * 1000;
  await listener(message("one"), {});
  assert.equal(calls, 4);
  dom.window.close();
});
function gridHTML() {
  const cards = [[1, "Owned"], [2, "Review"], [3, "Missing A"], [4, "Missing B"]].map(([id, title]) => `<li class="music-grid-item" data-item-id="album-${id}"><a href="/album/release-${id}"><p class="title">${title}</p></a></li>`).join("");
  return `<script data-band='{"id":9,"name":"business casual"}'></script><ol id="music-grid">${cards}</ol>`;
}
function browserMock(dom, getPrice, snapshotComplete = true) {
  let storageListener;
  const snapshot = { complete: snapshotComplete, updatedAt: Date.now(), items: [
    { type: "album", id: "1", url: "https://businesscasual87.bandcamp.com/album/release-1", artist: "business casual", title: "Owned" },
    { type: "album", id: "99", url: "https://artist.bandcamp.com/album/review", artist: "business casual", title: "Review" }
  ] };
  dom.window.browser = { storage: { onChanged: { addListener: listener => { storageListener = listener; } } }, runtime: { onMessage: { addListener() {} }, sendMessage: async message => {
    if (message.type === "state") return { user: { fanId: "7", username: "tester" }, snapshot, decisions: {} };
    if (message.type === "digital-price") return getPrice(message);
    return {};
  } } };
  return { snapshot, notify: changes => storageListener(changes, "local") };
}
const wait = () => new Promise(resolve => setTimeout(resolve, 20));
test("missing-price scan is opt-in, excludes owned and review, and labels incomplete subtotals", async () => {
  const dom = environment(gridHTML());
  const calls = [];
  browserMock(dom, message => {
    calls.push(message.url);
    return message.url.endsWith("release-3") ? { offer: { price: 5, paidPrice: 5, currency: "USD" } } : { offer: null };
  });
  dom.window.eval(source("content.js"));
  await wait();
  assert.equal(calls.length, 0);
  dom.window.document.querySelector(".bcc-pricing button").click();
  await wait();
  assert.deepEqual(calls.map(url => url.split("/").pop()), ["release-3", "release-4"]);
  const text = dom.window.document.querySelector(".bcc-pricing p").textContent;
  assert.match(text, /Known individual subtotal USD\s*5\.00/);
  assert.match(text, /1 prices unchecked or unavailable/);
  assert.doesNotMatch(text, /Missing individually: from/);
  assert.equal(dom.window.document.querySelectorAll(".bcc-release-price").length, 1);
  dom.window.close();
});
test("stopping an in-flight price scan prevents subsequent release requests", async () => {
  const dom = environment(gridHTML());
  let resolvePrice, calls = 0;
  browserMock(dom, () => { calls++; return new Promise(resolve => { resolvePrice = resolve; }); });
  dom.window.eval(source("content.js"));
  await wait();
  const [start, stop] = dom.window.document.querySelectorAll(".bcc-pricing button");
  start.click();
  await wait();
  stop.click();
  resolvePrice({ offer: { price: 5, paidPrice: 5, currency: "USD" } });
  await wait();
  assert.equal(calls, 1);
  assert.equal(stop.hidden, true);
  dom.window.close();
});
test("changing ownership cancels pricing and prevents a stale subtotal being applied", async () => {
  const dom = environment(gridHTML());
  let resolvePrice, calls = 0;
  const mock = browserMock(dom, () => { calls++; return new Promise(resolve => { resolvePrice = resolve; }); });
  dom.window.eval(source("content.js"));
  await wait();
  dom.window.document.querySelector(".bcc-pricing button").click();
  await wait();
  const owned = { type: "album", id: "3", url: "https://businesscasual87.bandcamp.com/album/release-3", artist: "business casual", title: "Missing A" };
  mock.notify({ "collection:7": { newValue: { ...mock.snapshot, items: [...mock.snapshot.items, owned] } } });
  resolvePrice({ offer: { price: 5, paidPrice: 5, currency: "USD" } });
  await wait();
  assert.equal(calls, 1);
  assert.match(dom.window.document.querySelector(".bcc-pricing button").textContent, /\(1\)/);
  assert.doesNotMatch(dom.window.document.querySelector(".bcc-pricing p").textContent, /5\.00/);
  dom.window.close();
});
test("missing-price scan requires a complete collection and stops on request failures", async () => {
  const incomplete = environment(gridHTML());
  let calls = 0;
  browserMock(incomplete, () => { calls++; return {}; }, false);
  incomplete.window.eval(source("content.js"));
  await wait();
  assert.equal(incomplete.window.document.querySelector(".bcc-pricing button").disabled, true);
  assert.equal(calls, 0);
  incomplete.window.close();
  const failed = environment(gridHTML());
  browserMock(failed, () => { calls++; return { error: "Bandcamp request failed (429)" }; });
  failed.window.eval(source("content.js"));
  await wait();
  failed.window.document.querySelector(".bcc-pricing button").click();
  await wait();
  assert.equal(calls, 1);
  assert.match(failed.window.document.querySelector(".bcc-pricing p").textContent, /429/);
  failed.window.close();
});
