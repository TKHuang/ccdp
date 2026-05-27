#!/usr/bin/env node
// cdp - lightweight Chrome DevTools Protocol CLI
// Uses raw CDP over WebSocket, no Puppeteer dependency.
// Requires Node 22+ (built-in WebSocket).
//
// Per-tab persistent daemon: page commands go through a daemon that holds
// the CDP session open. Chrome's "Allow debugging" modal fires once per
// daemon (= once per tab). Daemons auto-exit after 20min idle.

import {
  readFileSync,
  writeFileSync,
  unlinkSync,
  existsSync,
  mkdirSync,
} from 'fs';
import { homedir } from 'os';
import { resolve } from 'path';
import { spawn, execFileSync, spawnSync } from 'child_process';
import net from 'net';
import http from 'http';

const TIMEOUT = 15000;
const NAVIGATION_TIMEOUT = 30000;
const IDLE_TIMEOUT = 20 * 60 * 1000;
const DAEMON_CONNECT_RETRIES = 20;
const DAEMON_CONNECT_DELAY = 300;
const MIN_TARGET_PREFIX_LEN = 8;
const IS_WINDOWS = process.platform === 'win32';
if (!IS_WINDOWS) process.umask(0o077);
const RUNTIME_DIR = IS_WINDOWS
  ? resolve(
      process.env.LOCALAPPDATA || resolve(homedir(), 'AppData', 'Local'),
      'cdp',
    )
  : process.env.XDG_RUNTIME_DIR
    ? resolve(process.env.XDG_RUNTIME_DIR, 'cdp')
    : resolve(homedir(), '.cache', 'cdp');
try {
  mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 });
} catch {}
const PAGES_CACHE = resolve(RUNTIME_DIR, 'pages.json');
const CURRENT_TAB_FILE = resolve(RUNTIME_DIR, 'current-tab');
// We track which tabs ccdp itself opened so `close all` never touches
// the user's own tabs. Tabs added via `open` go in; tabs we never opened
// (i.e. the user's existing tabs) stay out.
const OWNED_TABS_FILE = resolve(RUNTIME_DIR, 'owned-tabs.json');

function readOwnedTabs() {
  try {
    const arr = JSON.parse(readFileSync(OWNED_TABS_FILE, 'utf8'));
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function writeOwnedTabs(ids) {
  try {
    writeFileSync(OWNED_TABS_FILE, JSON.stringify(ids), { mode: 0o600 });
  } catch {}
}

function addOwnedTab(targetId) {
  if (!targetId) return;
  const owned = readOwnedTabs();
  if (!owned.includes(targetId)) owned.push(targetId);
  writeOwnedTabs(owned);
}

function removeOwnedTab(targetId) {
  if (!targetId) return;
  writeOwnedTabs(readOwnedTabs().filter((id) => id !== targetId));
}

function readCurrentTab() {
  try {
    const id = readFileSync(CURRENT_TAB_FILE, 'utf8').trim();
    return id || null;
  } catch {
    return null;
  }
}

function writeCurrentTab(targetId) {
  if (!targetId) return;
  try {
    writeFileSync(CURRENT_TAB_FILE, targetId, { mode: 0o600 });
  } catch {}
}

function clearCurrentTab(targetId) {
  if (!targetId) return;
  if (readCurrentTab() === targetId) {
    try { unlinkSync(CURRENT_TAB_FILE); } catch {}
  }
}

function sockPath(targetId) {
  return IS_WINDOWS
    ? `\\\\.\\pipe\\cdp-${targetId}`
    : resolve(RUNTIME_DIR, `cdp-${targetId}.sock`);
}

// Known browsers we can probe and auto-launch on each platform.
// Order matters — we pick the first one whose port file is live.
const KNOWN_BROWSERS = {
  arc: {
    label: 'Arc',
    darwinApp: '/Applications/Arc.app',
    darwinBinary: '/Applications/Arc.app/Contents/MacOS/Arc',
    portFileDir: 'Library/Application Support/Arc/User Data',
  },
  chrome: {
    label: 'Google Chrome',
    darwinApp: '/Applications/Google Chrome.app',
    darwinBinary: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    portFileDir: 'Library/Application Support/Google/Chrome',
    linuxConfigDir: '.config/google-chrome',
  },
  brave: {
    label: 'Brave',
    darwinApp: '/Applications/Brave Browser.app',
    darwinBinary:
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    portFileDir: 'Library/Application Support/BraveSoftware/Brave-Browser',
    linuxConfigDir: '.config/BraveSoftware/Brave-Browser',
  },
  edge: {
    label: 'Microsoft Edge',
    darwinApp: '/Applications/Microsoft Edge.app',
    darwinBinary:
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    portFileDir: 'Library/Application Support/Microsoft Edge',
    linuxConfigDir: '.config/microsoft-edge',
  },
  chromium: {
    label: 'Chromium',
    darwinApp: '/Applications/Chromium.app',
    darwinBinary: '/Applications/Chromium.app/Contents/MacOS/Chromium',
    portFileDir: 'Library/Application Support/Chromium',
    linuxConfigDir: '.config/chromium',
  },
};

function getWsUrl() {
  const home = homedir();
  // macOS: ~/Library/Application Support/<name>/DevToolsActivePort
  const macBrowsers = [
    'Google/Chrome',
    'Google/Chrome Beta',
    'Google/Chrome for Testing',
    'Chromium',
    'BraveSoftware/Brave-Browser',
    'Microsoft Edge',
    'Arc/User Data',
  ];
  // Linux: ~/.config/<name>/DevToolsActivePort
  const linuxBrowsers = [
    'google-chrome',
    'google-chrome-beta',
    'chromium',
    'vivaldi',
    'vivaldi-snapshot',
    'BraveSoftware/Brave-Browser',
    'microsoft-edge',
  ];
  // Linux Flatpak: ~/.var/app/<app-id>/config/<name>/DevToolsActivePort
  const flatpakBrowsers = [
    ['org.chromium.Chromium', 'chromium'],
    ['com.google.Chrome', 'google-chrome'],
    ['com.brave.Browser', 'BraveSoftware/Brave-Browser'],
    ['com.microsoft.Edge', 'microsoft-edge'],
    ['com.vivaldi.Vivaldi', 'vivaldi'],
  ];
  const candidates = [
    process.env.CDP_PORT_FILE,
    ...macBrowsers.flatMap((b) => [
      resolve(home, 'Library/Application Support', b, 'DevToolsActivePort'),
      resolve(
        home,
        'Library/Application Support',
        b,
        'Default/DevToolsActivePort',
      ),
    ]),
    ...linuxBrowsers.flatMap((b) => [
      resolve(home, '.config', b, 'DevToolsActivePort'),
      resolve(home, '.config', b, 'Default/DevToolsActivePort'),
    ]),
    ...flatpakBrowsers.flatMap(([appId, name]) => [
      resolve(home, '.var/app', appId, 'config', name, 'DevToolsActivePort'),
      resolve(
        home,
        '.var/app',
        appId,
        'config',
        name,
        'Default/DevToolsActivePort',
      ),
    ]),
    // Windows: %LOCALAPPDATA%/<name>/User Data/DevToolsActivePort
    ...(IS_WINDOWS
      ? [
          'Google/Chrome',
          'BraveSoftware/Brave-Browser',
          'Microsoft/Edge',
        ].flatMap((b) => {
          const base =
            process.env.LOCALAPPDATA || resolve(home, 'AppData/Local');
          return [
            resolve(base, b, 'User Data/DevToolsActivePort'),
            resolve(base, b, 'User Data/Default/DevToolsActivePort'),
          ];
        })
      : []),
  ].filter(Boolean);
  const portFiles = [
    ...new Set(candidates.filter((p) => existsSync(p))),
  ];
  if (portFiles.length === 0)
    throw new Error(
      'CDP_NO_PORT_FILE: No browser is exposing CDP. No DevToolsActivePort file ' +
        'was found for any supported browser.',
    );
  const host = process.env.CDP_HOST || '127.0.0.1';
  const stalePortFiles = [];

  for (const portFile of portFiles) {
    const lines = readFileSync(portFile, 'utf8').trim().split('\n');
    if (lines.length < 2 || !lines[0] || !lines[1])
      throw new Error(`Invalid DevToolsActivePort file: ${portFile}`);
    const port = lines[0].trim();
    const wsPath = lines[1].trim();

    // Fetch the authoritative webSocketDebuggerUrl from /json/version
    // (Arc and some browsers update the UUID on restart, making DevToolsActivePort stale).
    // If the HTTP layer is dead but the port file is live, we fall through to the
    // WebSocket path advertised in line 2 -- Chromium 144+'s UI-toggle mode disables
    // /json/* but still serves the WebSocket directly.
    let httpStatus = null;
    try {
      const versionJson = execFileSync(
        'curl',
        ['-s', '-o', '/dev/stdout', '-w', '\n%{http_code}',
         `http://${host}:${port}/json/version`],
        { timeout: 3000 },
      ).toString();
      const newlineIdx = versionJson.lastIndexOf('\n');
      const body = newlineIdx >= 0 ? versionJson.slice(0, newlineIdx) : versionJson;
      httpStatus = newlineIdx >= 0 ? parseInt(versionJson.slice(newlineIdx + 1), 10) : null;
      if (httpStatus === 200 && body) {
        const version = JSON.parse(body);
        if (version.webSocketDebuggerUrl)
          return version.webSocketDebuggerUrl.replace('localhost', host);
      }
    } catch (e) {
      // curl failed entirely: skip a stale discovered endpoint and try another
      // browser before surfacing the auto-launch diagnostic.
      if (!isPortListening(host, port)) {
        try { unlinkSync(portFile); } catch {}
        stalePortFiles.push(`${portFile} pointing to ${port}`);
        continue;
      }
    }

    // HTTP is dead but a socket IS listening (httpStatus !== 200, but port live).
    // Most likely: Chromium 144+'s UI-toggle remote-debugging mode -- port open,
    // /json/* disabled, AND every WebSocket upgrade gets HTTP 403. Probe for
    // the 403 signature so we can surface a clear, actionable error instead of
    // a confusing "WebSocket error" later.
    if (httpStatus !== 200 && probeOriginLockdownSync(host, port, wsPath)) {
      throw new Error(
        'CDP_ORIGIN_LOCKDOWN: Browser rejected the CDP WebSocket upgrade ' +
          'with HTTP 403. The UI-toggle remote-debugging mode is not enough -- ' +
          'the browser must be (re)launched from the command line.',
      );
    }

    return `ws://${host}:${port}${wsPath}`;
  }

  throw new Error(
    `CDP_ARC_NOT_RUNNING: Browser is not running (cleaned up stale port ` +
      `file(s): ${stalePortFiles.join(', ')}).`,
  );
}

// Sync TCP probe: is anything listening on host:port right now?
function isPortListening(host, port) {
  const result = spawnSync(
    'nc',
    ['-z', '-w', '1', host, String(port)],
    { stdio: 'ignore' },
  );
  return result.status === 0;
}

// Detect Chromium 144+'s origin lockdown: WS upgrade returns HTTP 403.
function probeOriginLockdownSync(host, port, wsPath) {
  if (!wsPath) return false;
  const result = spawnSync(
    'curl',
    [
      '-s', '-o', '/dev/null', '-w', '%{http_code}',
      '-H', 'Connection: Upgrade',
      '-H', 'Upgrade: websocket',
      '-H', 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
      '-H', 'Sec-WebSocket-Version: 13',
      `http://${host}:${port}${wsPath}`,
    ],
    { encoding: 'utf8', timeout: 3000 },
  );
  return (result.stdout || '').trim() === '403';
}

// Quit a browser by binary path. Tries graceful pkill first, then SIGKILL.
function killBrowser(binary) {
  spawnSync('pkill', ['-f', binary]);
  for (let i = 0; i < 25; i++) {
    const r = spawnSync('pgrep', ['-f', binary], { encoding: 'utf8' });
    if (!(r.stdout || '').trim()) return;
    spawnSync('sleep', ['0.3']);
  }
  spawnSync('pkill', ['-9', '-f', binary]);
  spawnSync('sleep', ['1']);
}

// Quit + relaunch a browser with --remote-debugging-port. Blocks until
// HTTP /json/version returns 200 on the port, or throws. Returns the
// resolved port. Skips the relaunch entirely if the browser is already
// exposing CDP on that port (idempotent).
//
// We intentionally use the bare minimum flag set — passing
// --remote-allow-origins=* OR --user-data-dir alongside the debugging
// port has been observed to trigger Chromium's "potentially exploited"
// protections, which silently strip extensions from the user's main
// profile. The single --remote-debugging-port flag is enough on macOS.
async function launchBrowser(name, port = 9222, timeoutSec = 20) {
  const browser = KNOWN_BROWSERS[name];
  if (!browser) {
    throw new Error(
      `Unknown browser "${name}". Known: ${Object.keys(KNOWN_BROWSERS).join(', ')}`,
    );
  }
  const host = process.env.CDP_HOST || '127.0.0.1';

  // Idempotent: skip relaunch if browser already exposing CDP on the port.
  if (
    await httpHeadOk(`http://${host}:${port}/json/version`, 1000)
  ) {
    process.stderr.write(
      `${browser.label} already exposing CDP on port ${port}; reusing.\n`,
    );
    return port;
  }

  if (process.platform !== 'darwin') {
    throw new Error(
      `Auto-launch is only implemented for macOS right now. ` +
        `Launch ${browser.label} manually with --remote-debugging-port=${port}.`,
    );
  }
  if (!existsSync(browser.darwinBinary)) {
    throw new Error(`${browser.label} not found at ${browser.darwinBinary}`);
  }

  process.stderr.write(`Quitting any running ${browser.label} instances...\n`);
  killBrowser(browser.darwinBinary);

  process.stderr.write(
    `Launching ${browser.label} with --remote-debugging-port=${port}...\n`,
  );
  spawnSync('open', [
    '-na', browser.darwinApp,
    '--args', `--remote-debugging-port=${port}`,
  ]);

  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    if (await httpHeadOk(`http://${host}:${port}/json/version`, 1000)) {
      process.stderr.write(`${browser.label} CDP ready on port ${port}.\n`);
      return port;
    }
    await sleep(400);
  }
  throw new Error(
    `${browser.label} did not expose CDP on port ${port} within ${timeoutSec}s. ` +
      `Check that it launched correctly and nothing else binds ${host}:${port}.`,
  );
}

function httpHeadOk(url, timeoutMs = 1000) {
  return new Promise((res) => {
    const req = http.get(url, (resp) => {
      resp.resume();
      res(resp.statusCode === 200);
    });
    req.on('error', () => res(false));
    req.setTimeout(timeoutMs, () => { req.destroy(); res(false); });
  });
}

// Quick CDP liveness check — connect to the browser WS and call Browser.getVersion.
async function validateBrowserCdp(wsUrl, timeoutMs = 3000) {
  const cdp = new CDP();
  try {
    await Promise.race([
      (async () => {
        await cdp.connect(wsUrl);
        await cdp.send('Browser.getVersion');
      })(),
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error('preflight timeout')), timeoutMs),
      ),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    try { cdp.close(); } catch {}
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function resolvePrefix(prefix, candidates, noun = 'target', missingHint = '') {
  const upper = prefix.toUpperCase();
  const matches = candidates.filter((candidate) =>
    candidate.toUpperCase().startsWith(upper),
  );
  if (matches.length === 0) {
    const hint = missingHint ? ` ${missingHint}` : '';
    throw new Error(`No ${noun} matching prefix "${prefix}".${hint}`);
  }
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous prefix "${prefix}" — matches ${matches.length} ${noun}s. Use more characters.`,
    );
  }
  return matches[0];
}

function getDisplayPrefixLength(targetIds) {
  if (targetIds.length === 0) return MIN_TARGET_PREFIX_LEN;
  const maxLen = Math.max(...targetIds.map((id) => id.length));
  for (let len = MIN_TARGET_PREFIX_LEN; len <= maxLen; len++) {
    const prefixes = new Set(
      targetIds.map((id) => id.slice(0, len).toUpperCase()),
    );
    if (prefixes.size === targetIds.length) return len;
  }
  return maxLen;
}

// ---------------------------------------------------------------------------
// CDP WebSocket client
// ---------------------------------------------------------------------------

class CDP {
  #ws;
  #id = 0;
  #pending = new Map();
  #eventHandlers = new Map();
  #closeHandlers = [];

  async connect(wsUrl) {
    return new Promise((res, rej) => {
      this.#ws = new WebSocket(wsUrl);
      this.#ws.onopen = () => res();
      this.#ws.onerror = (e) =>
        rej(new Error('WebSocket error: ' + (e.message || e.type)));
      this.#ws.onclose = () => this.#closeHandlers.forEach((h) => h());
      this.#ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id && this.#pending.has(msg.id)) {
          const { resolve, reject } = this.#pending.get(msg.id);
          this.#pending.delete(msg.id);
          if (msg.error) reject(new Error(msg.error.message));
          else resolve(msg.result);
        } else if (msg.method && this.#eventHandlers.has(msg.method)) {
          for (const handler of [...this.#eventHandlers.get(msg.method)]) {
            handler(msg.params || {}, msg);
          }
        }
      };
    });
  }

  send(method, params = {}, sessionId) {
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      const msg = { id, method, params };
      if (sessionId) msg.sessionId = sessionId;
      this.#ws.send(JSON.stringify(msg));
      setTimeout(() => {
        if (this.#pending.has(id)) {
          this.#pending.delete(id);
          reject(new Error(`Timeout: ${method}`));
        }
      }, TIMEOUT);
    });
  }

  onEvent(method, handler) {
    if (!this.#eventHandlers.has(method))
      this.#eventHandlers.set(method, new Set());
    const handlers = this.#eventHandlers.get(method);
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) this.#eventHandlers.delete(method);
    };
  }

  waitForEvent(method, timeout = TIMEOUT) {
    let settled = false;
    let off;
    let timer;
    const promise = new Promise((resolve, reject) => {
      off = this.onEvent(method, (params) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        off();
        resolve(params);
      });
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        off();
        reject(new Error(`Timeout waiting for event: ${method}`));
      }, timeout);
    });
    return {
      promise,
      cancel() {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        off?.();
      },
    };
  }

  onClose(handler) {
    this.#closeHandlers.push(handler);
  }
  close() {
    this.#ws.close();
  }
}

// ---------------------------------------------------------------------------
// Command implementations — return strings, take (cdp, sessionId)
// ---------------------------------------------------------------------------

async function getPages(cdp) {
  const { targetInfos } = await cdp.send('Target.getTargets');
  return targetInfos.filter(
    (t) => t.type === 'page' && !t.url.startsWith('chrome://'),
  );
}

function formatPageList(pages) {
  const prefixLen = getDisplayPrefixLength(pages.map((p) => p.targetId));
  return pages
    .map((p) => {
      const id = p.targetId.slice(0, prefixLen).padEnd(prefixLen);
      const title = p.title.substring(0, 54).padEnd(54);
      return `${id}  ${title}  ${p.url}`;
    })
    .join('\n');
}

function shouldShowAxNode(node, compact = false) {
  const role = node.role?.value || '';
  const name = node.name?.value ?? '';
  const value = node.value?.value;
  if (compact && role === 'InlineTextBox') return false;
  return (
    role !== 'none' &&
    role !== 'generic' &&
    !(name === '' && (value === '' || value == null))
  );
}

function formatAxNode(node, depth) {
  const role = node.role?.value || '';
  const name = node.name?.value ?? '';
  const value = node.value?.value;
  const indent = '  '.repeat(Math.min(depth, 10));
  let line = `${indent}[${role}]`;
  if (name !== '') line += ` ${name}`;
  if (!(value === '' || value == null)) line += ` = ${JSON.stringify(value)}`;
  return line;
}

function orderedAxChildren(node, nodesById, childrenByParent) {
  const children = [];
  const seen = new Set();
  for (const childId of node.childIds || []) {
    const child = nodesById.get(childId);
    if (child && !seen.has(child.nodeId)) {
      seen.add(child.nodeId);
      children.push(child);
    }
  }
  for (const child of childrenByParent.get(node.nodeId) || []) {
    if (!seen.has(child.nodeId)) {
      seen.add(child.nodeId);
      children.push(child);
    }
  }
  return children;
}

async function snapshotStr(cdp, sid, compact = false) {
  const { nodes } = await cdp.send('Accessibility.getFullAXTree', {}, sid);
  const nodesById = new Map(nodes.map((node) => [node.nodeId, node]));
  const childrenByParent = new Map();
  for (const node of nodes) {
    if (!node.parentId) continue;
    if (!childrenByParent.has(node.parentId))
      childrenByParent.set(node.parentId, []);
    childrenByParent.get(node.parentId).push(node);
  }

  const lines = [];
  const visited = new Set();
  function visit(node, depth) {
    if (!node || visited.has(node.nodeId)) return;
    visited.add(node.nodeId);
    if (shouldShowAxNode(node, compact)) lines.push(formatAxNode(node, depth));
    for (const child of orderedAxChildren(node, nodesById, childrenByParent)) {
      visit(child, depth + 1);
    }
  }

  const roots = nodes.filter(
    (node) => !node.parentId || !nodesById.has(node.parentId),
  );
  for (const root of roots) visit(root, 0);
  for (const node of nodes) visit(node, 0);

  return lines.join('\n');
}

async function evalStr(cdp, sid, expression) {
  await cdp.send('Runtime.enable', {}, sid);
  const result = await cdp.send(
    'Runtime.evaluate',
    {
      expression,
      returnByValue: true,
      awaitPromise: true,
    },
    sid,
  );
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.text ||
        result.exceptionDetails.exception?.description,
    );
  }
  const val = result.result.value;
  return typeof val === 'object'
    ? JSON.stringify(val, null, 2)
    : String(val ?? '');
}

async function shotStr(cdp, sid, filePath, targetId) {
  // Get device scale factor so we can report coordinate mapping
  let dpr = 1;
  try {
    const metrics = await cdp.send('Page.getLayoutMetrics', {}, sid);
    dpr = metrics.visualViewport?.clientWidth
      ? metrics.cssVisualViewport?.clientWidth
        ? Math.round(
            (metrics.visualViewport.clientWidth /
              metrics.cssVisualViewport.clientWidth) *
              100,
          ) / 100
        : 1
      : 1;
    // Simpler: deviceScaleFactor is on the root Page metrics
    const { deviceScaleFactor } = await cdp
      .send('Emulation.getDeviceMetricsOverride', {}, sid)
      .catch(() => ({}));
    if (deviceScaleFactor) dpr = deviceScaleFactor;
  } catch {}
  // Fallback: try to get DPR from JS
  if (dpr === 1) {
    try {
      const raw = await evalStr(cdp, sid, 'window.devicePixelRatio');
      const parsed = parseFloat(raw);
      if (parsed > 0) dpr = parsed;
    } catch {}
  }

  const { data } = await cdp.send(
    'Page.captureScreenshot',
    { format: 'png' },
    sid,
  );
  const out =
    filePath ||
    resolve(
      RUNTIME_DIR,
      `screenshot-${(targetId || 'unknown').slice(0, 8)}.png`,
    );
  writeFileSync(out, Buffer.from(data, 'base64'));

  const lines = [out];
  lines.push(`Screenshot saved. Device pixel ratio (DPR): ${dpr}`);
  lines.push(`Coordinate mapping:`);
  lines.push(
    `  Screenshot pixels → CSS pixels (for CDP Input events): divide by ${dpr}`,
  );
  lines.push(
    `  e.g. screenshot point (${Math.round(100 * dpr)}, ${Math.round(200 * dpr)}) → CSS (100, 200) → use clickxy <target> 100 200`,
  );
  if (dpr !== 1) {
    lines.push(
      `  On this ${dpr}x display: CSS px = screenshot px / ${dpr} ≈ screenshot px × ${Math.round(100 / dpr) / 100}`,
    );
  }
  return lines.join('\n');
}

async function htmlStr(cdp, sid, selector) {
  const expr = selector
    ? `document.querySelector(${JSON.stringify(selector)})?.outerHTML || 'Element not found'`
    : `document.documentElement.outerHTML`;
  return evalStr(cdp, sid, expr);
}

async function waitForDocumentReady(cdp, sid, timeoutMs = NAVIGATION_TIMEOUT) {
  const deadline = Date.now() + timeoutMs;
  let lastState = '';
  let lastError;
  while (Date.now() < deadline) {
    try {
      const state = await evalStr(cdp, sid, 'document.readyState');
      lastState = state;
      if (state === 'complete') return;
    } catch (e) {
      lastError = e;
    }
    await sleep(200);
  }

  if (lastState) {
    throw new Error(
      `Timed out waiting for navigation to finish (last readyState: ${lastState})`,
    );
  }
  if (lastError) {
    throw new Error(
      `Timed out waiting for navigation to finish (${lastError.message})`,
    );
  }
  throw new Error('Timed out waiting for navigation to finish');
}

async function navStr(cdp, sid, url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      throw new Error(`Only http/https URLs allowed, got: ${url}`);
  } catch (e) {
    if (e.message.startsWith('Only')) throw e;
    throw new Error(`Invalid URL: ${url}`);
  }
  await cdp.send('Page.enable', {}, sid);
  const loadEvent = cdp.waitForEvent('Page.loadEventFired', NAVIGATION_TIMEOUT);
  const result = await cdp.send('Page.navigate', { url }, sid);
  if (result.errorText) {
    loadEvent.cancel();
    throw new Error(result.errorText);
  }
  if (result.loaderId) {
    await loadEvent.promise;
  } else {
    loadEvent.cancel();
  }
  await waitForDocumentReady(cdp, sid, 5000);
  return `Navigated to ${url}`;
}

async function netStr(cdp, sid) {
  const raw = await evalStr(
    cdp,
    sid,
    `JSON.stringify(performance.getEntriesByType('resource').map(e => ({
    name: e.name.substring(0, 120), type: e.initiatorType,
    duration: Math.round(e.duration), size: e.transferSize
  })))`,
  );
  return JSON.parse(raw)
    .map(
      (e) =>
        `${String(e.duration).padStart(5)}ms  ${String(e.size || '?').padStart(8)}B  ${e.type.padEnd(8)}  ${e.name}`,
    )
    .join('\n');
}

// Click element by CSS selector using real mouse events via CDP Input domain.
// Avoids el.click() which is a JS synthetic event that many frameworks ignore.
async function clickStr(cdp, sid, selector) {
  if (!selector) throw new Error('CSS selector required');
  const expr = `
    (function() {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { ok: false, error: 'Element not found: ' + ${JSON.stringify(selector)} };
      el.scrollIntoView({ block: 'center' });
      const rect = el.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      return { ok: true, x, y, tag: el.tagName, text: el.textContent.trim().substring(0, 80) };
    })()
  `;
  const result = await evalStr(cdp, sid, expr);
  const r = JSON.parse(result);
  if (!r.ok) throw new Error(r.error);
  const base = { x: r.x, y: r.y, button: 'left', clickCount: 1, modifiers: 0 };
  await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mouseMoved' }, sid);
  await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed' }, sid);
  await sleep(50);
  await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' }, sid);
  return `Clicked <${r.tag}> "${r.text}" at (${Math.round(r.x)}, ${Math.round(r.y)})`;
}

// Click at CSS pixel coordinates using Input.dispatchMouseEvent
async function clickXyStr(cdp, sid, x, y) {
  const cx = parseFloat(x);
  const cy = parseFloat(y);
  if (isNaN(cx) || isNaN(cy))
    throw new Error('x and y must be numbers (CSS pixels)');
  const base = { x: cx, y: cy, button: 'left', clickCount: 1, modifiers: 0 };
  await cdp.send(
    'Input.dispatchMouseEvent',
    { ...base, type: 'mouseMoved' },
    sid,
  );
  await cdp.send(
    'Input.dispatchMouseEvent',
    { ...base, type: 'mousePressed' },
    sid,
  );
  await sleep(50);
  await cdp.send(
    'Input.dispatchMouseEvent',
    { ...base, type: 'mouseReleased' },
    sid,
  );
  return `Clicked at CSS (${cx}, ${cy})`;
}

// Type text using Input.insertText (works in cross-origin iframes, unlike eval)
async function typeStr(cdp, sid, text) {
  if (text == null || text === '') throw new Error('text required');
  await cdp.send('Input.insertText', { text }, sid);
  return `Typed ${text.length} characters`;
}

// Load-more: repeatedly click a button/selector until it disappears
async function loadAllStr(cdp, sid, selector, intervalMs = 1500) {
  if (!selector) throw new Error('CSS selector required');
  let clicks = 0;
  const deadline = Date.now() + 5 * 60 * 1000; // 5-minute hard cap
  while (Date.now() < deadline) {
    const exists = await evalStr(
      cdp,
      sid,
      `!!document.querySelector(${JSON.stringify(selector)})`,
    );
    if (exists !== 'true') break;
    const clickExpr = `
      (function() {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        el.scrollIntoView({ block: 'center' });
        el.click();
        return true;
      })()
    `;
    const clicked = await evalStr(cdp, sid, clickExpr);
    if (clicked !== 'true') break;
    clicks++;
    await sleep(intervalMs);
  }
  return `Clicked "${selector}" ${clicks} time(s) until it disappeared`;
}

// Mapping for `key <target> <keyname>`. Covers the keys agents actually need.
// Maps friendly names → { key, code, windowsVirtualKeyCode, text? }.
const KEY_MAP = {
  enter:      { key: 'Enter',      code: 'Enter',      windowsVirtualKeyCode: 13, text: '\r' },
  return:     { key: 'Enter',      code: 'Enter',      windowsVirtualKeyCode: 13, text: '\r' },
  tab:        { key: 'Tab',        code: 'Tab',        windowsVirtualKeyCode: 9 },
  escape:     { key: 'Escape',     code: 'Escape',     windowsVirtualKeyCode: 27 },
  esc:        { key: 'Escape',     code: 'Escape',     windowsVirtualKeyCode: 27 },
  backspace:  { key: 'Backspace',  code: 'Backspace',  windowsVirtualKeyCode: 8 },
  delete:     { key: 'Delete',     code: 'Delete',     windowsVirtualKeyCode: 46 },
  space:      { key: ' ',          code: 'Space',      windowsVirtualKeyCode: 32, text: ' ' },
  arrowup:    { key: 'ArrowUp',    code: 'ArrowUp',    windowsVirtualKeyCode: 38 },
  up:         { key: 'ArrowUp',    code: 'ArrowUp',    windowsVirtualKeyCode: 38 },
  arrowdown:  { key: 'ArrowDown',  code: 'ArrowDown',  windowsVirtualKeyCode: 40 },
  down:       { key: 'ArrowDown',  code: 'ArrowDown',  windowsVirtualKeyCode: 40 },
  arrowleft:  { key: 'ArrowLeft',  code: 'ArrowLeft',  windowsVirtualKeyCode: 37 },
  left:       { key: 'ArrowLeft',  code: 'ArrowLeft',  windowsVirtualKeyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  right:      { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  home:       { key: 'Home',       code: 'Home',       windowsVirtualKeyCode: 36 },
  end:        { key: 'End',        code: 'End',        windowsVirtualKeyCode: 35 },
  pageup:     { key: 'PageUp',     code: 'PageUp',     windowsVirtualKeyCode: 33 },
  pagedown:   { key: 'PageDown',   code: 'PageDown',   windowsVirtualKeyCode: 34 },
};

// Press a single key (down then up). Use `type` for text input;
// use `key` for non-character keys like Enter, Tab, Escape, arrows.
async function keyStr(cdp, sid, keyName) {
  if (!keyName) throw new Error('key name required (e.g. enter, tab, escape, arrowdown)');
  const spec = KEY_MAP[keyName.toLowerCase()];
  if (!spec) {
    throw new Error(
      `Unknown key "${keyName}". Known: ${Object.keys(KEY_MAP).join(', ')}`,
    );
  }
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...spec }, sid);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...spec }, sid);
  return `Pressed ${spec.key}`;
}

// Poll for a CSS selector to appear. Returns element details on success;
// on timeout, dumps current URL/title/readyState so the agent can see why.
async function waitStr(cdp, sid, selector, timeoutMsRaw) {
  if (!selector) throw new Error('CSS selector required');
  const timeoutMs = timeoutMsRaw ? parseInt(timeoutMsRaw, 10) : 10000;
  if (isNaN(timeoutMs) || timeoutMs <= 0) {
    throw new Error('timeoutMs must be a positive number');
  }
  const deadline = Date.now() + timeoutMs;
  const expr = `
    (function() {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        tag: el.tagName,
        text: el.textContent.trim().substring(0, 80),
        visible: r.width > 0 && r.height > 0,
      };
    })()
  `;
  while (Date.now() < deadline) {
    const raw = await evalStr(cdp, sid, expr);
    if (raw && raw !== 'null' && raw !== '') {
      const info = JSON.parse(raw);
      return `Found <${info.tag}> "${info.text}" (visible=${info.visible})`;
    }
    await sleep(150);
  }
  // Capture page state so the agent can see whether the page didn't load,
  // the selector is wrong, or the element just hasn't rendered yet.
  let ctx = '';
  try {
    const dump = await evalStr(
      cdp, sid,
      `JSON.stringify({ url: location.href, title: document.title, ready: document.readyState, body_chars: (document.body && document.body.innerText.length) || 0 })`,
    );
    ctx = ' (' + dump + ')';
  } catch {}
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for "${selector}"${ctx}`,
  );
}

// click+type+Enter as one atomic command. Common pattern for search boxes
// and single-field forms. Returns a short summary.
async function submitStr(cdp, sid, selector, text) {
  if (!selector) throw new Error('selector required');
  if (text == null) throw new Error('text required');
  // Click to focus
  await clickStr(cdp, sid, selector);
  // Type into focused element
  if (text !== '') await cdp.send('Input.insertText', { text }, sid);
  // Press Enter
  const spec = KEY_MAP.enter;
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...spec }, sid);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...spec }, sid);
  return `Submitted "${text.slice(0, 60)}" into ${selector}`;
}

// Probe a CSS selector: returns how many elements matched plus a short
// description of the first N. Lets agents debug selectors without
// writing throwaway eval expressions.
async function probeStr(cdp, sid, selector, limitRaw) {
  if (!selector) throw new Error('CSS selector required');
  const limit = limitRaw ? parseInt(limitRaw, 10) : 5;
  if (isNaN(limit) || limit < 1) throw new Error('limit must be a positive integer');
  const expr = `
    (function() {
      const all = document.querySelectorAll(${JSON.stringify(selector)});
      const items = Array.from(all).slice(0, ${limit}).map((el) => {
        const r = el.getBoundingClientRect();
        // Surface the most informative attributes first.
        const attrs = {};
        for (const name of ['id', 'href', 'src', 'aria-label', 'role', 'data-testid', 'name', 'type', 'value']) {
          const v = el.getAttribute(name);
          if (v != null) attrs[name] = v.length > 80 ? v.slice(0, 80) + '…' : v;
        }
        return {
          tag: el.tagName.toLowerCase(),
          classes: (el.className && typeof el.className === 'string')
            ? el.className.trim().split(/\\s+/).slice(0, 4).join('.')
            : '',
          attrs,
          visible: r.width > 0 && r.height > 0,
          text: ((el.innerText || el.textContent || '').trim()).slice(0, 120),
        };
      });
      return JSON.stringify({ total: all.length, items });
    })()
  `;
  const raw = await evalStr(cdp, sid, expr);
  const { total, items } = JSON.parse(raw);
  if (total === 0) {
    return `Probe: 0 matches for "${selector}".`;
  }
  const lines = [`Probe: ${total} match(es) for "${selector}" (showing ${items.length}):`];
  items.forEach((it, i) => {
    const classes = it.classes ? '.' + it.classes : '';
    const attrPairs = Object.entries(it.attrs).map(([k, v]) => `${k}="${v}"`);
    const attrStr = attrPairs.length ? ' [' + attrPairs.join(' ') + ']' : '';
    const vis = it.visible ? '' : ' (hidden)';
    lines.push(`  [${i}] <${it.tag}${classes}>${attrStr}${vis}`);
    if (it.text) lines.push(`      text: ${JSON.stringify(it.text)}`);
  });
  return lines.join('\n');
}

// Quick page state snapshot — url + title + readyState + a few hints.
async function statusStr(cdp, sid) {
  const raw = await evalStr(
    cdp, sid,
    `JSON.stringify({
      url: location.href,
      title: document.title,
      ready: document.readyState,
      body_chars: (document.body && document.body.innerText.length) || 0,
      frames: window.frames.length,
      hidden: document.hidden,
    })`,
  );
  const info = JSON.parse(raw);
  return [
    `url:    ${info.url}`,
    `title:  ${info.title}`,
    `ready:  ${info.ready}`,
    `body:   ${info.body_chars} chars`,
    `frames: ${info.frames}`,
    `hidden: ${info.hidden}`,
  ].join('\n');
}

async function reloadStr(cdp, sid) {
  await cdp.send('Page.enable', {}, sid);
  const loadEvent = cdp.waitForEvent('Page.loadEventFired', NAVIGATION_TIMEOUT);
  await cdp.send('Page.reload', {}, sid);
  await loadEvent.promise;
  await waitForDocumentReady(cdp, sid, 5000);
  return 'Reloaded';
}

async function historyNavStr(cdp, sid, direction) {
  const { currentIndex, entries } = await cdp.send(
    'Page.getNavigationHistory', {}, sid,
  );
  const targetIndex = direction === 'back' ? currentIndex - 1 : currentIndex + 1;
  if (targetIndex < 0 || targetIndex >= entries.length) {
    throw new Error(`No history entry to go ${direction}`);
  }
  await cdp.send('Page.enable', {}, sid);
  // Back-forward cache hits don't reliably fire loadEventFired, so listen
  // for it on a short window AND fall back to a readyState poll.
  const loadEvent = cdp.waitForEvent('Page.loadEventFired', 2000);
  await cdp.send(
    'Page.navigateToHistoryEntry',
    { entryId: entries[targetIndex].id },
    sid,
  );
  try { await loadEvent.promise; } catch { loadEvent.cancel(); }
  await waitForDocumentReady(cdp, sid, 5000);
  return `Went ${direction} → ${entries[targetIndex].url}`;
}

// Send a raw CDP command and return the result as JSON
async function evalRawStr(cdp, sid, method, paramsJson) {
  if (!method) throw new Error('CDP method required (e.g. "DOM.getDocument")');
  let params = {};
  if (paramsJson) {
    try {
      params = JSON.parse(paramsJson);
    } catch {
      throw new Error(`Invalid JSON params: ${paramsJson}`);
    }
  }
  const result = await cdp.send(method, params, sid);
  return JSON.stringify(result, null, 2);
}

// ---------------------------------------------------------------------------
// Per-tab daemon
// ---------------------------------------------------------------------------

async function runDaemon(targetId) {
  const sp = sockPath(targetId);

  const cdp = new CDP();
  try {
    await cdp.connect(getWsUrl());
  } catch (e) {
    process.stderr.write(`Daemon: cannot connect to Chrome: ${e.message}\n`);
    process.exit(1);
  }

  let sessionId;
  try {
    const res = await cdp.send('Target.attachToTarget', {
      targetId,
      flatten: true,
    });
    sessionId = res.sessionId;
  } catch (e) {
    process.stderr.write(`Daemon: attach failed: ${e.message}\n`);
    cdp.close();
    process.exit(1);
  }

  // Shutdown helpers
  let alive = true;
  function shutdown() {
    if (!alive) return;
    alive = false;
    server.close();
    if (!IS_WINDOWS)
      try {
        unlinkSync(sp);
      } catch {}
    cdp.close();
    process.exit(0);
  }

  // Exit if target goes away or Chrome disconnects
  cdp.onEvent('Target.targetDestroyed', (params) => {
    if (params.targetId === targetId) shutdown();
  });
  cdp.onEvent('Target.detachedFromTarget', (params) => {
    if (params.sessionId === sessionId) shutdown();
  });
  cdp.onClose(() => shutdown());
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // Idle timer
  let idleTimer = setTimeout(shutdown, IDLE_TIMEOUT);
  function resetIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(shutdown, IDLE_TIMEOUT);
  }

  // Handle a command
  async function handleCommand({ cmd, args }) {
    resetIdle();
    try {
      let result;
      switch (cmd) {
        case 'list': {
          const pages = await getPages(cdp);
          result = formatPageList(pages);
          break;
        }
        case 'list_raw': {
          const pages = await getPages(cdp);
          result = JSON.stringify(pages);
          break;
        }
        case 'snap':
        case 'snapshot':
          result = await snapshotStr(cdp, sessionId, true);
          break;
        case 'eval':
          result = await evalStr(cdp, sessionId, args[0]);
          break;
        case 'shot':
        case 'screenshot':
          result = await shotStr(cdp, sessionId, args[0], targetId);
          break;
        case 'html':
          result = await htmlStr(cdp, sessionId, args[0]);
          break;
        case 'nav':
        case 'navigate':
          result = await navStr(cdp, sessionId, args[0]);
          break;
        case 'net':
        case 'network':
          result = await netStr(cdp, sessionId);
          break;
        case 'click':
          result = await clickStr(cdp, sessionId, args[0]);
          break;
        case 'clickxy':
          result = await clickXyStr(cdp, sessionId, args[0], args[1]);
          break;
        case 'type':
          result = await typeStr(cdp, sessionId, args[0]);
          break;
        case 'loadall':
          result = await loadAllStr(
            cdp,
            sessionId,
            args[0],
            args[1] ? parseInt(args[1]) : 1500,
          );
          break;
        case 'key':
          result = await keyStr(cdp, sessionId, args[0]);
          break;
        case 'submit':
          result = await submitStr(cdp, sessionId, args[0], args[1] ?? '');
          break;
        case 'status':
          result = await statusStr(cdp, sessionId);
          break;
        case 'probe':
          result = await probeStr(cdp, sessionId, args[0], args[1]);
          break;
        case 'wait':
          result = await waitStr(cdp, sessionId, args[0], args[1]);
          break;
        case 'reload':
          result = await reloadStr(cdp, sessionId);
          break;
        case 'back':
          result = await historyNavStr(cdp, sessionId, 'back');
          break;
        case 'forward':
          result = await historyNavStr(cdp, sessionId, 'forward');
          break;
        case 'evalraw':
          result = await evalRawStr(cdp, sessionId, args[0], args[1]);
          break;
        case 'stop':
          return { ok: true, result: '', stopAfter: true };
        default:
          return { ok: false, error: `Unknown command: ${cmd}` };
      }
      return { ok: true, result: result ?? '' };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // Unix socket server — NDJSON protocol
  // Wire format: each message is one JSON object followed by \n (newline-delimited JSON).
  // Request:  { "id": <number>, "cmd": "<command>", "args": ["arg1", "arg2", ...] }
  // Response: { "id": <number>, "ok": <boolean>, "result": "<string>" }
  //           or { "id": <number>, "ok": false, "error": "<message>" }
  const server = net.createServer((conn) => {
    let buf = '';
    conn.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop(); // keep incomplete last line
      for (const line of lines) {
        if (!line.trim()) continue;
        let req;
        try {
          req = JSON.parse(line);
        } catch {
          conn.write(
            JSON.stringify({
              ok: false,
              error: 'Invalid JSON request',
              id: null,
            }) + '\n',
          );
          continue;
        }
        handleCommand(req).then((res) => {
          const payload = JSON.stringify({ ...res, id: req.id }) + '\n';
          if (res.stopAfter) conn.end(payload, shutdown);
          else conn.write(payload);
        });
      }
    });
  });

  server.on('error', (e) => {
    process.stderr.write(`Daemon server listen failed: ${e.message}\n`);
    process.exit(1);
  });

  if (!IS_WINDOWS)
    try {
      unlinkSync(sp);
    } catch {}
  server.listen(sp);
}

// ---------------------------------------------------------------------------
// CLI ↔ daemon communication
// ---------------------------------------------------------------------------

function connectToSocket(sp) {
  return new Promise((resolve, reject) => {
    const conn = net.connect(sp);
    conn.on('connect', () => resolve(conn));
    conn.on('error', reject);
  });
}

async function getOrStartTabDaemon(targetId) {
  const sp = sockPath(targetId);
  // Try existing daemon
  try {
    return await connectToSocket(sp);
  } catch {}

  // Clean stale socket
  if (!IS_WINDOWS)
    try {
      unlinkSync(sp);
    } catch {}

  // Spawn daemon
  const child = spawn(
    process.execPath,
    [process.argv[1], '_daemon', targetId],
    {
      detached: true,
      stdio: 'ignore',
    },
  );
  child.unref();

  // Wait for socket (includes time for user to click Allow)
  for (let i = 0; i < DAEMON_CONNECT_RETRIES; i++) {
    await sleep(DAEMON_CONNECT_DELAY);
    try {
      return await connectToSocket(sp);
    } catch {}
  }
  throw new Error('Daemon failed to start — did you click Allow in Chrome?');
}

function sendCommand(conn, req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    let settled = false;

    const cleanup = () => {
      conn.off('data', onData);
      conn.off('error', onError);
      conn.off('end', onEnd);
      conn.off('close', onClose);
    };

    const onData = (chunk) => {
      buf += chunk.toString();
      const idx = buf.indexOf('\n');
      if (idx === -1) return;
      settled = true;
      cleanup();
      resolve(JSON.parse(buf.slice(0, idx)));
      conn.end();
    };

    const onError = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('Connection closed before response'));
    };

    const onClose = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('Connection closed before response'));
    };

    conn.on('data', onData);
    conn.on('error', onError);
    conn.on('end', onEnd);
    conn.on('close', onClose);
    req.id = 1;
    conn.write(JSON.stringify(req) + '\n');
  });
}

// ---------------------------------------------------------------------------
// Stop daemons
// ---------------------------------------------------------------------------

async function stopDaemons(targetPrefix) {
  if (!existsSync(PAGES_CACHE)) return;
  const pages = JSON.parse(readFileSync(PAGES_CACHE, 'utf8'));
  const targets = targetPrefix
    ? [
        resolvePrefix(
          targetPrefix,
          pages.map((p) => p.targetId),
          'target',
        ),
      ]
    : pages.map((p) => p.targetId);

  for (const targetId of targets) {
    const sp = sockPath(targetId);
    try {
      const conn = await connectToSocket(sp);
      await sendCommand(conn, { cmd: 'stop' });
    } catch {
      if (!IS_WINDOWS)
        try {
          unlinkSync(sp);
        } catch {}
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const USAGE = `cdp - lightweight Chrome DevTools Protocol CLI (no Puppeteer)

Usage: cdp <command> [args]

  launch [browser]                  Relaunch a browser with CDP enabled (default: arc)
                                    Known: arc, chrome, brave, edge, chromium
                                    Idempotent: skipped if browser already CDP-enabled
  list                              List open pages (shows unique target prefixes)
  snap  [target]                    Accessibility tree snapshot
  eval  [target] <expr>             Evaluate JS expression
  shot  [target] [file]             Screenshot (default: screenshot-<target>.png in runtime dir); prints coordinate mapping
  html  [target] [selector]         Get HTML (full page or CSS selector)
  nav   [target] <url>              Navigate to URL and wait for load completion
  net   [target]                    Network performance entries
  click   [target] <selector>       Click an element by CSS selector
  clickxy [target] <x> <y>          Click at CSS pixel coordinates (see coordinate note below)
  type    [target] <text>           Type text at current focus via Input.insertText
                                    Works in cross-origin iframes unlike eval-based approaches
  loadall [target] <selector> [ms]  Repeatedly click a "load more" button until it disappears
                                    Optional interval in ms between clicks (default 1500)
  key     [target] <name>           Press a single key — enter, tab, escape, esc,
                                    backspace, delete, space, arrowup/down/left/right
                                    (or up/down/left/right), home, end, pageup, pagedown
  wait    [target] <selector> [ms]  Block until selector exists (default 10000ms).
                                    On timeout, dumps URL/title/readyState for diagnosis.
  reload  [target]                  Reload the page and wait for load completion
  back    [target]                  Navigate one entry back in history
  forward [target]                  Navigate one entry forward in history
  submit  [target] <selector> <text>  click + insertText + Enter, one atomic action
                                    for search boxes and single-field forms
  status  [target]                  Show url, title, readyState, body size, frame count
  probe   [target] <sel> [n=5]      Inspect a CSS selector: show match count plus
                                    tag/classes/attrs/text of the first n elements.
                                    Use when scrape returns 0 or junk to debug the selector.
  scrape  [target] <container-sel>  Extract structured data from matching elements
          --limit N                 Limit number of results
          --field key=<selector>    Field to extract; text is element.innerText
          --field key=<sel>@<attr>  Use @attr to grab an attribute, e.g. a@href
  evalraw [target] <method> [json]  Send a raw CDP command; returns JSON result
                                    e.g. evalraw <t> "DOM.getDocument" '{}'
  open  [url]                       Open a new tab (default: about:blank)
                                    Note: each new tab triggers a fresh "Allow debugging?" prompt
  close <target>                    Close a browser tab and its daemon
  stop  [target]                    Stop daemon(s)

GLOBAL FLAGS
  --launch[=<browser>]              Ensure <browser> (default: arc) is running
                                    with CDP enabled before the command runs.
                                    Safe to combine with any command. The
                                    relaunch is idempotent — if the browser
                                    is already CDP-enabled, nothing happens.

<target> is a unique targetId prefix from "cdp list". It is OPTIONAL on
most commands: omitting it falls back to the last-used tab (current-tab),
which is updated by every command that names a target. The fallback also
kicks in if the first arg isn't a valid hex prefix — so e.g.
"cdp click '.menu-btn'" works without you naming the tab. If a prefix is
ambiguous, use more characters.

COORDINATE SYSTEM
  shot captures the viewport at the device's native resolution.
  The screenshot image size = CSS pixels × DPR (device pixel ratio).
  For CDP Input events (clickxy, etc.) you need CSS pixels, not image pixels.

    CSS pixels = screenshot image pixels / DPR

  shot prints the DPR and an example conversion for the current page.
  Typical Retina (DPR=2): CSS px ≈ screenshot px × 0.5
  If your viewer rescales the image further, account for that scaling too.

EVAL SAFETY NOTE
  Avoid index-based DOM selection (querySelectorAll(...)[i]) across multiple
  eval calls when the list can change between calls (e.g. after clicking
  "Ignore" buttons on a feed — indices shift). Prefer stable selectors or
  collect all data in a single eval.

DAEMON IPC (for advanced use / scripting)
  Each tab runs a persistent daemon at Unix socket in the runtime dir (see below).
  Protocol: newline-delimited JSON (one JSON object per line, UTF-8).
    Request:  {"id":<number>, "cmd":"<command>", "args":["arg1","arg2",...]}
    Response: {"id":<number>, "ok":true,  "result":"<string>"}
           or {"id":<number>, "ok":false, "error":"<message>"}
  Commands mirror the CLI: snap, eval, shot, html, nav, net, click, clickxy,
  type, loadall, key, wait, reload, back, forward, submit, status, evalraw,
  stop. (scrape is CLI-only — it builds a JS expr and runs it via eval.)
  Use evalraw to send arbitrary CDP methods.
  The socket disappears after 20 min of inactivity or when the tab closes.
`;

const NEEDS_TARGET = new Set([
  'snap',
  'snapshot',
  'eval',
  'shot',
  'screenshot',
  'html',
  'nav',
  'navigate',
  'net',
  'network',
  'click',
  'clickxy',
  'type',
  'loadall',
  'evalraw',
  'key',
  'wait',
  'reload',
  'back',
  'forward',
  'scrape',
  'submit',
  'status',
  'probe',
]);

// Parse a scrape field spec like:
//   user='selector'        → { sel: 'selector', attr: null }
//   link='a@href'          → { sel: 'a',        attr: 'href' }
//   src='img@src'          → { sel: 'img',      attr: 'src' }
function parseScrapeArgs(rawArgs) {
  const positional = [];
  const fields = []; // [[key, sel, attr], ...]
  let limit = null;
  for (let i = 0; i < rawArgs.length; i++) {
    const a = rawArgs[i];
    if (a === '--limit' && i + 1 < rawArgs.length) {
      limit = parseInt(rawArgs[++i], 10);
    } else if (a.startsWith('--limit=')) {
      limit = parseInt(a.slice('--limit='.length), 10);
    } else if (a === '--field' && i + 1 < rawArgs.length) {
      fields.push(parseFieldSpec(rawArgs[++i]));
    } else if (a.startsWith('--field=')) {
      fields.push(parseFieldSpec(a.slice('--field='.length)));
    } else if (a.startsWith('--')) {
      throw new Error(`Unknown flag for scrape: ${a}`);
    } else {
      positional.push(a);
    }
  }
  return { positional, fields, limit };
}

function parseFieldSpec(spec) {
  const eq = spec.indexOf('=');
  if (eq < 0) {
    throw new Error(`--field needs key=selector, got "${spec}"`);
  }
  const key = spec.slice(0, eq).trim();
  const value = spec.slice(eq + 1);
  if (!key) throw new Error(`--field key is empty in "${spec}"`);
  const atIdx = value.lastIndexOf('@');
  if (atIdx > 0) {
    return [key, value.slice(0, atIdx), value.slice(atIdx + 1)];
  }
  return [key, value, null];
}

// Build a JS expression that, when eval'd, returns a JSON string of the
// scraped results. Each container element is processed independently;
// when no fields are specified, the element's innerText is returned.
function buildScrapeExpr(container, fields, limit) {
  const limitClause = limit && limit > 0 ? `.slice(0, ${limit})` : '';
  if (fields.length === 0) {
    return (
      `JSON.stringify(Array.from(document.querySelectorAll(${JSON.stringify(container)}))` +
      `${limitClause}.map(el => (el.innerText || el.textContent || '').trim()))`
    );
  }
  const fieldEntries = fields
    .map(([key, sel, attr]) => {
      const access = attr
        ? `inner ? inner.getAttribute(${JSON.stringify(attr)}) : null`
        : `inner ? (inner.innerText || inner.textContent || '').trim() : null`;
      return (
        `[${JSON.stringify(key)}, ((el) => { const inner = el.querySelector(${JSON.stringify(sel)}); return ${access}; })(__el)]`
      );
    })
    .join(', ');
  return (
    `JSON.stringify(Array.from(document.querySelectorAll(${JSON.stringify(container)}))` +
    `${limitClause}.map(__el => Object.fromEntries([${fieldEntries}])))`
  );
}

const CDP_SENTINELS = [
  'CDP_NO_PORT_FILE',
  'CDP_ARC_NOT_RUNNING',
  'CDP_ORIGIN_LOCKDOWN',
  'CDP_PROBE_FAILED',
];

// Strip a global --launch[=<browser>] flag out of argv. Returns the
// requested browser name (default "arc") or null if the flag wasn't passed.
function extractLaunchFlag(argv) {
  let requested = null;
  const filtered = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--launch') {
      requested = requested ?? 'arc';
    } else if (a.startsWith('--launch=')) {
      requested = a.slice('--launch='.length) || 'arc';
    } else {
      filtered.push(a);
    }
  }
  argv.length = 0;
  argv.push(...filtered);
  return requested;
}

// Resolve args[0] as a target prefix if it looks like hex AND matches
// exactly one tab. Otherwise fall back to the cached current tab.
// Returns { targetId, consumed }: consumed=true means args[0] was the target.
function resolveTargetWithFallback(maybeArg, pages) {
  const targetIds = pages.map((p) => p.targetId);
  if (maybeArg && /^[a-fA-F0-9]{2,}$/.test(maybeArg)) {
    const upper = maybeArg.toUpperCase();
    const matches = targetIds.filter((id) => id.toUpperCase().startsWith(upper));
    if (matches.length === 1) return { targetId: matches[0], consumed: true };
    if (matches.length > 1) {
      throw new Error(
        `Ambiguous target prefix "${maybeArg}" — matches ${matches.length} tabs. Use more characters.`,
      );
    }
    // 0 matches → fall through; assume args[0] is a regular command arg.
  }
  const current = readCurrentTab();
  if (current && targetIds.includes(current)) {
    return { targetId: current, consumed: false };
  }
  throw new Error(
    'No target. Pass a tab ID or run "cdp list" to populate current-tab.',
  );
}

// Build the same command line that ran this process, plus `--launch`,
// so we can suggest it verbatim when CDP fails. Never spell raw
// `open -a Arc.app …` — that bypasses our vetted relaunch path.
function buildRerunSuggestion() {
  const prog = process.argv[1].includes('cdp.mjs') ? 'cdp' : process.argv[1];
  const rest = process.argv.slice(2);
  if (rest.some((a) => a === '--launch' || a.startsWith('--launch='))) {
    return null; // Already had --launch; another suggestion wouldn't help.
  }
  return `${prog} ${rest.join(' ')} --launch`.trim();
}

async function main() {
  const rawArgs = process.argv.slice(2);

  // Daemon mode (internal) — no flag parsing, raw argv.
  if (rawArgs[0] === '_daemon') {
    await runDaemon(rawArgs[1]);
    return;
  }

  const launchRequested = extractLaunchFlag(rawArgs);
  const [cmd, ...args] = rawArgs;

  // Explicit launch command.
  if (cmd === 'launch') {
    const name = args[0] || 'arc';
    await launchBrowser(name);
    return;
  }

  // Honor --launch flag: ensure browser is up before any command.
  if (launchRequested) {
    await launchBrowser(launchRequested);
  }

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(USAGE);
    process.exit(0);
  }

  if (cmd === 'list' || cmd === 'ls') {
    const cdp = new CDP();
    await cdp.connect(getWsUrl());
    const pages = await getPages(cdp);
    cdp.close();
    writeFileSync(PAGES_CACHE, JSON.stringify(pages), { mode: 0o600 });
    // If currentTab still exists, surface it; otherwise pick the first
    // listed page as a sane default so subsequent commands can omit target.
    const current = readCurrentTab();
    if (!current || !pages.some((p) => p.targetId === current)) {
      if (pages.length > 0) writeCurrentTab(pages[0].targetId);
    }
    console.log(formatPageList(pages));
    setTimeout(() => process.exit(0), 100);
    return;
  }

  // Open new tab. Waits for load by default; pass --no-wait to return immediately.
  if (cmd === 'open') {
    const noWait = args.includes('--no-wait');
    const positional = args.filter((a) => a !== '--no-wait');
    const url = positional[0] || 'about:blank';

    const cdp = new CDP();
    await cdp.connect(getWsUrl());
    const { targetId } = await cdp.send('Target.createTarget', { url });

    // Refresh cache; new tab may not appear in getTargets immediately, so add it manually
    const pages = await getPages(cdp);
    if (!pages.some((p) => p.targetId === targetId)) {
      pages.push({ targetId, title: url, url });
    }
    writeFileSync(PAGES_CACHE, JSON.stringify(pages), { mode: 0o600 });
    writeCurrentTab(targetId);
    addOwnedTab(targetId);

    if (noWait || url === 'about:blank' || !/^https?:/i.test(url)) {
      cdp.close();
      console.log(`Opened new tab: ${targetId.slice(0, 8)}  ${url}`);
      setTimeout(() => process.exit(0), 100);
      return;
    }

    // Wait for the new tab's load event via a flat session.
    try {
      const { sessionId } = await cdp.send('Target.attachToTarget', {
        targetId, flatten: true,
      });
      await cdp.send('Page.enable', {}, sessionId);
      const loadEvent = cdp.waitForEvent('Page.loadEventFired', NAVIGATION_TIMEOUT);
      try { await loadEvent.promise; } catch { loadEvent.cancel(); }
      await waitForDocumentReady(cdp, sessionId, 5000);
    } catch {
      // Best-effort: opening succeeded even if the wait failed.
    }
    cdp.close();

    console.log(`Opened new tab: ${targetId.slice(0, 8)}  ${url}`);
    setTimeout(() => process.exit(0), 100);
    return;
  }

  // Close tab(s). "close all" closes ONLY tabs ccdp itself opened —
  // the user's own tabs are left untouched (SAFETY: never close tabs
  // we don't own).
  if (cmd === 'close') {
    if (args[0] === 'all') {
      const owned = readOwnedTabs();
      if (owned.length === 0) {
        console.log('No ccdp-owned tabs to close.');
        setTimeout(() => process.exit(0), 100);
        return;
      }
      const cdpC = new CDP();
      await cdpC.connect(getWsUrl());
      const live = await getPages(cdpC);
      const liveIds = new Set(live.map((p) => p.targetId));
      // Intersect owned ∩ live so we don't try closing tabs the user
      // already manually closed.
      const toClose = owned.filter((id) => liveIds.has(id));
      let closed = 0;
      for (const id of toClose) {
        try {
          await cdpC.send('Target.closeTarget', { targetId: id });
          closed++;
        } catch {}
        await stopDaemons(id);
      }
      cdpC.close();
      writeOwnedTabs([]);
      // Rewrite page cache to drop closed tabs.
      const remaining = live.filter((p) => !toClose.includes(p.targetId));
      writeFileSync(PAGES_CACHE, JSON.stringify(remaining), { mode: 0o600 });
      // Clear current-tab if it was a closed one.
      const current = readCurrentTab();
      if (current && toClose.includes(current)) {
        try { unlinkSync(CURRENT_TAB_FILE); } catch {}
      }
      const otherLive = live.length - closed;
      console.log(
        `Closed ${closed} ccdp-owned tab(s); left ${otherLive} other tab(s) untouched.`,
      );
      setTimeout(() => process.exit(0), 100);
      return;
    }

    if (!existsSync(PAGES_CACHE)) {
      console.error('No page list cached. Run "cdp list" first.');
      process.exit(1);
    }
    const pages = JSON.parse(readFileSync(PAGES_CACHE, 'utf8'));
    const { targetId } = resolveTargetWithFallback(args[0], pages);

    // Stop daemon for this tab first (if running)
    await stopDaemons(targetId);
    // Close the browser tab
    const cdp = new CDP();
    await cdp.connect(getWsUrl());
    await cdp.send('Target.closeTarget', { targetId });
    cdp.close();
    // Update cache and clear current-tab if it was this one
    const remaining = pages.filter((p) => p.targetId !== targetId);
    writeFileSync(PAGES_CACHE, JSON.stringify(remaining), { mode: 0o600 });
    clearCurrentTab(targetId);
    removeOwnedTab(targetId);
    console.log(`Closed tab: ${targetId.slice(0, 8)}`);
    setTimeout(() => process.exit(0), 100);
    return;
  }

  // Stop
  if (cmd === 'stop') {
    await stopDaemons(args[0]);
    return;
  }

  // Page commands — need a target (explicit or current-tab fallback)
  if (!NEEDS_TARGET.has(cmd)) {
    console.error(`Unknown command: ${cmd}\n`);
    console.log(USAGE);
    process.exit(1);
  }

  // Resolve target → full targetId, refreshing pages cache if it's missing
  // or stale. This lets agents skip "cdp list" before commands.
  let pages;
  if (existsSync(PAGES_CACHE)) {
    pages = JSON.parse(readFileSync(PAGES_CACHE, 'utf8'));
  } else {
    const cdpLocal = new CDP();
    await cdpLocal.connect(getWsUrl());
    pages = await getPages(cdpLocal);
    cdpLocal.close();
    writeFileSync(PAGES_CACHE, JSON.stringify(pages), { mode: 0o600 });
  }
  const { targetId, consumed } = resolveTargetWithFallback(args[0], pages);
  writeCurrentTab(targetId);

  const conn = await getOrStartTabDaemon(targetId);

  const cmdArgs = consumed ? args.slice(1) : args.slice(0);

  if (cmd === 'scrape') {
    // CLI-side: parse --field/--limit, build JS expr, dispatch as eval.
    let parsed;
    try {
      parsed = parseScrapeArgs(cmdArgs);
    } catch (e) {
      console.error('Error:', e.message);
      process.exit(1);
    }
    const container = parsed.positional[0];
    if (!container) {
      console.error('Error: container selector required, e.g. scrape "article"');
      process.exit(1);
    }
    const expr = buildScrapeExpr(container, parsed.fields, parsed.limit);
    const response = await sendCommand(conn, { cmd: 'eval', args: [expr] });
    if (!response.ok) {
      console.error('Error:', response.error);
      process.exitCode = 1;
      return;
    }
    let data;
    try { data = JSON.parse(response.result); } catch {
      console.log(response.result);
      return;
    }

    // Diagnostic line to stderr so JSON on stdout stays consumable.
    // Empty results almost always mean the container selector is wrong;
    // surface that loudly so the agent doesn't silently move on.
    const total = Array.isArray(data) ? data.length : 0;
    if (total === 0) {
      console.error(
        `Scrape: 0 matches for container "${container}". ` +
          `Check the selector; e.g. try cdp eval 'document.querySelectorAll(${JSON.stringify(container)}).length'.`,
      );
    } else if (parsed.fields.length > 0) {
      const allNull = data.filter((item) =>
        item && typeof item === 'object' &&
        Object.values(item).every((v) => v == null || v === ''),
      ).length;
      console.error(
        `Scrape: ${total} containers matched` +
          (allNull > 0
            ? `, ${allNull} had no fields populated (selector mismatch?)`
            : ''),
      );
    } else {
      console.error(`Scrape: ${total} containers matched`);
    }
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (cmd === 'submit') {
    // submit <selector> <text...> — join remaining args as text body.
    if (!cmdArgs[0]) {
      console.error('Error: selector required, e.g. submit \'input[type="search"]\' "your query"');
      process.exit(1);
    }
    if (cmdArgs.length > 2) cmdArgs[1] = cmdArgs.slice(1).join(' ');
  } else if (cmd === 'eval') {
    const expr = cmdArgs.join(' ');
    if (!expr) {
      console.error('Error: expression required');
      process.exit(1);
    }
    cmdArgs[0] = expr;
  } else if (cmd === 'type') {
    // Join all remaining args as text (allows spaces)
    const text = cmdArgs.join(' ');
    if (!text) {
      console.error('Error: text required');
      process.exit(1);
    }
    cmdArgs[0] = text;
  } else if (cmd === 'evalraw') {
    // args: [method, ...jsonParts] — join json parts in case of spaces
    if (!cmdArgs[0]) {
      console.error('Error: CDP method required');
      process.exit(1);
    }
    if (cmdArgs.length > 2) cmdArgs[1] = cmdArgs.slice(1).join(' ');
  }

  if ((cmd === 'nav' || cmd === 'navigate') && !cmdArgs[0]) {
    console.error('Error: URL required');
    process.exit(1);
  }

  const response = await sendCommand(conn, { cmd, args: cmdArgs });

  if (response.ok) {
    if (response.result) {
      console.log(response.result);
    } else if (cmd === 'eval') {
      // eval often returns ''/undefined when an expression evaluates to
      // a falsy/empty value. A silent stdout looks like a failure to the
      // agent, so make the empty result explicit.
      console.error('(empty result — expression returned empty string, null, or undefined)');
    }
  } else {
    console.error('Error:', response.error);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  const msg = e.message || String(e);
  if (CDP_SENTINELS.some((s) => msg.includes(s))) {
    const rerun = buildRerunSuggestion();
    console.error(`Error: ${msg}`);
    if (rerun) {
      console.error(
        `\nTo auto-launch the browser with CDP enabled and retry, run:\n  ${rerun}`,
      );
    }
  } else {
    console.error(msg);
  }
  process.exit(1);
});
