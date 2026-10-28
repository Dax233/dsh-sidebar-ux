import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * Load the browser half the way the Web client does: evaluate its source with a
 * `window.__ModuleLoader__.load` stub and call the captured factory.
 * @returns plugin module (inject/apply/__internals).
 */
async function loadPlugin() {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
  let registration;
  const windowStub = {
    __ModuleLoader__: {
      load(value) {
        registration = value;
      },
    },
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: (fn) => {
      fn();
      return 1;
    },
  };
  // The factory only closes over pure helpers; nothing touches DOM until apply().
  const run = new Function('window', source);
  run(windowStub);
  assert.ok(registration, 'bundle registers itself through window.__ModuleLoader__');
  assert.equal(registration.id, '@local/dsh-sidebar-ux');
  return registration.factory();
}

/** Minimal element base so the bundle's `instanceof Element` guards accept fakes. */
class FakeElement {
  constructor() {
    this.classList = { add() {}, remove() {} };
  }
}

/**
 * Fake document that records listener phases.
 * @returns document stub with `listeners` map.
 */
function fakeDocument() {
  const listeners = new Map();
  return {
    listeners,
    head: { appendChild() {}, removeChild() {} },
    createElement() {
      return { dataset: {}, style: {}, textContent: '', remove() {} };
    },
    addEventListener(type, fn, capture) {
      listeners.set(`${type}:${capture === true}`, fn);
    },
    removeEventListener() {},
    querySelector() {
      return null;
    },
  };
}

/**
 * Fake Cordis client context with the services the plugin injects.
 * @returns context stub plus the recorded insert calls.
 */
function fakeContext() {
  const inserts = [];
  const target = {
    sessionId: 'session-target',
    retainedBy: { mainView: 0 },
  };
  const source = {
    sessionId: 'session-source',
    retainedBy: { mainView: 0 },
  };
  const list = {
    getSnapshot: () => ({
      ids: [target.sessionId, source.sessionId],
      byId: {
        [target.sessionId]: { ...target, displayTitle: 'Target chat' },
        [source.sessionId]: { ...source, displayTitle: 'Source chat' },
      },
    }),
  };
  const input = {
    caretSpan: () => ({ start: 3, end: 3 }),
    snapshot: { draftRev: 7 },
    insertReference: (reference, span) => {
      inserts.push({ reference, span });
      return true;
    },
    notify() {},
    focus() {},
  };
  const ctx = {
    effect(fn) {
      const dispose = fn();
      return dispose;
    },
    locale: {
      register: () => () => {},
      bind: () => (key) => key,
    },
    sessions: {
      list,
      scope: (id) => (id === target.sessionId ? { sessionId: id } : undefined),
    },
    conversation: { input: { for: () => input } },
    workspaces: { list: { getSnapshot: () => ({ items: [] }) } },
    // `remote` is declared in inject but only read when the menu row activates.
    remote: { session: {} },
    get(key) {
      return this[key];
    },
  };
  return { ctx, inserts, list, input };
}

test('mention encoding matches the host session-reference form', async () => {
  const { __internals } = await loadPlugin();
  const id = 'session-abcdef-123';
  const expected = `dsh-session:${Buffer.from(JSON.stringify(id), 'utf8')
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '')}`;
  assert.equal(__internals.encodeSessionUri(id), expected);
  assert.equal(__internals.formatSessionMention(id, 'A]B\\C'), `@[A\\]B\\\\C](${expected})`);
  assert.equal(__internals.formatSessionMention(id), `@[${id}](${expected})`);
});

test('session-id plausibility rejects workspace keys', async () => {
  const { __internals } = await loadPlugin();
  assert.equal(__internals.isPlausibleSessionId('session-58374031-78dd'), true);
  assert.equal(__internals.isPlausibleSessionId('workspace:1111'), false);
  assert.equal(__internals.isPlausibleSessionId(''), false);
  assert.equal(__internals.isPlausibleSessionId(null), false);
});

test('current session resolution supports both host list shapes', async () => {
  const { __internals } = await loadPlugin();
  assert.equal(__internals.currentSessionIdOf({ current: 'legacy' }), 'legacy');
  assert.equal(
    __internals.currentSessionIdOf({
      byId: {
        a: { retainedBy: { mainView: 0 } },
        b: { retainedBy: { mainView: 2 } },
      },
    }),
    'b',
  );
  assert.equal(__internals.currentSessionIdOf({ byId: {} }), undefined);
  assert.equal(__internals.currentSessionIdOf(undefined), undefined);
});

test('row menu trigger prefers the labelled action button', async () => {
  const { __internals } = await loadPlugin();
  const menuButton = { getAttribute: () => '会话“x”的操作' };
  const other = { getAttribute: () => '归档会话' };
  const row = {
    querySelector: () => ({ querySelectorAll: () => [other, menuButton] }),
  };
  assert.equal(__internals.rowMenuTrigger(row), menuButton);
  const fallbackRow = {
    querySelector: () => ({ querySelectorAll: () => [other] }),
  };
  assert.equal(__internals.rowMenuTrigger(fallbackRow), other);
  assert.equal(__internals.rowMenuTrigger({ querySelector: () => ({ querySelectorAll: () => [] }) }), null);
});

test('apply wires document listeners in the required phases', async () => {
  const plugin = await loadPlugin();
  const doc = fakeDocument();
  const { ctx } = fakeContext();
  globalThis.Element = FakeElement;
  const previousDocument = globalThis.document;
  globalThis.document = doc;
  try {
    plugin.apply(ctx);
  } finally {
    globalThis.document = previousDocument;
  }
  assert.equal(typeof doc.listeners.get('contextmenu:true'), 'function');
  assert.equal(typeof doc.listeners.get('dragstart:false'), 'function');
  assert.equal(typeof doc.listeners.get('dragover:true'), 'function');
  assert.equal(typeof doc.listeners.get('drop:true'), 'function');
  assert.equal(typeof doc.listeners.get('dragend:false'), 'function');
  assert.equal(typeof doc.listeners.get('dragleave:true'), 'function');
});

test('right-click on a session row clicks the shipped menu trigger', async () => {
  const plugin = await loadPlugin();
  const doc = fakeDocument();
  const { ctx } = fakeContext();
  globalThis.Element = FakeElement;
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  globalThis.document = doc;
  globalThis.window = { setInterval: () => 1, clearInterval: () => {}, setTimeout: () => 1 };
  try {
    plugin.apply(ctx);
  } finally {
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
  }
  const menuButton = {
    clicks: 0,
    click() {
      this.clicks += 1;
    },
    getAttribute: () => '会话“x”的操作',
  };
  const row = {
    getAttribute: (name) => (name === 'data-row-key' ? 'session:session-source' : null),
    querySelector: () => ({ querySelectorAll: () => [menuButton] }),
  };
  const target = new FakeElement();
  target.closest = (selector) => (selector === '[data-row-key]' ? row : null);
  const event = {
    defaultPrevented: false,
    target,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {},
  };
  doc.listeners.get('contextmenu:true')(event);
  assert.equal(menuButton.clicks, 1);
  assert.equal(event.defaultPrevented, true);
});

test('dropping a dragged session row inserts a reference chip', async () => {
  const plugin = await loadPlugin();
  const doc = fakeDocument();
  const { ctx, inserts, list } = fakeContext();
  globalThis.Element = FakeElement;
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  globalThis.document = doc;
  globalThis.window = { setInterval: () => 1, clearInterval: () => {}, setTimeout: () => 1 };
  try {
    plugin.apply(ctx);
  } finally {
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
  }
  // Mark the target session as the one in the main view.
  list.getSnapshot = () => ({
    ids: ['session-target', 'session-source'],
    byId: {
      'session-target': { sessionId: 'session-target', retainedBy: { mainView: 1 }, displayTitle: 'Target chat' },
      'session-source': { sessionId: 'session-source', retainedBy: { mainView: 0 }, displayTitle: 'Source chat' },
    },
  });

  const sourceRow = new FakeElement();
  sourceRow.closest = (selector) => (selector === '[data-row-key]' ? { getAttribute: () => 'session:session-source' } : null);
  const dragStart = {
    target: sourceRow,
    dataTransfer: { getData: () => 'session-source', effectAllowed: 'move' },
  };
  doc.listeners.get('dragstart:false')(dragStart);
  assert.equal(dragStart.dataTransfer.effectAllowed, 'copyMove');

  const composer = new FakeElement();
  const host = { getAttribute: () => 'session-target' };
  composer.closest = (selector) =>
    selector === '[data-composer-card="true"]'
      ? composer
      : selector === '[data-conversation-session]'
        ? host
        : null;
  const dropEvent = {
    target: composer,
    dataTransfer: {},
    preventDefault() {},
    stopPropagation() {},
  };
  doc.listeners.get('drop:true')(dropEvent);

  assert.equal(inserts.length, 1);
  const [{ reference, span }] = inserts;
  assert.equal(reference.source, 'reference');
  assert.equal(reference.appearance, 'session');
  assert.equal(reference.label, 'Source chat');
  assert.match(reference.ref, /^@\[Source chat\]\(dsh-session:[A-Za-z0-9_-]+\)$/u);
  assert.deepEqual(span, { start: 3, end: 3, draftRev: 7 });
});

test('dropping a session onto its own composer notifies instead of inserting', async () => {
  const plugin = await loadPlugin();
  const doc = fakeDocument();
  const { ctx, inserts, list } = fakeContext();
  globalThis.Element = FakeElement;
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  globalThis.document = doc;
  globalThis.window = { setInterval: () => 1, clearInterval: () => {}, setTimeout: () => 1 };
  try {
    plugin.apply(ctx);
  } finally {
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
  }
  list.getSnapshot = () => ({
    ids: ['session-target'],
    byId: { 'session-target': { sessionId: 'session-target', retainedBy: { mainView: 1 }, displayTitle: 'Target chat' } },
  });
  const row = new FakeElement();
  row.closest = (selector) => (selector === '[data-row-key]' ? { getAttribute: () => 'session:session-target' } : null);
  doc.listeners.get('dragstart:false')({ target: row, dataTransfer: { getData: () => 'session-target', effectAllowed: 'move' } });
  const composer = new FakeElement();
  const host = { getAttribute: () => 'session-target' };
  composer.closest = (selector) =>
    selector === '[data-composer-card="true"]'
      ? composer
      : selector === '[data-conversation-session]'
        ? host
        : null;
  doc.listeners.get('drop:true')({ target: composer, dataTransfer: {}, preventDefault() {}, stopPropagation() {} });
  assert.equal(inserts.length, 0);
});
