/* Shared, DOM-free ownership and pagination logic. */
(function (root) {
  "use strict";
  function canonical(value, base = "https://bandcamp.com") {
    try {
      const url = new URL(value, base);
      if (!/^https?:$/.test(url.protocol) || !/^\/(album|track)\/[^/]+\/?$/.test(url.pathname)) return "";
      return `https://${url.hostname.toLowerCase()}${url.pathname.replace(/\/$/, "")}`;
    } catch { return ""; }
  }
  const normalize = value => String(value || "").normalize("NFKC").toLowerCase().replace(/[\u200B-\u200D\uFEFF]/g, "").replace(/\s+/g, " ").trim();
  function item(raw) {
    const type = ({ a: "album", t: "track", album: "album", track: "track" })[raw.tralbum_type || raw.type || raw.item_type];
    return { type, id: String(raw.tralbum_id || raw.id || raw.item_id || ""), url: canonical(raw.item_url || raw.url || raw.page_url), title: raw.item_title || raw.title || "", artist: raw.band_name || raw.artist || "" };
  }
  const key = release => release.type && release.id ? `${release.type}-${release.id}` : release.url;
  const pair = (a, b) => JSON.stringify([a.url, b.url].sort());
  function freshOwnership(records = {}, now = Date.now()) {
    return Object.fromEntries(Object.entries(records).filter(([, record]) => record && record.updatedAt <= now && now - record.updatedAt < 6 * 60 * 60 * 1000));
  }
  function match(release, snapshot, decisions = {}, ownership = {}) {
    const items = snapshot?.items || [];
    const exact = items.find(i => (release.id && i.id && release.type === i.type && release.id === i.id) || (release.url && release.url === i.url));
    if (exact) return { status: "owned", reason: "exact", candidates: [exact] };
    const pageRecords = Object.values(freshOwnership(ownership)).filter(i => (release.id && release.type === i.type && release.id === i.id) || (release.url && release.url === i.url));
    const verified = pageRecords.find(record => record.status == null || record.status === "owned");
    if (verified) return { status: "owned", reason: "page", candidates: [verified] };
    const pageStatus = pageRecords.find(record => ["unavailable", "unchecked"].includes(record.status));
    if (!snapshot) return { status: pageStatus?.status || "unchecked", candidates: [], pageStatus };
    const confirmed = items.find(i => release.url && i.url && decisions[pair(release, i)] === "same");
    if (confirmed) return { status: "owned", reason: "confirmed", candidates: [confirmed] };
    const candidates = items.filter(i => release.url && i.url && release.type === i.type && normalize(release.artist) && normalize(release.artist) === normalize(i.artist) && normalize(release.title) && normalize(release.title) === normalize(i.title) && decisions[pair(release, i)] !== "different");
    if (!candidates.length && pageStatus) return { status: pageStatus.status, candidates: [], pageStatus };
    return { status: candidates.length ? "probable" : snapshot.complete ? "missing" : "unchecked", candidates };
  }
  async function paginate({ initial = [], count, cursor, fetchPage, progress = () => {}, getKey = value => JSON.stringify(value) }) {
    if (!Number.isInteger(count) || count < 0) throw new Error("Bandcamp did not provide a reliable collection count.");
    const seenItems = new Map(initial.map(value => [getKey(value), value]));
    let items = [...seenItems.values()];
    const cursors = new Set();
    progress(items.length, count);
    while (items.length < count) {
      if (cursors.has(cursor)) throw new Error("Collection pagination stopped advancing.");
      cursors.add(cursor);
      const page = await fetchPage(cursor);
      if (!Array.isArray(page.items) || !page.items.length) throw new Error("Bandcamp returned an incomplete collection.");
      const previousSize = seenItems.size;
      for (const value of page.items) seenItems.set(getKey(value), value);
      if (seenItems.size === previousSize) throw new Error("Bandcamp returned a repeated collection page.");
      items = [...seenItems.values()];
      cursor = page.last_token;
      progress(items.length, count);
      if (items.length < count && !cursor) throw new Error("Bandcamp did not return the next collection cursor.");
      if (cursors.size > 10000) throw new Error("Collection pagination limit reached.");
    }
    return items;
  }
  function priceTotals(entries) {
    const unique = new Map(entries.map(entry => [entry.url, entry]));
    const currencies = new Map();
    let priced = 0, zero = 0;
    for (const { offer } of unique.values()) {
      if (!offer || !Number.isFinite(offer.price) || offer.price < 0 || !/^[A-Z]{3}$/.test(offer.currency)) continue;
      priced++;
      if (offer.price === 0) zero++;
      const total = currencies.get(offer.currency) || { currency: offer.currency, price: 0, paidPrice: 0, paidUnknown: 0 };
      total.price += offer.price;
      if (Number.isFinite(offer.paidPrice) && offer.paidPrice > 0) total.paidPrice += offer.paidPrice;
      else total.paidUnknown++;
      currencies.set(offer.currency, total);
    }
    const totals = [...currencies.values()].sort((a, b) => a.currency.localeCompare(b.currency)).map(total => ({ ...total, price: Math.round(total.price * 1e6) / 1e6, paidPrice: Math.round(total.paidPrice * 1e6) / 1e6 }));
    return { count: unique.size, priced, unknown: unique.size - priced, zero, totals };
  }
  const api = { canonical, normalize, item, key, pair, match, paginate, priceTotals, freshOwnership };
  root.BCCore = api;
  if (typeof module !== "undefined") module.exports = api;
})(globalThis);
