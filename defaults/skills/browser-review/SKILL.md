---
name: browser-review
description: Drive Skadi's embedded browser to check your own UI work — open a page, read it, click it, screenshot it, check the console.
triggers: in the browser|screenshot|open the page|test the (page|site|ui|game)|check (how it looks|the page|the site)|does it (look|work) right
---

# Reviewing your work in the browser

Skadi embeds a real Chromium, driven over the DevTools Protocol and mirrored in
its own window. The user watches the same page you are driving.

The viewport is fixed at **1280×800**. This matters: screenshot pixels and click
coordinates are the same coordinate space, so a point you identify in an image is
a point you can click.

## Quick start

1. Make the change with the file tools.
2. Make sure something is serving the page. If a dev server is not already
   running, start it so the call returns — for example
   `Start-Process npm -ArgumentList 'run','dev'`. A plain `npm run dev` never
   exits and will hit the command timeout.
3. `browser_open` the URL — or the local file path, if there is nothing to serve.
4. `browser_console` with `errors_only: true`. Do this **first**. A page that
   threw during render can still look plausible in a screenshot.
5. `browser_read` to confirm the expected text and structure actually rendered.
6. `browser_screenshot` so the user can see it.
7. Report what you saw: "no console errors, the heading reads 'Dashboard',
   the three cards render". Fix and repeat if anything is wrong.

A single HTML file needs no server: skip step 2 and `browser_open` its full
path, e.g. `C:/Users/me/site/index.html`.

## Opening local files

A static page does not need a server. `browser_open` takes three things:

- a URL — `http://localhost:5173`, `https://example.com`;
- a `file://` URL — `file:///C:/Users/me/site/index.html`;
- a plain local path — `C:\Users\me\site\index.html`, or
  `C:/Users/me/site/index.html`, or `/srv/www/index.html`.

A plain path is resolved and percent-encoded for you, so spaces and other
awkward characters need no escaping — write the path as it appears on disk.
Relative paths are not accepted; give the full one.

Prefer `file://` for a standalone HTML file you just wrote, and a dev server for
anything that needs one. Under `file://` the page's origin is opaque, so
`fetch()` of sibling files, ES module imports and anything gated on CORS will
fail there even though the same page works when served. If you see that, serve
the directory instead of blaming the markup.

Step 2 of the quick start is about serving; skip it when you are opening a file
directly.

## Clicking

Two ways, and the right one depends on what you know.

**By selector** — `browser_click` with a CSS selector. Use this whenever you know
the markup, because it is precise and does not depend on layout.

**By coordinate** — `browser_click_at` with x and y. Use this when you are
working from what the page *looks like* rather than from its source. Get the
coordinates from:

- a screenshot, if you can view images — read the point straight off the picture;
- `browser_elements` otherwise, which lists every visible clickable element with
  its label and centre point, like `(412,288) <button> Save changes`.

`browser_elements` is how you click accurately without vision. Do not guess
coordinates from a description of the page.

After any click, call `browser_read` or `browser_console` to confirm what
changed. A click that silently did nothing looks identical to one that worked.

## Typing

`browser_type` sends keystrokes to whatever has focus, so click the field first.
Pass `press` to follow with a key: `{"text": "hello", "press": "Enter"}`.
`browser_fill` is the selector-based alternative and fires `input` and `change`,
so frameworks notice it.

## Seeing

If the status line says you cannot view images, a screenshot is still worth
taking — the user sees it — but do not claim to have looked at it. Verify with
`browser_read`, `browser_elements` and `browser_console`, and say that is what
you did.

If you can view images, the screenshot comes back on your next round and you may
reason about layout, spacing, alignment and colour from it. That is also when
`browser_click_at` is at its most useful.

## Other tools

- `browser_scroll` moves the page; content below the fold is not in the
  screenshot or in `browser_elements` until you scroll to it.
- `browser_eval` answers precise questions an image cannot:
  `getComputedStyle(document.querySelector('.card')).backgroundColor`,
  `document.querySelectorAll('.row').length`.

## Rules

- Re-open the page after changing source. There is no hot-reload guarantee.
- Check the console after every interaction, not only after loading.
- `http://`, `https://` and `file://` all work. See "Opening local files".
- Report what you observed. "The console is clean and the heading reads
  'Dashboard'" is a finding. "It looks correct" is not.
