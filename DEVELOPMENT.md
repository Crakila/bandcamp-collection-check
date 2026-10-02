# Bandcamp Collection Check — development notes

A local Firefox/Waterfox WebExtension that adds ownership badges and filters to Bandcamp artist and label music grids. The initial target is **Waterfox 6.7.5** (Manifest V2, Firefox 115+ APIs).

## Try it in Waterfox or Firefox

1. Open `about:debugging#/runtime/this-firefox`.
2. Choose **Load Temporary Add-on…** and select this directory’s `manifest.json`.
3. Sign in to your Bandcamp **fan account in a regular, non-container tab**.
4. Visit an artist or label’s `/music` page, for example <https://chancedelasoul.bandcamp.com/music>.
5. Wait for collection sync, then use **Missing**, **Review**, or **Owned** above the music grid.

Temporary installation lasts until the browser restarts. Source changes can be picked up with **Reload** in `about:debugging`, followed by reloading the Bandcamp tab. Node/npm are not needed for temporary installation.

## Behaviour

- Checks albums, EPs, and standalone tracks. Typed IDs prevent track purchases being treated as album purchases.
- Retrieves initial collection page data, then uses Bandcamp’s `collection_items` pagination endpoint. Hidden items use `hidden_items` when Bandcamp provides a reliable hidden count.
- Exact typed release IDs or canonical URLs mean **Owned**.
- Signed-in album/track pages also supply authoritative digital-purchase flags. Visiting a purchased release page records a verified ownership observation, even if the cached collection did not contain a matching entry. Matching grid cards update to **Owned · verified by Bandcamp**, with a green backing, and leave Missing/pricing calculations. Observations are scoped to the fan account and expire after six hours.
- Unmatched grid cards have a **Check ownership** button to fetch their release page while signed in. Checks validate the account before and after the request. Wishlist status, physical-only purchases, subscriptions and hidden “You own this” text templates are not treated as digital purchase evidence. Failed or indeterminate checks leave the card **Unchecked**, with a retry button.
- **“You own this” in the Full Digital Discography section is bundle ownership**, not necessarily an individual purchase. Checks examine the bundle’s typed release IDs separately. A current bundle list does not establish what was included in a past purchase; without an individual purchase confirmation, included releases remain Unchecked rather than being marked Owned solely from the bundle heading.
- Empty catalogue/link pages with no tracks, no individual digital download and no inclusion in a complete current bundle list are classified **Unavailable on this storefront**. Checking such a page, or visiting it while signed in, updates the grid and its **Unavailable** filter. These entries are excluded from Missing and missing-price calculations. A **View linked release** link appears when the page’s description points to another release, without automatically claiming the two entries are equivalent. Preorders, subscriber-only entries and incomplete bundle lists are not treated as unavailable just because they have no preview audio.
- Matching artist and title on a different storefront means **Probably owned**. Expand **Review your copies**, open your existing copy, and choose **Same release** or **Different release**. **Undo decision** reverses either choice.
- Label releases without artist metadata are resolved only when a same-title collection candidate exists. Failed artist checks remain **Unchecked**, with a retry button.
- **Missing** is shown only against a complete snapshot. Missing hidden counts or unrecognized collection records leave the snapshot incomplete, so unmatched releases remain **Unchecked**.
- Filters apply to cards rendered by Bandcamp, including dynamically added cards. Bandcamp’s own rendering supplies the rest of its embedded discography.
- Artwork uses native image loading so **Review** and **Owned** filters display covers even when Bandcamp’s lazy loader stops at hidden cards. Owned covers have a green backing, review covers an amber backing, and missing covers no added background.
- When Bandcamp offers a full digital discography, the panel shows **Buy digital discography — from [price and currency]**. It checks an artist/label release page for the enabled bundle and its discounted starting price. The link opens Bandcamp’s own purchase dialog in a new tab. This is the full bundle, including releases you already own; the final price is shown by Bandcamp. Offer data is cached in memory for ten minutes; the panel’s **Refresh collection** button also refreshes the offer.
- **Price missing releases** checks only confirmed missing releases, on demand. Large catalogues such as <https://businesscasual87.bandcamp.com/music> are priced one release page at a time, with progress and a **Stop price check** button. Owned, Review, Unavailable and Unchecked releases are excluded. Prices are cached in memory for ten minutes; **Refresh missing prices** fetches them again. JSON-LD prices on known empty, unpurchasable catalogue pages do not count as individual purchase offers.
- Individual totals use the exact digital album/track offer, excluding cassettes, subscriptions and discography bundles. Different currencies are kept separate. Unavailable or failed prices produce an explicitly incomplete subtotal. A request failure stops the scan so it can be retried later. Changes to the account or missing-release list cancel an in-progress scan.
- Zero-price downloads and paid purchases are distinguished: free downloads may not add releases to your Bandcamp collection. The panel also shows a **paid-price estimate** using Bandcamp’s separate nonzero minimum where supplied; unknown paid minimums are explicitly labelled. These are starting prices before taxes or discount codes. The full bundle may exclude subscription-only releases visible in the music grid, so the extension shows both prices without assuming that the bundle contains every missing release.
- Caches collection metadata for six hours, refreshing on subsequent use or with **Refresh collection**. Failed refreshes retain the previous snapshot and explicitly show its timestamp.
- Cache and decisions are keyed by fan ID. Account identity is rechecked before collection access and before committing a sync or review decision. Returning focus to a music page after a minute rechecks the account.
- Popup cache clearing removes collection snapshots and page-verified ownership observations, preserving manual review decisions; decision resetting applies to the currently detected account.
- The toolbar badge shows the page’s missing count when the snapshot is complete.

The first version supports `https://*.bandcamp.com` grids. Custom-domain artist pages and private/container browsing are not supported. Collection sync uses the browser’s normal Bandcamp session, so these tabs are explicitly rejected rather than mixing sessions.

## Local data and permissions

`storage` holds fan ID/username, release ID/type/URL/title/artist, sync completeness/timestamp, page-verified purchase/availability observations with timestamps and optional linked release URLs, and review decisions. No download tokens, payment details, passwords, or wishlist entries are saved. Host permissions allow requests to Bandcamp and grid annotations. There is no server or telemetry. Uninstalling the extension removes its local storage.

Bandcamp’s collection endpoints are internal website interfaces and can change. If sync fails, the panel/popup reports the error; first check that you are signed in and that your collection page opens normally, then retry.

## Development and packaging

```sh
npm install
npm test
npm run lint
npm run build
```

The archive is written to `artifacts/`. For permanent Firefox installation, submit/sign the extension through Mozilla Add-ons (an unlisted distribution is possible). Waterfox’s acceptance of unsigned archives depends on its build/settings; temporary loading above is the development route. This repository does not include a signed extension.

## Verification

Automated tests cover URL normalization, typed IDs, edition differences, probable matches and decisions, incomplete pagination, cache retention after failures, account switching, container rejection, grid filters, lazy artwork, ownership backgrounds, dynamic cards, review controls, discography offers, digital-only pricing, mixed currencies, incomplete subtotals, opt-in scans and cancellation using mocked Bandcamp responses and a DOM environment. The Night Love regression verifies that owning a discography does not mark an excluded, empty catalogue entry owned or produce a fictitious individual price. Other tests cover unavailable filtering, partial bundle lists, preorders, subscriber-only entries and authoritative individual purchase confirmations.

The extension was also successfully installed as a temporary add-on in a disposable, headless **Waterfox 6.7.5** profile. That smoke check verifies installation, not authenticated collection retrieval or visual layout.

The manifest declares the identifying/account information, browsing URLs and website content used for authenticated Bandcamp requests. Firefox 140+ supplies the native consent experience. Older versions, including Waterfox builds based on Firefox 115, use an explicit local consent page before the extension may make requests. The user can pause access or delete saved data from **Privacy & access**. No developer-operated server or analytics is involved.

The release-preparation build was successfully installed in disposable headless Firefox 157 and Waterfox 6.7.5 profiles. `web-ext lint` has no errors; its two compatibility warnings refer to the newer native consent key on older Firefox/Android versions. The custom consent fallback supports the older desktop target. Android is not advertised or tested.

For live acceptance in Waterfox 6.7.5:

1. Check collection size/progress against your real account, including a known hidden purchase.
2. Check CHANCE デラソウル’s grid and confirm its total matches Bandcamp’s rendered releases.
3. Review the Business Casual copy of **Goodbye Future Funk**; confirm and undo the equivalence.
4. Confirm a known track purchase does not mark its album owned.
5. Interrupt pagination while keeping account verification available: the old snapshot should remain, with an error and timestamp. If the signed-in account cannot be verified (for example, fully offline), ownership should become unchecked.
6. Switch accounts or sign out, then refresh: previous-account ownership must disappear.
7. Clear cached collection data and reset decisions from the popup.
8. Switch between **Owned**, **Review**, and **All** without scrolling first: the displayed album art should load and retain the appropriate backing colour.
9. On an artist offering a digital discography, check the panel’s starting price against Bandcamp and follow the button to the full-discography purchase dialog.
10. On Business Casual, click **Price missing releases** and compare the individual subtotal and paid-price estimate with the full bundle. Stop during loading, then refresh prices. Unavailable/subscriber-only releases must remain unpriced rather than contributing a zero.
11. On <https://sunset-network.bandcamp.com/music>, use **Check ownership** on **Night Love**, or reload its album page and return to the grid. Its currently empty Sunset Network entry is not in the published 12-release discography bundle; absent an actual individual purchase record, it should show **Unavailable on this storefront** and a link to the DMT Records release, leaving Missing/pricing calculations. A genuine individual purchase confirmed by Bandcamp still takes precedence over availability. Switch accounts and refresh to verify observations are not shared.

Authenticated live requests and UI compatibility must be checked in your browser session; automated mocks do not establish those outcomes.

## Public release

- Permanent extension ID: `bandcamp-collection-check@pf.ie`. Keep it unchanged for future releases.
- The permanent ID replaces the earlier `@local` development ID. Remove that temporary add-on before loading the public build, then reload Bandcamp tabs. Firefox treats the two IDs as separate extensions; cached data is not migrated.
- Core features have been tested by the project owner in desktop Firefox 157. Advertise desktop Firefox only on AMO; do not select Firefox for Android.
- License: MIT. Public support: <https://github.com/Crakila/bandcamp-collection-check/issues>.
- AMO privacy-policy URL: <https://github.com/Crakila/bandcamp-collection-check/blob/main/PRIVACY.md>.
- Runtime source is plain, unminified JavaScript. `npm run build` packages it without transpilation or bundling. Development dependencies are not shipped in the extension.
- Build environment: Node.js 22 and npm 10 on Linux. Use `npm ci`, `npm test`, `npm run lint`, and `npm run build` from the repository root.
- The GitHub workflow runs the same checks and uploads the ZIP as a workflow artifact.

### Suggested AMO listing

**Name:** Bandcamp Collection Check

**Summary:** Find missing Bandcamp releases, review cross-label matches, and compare digital prices.

**Description:** Compare an artist or label’s Bandcamp music grid with your signed-in collection. See Owned, Missing, Review, Unavailable and Unchecked releases, confirm probable cross-label matches, and compare individual digital prices with an available full-discography offer. Collection metadata and your review decisions stay in your browser. Requests go to Bandcamp using your existing session; artwork uses Bandcamp’s usual image hosts. No developer server or analytics. A Bandcamp fan account and a regular, non-container tab are required. Custom-domain pages and private/container browsing are not supported. Unofficial; not affiliated with Bandcamp.

### Reviewer instructions

1. Install the extension in desktop Firefox and accept its required data permissions. On older supported browsers, explicitly enable Bandcamp access on the local privacy page.
2. Sign in to the dedicated Bandcamp test account provided privately in the AMO reviewer notes. The account should contain a small collection with at least one album and one track. Never put those credentials in the repository.
3. Visit an artist’s `/music` page and wait for sync. Test All, Missing, Review, Owned and Unavailable filters. Check that owning a track does not mark its album owned.
4. Test **Check ownership**, **Price missing releases**, and the full-discography link. Purchase links open Bandcamp’s own interface; the extension does not submit purchases.
5. Open **Privacy & access**, pause Bandcamp access, and verify that refresh/pricing requests stop. **Delete saved data** removes collection, page observations and review decisions. Enable access again to resume.

Permissions are limited to extension-local storage and Bandcamp hosts. Read-only collection endpoints and release-page metadata are used to provide the features. Review decisions are local. Network requests reuse the browser’s normal Bandcamp session; no passwords, session cookies or payment details are saved by the extension.
