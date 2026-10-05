# Icon

`icon.png` is the original image generated with the built-in imagegen tool. It
is retained as a source asset and is not displayed in the chat interface.
The browser favicon files in `public/` are raster reductions of this image.

Run `agora-icons` from the Nix development shell to regenerate the PNG, ICO, and
Apple touch icons. ImageMagick is included in the shell. The touch icon uses an
opaque green background; the other icons preserve the source transparency.

## Generation prompt

```text
Use case: logo-brand
Asset type: raster application icon and source for tiny browser favicons for Agora, a focused chat client for Hermes.
Primary request: Design one polished, distinctive minimal chat icon matching the application's warm ivory and muted sage green appearance. A single bold ivory conversation bubble with a simple open arch suggested by the negative space inside, on a deep forest/sage green rounded square. The subtle arch recalls a meeting place; the silhouette reads immediately as conversation. Keep the mark very simple and substantial, legible at 16 pixels.
Style/medium: beautifully finished raster app icon, flat graphic shapes, crisp edges, restrained subtle surface shading, professional and quiet.
Composition/framing: square 1024x1024 canvas; rounded-square tile almost fills canvas with only about 4% transparent margin; central ivory mark occupies about 65% of tile width. Front-on, perfectly centered, no perspective.
Color palette: dark green #415b3a, sage #819570, warm ivory #faf9f5, matching a calm chat UI.
Constraints: one icon only, real transparent pixels outside rounded-square tile; no text, no letters, no wordmark, no tiny details, no robots, no sparkles, no surrounding scene, no mockup, no watermark, no external shadow. Clear high contrast and bold silhouette suitable for both light and dark browser tabs.
```

