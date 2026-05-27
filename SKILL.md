---
name: ccdp
description: Browser automation via Chrome DevTools Protocol. Use for any browser task — navigating pages, clicking elements, filling forms, taking screenshots, reading and scraping page content. Works with Arc, Chrome, Brave, Edge, Chromium.
---

# Chrome CDP — Browser Control

All commands are shell commands. Run them with the Bash tool.

```bash
CDP="node <this-skill-dir>/scripts/cdp.mjs"
```

## Browser Setup

The CLI talks to a Chromium-family browser that exposes CDP. The default
browser is **Arc**.

If a command fails with a `CDP_*:` error (e.g. `CDP_NO_PORT_FILE`,
`CDP_ARC_NOT_RUNNING`, `CDP_ORIGIN_LOCKDOWN`), the CLI prints the exact
rerun command — copy it verbatim. It will pass `--launch`, which lets
the CLI safely (re)launch the browser with the right flags.

**Never** run `open -na "Arc" --args …` yourself. The wrong combination
of Chromium flags silently wipes extensions from the user's main
profile. Always go through the CLI's `--launch` / `launch` path.

Your first command of a session should typically include `--launch` —
it's idempotent (no-op if the browser is already CDP-enabled).

## Target IDs are optional

Most commands take an optional `<target>` (a tab ID prefix from
`cdp list`). If omitted, the CLI uses the **last-used tab** (current-tab),
which is updated automatically by every command that names a target —
including `open`, `nav`, `click`, etc.

You can usually do a whole session without naming any target:

```bash
$CDP open https://example.com      # opens, sets current-tab, waits for load
$CDP snap                          # operates on the new tab
$CDP scrape 'article' --field title='h1'
$CDP close                         # closes current-tab
```

Pass an explicit prefix only when juggling multiple tabs.

## Workflow

### 1. Get a tab

```bash
$CDP list                          # check for existing tabs
$CDP open https://example.com      # open a new one; waits for load completion
```

### 2. Interact

```bash
$CDP click  '<selector>'           # click element (real mouse events)
$CDP type   'hello'                # type into focused element
$CDP key    enter                  # press a key (enter|tab|esc|arrow…|…)
$CDP submit 'input[name=q]' 'query'  # click + type + Enter in one shot
$CDP wait   '.spinner' 5000        # wait up to 5s for selector
$CDP nav    https://other.com      # navigate
$CDP reload                        # reload current page
$CDP back                          # history back
```

### 3. Read / extract

```bash
$CDP snap                          # accessibility tree — best for structure
$CDP shot                          # screenshot
$CDP status                        # url + title + readyState + body size
$CDP scrape 'article' --limit 5 \
  --field user='.author' \
  --field text='.tweet-text' \
  --field link='a@href'            # structured extraction → JSON array
```

### 4. Clean up

```bash
$CDP close                         # close current-tab; leave others alone
$CDP close all                     # close every tab ccdp opened in this
                                   # session; the user's own tabs are
                                   # never touched
```

## All Commands

```
launch [browser]                     Relaunch a browser with CDP (default: arc)
list                                 List open tabs
open  [url] [--no-wait]              Open new tab; waits for load (unless --no-wait)
close [target|all]                   Close tab + stop its daemon.
                                     `close all` only closes tabs ccdp
                                     opened (via `open`) — never touches
                                     the user's own tabs.
snap  [target]                       Accessibility tree snapshot
shot  [target] [file]                Screenshot (prints DPR for coord mapping)
eval  [target] <expr>                Evaluate JavaScript expression
html  [target] [selector]            Get HTML (full page or element)
nav   [target] <url>                 Navigate and wait for load
reload  [target]                     Reload page and wait for load
back    [target]                     Navigate one entry back in history
forward [target]                     Navigate one entry forward in history
click   [target] <selector>          Click element by CSS selector (real mouse)
clickxy [target] <x> <y>             Click at CSS pixel coordinates
type    [target] <text>              Type text at current focus
key     [target] <name>              Press a single key (enter|tab|esc|arrow…|…)
submit  [target] <selector> <text>   click + type + Enter, atomic
wait    [target] <selector> [ms]     Block until selector exists (default 10s).
                                     On timeout, dumps URL/title/readyState.
status  [target]                     URL + title + readyState + body size + frames
probe   [target] <sel> [n=5]         Selector debugger: show match count + tag/
                                     classes/attrs/text for the first n matches.
                                     Use when scrape returns 0 or junk.
scrape  [target] <container-sel>     Extract structured data → JSON array
        --limit N                    Limit number of results
        --field key=<sel>            Extract element.innerText
        --field key=<sel>@<attr>     Extract an attribute (e.g. a@href, img@src)
net     [target]                     Network resource timing
loadall [target] <selector> [ms]     Click selector repeatedly until gone
evalraw [target] <method> [json]     Raw CDP command passthrough
stop    [target]                     Stop daemon(s)

Global flag (works on any command):
--launch[=<browser>]                 Ensure browser is up before running.
                                     Idempotent; defaults to arc.
```

## Common Patterns

**Search and read results (the most common AI task):**
```bash
$CDP open https://duckduckgo.com
$CDP submit 'input[name=q]' 'your query'
$CDP wait 'article' 5000
$CDP scrape 'article' --limit 5 \
  --field title='h2' --field url='a@href' --field snippet='[data-result="snippet"]'
```

**Scrape a list of items:**
```bash
$CDP open https://news.ycombinator.com
$CDP scrape '.athing' --limit 10 \
  --field title='.titleline a' --field url='.titleline a@href'
```

**Fill a multi-field form:**
```bash
$CDP click '#email'
$CDP type 'user@example.com'
$CDP click '#password'
$CDP type 'secret'
$CDP click 'button[type="submit"]'
```

**Read page content without scraping:**
```bash
$CDP snap                          # accessibility tree
$CDP eval 'document.title'         # any JS expression
$CDP html '.main-content'          # HTML of specific element
$CDP status                        # quick page state check
```

**Diagnose why a wait timed out:**
```bash
$CDP wait '.results' 5000          # if it times out, the error includes
                                   # current URL, title, readyState, body size —
                                   # so you can see if you're on the wrong page
                                   # or the page just hasn't rendered yet
$CDP status                        # same info, on demand
```

**Debug a selector that returns nothing / junk:**
```bash
# scrape returned 0 matches or unexpected data? probe the selector to see
# what's actually on the page and iterate.
$CDP probe 'article' 3             # show first 3 matches: tag, classes, attrs, text
$CDP probe 'a[data-testid="result-title-a"]' 3   # try a narrower selector
```

**URL gotcha (shell quoting):**
URLs with `?`, `&`, `*`, `#`, or `=` must be **single-quoted**, otherwise zsh
will mangle them (e.g. `?` triggers `no matches found` and the command never
runs):
```bash
$CDP open 'https://duckduckgo.com/?q=foo&t=h_'   # right
$CDP open  https://duckduckgo.com/?q=foo&t=h_    # wrong — zsh eats it
```

## Coordinates

`shot` captures at native resolution. CDP input commands use **CSS pixels**.

```
CSS px = screenshot px / DPR
```

`shot` prints the DPR. Retina (DPR=2): divide screenshot coordinates by 2.

## Site-Specific Patterns

### X.com (Twitter) — React SPA, dynamic rendering
- **`html` fails** for content extraction — X.com renders everything via React, so `html 'body'` returns shell/framework code, not tweet content
- **Use `eval` instead** to extract tweets:
  ```bash
  $CDP nav 'https://x.com/search?q=YOUR_QUERY&src=typed_query'
  $CDP wait 'article' 10000          # wait for React to render
  $CDP eval 'Array.from(document.querySelectorAll("article")).slice(0, N).map(a => {
    const text = a.querySelector("div[data-testid=\"tweetText\"]");
    const link = a.querySelector("a[href*=\"/status/\"]");
    return { text: text ? text.textContent.trim().substring(0, 150) : "N/A",
             link: link ? link.href : "N/A" };
  })'
  ```
- Search URL format: `https://x.com/search?q=KEYWORDS&src=typed_query`
- For site-specific searches: `q=jable+site:jable.tv%2Fvideos`
- Tweet text is in `div[data-testid="tweetText"]`, links in `a[href*="/status/"]`
- `scrape` returns empty/null for X.com — always use `eval` pattern above

### jable.tv — AV video site (Chinese UI, English tag URLs)
- **Tag URLs use English names**, NOT Chinese characters:
  - `https://jable.tv/tags/anal-sex/` (肛交)
  - `https://jable.tv/tags/big-tits/` (巨乳)
  - `https://jable.tv/tags/multi/` (多P)
  - `https://jable.tv/tags/gang-intrusion/` (集團進犯)
- Video list container: `#list_videos_common_videos_list`
- **`scrape` often fails** on jable.tv — fallback pattern:
  ```bash
  $CDP html 'body' | grep 'h6' | grep 'title' | grep -i 'keyword'
  ```
- Video links: `a[href*="/videos/"]` (use `eval` to count, then `html` + `grep` to extract)
- Video titles are in `<h6 class="title">` with `<savdiv>` tags containing AV codes
- `eval` can return empty arrays unexpectedly — use `html` + `grep` as reliable fallback
- 404 pages may appear with Chinese tag paths (e.g., `/tags/肛交/`) — always use English

### See also
- [X.com Content Extraction](references/x-com-extraction.md) — React SPA handling pattern

## Notes

- `click` / `submit` use real mouse events (not `el.click()`), so they work
  correctly with React, Vue, and other frameworks.
- `type` inserts text at the currently focused element. Use `submit` to
  combine click + type + Enter, or click the target first then type.
- `snap` is preferred over `html` for understanding page structure.
- `scrape` is preferred over `eval` for extracting lists of items — it
  saves you writing `JSON.stringify(Array.from(...).map(...))`.
- Each tab has a background daemon that auto-exits after 20 min idle.
- First access to a tab may trigger Chrome's "Allow debugging" prompt.
- Browser must expose CDP. Use `$CDP launch` (default: Arc) — never run
  `open -na` / `--args` yourself, the wrong flag combo can damage profiles.
