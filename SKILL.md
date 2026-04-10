---
name: ccdp
description: Browser automation via Chrome DevTools Protocol. Use for any browser task — navigating pages, clicking elements, filling forms, taking screenshots, reading page content. Works with Arc, Chrome, Brave, Edge, Chromium.
---

# Chrome CDP — Browser Control

All commands are shell commands. Run them with the Bash tool.

```bash
CDP="node <this-skill-dir>/scripts/cdp.mjs"
```

## Workflow

### 1. Get a tab

```bash
$CDP list                          # check for existing tabs
$CDP open https://example.com      # or open a new one → prints target ID
```

Output: `A1B2C3D4  Example Domain  https://example.com`

The 8-char hex (`A1B2C3D4`) is the **target ID** — use it in all commands below.

### 2. Interact

```bash
$CDP click  <target> '<selector>'  # click element (CSS selector)
$CDP type   <target> 'hello'       # type text into focused element
$CDP nav    <target> <url>         # navigate to URL
$CDP snap   <target>               # accessibility tree (prefer over html)
$CDP shot   <target> [file]        # screenshot
$CDP eval   <target> '<expr>'      # run JS
```

### 3. Clean up

```bash
$CDP close <target>                # close tabs YOU opened; leave others alone
```

## All Commands

```
list                                 List open tabs
open  [url]                          Open new tab (default: about:blank)
close <target>                       Close tab + stop its daemon
snap  <target>                       Accessibility tree snapshot
shot  <target> [file]                Screenshot (prints DPR for coord mapping)
eval  <target> <expr>                Evaluate JavaScript
html  <target> [selector]            Get HTML (full page or element)
nav   <target> <url>                 Navigate and wait for load
click <target> <selector>            Click element by CSS selector
clickxy <target> <x> <y>             Click at CSS pixel coordinates
type  <target> <text>                Type text at current focus
net   <target>                       Network resource timing
loadall <target> <selector> [ms]     Click selector repeatedly until gone
evalraw <target> <method> [json]     Raw CDP command passthrough
stop  [target]                       Stop daemon(s)
```

## Common Patterns

**Search on a website:**
```bash
$CDP click <target> 'input[type="search"]'   # focus search box
$CDP type  <target> 'query text'             # type query
# press Enter:
$CDP evalraw <target> "Input.dispatchKeyEvent" '{"type":"keyDown","key":"Enter","code":"Enter","windowsVirtualKeyCode":13,"text":"\r"}'
$CDP evalraw <target> "Input.dispatchKeyEvent" '{"type":"keyUp","key":"Enter","code":"Enter","windowsVirtualKeyCode":13}'
```

**Fill a form:**
```bash
$CDP click <target> '#email'
$CDP type  <target> 'user@example.com'
$CDP click <target> '#password'
$CDP type  <target> 'secret'
$CDP click <target> 'button[type="submit"]'
```

**Read page content:**
```bash
$CDP snap <target>                           # accessibility tree — best for structure
$CDP eval <target> 'document.title'          # quick JS query
$CDP html <target> '.main-content'           # HTML of specific element
```

## Coordinates

`shot` captures at native resolution. CDP input commands use **CSS pixels**.

```
CSS px = screenshot px / DPR
```

`shot` prints the DPR. Retina (DPR=2): divide screenshot coordinates by 2.

## Notes

- `click` uses real mouse events (not `el.click()`), so it works correctly with React, Vue, and other frameworks.
- `type` inserts text at the currently focused element. Always `click` the target element first.
- `snap` is preferred over `html` for understanding page structure.
- Each tab has a background daemon that auto-exits after 20 min idle.
- First access to a tab may trigger Chrome's "Allow debugging" prompt.
- Requires browser launched with `--remote-debugging-port=9222`.
