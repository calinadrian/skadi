---
name: pixel-art
description: Make pixel art (sprites, icons, characters, tiles, scenes, UI) with the built-in pixel_* tools and use it in web pages or games. Use whenever the user asks for pixel art, sprites, 8-bit/16-bit or retro graphics, or a tileset.
triggers: pixel[\s-]?art|pixelart|pixel[\s-]?(icons?|sprites?|characters?|fonts?|style|graphics?|tiles?|avatars?|logos?)|sprites?(heets?)?|8[\s-]?bit|16[\s-]?bit|tile[\s-]?(sets?|maps?)|retro[\s-](game|style|look|graphics|art)|pixelated
---

# Pixel art

Skadi has a built-in pixel art studio. You paint on a small canvas with
drawing tools, look at the result as a text grid, fix it, and export a PNG.
Never write pixel art as SVG, CSS box-shadows or base64 by hand: use the tools.

## Quick start

1. `pixel_new` with a `name`, a `kind` (icon, character, tile, scene, ui) and
   a `palette` (default sweetie-16). Small is better: 16x16 or 32x32 for icons
   and tiles, 32x32 for characters, 96x54 for a scene. The reply lists the
   palette: use those index numbers as `color`, and -1 for transparent.
2. ONE `pixel_draw` call with many `ops`, biggest shapes first:
   `{"ops":[{"op":"ellipse","cx":15,"cy":17,"rx":10,"ry":8,"color":6},{"op":"rect","x1":10,"y1":12,"x2":12,"y2":15,"color":0}]}`
3. Make it look good, in this order:
   - `shade` each main colour: `{"op":"shade","target":6,"highlight":5,"shadow":7,"x":15,"y":17}`
     (the x,y point limits it to that one shape).
   - `outline` sprites on transparent backgrounds: `{"op":"outline","color":0}`.
   - Add texture to big flat areas: `{"op":"noise","colors":[6,7],"density":0.15,"on":6}`.
   - Characters: draw the left half, then `{"op":"mirror","axis":"x","from":"left"}`.
4. Read the grid the tool returns (or call `pixel_view`). Follow its
   Suggestions. Coordinates: x goes right, y goes down, (0,0) is top-left.
5. `pixel_export` with a `path` like `assets/hero.png`. Keep `scale` 1 and
   paste the HTML/CSS/canvas code it gives you: it keeps pixels sharp with
   `image-rendering: pixelated` and `imageSmoothingEnabled = false`. For a
   single-file page, pass `"data_uri": true`.
6. Check the page or game in the browser, then report the file paths.

## Palettes

| Name | Colours | Good for |
|---|---|---|
| sweetie-16 | 16 | general use, soft and friendly (default) |
| pico-8 | 16 | bright arcade games |
| endesga-32 | 32 | detailed characters and scenes |
| earth | 24 | nature tiles: dirt, grass, stone, sand, wood |
| gameboy | 4 | green Game Boy look |
| grayscale | 8 | UI mockups, silhouettes |

Or pass your own list of hex colours (up to 36). Give each material three
shades from the same palette: dark (shadow), mid (base), light (highlight).
Use the darkest colour for outlines. Do not use pure black on a colourful
sprite if the palette has a dark navy or purple; it looks softer.

## Rules that make pixel art look good

- **Light from the top-left.** Highlight top and left edges, shadow bottom and
  right. `shade` does this for you.
- **Clear silhouette.** Fill the shape in one colour first and check the grid:
  it should read as the object before any detail is added.
- **Outline sprites, not tiles or scenes.** A 1px dark outline makes a sprite
  readable on any background.
- **Few colours.** 3-4 per material, 8-16 for a whole sprite.
- **No stray single pixels** ("pillow shading", noise everywhere). Texture
  with `density` 0.1-0.25 and only on big areas.
- **Whole-number scaling only** (2x, 3x, 4x). Never let a browser or canvas
  smooth pixel art.

## Recipes

**Item icon (16x16 or 32x32, kind "icon"):** main shape with rect/ellipse/
triangle, 1-2px of empty border, shade, outline, one or two white highlight
pixels on the shiny part.

**Character (32x32, kind "character"):** head is big (about a third of the
height). Draw the left half: head, eye, body, arm, leg. `mirror`. Add the face
details that are not symmetric after mirroring. Shade each colour, outline.
Walk animation: `pixel_new {"name":"hero_2","from":"hero"}`, move the legs
with a few `pixel`/`rect` ops, repeat for 2-4 frames, then
`pixel_export {"frames":["hero","hero_2","hero_3"],"path":"assets/hero-walk.png"}`
and use the CSS `steps()` animation it returns.

**Tile (16x16, kind "tile"):** fill everything (no -1). Base colour, then
`noise` with 2-3 shades, or `voronoi` for stone. Keep features away from one
edge unless the opposite edge matches, so copies join seamlessly. For a
platformer ground set, `pixel_export {"tileset":true}` makes all 16 edge
variants in one sheet.

**Scene or website hero (kind "scene", e.g. 96x54 or 160x90):** back to front.
`gradient` sky with 3-4 colours, sun/moon `circle`, far mountains
(`triangle`, low contrast), near ground (`rect` + `noise` with `on`), details,
then `text` for a title (`scale` 2-3). Export and use it as a full-width
background with `image-rendering: pixelated; background-size: cover`.

**UI button (48x16, kind "ui"):** `rect` fill, `rect` outline with `fill:
false`, a light `row` on top and a dark `row` at the bottom, `text` centred.

## Using the result

- Web page: `<img src="assets/coin.png" width="64" height="64" alt="Coin"
  style="image-rendering: pixelated">`. Always give a real `alt` text.
- CSS background: `background: url(assets/tile.png) 0 0 / 64px 64px repeat;
  image-rendering: pixelated;`
- Canvas game: `ctx.imageSmoothingEnabled = false` after every canvas resize,
  and draw at `size * scale` with a whole-number scale.
- Editing existing art: `pixel_import {"path":"assets/old.png","name":"old"}`,
  change it, export again.

## If something goes wrong

- A `SKIPPED` op in the reply names the problem; resend only that op, fixed.
- Colours look wrong: you used an index outside the palette. Read the palette
  line from `pixel_new` again.
- Shape in the wrong place: check the grid rows (y) and ruler (x) and move it
  with `shift`, or `clear` a box and redraw.
