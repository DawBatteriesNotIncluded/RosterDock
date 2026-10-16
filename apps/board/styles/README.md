# Style packs in the build

`vendor/` holds each style pack's file (`<id>.md`) exactly as its authors published it at the commit
`src/styles/catalog.ts` pins, with the repository's licence beside it (`<id>.LICENSE`, after one line
saying where both came from). `scripts/vendor-styles.mts` writes them, and nobody edits them by hand:
run it again when a pin moves, and `test/styles.test.ts` fails until someone has. Prettier and git leave
these bytes alone (`.prettierignore`, `.gitattributes`), since one changed byte breaks the hash.
