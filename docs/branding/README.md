# Branding

Agora's artwork depicts a public courtyard framed by ivory colonnades, with
gold evening light and a deep navy sky.

- `agora-courtyard.png`: detailed artwork for larger branding uses, with olive
  trees, stonework, and people in conversation.
- `icon.png`: simplified companion used as the source for browser favicons and
  the Apple touch icon. It retains the courtyard, columns, olive tree, and sun,
  but removes people and fine architectural ornament.

Both original PNGs are 1254 × 1254 pixels and were generated with GPT-image-2
through Hermes's Codex OAuth image provider. The simplified icon was generated
using the detailed artwork as an image reference, not drawn with code.
Neither source asset is displayed in the chat interface.

## Regenerate browser icons

Run `agora-icons` from the Nix development shell to regenerate the 16, 32, 48,
and 192-pixel PNGs, the multi-size ICO, and the 180-pixel Apple touch icon.
ImageMagick is included in the shell. These are raster reductions of `icon.png`,
not separately generated illustrations. The touch icon uses an opaque navy
background if the source contains transparency.

## Artwork direction

The detailed artwork uses an open Greek public square enclosed by covered
colonnades, broad foreground steps, olive trees, small conversational figures,
and golden evening light. Its illustration combines bold navy and warm ivory
shapes with architectural detail and restrained gold accents.

The simplified companion preserves the courtyard composition and palette with
fewer columns, broad roof bands, three foreground steps, and one olive tree.
People, statues, pottery, distant scenery, engraved stonework, and roof tiles
are removed. Both versions omit text, monograms, and speech-bubble symbols.

