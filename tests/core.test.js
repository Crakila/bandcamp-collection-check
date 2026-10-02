const { test } = require("node:test");
const assert = require("node:assert/strict");
const core = require("../src/core.js");
const own = { type: "album", id: "1", url: "https://label.bandcamp.com/album/goodbye", artist: "CHANCE デラソウル", title: "Goodbye Future Funk" };
const other = { ...own, id: "2", url: "https://artist.bandcamp.com/album/goodbye" };
test("price totals separate currencies, unpaid downloads and unavailable prices without double counting", () => {
  const entries = [
    { url: "one", offer: { price: 0, paidPrice: 7, currency: "USD" } },
    { url: "two", offer: { price: 0.1, paidPrice: 0.1, currency: "USD" } },
    { url: "three", offer: { price: 0.2, paidPrice: 0.2, currency: "USD" } },
    { url: "eur", offer: { price: 5, paidPrice: 5, currency: "EUR" } },
    { url: "unknown", offer: null }
  ];
  const result = core.priceTotals([...entries, entries[0]]);
  assert.equal(result.count, 5);
  assert.equal(result.priced, 4);
  assert.equal(result.unknown, 1);
  assert.equal(result.zero, 1);
  assert.deepEqual(result.totals, [
    { currency: "EUR", price: 5, paidPrice: 5, paidUnknown: 0 },
    { currency: "USD", price: 0.3, paidPrice: 7.3, paidUnknown: 0 }
  ]);
  assert.equal(core.priceTotals([{ url: "free", offer: { price: 0, currency: "USD", paidPrice: null } }]).totals[0].paidUnknown, 1);
});
test("canonical release URLs discard tracking and preserve distinct releases", () => {
  assert.equal(core.canonical("http://Artist.bandcamp.com/album/goodbye/?from=music#x"), other.url);
  assert.equal(core.canonical("/track/song", "https://artist.bandcamp.com"), "https://artist.bandcamp.com/track/song");
  assert.equal(core.canonical("javascript:alert(1)"), "");
  assert.equal(core.canonical("https://bandcamp.com/fan"), "");
});
test("typed IDs avoid album/track collisions and title matching preserves edition wording", () => {
  const snapshot = { items: [own], complete: true };
  assert.equal(core.match({ ...own, url: other.url }, snapshot).status, "owned");
  assert.equal(core.match({ ...other, type: "track", id: "1" }, snapshot).status, "missing");
  assert.equal(core.match({ ...other, title: "Goodbye Future Funk (Remastered)" }, snapshot).status, "missing");
  assert.equal(core.match({ ...other, artist: "Different artist" }, snapshot).status, "missing");
});
test("cross-label reviews can be confirmed, rejected and undone", () => {
  const snapshot = { items: [own], complete: true };
  assert.equal(core.match(other, snapshot).status, "probable");
  assert.equal(core.match(other, snapshot, { [core.pair(other, own)]: "same" }).reason, "confirmed");
  assert.equal(core.match(other, snapshot, { [core.pair(other, own)]: "different" }).status, "missing");
  assert.equal(core.match(other, snapshot, {}).status, "probable");
  assert.equal(core.match(other, { items: [], complete: true }, { [core.pair(other, own)]: "same" }).status, "missing");
});
test("incomplete collections never classify unmatched releases as missing", () => {
  assert.equal(core.match(other, null).status, "unchecked");
  assert.equal(core.match(other, { items: [], complete: false }).status, "unchecked");
  assert.equal(core.match(own, { items: [own], complete: false }).status, "owned");
});
test("pagination uses opaque cursors and rejects interrupted or stalled retrieval", async () => {
  const calls = [];
  const result = await core.paginate({ initial: [1], count: 3, cursor: "opaque:one", fetchPage: async cursor => {
    calls.push(cursor);
    return cursor === "opaque:one" ? { items: [2], last_token: "opaque:two" } : { items: [3], last_token: null };
  } });
  assert.deepEqual(result, [1, 2, 3]);
  assert.deepEqual(calls, ["opaque:one", "opaque:two"]);
  await assert.rejects(core.paginate({ count: 3, cursor: "same", fetchPage: async () => ({ items: [1], last_token: "same" }) }), /advancing/);
  await assert.rejects(core.paginate({ count: 3, fetchPage: async () => ({ items: [] }) }), /incomplete/);
  await assert.rejects(core.paginate({ count: null, fetchPage: async () => ({}) }), /reliable/);
  await assert.rejects(core.paginate({ count: 2, initial: [1], cursor: "next", fetchPage: async () => ({ items: [1], last_token: "new" }) }), /repeated/);
});

test("indexed matching preserves collection order, typed IDs and review precedence", () => {
  const byUrl = { ...own, id: "10", url: other.url };
  const byId = { ...other, url: "https://artist.bandcamp.com/album/second" };
  const snapshot = { complete: true, items: [byUrl, byId, own] };
  const matcher = core.createMatcher(snapshot);
  assert.deepEqual(matcher.match(other).candidates, [byUrl]);
  assert.deepEqual(core.createMatcher({ ...snapshot, items: [byId, byUrl] }).match(other).candidates, [byId]);
  assert.equal(matcher.match({ ...other, type: "track", url: "https://artist.bandcamp.com/track/goodbye" }).status, "missing");

  const copy = { ...own, id: "11", url: "https://label.bandcamp.com/album/another-copy" };
  const copies = { complete: true, items: [own, copy] };
  const decisions = { [core.pair(other, copy)]: "same", [core.pair(other, own)]: "same", malformed: "same" };
  const reviewed = core.createMatcher(copies, decisions);
  assert.deepEqual(reviewed.match(other).candidates, [own]);
  assert.deepEqual(reviewed.reviewed(other), [own, copy]);
  assert.equal(reviewed.needsMetadata({ ...other, artist: "", title: " Goodbye  Future Funk " }), true);
  assert.equal(reviewed.needsMetadata({ ...other, type: "track", artist: "" }), false);
  assert.equal(core.createMatcher({ complete: true, items: [] }, decisions).match(other).status, "missing");
});

test("indexed ownership gives purchases precedence and exposes the next expiry", () => {
  const now = 100000000;
  const ttl = 6 * 60 * 60 * 1000;
  const ownership = {
    unavailable: { ...other, status: "unavailable", updatedAt: now },
    purchased: { ...other, url: "https://artist.bandcamp.com/album/verified-copy", status: "owned", updatedAt: now - ttl + 1 },
    expired: { ...other, status: "owned", updatedAt: now - ttl },
    future: { ...own, status: "owned", updatedAt: now + 100 }
  };
  const matcher = core.createMatcher(null, {}, ownership, now);
  assert.equal(matcher.match(other).reason, "page");
  assert.equal(matcher.expiresAt, now + 1);
  assert.equal(core.createMatcher(null, {}, ownership, now + 1).match(other).status, "unavailable");
  assert.equal(core.createMatcher(null, {}, ownership, now + 1).expiresAt, now + 100);
  assert.equal(core.createMatcher(null, {}, ownership, now + 100).match(own).reason, "page");
  assert.equal(core.createMatcher(null, {}, ownership, now + ttl + 100).match(other).status, "unchecked");
});

test("pagination reports unique progress and retains updated overlapping items", async () => {
  const progress = [];
  const items = await core.paginate({
    initial: [{ id: 1, title: "old" }], count: 3, cursor: "first", getKey: item => item.id,
    progress: (loaded, total) => progress.push([loaded, total]),
    fetchPage: async cursor => cursor === "first" ? {
      items: [{ id: 1, title: "updated" }, { id: 2 }], last_token: "second"
    } : { items: [{ id: 2 }, { id: 3 }], last_token: null }
  });
  assert.deepEqual(items, [{ id: 1, title: "updated" }, { id: 2 }, { id: 3 }]);
  assert.deepEqual(progress, [[1, 3], [2, 3], [3, 3]]);
});
