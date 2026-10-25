window.__ModuleLoader__.load({
  id: 'dsh-unlag',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const zh = /^zh/i.test(navigator.language || '');
    const COPY = zh
      ? { label: '解除卡顿', hint: '卡顿时用：换掉插件代码并重建界面；运行中的任务、排队的消息保留', blocked: '暂时无法重建界面，稍后再试', unsaved: '有未保存的改动，先保存再重试', dialog: '先关闭打开的窗口再重载', queued: '更新已排队，稍后再按一次', applying: '还在应用这次更新，稍后再按一次', off: '两个开关都关着，先在设置里打开一个', replaced: '插件代码已更新，页面保持不动', done: '插件代码已是最新', restart: '这次改动要重新打开应用才会生效', failed: '插件更新没完成，稍后再按一次' } // ui-copy-ignore
      : { label: 'Unlag', hint: 'For a sluggish interface: replaces plugin code and rebuilds the page; running turns and queued messages are kept', blocked: 'Cannot rebuild the page right now; try again', unsaved: 'Unsaved changes; save them, then retry', dialog: 'Close the open window first', queued: 'Update queued; press again shortly', applying: 'Still applying this update; press again shortly', off: 'Both switches are off; turn one on in settings', replaced: 'Plugin code updated; the page stayed as it is', done: 'Plugin code is already up to date', restart: 'This change needs the app reopened before it can apply', failed: 'The plugin update did not finish; press again later' };

    /**
     * Why the interface was left as it is, in words a person can act on. The checks below record
     * the first reason they refuse for, so a press that stops can say what it saw instead of
     * repeating one generic sentence.
     */
    const REASONS = zh
      ? { list: '读不到启动信息', row: '启动信息不完整', src: '启动脚本没有地址', graph: '已装插件清单读不到', plugin: '有插件已不在运行', script: '启动脚本读不到', empty: '启动脚本是空的', covers: '启动脚本缺插件', parse: '启动脚本内容不完整', verify: '插件后端没有应答' }
      : { list: 'startup info is unavailable', row: 'startup info is incomplete', src: 'a startup script has no address', graph: 'the plugin list cannot be read', plugin: 'a plugin is no longer running', script: 'a startup script cannot be read', empty: 'a startup script is empty', covers: 'a startup script misses a plugin', parse: 'a startup script is incomplete', verify: 'the plugin is not answering' };

    /** The last reason a readiness check refused for, or null after a check that passed. */
    let holdReason = null;

    /** Record why a rebuild is held and answer false for the check that asked. */
    function held(reason) {
      holdReason = reason;
      return false;
    }

    /**
     * The notice for one copy key, naming the reason when a readiness check stopped the press.
     * A press that already replaced the plugins did its work even when the page was left alone, and
     * is said so: the update is live either way, and only the new document was skipped.
     */
    function noticeFor(key, applied = false) {
      // The plugin half already went live; whatever held the page is said on top of that.
      if (applied && key !== 'blocked') {
        return zh ? `插件已更新，页面未重开：${COPY[key]}。` : `Plugins updated; the page stayed: ${COPY[key]}.`;
      }
      if (key !== 'blocked' || holdReason === null) return COPY[key];
      const why = REASONS[holdReason] ?? REASONS.list;
      if (applied) return zh ? `插件已更新，页面未重开：${why}。` : `Plugins updated; the page stayed: ${why}.`;
      return zh ? `暂时无法重建：${why}。` : `Cannot rebuild yet: ${why}.`;
    }

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

    /** What this document remembers about its last press, so two presses cannot overlap. */
    const STAMP_KEY = 'dsh-unlag:at'; // ui-copy-ignore
    let pressInFlight = false;

    /**
     * Session storage is denied in some profiles and full in others. A press must not be lost to
     * that: the stamp only paces repeated presses, so an unreadable stamp reads as "no press yet".
     */
    function stampRead() {
      try {
        const at = Number(window.sessionStorage.getItem(STAMP_KEY) ?? 0);
        return Number.isFinite(at) ? at : 0;
      } catch {
        return 0;
      }
    }

    function stampWrite() {
      try {
        window.sessionStorage.setItem(STAMP_KEY, String(Date.now()));
      } catch {
        // Pacing is the only thing this stamp feeds; a denied store costs nothing else.
      }
    }

    /**
     * One bound for every call a press makes: a stalled answer ends the press with a notice
     * instead of holding the button until the page is reloaded by hand.
     */
    const HOST_TIMEOUT_MS = 12000; // ui-copy-ignore
    function withTimeout(promise, ms = HOST_TIMEOUT_MS) {
      let id = null;
      const timer = new Promise((_resolve, reject) => {
        id = setTimeout(() => reject(new Error('timeout')), ms); // ui-copy-ignore
      });
      return Promise.race([promise, timer]).finally(() => clearTimeout(id));
    }

    /**
     * What a press does is decided by the plugin's settings row, read from the running app, so
     * neither half assumes the other one is wanted. An app that does not answer leaves the press
     * doing what it did before: rebuild the interface.
     */
    const HOST_BASE = '/dsh-unlag'; // ui-copy-ignore

    async function readSettings() {
      try {
        const response = await withTimeout(fetch(`${HOST_BASE}/state`, { cache: 'no-store', credentials: 'same-origin' }));
        if (!response.ok) return null;
        const data = await withTimeout(response.json());
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
    function report(event, gate, attempt = 0) {
      const page = String(window?.__DSH_BOOT__?.rev ?? '').replace(/[^a-z0-9]/gu, '').slice(0, 24);
      const named = gate === undefined ? `event=${event}` : `event=${event}&gate=${encodeURIComponent(gate)}`;
      const query = page === '' ? named : `${named}&rev=${page}`;
      /**
       * The route belongs to the instance this press is replacing. Its answer can land while the old
       * one is gone and the new one is not listening yet, and a lost line is a press nobody can
       * account for later. Two more tries cost nothing and keep the record.
       */
      const again = () => {
        if (attempt >= 2) return;
        setTimeout(() => report(event, gate, attempt + 1), attempt === 0 ? 300 : 900);
      };
      try {
        fetch(`${HOST_BASE}/report?${query}`, {
          method: 'POST', // ui-copy-ignore
          credentials: 'same-origin',
          headers: { 'x-dsh-unlag': '1' }, // ui-copy-ignore
          keepalive: true, // ui-copy-ignore
        })
          .then((response) => {
            if (!response?.ok) again();
          })
          .catch(again);
      } catch {
        again();
      }
    }

    /** Ask the running app to replace changed plugins now; a running turn is reported, never cut. */
    async function replacePlugins() {
      try {
        const response = await withTimeout(fetch(`${HOST_BASE}/reload`, {
          method: 'POST', // ui-copy-ignore
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json', 'x-dsh-unlag': '1' }, // ui-copy-ignore
          body: '{}', // ui-copy-ignore
        }));
        if (!response.ok) return 'failed';
        const data = await withTimeout(response.json());
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
      // A plugin that did not start makes the set unusable for a rebuild, whatever the status says.
      if (Array.isArray(data.failedEntries) && data.failedEntries.length > 0) return 'failed';
      // `pending` is not a queued update: the changed modules need a restart to load at all.
      if (Array.isArray(data.pending) && data.pending.length > 0) return 'restart';
      if (typeof data.restartReason === 'string' && data.restartReason !== '') return 'failed';
      return status;
    }

    /** The plugin ids one startup bundle covers, read from its `??<id>/client.js,…` list. */
    function bundledIds(url) {
      const match = /\?\?([^&]+)/.exec(url);
      if (match === null) return [];
      const ids = [];
      for (const part of match[1].split(',')) {
        let decoded = part;
        try {
          decoded = decodeURIComponent(part);
        } catch {
          decoded = part;
        }
        decoded = decoded.replace(/\/client\.js.*$/u, '');
        if (decoded !== '') ids.push(decoded);
      }
      return ids;
    }

    /**
     * Ask the running app whether the scripts the next document would run can start it. The page has no
     * parser that agrees with a script tag, and compiling a candidate body here would execute the
     * plugin inside the page that carries the turn, so the verdict is the app's real parse bound to
     * the bytes it read.
     * @returns 'ok' | 'blocked'
     */
    async function hostVerifyStartup(scripts) {
      let response;
      try {
        response = await withTimeout(fetch(`${HOST_BASE}/verify`, {
          method: 'POST', // ui-copy-ignore
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json', 'x-dsh-unlag': '1' }, // ui-copy-ignore
          body: JSON.stringify({ rows: scripts }), // ui-copy-ignore
        }));
      } catch {
        held('verify');
        return 'blocked';
      }
      if (!response.ok) {
        held('verify');
        return 'blocked';
      }
      let data = null;
      try {
        data = await withTimeout(response.json());
      } catch {
        data = null;
      }
      if (data !== null && typeof data === 'object' && data.status === 'ok') {
        holdReason = null;
        return 'ok';
      }
      const reason = data !== null && typeof data === 'object' && typeof data.reason === 'string' ? data.reason : 'list';
      held(VERIFY_GATES[reason] ?? 'list');
      return 'blocked';
    }

    // What the app's refusal means to the person pressing: the same gates the checks above use.
    const VERIFY_GATES = {
      empty: 'empty', // ui-copy-ignore
      missing: 'script', // ui-copy-ignore
      network: 'script', // ui-copy-ignore
      parse: 'parse', // ui-copy-ignore
      register: 'plugin', // ui-copy-ignore
      dependencies: 'covers',
      list: 'list', // ui-copy-ignore
    };

    /** Read every bundle the next boot would load and prove each listed plugin is inside. */
    async function bundlesCoverStartup(graph) {
      if (graph === null || typeof graph !== 'object') return held('graph');
      const entries = Array.isArray(graph.entries) ? graph.entries : [];
      const batches = Array.isArray(graph.batches) ? graph.batches : [];
      if (entries.length === 0 || batches.length === 0) return held('graph');
      const covered = new Set();
      const sources = [];
      for (const batch of batches) {
        const url = typeof batch?.url === 'string' ? batch.url : '';
        if (url === '') continue;
        const listed = Array.isArray(batch.entries) && batch.entries.every((id) => typeof id === 'string') ? batch.entries : [];
        const ids = listed.length > 0 ? listed : bundledIds(url);
        if (ids.length === 0) return held('row');
        let resolved = null;
        try {
          resolved = new URL(url, location.href);
        } catch {
          return held('row');
        }
        for (const id of ids) covered.add(id);
        sources.push({ url: resolved, ids });
      }
      if (sources.length === 0) return held('graph');
      for (const entry of entries) {
        const id = typeof entry === 'string' ? entry : entry?.id;
        if (typeof id !== 'string' || !covered.has(id)) return held('covers');
      }
      // Reading these bodies here would need a parser the page does not have and would not prove
      // what the new document registers; the app compiles the same bytes with the real parser.
      const verdict = await hostVerifyStartup(sources.map((source) => source.url.toString()));
      if (verdict !== 'ok') return false;
      holdReason = null;
      return true;
    }

    // Every row kind a document boot understands; an unknown one ends the document.
    const STARTUP_ROW_KINDS = new Set(['global', 'script', 'script-src', 'script-preload', 'style', 'html']);

    /** Whether this document is owned by the desktop shell, whose saved list decides a boot. */
    function desktopShellPresent() {
      const bridge = window.dshDesktopBoot;
      return bridge !== undefined && bridge !== null && typeof bridge.ready === 'function';
    }

    /**
     * The startup list the desktop shell hands the next document, exactly as it hands it. The
     * shell reads that list once when the app starts and replays the same copy for every document
     * after that, so this is the only way to see what a rebuild would really boot from.
     * @returns the list rows, or null when this page is not running inside the desktop shell.
     */
    async function desktopStartupPayload() {
      const bridge = window.dshDesktopBoot;
      if (bridge === undefined || bridge === null || typeof bridge.ready !== 'function') return null;
      try {
        const payload = await withTimeout(bridge.ready(), 8000);
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
        if (typeof row.kind !== 'string' || !STARTUP_ROW_KINDS.has(row.kind)) return held('row');
        // Only the rows a document runs as scripts have to load as classic scripts. Style and
        // markup rows carry their own text and their address is not a script at all, so reading
        // them back would refuse a sound list over a false alarm.
        const runs = row.kind === 'script-src' || row.kind === 'script-preload';
        if (runs && (typeof row.src !== 'string' || row.src === '')) return held('src');
        if (runs) scripts.push(row.src);
        // Inline rows carry their own text and are not fetched; the queue script among them ends
        // in a nested return that a flat scan would misread, so their text is left to the document.
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
      if (scripts.length === 0) return held('list');
      // The graph is read twice: one answer taken while the app re-composes says nothing about
      // the next boot, and holding the page is the safe answer when it cannot be read at all.
      let live = await hostBootGraph();
      if (live === null && frozen !== null) {
        await new Promise((resolve) => setTimeout(resolve, 300)); // ui-copy-ignore
        live = await hostBootGraph();
      }
      if (frozen !== null) {
        // The frozen list decides what this document boots. Without the current plugin list there
        // is nothing to prove every plugin in it still exists, so the page is not rebuilt.
        if (live === null) return held('graph');
        const kept = Array.isArray(frozen.entries) ? frozen.entries : [];
        const liveIds = new Set((Array.isArray(live.entries) ? live.entries : []).map((entry) => (typeof entry === 'string' ? entry : entry?.id)));
        for (const entry of kept) {
          const id = typeof entry === 'string' ? entry : entry?.id;
          if (typeof id === 'string' && id !== '' && !liveIds.has(id)) return held('plugin');
        }
      }
      const verdict = await hostVerifyStartup(scripts);
      if (verdict !== 'ok') return false;
      holdReason = null;
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
        const response = await withTimeout(fetch(`${HOST_BASE}/graph`, { cache: 'no-store', credentials: 'same-origin' }));
        if (!response.ok) return null;
        const data = await withTimeout(response.json());
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
        const response = await withTimeout(fetch(location.href, { cache: 'no-store', credentials: 'same-origin' }));
        if (!response.ok) return null;
        return graphFromHtml(await withTimeout(response.text()));
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
      holdReason = null;
      // Two repeats: the app re-composes its bundles while it starts and after a plugin swap, and
      // a list read in the middle of that can answer for a generation that is already gone.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const saved = await desktopStartupPayload();
        // The desktop shell replays one startup list for every document. If it is running but its
        // copy cannot be read, nothing here proves a new document would boot, so the page stays.
        if (saved === null && desktopShellPresent()) {
          held('list');
        } else {
          const servable =
            saved === null
              ? await bundlesCoverStartup((await servedBootGraph()) ?? window.__DSH_BOOT__)
              : await frozenStartupLooksServable(saved);
          if (servable) return true;
        }
        if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 300 + attempt * 300)); // ui-copy-ignore
      }
      if (holdReason === null) held('list');
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
      // One frame lets the field write what it holds. A page that is not painting (a background
      // window, a dropped frame) never answers a frame request, so the wait is also bounded.
      await new Promise((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          resolve();
        };
        try {
          requestAnimationFrame(finish);
        } catch {
          finish();
        }
        setTimeout(finish, 250); // ui-copy-ignore
      });
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
      return probe.defaultPrevented === true || probe.returnValue === false;
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
        if (pending || pressInFlight) return;
        // A press the page already answered is not answered twice. Saying so beats a dead button.
        if (Date.now() - stampRead() < 3000) { // ui-copy-ignore
          setNotice(COPY.applying);
          return;
        }
        pressInFlight = true;
        setPending(true);
        setNotice(null);
        let navigated = false;
        const stop = (key, applied = false) => {
          setPending(false);
          setNotice(noticeFor(key, applied));
        };
        try {
          const settings = await readSettings();
          const replace = settings === null ? false : settings.plugins;
          const rebuild = settings === null ? true : settings.page;
          let replaced = false;
          // Nothing is switched on: the press says so instead of looking broken.
          if (!replace && !rebuild) {
            report('off');
            return stop('off');
          }
          // Replace first: a plugin that only changed the interface is then covered by the rebuild.
          // A replacement that did not finish stops the press here: rebuilding the page anyway would
          // start a document against a plugin set the app has not finished applying.
          if (replace) {
            /**
             * The answer to a replacement can be lost while the set is being recomposed, which reads
             * as a failure even though the plugins did change. The startup list says which set is
             * serving now, so a lost answer is checked against it before the press claims to fail.
             */
            const before = await hostBootGraph();
            const revBefore = typeof before?.rev === 'string' ? before.rev : null;
            let status = await withTimeout(replacePlugins()).catch(() => 'failed');
            if (status === 'failed' && revBefore !== null) {
              for (const wait of [400, 900, 1800]) { // ui-copy-ignore
                await new Promise((resolve) => setTimeout(resolve, wait));
                const after = await hostBootGraph();
                const revNow = typeof after?.rev === 'string' ? after.rev : null;
                if (revNow !== null && revNow !== revBefore) {
                  status = 'done';
                  break;
                }
              }
            }
            if (status !== 'done' && status !== 'off') {
              const key =
                status === 'queued'
                  ? 'queued'
                  : status === 'applying'
                    ? 'applying'
                    : status === 'restart'
                      ? 'restart'
                      : status === 'unavailable'
                        ? 'blocked'
                        : 'failed';
              report('plugin-held', key);
              return stop(key);
            }
            replaced = status === 'done';
          }
          if (!rebuild) {
            // The plugin half is on and the page half is off: what the press did is worth saying.
            report('replaced');
            return stop(replaced ? 'replaced' : 'done');
          }
          stampWrite();
          const reason = await prepareInterface();
          if (reason !== null) {
            // The log keeps the exact check that refused, so a held press can be explained later.
            const gate = reason === 'blocked' && holdReason !== null ? `blocked:${holdReason}` : reason;
            report('held', replaced ? `applied:${gate}` : gate);
            return stop(reason, replaced);
          }
          report('rebuild');
          navigated = true;
          reloadFreshPage();
          return undefined;
        } catch (error) {
          report('failed', 'press');
          stop('failed');
          return undefined;
        } finally {
          pressInFlight = false;
          // The document goes away on a rebuild, so the button only needs re-enabling when it does not.
          if (!navigated) setPending(false);
          else {
            setTimeout(() => {
              // Still here after asking for a rebuild: the page held the navigation. Say what
              // happened and take the press back, so the button is never left unresponsive.
              report('held', 'navigation');
              setPending(false);
              setNotice(noticeFor('replaced'));
            }, 6000); // ui-copy-ignore
          }
        }
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
      startupHoldReason: () => holdReason,
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
