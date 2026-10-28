/**
 * Browser half of @local/dsh-sidebar-ux.
 *
 * Three additive surfaces over the shipped sidebar, no slot replacement:
 *
 * 1. Right-click on a session row clicks the row's own "…" trigger, so the
 *    shipped menu (pin / rename / fork / archive / copy Session ID) opens
 *    exactly as if it had been clicked. Same for a workspace row's "…" menu.
 * 2. While a workspace menu is open, one extra row — "Open in File Explorer" —
 *    is appended to it. The shipped workspace menu has no client slot, so the
 *    row is a clone of a shipped item (styling and markup stay host-owned) with
 *    its own click handler; a MutationObserver re-appends it if React re-renders
 *    the menu while it is open.
 * 3. Dragging a session row onto the composer inserts a real session-reference
 *    chip through the same facade the "@" picker uses
 *    (`conversation.input.for(actx).insertReference(reference, span)`), with the
 *    canonical `@[label](dsh-session:…)` mention as the clipboard form.
 *
 * Techniques and API contracts follow the public prior art (MIT / BSD-3):
 * dsh-drag (drag/insert facade, span CAS, self-reference notice) and
 * dsh-session-folder (capture-phase contextmenu -> shipped row trigger). The
 * extra pieces here are the workspace-menu item injection and the workspace
 * directory hand-off through the shipped Session Remote.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-sidebar-ux',
  factory() {
    /** Locale namespace owned by this plugin. */
    const NS = 'sidebar-ux';

    /** Dictionaries; zh is the key-set source of truth. */
    const DICTIONARIES = {
      zh: {
        'menu.openInExplorer': '在文件资源管理器中打开',
        'info.self': '当前会话不需要引用自己',
        'error.insert': '会话引用插入失败',
        'error.noComposer': '找不到可插入引用的输入框',
        'error.openWorkspace': '无法打开工作区目录',
      },
      en: {
        'menu.openInExplorer': 'Open in File Explorer',
        'info.self': 'The current session does not need to reference itself',
        'error.insert': 'Failed to insert the session reference',
        'error.noComposer': 'No composer is available to insert the reference',
        'error.openWorkspace': 'Could not open the workspace directory',
      },
    };

    const MENU = '[role="menu"]';
    const ROW_ACTIONS = '[class*="rowActions"]';
    const ITEM_WRAP = '[class*="itemWrap"]';
    const ITEM_VIEWPORT = '[class*="viewport"]';
    const COMPOSER_AREA = '[data-conversation-region="composer"]';
    const COMPOSER_CARD = '[data-composer-card="true"]';
    const CONVERSATION_SESSION = '[data-conversation-session]';
    const DROP_HIGHLIGHT = 'dsh-sidebar-ux-drop-target';
    const ITEM_MARK = 'data-sidebar-ux-menu-item';

    /** Hardcoded folder glyph used when the row carries no own icon. */
    const FALLBACK_FOLDER_ICON =
      '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true" stroke-width="1">' +
      '<path d="M1.5 4.5C1.5 3.95 1.95 3.5 2.5 3.5H6l1.3 1.5h6.2c.55 0 1 .45 1 1v6c0 .55-.45 1-1 1h-11c-.55 0-1-.45-1-1v-6.5Z" stroke="currentColor" stroke-linejoin="round"/>' +
      '</svg>';

    /**
     * Canonical `dsh-session:` URI (host form: base64url(JSON.stringify(id))),
     * mirrored from `@deepseek-ai/dsh-session-reference`.
     * @param sessionId - session identity string.
     * @returns canonical URI.
     */
    function encodeSessionUri(sessionId) {
      const bytes = new TextEncoder().encode(JSON.stringify(sessionId));
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return `dsh-session:${btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
    }

    /**
     * Escape a mention label the way the host parses it (backslash and closing
     * bracket).
     * @param label - visible label.
     * @returns escaped label.
     */
    function escapeLabel(label) {
      return label.replace(/[\\\]]/gu, (match) => `\\${match}`);
    }

    /**
     * Host-neutral Markdown mention carrying the canonical URI.
     * @param sessionId - referenced session.
     * @param label - display title.
     * @returns `@[label](dsh-session:…)`.
     */
    function formatSessionMention(sessionId, label) {
      return `@[${escapeLabel(label ?? sessionId)}](${encodeSessionUri(sessionId)})`;
    }

    /** True when the payload looks like a bare host session id. */
    function isPlausibleSessionId(value) {
      return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(value);
    }

    /**
     * The "…" menu trigger of one sidebar row: the first button inside the row's
     * hover-actions cell (session rows: menu trigger, then slotted actions;
     * workspace rows: menu trigger, then "new session").
     * @param row - `[data-row-key]` element.
     * @returns trigger button, or null.
     */
    function rowMenuTrigger(row) {
      const actions = row.querySelector(ROW_ACTIONS) ?? row;
      const buttons = [...actions.querySelectorAll('button')];
      if (buttons.length === 0) return null;
      return (
        buttons.find((button) => /操作|action|menu/iu.test(button.getAttribute('aria-label') ?? '')) ??
        buttons[0]
      );
    }

    /**
     * Dispatch a click on the trigger. React state updates asynchronously, so the
     * menu appears a tick later; callers poll for it.
     * @param trigger - menu trigger button.
     * @returns undefined.
     */
    function clickTrigger(trigger) {
      try {
        trigger.click();
      } catch {
        /* the row may have unmounted between pointerdown and contextmenu */
      }
    }

    /**
     * Close one open menu with Escape (the host menu's own close path). A pointer
     * press on the anchor is the fallback for a menu that ignores synthetic keys.
     * @param menu - `[role="menu"]` element.
     * @returns undefined.
     */
    function closeMenu(menu) {
      const active = document.activeElement;
      const target = active instanceof Element && menu.contains(active) ? active : menu;
      target.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          code: 'Escape',
          keyCode: 27,
          which: 27,
          bubbles: true,
          cancelable: true,
        }),
      );
      window.setTimeout(() => {
        if (!menu.isConnected) return;
        target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
      }, 0);
    }

    /**
     * The session the main view currently shows: the host's own predicate
     * (`retainedBy.mainView > 0` from 0.2.0-rc.2 on, `current` on older hosts).
     * @param list - `sessions.list.getSnapshot()`.
     * @returns session id, or undefined.
     */
    function currentSessionIdOf(list) {
      if (list === undefined || list === null) return undefined;
      if (typeof list.current === 'string' && list.current !== '') return list.current;
      const rows = list.byId ?? {};
      for (const id of Object.keys(rows)) {
        if ((rows[id]?.retainedBy?.mainView ?? 0) > 0) return id;
      }
      return undefined;
    }

    /**
     * @param ctx - client root context.
     * @returns plugin body.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, DICTIONARIES), 'sidebar-ux: dictionaries');
      const t = ctx.locale.bind(NS);

      const sessions = ctx.sessions ?? ctx.get('sessions');
      const conversation = ctx.conversation ?? ctx.get('conversation');
      const workspaces = ctx.workspaces ?? ctx.get('workspaces');

      /** Disposers for transient menu watchers (plugin unload cleanup). */
      const watchers = new Set();

      /** The drag gesture in flight, or null. */
      let dragging = null;
      /** A drag whose `dragend` already ran can never drop. */
      let dragEnded = true;
      /** Composer element currently highlighted as the drop target. */
      let highlighted = null;

      /** Remove the drop highlight from whichever composer carries it. */
      function clearHighlight() {
        if (highlighted !== null) highlighted.classList.remove(DROP_HIGHLIGHT);
        highlighted = null;
      }

      /**
       * Resolve the session-input facade of one session.
       * @param targetSessionId - session whose composer receives the edit.
       * @returns `{ insertReference, span, notify }`, or null.
       */
      function resolveFace(targetSessionId) {
        try {
          if (sessions === undefined || conversation === undefined) return null;
          const actx = sessions.scope(targetSessionId);
          if (actx === undefined) return null;
          const input = conversation.input.for(actx);
          return {
            input,
            span: () => {
              const caret = typeof input.caretSpan === 'function' ? input.caretSpan() : { start: 0, end: 0 };
              const snapshot = input.snapshot ?? input.state?.getSnapshot?.();
              return { start: caret.start, end: caret.end, draftRev: snapshot?.draftRev ?? 0 };
            },
            insertReference: (reference, span) => input.insertReference(reference, span),
            notify: (level, text) => input.notify(level, text),
          };
        } catch {
          return null;
        }
      }

      /**
       * Tell the user something through the composer's own notice banner when a
       * composer exists; fall back to the console elsewhere.
       * @param level - info or error.
       * @param text - localized message.
       * @returns undefined.
       */
      function notify(level, text) {
        const list = sessions?.list?.getSnapshot?.();
        const current = currentSessionIdOf(list);
        const face = current === undefined ? null : resolveFace(current);
        if (face !== null) {
          try {
            face.notify(level, text);
            return;
          } catch {
            /* fall through to the console */
          }
        }
        console.warn(`[sidebar-ux] ${text}`);
      }

      /**
       * Open one registered workspace directory in the OS file manager through
       * the shipped Session Remote (`openWorkspacePath` verifies the path on the
       * Host and opens the folder with the default handler).
       * @param workspaceId - workspace identity from the row.
       * @returns promise resolved when the Host answered.
       */
      async function openWorkspaceInExplorer(workspaceId) {
        try {
          const items = workspaces?.list?.getSnapshot?.()?.items ?? [];
          const workspace = items.find((item) => item.workspaceId === workspaceId);
          const path = workspace?.path;
          if (typeof path !== 'string' || path === '') {
            console.warn('[sidebar-ux] workspace path is unavailable', workspaceId, items.map((item) => [item.workspaceId, item.path]));
            notify('error', t('error.openWorkspace'));
            return;
          }
          const remote = ctx.remote;
          const sessionRemote = remote?.session;
          if (sessionRemote === undefined) {
            console.warn('[sidebar-ux] the session Remote is unavailable');
            notify('error', t('error.openWorkspace'));
            return;
          }
          const can = await sessionRemote.canOpenWorkspacePath();
          if (can?.ok !== true || can.value !== true) {
            console.warn('[sidebar-ux] opening Host paths is not available here', can);
            notify('error', t('error.openWorkspace'));
            return;
          }
          const result = await sessionRemote.openWorkspacePath({ path });
          if (result?.ok !== true) {
            console.warn('[sidebar-ux] openWorkspacePath failed', result?.error);
            notify('error', t('error.openWorkspace'));
          }
        } catch (error) {
          console.warn('[sidebar-ux] openWorkspacePath failed', error);
          notify('error', t('error.openWorkspace'));
        }
      }

      /**
       * Clone one shipped menu row into our extra workspace action. Markup and
       * classes are copied from the live menu so the host keeps owning the look;
       * only the label, icon, and click handler are ours.
       * @param sample - a shipped item wrapper inside the open menu.
       * @param icon - folder glyph to show.
       * @param onActivate - click handler.
       * @returns cloned wrapper, or null when the sample has no button.
       */
      function buildWorkspaceMenuRow(sample, icon, onActivate) {
        const wrap = sample.cloneNode(true);
        wrap.setAttribute(ITEM_MARK, '');
        for (const subtree of wrap.querySelectorAll('[data-slot]')) subtree.removeAttribute('data-slot');
        const button = wrap.querySelector('button[role="menuitem"]') ?? wrap.querySelector('button');
        if (button === null) return null;
        for (const name of ['aria-keyshortcuts', 'aria-haspopup', 'aria-expanded', 'disabled']) {
          button.removeAttribute(name);
        }
        for (const className of [...button.classList]) {
          if (/danger/iu.test(className)) button.classList.remove(className);
        }
        const shortcut = wrap.querySelector('[class*="shortcut"]');
        if (shortcut !== null) shortcut.remove();
        const label = wrap.querySelector('[class*="itemLabel"]');
        if (label !== null) label.textContent = t('menu.openInExplorer');
        const iconHost = wrap.querySelector('[class*="itemIcon"]');
        if (iconHost !== null) iconHost.innerHTML = icon;
        button.addEventListener(
          'click',
          (event) => {
            event.preventDefault();
            event.stopPropagation();
            const menu = wrap.closest(MENU);
            if (menu !== null) closeMenu(menu);
            onActivate();
          },
          true,
        );
        return wrap;
      }

      /**
       * Insert (or re-insert) our row into one open menu, before the dangerous
       * shipped item when there is one.
       * @param menu - open `[role="menu"]`.
       * @param row - built row wrapper.
       * @returns undefined.
       */
      function placeMenuRow(menu, row) {
        const viewport = menu.querySelector(ITEM_VIEWPORT) ?? menu;
        const existing = viewport.querySelector(`[${ITEM_MARK}]`);
        if (existing !== null) existing.remove();
        const danger = [...viewport.children].find(
          (child) => child.querySelector?.('[class*="danger"]') != null,
        );
        if (danger !== undefined) viewport.insertBefore(row, danger);
        else viewport.appendChild(row);
      }

      /**
       * Watch a freshly opened workspace menu: append the extra row once it
       * exists, keep it present across React re-renders, and clean up when the
       * menu closes or the plugin unloads.
       * @param workspaceId - workspace whose path the row opens.
       * @param icon - folder glyph captured from the workspace row.
       * @returns undefined.
       */
      function watchWorkspaceMenu(workspaceId, icon) {
        const startedAt = Date.now();
        let row = null;
        let observer = null;
        let timer = null;
        const stop = () => {
          if (timer !== null) window.clearInterval(timer);
          if (observer !== null) observer.disconnect();
          row?.remove();
          watchers.delete(stop);
        };
        const attach = (menu) => {
          const sample = menu.querySelector(ITEM_WRAP);
          if (sample === null) return false;
          row = buildWorkspaceMenuRow(sample, icon, () => {
            void openWorkspaceInExplorer(workspaceId);
          });
          if (row === null) return false;
          placeMenuRow(menu, row);
          observer = new MutationObserver(() => {
            if (!menu.isConnected) {
              stop();
              return;
            }
            if (row !== null && !row.isConnected) placeMenuRow(menu, row);
          });
          observer.observe(menu, { childList: true, subtree: true });
          return true;
        };
        timer = window.setInterval(() => {
          const menu = document.querySelector(MENU);
          if (menu === null) {
            if (row !== null || Date.now() - startedAt > 1500) stop();
            return;
          }
          if (row === null || !row.isConnected) attach(menu);
          if (Date.now() - startedAt > 30_000) stop();
        }, 30);
        watchers.add(stop);
      }

      /**
       * Capture-phase contextmenu: turn a right-click on a session or workspace
       * row into a click on that row's own "…" trigger, then (workspace rows)
       * add the file-manager row to the menu that opens.
       * @param event - contextmenu event.
       * @returns undefined.
       */
      function onContextMenu(event) {
        if (event.defaultPrevented) return;
        const target = event.target instanceof Element ? event.target : null;
        if (target === null) return;
        if (target.closest(MENU) !== null) return;
        const row = target.closest('[data-row-key]');
        if (row === null) return;
        const key = row.getAttribute('data-row-key') ?? '';
        if (key.startsWith('session:')) {
          const trigger = rowMenuTrigger(row);
          if (trigger === null) return;
          event.preventDefault();
          event.stopPropagation();
          clickTrigger(trigger);
          return;
        }
        if (key.startsWith('workspace:')) {
          const trigger = rowMenuTrigger(row);
          if (trigger === null) return;
          event.preventDefault();
          event.stopPropagation();
          const workspaceId = key.slice('workspace:'.length);
          const icon = row.querySelector('span[class*="folder"] svg')?.outerHTML ?? FALLBACK_FOLDER_ICON;
          clickTrigger(trigger);
          watchWorkspaceMenu(workspaceId, icon);
        }
      }

      /**
       * Bubble-phase dragstart: the shipped row handler has already written the
       * payload; record the gesture and widen `effectAllowed` from the row's
       * official `move` so a `copy` drop stays legal.
       * @param event - dragstart event.
       * @returns undefined.
       */
      function onDragStart(event) {
        dragEnded = true;
        dragging = null;
        const target = event.target instanceof Element ? event.target : null;
        if (target === null) return;
        let sessionId = null;
        const row = target.closest('[data-row-key]');
        const key = row?.getAttribute('data-row-key') ?? '';
        if (key.startsWith('session:')) sessionId = key.slice('session:'.length);
        else {
          const payload = event.dataTransfer?.getData('text/plain') ?? '';
          if (isPlausibleSessionId(payload)) sessionId = payload;
        }
        if (!isPlausibleSessionId(sessionId)) return;
        const summary = sessions?.list?.getSnapshot?.()?.byId?.[sessionId];
        const label = summary?.displayTitle ?? summary?.title ?? sessionId;
        dragging = { sessionId, label };
        dragEnded = false;
        console.debug('[sidebar-ux] drag armed', sessionId);
        if (event.dataTransfer !== undefined && event.dataTransfer !== null) {
          try {
            event.dataTransfer.effectAllowed = 'copyMove';
          } catch {
            /* older engines may refuse the write; the drop still works */
          }
        }
      }

      /**
       * The composer surface a drop belongs to.
       * @param target - dragover/drop target.
       * @returns composer element, or null.
       */
      function composerOf(target) {
        if (!(target instanceof Element)) return null;
        return target.closest(COMPOSER_CARD) ?? target.closest(COMPOSER_AREA);
      }

      /**
       * Capture-phase dragover: accept a session-row drag over the composer and
       * show the copy badge; every other drop keeps its shipped behaviour.
       * @param event - dragover event.
       * @returns undefined.
       */
      function onDragOver(event) {
        if (dragging === null || dragEnded) {
          clearHighlight();
          return;
        }
        const composer = composerOf(event.target);
        if (composer === null) {
          clearHighlight();
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        if (event.dataTransfer !== undefined && event.dataTransfer !== null) {
          try {
            event.dataTransfer.dropEffect = 'copy';
          } catch {
            /* the badge is cosmetic */
          }
        }
        if (highlighted !== composer) {
          clearHighlight();
          highlighted = composer;
          composer.classList.add(DROP_HIGHLIGHT);
        }
      }

      /**
       * Capture-phase drop: insert a real session-reference chip into the
       * composer draft through the input facade the "@" picker uses.
       * @param event - drop event.
       * @returns undefined.
       */
      function onDrop(event) {
        if (dragging === null || dragEnded) return;
        const composer = composerOf(event.target);
        if (composer === null) return;
        event.preventDefault();
        event.stopPropagation();
        const gesture = dragging;
        dragging = null;
        dragEnded = true;
        clearHighlight();
        console.debug('[sidebar-ux] drop accepted for', gesture.sessionId);
        const host = composer.closest(CONVERSATION_SESSION);
        const targetSessionId =
          host?.getAttribute('data-conversation-session') ??
          currentSessionIdOf(sessions?.list?.getSnapshot?.());
        if (targetSessionId === undefined || targetSessionId === null || targetSessionId === '') {
          notify('error', t('error.noComposer'));
          return;
        }
        if (targetSessionId === gesture.sessionId) {
          notify('info', t('info.self'));
          return;
        }
        const face = resolveFace(targetSessionId);
        if (face === null) {
          notify('error', t('error.noComposer'));
          return;
        }
        const mention = formatSessionMention(gesture.sessionId, gesture.label);
        const reference = {
          source: 'reference',
          ref: mention,
          label: gesture.label,
          appearance: 'session',
          clipboardText: mention,
        };
        const inserted = face.insertReference(reference, face.span());
        console.debug('[sidebar-ux] reference insert result', inserted);
        if (inserted !== true) {
          face.notify('error', t('error.insert'));
          return;
        }
        try {
          face.input.focus?.();
        } catch {
          /* focus is a nicety */
        }
      }

      /** Bubble-phase dragend: the gesture is over even if no drop fired. */
      function onDragEnd() {
        dragEnded = true;
        dragging = null;
        clearHighlight();
      }

      /** Clear the highlight when the pointer leaves the document mid-drag. */
      function onDragLeave(event) {
        if (event.relatedTarget === null) clearHighlight();
      }

      ctx.effect(() => {
        const style = document.createElement('style');
        style.dataset.plugin = NS;
        style.dataset.pluginCss = 'sidebar-ux/drop-target';
        style.textContent = `.${DROP_HIGHLIGHT}{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px;border-radius:var(--dsw-radius-md);}`;
        document.head.appendChild(style);
        return () => style.remove();
      }, 'sidebar-ux: styles');

      ctx.effect(() => {
        document.addEventListener('contextmenu', onContextMenu, true);
        document.addEventListener('dragstart', onDragStart);
        document.addEventListener('dragover', onDragOver, true);
        document.addEventListener('drop', onDrop, true);
        document.addEventListener('dragend', onDragEnd);
        document.addEventListener('dragleave', onDragLeave, true);
        return () => {
          document.removeEventListener('contextmenu', onContextMenu, true);
          document.removeEventListener('dragstart', onDragStart);
          document.removeEventListener('dragover', onDragOver, true);
          document.removeEventListener('drop', onDrop, true);
          document.removeEventListener('dragend', onDragEnd);
          document.removeEventListener('dragleave', onDragLeave, true);
          for (const stop of [...watchers]) stop();
          clearHighlight();
        };
      }, 'sidebar-ux: document listeners');
    }

    return {
      inject: ['sessions', 'conversation', 'locale', 'workspaces', 'remote', 'remote.session'],
      apply,
      __internals: {
        encodeSessionUri,
        escapeLabel,
        formatSessionMention,
        isPlausibleSessionId,
        currentSessionIdOf,
        rowMenuTrigger,
      },
    };
  },
});
