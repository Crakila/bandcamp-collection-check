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
  // Reuse these indexes for a whole grid instead of scanning the collection per card.
  function createMatcher(snapshot, decisions = {}, ownership = {}, now = Date.now()) {
    const add = (map, key, entry) => {
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(entry);
    };
    const idKey = release => JSON.stringify([release.type, release.id]);
    const titleKey = release => JSON.stringify([release.type, normalize(release.title)]);
    const candidateKey = release => JSON.stringify([release.type, normalize(release.artist), normalize(release.title)]);
    function index(items) {
      const ids = new Map(), urls = new Map();
      items.forEach((release, order) => {
        const entry = { release, order };
        if (release.id) add(ids, idKey(release), entry);
        if (release.url) add(urls, release.url, entry);
      });
      return { ids, urls };
    }
    const collection = index(snapshot?.items || []);
    const observations = index(Object.values(freshOwnership(ownership, now)));
    const titles = new Set(), candidates = new Map(), reviews = new Map();
    (snapshot?.items || []).forEach((release, order) => {
      titles.add(titleKey(release));
      if (release.url && normalize(release.artist) && normalize(release.title)) add(candidates, candidateKey(release), { release, order });
    });
    // Only decisions referring to an existing collection item can confirm a match.
    for (const [encoded, value] of Object.entries(decisions)) {
      if (!value) continue;
      let urls;
      try { urls = JSON.parse(encoded); } catch { continue; }
      if (!Array.isArray(urls) || urls.length !== 2 || urls.some(url => typeof url !== "string") || JSON.stringify([...urls].sort()) !== encoded) continue;
      for (const [a, b] of [[urls[0], urls[1]], [urls[1], urls[0]]]) {
        for (const entry of collection.urls.get(b) || []) add(reviews, a, entry);
      }
    }
    const ordered = entries => [...new Set(entries)].sort((a, b) => a.order - b.order).map(entry => entry.release);
    const exactMatches = (release, source) => ordered([
      ...(release.id ? source.ids.get(idKey(release)) || [] : []),
      ...(release.url ? source.urls.get(release.url) || [] : [])
    ]);
    let expiresAt = Infinity;
    for (const record of Object.values(ownership)) {
      if (!record) continue;
      const changeAt = record.updatedAt > now ? record.updatedAt : record.updatedAt + 6 * 60 * 60 * 1000;
      if (changeAt > now) expiresAt = Math.min(expiresAt, changeAt);
    }
    const reviewed = release => release.url ? ordered(reviews.get(release.url) || []) : [];
    function match(release) {
      const exact = exactMatches(release, collection)[0];
      if (exact) return { status: "owned", reason: "exact", candidates: [exact] };
      const pageRecords = exactMatches(release, observations);
      const verified = pageRecords.find(record => record.status == null || record.status === "owned");
      if (verified) return { status: "owned", reason: "page", candidates: [verified] };
      const pageStatus = pageRecords.find(record => ["unavailable", "unchecked"].includes(record.status));
      if (!snapshot) return { status: pageStatus?.status || "unchecked", candidates: [], pageStatus };
      const confirmed = reviewed(release).find(item => decisions[pair(release, item)] === "same");
      if (confirmed) return { status: "owned", reason: "confirmed", candidates: [confirmed] };
      const matches = release.url ? (candidates.get(candidateKey(release)) || []).map(entry => entry.release).filter(item => decisions[pair(release, item)] !== "different") : [];
      if (!matches.length && pageStatus) return { status: pageStatus.status, candidates: [], pageStatus };
      return { status: matches.length ? "probable" : snapshot.complete ? "missing" : "unchecked", candidates: matches };
    }
    return { match, reviewed, needsMetadata: release => !release.artist && titles.has(titleKey(release)), expiresAt };
  }
  function match(release, snapshot, decisions = {}, ownership = {}) {
    return createMatcher(snapshot, decisions, ownership).match(release);
  }
  async function paginate({ initial = [], count, cursor, fetchPage, progress = () => {}, getKey = value => JSON.stringify(value) }) {
    if (!Number.isInteger(count) || count < 0) throw new Error("Bandcamp did not provide a reliable collection count.");
    const seenItems = new Map(initial.map(value => [getKey(value), value]));
    const cursors = new Set();
    progress(seenItems.size, count);
    while (seenItems.size < count) {
      if (cursors.has(cursor)) throw new Error("Collection pagination stopped advancing.");
      cursors.add(cursor);
      const page = await fetchPage(cursor);
      if (!Array.isArray(page.items) || !page.items.length) throw new Error("Bandcamp returned an incomplete collection.");
      const previousSize = seenItems.size;
      for (const value of page.items) seenItems.set(getKey(value), value);
      if (seenItems.size === previousSize) throw new Error("Bandcamp returned a repeated collection page.");
      cursor = page.last_token;
      progress(seenItems.size, count);
      if (seenItems.size < count && !cursor) throw new Error("Bandcamp did not return the next collection cursor.");
      if (cursors.size > 10000) throw new Error("Collection pagination limit reached.");
    }
    return [...seenItems.values()];
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
  const api = { canonical, normalize, item, key, pair, match, createMatcher, paginate, priceTotals, freshOwnership };
  root.BCCore = api;
  if (typeof module !== "undefined") module.exports = api;
})(globalThis);
