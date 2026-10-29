window.__ModuleLoader__.load({
  id: 'dsh-unlag',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    // The app's own document language wins: it is what the surrounding interface speaks. A shell
    // still serving its default `lang="en"` has not synced it yet, and reading only the document
    // would leave a Chinese interface in English, so the browser's own order decides then.
    const detectZh = (documentLanguage, browserLanguage) => {
      const tag = typeof documentLanguage === 'string' ? documentLanguage : '';
      if (/^zh(-|$)/i.test(tag)) return true;
      if (tag !== '' && !/^en(-|$)/i.test(tag)) return false;
      const first = Array.isArray(browserLanguage) ? browserLanguage[0] : browserLanguage;
      return typeof first === 'string' && /^zh(-|$)/i.test(first);
    };
    const documentLanguage = typeof document !== 'undefined' ? document?.documentElement?.lang : '';
    const browserLanguage = typeof navigator !== 'undefined' ? navigator.languages || navigator.language : '';
    const zh = detectZh(documentLanguage, browserLanguage);
    const COPY = zh
      ? { label: '解除卡顿', hint: '卡顿时用：换掉插件代码并重建界面；运行中的任务、排队的消息保留', blocked: '暂时无法重建界面，稍后再试', unsaved: '有未保存的改动，先保存再重试', dialog: '先关闭打开的窗口再重载', queued: '更新已排队，稍后再按一次', applying: '还在应用这次更新，稍后再按一次', off: '两个开关都关着，先在设置里打开一个', replaced: '插件代码已更新，页面保持不动', stalled: '这次刷新没有回应，页面没有变，稍后再按一次', cannotLoad: '新页面没有准备好，页面保持不动，稍后再按一次', stayedReplaced: '插件代码已更新，页面没有重建；稍后再按一次', stayed: '页面没有重建；稍后再按一次', done: '插件代码已是最新', restart: '这次改动要重新打开应用才会生效', failed: '插件更新没完成，稍后再按一次', unconfirmed: '没读到插件状态，先不重建；稍后再按一次', attachments: '还有没发出去的附件，先发出去再按；再按一次会丢掉这些附件', unchecked: '这次没能确认新页面可用，再按一次仍会重建', quiet: '刚重建过，页面已经是新的，稍等再按', unsent: '有一条发送失败的消息还没回到输入框，先把这条重发再按', sending: '消息正在发送，请稍候' , mixed: '这次刷新会混用新旧插件代码，先重新打开应用', menu: '按下按钮时', switchPlugins: '换掉插件代码', switchPage: '重建页面', switchAgent: 'Agent 可以自己刷新', switchesFailed: '设置没改成，稍后再试', switchesUnsaved: '设置只在这次运行里有效', rawShow: '详情', rawHide: '收起'} // ui-copy-ignore
      : { label: 'Unlag', hint: 'For a sluggish interface: replaces plugin code and rebuilds the page; running turns and queued messages are kept', blocked: 'Cannot rebuild the page right now; try again', unsaved: 'Unsaved changes; save them, then retry', dialog: 'Close the open window first', queued: 'Update queued; press again shortly', applying: 'Still applying this update; press again shortly', off: 'Both switches are off; turn one on in settings', replaced: 'Plugin code updated; the page stayed as it is', stalled: 'No answer in time; the page stayed as it is; press again later', cannotLoad: 'The new page did not come up; this page stayed; press again later', stayedReplaced: 'Plugin code updated; the page did not rebuild; press again shortly', stayed: 'The page did not rebuild; press again shortly', done: 'Plugin code is already up to date', restart: 'This change needs the app reopened before it can apply', failed: 'The plugin update did not finish; press again later', unconfirmed: 'Plugin state could not be read, so the page stays; press again shortly', attachments: 'Files are attached but not sent; send them first, or press again to discard them', unchecked: 'The new page could not be confirmed this time; press again to rebuild anyway', quiet: 'Just rebuilt; the page is already the new one, give it a moment', unsent: 'A failed message is not back in the input yet; resend it first', sending: 'A message is being sent; wait for it to finish' , mixed: 'This rebuild would mix old and new plugin code; reopen the app first', menu: 'On press', switchPlugins: 'Replace plugin code', switchPage: 'Rebuild page', switchAgent: 'Agents may refresh on their own', switchesFailed: 'Settings not changed; try again later', switchesUnsaved: 'Settings apply to this run only', rawShow: 'Details', rawHide: 'Hide'};

    /**
     * Why the interface was left as it is, in words a person can act on. The checks below record
     * the first reason they refuse for, so a press that stops can say what it saw instead of
     * repeating one generic sentence.
     */
    /**
     * The one thing worth saying without a press: a window whose startup list names a script the
     * app can no longer serve runs without that plugin, and nothing on screen says so. The remedy
     * is the same as the frozen list's own refusal, so it is said in the same few words.
     */
    const BOOT_GAP_NOTICE = zh ? '缺插件，重启应用后恢复' : 'a plugin is missing, so reopen the app';

    const REASONS = zh
      ? { list: '读不到启动信息', slow: '启动信息读得太慢', row: '启动信息不完整', src: '启动脚本没有地址', graph: '已装插件清单读不到', plugin: '有插件已不在运行', script: '启动脚本读不到', empty: '启动脚本是空的', covers: '启动脚本缺插件', parse: '启动脚本内容不完整', size: '启动脚本太大', verify: '插件后端没有应答', screen: '页面状态读不到', busy: '另一次刷新还在进行', dependencies: '插件依赖还没有运行', missing: '启动清单里有插件已经不见了', network: '读取插件时出错', register: '插件没有登记自己', entries: '这样刷新会打不开页面，先重启应用', generation: '插件刚被换过，再按一次刷新', boot: '重启应用后用上新代码', url: '启动信息太长，读不全', mixed: '新页面会混用新旧插件代码，先重新打开应用' }
      : { list: 'startup info is unavailable', slow: 'the startup list answered too slowly', row: 'startup info is incomplete', src: 'a startup script has no address', graph: 'the plugin list cannot be read', plugin: 'a plugin is no longer running', script: 'a startup script cannot be read', empty: 'a startup script is empty', covers: 'a startup script misses a plugin', parse: 'a startup script is incomplete', size: 'a startup script is too large', verify: 'the plugin is not answering', screen: 'the page state cannot be read', busy: 'another rebuild is already running', dependencies: 'a plugin dependency is not running', missing: 'a plugin in the startup list is gone', network: 'the plugins could not be read', register: 'a plugin did not register itself', entries: 'a refresh would open a page that cannot load, so restart the app first', generation: 'the plugins were replaced a moment ago, press again', boot: 'reopen the app to use the new code', url: 'the startup info is too long to keep', mixed: 'the next page would mix old and new plugin code, so reopen the app first' };

    /** The last reason a readiness check refused for, or null after a check that passed. */
    let holdReason = null;

    /** The exact state that held the last check, when the reason alone would not tell. */
    let holdDetail = null;
    let holdSignature = null;

    /** What the refusing check itself said, kept for the press that wants to read it. */
    let holdRaw = null;

    /** Record why a rebuild is held and answer false for the check that asked. */
    function held(reason) {
      holdReason = reason;
      holdRaw = null;
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
     * The press this page is still finishing, and whether its deadline already answered for it. A
     * press that outlived the person's patience is finished as far as the button is concerned, but
     * the update it named is not: this record is what the next press reads to answer with the
     * update's own end instead of repeating "still applying" until the old call finally settles.
     */
    let pressRecord = null;

    /** The address a press could not check, so the next press inside the minute can go ahead. */
    let addressHold = null;
    let attachmentsHold = null;
    /**
     * A picked file has no id this page can read, and two different files can share one name and
     * one size. The picker's own object is the file, so each one gets a stable number of its own:
     * a file swapped for another under the same name then reads as a different set to give up.
     */
    const pickedFileIds = new WeakMap();
    let pickedFileSeq = 0;
    function pickedFileId(file) {
      if (file === null || typeof file !== 'object') return '';
      try {
        const known = pickedFileIds.get(file);
        if (known !== undefined) return known;
        pickedFileSeq += 1;
        pickedFileIds.set(file, pickedFileSeq);
        return pickedFileSeq;
      } catch {
        // A file object that cannot be keyed is still described by its own name and size.
        return '';
      }
    }
    /** Until this moment the page itself was just rebuilt, so another press has nothing to do. */
    let quietUntil = 0;

    /** The last line this page put up, so a press tells its own progress from a joined press's. */
    let lastSaid = null;

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

    function stampClear() {
      try {
        window.sessionStorage.removeItem(STAMP_KEY);
      } catch {
        // Pacing is the only thing this stamp feeds: a store that refuses the clear costs nothing.
      }
    }

    /**
     * Written down by the document that is about to be replaced, so the one that comes up knows it
     * is the rebuild the person asked for and does not reload itself again on top of it.
     */
    const REBUILT_KEY = 'dsh-unlag:rebuilt'; // ui-copy-ignore
    function currentRev() {
      try {
        const rev = window.__DSH_BOOT__?.rev;
        return typeof rev === 'string' ? rev : '';
      } catch {
        return '';
      }
    }
    function rebuiltRead() {
      try {
        const raw = window.sessionStorage.getItem(REBUILT_KEY);
        if (typeof raw !== 'string' || raw === '') return null;
        const mark = JSON.parse(raw);
        return mark !== null && typeof mark === 'object' && Number.isFinite(mark.at) ? mark : null;
      } catch {
        return null;
      }
    }
    function rebuiltWrite() {
      try {
        window.sessionStorage.setItem(REBUILT_KEY, JSON.stringify({ rev: currentRev(), at: Date.now() }));
      } catch {
        // Pacing is the only thing this mark feeds.
      }
    }
    try {
      const mark = rebuiltRead();
      if (mark !== null && mark.rev === currentRev() && Date.now() - mark.at < 60000) { // ui-copy-ignore
        // This page is the new document: a press inside the next seconds has nothing to replace.
        quietUntil = mark.at + 15000; // ui-copy-ignore
        window.sessionStorage.removeItem(REBUILT_KEY);
      }
    } catch {
      // A store that refuses the read leaves no window, which only means no pacing.
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
    /** How long one switch save may take before the page stops believing it will land. */
    const SWITCH_SAVE_MS = 4000; // ui-copy-ignore
    /**
     * The whole press has a bound of its own. Each call inside it is bounded already, but a chain of
     * them is not: a press that waits on several slow answers in a row can outlive the patience of
     * the person who pressed it, and a button left pending is a button that looks broken. Whatever
     * has not answered by then is answered here, in words that describe the page still on screen.
     */
    const PRESS_DEADLINE_MS = 45000; // ui-copy-ignore
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

    async function readSettings(attempt = 0) {
      const again = async () => {
        if (attempt >= 1) return null;
        await new Promise((resolve) => setTimeout(resolve, 250)); // ui-copy-ignore
        return readSettings(attempt + 1);
      };
      try {
        // The answer can be missing for a moment while the plugin set is recomposed, which reads
        // exactly like a press with nothing switched on. One more ask costs a fraction of a second
        // and turns that into the press the person meant; a second miss is still reported as such.
        const response = await withTimeout(fetch(`${HOST_BASE}/state`, { cache: 'no-store', credentials: 'same-origin' }));
        if (!response.ok) return again();
        const data = await withTimeout(response.json());
        if (data === null || typeof data !== 'object') return again();
        return { plugins: data.plugins !== false, page: data.page !== false, agentRefresh: data.agentRefresh === true };
      } catch {
        return again();
      }
    }

    /**
     * Whether this page booted without a script it asked for. The app captures the startup list's
     * addresses while the document is booting, so the record says which of them answered at all;
     * only an address that answered with an error count as missing code. A record that is still
     * being written, or one that could not be read whole, says nothing and keeps quiet.
     */
    async function startupLostPlugins(attempt = 0) {
      try {
        const response = await withTimeout(fetch(`${HOST_BASE}/state`, { cache: 'no-store', credentials: 'same-origin' }));
        if (response.ok) {
          const data = await withTimeout(response.json());
          const snapshot = data?.bootSnapshot ?? null;
          if (snapshot !== null && typeof snapshot === 'object' && Array.isArray(snapshot.rows) && snapshot.rows.length > 0) {
            return snapshot.rows.some((row) => row?.unreadable === true && typeof row?.code === 'number' && row.code !== 0);
          }
        }
      } catch {
        /* a page that cannot read the record says nothing rather than guessing */
      }
      if (attempt >= 2) return false;
      await new Promise((resolve) => setTimeout(resolve, 700)); // ui-copy-ignore
      return startupLostPlugins(attempt + 1);
    }

    /**
     * Leave one line per press outcome in the log the app keeps. Without it a press that stopped
     * before rebuilding looks exactly like one that never happened, and the page itself is gone by
     * the time anyone reads it.
     */
    /**
     * Tells the app which startup list this page was frozen with. Nothing acts on it here: the
     * desktop shell pins the list when the window starts, so a document that never says what it got
     * leaves every later check guessing which addresses it will actually request.
     */
    function reportBoot() {
      try {
        const boot = window?.__DSH_BOOT__;
        if (boot === null || typeof boot !== 'object') return;
        void fetch(`${HOST_BASE}/boot`, {
          method: 'POST', // ui-copy-ignore
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json', 'x-dsh-unlag': '1' }, // ui-copy-ignore
          body: JSON.stringify({ boot: { rev: boot.rev, entries: boot.entries, batches: boot.batches } }), // ui-copy-ignore
        }).catch(() => {});
      } catch {
        /* a page that cannot describe itself must still render its button */
      }
    }

    function report(event, gate, attempt = 0) {
      // The page description is the app's value, not this plugin's: a boot object whose revision
      // cannot be read must not stop a press from being written down, and this call is the one
      // place a press is recorded at all.
      let page = '';
      try {
        page = String(window?.__DSH_BOOT__?.rev ?? '').replace(/[^a-z0-9]/gu, '').slice(0, 24);
      } catch {
        page = '';
      }
      // Each document has its own time origin. Two lines with the same origin are one page
      // reporting twice; two lines with different origins are two documents, which is the only
      // way to tell a double reload apart from a double report after the fact.
      let born = '';
      try {
        born = String(Math.round(Number(performance?.timeOrigin ?? 0))).replace(/[^0-9]/gu, '').slice(0, 16);
      } catch {
        born = '';
      }
      // How this document was reached is not something this plugin decides: a reload, a fresh
      // navigation and a history walk look identical from inside the page afterwards, so the only
      // way to say which happened is to write down how it arrived.
      let nav = '';
      try {
        const entry = performance?.getEntriesByType?.('navigation')?.[0];
        nav = String(entry?.type ?? '').replace(/[^a-z_]/gu, '').slice(0, 16);
      } catch {
        nav = '';
      }
      // Two things separate a page this plugin sent from one the app loaded on its own: this
      // plugin's address carries the interface marker, and its own navigation has this page as the
      // referrer. Neither is true of a load the app starts.
      let from = '';
      try {
        const url = new URL(location.href);
        if (url.searchParams.has('interface')) from = 'interface'; // ui-copy-ignore
        else if (String(document?.referrer ?? '').startsWith(url.origin)) from = 'self';
        else if (String(document?.referrer ?? '') === '') from = 'none';
        else from = 'other';
      } catch {
        from = '';
      }
      // Which window this is: the same page is opened by more than the workspace window, and a
      // document that is not the one the person is looking at should not be read as a refresh.
      let view = '';
      try {
        const path = String(location.pathname ?? '').replace(/[^a-zA-Z0-9/._-]/gu, '').slice(0, 40);
        const width = Math.round(Number(window?.innerWidth ?? 0));
        const height = Math.round(Number(window?.innerHeight ?? 0));
        // A tab keeps its session storage across loads; a new window starts at 1. That tells a
        // load of the window you are looking at apart from another window opening the same page.
        let tab = 0;
        try {
          tab = Number(sessionStorage.getItem('dsh-unlag-tab') ?? '0') + 1;
          sessionStorage.setItem('dsh-unlag-tab', String(tab));
        } catch {
          tab = 0;
        }
        const hist = Math.round(Number(window?.history?.length ?? 0));
        const outerW = Math.round(Number(window?.outerWidth ?? 0));
        const outerH = Math.round(Number(window?.outerHeight ?? 0));
        const vis = String(document?.visibilityState ?? '').replace(/[^a-z]/gu, '').slice(0, 9);
        view = `${path}|${width}x${height}|${outerW}x${outerH}|${tab}|${hist}|${vis}`;
      } catch {
        view = '';
      }
      const named = gate === undefined ? `event=${event}` : `event=${event}&gate=${encodeURIComponent(gate)}`;
      const withPage = page === '' ? named : `${named}&rev=${page}`;
      const withBorn = born === '' ? withPage : `${withPage}&born=${born}`;
      const withNav = nav === '' ? withBorn : `${withBorn}&nav=${nav}`;
      const withFrom = from === '' ? withNav : `${withNav}&from=${from}`;
      const query = view === '' ? withFrom : `${withFrom}&view=${encodeURIComponent(view)}`;
      /**
       * The route belongs to the instance this press is replacing. Its answer can land while the old
       * one is gone and the new one is not listening yet, and a lost line is a press nobody can
       * account for later. Two more tries cost nothing and keep the record.
       */
      const again = () => {
        if (attempt >= 3) return;
        // The route is registered again by the plugin the press just replaced, and that window can
        // outlast a second: three tries spread over four seconds keep the record through it.
        setTimeout(() => report(event, gate, attempt + 1), attempt === 0 ? 300 : attempt === 1 ? 900 : 2500); // ui-copy-ignore
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

    /** The operation the last replacement started, so its real end can be read back later. */
    let replacedOperation = null;
    /** The name the last press gave its update, so its answer can be asked for by that name. */
    let replacedRequest = null;

    /** Ask the running app to replace changed plugins now; a running turn is reported, never cut. */
    async function replacePlugins(requestId) {
      try {
        const response = await withTimeout(fetch(`${HOST_BASE}/reload?requestId=${encodeURIComponent(requestId)}`, {
          method: 'POST', // ui-copy-ignore
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json', 'x-dsh-unlag': '1' }, // ui-copy-ignore
          body: '{}', // ui-copy-ignore
        }));
        if (!response.ok) return 'failed';
        const data = await withTimeout(response.json());
        replacedOperation = typeof data?.operationId === 'number' ? data.operationId : null;
    if (pressRecord !== null) pressRecord.operationId = replacedOperation;
        return reloadVerdict(data);
      } catch {
        // Nothing answered: the update may or may not have happened, and only the set can say.
        return 'lost';
      }
    }

    /**
     * What the app's answer to a plugin replacement really means for the rebuild that follows.
     * Only a set the app has finished starting can be rebuilt against: one still starting would
     * boot a document over plugins that are not ready, and one the app says cannot be applied to a
     * running page would boot the old code behind a fresh interface.
     * @returns 'done' | 'unconfirmed' | 'off' | 'queued' | 'unavailable' | 'failed' | 'lost'
     */
    function reloadVerdict(data) {
      if (data === null || typeof data !== 'object') return 'failed';
      const status = typeof data.status === 'string' ? data.status : 'failed';
      // `pending` is not a queued update: the changed modules need a restart to load at all.
      // Entries that were already not running before the press are not its result: the app rejects
      // a reload that newly breaks one, so the press stands whatever that leftover list says.
      if (Array.isArray(data.pending) && data.pending.length > 0) return 'restart';
      if (typeof data.restartReason === 'string' && data.restartReason !== '') return 'restart';
      // A finished update whose plugin health could not be read is not a confirmed one. It is not a
      // failure either — the plugins may be fine — but starting a document over them would be a
      // guess, so the press holds the page and says what it could not check.
      if (data.healthReadable === false) return 'unconfirmed';
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
      // The answer is read outside the try above, and a page shares one `fetch` with every plugin:
      // an answer that cannot say whether it is ok is treated as no answer, never as a throw.
      let served = false;
      try {
        served = response?.ok === true;
      } catch {
        served = false;
      }
      if (served === false) {
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
        holdDetail = null;
        return 'ok';
      }
      // The refusal's wording is the app's, read as a key into a table of gates: a key the table does
      // not own (a prototype name, a word from a newer app) falls back to the list rather than to
      // whatever that name happens to resolve to.
      const reason = data !== null && typeof data === 'object' && typeof data.reason === 'string' ? data.reason : 'list';
      held(Object.hasOwn(VERIFY_GATES, reason) ? VERIFY_GATES[reason] : 'list');
      // The app's sentence is kept only when it says more than the key already did.
      const said = data !== null && typeof data === 'object' && typeof data.detail === 'string' ? data.detail : '';
      holdRaw = said === '' ? `${reason}` : `${reason}: ${said}`;
      return 'blocked';
    }

    // What the app's refusal means to the person pressing: the same gates the checks above use.
    const VERIFY_GATES = {
      empty: 'empty', // ui-copy-ignore
      missing: 'script', // ui-copy-ignore
      network: 'script', // ui-copy-ignore
      parse: 'parse', // ui-copy-ignore
      size: 'script', // ui-copy-ignore
      register: 'plugin', // ui-copy-ignore
      slow: 'slow', // ui-copy-ignore
      dependencies: 'covers',
      entries: 'entries', generation: 'generation', boot: 'boot',
      list: 'list', // ui-copy-ignore
      mixed: 'mixed', // ui-copy-ignore
    };

    /** Read every bundle the next boot would load and prove each listed plugin is inside. */
    async function bundlesCoverStartup(graph) {
      if (graph === null || typeof graph !== 'object') return held('graph');
      // The list is a live object the app re-composes: reading its fields can fail mid-swap, and a
      // list that cannot be read is a held press, not a broken page.
      let entries = [];
      let batches = [];
      try {
        entries = Array.isArray(graph.entries) ? graph.entries : [];
        batches = Array.isArray(graph.batches) ? graph.batches : [];
      } catch {
        return held('graph');
      }
      // A profile with no plugin at all hands the next document no script to load: a rebuild has
      // nothing to fail, and holding would refuse it with a reason that is not true.
      if (entries.length === 0 && batches.length === 0) return true;
      if (entries.length === 0 || batches.length === 0) return held('graph');
      const covered = new Set();
      const sources = [];
      for (const batch of batches) {
        // A batch is read field by field: the list can be the page's own boot object, and a batch
        // whose fields cannot be read leaves that address unproven rather than the page broken.
        let url = '';
        let listed = [];
        try {
          url = typeof batch?.url === 'string' ? batch.url : '';
          listed = Array.isArray(batch?.entries) && batch.entries.every((id) => typeof id === 'string') ? batch.entries : [];
        } catch {
          return held('row');
        }
        if (url === '') continue;
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
        let id = '';
        try {
          id = typeof entry === 'string' ? entry : entry?.id;
        } catch {
          return held('covers');
        }
        if (typeof id !== 'string' || !covered.has(id)) return held('covers');
      }
      // Reading these bodies here would need a parser the page does not have and would not prove
      // what the new document registers; the app compiles the same bytes with the real parser.
      const verdict = await hostVerifyStartup(sources.map((source) => source.url.toString()));
      if (verdict !== 'ok') return false;
      holdReason = null;
      holdDetail = null;
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
        // An empty list is still an answer: a document booting from it loads no plugin script, so
        // nothing about it can fail. Only a shape that names no list at all stays unread.
        const rows = Array.isArray(payload?.injections) ? payload.injections : null;
        return rows;
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
        // The saved list crosses a boundary from the shell: a row whose fields cannot be read is a
        // list this page cannot vouch for, and naming the row beats a page-shaped notice.
        let kind = '';
        let runs = false;
        let src = '';
        let name = '';
        let value = null;
        try {
          kind = typeof row.kind === 'string' ? row.kind : '';
          runs = kind === 'script-src' || kind === 'script-preload';
          src = typeof row.src === 'string' ? row.src : '';
          name = typeof row.name === 'string' ? row.name : '';
          value = row.value;
        } catch {
          return held('row');
        }
        if (!STARTUP_ROW_KINDS.has(kind)) return held('row');
        // Only the rows a document runs as scripts have to load as classic scripts. Style and
        // markup rows carry their own text and their address is not a script at all, so reading
        // them back would refuse a sound list over a false alarm.
        if (runs && src === '') return held('src');
        if (runs) scripts.push(src);
        // Inline rows carry their own text and are not fetched; the queue script among them ends
        // in a nested return that a flat scan would misread, so their text is left to the document.
        if (kind !== 'global' || name !== '__DSH_BOOT__') continue; // ui-copy-ignore
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
        // Both lists come from outside this function: the saved one from the shell, the current one
        // from the app. One that cannot be read leaves the comparison unanswered, and each names
        // itself rather than the page.
        let kept = [];
        try {
          kept = Array.isArray(frozen.entries) ? frozen.entries : [];
        } catch {
          return held('list');
        }
        let liveEntries = [];
        try {
          liveEntries = Array.isArray(live.entries) ? live.entries : [];
        } catch {
          return held('graph');
        }
        const liveIds = new Set();
        try {
          for (const entry of liveEntries) liveIds.add(typeof entry === 'string' ? entry : entry?.id);
        } catch {
          return held('graph');
        }
        let vanished = false;
        for (const entry of kept) {
          const id = typeof entry === 'string' ? entry : entry?.id;
          if (typeof id === 'string' && id !== '' && !liveIds.has(id)) vanished = true;
        }
        // A plugin switched off since this page booted is only fatal if nothing stands in for its
        // script. Such a row is answered with a stand-in module that registers the id and applies
        // nothing, and the check below reads those same bytes, so the press may ask instead of being
        // refused here for good.
        if (vanished && (await hostShimAnswersGone())) return held('plugin');
      }
      const verdict = await hostVerifyStartup(scripts);
      if (verdict !== 'ok') return false;
      holdReason = null;
      holdDetail = null;
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

    /**
     * The stamp written when the plugin code was last loaded. A replacement that was applied
     * without changing which bundles are served keeps the startup list's revision, so the graph
     * alone cannot tell a lost answer from a failed press; the code stamp can.
     */
    /** Whether a plugin no longer in the running set still has its script answered. */
    async function hostShimAnswersGone() {
      try {
        const response = await withTimeout(fetch(`${HOST_BASE}/state`, { cache: 'no-store', credentials: 'same-origin' }));
        if (!response.ok) return true;
        const data = await withTimeout(response.json());
        return data?.shim?.wrapped !== true;
      } catch {
        return true;
      }
    }

    /**
     * The real end of the update a press started. The press's own answer is bounded by the time a
     * page waits, so an update that outlasted it is answered as still applying; the app writes that
     * same operation's end as it happens, and this reads it instead of leaving the press undecided.
     */
    async function settledOperation(id, requestId = null) {
      if (typeof id !== 'number' && typeof requestId !== 'string') return null;
      for (const wait of [500, 1200, 2500]) { // ui-copy-ignore
        await new Promise((resolve) => setTimeout(resolve, wait));
        try {
          const response = await withTimeout(fetch(`${HOST_BASE}/state`, { cache: 'no-store', credentials: 'same-origin' }));
          if (!response.ok) continue;
          const data = await withTimeout(response.json());
          const operation = data?.operation;
          if (operation === null || typeof operation !== 'object') continue;
          // A named press is answered only by the operation that carries its name: an id that
          // happens to be at least as high may belong to somebody else's update.
          if (typeof requestId === 'string') {
            if (operation.requestId !== requestId) continue;
          } else if (typeof operation.id !== 'number' || operation.id < id) continue;
          if (operation.status !== 'applying') return operation;
        } catch {
          /* the answer is a nicety here: the press already has one of its own */
        }
      }
      return null;
    }

    /**
     * What a lost replacement answer really did, read from the app's own record of that press.
     * A moved revision or a changed code stamp proves only that some update happened, so neither is
     * read as this press's success. Null means the app never showed an end for this press.
     * @returns 'done' | 'restart' | 'failed' | null
     */
    /**
     * The verdict one written record supports. A record can contradict itself: `done` while its
     * own fields still name a module waiting for a restart is not a finished update, and the
     * restart fields win. A record that already says it did not finish stays that way, and one
     * whose health the app could not read is finished but unconfirmed, so it never counts as a
     * set the page may be rebuilt over.
     * @returns 'done' | 'unconfirmed' | 'restart' | 'failed' | null
     */
    function verdictOfOperation(operation) {
      if (operation === null || typeof operation !== 'object') return null;
      if (operation.status === 'done') {
        if (typeof operation.pending === 'number' && operation.pending > 0) return 'restart';
        if (typeof operation.restart === 'string' && operation.restart !== '') return 'restart';
        if (operation.healthReadable === false) return 'unconfirmed';
        return 'done';
      }
      if (operation.status === 'restart') return 'restart';
      return 'failed';
    }

    async function settledPress(requestId) {
      const operation = await settledOperation(null, requestId);
      return verdictOfOperation(operation);
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
      holdDetail = null;
      // Two repeats: the app re-composes its bundles while it starts and after a plugin swap, and
      // a list read in the middle of that can answer for a generation that is already gone.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const saved = await desktopStartupPayload();
        // The desktop shell replays one startup list for every document. If it is running but its
        // copy cannot be read, nothing here proves a new document would boot, so the page stays.
        if (saved === null && desktopShellPresent()) {
          held('list');
        } else {
          // The document's own boot value is a page value: one that cannot be read leaves the list
          // unread rather than turning a held press into a broken-page notice.
          let own = null;
          try {
            own = window.__DSH_BOOT__ ?? null;
          } catch {
            own = null;
          }
          const fromHost = saved === null ? await servedBootGraph() : null;
          let servable = false;
          if (saved !== null && saved.length === 0) {
            // A shell whose saved list names no script hands the next document nothing to load, so
            // a rebuild has no script to fail: holding here would be a refusal with no reason.
            servable = true;
          } else if (saved !== null) servable = await frozenStartupLooksServable(saved);
          else if (fromHost === null && own === null) held('list');
          else servable = await bundlesCoverStartup(fromHost ?? own);
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

    /**
     * The address this document comes back on: the same page, with a stamp that says which
     * generation of the interface it is. The document's own description decides the stamp; a value
     * that cannot be read costs a readable address, not the rebuild.
     */
    function freshAddress() {
      let stamp = String(Date.now());
      try {
        const graph = window.__DSH_BOOT__;
        if (typeof graph?.rev === 'string' && graph.rev !== '') stamp = graph.rev;
      } catch {
        stamp = String(Date.now());
      }
      try {
        const parsed = new URL(location.href);
        parsed.searchParams.set('interface', stamp);
        return parsed.toString();
      } catch {
        return null;
      }
    }

    /**
     * Whether the address about to be entered really serves a page. Walking into it is the one step
     * a press cannot take back: the shell quits on a document it cannot boot, and the document it
     * replaced is gone from the history with it. Asking first is what makes a refused rebuild keep
     * the page the person is reading instead of trading a slow page for no page at all.
     */
    /**
     * Whether a served document is one the app can boot from.
     *
     * The desktop shell serves a static page carrying `__DSH_BOOT_READY__` and then fetches the
     * startup manifest over its own channel, so the literal `__DSH_BOOT__` is absent from a page
     * that boots perfectly. Requiring it turned every normal desktop address into "no boot" and
     * refused the press twice, every time. The root container is what makes the body a page rather
     * than an error document; the manifest itself is checked where the app already checks it.
     */
    function documentCanBoot(body) {
      if (typeof body !== 'string' || body === '') return false;
      if (body.includes('__DSH_BOOT__')) return true; // ui-copy-ignore
      return body.includes('__DSH_BOOT_READY__') && /id\s*=\s*["']root["']/u.test(body); // ui-copy-ignore
    }

    async function askAddress(target) {
      const read = async (url) => {
        try {
          const res = await withTimeout(fetch(url, { cache: 'no-store', credentials: 'same-origin', headers: { 'x-dsh-unlag': '1' } })); // ui-copy-ignore
          if (res === null) return { ok: false, why: 'noanswer' };
          if (res.ok !== true) return { ok: false, why: `http:${res.status}` };
          const body = await withTimeout(res.text());
          if (typeof body !== 'string') return { ok: false, why: 'noanswer' };
          return documentCanBoot(body) ? { ok: true, why: 'ok' } : { ok: false, why: 'noboot' };
        } catch (error) {
          return { ok: false, why: error?.message === 'timeout' ? 'timeout' : 'noanswer' };
        }
      };
      if (target === null) return { safe: true, definite: false, why: 'ok' };
      const first = await read(target);
      if (first.ok) return { safe: true, definite: false, why: 'ok' };
      // A document asked for while the plugin set is being recomposed can answer late; one more
      // look is the difference between "not up yet" and "not there".
      const again = await read(target);
      if (again.ok) return { safe: true, definite: false, why: 'ok' };
      /**
       * An answer that the address does not serve a page is a refusal the press cannot argue with:
       * entering it would leave nothing to read. A check that never answered is not that answer —
       * it says nothing about the page — so it is called unchecked, said on screen, and the next
       * press inside the minute goes ahead with it.
       */
      // An auth answer means the request carried no session — not that the page is gone. The
      // browser enters the address with the session this page is already using, so the press goes
      // ahead instead of being told to try again for a page that is there.
      if (again.why === 'http:401' || again.why === 'http:403') return { safe: true, refused: true, why: again.why };
      const definite = again.why.startsWith('http:') || again.why === 'noboot';
      return { safe: false, definite, why: again.why };
    }

    /** Re-enter the interface on a fresh document, keeping the current view in the address. */
    function reloadFreshPage(known = null) {
      const target = known ?? freshAddress();
      try {
        if (target !== null) window.location.replace(target);
        else window.location.reload?.();
      } catch {
        // The page is going away either way; the press has already reported what it replaced.
      }
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
      // A handler says no in three ways: cancelling the event, setting `returnValue` to false, or
      // returning a message through `window.onbeforeunload` (the browser copies that message into
      // `returnValue`). Missing the last one let a press start a navigation the page would then
      // ask about over the page's own head.
      const message = probe.returnValue;
      return probe.defaultPrevented === true || message === false || (typeof message === 'string' && message !== '');
    }

    /**
     * The ids of every session the app retains. The app publishes them as one snapshot; older
     * shapes are accepted too, so a page from before a shape change still finds its composers
     * instead of reporting an empty set while messages are still being sent.
     * @returns the session ids, in no particular order.
     */
    function retainedSessionIds(sessions) {
      try {
        const byId = sessions?.list?.getSnapshot?.()?.byId;
        if (byId !== null && typeof byId === 'object') return Object.keys(byId);
      } catch {
        // Fall through to the list shapes below.
      }
      try {
        const list = sessions?.list?.();
        if (Array.isArray(list)) return list.map((session) => (typeof session === 'string' ? session : session?.id)).filter((id) => typeof id === 'string' && id !== '');
        if (list !== null && list !== undefined && typeof list[Symbol.iterator] === 'function') {
          return [...list].map((session) => (typeof session === 'string' ? session : session?.id)).filter((id) => typeof id === 'string' && id !== '');
        }
      } catch {
        // No readable session list: the markup fallback below is the remaining witness.
      }
      return [];
    }

    /**
     * The composer's failed sends, and whether the app has already put them back into a saved draft.
     *
     * These are the shipped composer's own fields, not an interface the app promises, so they are
     * read here and nowhere else. Basis, from the session input shell in the app bundle (app.asar,
     * client input model, `SessionInputShell`):
     * - `failedDetached` — "Failed default sends waiting to be restored together in submission
     *   order", a map keyed by send sequence; each record keeps the draft text it carried.
     * - `failedRestoreRev` — "Revision of the last automatic failure restoration". The one restore
     *   path joins the waiting records in sequence order, writes that text into the editor, then
     *   records the draft revision the restore produced; the same publish writes the text to the
     *   session's draft store, so a restore and its saving are one step.
     * - `snapshot.draftRev` — the revision of the draft the composer holds now.
     * - a real edit bumps the revision and clears both the records and the recorded revision, so a
     *   matching pair cannot describe text the person has changed since.
     * One consequence decides the press: the app restores a failure only at the moment it fails, and
     * only into an empty composer. A record that no restore accounts for is therefore in neither the
     * composer nor the draft store — clearing newer words later does not bring it back — so it holds
     * the rebuild whatever the composer currently shows.
     * @param shell - the session composer.
     * @returns the failed records, whether a restore accounts for them, whether one holds a file,
     *   and whether the record map could be read at all.
     */
    function failedSendDraft(shell) {
      const records = [];
      let attachments = false;
      /**
       * Words and files are held apart because the app restores them apart. A record whose words
       * no restore accounts for is a message the person cannot get back by resending, whatever
       * else the same record dragged along; a record that only ever carried files is a file
       * question. Judging the two together let a file excuse a lost message.
       */
      let text = false;
      /**
       * A record map that throws is not a map with no failures. Answering it as empty let the press
       * rebuild over a message the app still holds, so the read is reported instead of swallowed.
       */
      let unreadable = false;
      try {
        for (const record of shell?.failedDetached?.values?.() ?? []) {
          records.push(record);
          // A restored record's files go back into the composer's rail; an unrestored one keeps its
          // files in a map only this document has.
          if ((record?.attachmentIds?.length ?? 0) > 0) attachments = true;
          if (typeof record?.draft === 'string' && record.draft.trim() !== '') text = true;
        }
      } catch {
        unreadable = true;
      }
      const draftRev = shell?.snapshot?.draftRev;
      const restoreRev = shell?.failedRestoreRev;
      // Only the app's own revision pairing makes a record safe. An answer missing either
      // revision cannot be read as "restored", because the words would then be assumed saved.
      const restored = records.length > 0
        && typeof restoreRev === 'number'
        && typeof draftRev === 'number'
        && restoreRev === draftRev;
      return { records, attachments, text, restored, unreadable };
    }

    /**
     * What the composer still holds that was never sent, if anything. The answer names the piece
     * of state that held the rebuild: a check that guesses is worse than one that says which
     * reading refused, because a false hold can then be traced to the exact field that lied.
     * @returns the name of the holding state, or null when nothing is held.
     */
    function draftAttachmentReason() {
      try {
        const conversation = appContext?.get?.('conversation');
        if (conversation !== null && conversation !== undefined) {
          // Files picked into this draft, still uploading, or on their way out in a send that has
          // not settled: each one exists only here until the app keeps it.
          if ((conversation.draftAttachments?.size ?? 0) > 0) return 'draft';
          if ((conversation.pendingFileUploads?.size ?? 0) > 0) return 'uploading';
          if ((conversation.fileUploadOperations?.size ?? 0) > 0) return 'uploading';
          const uploads = conversation.fileUploads?.getSnapshot?.() ?? conversation.fileUploads ?? {};
          if (Object.keys(uploads).length > 0) return 'upload';
          /**
           * A draft belongs to the session its composer was mounted for, and leaving that session
           * does not throw the draft away: the composer keeps it, attachments included, so the
           * person can come back to it. Those sessions are retained by the app, not shown in this
           * document, so the only complete answer names every retained session and reads its
           * composer through the app's own registry.
           */
          const sessions = appContext?.get?.('sessions');
          const shells = conversation.input;
          for (const id of retainedSessionIds(sessions)) {
            try {
              // The shell is addressed by session id and resolves the retained binding itself, so
              // this reads the composer the app actually mounted for that session.
              const shell = shells?.shell?.(id) ?? shells?.for?.(id);
              if (shell === null || shell === undefined) continue;
              /**
               * Files the composer still owns are the attachment question, and it is asked on its
               * own below the send question: a send in flight is checked first, in `sendHold`, so a
               * draft file can never mask a send that a rebuild would interrupt. Written words are
               * not a reason to hold either — the app keeps each session's draft in its own store.
               */
              if ((shell.snapshot?.attachmentIds?.length ?? 0) > 0) return 'composer';
            } catch {
              // One session whose composer cannot be read does not make the others empty; its own
              // composer still answers below through the markup fallback when it can.
            }
          }
          // The service answered, so the markup is not a better witness: images already sent stay
          // in the transcript with their preview addresses, and treating those as drafts held every
          // rebuild after a picture was ever sent.
          return null;
        }
      } catch {
        // The service answers nothing readable; the markup below is still worth a look.
      }
      try {
        // A picker that still holds files is the one markup fact that cannot be a transcript.
        for (const picker of document.querySelectorAll?.('input[type="file"]') ?? []) {
          if ((picker?.files?.length ?? 0) > 0) return 'picker';
        }
        return null;
      } catch {
        return null;
      }
    }

    /** The identities a collection holds, whatever shape it keeps them in. */
    function attachmentIdsIn(collection) {
      const ids = [];
      try {
        if (collection === null || collection === undefined) return ids;
        if (typeof collection.keys === 'function') {
          for (const key of collection.keys()) ids.push(String(key));
          return ids;
        }
        if (typeof collection !== 'string' && typeof collection[Symbol.iterator] === 'function') {
          for (const piece of collection) ids.push(String(piece));
          return ids;
        }
        if (typeof collection === 'object') ids.push(...Object.keys(collection));
      } catch {
        // A collection that cannot be walked adds no identity; the detail still holds the press.
      }
      return ids;
    }

    /**
     * The files a rebuild would take, and the identity of that exact set.
     *
     * A second press may agree to give the files up, and the agreement is worth something only for
     * the files the sentence was about: deleting them and picking different ones a moment later is
     * a new question. So the answer carries a signature of the attachment ids, the session they
     * belong to, and the picker's file names — an approval names a set, not a category.
     * @returns {{detail: string, signature: string}|null} what holds, and which files those are.
     */
    function attachmentSet() {
      const detail = draftAttachmentReason();
      if (detail === null) return null;
      const pieces = [];
      try {
        const conversation = appContext?.get?.('conversation');
        if (conversation !== null && conversation !== undefined) {
          pieces.push(...attachmentIdsIn(conversation.draftAttachments));
          pieces.push(...attachmentIdsIn(conversation.pendingFileUploads));
          pieces.push(...attachmentIdsIn(conversation.fileUploadOperations));
          const uploads = conversation.fileUploads?.getSnapshot?.() ?? conversation.fileUploads ?? {};
          pieces.push(...attachmentIdsIn(uploads));
          const sessions = appContext?.get?.('sessions');
          const shells = conversation.input;
          for (const id of retainedSessionIds(sessions)) {
            try {
              const shell = shells?.shell?.(id) ?? shells?.for?.(id);
              for (const piece of shell?.snapshot?.attachmentIds ?? []) pieces.push(`${id}:${String(piece)}`);
            } catch {
              // This session's files still count through the detail; only their identity is lost.
            }
          }
        }
      } catch {
        // The service is unreadable; the detail still holds the press and the markup may name more.
      }
      try {
        for (const picker of document.querySelectorAll?.('input[type="file"]') ?? []) {
          for (const file of picker?.files ?? []) pieces.push(`${String(file?.name ?? '')}:${String(file?.size ?? '')}#${String(pickedFileId(file))}`);
        }
      } catch {
        // No markup to read; the answer is what the service said.
      }
      const signature = pieces.filter((piece) => piece !== '').sort().join(',');
      return { detail, signature: `${detail}|${signature}` };
    }

    /**
     * What the retained composers hold right now, as one comparable string: the revision the
     * composer publishes, the words it shows, and how many files its rail carries. A save that
     * landed before an edit and one that landed after it must not read alike, or the edit is lost
     * with the save that claimed it.
     * @returns {string} the composers' current state, stable while nothing is typed or picked.
     */
    function draftStamp() {
      const parts = [];
      try {
        const conversation = appContext?.get?.('conversation');
        const shells = conversation?.input;
        for (const id of retainedSessionIds(appContext?.get?.('sessions'))) {
          try {
            const shell = shells?.shell?.(id);
            if (shell === null || shell === undefined) continue;
            const snapshot = shell.snapshot ?? {};
            parts.push(`${id}|${String(snapshot.draftRev ?? '')}|${String(snapshot.draft ?? '')}|${snapshot.attachmentIds?.length ?? 0}`);
          } catch {
            parts.push(`${id}|unreadable`);
          }
        }
      } catch {
        return 'unreadable';
      }
      return parts.join('\n');
    }

    /**
     * The send half of the judgement, scanned across every retained session.
     *
     * A message handed to the app but not yet accepted is still on its way out, so a rebuild in
     * that window interrupts a send the person already made: it holds like any other send. The scan never returns early on a draft file — files are asked about
     * separately, in `attachmentSet`, precisely so that one cannot mask the other.
     * @returns {{key: string, detail: string}|null} the send state that holds, if any.
     */
    function sendHold() {
      try {
        const conversation = appContext?.get?.('conversation');
        if (conversation === null || conversation === undefined) return null;
        const sessions = appContext?.get?.('sessions');
        const shells = conversation.input;
        for (const id of retainedSessionIds(sessions)) {
          try {
            const shell = shells?.shell?.(id) ?? shells?.for?.(id);
            if (shell === null || shell === undefined) continue;
            const phase = shell.snapshot?.phase;
            if (phase === 'sending' || phase === 'adjudicating' || phase === 'submitting') {
              return { key: 'sending', detail: 'sending' };
            }
            if ((shell.attachmentFlights?.size ?? 0) > 0) return { key: 'sending', detail: 'uploading' };
            /**
             * A send is retained until admission settles: the composer still owns something that
             * is neither a draft nor in the transcript, and a rebuild would leave the person
             * without an answer or a way to ask again.
             */
            for (const record of shell.detachedDrafts?.values?.() ?? []) {
              if ((record?.attachmentIds?.length ?? 0) > 0) return { key: 'sending', detail: 'sending' };
              if (typeof record?.draft === 'string' && record.draft.trim() !== '') {
                return { key: 'sending', detail: 'sending' };
              }
            }
            // A send that failed holds the press unless a restore put it back into the draft the
            // app already wrote down. Walking that per record, and never judging it by what the
            // composer happens to show, keeps a message the person cannot see and one the app
            // already saved from reading alike.
            const failed = failedSendDraft(shell);
            if ((failed.unreadable || failed.records.length > 0) && !failed.restored) {
              if (!failed.attachments || failed.text) return { key: 'unsent', detail: 'unsent' };
            }
          } catch {
            // One session whose composer cannot be read does not make the others empty.
          }
        }
      } catch {
        // Nothing readable: there is no send state to hold, and the markup fallback still runs.
      }
      return null;
    }

    /**
     * The last look before the document goes, taken with no `await` after it.
     *
     * The address check above can take a moment, and a file can be picked or a send started while
     * it runs. Everything read here is the page's own state, read synchronously, so the answer
     * describes the document that is about to be replaced rather than an earlier one.
     * @returns {{key: string, detail: string, signature?: string}|null} what holds, if anything.
     */
    function finalGate(discarded) {
      if (screenHasOpenWindow()) return { key: 'dialog', detail: 'dialog' };
      const send = sendHold();
      if (send !== null) return send;
      const attach = attachmentSet();
      if (attach !== null && attach.signature !== discarded) {
        return { key: 'attachments', detail: attach.detail, signature: attach.signature };
      }
      return null;
    }

    /**
     * The automatic judgement: every reason a rebuild would take something away is checked here,
     * in the order that costs the user least. A null answer means the interface can go.
     * @param {{discardAttachments?: string|null}} options the exact attachment set the person has
     *   agreed to give up, if any. It excuses those files and nothing else: focus commit, other
     *   plugins' save and refusal events, and the dialog check all still run.
     * @returns the copy key of the reason to stop, or null when a rebuild is safe.
     */
    async function prepareInterface(options = {}) {
      if (!(await startupLooksServable())) return 'blocked';
      /**
       * Everything below reads the page itself: the document, the events it answers, the fields it
       * holds. A page that cannot be read is not a page that can be left running behind a fresh
       * document, and a throw here would end the press as a failure with no reason on screen, so
       * an unreadable page holds the rebuild and says so.
       */
      holdDetail = null;
      holdSignature = null;
      try {
        if (screenHasOpenWindow()) return 'dialog';
        const send = sendHold();
        if (send !== null) {
          holdDetail = send.detail;
          return send.key;
        }
        const attach = attachmentSet();
        if (attach !== null) {
          holdDetail = attach.detail;
          holdSignature = attach.signature;
          if (attach.signature !== options.discardAttachments) return 'attachments';
        }
        /**
         * A save is the save of what the composer held when it ran. Words typed while a plugin was
         * saving are newer than that save, and the app has already written the older text down: a
         * press that leaves now drops them. So the check is made again against what the composer
         * holds after the save, and a composer that moved gets one more save. The count is bounded
         * because a person who keeps typing keeps the page, which is the honest answer.
         */
        for (let round = 0; round < 2; round += 1) {
          const before = draftStamp();
          await commitFocusedField();
          const ready = await otherPluginsAreReady();
          if (!ready || stillHeldBack()) return 'unsaved';
          if (draftStamp() === before) return null;
        }
        return 'unsaved';
      } catch {
        held('screen');
        return 'blocked';
      }
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

    // The notice is a card, not a line: the sentence and the detail behind it live in one box that
    // grows downwards. The detail used to be a second absolutely placed box, which put it outside
    // the notice and under whatever came next — a press on "详情" appeared to do nothing.
    const PILL_STYLE = {
      position: 'absolute', // ui-copy-ignore
      top: 30, // ui-copy-ignore
      right: 0, // ui-copy-ignore
      zIndex: 30, // ui-copy-ignore
      display: 'flex', // ui-copy-ignore
      flexDirection: 'column', // ui-copy-ignore
      alignItems: 'flex-end', // ui-copy-ignore
      gap: 6, // ui-copy-ignore
      // A short sentence gets a short box: the card hugs its own words up to a reading width, so a
      // six-character answer does not sit in a 340px frame with two thirds of it empty.
      // `max-content` is what makes it hug: this card is absolutely placed inside a 28px button
      // wrapper, and without a width basis its shrink-to-fit box is squeezed to that 28px — which
      // stacked a whole sentence one letter per line. max-width then clamps the long ones.
      width: 'max-content', // ui-copy-ignore
      maxWidth: 'min(340px, 82vw)', // ui-copy-ignore
      alignSelf: 'flex-end', // ui-copy-ignore
      padding: '6px 8px', // ui-copy-ignore
      borderRadius: 6,
      border: '1px solid var(--dsh-color-border, rgba(127,127,127,0.28))',
      background: 'var(--dsh-color-surface, Canvas)',
      color: 'var(--dsh-color-text-secondary, inherit)',
      fontSize: 12, // ui-copy-ignore
      lineHeight: 1.5,
      textAlign: 'left', // ui-copy-ignore
      whiteSpace: 'normal', // ui-copy-ignore
      wordBreak: 'break-word', // ui-copy-ignore
    };

    const PILL_TEXT_STYLE = {
      display: 'flex', // ui-copy-ignore
      alignItems: 'baseline', // ui-copy-ignore
      flexWrap: 'wrap', // ui-copy-ignore
      gap: 6, // ui-copy-ignore
    };

    const RAW_LINK_STYLE = {
      padding: 0, // ui-copy-ignore
      border: 'none', // ui-copy-ignore
      background: 'transparent', // ui-copy-ignore
      color: 'inherit', // ui-copy-ignore
      font: 'inherit', // ui-copy-ignore
      textDecoration: 'underline', // ui-copy-ignore
      cursor: 'pointer', // ui-copy-ignore
    };

    const RAW_STYLE = {
      paddingTop: 6, // ui-copy-ignore
      borderTop: '1px solid var(--dsh-color-border, rgba(127,127,127,0.28))',
      color: 'inherit', // ui-copy-ignore
      font: 'inherit', // ui-copy-ignore
      lineHeight: 1.5,
      textAlign: 'left', // ui-copy-ignore
      whiteSpace: 'pre-wrap', // ui-copy-ignore
      wordBreak: 'break-word', // ui-copy-ignore
    };

    const MENU_STYLE = {
      zIndex: 40, // ui-copy-ignore
      position: 'absolute', // ui-copy-ignore
      top: 30, // ui-copy-ignore
      right: 0, // ui-copy-ignore
      display: 'grid', // ui-copy-ignore
      gap: 6, // ui-copy-ignore
      padding: '8px 10px', // ui-copy-ignore
      borderRadius: 8,
      border: '1px solid var(--dsh-color-border, rgba(127,127,127,0.28))',
      background: 'var(--dsh-color-surface, Canvas)',
      color: 'var(--dsh-color-text, inherit)',
      fontSize: 12, // ui-copy-ignore
      textAlign: 'left', // ui-copy-ignore
      whiteSpace: 'nowrap', // ui-copy-ignore
      boxShadow: '0 4px 12px rgba(0,0,0,0.16)', // ui-copy-ignore
    };

    const MENU_ROW_STYLE = {
      display: 'flex', // ui-copy-ignore
      alignItems: 'center', // ui-copy-ignore
      gap: 6, // ui-copy-ignore
      cursor: 'pointer', // ui-copy-ignore
    };

    function ReloadButton() {
      const [hover, setHover] = React.useState(false);
      const [pending, setPending] = React.useState(false);
      const [notice, setNotice] = React.useState(null);
      /**
       * A page that came up short a plugin says so once, at mount. That sentence is not a press
       * outcome, so a press must not be able to take it away: it lives here, beside the notice,
       * and outlives every press this document makes.
       */
      const [gap, setGap] = React.useState(null);
      // A notice about the page itself stays until the page changes: it is not one press outcome.
      const [sticky, setSticky] = React.useState(false);
      // The refusing check's own words, shown only when the press is asked for them.
      const [raw, setRaw] = React.useState(null);
      const [showRaw, setShowRaw] = React.useState(false);
      const [menu, setMenu] = React.useState(false);
      const [switches, setSwitches] = React.useState({ plugins: true, page: true, agentRefresh: false });
      const wrap = React.useRef(null);

      /**
       * The save a flip is still waiting on, the choice the boxes show before its answer lands, and
       * the timer that would speak to a page that already went away. All three outlive the render
       * that started them, so all three are refs: the state below is a render behind when a second
       * click arrives in the same tick, and a press must be able to find the write in flight.
       */
      const savingRef = React.useRef(null);
      const intentRef = React.useRef(null);
      const navTimer = React.useRef(null);

      React.useEffect(() => () => {
        if (navTimer.current !== null) clearTimeout(navTimer.current);
        navTimer.current = null;
      }, []);

      /** One line about the press: the words, and the refusal that produced them if any. */
      const say = (text, words = null) => {
        lastSaid = text;
        setSticky(false);
        setRaw(words);
        setShowRaw(false);
        setNotice(text);
      };

      React.useEffect(() => {
        if (notice === null) return undefined;
        // A page that is short a plugin stays short until it is reopened, so its notice stays too.
        if (sticky) return undefined;
        // An opened detail belongs to the person reading it: the notice waits, and its timer starts
        // again once the detail is closed. A card that disappears under a press looks broken.
        if (showRaw) return undefined;
        // The raw words need longer on screen than a one-line notice.
        const timer = setTimeout(() => {
          setNotice(null);
          setRaw(null);
        }, raw === null ? 8000 : 16000); // ui-copy-ignore
        return () => clearTimeout(timer);
      }, [notice, raw, showRaw, sticky]);

      /**
       * One page, one check. A document whose startup list names a script the app can no longer
       * serve renders without that plugin and mentions nothing; this is the only moment the person
       * can be told, and it must not wait for a press they have no reason to make.
       */
      React.useEffect(() => {
        let live = true;
        const timer = setTimeout(() => {
          void startupLostPlugins().then((missing) => {
            if (!live || !missing) return;
            setGap(BOOT_GAP_NOTICE);
          });
        }, 1200); // ui-copy-ignore
        return () => {
          live = false;
          clearTimeout(timer);
        };
      }, []);

      // A menu left open over a page that is about to be rebuilt would name switches that no
      // longer describe the press that follows it.
      React.useEffect(() => {
        if (!menu) return undefined;
        const close = (event) => {
          if (wrap.current !== null && wrap.current.contains?.(event?.target)) return;
          setMenu(false);
        };
        const escape = (event) => {
          if (event.key === 'Escape') setMenu(false);
        };
        document.addEventListener('mousedown', close);
        document.addEventListener('keydown', escape);
        // Leaving the window is the same intent as clicking elsewhere: the menu is not something
        // to come back to open, and a blur handler that stays would keep the row alive for nothing.
        window.addEventListener('blur', close);
        return () => {
          document.removeEventListener('mousedown', close);
          document.removeEventListener('keydown', escape);
          window.removeEventListener('blur', close);
        };
      }, [menu]);

      /**
       * The switches are read when the menu opens, so it never shows a stale answer. A page that
       * cannot read them keeps the menu closed: a checkbox that changes nothing is worse than none.
       */
      const openMenu = async (event) => {
        event.preventDefault();
        if (pressInFlight || pending) {
          say(COPY.applying);
          return;
        }
        const settings = await readSettings();
        if (settings === null) {
          say(noticeFor('blocked'));
          return;
        }
        setSwitches({ plugins: settings.plugins, page: settings.page, agentRefresh: settings.agentRefresh });
        setMenu(true);
      };

      /**
       * Save one switch, and put it back if the app did not take it.
       *
       * A flip is a write, and a press is a read that can land on either side of it. Two flips in
       * one tick used to drop the second one silently, and a press started while the write was in
       * flight could judge a setting the person had already changed. So flips queue behind the one
       * in flight, each save carries the newest intent, and only the newest answer writes back to
       * the boxes: an older answer arriving late is history, not the current choice.
       */
      const sendSwitches = (next) => withTimeout(fetch(`${HOST_BASE}/switches`, {
        method: 'POST', // ui-copy-ignore
        cache: 'no-store', // ui-copy-ignore
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-dsh-unlag': '1' }, // ui-copy-ignore
        body: JSON.stringify({ plugins: next.plugins, page: next.page, agentRefresh: next.agentRefresh }),
      }), SWITCH_SAVE_MS);
      const toggleSwitch = (key) => {
        const before = intentRef.current ?? switches;
        const next = { ...before, [key]: !before[key] };
        intentRef.current = next;
        setSwitches(next);
        const save = (savingRef.current ?? Promise.resolve())
          .then(async () => {
            try {
              const response = await sendSwitches(next);
              const data = await withTimeout(response.json(), SWITCH_SAVE_MS);
              if (!response.ok || data?.status !== 'done') throw new Error('not saved');
              if (intentRef.current !== next) return;
              const applied = { plugins: data.plugins === true, page: data.page === true, agentRefresh: data.agentRefresh === true };
              intentRef.current = applied;
              setSwitches(applied);
              if (data.saved !== true) say(COPY.switchesUnsaved);
            } catch {
              if (intentRef.current !== next) return;
              intentRef.current = before;
              setSwitches(before);
              say(COPY.switchesFailed);
            }
          })
          .finally(() => {
            if (savingRef.current === save) savingRef.current = null;
          });
        savingRef.current = save;
        return save;
      };


      const style = pending
        ? { ...BUTTON_STYLE, opacity: 0.4 }
        : hover
          ? { ...BUTTON_STYLE, opacity: 1, background: 'var(--dsh-color-surface-hover, rgba(127,127,127,0.14))' }
          : BUTTON_STYLE;

      const onClick = async () => {
        /**
         * A press already running is joined, and the press that joined says so instead of nothing.
         * One exception: a press whose deadline already said the page stayed is not still working
         * for anyone. Its update may be, though, so this press reads that update's own end and
         * answers with it, then leaves the old call to finish where nobody is waiting.
         */
        if (pressInFlight) {
          const running = pressRecord;
          if (running === null || running.stalled !== true) {
            say(COPY.applying);
            return;
          }
          // Taken before the read so a second press during it joins instead of asking twice.
          running.stalled = false;
          say(COPY.applying);
          const settled = verdictOfOperation(await settledOperation(running.operationId, running.requestId));
          if (settled === 'done') {
            report('plugin-held', 'late-done');
            say(COPY.stayedReplaced);
          } else if (settled === 'restart') {
            report('plugin-held', 'late-restart');
            say(COPY.restart);
          } else if (settled === 'unconfirmed') {
            report('plugin-held', 'late-unconfirmed');
            say(COPY.unconfirmed);
          } else {
            report('plugin-held', 'late-failed');
            say(COPY.failed);
          }
          return;
        }
        if (pending) {
          say(COPY.applying);
          return;
        }
        // A press the page already answered is not answered twice. Saying so beats a dead button.
        if (Date.now() - stampRead() < 3000) { // ui-copy-ignore
          say(COPY.applying);
          return;
        }
        pressInFlight = true;
        pressRecord = { requestId: null, operationId: null, stalled: false };
        setMenu(false);
        setPending(true);
        // A press starts from nothing: a refusal from an earlier press must not answer this one,
        // and a button that looks idle until an answer lands looks broken.
        holdReason = null;
        holdRaw = null;
        // Nothing is drawn while the press runs: the button dims, and the page either
        // changes or it does not. An outcome from an earlier press must not answer this one.
        lastSaid = null;
        setSticky(false);
        setNotice(null);
        setRaw(null);
        setShowRaw(false);
        let navigated = false;
        // Read by the fallback below, which runs after the try block's own scope is gone.
        let replaced = false;
        // The app answered that it did not replace anything: the page half can still be rebuilt,
        // but nothing may claim the code is current.
        let hostSaidOff = false;
        /**
         * One press answers once. Every path below ends through `stop` or by navigating, and the
         * deadline ends the ones that never reach either: a press whose calls are still waiting
         * past the moment a person would call it broken is told so, and the button is handed back.
         */
        let answered = false;
        let pressTimer = null;
        const stop = (key, applied = false) => {
          if (answered) return;
          answered = true;
          if (pressTimer !== null) clearTimeout(pressTimer);
          pressTimer = null;
          setPending(false);
          say(noticeFor(key, applied), key === 'blocked' ? holdRaw : null);
        };
        pressTimer = setTimeout(() => {
          // A press that already answered or already navigated has nothing left to report.
          if (answered) return;
          // The button stops waiting here, but the update is still out there: the record keeps the
          // name this press gave it, so the next press can ask how it really ended.
          if (pressRecord !== null) pressRecord.stalled = true;
          report('stalled');
          stop('stalled');
        }, PRESS_DEADLINE_MS); // ui-copy-ignore
        try {
          // A press waits out a switch still being saved (bounded), so it judges the setting the
          // person chose rather than the one the app had a moment before the write landed.
          if (savingRef.current !== null) await Promise.race([savingRef.current, new Promise((resolve) => setTimeout(resolve, SWITCH_SAVE_MS))]); // ui-copy-ignore
          const settings = await readSettings();
          /**
           * Without the switches the press cannot know what it was asked for. Rebuilding anyway would
           * reload the page and leave the code untouched while the notice claimed the code was
           * current, so the press holds instead and says why.
           */
          if (settings === null) {
            report('held', 'settings');
            return stop('blocked');
          }
          const replace = settings.plugins;
          const rebuild = settings.page;
          // Nothing is switched on: the press says so instead of looking broken.
          if (!replace && !rebuild) {
            report('off');
            return stop('off');
          }
          // The page was rebuilt a moment ago by this same code: pressing again would replace a
          // document that is already the new one, which is the loop a stuck person would create.
          if (Date.now() < quietUntil && rebuild) {
            report('held', 'quiet');
            return stop('quiet');
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
            /**
             * The press names its update before asking, so a lost answer can be looked up by that
             * name. A revision that moved, or a code stamp that changed, may belong to any other
             * update — including one already running — and is never read as this press succeeding.
             */
            const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`; // ui-copy-ignore
            replacedRequest = requestId;
            if (pressRecord !== null) pressRecord.requestId = requestId;
            let status = await withTimeout(replacePlugins(requestId)).catch(() => 'lost');
            if (status === 'lost') {
              const settled = await settledPress(requestId);
              // No end shown for this press: nothing proves the update went through, and the page
              // is not rebuilt on a guess.
              status = settled === null ? 'failed' : settled;
            }
            let lateDone = false;
            hostSaidOff = status === 'off';
            if (status !== 'done' && status !== 'off') {
              const key =
                status === 'queued'
                  ? 'queued'
                  : status === 'applying'
                    ? 'applying'
                    : status === 'unconfirmed'
                      ? 'unconfirmed'
                      : status === 'restart'
                        ? 'restart'
                        : status === 'unavailable'
                          ? 'blocked'
                          : 'failed';
              report('plugin-held', key);
              /**
               * Still applying when the page stops waiting: the update is not the page's to finish,
               * but its real end is read back so a press that later broke an entry is not left
               * looking like a press that worked.
               */
              if (key === 'applying' || key === 'queued') {
                const settled = verdictOfOperation(await settledOperation(replacedOperation, replacedRequest));
                if (settled === 'failed') {
                  report('plugin-held', 'late-failed');
                  return stop('failed');
                }
                // The update did not finish after all: the page is told it needs a reopen instead
                // of being left on "still applying" forever.
                if (settled === 'restart') {
                  report('plugin-held', 'late-restart');
                  return stop('restart');
                }
                // The update finished but the app could not say the plugins are healthy: the page
                // is left as it is and told why, instead of being rebuilt over an unchecked set.
                if (settled === 'unconfirmed') {
                  report('plugin-held', 'late-unconfirmed');
                  return stop('unconfirmed');
                }
                // The answer ran out before the update did, but the update did finish: the press
                // goes on to the rebuild it was asked for instead of asking for another press.
                if (settled === 'done' || settled === 'off') {
                  report('plugin-held', 'late-done');
                  lateDone = settled === 'done';
                } else {
                  return stop(key);
                }
              } else {
                return stop(key);
              }
            }
            replaced = lateDone || status === 'done';
          }
          // The deadline already answered this press: a page rebuilt after that would contradict
          // the sentence the person just read, so the code update is where it stops.
          if (answered) return undefined;
          if (!rebuild) {
            // The plugin half is on and the page half is off: what the press did is worth saying.
            report('replaced');
            return stop(replaced ? 'replaced' : hostSaidOff ? 'off' : 'done');
          }
          const agreed = attachmentsHold !== null && Date.now() - attachmentsHold.at < 60000 // ui-copy-ignore
            ? attachmentsHold.signature
            : null;
          const agreedDetail = agreed === null ? null : attachmentsHold.detail;
          attachmentsHold = null;
          // Before the document is replaced, the address it is replaced with has to answer. A page
          // that cannot come up is not a rebuild; it is a page the person can no longer read.
          const target = freshAddress();
          const address = await askAddress(target);
          if (address.refused === true) report('rebuild', `refused:${address.why}`);
          if (!address.safe) {
            const repeat = addressHold !== null && addressHold.target === target && Date.now() - addressHold.at < 60000; // ui-copy-ignore
            if (address.definite || !repeat) {
              if (!address.definite) addressHold = { target, at: Date.now() };
              report('held', replaced ? `applied:document:${address.why}` : `document:${address.why}`);
              return stop(address.definite ? 'cannotLoad' : 'unchecked', replaced);
            }
            addressHold = null;
            report('rebuild', `unchecked:${address.why}`);
          } else {
            addressHold = null;
          }
          if (answered) return undefined;
          const reason = await prepareInterface({ discardAttachments: agreed });
          if (answered) return undefined;
          // The second press on the same files: they are what the press gives up, and that was said
          // before it. Only those files are excused — the save and refusal checks above still ran.
          const discarded = reason === null && agreed !== null ? agreed : null;
          if (discarded !== null) report('rebuild', `attachments:${agreedDetail ?? 'attachments'}`);
          if (reason !== null) {
            if (reason === 'attachments') {
              attachmentsHold = { signature: holdSignature, detail: holdDetail, at: Date.now() };
            }
            // The log keeps the exact check that refused, so a held press can be explained later.
            const gate = reason === 'blocked' && holdReason !== null
              ? `blocked:${holdReason}`
              : reason === 'attachments' && holdDetail !== null
                ? `attachments:${holdDetail}`
                : reason === 'sending' || reason === 'unsent'
                  ? `${reason}:${holdDetail}`
                  : reason;
            report('held', replaced ? `applied:${gate}` : gate);
            return stop(reason, replaced);
          }
          /**
           * The address check can take a moment, and a file can be picked or a send started while
           * it waits. Everything read here is synchronous, so the answer describes the document
           * that is about to be replaced — checked with no `await` between it and the navigation.
           */
          const late = finalGate(discarded);
          if (late !== null) {
            if (late.key === 'attachments') {
              attachmentsHold = { signature: late.signature, detail: late.detail, at: Date.now() };
            }
            report('held', replaced ? `applied:${late.key}:${late.detail}` : `${late.key}:${late.detail}`);
            return stop(late.key, replaced);
          }
          // Written only now, when the document really is about to go: a press that was held changed
          // nothing, so the next press must not be turned away as if this one had been answered.
          // The navigation is this press's answer, so the deadline set at its start is spent here.
          answered = true;
          if (pressTimer !== null) clearTimeout(pressTimer);
          pressTimer = null;
          stampWrite();
          rebuiltWrite();
          report('rebuild');
          // One line for the navigation itself: the number of documents that come up after it is
          // the number of loads the person sees, and only the log can count them afterwards.
          report('navigating');
          navigated = true;
          reloadFreshPage(target);
          return undefined;
        } catch (error) {
          report('failed', 'press');
          stop('failed');
          return undefined;
        } finally {
          // The update has really ended, so the record has nothing left to answer and the button
          // is nobody's: a press that stalled gave its answer long ago, and this is the only place
          // the flag is cleared.
          pressRecord = null;
          pressInFlight = false;
          // The document goes away on a rebuild, so the button only needs re-enabling when it does not.
          if (!navigated) setPending(false);
          else {
            navTimer.current = setTimeout(() => {
              navTimer.current = null;
              // Still here after asking for a rebuild: the page held the navigation. Say what
              // happened and take the press back, so the button is never left unresponsive.
              report('held', 'navigation');
              // The document stayed, so no press was answered: clear the pacing stamp this press
              // wrote, or the next press inside three seconds would be told it is already applying.
              stampClear();
              setPending(false);
              // Only a press that really replaced the plugins may say so: a page-only press that
              // held the navigation changed no code.
              say(replaced ? COPY.stayedReplaced : COPY.stayed);
            }, 6000); // ui-copy-ignore
          }
        }
      };

      const menuPanel = menu
        ? h('span', { style: MENU_STYLE, role: 'group', 'aria-label': COPY.menu },
            h('span', { style: { opacity: 0.7 } }, COPY.menu), // ui-copy-ignore
            h('label', { style: MENU_ROW_STYLE },
              h('input', { type: 'checkbox', checked: switches.plugins, onChange: () => toggleSwitch('plugins'), style: { margin: 0 } }), // ui-copy-ignore
              COPY.switchPlugins),
            h('label', { style: MENU_ROW_STYLE },
              h('input', { type: 'checkbox', checked: switches.page, onChange: () => toggleSwitch('page'), style: { margin: 0 } }), // ui-copy-ignore
              COPY.switchPage),
            h('label', { style: MENU_ROW_STYLE },
              h('input', { type: 'checkbox', checked: switches.agentRefresh, onChange: () => toggleSwitch('agentRefresh'), style: { margin: 0 } }), // ui-copy-ignore
              COPY.switchAgent))
        : null;

      return h('span', { style: WRAP_STYLE, ref: wrap, onContextMenu: openMenu },
        h('button', {
          type: 'button', // ui-copy-ignore
          title: notice ?? gap ?? (zh ? `${COPY.hint}；右键设置` : `${COPY.hint}; right-click for settings`), // ui-copy-ignore
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
        menuPanel,
        (notice ?? gap) === null ? null : h('span', { role: 'status', 'aria-live': 'polite', style: PILL_STYLE },
          h('span', { style: PILL_TEXT_STYLE },
            h('span', null, notice ?? gap),
            // The sentence says what to do; the words behind it are one press away for the person
            // who wants to know why the press was refused at all.
            raw === null ? null : h('button', {
              type: 'button', // ui-copy-ignore
              style: RAW_LINK_STYLE,
              'aria-expanded': showRaw,
              onClick: (event) => {
                event.preventDefault();
                setShowRaw((open) => !open);
              },
            }, showRaw ? COPY.rawHide : COPY.rawShow)),
          raw === null || !showRaw ? null : h('span', { style: RAW_STYLE }, raw)));
    }

    /**
     * The guard as the press asks it. Exposed only to a headless harness: the failure this plugin
     * must never cause is a navigation the saved startup list cannot survive, and that question is
     * worth asking without starting a desktop app.
     */
    /** The page's own plugin context, kept so the composer's state can be read at press time. */
    let appContext = null;
    // The context this plugin already put its row into. The host can replay an injection (a remount ui-copy-ignore
    // of the same plugin, a reload that keeps the context), and registering the row twice puts a ui-copy-ignore
    // second button in it with its own listeners and its own boot report.
    let appliedCtx = null;

    const PROBE = {
      prepareInterface,
      readSettings,
      startupLooksServable,
      startupHoldReason: () => holdReason,
      startupLostPlugins,
      noticeFor,
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
        appContext = ctx;
        if (ctx === appliedCtx) return;
        appliedCtx = ctx;
        if (!desktop) return;
        /**
         * The pacing stamp only paces presses inside one document. A document that is mounting now
         * means the press that wrote it finished and navigated, so a click here is the first press
         * of a fresh page, not a repeat of one still in flight. Clearing it keeps that click
         * answered instead of turning it away with "press again later" on a page with nothing
         * pending.
         */
        stampClear();
        // Which composer service this document could reach decides how much the press can know: a
        // page without it can only read the markup, and the line says which page it was.
        reportBoot();
        report('mounted', appContext?.get?.('conversation') ? 'composer' : 'no-composer');
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
