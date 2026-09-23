---
name: browser-review
description: Use the built-in browser to open a page, click, type, and check that it works — for testing your own UI or using any website.
triggers: browser|web ?page|website|localhost|screenshot|open the page|click (on|the)|fill (in|out) the|test the (page|site|ui|app|game)|check (how it looks|the page|the site)|does it (look|work) right
---

# Using the browser

You drive a real browser. The user watches the same page.

## Quick start

Every browser tool answers with the page as a numbered list:

```
Page: "Login" — http://localhost:5173/
Elements (use the number with browser_click / browser_type):
[1] textbox "Email"
[2] textbox "Password"
[3] button "Sign in"
[4] link "Forgot password?" -> /reset
Text: Login Email Password Sign in Forgot password?
```

To act on something, use its **number**:

- `browser_click` `{"target": "3"}`
- `browser_type` `{"target": "1", "text": "me@example.com"}`

The visible text also works: `{"target": "Sign in"}`.

After every action you get the new list. **Read it.** It tells you whether
the action worked. Numbers change when the page changes, so always use the
numbers from the **latest** list.

## Tools

| Tool | Use it to | Example |
|---|---|---|
| `browser_open` | open a page | `{"url": "http://localhost:5173"}` |
| `browser_snapshot` | look at the page again | `{}` |
| `browser_click` | click a button, link, checkbox | `{"target": "3"}` |
| `browser_type` | type in a field, or pick a dropdown option | `{"target": "1", "text": "hello", "submit": true}` |
| `browser_press` | press a key | `{"key": "Escape"}` |
| `browser_scroll` | see more of the page | `{"to": "down"}` |
| `browser_wait` | wait for something slow | `{"text": "Saved"}` |
| `browser_console` | read JavaScript errors | `{"errors_only": true}` |
| `browser_screenshot` | show the user the page | `{}` |
| `browser_read` | read all the page text | `{}` |

`browser_open` also takes a file path (`C:/site/index.html`) or the words
`back`, `forward`, `reload`.

`browser_type` clears the field first. `"submit": true` presses Enter after
typing, for search boxes and login forms.

## Recipe: check a page you built

1. `browser_open` the page. For a single HTML file, use its full path.
   For an app, start the dev server in the background first.
2. `browser_console` with `{"errors_only": true}`.
3. Read the list. Is the text you expect there?
4. Click or type through the main thing the page does. Read each answer.
5. `browser_screenshot` so the user can see it.
6. Report what you saw: "No console errors. The heading says 'Dashboard'.
   Clicking Add put a new row in the table."

If something is wrong: fix the file, then `browser_open` with `reload`,
and check again.

## Recipe: fill in a form

1. `browser_type` each field by its number.
2. `browser_click` the submit button, or use `"submit": true` on the last field.
3. Read the answer: an error message, or a new page?

## When something goes wrong

- **"No element [N]"**: the page changed. Call `browser_snapshot` and use the
  new numbers.
- **"Nothing matches"**: use a number from the list instead of text.
- **"is not a text field"**: you tried to type into a button. Click it instead.
- **The element you need is not in the list**: `browser_scroll` `{"to": "down"}`
  and look again. Items marked `(below, scroll down)` can be clicked directly.
- **A dialog is open**: the list says so. Handle it first, or press Escape.
- **Nothing happened after a click**: check `browser_console` for errors.

## Rules

- Never guess. If you are not sure what is on the page, call `browser_snapshot`.
- Do not click the same thing twice in a row. If it did not work the first
  time, read the list and try something else.
- Report only what the tools showed you. "It looks correct" is not a finding.
- If you cannot see images, do not say you looked at a screenshot.
- Do not type passwords, card numbers or other secrets. Ask the user to do it.
