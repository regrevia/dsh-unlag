window.__ModuleLoader__.load({
  id: 'dsh-unlag',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const zh = /^zh/i.test(navigator.language || '');
    const COPY = zh
      ? { label: '解除卡顿', hint: '卡顿时用：换掉插件代码并重建界面；运行中的任务、排队的消息保留', blocked: '暂时无法重建界面，稍后再试', unsaved: '有未保存的改动，先保存再重试', dialog: '先关闭打开的窗口再重载', queued: '已排队：任务跑完自动重载', failed: '插件更新没完成，稍后再按一次' } // ui-copy-ignore
      : { label: 'Unlag', hint: 'For a sluggish interface: replaces plugin code and rebuilds the page; running turns and queued messages are kept', blocked: 'Cannot rebuild the page right now; try again', unsaved: 'Unsaved changes; save them, then retry', dialog: 'Close the open window first', queued: 'Queued; it reloads once the turn ends', failed: 'The plugin update did not finish; press again later' };

    // Desktop shell only: the macOS and Windows desktop build owns the page and the running
    // app, so this is where the button belongs. A browser tab can reload freely on its own.
    const desktop = /Electron\//.test(navigator.userAgent || '');

    /**
     * Announced before the interface is rebuilt. Any plugin holding state that a rebuild would
     * drop can listen, save synchronously, or add a promise to `detail.pending`; calling
     * `preventDefault()` keeps the interface as it is. Nothing here is required to know about
     * this plugin, and no plugin is required to answer.
     */
    const PREPARE_EVENT = 'dsh-unlag:before';

    /** Set while a rebuild is pending, so a repeated click cannot start a second one. */
    const STAMP_KEY = 'dsh-unlag:at'; // ui-copy-ignore

    /**
     * What a press does is decided by the plugin's settings row, read from the running app, so
     * neither half assumes the other one is wanted. An app that does not answer leaves the press
     * doing what it did before: rebuild the interface.
     */
    const HOST_BASE = '/dsh-unlag'; // ui-copy-ignore

    async function readSettings() {
      try {
        const response = await fetch(`${HOST_BASE}/state`, { cache: 'no-store', credentials: 'same-origin' });
        if (!response.ok) return null;
        const data = await response.json();
        if (data === null || typeof data !== 'object') return null;
        return { plugins: data.plugins !== false, page: data.page !== false };
      } catch {
        return null;
      }
    }

    /**
     * Leave one line per press outcome in the log the app keeps. Without it a press that stopped
     * before rebuilding looks exactly like one that never happened, and the page itself is gone by
     * the time anyone reads it.
     */
    function report(event, gate) {
      const query = gate === undefined ? `event=${event}` : `event=${event}&gate=${encodeURIComponent(gate)}`;
      try {
        fetch(`${HOST_BASE}/report?${query}`, {
          method: 'POST', // ui-copy-ignore
          credentials: 'same-origin',
          headers: { 'x-dsh-unlag': '1' }, // ui-copy-ignore
          keepalive: true, // ui-copy-ignore
        }).catch(() => {});
      } catch {}
    }

    /** Ask the running app to replace changed plugins now; a running turn is reported, never cut. */
    async function replacePlugins() {
      try {
        const response = await fetch(`${HOST_BASE}/reload`, {
          method: 'POST', // ui-copy-ignore
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json', 'x-dsh-unlag': '1' }, // ui-copy-ignore
          body: '{}', // ui-copy-ignore
        });
        if (!response.ok) return 'failed';
        const data = await response.json();
        return reloadVerdict(data);
      } catch {
        return 'failed';
      }
    }

    /**
     * What the app's answer to a plugin replacement really means for the rebuild that follows.
     * Only a set the app has finished starting can be rebuilt against: one still starting would
     * boot a document over plugins that are not ready, and one the app says cannot be applied to a
     * running page would boot the old code behind a fresh interface.
     * @returns 'done' | 'off' | 'queued' | 'unavailable' | 'failed'
     */
    function reloadVerdict(data) {
      if (data === null || typeof data !== 'object') return 'failed';
      const status = typeof data.status === 'string' ? data.status : 'failed';
      if (Array.isArray(data.pending) && data.pending.length > 0) return 'queued';
      if (typeof data.restartReason === 'string' && data.restartReason !== '') return 'failed';
      return status;
    }

    /** The plugin ids one startup bundle covers, read from its `??<id>/client.js,…` list. */
    function bundledIds(url) {
      const match = /\?\?([^&]+)/.exec(url);
      if (match === null) return [];
      return match[1].split(',').map((part) => decodeURIComponent(part).replace(/\/client\.js.*$/u, '')).filter((id) => id !== '');
    }

    /** Read every bundle the next boot would load and prove each listed plugin is inside. */
    async function bundlesCoverStartup(graph) {
      if (graph === null || typeof graph !== 'object') return false;
      const entries = Array.isArray(graph.entries) ? graph.entries : [];
      const batches = Array.isArray(graph.batches) ? graph.batches : [];
      if (entries.length === 0 || batches.length === 0) return false;
      const covered = new Set();
      const sources = [];
      for (const batch of batches) {
        const url = typeof batch?.url === 'string' ? batch.url : '';
        if (url === '') continue;
        const listed = Array.isArray(batch.entries) && batch.entries.every((id) => typeof id === 'string') ? batch.entries : [];
        const ids = listed.length > 0 ? listed : bundledIds(url);
        if (ids.length === 0) return false;
        for (const id of ids) covered.add(id);
        sources.push({ url: new URL(url, location.href), ids });
      }
      if (sources.length === 0) return false;
      for (const entry of entries) {
        const id = typeof entry === 'string' ? entry : entry?.id;
        if (typeof id !== 'string' || !covered.has(id)) return false;
      }
      for (const source of sources) {
        try {
          const response = await fetch(source.url.toString(), { cache: 'no-store', credentials: 'same-origin' });
          if (!response.ok) return false;
          const body = await response.text();
          if (body.length === 0) return false;
          for (const id of source.ids) {
            if (!body.includes(id)) return false;
          }
          if (!parsesAsClassicScript(body)) return false;
        } catch {
          return false;
        }
      }
      return true;
    }

    // Every row kind a document boot understands; an unknown one ends the document.
    const STARTUP_ROW_KINDS = new Set(['global', 'script', 'script-src', 'script-preload', 'style', 'html']);

    /**
     * Whether a script body parses the way the document will parse it: as a classic script. A body
     * that needs module syntax never runs, so the document that loads it fails to boot and the
     * desktop shell ends. Compiling runs nothing, so nothing here has a side effect; a page that
     * forbids compiling strings cannot answer, and then the checks already done stand.
     * @param body - the served script.
     * @returns true when the body parses, or when this page cannot compile one at all.
     */
    function parsesAsClassicScript(body) {
      try {
        new Function(body); // eslint-disable-line no-new-func
        return true;
      } catch (error) {
        const text = String(error?.message ?? error);
        if (/unsafe-eval|Content Security Policy/iu.test(text)) return true;
        return false;
      }
    }

    /**
     * The startup list the desktop shell hands the next document, exactly as it hands it. The
     * shell reads that list once when the app starts and replays the same copy for every document
     * after that, so this is the only way to see what a rebuild would really boot from.
     * @returns the list rows, or null when this page is not running inside the desktop shell.
     */
    /** Whether this document is owned by the desktop shell, whose saved list decides a boot. */
    function desktopShellPresent() {
      const bridge = window.dshDesktopBoot;
      return bridge !== undefined && bridge !== null && typeof bridge.ready === 'function';
    }

    async function desktopStartupPayload() {
      const bridge = window.dshDesktopBoot;
      if (bridge === undefined || bridge === null || typeof bridge.ready !== 'function') return null;
      try {
        const payload = await bridge.ready();
        const rows = Array.isArray(payload?.injections) ? payload.injections : [];
        return rows.length === 0 ? null : rows;
      } catch {
        return null;
      }
    }

    /**
     * Whether a document booting from the desktop shell's saved startup list would come up. Every
     * script in that list is read back from where the document would load it, and every plugin it
     * lists must still be one the running app serves: a missing script ends the desktop app, which
     * would take every running turn with it, so this is answered before anything navigates.
     * @param rows - the saved startup list.
     * @returns true when each saved script loads and still contains its plugins.
     */
    async function frozenStartupLooksServable(rows) {
      const scripts = [];
      let frozen = null;
      for (const row of rows) {
        if (row === null || typeof row !== 'object') continue;
        if (typeof row.kind !== 'string' || !STARTUP_ROW_KINDS.has(row.kind)) return false;
        if (row.kind === 'script-src' && (typeof row.src !== 'string' || row.src === '')) return false;
        if (typeof row.src === 'string' && row.src !== '') scripts.push(row.src);
        if (row.kind !== 'global' || row.name !== '__DSH_BOOT__') continue; // ui-copy-ignore
        let value = row.value;
        if (typeof value === 'string') {
          try {
            value = JSON.parse(value);
          } catch {
            value = null;
          }
        }
        if (value !== null && typeof value === 'object') frozen = value;
      }
      if (scripts.length === 0) return false;
      const live = await hostBootGraph();
      if (live !== null && frozen !== null) {
        const liveIds = new Set((Array.isArray(live.entries) ? live.entries : []).map((entry) => (typeof entry === 'string' ? entry : entry?.id)));
        const kept = Array.isArray(frozen.entries) ? frozen.entries : [];
        for (const entry of kept) {
          const id = typeof entry === 'string' ? entry : entry?.id;
          if (typeof id === 'string' && id !== '' && !liveIds.has(id)) return false;
        }
      }
      for (const src of scripts) {
        let target;
        try {
          target = new URL(src, location.href).toString();
        } catch {
          return false;
        }
        try {
          const response = await fetch(target, { cache: 'no-store', credentials: 'same-origin' });
          if (!response.ok) return false;
          const body = await response.text();
          if (body.length === 0) return false;
          for (const id of bundledIds(target)) {
            if (!body.includes(id)) return false;
          }
          if (!parsesAsClassicScript(body)) return false;
        } catch {
          return false;
        }
      }
      return true;
    }

    /** The first balanced JSON object after `__DSH_BOOT__` in a served document. */
    function graphFromHtml(html) {
      const at = html.indexOf('__DSH_BOOT__'); // ui-copy-ignore
      if (at < 0) return null;
      const start = html.indexOf('{', at);
      if (start < 0) return null;
      let depth = 0;
      let quoted = false;
      let escaped = false;
      for (let index = start; index < html.length; index += 1) {
        const ch = html[index];
        if (quoted) {
          if (escaped) escaped = false;
          else if (ch === '\\') escaped = true;
          else if (ch === '"') quoted = false;
          continue;
        }
        if (ch === '"') quoted = true;
        else if (ch === '{') depth += 1;
        else if (ch === '}') {
          depth -= 1;
          if (depth === 0) {
            try {
              return JSON.parse(html.slice(start, index + 1));
            } catch {
              return null;
            }
          }
        }
      }
      return null;
    }

    /**
     * The startup list a rebuild would actually get. This page's own list is only true of the
     * page already running: a plugin swapped since then is listed there under its old module,
     * so asking it first would refuse a rebuild that is in fact safe.
     */
    /**
     * The startup list the next document would get, read from the running app. It renders that
     * list for every index response, so this is the same row the next boot reads, described by
     * the side that serves the bundles rather than by whatever this document happens to hold.
     */
    async function hostBootGraph() {
      try {
        const response = await fetch(`${HOST_BASE}/graph`, { cache: 'no-store', credentials: 'same-origin' });
        if (!response.ok) return null;
        const data = await response.json();
        const graph = data?.graph;
        return graph !== null && typeof graph === 'object' ? graph : null;
      } catch {
        return null;
      }
    }

    async function servedBootGraph() {
      const fromHost = await hostBootGraph();
      if (fromHost !== null) return fromHost;
      try {
        const response = await fetch(location.href, { cache: 'no-store', credentials: 'same-origin' });
        if (!response.ok) return null;
        return graphFromHtml(await response.text());
      } catch {
        return null;
      }
    }

    /**
     * Whether a rebuild can re-run the interface at all. A boot activates one module per plugin
     * in the startup list and stops the desktop app when any of them is missing, so a list row
     * whose module is absent from the bundles it points at would end the app and every running
     * turn along with it. Reading the bundles back proves each row still resolves before the
     * interface is rebuilt; one repeat covers a bundle swapped while the app was re-composing.
     * @returns true when every listed plugin's module is present in the served bundles.
     */
    async function startupLooksServable() {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const saved = await desktopStartupPayload();
        // The desktop shell replays one startup list for every document. If it is running but its
        // copy cannot be read, nothing here proves a new document would boot, so the page stays.
        if (saved === null && desktopShellPresent()) return false;
        const servable =
          saved === null
            ? await bundlesCoverStartup((await servedBootGraph()) ?? window.__DSH_BOOT__)
            : await frozenStartupLooksServable(saved);
        if (servable) return true;
        if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 300)); // ui-copy-ignore
      }
      return false;
    }

    /**
     * Whether the other plugins are ready for the rebuild: their saves run first, and a refusal
     * from any of them stops the rebuild instead of discarding work they still hold.
     */
    async function otherPluginsAreReady() {
      const detail = { pending: [] };
      const event = new CustomEvent(PREPARE_EVENT, { cancelable: true, detail });
      window.dispatchEvent(event);
      if (event.defaultPrevented) return false;
      const pending = Array.isArray(detail.pending) ? detail.pending.filter((item) => item !== null && typeof item?.then === 'function') : [];
      if (pending.length === 0) return true;
      const slow = Symbol('slow'); // ui-copy-ignore
      const settled = await Promise.race([
        Promise.allSettled(pending),
        new Promise((resolve) => setTimeout(() => resolve(slow), 1200)), // ui-copy-ignore
      ]);
      // A save that never settled in time is as uncommitted as one that rejected: the rebuild
      // would drop the work it still holds, so the page stays.
      if (settled === slow) return false;
      if (settled.some((entry) => entry.status === 'rejected')) return false;
      return event.defaultPrevented === false;
    }

    /**
     * Commit whatever the focused field holds. A field keeps the last keystrokes in its own
     * state until the next write, so blurring it and yielding one frame leaves the draft in the
     * session's stored input before the document goes away.
     */
    async function commitFocusedField() {
      const active = document.activeElement;
      if (active !== null && typeof active.blur === 'function') active.blur();
      await new Promise((resolve) => requestAnimationFrame(() => resolve()));
    }

    /** Re-enter the interface on a fresh document, keeping the current view in the address. */
    function reloadFreshPage() {
      const graph = window.__DSH_BOOT__;
      const stamp = typeof graph?.rev === 'string' && graph.rev !== '' ? graph.rev : String(Date.now());
      const target = new URL(location.href);
      target.searchParams.set('interface', stamp);
      window.location.replace(target.toString());
    }

    /** A window the user still has open would go away with the rebuild. */
    function screenHasOpenWindow() {
      return document.querySelector('[aria-modal="true"], dialog[open]') !== null; // ui-copy-ignore
    }

    /**
     * Whether anything still in the page would hold a navigation back. Asking the question without
     * navigating runs the very listeners a rebuild would run, so work that is not committed yet is
     * caught here rather than behind the leave-page prompt a navigation would raise.
     * @returns true when a listener refuses to leave the page.
     */
    function stillHeldBack() {
      const probe = new Event('beforeunload', { cancelable: true }); // ui-copy-ignore
      window.dispatchEvent(probe);
      return probe.defaultPrevented === true;
    }

    /**
     * The automatic judgement: every reason a rebuild would take something away is checked here,
     * in the order that costs the user least. A null answer means the interface can go.
     * @returns the copy key of the reason to stop, or null when a rebuild is safe.
     */
    async function prepareInterface() {
      if (!(await startupLooksServable())) return 'blocked';
      if (screenHasOpenWindow()) return 'dialog';
      await commitFocusedField();
      const ready = await otherPluginsAreReady();
      if (!ready || stillHeldBack()) return 'unsaved';
      return null;
    }

    const WRAP_STYLE = { position: 'relative', display: 'inline-flex', alignItems: 'center' };

    const BUTTON_STYLE = {
      display: 'inline-flex', // ui-copy-ignore
      alignItems: 'center',
      justifyContent: 'center',
      width: 28, // ui-copy-ignore
      height: 28, // ui-copy-ignore
      padding: 0, // ui-copy-ignore
      border: 'none', // ui-copy-ignore
      borderRadius: 6,
      background: 'transparent',
      color: 'inherit', // ui-copy-ignore
      cursor: 'pointer', // ui-copy-ignore
      opacity: 0.75, // ui-copy-ignore
    };

    const PILL_STYLE = {
      position: 'absolute', // ui-copy-ignore
      top: 30, // ui-copy-ignore
      right: 0, // ui-copy-ignore
      padding: '4px 8px', // ui-copy-ignore
      borderRadius: 6,
      border: '1px solid var(--dsh-color-border, rgba(127,127,127,0.28))',
      background: 'var(--dsh-color-surface, Canvas)',
      color: 'var(--dsh-color-text-secondary, inherit)',
      fontSize: 12, // ui-copy-ignore
      whiteSpace: 'nowrap', // ui-copy-ignore
    };

    function ReloadButton() {
      const [hover, setHover] = React.useState(false);
      const [pending, setPending] = React.useState(false);
      const [notice, setNotice] = React.useState(null);

      React.useEffect(() => {
        if (notice === null) return undefined;
        const timer = setTimeout(() => setNotice(null), 8000);
        return () => clearTimeout(timer);
      }, [notice]);

      const style = pending
        ? { ...BUTTON_STYLE, opacity: 0.4 }
        : hover
          ? { ...BUTTON_STYLE, opacity: 1, background: 'var(--dsh-color-surface-hover, rgba(127,127,127,0.14))' }
          : BUTTON_STYLE;

      const onClick = async () => {
        if (pending) return;
        const previous = Number(window.sessionStorage.getItem(STAMP_KEY) ?? 0);
        if (Number.isFinite(previous) && Date.now() - previous < 3000) return; // ui-copy-ignore
        setPending(true);
        setNotice(null);
        const stop = (key) => {
          setPending(false);
          setNotice(COPY[key]);
        };
        const settings = await readSettings();
        const replace = settings === null ? false : settings.plugins;
        const rebuild = settings === null ? true : settings.page;
        // Both switches off: a press does nothing at all.
        if (!replace && !rebuild) {
          setPending(false);
          return;
        }
        // Replace first: a plugin that only changed the interface is then covered by the rebuild.
        // A replacement that did not finish stops the press here: rebuilding the page anyway would
        // start a document against a plugin set the app has not finished applying.
        if (replace) {
          const status = await replacePlugins();
          if (status !== 'done' && status !== 'off') {
            const key = status === 'queued' ? 'queued' : status === 'unavailable' ? 'blocked' : 'failed';
            report('plugin-held', key);
            return stop(key);
          }
        }
        if (!rebuild) {
          setPending(false);
          return;
        }
        window.sessionStorage.setItem(STAMP_KEY, String(Date.now()));
        const reason = await prepareInterface();
        if (reason !== null) {
          report('held', reason);
          return stop(reason);
        }
        report('rebuild');
        reloadFreshPage();
        setTimeout(() => setPending(false), 4000); // ui-copy-ignore
      };

      return h('span', { style: WRAP_STYLE },
        h('button', {
          type: 'button', // ui-copy-ignore
          title: notice ?? COPY.hint, // ui-copy-ignore
          'aria-label': COPY.label,
          style,
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          onClick,
        }, h('svg', {
          viewBox: '0 0 16 16', // ui-copy-ignore
          width: 16, // ui-copy-ignore
          height: 16, // ui-copy-ignore
          fill: 'none', // ui-copy-ignore
          stroke: 'currentColor', // ui-copy-ignore
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        h('path', { d: 'M13 8a5 5 0 1 1-1.9-3.94' }),
        h('path', { d: 'M13 2.7v3.6H9.4' }))),
        notice === null ? null : h('span', { role: 'status', 'aria-live': 'polite', style: PILL_STYLE }, notice));
    }

    /**
     * The guard as the press asks it. Exposed only to a headless harness: the failure this plugin
     * must never cause is a navigation the saved startup list cannot survive, and that question is
     * worth asking without starting a desktop app.
     */
    const PROBE = {
      prepareInterface,
      startupLooksServable,
      frozenStartupLooksServable,
      desktopStartupPayload,
      desktopShellPresent,
      reloadVerdict,
      reloadFreshPage,
    };

    return {
      inject: ['slots'], // ui-copy-ignore
      ...(window.__DSH_UNLAG_PROBE__ === true ? { probe: PROBE } : {}), // ui-copy-ignore
      apply(ctx) {
        if (!desktop) return;
        // Leave a line in the log per rebuilt interface: it is the one place that shows which
        // plugin code a running page actually loaded.
        report('mounted');
        ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
          name: 'conversation.session.header.utilities',
          id: 'dsh-unlag', // ui-copy-ignore
          order: 29, // ui-copy-ignore
          label: () => COPY.label, // ui-copy-ignore
        }, ReloadButton));
      },
    };
  },
});
