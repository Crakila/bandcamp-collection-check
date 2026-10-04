# Bandcamp Collection Check
[![Static Badge](https://img.shields.io/badge/Download%20Now-Firefox?style=flat&logo=firefoxbrowser&label=Firefox)](https://addons.mozilla.org/en-GB/firefox/addon/bandcamp-collection-check/)
 | ![Mozilla Add-on Users](https://img.shields.io/amo/users/bandcamp-collection-check) | ![Mozilla Add-on Downloads](https://img.shields.io/amo/dw/bandcamp-collection-check)

A desktop Firefox add-on that shows which releases you own while browsing Bandcamp artist and label music pages.

## Features

- **Owned:** green artwork backing for releases in your collection.
- **Review:** amber backing for probable matches from another artist or label storefront.
- **Missing, Unavailable and Unchecked:** keep purchasable gaps separate from unavailable releases and uncertain results.
- Filter the music grid, confirm cross-label matches, and check ownership directly with Bandcamp.
- Compare missing releases’ digital starting prices with an available full-discography offer.
- Cache collection metadata and review decisions locally in your browser.

Core features have been tested in **desktop Firefox 157**. Firefox for Android is not supported.

## Try it

1. Download or clone this repository.
2. Open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on…**, and select `manifest.json`.
3. Accept the requested data permissions. Older supported browsers ask you to enable Bandcamp access on a local privacy page.
4. Sign in to a Bandcamp fan account in a regular, non-container tab and visit an artist or label’s `/music` page.

Temporary installation lasts until Firefox restarts. Custom-domain pages and private/container browsing are not supported. This is an unofficial add-on, not affiliated with Bandcamp.

## Privacy

Requests go to Bandcamp using your existing session; artwork uses Bandcamp’s usual image hosts. There is no developer server or analytics. You can pause access or delete saved data under **Privacy & access**. Read the short [privacy policy](PRIVACY.md).

## Support and contributions

[Report issues on GitHub](https://github.com/Crakila/bandcamp-collection-check/issues). Contributions, bug reports and improvements are welcome. See [development notes](DEVELOPMENT.md) for setup, tests and release instructions.

Source: [GitHub](https://github.com/Crakila/bandcamp-collection-check) · [code.pf.ie](https://code.pf.ie/Crakila/bandcamp-collection-check).

## Licence and AI assistance

Released under the [MIT licence](LICENSE).

This add-on was created with assistance from **ChatGPT 6.1 Sol** (OpenAI’s `gpt-6.1-sol` model).
