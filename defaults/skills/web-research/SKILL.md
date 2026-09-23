---
name: web-research
description: Research current or externally verifiable information with web_search, compare sources, and answer with traceable links. Use for recent facts, documentation, releases, recommendations, or changed claims.
triggers: search (the )?(web|internet|online)|look (it |this |that )?up online|research (it |this )?(online|on the web)|latest version|newest|release notes|what'?s new in|current (price|version|status)|documentation for|docs for
---

# Web Research

## Quick start

1. Call `web_search` with a short, specific query: one subject per query,
   with exact names, versions, error text or dates.
2. Read the titles and snippets. Open the best official source in the browser
   (`browser_open`, then `browser_read`) when the snippet is not enough.
3. If the first query finds nothing useful, rewrite it once (fewer words, the
   exact product name, or add a year) and search again.
4. Answer with the facts, and put a link next to each claim it supports.
   Say plainly when sources disagree or you could not confirm something.
5. Never put passwords, keys, private code or personal data in a query.

## When to search

Use `web_search` when the answer depends on current, niche, or externally
verifiable information. Keep searches focused: one subject, fact, or comparison
per query. Prefer precise product names, versions, error text, dates, and the
kind of source needed.

If `web_search` is unavailable, the chat has web search disabled. Do not work
around that choice with shell commands or the review browser; answer from the
available material or ask the user to enable the globe button.

## Source selection

- Prefer primary sources: official documentation, project repositories,
  standards, government publications, original research, and vendor notices.
- For recommendations or disputed claims, compare at least two independent
  sources rather than treating result order as evidence.
- Treat snippets as discovery aids. Do not invent details that the returned
  title, URL, and snippet do not support.
- Distinguish publication date from the date an event happened. If freshness
  matters and the result does not establish it, search again with a date or
  version constraint.
- Never include credentials, private workspace content, personal data, or
  proprietary code in a search query.

## Efficient workflow

Start with the narrowest query likely to find an authoritative source. Refine
once when results are ambiguous or stale. Use multiple searches only when they
answer distinct subquestions or corroborate a consequential claim. Stop when
the available evidence answers the request; do not collect links for their own
sake.

## Pages that load their content with JavaScript

Search snippets and `browser_read` may miss the actual cards or records on
JavaScript-heavy sites. Open the page, then use `browser_extract` to collect
headings, links, image URLs with nearby text, and embedded JSON. If the first
extraction shows navigation rather than the records you need, click the
relevant tab or filter and extract again. Do not invent placeholder data when
the source is reachable; report the exact blocker if structured data still
cannot be read.

Zero results from one search are not proof that the information does not
exist. Refine the query once, then open a source the user named, or a credible
result, directly in the browser and use `browser_extract`. For implementation
requests, try those browser paths before stopping or asking the user to supply
public data.

## Answering

Link the sources that materially support the conclusion and place each link
near the claim it supports. State uncertainty plainly when results conflict,
are incomplete, or only provide indirect evidence.
