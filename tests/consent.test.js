const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const source = name => fs.readFileSync(path.join(__dirname, "..", "src", name), "utf8");
const extensionUrl = "moz-extension://test/";
const localSender = { url: `${extensionUrl}consent/consent.html` };
function environment({ native = false, grants = [], choice } = {}) {
  const dom = new JSDOM("", { runScripts: "outside-only" });
  for (const file of ["core.js", "page-data.js", "consent.js"]) dom.window.eval(source(file));
  const store = choice ? { bandcampConsent: choice } : {};
  let listener, installed;
  const tabs = [];
  let requests = 0;
  dom.window.browser = {
    permissions: { getAll: async () => native ? { data_collection: grants } : {} },
    storage: { local: {
      get: async keys => keys == null ? { ...store } : Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(key => key in store).map(key => [key, store[key]])),
      set: async values => Object.assign(store, values),
      remove: async keys => { for (const key of [].concat(keys)) delete store[key]; }
    } },
    runtime: { getURL: name => `${extensionUrl}${name}`, onMessage: { addListener: fn => { listener = fn; } }, onInstalled: { addListener: fn => { installed = fn; } } },
    tabs: { create: async tab => { tabs.push(tab); } },
    browserAction: { setBadgeBackgroundColor() {} }
  };
  dom.window.fetch = async () => { requests++; return { ok: true, text: async () => "" }; };
  dom.window.eval(source("background.js"));
  return { dom, store, tabs, installed: () => installed(), requestCount: () => requests, send: (message, sender = {}) => listener(message, sender) };
}
test("older browsers block every remote feature until explicit consent, including cached prices", async () => {
  const env = environment();
  await env.installed();
  assert.equal(env.tabs[0].url, `${extensionUrl}consent/consent.html`);
  for (const message of [
    { type: "state" },
    { type: "metadata", url: "https://artist.bandcamp.com/album/one" },
    { type: "digital-price", url: "https://artist.bandcamp.com/album/one" },
    { type: "discography", url: "https://artist.bandcamp.com/album/one" },
    { type: "check-ownership", fanId: "7", url: "https://artist.bandcamp.com/album/one" }
  ]) {
    assert.equal((await env.send(message)).consentRequired, true);
  }
  assert.equal(env.requestCount(), 0);
  assert.equal((await env.send({ type: "set-consent", allowed: true }, localSender)).allowed, true);
  await env.send({ type: "digital-price", url: "https://artist.bandcamp.com/album/one" });
  assert.equal(env.requestCount(), 1);
  await env.send({ type: "set-consent", allowed: false }, localSender);
  assert.equal((await env.send({ type: "digital-price", url: "https://artist.bandcamp.com/album/one" })).consentRequired, true);
  assert.equal(env.requestCount(), 1);
  env.dom.window.close();
});
test("native Firefox grants are recognised, manual pause takes precedence, and missing grants cannot be bypassed", async () => {
  const native = environment({ native: true });
  const grants = [...native.dom.window.BCConsent.DATA_TYPES];
  native.dom.window.browser.permissions.getAll = async () => ({ data_collection: grants });
  assert.equal((await native.send({ type: "consent-state" })).allowed, true);
  await native.installed();
  assert.equal(native.tabs.length, 0);
  await native.send({ type: "set-consent", allowed: false }, localSender);
  assert.equal((await native.send({ type: "consent-state" })).allowed, false);
  assert.equal((await native.send({ type: "set-consent", allowed: true }, localSender)).allowed, true);
  native.dom.window.close();
  const missing = environment({ native: true, grants: [], choice: { version: 1, allowed: true } });
  assert.equal((await missing.send({ type: "consent-state" })).allowed, false);
  assert.match((await missing.send({ type: "set-consent", allowed: true }, localSender)).error, /required data permissions/);
  assert.equal(missing.requestCount(), 0);
  missing.dom.window.close();
});
test("web content cannot enable access, and deleting saved data works while access is paused", async () => {
  const env = environment({ choice: { version: 1, allowed: false } });
  assert.match((await env.send({ type: "set-consent", allowed: true }, { url: "https://artist.bandcamp.com/music" })).error, /extension's privacy page/);
  env.store["collection:7"] = { items: [{ title: "Private collection" }] };
  env.store["ownership:7"] = { test: true };
  env.store["decisions:7"] = { test: "same" };
  await env.send({ type: "clear-data" }, localSender);
  assert.deepEqual(Object.keys(env.store), ["bandcampConsent"]);
  assert.equal((await env.send({ type: "consent-state" })).allowed, false);
  assert.equal(env.requestCount(), 0);
  env.dom.window.close();
});
test("a permissions API failure cannot be bypassed by a previously accepted local choice", async () => {
  const env = environment({ choice: { version: 1, allowed: true } });
  env.dom.window.browser.permissions.getAll = async () => { throw new Error("Permissions unavailable"); };
  assert.equal((await env.send({ type: "consent-state" })).allowed, false);
  assert.equal((await env.send({ type: "state" })).consentRequired, true);
  assert.match((await env.send({ type: "set-consent", allowed: true }, localSender)).error, /could not be checked/);
  assert.equal(env.requestCount(), 0);
  env.dom.window.close();
});
test("pausing access aborts an active request and cancels already queued price requests", async () => {
  const env = environment({ choice: { version: 1, allowed: true } });
  let started;
  const pending = new Promise(resolve => { started = resolve; });
  let calls = 0;
  env.dom.window.fetch = async (url, { signal }) => {
    calls++;
    started();
    return new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(new Error("Request aborted"))));
  };
  const first = env.send({ type: "digital-price", url: "https://artist.bandcamp.com/album/one" });
  const second = env.send({ type: "digital-price", url: "https://artist.bandcamp.com/album/two" });
  await pending;
  await env.send({ type: "set-consent", allowed: false }, localSender);
  assert.match((await first).error, /aborted/);
  assert.equal((await second).consentRequired, true);
  assert.equal(calls, 1);
  env.dom.window.close();
});
test("paused content does not promote lazy artwork into extra network requests", async () => {
  const dom = new JSDOM('<ol id="music-grid"><li class="music-grid-item" data-item-id="album-1"><a href="/album/one"><div class="art"><img src="/img/0.gif" data-original="https://f4.bcbits.com/img/a1_2.jpg"></div><p class="title">One</p></a></li></ol>', { url: "https://artist.bandcamp.com/music", runScripts: "outside-only" });
  for (const file of ["core.js", "page-data.js"]) dom.window.eval(source(file));
  dom.window.browser = { storage: { onChanged: { addListener() {} } }, runtime: { onMessage: { addListener() {} }, sendMessage: async () => ({ error: "Bandcamp access is paused.", consentRequired: true }) } };
  dom.window.eval(source("content.js"));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(dom.window.document.querySelector("img").src, "https://artist.bandcamp.com/img/0.gif");
  assert.match(dom.window.document.querySelector(".bcc-info").textContent, /paused/);
  dom.window.close();
});
