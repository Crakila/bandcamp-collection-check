(function (root) {
  "use strict";
  function jsonAttribute(doc, selector, attribute) {
    try { return JSON.parse(doc.querySelector(selector)?.getAttribute(attribute) || "null"); } catch { return null; }
  }
  function identity(doc) {
    const context = jsonAttribute(doc, "[page-context]", "page-context") || jsonAttribute(doc, "#HomepageApp", "data-blob")?.pageContext;
    const user = context?.identity;
    if (!user?.isLoggedIn || !user.fanId || !user.fanUsername) return null;
    return { fanId: String(user.fanId), username: user.fanUsername };
  }
  function collection(doc) {
    const data = jsonAttribute(doc, "#pagedata", "data-blob");
    if (!data?.fan_data || !data.collection_data) throw new Error("Bandcamp collection page data was not found. Open your collection in Bandcamp and retry.");
    return data;
  }
  function initial(data, kind) {
    const section = data[`${kind}_data`];
    const cache = data.item_cache?.[kind] || {};
    return (section?.sequence || []).map(id => cache[id]).filter(Boolean);
  }
  function discography(doc, releaseUrl, expectedBandId) {
    const band = jsonAttribute(doc, "[data-band]", "data-band");
    const data = jsonAttribute(doc, "#pagedata", "data-blob");
    const bundle = data?.buyfulldisco;
    if (!band || (expectedBandId != null && String(band.id) !== String(expectedBandId))) return null;
    if (!bundle?.enabled || data.show_buy_full_disco === false || !/^\d+$/.test(String(bundle.bundle_id))) return null;
    if (bundle.price == null || String(bundle.price).trim() === "") return null;
    const price = Number(bundle.price);
    // Release pages use a smaller data-band object than music grids. Their
    // selling currency is attached to Bandcamp's currency-data script instead.
    const currency = String(doc.querySelector("[data-band-currency]")?.getAttribute("data-band-currency") || band.currency || "").toUpperCase();
    const canonical = root.BCCore.canonical(releaseUrl);
    if (!canonical || !Number.isFinite(price) || price < 0 || !/^[A-Z]{3}$/.test(currency)) return null;
    const url = new URL(canonical);
    url.searchParams.set("action", "buy");
    url.searchParams.set("buy_id", `b${bundle.bundle_id}`);
    return { url: url.href, price, currency, count: Number.isInteger(bundle.tralbum_count) ? bundle.tralbum_count : null };
  }
  function digitalPrice(doc, releaseUrl) {
    if (releaseAvailability(doc, releaseUrl)?.available === false) return null;
    const current = jsonAttribute(doc, "[data-tralbum]", "data-tralbum")?.current;
    const canonical = root.BCCore.canonical(releaseUrl);
    if (!canonical || !current?.id || !["album", "track"].includes(current.type) || current.private || current.killed) return null;
    const type = current.type === "album" ? "a" : "t";
    for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
      let data;
      try { data = JSON.parse(script.textContent); } catch { continue; }
      const roots = Array.isArray(data) ? data : [data];
      for (const root of [...roots, ...roots.flatMap(node => node?.["@graph"] || [])]) {
        for (const product of [root, ...([].concat(root?.albumRelease || []))]) {
          const props = Object.fromEntries((product?.additionalProperty || []).map(prop => [prop.name, prop.value]));
          if (props.item_type !== type || String(props.item_id) !== String(current.id) || product.musicReleaseFormat !== "DigitalFormat") continue;
          const offer = Array.isArray(product.offers) ? product.offers[0] : product.offers;
          if (!offer || /SoldOut|Discontinued|OutOfStock/.test(offer.availability || "")) continue;
          const raw = offer.priceSpecification?.minPrice ?? offer.price;
          const price = Number(raw), currency = String(offer.priceCurrency || "").toUpperCase();
          if (raw == null || String(raw).trim() === "" || !Number.isFinite(price) || price < 0 || !/^[A-Z]{3}$/.test(currency)) continue;
          const nonzero = Number(current.minimum_price_nonzero);
          const paidPrice = price > 0 ? price : Number.isFinite(nonzero) && nonzero > 0 ? nonzero : null;
          return { price, paidPrice, currency };
        }
      }
    }
    return null;
  }
  function bundleMembership(bundle, current) {
    if (!bundle?.enabled || !Array.isArray(bundle.tralbums)) return null;
    const type = current.type === "album" ? "a" : "t";
    if (bundle.tralbums.some(item => String(item.item_id) === String(current.id) && (item.item_type === type || item.item_type === current.type))) return true;
    return bundle.tralbum_count === bundle.tralbums.length ? false : null;
  }
  function releaseAvailability(doc, releaseUrl) {
    const tralbum = jsonAttribute(doc, "[data-tralbum]", "data-tralbum");
    const current = tralbum?.current;
    const url = root.BCCore.canonical(releaseUrl);
    if (!url || !current?.id || !["album", "track"].includes(current.type)) return null;
    const actualUrl = root.BCCore.canonical(tralbum.url);
    if (actualUrl && actualUrl !== url) return null;
    if (tralbum.hasAudio !== false || !Array.isArray(tralbum.trackinfo) || tralbum.trackinfo.length) return null;
    if (tralbum.is_preorder || tralbum.album_is_preorder || tralbum.tralbum_subscriber_only || tralbum.freeDownloadPage || doc.querySelector(".buyItem.digital")) return null;
    const bundle = jsonAttribute(doc, "#pagedata", "data-blob")?.buyfulldisco;
    // A real bundle-only download must stay distinguishable from an empty
    // catalogue/redirect page. A partial bundle list cannot prove exclusion.
    if (bundle?.enabled && bundleMembership(bundle, current) !== false) return null;
    const linkedReleaseUrl = [...doc.querySelectorAll(".tralbumData a[href]")].map(link => root.BCCore.canonical(link.getAttribute("href"), url)).find(link => link && link !== url) || "";
    return { available: false, linkedReleaseUrl };
  }
  function hidden(element) {
    for (let node = element; node; node = node.parentElement) {
      if (node.hidden || node.getAttribute("aria-hidden") === "true" || node.classList.contains("hidden") || node.classList.contains("hiddenelem") || node.style.display === "none" || node.style.visibility === "hidden") return true;
    }
    return false;
  }
  function ownershipEvidence(doc, releaseUrl) {
    const tralbum = jsonAttribute(doc, "[data-tralbum]", "data-tralbum");
    const current = tralbum?.current;
    const collect = jsonAttribute(doc, "[data-tralbum-collect-info]", "data-tralbum-collect-info");
    const user = identity(doc);
    const fan = jsonAttribute(doc, "[data-fan]", "data-fan");
    const fanId = user?.fanId || (fan?.logged_in === true && collect?.fan_id ? String(collect.fan_id) : null);
    const url = root.BCCore.canonical(releaseUrl);
    if (!fanId || !url || !current?.id || !["album", "track"].includes(current.type)) return null;
    if (!new URL(url).pathname.startsWith(`/${current.type}/`)) return null;
    if (collect?.fan_id != null && String(collect.fan_id) !== fanId) return null;
    const actualUrl = root.BCCore.canonical(tralbum.url);
    if (actualUrl && actualUrl !== url) return null;
    // Wishlist entries, subscription streams and physical-only purchases are
    // not evidence that the digital album is owned. Ignore generic DOM text:
    // Bandcamp can include hidden "You own this" templates on unowned pages.
    const flags = [tralbum.is_purchased, collect?.is_purchased];
    const owned = flags.some(flag => flag === true || flag === 1) ? true : flags.some(flag => flag === false || flag === 0) ? false : null;
    const release = { type: current.type, id: String(current.id), url, title: current.title || "", artist: tralbum.artist || current.artist || "" };
    const bundle = jsonAttribute(doc, "#pagedata", "data-blob")?.buyfulldisco;
    const bundleSection = doc.querySelector(".buyItem.buyFullDiscography");
    const ownedHeading = bundleSection?.querySelector(".you-own-this.buyfulldisco");
    const buyButtons = bundleSection?.querySelectorAll('[data-test="buy-full-digital-discography"], button[data-bind*="fullDiscographyBuyDialog"]') || [];
    const bundleOwned = Boolean(bundle?.enabled && ownedHeading && !hidden(ownedHeading) && ![...buyButtons].some(button => !button.classList.contains("buy-again") && !hidden(button)));
    const bundleIncludesRelease = bundleMembership(bundle, current);
    const availability = releaseAvailability(doc, url);
    let message = "";
    if (availability?.available === false) message = `No audio tracks or digital download are available on this storefront.${bundle?.enabled && bundleIncludesRelease === false ? " This entry is not part of the current discography bundle." : ""}`;
    if (bundleOwned && owned !== true) {
      if (bundleIncludesRelease === false) message = `You own the discography bundle, but this release is not in its current release list.${availability?.available === false ? " No audio tracks or individual digital download are available here." : ""}`;
      else message = "You own a discography bundle, but Bandcamp did not confirm this individual release. A previous bundle purchase does not establish ownership of every release in today's bundle.";
    }
    return { fanId, release, owned, availability, bundleOwned, bundleIncludesRelease, message };
  }
  root.BCPage = { jsonAttribute, identity, collection, initial, discography, digitalPrice, ownershipEvidence, releaseAvailability };
})(globalThis);
