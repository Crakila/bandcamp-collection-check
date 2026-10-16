# Vendored anti-slop

Source: https://github.com/dmmulroy/anti-slop
Revision: `13909c9e07590f5a85d93c62712259fe14a883f7`

Copied from `src/`: generic production rules, shared helpers, and the spacing
rule's ESLint Stylistic vendor files, including their licence and provenance.
Effect rules and upstream test suites are omitted. Production source is unchanged;
`package.json` is a local addition to load the plugin as ES modules without changing
the extension or Node test module format. `LICENSE` is the upstream MIT licence.

Project policy lives in the root `.oxlintrc.json`. Runtime `typeof` checks remain
allowed because this JavaScript extension validates external Bandcamp/browser data
without a schema library. The symbol-name and readable-spacing rules are left
unconfigured to preserve local naming and formatting conventions. All other generic
anti-slop rules are errors, including TypeScript rules for any future TypeScript.

To update, fetch and identify an upstream commit, compare its `src/` with this
revision, and review changes before copying them. Preserve local policy, this module
marker, and both licences; update this revision when done. Upgrade `oxlint` and
`@oxlint/plugins` together to the same exact version. Run `npm test`, `npm run lint`,
and `npm run build`, then verify the ZIP excludes `tools/` and `.oxlintrc.json`.
