---
name: web-research
description: Research current or externally verifiable information with web_search, compare sources, and answer with traceable links. Use for recent facts, documentation, releases, recommendations, or changed claims.
---

# Web Research

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

In the final answer, link the sources that materially support the conclusion
and place each link near the claim it supports. State uncertainty plainly when
results conflict, are incomplete, or only provide indirect evidence.
