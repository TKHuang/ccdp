# X.com (Twitter) Content Extraction via ccdp

## Problem
X.com is a React SPA — `html 'body'` returns framework code, not tweet content. `scrape` returns empty/null.

## Solution: Use `eval` with specific selectors

### Step 1: Navigate to search
```bash
$CDP nav 'https://x.com/search?q=YOUR_QUERY&src=typed_query'
```

### Step 2: Wait for React rendering
```bash
$CDP wait 'article' 10000
```

### Step 3: Extract tweets via eval
```bash
$CDP eval 'Array.from(document.querySelectorAll("article")).slice(0, N).map(a => {
  const text = a.querySelector("div[data-testid=\"tweetText\"]");
  const link = a.querySelector("a[href*=\"/status/\"]");
  return { text: text ? text.textContent.trim().substring(0, 150) : "N/A",
           link: link ? link.href : "N/A" };
})'
```

## Key Selectors
- Tweet text: `div[data-testid="tweetText"]`
- Tweet link: `a[href*="/status/"]`
- Container: `article`

## Search URL Patterns
- General: `https://x.com/search?q=KEYWORDS&src=typed_query`
- Site-specific: `https://x.com/search?q=jable+site:jable.tv%2Fvideos&src=typed_query`
- With operators: `https://x.com/search?q=keyword+filter:links&src=typed_query`

## Common Use Cases
- Finding jable.tv video links shared on X
- Monitoring specific accounts (e.g., @marywannanite)
- Searching for AV codes or titles
- Finding NSFW content recommendations

## Notes
- X.com uses React — always use `eval` for content extraction
- `html` command works for static sites but not React SPAs
- `wait 'article'` is critical — content loads asynchronously
- Use `.slice(0, N)` to limit results and avoid context overflow
- Use `.substring(0, 150)` to truncate long tweets