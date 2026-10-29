# Where the fonts come from

Each font is from its project's own release (or, for JetBrains Mono's italic, its repository at a fixed commit), checked
against the digest GitHub or npm publishes where there is one, and kept with its license. Nothing is fetched from another
site when the app runs: the page's security policy allows fonts only from the app itself.

`JetBrainsMono.woff2`, `OFL.txt`, `Geist.woff2`, and `Geist-OFL.txt` are the app's own fonts and are not covered here.

## Whole files, as released

| File                         | From                                                                                                                                                                                                                       |  Bytes |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -----: |
| `JetBrainsMono-Italic.woff2` | [JetBrains Mono](https://github.com/JetBrains/JetBrainsMono) at commit `19371302b95d218af43299bce79ddbddd0bc364d`: `fonts/webfonts/JetBrainsMono-Italic[wght].woff2` (git blob `5e8a82e3669297716702f70a5f9ca242ca050896`) | 123160 |

## Cut down

This one is cut down, so the browser downloads less. The Nerd Fonts symbols are under MIT and the licenses of their icon
sets, and keep every name record of the original.

- **Nerd Fonts symbols** (`NerdFontsSymbolsMono.woff2`): from
  [Nerd Fonts 3.5.1](https://github.com/ryanoasis/nerd-fonts/releases/tag/v3.5.1), `NerdFontsSymbolsOnly.tar.xz`
  (SHA-256 `01172f37db8543edb102e5cb5c64101c9f4686630804d49b419aa07b23a69996`), `SymbolsNerdFontMono-Regular.ttf`: the
  Mono build, each icon one cell wide. Cut to the private use areas its icons fill (`U+E000-F8FF`, `U+F0000-F1AF0`, as
  its `@font-face` says) and saved as WOFF2. `NerdFonts-LICENSE.txt` and `NerdFonts-README.txt` are the release's.

## SHA-256 of each file here

```text
76a805b6ea613ce2e3973f1bac6fa29db23116b2881390b59247d22890844ecc  JetBrainsMono-Italic.woff2
6874ea10824785e9e6fd88a6dae5cfb663945dd09e151c3c2e329064d89d9752  NerdFontsSymbolsMono.woff2
```
