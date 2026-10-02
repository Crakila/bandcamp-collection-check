(function () {
  "use strict";
  // Album/track visits are useful even without a music grid: a verified page
  // purchase can fill gaps in the collection listing; an empty catalogue page
  // can also establish that an unmatched entry is unavailable at this store.
  function reportPageOwnership() {
    const pageOwnership = BCPage.ownershipEvidence(document, location.href);
    if (pageOwnership && (pageOwnership.owned === true || pageOwnership.availability?.available === false || pageOwnership.bundleOwned)) {
      browser.runtime.sendMessage({ type: "check-ownership", fanId: pageOwnership.fanId, url: pageOwnership.release.url, id: pageOwnership.release.id, releaseType: pageOwnership.release.type }).catch(() => {});
    }
  }
  reportPageOwnership();
  browser.storage.onChanged.addListener((changes, area) => { if (area === "local" && changes.bandcampConsent) reportPageOwnership(); });
  const grid = document.querySelector("#music-grid");
  if (!grid) return;
  const band = BCPage.jsonAttribute(document, "[data-band]", "data-band") || {};
  let state = { snapshot: null, decisions: {}, error: "" };
  let filter = "all", busy = false, timer, resolving = false;
  const metadata = new Map();
  const failedMetadata = new Set();
  const ownershipChecks = new Map();
  let checkingDiscography = false, checkedDiscography = false;
  const prices = new Map();
  let missingReleases = [], missingSignature = "", priceRun = 0, pricing = false, checkedPrices = 0, priceAttempted = false;
  const panel = el("section", "bcc-panel");
  panel.setAttribute("aria-label", "Bandcamp collection check");
  const heading = el("strong", "", "Collection check");
  const summary = el("p", "bcc-summary", "Checking your collection…");
  const info = el("p", "bcc-info");
  info.setAttribute("role", "status");
  const filters = el("div", "bcc-filters");
  const buttons = {};
  for (const [name, label] of [["all", "All"], ["missing", "Missing"], ["probable", "Review"], ["owned", "Owned"], ["unavailable", "Unavailable"], ["unchecked", "Unchecked"]]) {
    buttons[name] = button(label, () => { filter = name; render(); });
    filters.append(buttons[name]);
  }
  const refreshButton = button("Refresh collection", () => Promise.all([refresh(true), checkDiscography(true)]));
  filters.append(refreshButton);
  filters.append(button("Privacy & access", async () => {
    const result = await send({ type: "open-privacy" });
    if (result.error) throw new Error(result.error);
  }));
  panel.append(heading, summary, info, filters);
  const discography = el("div", "bcc-discography");
  discography.hidden = true;
  panel.append(discography);
  const pricePanel = el("div", "bcc-pricing");
  const priceButton = button("Price missing releases", () => checkMissingPrices());
  const stopButton = button("Stop price check", () => { priceRun++; pricing = false; renderPricing(); });
  const priceInfo = el("p", "bcc-info");
  priceInfo.setAttribute("role", "status");
  pricePanel.append(priceButton, stopButton, priceInfo);
  panel.append(pricePanel);
  grid.before(panel);
  function el(tag, className = "", text = "") {
    const node = document.createElement(tag);
    node.className = className;
    node.textContent = text;
    return node;
  }
  function button(text, handler) {
    const node = el("button", "", text);
    node.type = "button";
    node.addEventListener("click", async () => {
      node.disabled = true;
      try { await handler(); } catch (error) { info.textContent = error.message; }
      finally { node.disabled = false; }
    });
    return node;
  }
  async function send(message) {
    const result = await browser.runtime.sendMessage(message);
    return result || {};
  }
  function releases() {
    return [...grid.querySelectorAll(":scope > li.music-grid-item")].map(card => {
      const anchor = card.querySelector("a[href]");
      const url = BCCore.canonical(anchor?.href);
      const typed = /^(album|track)-(\d+)$/.exec(card.dataset.itemId || "");
      const titleNode = card.querySelector(".title");
      // Label titles may contain a separate artist subtitle; don't include it in the title.
      const title = titleNode ? [...titleNode.childNodes].filter(n => n.nodeType === Node.TEXT_NODE).map(n => n.textContent).join(" ").trim() : "";
      const subtitle = card.querySelector(".artist, .artist-override");
      const release = { url, type: typed?.[1] || (url.includes("/track/") ? "track" : "album"), id: typed?.[2] || "", title, artist: subtitle?.textContent.trim() || (band.is_label ? "" : band.name || "") };
      Object.assign(release, metadata.get(url) || {});
      return { card, release };
    }).filter(({ release }) => release.url);
  }
  function loadArtwork(card) {
    for (const image of card.querySelectorAll(".art img[data-original]")) {
      let url;
      try { url = new URL(image.dataset.original, location.href); } catch { continue; }
      if (!/^https?:$/.test(url.protocol)) continue;
      // Bandcamp's ordered lazy-load scan can stop at filtered-out cards.
      // Use native image loading so visible cards don't depend on that scan.
      image.loading = filter === "all" ? "lazy" : "eager";
      if (image.src !== url.href) image.src = url.href;
      image.style.removeProperty("display");
      image.style.removeProperty("opacity");
      image.style.removeProperty("visibility");
      image.classList.add("bcc-art-loaded");
    }
  }
  const money = (price, currency) => new Intl.NumberFormat(undefined, { style: "currency", currency, currencyDisplay: "code" }).format(price);
  function renderPricing() {
    priceButton.disabled = pricing || busy || !state.snapshot?.complete || !missingReleases.length;
    priceButton.textContent = `${priceAttempted ? "Refresh missing prices" : "Price missing releases"} (${missingReleases.length})`;
    stopButton.hidden = !pricing;
    priceInfo.replaceChildren();
    if (!state.snapshot?.complete) { priceInfo.textContent = "Complete collection sync before checking missing-release prices."; return; }
    if (!missingReleases.length) { priceInfo.textContent = "No confirmed missing releases to price. Review, unavailable and unchecked releases are excluded."; return; }
    if (!priceAttempted) { priceInfo.textContent = "Compare individual starting prices with the full discography. Prices are checked only when you click."; return; }
    const result = BCCore.priceTotals(missingReleases.map(release => ({ url: release.url, offer: prices.get(release.url)?.offer })));
    const parts = [];
    if (pricing) parts.push(`Checking prices: ${checkedPrices} / ${missingReleases.length}`);
    if (result.priced) {
      const label = result.unknown ? "Known individual subtotal" : "Missing individually: from";
      parts.push(`${label} ${result.totals.map(total => money(total.price, total.currency)).join(" + ")} (${result.priced} / ${result.count} priced)`);
      if (result.zero) {
        const paidUnknown = result.totals.reduce((sum, total) => sum + total.paidUnknown, 0);
        parts.push(`Paid-price ${result.unknown || paidUnknown ? "known subtotal" : "estimate: from"} ${result.totals.map(total => money(total.paidPrice, total.currency)).join(" + ")}${paidUnknown ? ` (${paidUnknown} paid minimums unknown)` : ""}`);
      }
    }
    if (result.unknown) parts.push(`${result.unknown} prices unchecked or unavailable; this is not a complete total`);
    const failure = missingReleases.map(release => prices.get(release.url)?.error).find(Boolean);
    if (failure) parts.push(`Price check stopped: ${failure}. Use Refresh missing prices to retry.`);
    parts.push("Review, unavailable and unchecked releases excluded. Advertised starting prices before taxes or discount codes.");
    if (result.zero) parts.push(`${result.zero} releases allow a zero-price download. Free downloads may not add releases to your collection; paid minimums are shown separately where available.`);
    priceInfo.textContent = parts.join(" · ");
  }
  async function checkMissingPrices() {
    if (pricing || !state.snapshot?.complete || !missingReleases.length) return;
    const run = ++priceRun;
    const force = priceAttempted;
    for (const release of missingReleases) prices.delete(release.url);
    pricing = true;
    checkedPrices = 0;
    priceAttempted = true;
    renderPricing();
    for (const release of [...missingReleases]) {
      let result;
      try { result = await send({ type: "digital-price", url: release.url, force }); }
      catch (error) { result = { error: error.message }; }
      if (run !== priceRun) return;
      prices.set(release.url, result);
      checkedPrices++;
      renderPricing();
      // Stop on a request failure rather than hammering a rate-limited service.
      if (result.error) break;
    }
    if (run === priceRun) { pricing = false; render(); }
  }
  async function checkDiscography(force = false) {
    if (checkingDiscography || (checkedDiscography && !force) || band.meets_buy_full_discography_criteria === false) return;
    const release = releases().find(({ release }) => new URL(release.url).origin === location.origin)?.release;
    if (!release) return;
    checkingDiscography = true;
    discography.hidden = true;
    try {
      const result = await send({ type: "discography", url: release.url, bandId: band.id, force });
      checkedDiscography = true;
      discography.replaceChildren();
      if (result.error) {
        discography.append(el("span", "bcc-info", "Discography price could not be checked."), button("Retry", () => checkDiscography(true)));
        discography.hidden = false;
        return;
      }
      if (!result.offer) return;
      const offer = result.offer;
      const price = money(offer.price, offer.currency);
      const link = el("a", "bcc-discography-buy", `Buy digital discography — from ${price}`);
      link.href = offer.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      discography.append(link, el("span", "bcc-info", `${offer.count == null ? "Full digital discography" : `${offer.count} releases`} · Full bundle, including releases you already own`));
      discography.hidden = false;
    } catch (error) {
      discography.replaceChildren(el("span", "bcc-info", "Discography price could not be checked."), button("Retry", () => checkDiscography(true)));
      discography.hidden = false;
    } finally { checkingDiscography = false; }
  }
  async function decide(release, candidate, value) {
    const result = await send({ type: "decision", fanId: state.user?.fanId, a: release.url, b: candidate.url, value });
    if (result.error) throw new Error(result.error);
    state.decisions = result.decisions;
    render();
  }
  async function checkOwnership(release) {
    const fanId = state.user?.fanId;
    if (!fanId || ownershipChecks.get(release.url)?.checking) return;
    ownershipChecks.set(release.url, { checking: true });
    render();
    let result;
    try { result = await send({ type: "check-ownership", fanId, url: release.url, id: release.id, releaseType: release.type }); }
    catch (error) { result = { error: error.message }; }
    if (state.user?.fanId !== fanId) return;
    if (!result.error && result.fanId !== fanId) result = { error: "Account changed. Refresh before checking ownership." };
    if (result.error) ownershipChecks.set(release.url, { error: result.error });
    else {
      state.ownership = result.ownership || {};
      const unknown = result.availability?.available !== false && (result.owned == null || (result.owned !== true && result.bundleOwned && result.bundleIncludesRelease !== false));
      ownershipChecks.set(release.url, { unknown, message: result.message || (result.owned === false ? "Bandcamp did not mark this individual digital release as purchased." : result.owned == null ? "Bandcamp did not return a definite ownership status." : "") });
    }
    render();
  }
  function render() {
    observer.disconnect();
    const entries = releases();
    const missing = new Map();
    const counts = { all: entries.length, missing: 0, probable: 0, owned: 0, unavailable: 0, unchecked: 0 };
    for (const { card, release } of entries) {
      const result = BCCore.match(release, state.snapshot, state.decisions, state.ownership);
      const ownershipCheck = ownershipChecks.get(release.url);
      // A title-only label candidate needs artist verification before declaring it missing.
      const needsMetadata = !release.artist && (state.snapshot?.items || []).some(i => i.type === release.type && BCCore.normalize(i.title) === BCCore.normalize(release.title));
      if (needsMetadata && result.status === "missing") result.status = "unchecked";
      if (result.status !== "owned" && (ownershipCheck?.checking || ownershipCheck?.error || ownershipCheck?.unknown)) result.status = "unchecked";
      if (result.status === "missing") missing.set(release.url, release);
      counts[result.status]++;
      card.classList.toggle("bcc-hidden", filter !== "all" && result.status !== filter);
      card.classList.toggle("bcc-art-owned", result.status === "owned");
      card.classList.toggle("bcc-art-probable", result.status === "probable");
      if (state.user && !card.classList.contains("bcc-hidden")) loadArtwork(card);
      card.querySelector(":scope > .bcc-status")?.remove();
      const badge = el("div", `bcc-status bcc-${result.status}`);
      const labels = { owned: result.reason === "page" ? "✓ Owned · verified by Bandcamp" : result.reason === "confirmed" ? "✓ Owned · confirmed equivalent" : "✓ Owned", probable: "≈ Probably owned · review", missing: "○ Not found in cached collection", unavailable: "— Unavailable on this storefront", unchecked: ownershipCheck?.checking ? "? Checking with Bandcamp…" : ownershipCheck?.error || ownershipCheck?.unknown || result.pageStatus ? "? Ownership unchecked" : needsMetadata ? "? Artist match unchecked" : "? Collection unchecked" };
      badge.append(el("strong", "", labels[result.status]));
      if (result.pageStatus?.message) badge.append(el("div", "bcc-ownership-note", result.pageStatus.message));
      if (result.pageStatus?.linkedReleaseUrl) {
        const link = el("a", "bcc-linked-release", "View linked release");
        link.href = result.pageStatus.linkedReleaseUrl;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        badge.append(link);
      }
      const reviewed = (state.snapshot?.items || []).filter(i => state.decisions[BCCore.pair(release, i)]);
      const candidates = [...new Map([...result.candidates, ...reviewed].map(i => [i.url, i])).values()];
      if (candidates.length) {
        const details = el("details");
        details.append(el("summary", "", result.status === "probable" ? "Review your copies" : "Match details"));
        for (const candidate of candidates) {
          const row = el("div", "bcc-candidate");
          const link = el("a", "", `${candidate.artist} — ${candidate.title}`);
          link.href = candidate.url;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          row.append(link);
          const decision = state.decisions[BCCore.pair(release, candidate)];
          if (decision) {
            row.append(el("span", "", decision === "same" ? "Confirmed equivalent" : "Marked as different"));
            row.append(button("Undo decision", () => decide(release, candidate, "reset")));
          } else if (!["exact", "page"].includes(result.reason)) {
            row.append(button("Same release", () => decide(release, candidate, "same")), button("Different release", () => decide(release, candidate, "different")));
          }
          details.append(row);
        }
        badge.append(details);
      }
      if (needsMetadata && failedMetadata.has(release.url)) badge.append(button("Retry artist check", () => { failedMetadata.delete(release.url); return resolveArtists(); }));
      if (result.status !== "owned" && state.user) {
        const verify = button(result.status === "unavailable" ? "Recheck status" : ownershipCheck?.error || ownershipCheck?.unknown ? "Retry ownership check" : "Check ownership", () => checkOwnership(release));
        verify.disabled = Boolean(ownershipCheck?.checking);
        badge.append(verify);
        if ((ownershipCheck?.error || ownershipCheck?.message) && ownershipCheck.message !== result.pageStatus?.message) badge.append(el("div", "bcc-ownership-note", ownershipCheck.error || ownershipCheck.message));
      }
      const offer = prices.get(release.url)?.offer;
      if (result.status === "missing" && offer) badge.append(el("div", "bcc-release-price", `Digital: from ${money(offer.price, offer.currency)}${offer.price === 0 && offer.paidPrice != null ? ` · Paid minimum ${money(offer.paidPrice, offer.currency)}` : ""}`));
      card.append(badge);
    }
    summary.textContent = `${counts.owned} / ${counts.all} owned · ${counts.probable} probable · ${counts.missing} missing${counts.unavailable ? ` · ${counts.unavailable} unavailable` : ""}${counts.unchecked ? ` · ${counts.unchecked} unchecked` : ""}`;
    for (const [name, node] of Object.entries(buttons)) {
      node.textContent = `${({ all: "All", missing: "Missing", probable: "Review", owned: "Owned", unavailable: "Unavailable", unchecked: "Unchecked" })[name]} (${counts[name]})`;
      node.setAttribute("aria-pressed", String(filter === name));
    }
    refreshButton.disabled = busy;
    missingReleases = [...missing.values()];
    const signature = JSON.stringify([state.user?.fanId, ...[...missing.keys()].sort()]);
    if (signature !== missingSignature) {
      missingSignature = signature;
      priceRun++;
      pricing = false;
      priceAttempted = false;
      checkedPrices = 0;
    }
    renderPricing();
    if (!busy) {
      const snapshot = state.snapshot;
      info.textContent = state.error || (snapshot ? `${state.user.username} · ${snapshot.items.length} collection releases · Updated ${new Date(snapshot.updatedAt).toLocaleString()}${snapshot.complete ? "" : " · Incomplete: unmatched releases remain unchecked"}` : "Sign in to Bandcamp and refresh your collection.");
      if (state.error && snapshot) info.textContent += ` Using previous snapshot from ${new Date(snapshot.updatedAt).toLocaleString()}.`;
    }
    send({ type: "badge", count: state.snapshot?.complete ? counts.missing : null }).catch(() => {});
    observer.observe(grid, { childList: true, subtree: true });
  }
  async function resolveArtists() {
    if (resolving || !state.snapshot) return;
    resolving = true;
    try {
      for (const { release } of releases()) {
        if (release.artist || metadata.has(release.url) || failedMetadata.has(release.url)) continue;
        if (!state.snapshot.items.some(i => i.type === release.type && BCCore.normalize(i.title) === BCCore.normalize(release.title))) continue;
        const result = await send({ type: "metadata", url: release.url });
        if (result.error) failedMetadata.add(release.url); else metadata.set(release.url, result);
        render();
      }
    } finally { resolving = false; }
  }
  async function refresh(force = false) {
    if (busy) return;
    busy = true;
    ownershipChecks.clear();
    state = { snapshot: null, decisions: {}, error: "" };
    render();
    refreshButton.disabled = true;
    info.textContent = "Checking signed-in account and loading collection…";
    const polling = setInterval(async () => {
      try { const result = await send({ type: "progress" }); if (result.progress) info.textContent = result.progress; } catch { /* Refresh reports errors. */ }
    }, 800);
    try {
      const result = await send({ type: "state", force });
      // No authenticated identity means the prior account's snapshot must not be shown.
      state = result.user ? result : { snapshot: null, decisions: {}, error: result.error };
    } catch (error) { state = { snapshot: null, decisions: {}, error: error.message }; }
    finally { busy = false; clearInterval(polling); render(); }
    await resolveArtists();
  }
  const observer = new MutationObserver(records => {
    if (!records.some(record => [...record.addedNodes, ...record.removedNodes].some(node => node.nodeType === Node.ELEMENT_NODE && !node.closest?.(".bcc-status")))) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      render();
      resolveArtists().catch(error => { info.textContent = error.message; });
      checkDiscography();
    }, 100);
  });
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.bandcampConsent) {
      if (changes.bandcampConsent.newValue?.allowed === false) {
        state = { snapshot: null, decisions: {}, error: "Bandcamp access is paused. Open Privacy & access to enable it." };
        ownershipChecks.clear();
        render();
      } else { refresh(); checkDiscography(true); }
      return;
    }
    const fanId = state.user?.fanId;
    if (fanId && changes[`decisions:${fanId}`]) state.decisions = changes[`decisions:${fanId}`].newValue || {};
    if (fanId && changes[`collection:${fanId}`]) state.snapshot = changes[`collection:${fanId}`].newValue || null;
    if (fanId && changes[`ownership:${fanId}`]) state.ownership = changes[`ownership:${fanId}`].newValue || {};
    render();
  });
  let lastFocus = Date.now();
  window.addEventListener("focus", () => { if (Date.now() - lastFocus > 60000) { lastFocus = Date.now(); refresh(); } });
  browser.runtime.onMessage.addListener(message => { if (message.type === "refresh-page") return refresh(Boolean(message.force)).then(() => ({})); });
  render();
  refresh();
  checkDiscography();
})();
