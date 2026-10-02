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
