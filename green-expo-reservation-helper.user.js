// ==UserScript==
// @name         GREEN×EXPO 2027 来場日時予約ヘルパー
// @namespace    https://expo.pengu.info/
// @version      1.0.0
// @description  Pengu infoで選んだ空き枠だけを、個人情報をPengu側へ出さずに公式チケットサイトへ引き継ぎます。
// @author       local
// @match        https://expo.pengu.info/visiting*
// @match        https://ticket.expo2027yokohama.or.jp/*
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_listValues
// @grant        GM_openInTab
// @grant        GM_registerMenuCommand
// @grant        GM_deleteValue
// @grant        GM_setValue
// @grant        GM.addStyle
// @grant        GM.getValue
// @grant        GM.listValues
// @grant        GM.openInTab
// @grant        GM.deleteValue
// @grant        GM.setValue
// @noframes
// @sandbox      DOM
// @inject-into  content
// @run-at       document-start
// ==/UserScript==

(async function () {
  'use strict';

  const SCRIPT_NAME = 'GREEN×EXPO 2027 来場日時予約ヘルパー';
  const VERSION = '1.0.0';
  const REQUEST_KEY_PREFIX = 'greenExpoReservationHelper.request.v3.';
  const SECURE_JOB_KEY_PREFIX = 'greenExpoReservationHelper.secureJob.v3.';
  const TICKET_ID_KEY = 'greenExpoReservationHelper.ticketId.v1';
  const LEGACY_REQUEST_KEY = 'greenExpoReservationHelper.request.v2';
  const LEGACY_SECURE_JOB_KEY = 'greenExpoReservationHelper.secureJob.v2';
  const LEGACY_JOB_KEY = 'greenExpoReservationHelper.job.v1';
  const OFFICIAL_RUN_WINDOW_PREFIX = 'greenExpoReservationHelper:officialRun:';
  const OFFICIAL_RUN_HASH_PREFIX = '#ge-helper-run=';
  const JOB_TTL_MS = 60 * 1000;
  const OFFICIAL_ORIGIN = 'https://ticket.expo2027yokohama.or.jp';
  const CHANGE_MESSAGE_CODE = 'SW_GP_DL_019_0137';
  const RESERVE_MESSAGE_CODE = 'SW_GP_DL_132_0322';
  const NEXT_MESSAGE_CODE = 'SW_GP_DL_101_0157';
  const FINAL_CONFIRM_MESSAGE_CODE = 'NSW_GP_DL_237_001_0017';
  const AVAILABLE_STATUS_PATTERN =
    /^(?:余裕あり|残りわずか)(?:\s*[（(][^）)]*[）)])?$/;
  const PENGU_CLICK_DEBOUNCE_MS = 10_000;
  const LEGACY_STORAGE_KEYS = [
    LEGACY_REQUEST_KEY,
    LEGACY_SECURE_JOB_KEY,
    LEGACY_JOB_KEY,
  ];

  let ticketRouteRunning = false;
  let officialRouteTimer = null;
  let lastTicketRouteSignature = '';
  let activeTicketPanelCleanup = null;
  const lastPenguClickByTarget = new Map();
  const storageCache = new Map();

  const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

  function normalizeText(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
  }

  function pad2(value) {
    return String(value).padStart(2, '0');
  }

  function makeId() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function getModernApi(name) {
    const api = typeof GM !== 'undefined' ? GM : globalThis.GM;
    const method = api?.[name];
    return typeof method === 'function' ? method.bind(api) : null;
  }

  function getLegacyApi(name) {
    const method = globalThis[`GM_${name}`];
    return typeof method === 'function' ? method : null;
  }

  async function readStorageValue(key, defaultValue = null) {
    const legacy = getLegacyApi('getValue');
    if (legacy) return await legacy(key, defaultValue);

    const modern = getModernApi('getValue');
    if (modern) return await modern(key, defaultValue);

    throw new Error('ユーザースクリプトの保存APIを利用できません。');
  }

  async function listStorageKeys() {
    const legacy = getLegacyApi('listValues');
    if (legacy) return await legacy();

    const modern = getModernApi('listValues');
    if (modern) return await modern();

    throw new Error('ユーザースクリプトの保存一覧APIを利用できません。');
  }

  function getStorageValue(key, defaultValue = null) {
    return storageCache.has(key) ? storageCache.get(key) : defaultValue;
  }

  function setStorageValue(key, value) {
    storageCache.set(key, value);

    const legacy = getLegacyApi('setValue');
    if (legacy) return Promise.resolve(legacy(key, value));

    const modern = getModernApi('setValue');
    if (modern) return Promise.resolve(modern(key, value));

    return Promise.reject(new Error('ユーザースクリプトの保存APIを利用できません。'));
  }

  function deleteStorageValue(key) {
    storageCache.delete(key);

    const legacy = getLegacyApi('deleteValue');
    if (legacy) return Promise.resolve(legacy(key));

    const modern = getModernApi('deleteValue');
    if (modern) return Promise.resolve(modern(key));

    return Promise.reject(new Error('ユーザースクリプトの保存APIを利用できません。'));
  }

  async function initializeStorageCache(keys) {
    await Promise.all(
      keys.map(async (key) => {
        const value = await readStorageValue(key, null);
        if (value !== null && value !== undefined) storageCache.set(key, value);
      }),
    );
  }

  async function refreshStorageCache(keys) {
    await Promise.all(
      keys.map(async (key) => {
        const value = await readStorageValue(key, null);
        if (value === null || value === undefined) {
          storageCache.delete(key);
        } else {
          storageCache.set(key, value);
        }
      }),
    );
  }

  function addUserStyle(css) {
    const legacy = getLegacyApi('addStyle');
    if (legacy) return Promise.resolve(legacy(css));

    const modern = getModernApi('addStyle');
    if (modern) return Promise.resolve(modern(css));

    return Promise.reject(new Error('ユーザースクリプトのスタイルAPIを利用できません。'));
  }

  async function openUserScriptTab(url) {
    const legacy = getLegacyApi('openInTab');
    if (legacy) {
      return await legacy(url, {
        active: true,
        insert: true,
        setParent: false,
      });
    }

    const modern = getModernApi('openInTab');
    if (modern) return await modern(url, false);

    throw new Error('ユーザースクリプトのタブAPIを利用できません。');
  }

  function registerMenuCommand(label, callback) {
    const legacy = getLegacyApi('registerMenuCommand');
    if (legacy) return legacy(label, callback);

    const modern = getModernApi('registerMenuCommand');
    if (modern) return modern(label, callback);

    return null;
  }

  function getStoredObject(key) {
    const value = getStorageValue(key, null);
    return parseStoredObject(value);
  }

  function parseStoredObject(value) {
    if (!value) return null;
    if (typeof value === 'string') {
      try {
        return JSON.parse(value);
      } catch (_error) {
        return null;
      }
    }
    return value;
  }

  function isValidOperationId(value) {
    return /^[A-Za-z0-9-]{1,100}$/.test(String(value ?? ''));
  }

  function getOfficialRunId() {
    if (location.hostname !== 'ticket.expo2027yokohama.or.jp') return '';
    try {
      if (!window.name.startsWith(OFFICIAL_RUN_WINDOW_PREFIX)) return '';
      const operationId = window.name.slice(OFFICIAL_RUN_WINDOW_PREFIX.length);
      return isValidOperationId(operationId) ? operationId : '';
    } catch (_error) {
      return '';
    }
  }

  function requestStorageKey(operationId = getOfficialRunId()) {
    return isValidOperationId(operationId)
      ? `${REQUEST_KEY_PREFIX}${operationId}`
      : '';
  }

  function secureJobStorageKey(operationId = getOfficialRunId()) {
    return isValidOperationId(operationId)
      ? `${SECURE_JOB_KEY_PREFIX}${operationId}`
      : '';
  }

  function getRequest(operationId = getOfficialRunId()) {
    const key = requestStorageKey(operationId);
    return key ? getStoredObject(key) : null;
  }

  function setRequest(request) {
    const key = requestStorageKey(request?.id);
    if (!key) return Promise.reject(new Error('予約処理IDが不正です。'));
    return setStorageValue(key, {
      ...request,
      updatedAt: Date.now(),
      scriptVersion: VERSION,
    });
  }

  function getSecureJob(operationId = getOfficialRunId()) {
    const key = secureJobStorageKey(operationId);
    return key ? getStoredObject(key) : null;
  }

  function setSecureJob(job) {
    const key = secureJobStorageKey(job?.requestId);
    if (!key) return Promise.reject(new Error('予約処理IDが不正です。'));
    return setStorageValue(key, {
      ...job,
      updatedAt: Date.now(),
      scriptVersion: VERSION,
    });
  }

  function isFresh(value) {
    if (!value?.createdAt) return false;
    return Date.now() - value.createdAt <= JOB_TTL_MS;
  }

  function normalizeTicketId(value) {
    return String(value ?? '').trim().toUpperCase();
  }

  function isValidTarget(target) {
    if (!target || typeof target !== 'object') return false;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(target.date || '')) return false;
    if (!/^\d{2}:\d{2}$/.test(target.time || '')) return false;
    if (typeof target.status !== 'string' || target.status.length > 100) return false;

    const timestamp = Date.parse(`${target.date}T${target.time}:00+09:00`);
    return Number.isFinite(timestamp);
  }

  function officialDetailUrl(ticketId) {
    const params = new URLSearchParams({ screen_id: '018', id: ticketId });
    return `${OFFICIAL_ORIGIN}/myticket_detail/?${params.toString()}`;
  }

  function removeLegacyMessages() {
    document.getElementById('ge-helper-public-feedback')?.remove();
    document.getElementById('ge-helper-official-banner')?.remove();
    document.getElementById('ge-helper-error-notice')?.remove();
  }

  function removeLegacyMessagesNowAndWhenReady() {
    removeLegacyMessages();
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', removeLegacyMessages, { once: true });
    }
  }

  async function removeExpiredData(includeSecureJob) {
    const request = getRequest();
    const requestKey = requestStorageKey();
    const secureKey = secureJobStorageKey();
    if (request && !isFresh(request) && requestKey) {
      await deleteStorageValue(requestKey);
    }

    if (!includeSecureJob) return;
    const job = getSecureJob();
    if (job && !isFresh(job) && secureKey) {
      await deleteStorageValue(secureKey);
    }
  }

  async function removeExpiredOrphanedOperations(
    excludedOperationId = getOfficialRunId(),
  ) {
    if (location.hostname !== 'ticket.expo2027yokohama.or.jp') return;

    const keys = await listStorageKeys();
    if (!Array.isArray(keys)) return;

    const operationIds = new Set();
    for (const key of keys) {
      if (typeof key !== 'string') continue;
      const prefix = key.startsWith(REQUEST_KEY_PREFIX)
        ? REQUEST_KEY_PREFIX
        : key.startsWith(SECURE_JOB_KEY_PREFIX)
          ? SECURE_JOB_KEY_PREFIX
          : '';
      if (!prefix) continue;

      const operationId = key.slice(prefix.length);
      if (
        operationId !== excludedOperationId &&
        isValidOperationId(operationId)
      ) {
        operationIds.add(operationId);
      }
    }

    for (const operationId of operationIds) {
      const requestKey = requestStorageKey(operationId);
      const secureKey = secureJobStorageKey(operationId);
      const [requestValue, secureValue] = await Promise.all([
        readStorageValue(requestKey, null),
        readStorageValue(secureKey, null),
      ]);
      const records = [requestValue, secureValue]
        .filter((value) => value !== null && value !== undefined)
        .map(parseStoredObject);

      // 片方でも有効な処理情報があれば、その処理IDには一切触れない。
      if (!records.length || records.some((record) => isFresh(record))) continue;

      await clearOperationById(operationId);
    }
  }

  function clearOfficialRunToken() {
    if (location.hostname !== 'ticket.expo2027yokohama.or.jp') return;
    try {
      if (window.name.startsWith(OFFICIAL_RUN_WINDOW_PREFIX)) window.name = '';
    } catch (_error) {
      // タブ識別情報を消去できない環境でも、保存領域の処理情報は消去する。
    }
  }

  function hasOfficialRunToken() {
    if (location.hostname !== 'ticket.expo2027yokohama.or.jp') return false;
    try {
      return window.name.startsWith(OFFICIAL_RUN_WINDOW_PREFIX);
    } catch (_error) {
      return false;
    }
  }

  function stopOfficialRouteWatcher() {
    if (officialRouteTimer === null) return;
    window.clearInterval(officialRouteTimer);
    officialRouteTimer = null;
  }

  function clearCurrentOperation() {
    const operationId = getOfficialRunId();
    clearOfficialRunToken();
    stopOfficialRouteWatcher();
    activeTicketPanelCleanup?.(false);
    if (!operationId) return Promise.resolve([]);
    return Promise.all([
      deleteStorageValue(requestStorageKey(operationId)),
      deleteStorageValue(secureJobStorageKey(operationId)),
    ]);
  }

  function clearOperationById(operationId) {
    if (!isValidOperationId(operationId)) return Promise.resolve([]);
    return Promise.all([
      deleteStorageValue(requestStorageKey(operationId)),
      deleteStorageValue(secureJobStorageKey(operationId)),
    ]);
  }

  function initializeOfficialRunToken() {
    if (location.hostname !== 'ticket.expo2027yokohama.or.jp') return;
    if (!location.hash.startsWith(OFFICIAL_RUN_HASH_PREFIX)) return;

    let token = '';
    try {
      token = decodeURIComponent(
        location.hash.slice(OFFICIAL_RUN_HASH_PREFIX.length),
      );
    } catch (_error) {
      return;
    }
    if (!isValidOperationId(token)) return;

    try {
      window.name = `${OFFICIAL_RUN_WINDOW_PREFIX}${token}`;
    } catch (_error) {
      // 所有タブを識別できなければ、このタブでは予約処理を開始しない。
    }
  }

  function isOfficialRunOwner(request = getRequest()) {
    if (location.hostname !== 'ticket.expo2027yokohama.or.jp') return false;
    if (!request?.id) return false;
    try {
      return window.name === `${OFFICIAL_RUN_WINDOW_PREFIX}${request.id}`;
    } catch (_error) {
      return false;
    }
  }

  function registerPrivateMenuCommands() {
    if (!getLegacyApi('registerMenuCommand') && !getModernApi('registerMenuCommand')) {
      return;
    }

    try {
      registerMenuCommand('チケットIDを設定・変更', () => {
        if (location.hostname === 'ticket.expo2027yokohama.or.jp') {
          showTicketIdPanel();
          return;
        }
        openOfficialTicketSettingPage();
      });

      registerMenuCommand('保存したチケットIDを消去', async () => {
        await deleteStorageValue(TICKET_ID_KEY);
      });

    } catch (error) {
      console.warn(`[${SCRIPT_NAME}] Tampermonkeyメニューを登録できませんでした。`, error);
    }
  }

  function addPenguStyles() {
    return addUserStyle(`
      #ge-helper-public-feedback,
      #ge-helper-official-banner,
      #ge-helper-error-notice {
        display: none !important;
      }
      td[title*="余裕あり"] img.visiting-status-image,
      td[title*="残りわずか"] img.visiting-status-image {
        cursor: pointer !important;
      }
    `);
  }

  function parseSlotTitle(title) {
    const match = normalizeText(title).match(
      /^(\d{4}-\d{2}-\d{2})\s+(\d{1,2}:\d{2})\s+(.+)$/,
    );
    if (!match) return null;

    const target = {
      date: match[1],
      time: match[2].padStart(5, '0'),
      status: match[3],
    };
    return isValidTarget(target) ? target : null;
  }

  async function openOfficialStartPage(requestId) {
    try {
      const runHash = `${OFFICIAL_RUN_HASH_PREFIX}${encodeURIComponent(requestId)}`;
      await openUserScriptTab(`${OFFICIAL_ORIGIN}/${runHash}`);
      return true;
    } catch (_error) {
      try {
        await clearOperationById(requestId);
      } catch (_cleanupError) {
        // Tampermonkey保存領域自体の障害はコンソールだけに記録する。
      }
      console.error(`[${SCRIPT_NAME}] 公式サイトのタブを開けませんでした。`, _error);
      return false;
    }
  }

  async function openOfficialTicketSettingPage() {
    try {
      await openUserScriptTab(`${OFFICIAL_ORIGIN}/#ge-helper-ticket-setting`);
    } catch (error) {
      console.error(`[${SCRIPT_NAME}] チケットID設定画面を開けませんでした。`, error);
    }
  }

  async function handlePenguIconClick(event) {
    // Pengu側スクリプトが生成した合成イベントでは処理を開始しない。
    if (!event.isTrusted) return;

    const image = event.target?.closest?.('img.visiting-status-image');
    if (!image) return;

    const target = parseSlotTitle(image.closest('td[title]')?.getAttribute('title'));
    if (!target || !AVAILABLE_STATUS_PATTERN.test(target.status)) return;

    event.preventDefault();
    event.stopImmediatePropagation();

    const request = {
      id: makeId(),
      createdAt: Date.now(),
      target,
    };
    const targetKey = `${target.date} ${target.time}`;
    const now = Date.now();
    if (
      now - (lastPenguClickByTarget.get(targetKey) || 0) <
      PENGU_CLICK_DEBOUNCE_MS
    ) {
      return;
    }
    lastPenguClickByTarget.set(targetKey, now);

    // Pengu側では、公開されている希望日時だけを保存する。
    // チケットID・現在の予約・氏名等は読み取らず、DOMにも出さない。
    try {
      await setRequest(request);
    } catch (error) {
      console.error(`[${SCRIPT_NAME}] 変更先を保存できませんでした。`, error);
      try {
        await clearOperationById(request.id);
      } catch (_cleanupError) {
        // Tampermonkey保存領域自体の障害はコンソールだけに記録する。
      }
      return;
    }

    await openOfficialStartPage(request.id);
    window.setTimeout(() => {
      void clearOperationById(request.id).catch((error) => {
        console.error(`[${SCRIPT_NAME}] 期限切れの予約処理を消去できませんでした。`, error);
      });
    }, JOB_TTL_MS + 250);
  }

  function runOnPengu() {
    removeLegacyMessagesNowAndWhenReady();
    // 隔離環境のwindowではなく、共有されるdocumentへ登録する。
    document.addEventListener('click', handlePenguIconClick, true);
    try {
      void addPenguStyles().catch((error) => {
        console.warn(`[${SCRIPT_NAME}] クリック可能表示のスタイルを追加できませんでした。`, error);
      });
    } catch (error) {
      console.warn(`[${SCRIPT_NAME}] クリック可能表示のスタイルを追加できませんでした。`, error);
    }
  }

  function addOfficialStyles() {
    return addUserStyle(`
      #ge-helper-public-feedback,
      #ge-helper-official-banner,
      #ge-helper-error-notice {
        display: none !important;
      }
      #ge-helper-ticket-overlay {
        position: fixed;
        inset: 0;
        z-index: 2147483647;
        display: grid;
        place-items: center;
        box-sizing: border-box;
        padding: 20px;
        background: rgba(0, 0, 0, 0.48);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      #ge-helper-ticket-panel {
        width: min(520px, 100%);
        box-sizing: border-box;
        border: 2px solid #0876b9;
        border-radius: 14px;
        padding: 22px;
        color: #102a3a;
        background: #fff;
        box-shadow: 0 18px 50px rgba(0, 0, 0, 0.3);
      }
      #ge-helper-ticket-panel h2 {
        margin: 0 0 10px;
        font-size: 22px;
      }
      #ge-helper-ticket-panel p {
        margin: 0 0 14px;
        line-height: 1.6;
      }
      #ge-helper-ticket-input {
        width: 100%;
        box-sizing: border-box;
        border: 2px solid #777;
        border-radius: 8px;
        padding: 11px 12px;
        font: inherit;
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }
      #ge-helper-ticket-actions {
        display: flex;
        flex-wrap: wrap;
        justify-content: flex-end;
        gap: 10px;
        margin-top: 12px;
      }
      #ge-helper-ticket-actions button {
        border: 2px solid #0876b9;
        border-radius: 8px;
        padding: 9px 16px;
        color: #0876b9;
        background: #fff;
        font: inherit;
        font-weight: 700;
        cursor: pointer;
      }
      #ge-helper-ticket-actions button[type="submit"] {
        color: #fff;
        background: #0876b9;
      }
      #ge-helper-delete-ticket-id {
        margin-right: auto;
        border-color: #777 !important;
        color: #444 !important;
      }
      #ge-helper-ticket-settings-button {
        position: fixed;
        right: 16px;
        bottom: 76px;
        z-index: 2147483645;
        border: 2px solid #0876b9;
        border-radius: 10px;
        padding: 9px 13px;
        color: #0876b9;
        background: #fff;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        font-size: 14px;
        font-weight: 700;
        cursor: pointer;
      }
      #ge-helper-stop-button {
        position: fixed;
        right: 16px;
        bottom: 16px;
        z-index: 2147483646;
        border: 2px solid #b00020;
        border-radius: 10px;
        padding: 11px 16px;
        color: #7d0017;
        background: #fff;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.2);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        font-size: 16px;
        font-weight: 700;
        cursor: pointer;
      }
    `);
  }

  function hideStopButton() {
    document.getElementById('ge-helper-stop-button')?.remove();
  }

  function showStopButton() {
    if (!document.documentElement || document.getElementById('ge-helper-stop-button')) {
      return;
    }

    const button = document.createElement('button');
    button.id = 'ge-helper-stop-button';
    button.type = 'button';
    button.textContent = '予約作業停止';
    button.addEventListener('click', () => {
      stopCurrentOperationSilently();
    });
    document.documentElement.appendChild(button);
  }

  function showTicketSettingsButton() {
    if (
      !document.documentElement ||
      isOfficialLoginPage() ||
      location.pathname.startsWith('/system_error') ||
      document.getElementById('ge-helper-ticket-settings-button')
    ) {
      return;
    }

    const button = document.createElement('button');
    button.id = 'ge-helper-ticket-settings-button';
    button.type = 'button';
    button.textContent = 'チケットID設定';
    button.addEventListener('click', (event) => {
      if (!event.isTrusted) return;
      showTicketIdPanel();
    });
    document.documentElement.appendChild(button);
  }

  function stopCurrentOperationSilently() {
    activeTicketPanelCleanup?.(false);
    const cleanup = clearCurrentOperation();
    hideStopButton();
    removeLegacyMessages();
    return cleanup;
  }

  function showTicketIdPanel(options = {}) {
    const titleText =
      typeof options.title === 'string' && options.title
        ? options.title
        : 'チケットIDを入力してください';
    const initialTicketId = normalizeTicketId(
      options.initialTicketId ?? getStorageValue(TICKET_ID_KEY, ''),
    );

    if (!document.documentElement) {
      document.addEventListener(
        'DOMContentLoaded',
        () => showTicketIdPanel(options),
        { once: true },
      );
      return;
    }

    const existing = document.getElementById('ge-helper-ticket-overlay');
    if (existing) {
      const existingTitle = existing.querySelector('#ge-helper-ticket-title');
      if (existingTitle) existingTitle.textContent = titleText;
      const existingInput = existing.querySelector('#ge-helper-ticket-input');
      if (existingInput && !existingInput.value) {
        existingInput.value = initialTicketId;
      }
      existingInput?.focus();
      return;
    }

    const overlay = document.createElement('div');
    overlay.id = 'ge-helper-ticket-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'ge-helper-ticket-title');

    const panel = document.createElement('form');
    panel.id = 'ge-helper-ticket-panel';

    const title = document.createElement('h2');
    title.id = 'ge-helper-ticket-title';
    title.textContent = titleText;

    const description = document.createElement('p');
    description.textContent =
      'pengu.infoなど外部へのチケットIDの送信は行われません。';

    const input = document.createElement('input');
    input.id = 'ge-helper-ticket-input';
    input.name = 'ticket-id';
    input.type = 'text';
    input.inputMode = 'text';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.placeholder = 'チケットID';
    input.setAttribute('aria-label', 'チケットID');
    input.value = initialTicketId;

    const actions = document.createElement('div');
    actions.id = 'ge-helper-ticket-actions';

    const cancelButton = document.createElement('button');
    cancelButton.type = 'button';
    cancelButton.textContent = '閉じる';

    const saveButton = document.createElement('button');
    saveButton.type = 'submit';
    saveButton.textContent = 'このIDを使用する';

    const deleteButton = document.createElement('button');
    deleteButton.id = 'ge-helper-delete-ticket-id';
    deleteButton.type = 'button';
    deleteButton.textContent = '保存したチケットIDを消去';
    deleteButton.hidden = !normalizeTicketId(getStorageValue(TICKET_ID_KEY, ''));

    actions.append(deleteButton, cancelButton, saveButton);
    panel.append(title, description, input, actions);
    overlay.appendChild(panel);
    document.documentElement.appendChild(overlay);

    let settled = false;
    const finishPanel = (clearOperation) => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', handleEscape, true);
      window.removeEventListener('pagehide', handlePageHide, true);
      overlay.remove();
      if (activeTicketPanelCleanup === finishPanel) {
        activeTicketPanelCleanup = null;
      }
      if (clearOperation) {
        void clearCurrentOperation().catch((error) => {
          console.error(`[${SCRIPT_NAME}] 予約処理情報を消去できませんでした。`, error);
        });
        hideStopButton();
      }
    };
    const cancelTicketInput = () => finishPanel(true);
    const handleEscape = (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      cancelTicketInput();
    };
    const handlePageHide = () => cancelTicketInput();

    activeTicketPanelCleanup = finishPanel;
    document.addEventListener('keydown', handleEscape, true);
    window.addEventListener('pagehide', handlePageHide, true);
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) cancelTicketInput();
    });
    cancelButton.addEventListener('click', cancelTicketInput);
    deleteButton.addEventListener('click', async (event) => {
      if (!event.isTrusted) return;
      try {
        await deleteStorageValue(TICKET_ID_KEY);
        finishPanel(true);
      } catch (error) {
        console.error(`[${SCRIPT_NAME}] チケットIDを消去できませんでした。`, error);
      }
    });

    panel.addEventListener('submit', async (event) => {
      event.preventDefault();
      const ticketId = normalizeTicketId(input.value);
      if (!ticketId) {
        input.focus();
        return;
      }

      await setStorageValue(TICKET_ID_KEY, ticketId);
      input.value = '';
      finishPanel(false);

      const job = await getActiveSecureJob();
      if (job) {
        const next = { ...job, ticketId, phase: 'navigating-detail' };
        await setSecureJob(next);
        location.replace(officialDetailUrl(ticketId));
        return;
      }

    });

    window.setTimeout(() => input.focus(), 0);
  }

  function failJob(job, message, details = '') {
    if (!isCurrentOperation(job)) {
      hideStopButton();
      removeLegacyMessages();
      return;
    }
    stopCurrentOperationSilently();
    console.error(`[${SCRIPT_NAME}] ${message}`, details);
  }

  function isCurrentOperation(job) {
    const request = getRequest();
    const currentJob = getSecureJob();
    return Boolean(
      job?.requestId &&
        request?.id === job.requestId &&
        currentJob?.requestId === job.requestId &&
        isFresh(request) &&
        isFresh(currentJob),
    );
  }

  function ensureOperationIsActive(job) {
    if (!isCurrentOperation(job)) {
      throw new Error('予約作業は停止されています。');
    }
  }

  async function waitFor(getValue, options = {}) {
    const timeout = options.timeout ?? 20_000;
    const interval = options.interval ?? 200;
    const startedAt = Date.now();
    let lastError = null;

    while (Date.now() - startedAt < timeout) {
      try {
        const value = getValue();
        if (value) return value;
      } catch (error) {
        lastError = error;
      }
      await sleep(interval);
    }

    const error = new Error(options.message || '画面の読み込みを確認できませんでした。');
    if (lastError) error.cause = lastError;
    throw error;
  }

  function parseJapaneseDateTime(text) {
    const match = normalizeText(text).match(
      /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日[^0-9]*(\d{1,2}:\d{2})/,
    );
    if (!match) return null;

    const date = `${match[1]}-${pad2(match[2])}-${pad2(match[3])}`;
    const time = match[4].padStart(5, '0');
    return {
      date,
      time,
      key: `${date} ${time}`,
    };
  }

  function getButtonByMessageCode(messageCode) {
    return document
      .querySelector(`[data-message-code="${messageCode}"]`)
      ?.closest('button');
  }

  function getButtonByExactText(text) {
    return [...document.querySelectorAll('button')].find(
      (button) => normalizeText(button.textContent) === text,
    );
  }

  function findReservationRows() {
    const results = [];
    const changeMarkers = document.querySelectorAll(
      `[data-message-code="${CHANGE_MESSAGE_CODE}"]`,
    );

    for (const marker of changeMarkers) {
      const button = marker.closest('button');
      if (!button || button.disabled) continue;

      let container = button.parentElement;
      for (let depth = 0; container && depth < 6; depth += 1) {
        const parsed = parseJapaneseDateTime(container.textContent);
        const changes = container.querySelectorAll(
          `[data-message-code="${CHANGE_MESSAGE_CODE}"]`,
        ).length;
        if (parsed && changes === 1) {
          results.push({ ...parsed, button });
          break;
        }
        container = container.parentElement;
      }
    }

    return results.filter(
      (item, index, array) =>
        array.findIndex((other) => other.key === item.key) === index,
    );
  }

  function findNewReservationButtons() {
    const candidates = [];
    const markers = document.querySelectorAll(
      `[data-message-code="${RESERVE_MESSAGE_CODE}"]`,
    );

    for (const marker of markers) {
      const button = marker.closest('button');
      if (button && !button.disabled) candidates.push(button);
    }

    for (const button of document.querySelectorAll('button')) {
      if (
        !button.disabled &&
        normalizeText(button.textContent) === '来場日時予約'
      ) {
        candidates.push(button);
      }
    }

    return [...new Set(candidates)].filter((button) => {
      // ヘッダーにも同名の「来場日時予約」メニューがあるため、
      // 予約状況の「設定されていません」と同じ枠内にあるボタンだけを採用する。
      if (button.closest('header, nav, [role="navigation"]')) return false;

      let container = button.parentElement;
      for (let depth = 0; container && depth < 7; depth += 1) {
        const text = normalizeText(container.textContent);
        const reserveButtonCount = [...container.querySelectorAll('button')].filter(
          (candidate) => normalizeText(candidate.textContent) === '来場日時予約',
        ).length;
        if (text.includes('設定されていません') && reserveButtonCount === 1) {
          return true;
        }
        container = container.parentElement;
      }
      return false;
    });
  }

  function getDisplayedTicketId() {
    const match = normalizeText(document.body?.innerText).match(
      /チケットID\s*[:：]?\s*([A-Z0-9-]{8,32})/i,
    );
    return normalizeTicketId(match?.[1]);
  }

  function getTicketIdFromOfficialUrl() {
    if (location.origin !== OFFICIAL_ORIGIN) return '';
    return normalizeTicketId(new URL(location.href).searchParams.get('id'));
  }

  function verifyOfficialTicket(job) {
    const urlTicketId = getTicketIdFromOfficialUrl();
    const displayedTicketId = getDisplayedTicketId();
    const expected = normalizeTicketId(job.ticketId);

    if (urlTicketId && urlTicketId !== expected) {
      throw new Error('開いたチケットIDが保存済みのIDと一致しません。');
    }
    if (displayedTicketId && displayedTicketId !== expected) {
      throw new Error('表示されたチケットIDが保存済みのIDと一致しません。');
    }
  }

  async function getActiveSecureJob() {
    const operationId = getOfficialRunId();
    const requestKey = requestStorageKey(operationId);
    const secureKey = secureJobStorageKey(operationId);
    if (!operationId || !requestKey || !secureKey) return null;

    const request = getRequest();
    if (!request || !isFresh(request) || !isValidTarget(request.target)) {
      if (request) await deleteStorageValue(requestKey);
      await deleteStorageValue(secureKey);
      clearOfficialRunToken();
      return null;
    }

    // Penguから今回開いた公式タブだけが、共有されている予約処理を進める。
    // 以前から開いている公式タブや設定用タブは処理状態に触れない。
    if (!isOfficialRunOwner(request)) return null;

    let job = getSecureJob();
    if (!job || !isFresh(job) || job.requestId !== request.id) {
      job = {
        requestId: request.id,
        createdAt: request.createdAt,
        target: request.target,
        phase: 'start-official',
      };
      await setSecureJob(job);
    }
    return job;
  }

  async function startOnOfficialSite(job) {
    const storedTicketId = normalizeTicketId(getStorageValue(TICKET_ID_KEY, ''));

    if (storedTicketId) {
      activeTicketPanelCleanup?.(false);
      const next = { ...job, ticketId: storedTicketId, phase: 'navigating-detail' };
      await setSecureJob(next);
      location.replace(officialDetailUrl(storedTicketId));
      return null;
    }

    if (job.phase !== 'awaiting-ticket') {
      await setSecureJob({ ...job, phase: 'awaiting-ticket' });
    }
    showTicketIdPanel();
    return null;
  }

  async function prepareReservationSelection(job) {
    await waitFor(
      () =>
        document.querySelector(`[data-message-code="${CHANGE_MESSAGE_CODE}"]`) ||
        findNewReservationButtons().length > 0,
      { message: 'チケット詳細の読み込みを確認できませんでした。' },
    );

    ensureOperationIsActive(job);
    verifyOfficialTicket(job);
    const rows = findReservationRows();
    const sameDateRows = rows.filter((row) => row.date === job.target.date);

    if (sameDateRows.length === 1) {
      const row = sameDateRows[0];
      const next = {
        ...job,
        phase: 'selecting-date',
      };
      await setSecureJob(next);
      row.button.click();
      return;
    }

    if (sameDateRows.length > 1) {
      return;
    }

    const newReservationButton = findNewReservationButtons()[0];
    if (newReservationButton) {
      const next = {
        ...job,
        phase: 'selecting-date',
      };
      await setSecureJob(next);
      newReservationButton.click();
      return;
    }

    if (!rows.length) {
      throw new Error('変更できる予約日時が見つかりませんでした。');
    }

  }

  async function handleOfficialChangeButtonClick(event) {
    const button = event.target?.closest?.('button');
    if (!button?.querySelector(`[data-message-code="${CHANGE_MESSAGE_CODE}"]`)) {
      return;
    }

    const job = getSecureJob();
    if (!job || job.phase !== 'select-reservation' || !isFresh(job)) return;

    const row = findReservationRows().find((item) => item.button === button);
    if (!row) {
      event.preventDefault();
      event.stopImmediatePropagation();
      failJob(job, '押された「変更」ボタンの予約日時を確認できませんでした。');
      return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();
    await setSecureJob({
      ...job,
      phase: 'selecting-date',
    });
    button.click();
  }

  function getCurrentCalendarMonth() {
    const element = [...document.querySelectorAll('span,div,p')].find((candidate) =>
      /^\d{4}年\d{1,2}月$/.test(normalizeText(candidate.textContent)),
    );
    const match = normalizeText(element?.textContent).match(
      /^(\d{4})年(\d{1,2})月$/,
    );
    if (!match) return null;
    return { year: Number(match[1]), month: Number(match[2]) };
  }

  async function moveCalendarTo(targetDate, job) {
    const [targetYear, targetMonth] = targetDate.split('-').map(Number);
    const targetIndex = targetYear * 12 + targetMonth;

    for (let attempt = 0; attempt < 18; attempt += 1) {
      ensureOperationIsActive(job);
      const current = getCurrentCalendarMonth();
      if (!current) throw new Error('表示中の年月を判定できません。');
      const currentIndex = current.year * 12 + current.month;
      if (currentIndex === targetIndex) return;

      const button = getButtonByExactText(
        currentIndex < targetIndex ? '次の月' : '前の月',
      );
      if (!button || button.disabled) {
        throw new Error('指定した年月へ移動できません。');
      }

      const before = `${current.year}-${current.month}`;
      button.click();
      await waitFor(
        () => {
          const updated = getCurrentCalendarMonth();
          return updated && `${updated.year}-${updated.month}` !== before;
        },
        { timeout: 6_000, message: '月の切り替えが完了しませんでした。' },
      );
      ensureOperationIsActive(job);
    }

    throw new Error('指定した月が予約可能期間の外です。');
  }

  function findTimeRadio(targetDate, targetTime) {
    const radios = [...document.querySelectorAll('input[type="radio"]')].filter(
      (radio) => radio.name === `selectTime${targetDate}`,
    );
    return radios.find((radio) => {
      const ids = (radio.getAttribute('aria-labelledby') || '')
        .split(/\s+/)
        .filter(Boolean);
      const labelText = ids
        .map((id) => document.getElementById(id)?.textContent || '')
        .join(' ');
      return normalizeText(labelText).startsWith(targetTime);
    });
  }

  function verifyConfirmationSummary(finalButton, target) {
    let container = finalButton.parentElement;
    for (let depth = 0; container && depth < 7; depth += 1) {
      const text = normalizeText(container.textContent);
      const hasHeading = text.includes('変更内容の確認');
      const parsed = parseJapaneseDateTime(text);
      if (hasHeading && parsed) {
        return parsed.date === target.date && parsed.time === target.time;
      }
      container = container.parentElement;
    }
    return false;
  }

  function handleReservationCloseControlClick(event) {
    if (!hasOfficialRunToken()) return;
    const control = event.target?.closest?.(
      'button, a[role="button"], [role="button"]',
    );
    if (!control) return;

    const isCloseControl = [
      control.textContent,
      control.getAttribute('aria-label'),
      control.getAttribute('title'),
      control.querySelector('img[alt]')?.getAttribute('alt'),
    ].some((value) => normalizeText(value) === '閉じる');
    if (!isCloseControl) return;

    const confirmationDialog = control.closest('[role="dialog"]');
    const finalButton = confirmationDialog
      ?.querySelector(`[data-message-code="${FINAL_CONFIRM_MESSAGE_CODE}"]`)
      ?.closest('button');
    if (!finalButton) return;

    void stopCurrentOperationSilently().catch((error) => {
      console.error(`[${SCRIPT_NAME}] 予約処理情報を消去できませんでした。`, error);
    });
  }

  async function automateDateAndTime(job) {
    await waitFor(() => document.querySelector('time[datetime]'), {
      message: '来場日カレンダーを読み込めませんでした。',
    });
    ensureOperationIsActive(job);

    await moveCalendarTo(job.target.date, job);
    ensureOperationIsActive(job);

    const dateElement = document.querySelector(
      `time[datetime="${job.target.date}"]`,
    );
    const dateButton = dateElement?.closest('[role="button"]');
    if (!dateButton || dateButton.dataset.pointerNone === 'true') {
      throw new Error('指定した日付は公式サイトで選択できません。');
    }
    ensureOperationIsActive(job);
    dateButton.click();

    const radio = await waitFor(
      () => findTimeRadio(job.target.date, job.target.time),
      { message: '指定した時間帯を公式サイトで確認できませんでした。' },
    );
    ensureOperationIsActive(job);
    if (radio.disabled) {
      throw new Error('指定した時間帯は公式サイトでは満員または選択不可です。');
    }
    radio.click();

    const nextButton = await waitFor(
      () => {
        const button = getButtonByMessageCode(NEXT_MESSAGE_CODE);
        return button && !button.disabled ? button : null;
      },
      { message: '時間帯選択後の「次に進む」ボタンを押せませんでした。' },
    );
    ensureOperationIsActive(job);
    nextButton.click();

    const finalButton = await waitFor(
      () => getButtonByMessageCode(FINAL_CONFIRM_MESSAGE_CODE),
      { message: '公式サイトの最終確認画面を表示できませんでした。' },
    );
    ensureOperationIsActive(job);
    if (!verifyConfirmationSummary(finalButton, job.target)) {
      throw new Error('公式サイトの最終確認日時が選択内容と一致しません。');
    }

    await setSecureJob({ ...job, phase: 'awaiting-final-confirmation' });
    finalButton.style.outline = '4px solid #e66a00';
    finalButton.style.outlineOffset = '4px';
    finalButton.addEventListener(
      'click',
      stopCurrentOperationSilently,
      { once: true },
    );
  }

  function isOfficialNotFoundPage() {
    const title = normalizeText(document.title);
    const heading = normalizeText(
      document.querySelector('main h1, main h2, h1, h2')?.textContent,
    );
    const body = normalizeText(document.body?.innerText);
    return (
      title.includes('404') ||
      heading.includes('404') ||
      body.includes('404 Not Found') ||
      body.includes('ご指定のページが見つかりません') ||
      title.includes('ページが見つかりません') ||
      heading.includes('ページが見つかりません') ||
      body.includes('ページが見つかりません')
    );
  }

  function isOfficialLoginPage() {
    return location.pathname === '/login' || location.pathname.startsWith('/login/');
  }

  async function stopForIncorrectTicketId() {
    const incorrectTicketId = normalizeTicketId(
      getStorageValue(TICKET_ID_KEY, ''),
    );
    await deleteStorageValue(TICKET_ID_KEY);
    await stopCurrentOperationSilently();
    showTicketIdPanel({
      title: '正しいチケットIDを入力してください',
      initialTicketId: incorrectTicketId,
    });
  }

  async function processTicketRoute() {
    if (isOfficialLoginPage()) {
      await stopCurrentOperationSilently();
      return;
    }

    if (isOfficialNotFoundPage()) {
      if (hasOfficialRunToken()) {
        await stopForIncorrectTicketId();
      }
      return;
    }

    if (ticketRouteRunning) return;
    ticketRouteRunning = true;
    let job = null;

    try {
      // 予約処理の状態はタブごとの古いキャッシュを使わず、毎回共有保存領域から確認する。
      const requestKey = requestStorageKey();
      const secureKey = secureJobStorageKey();
      if (!requestKey || !secureKey) {
        hideStopButton();
        stopOfficialRouteWatcher();
        return;
      }
      await refreshStorageCache([requestKey, secureKey, TICKET_ID_KEY]);

      job = await getActiveSecureJob();
      if (!job) {
        hideStopButton();
        activeTicketPanelCleanup?.(false);
        if (!isOfficialRunOwner()) {
          clearOfficialRunToken();
          stopOfficialRouteWatcher();
        }
        return;
      }
      showStopButton();

      const signature = `${location.pathname}${location.search}|${job.requestId}|${job.phase}|${job.updatedAt}`;
      if (signature === lastTicketRouteSignature) return;
      lastTicketRouteSignature = signature;

      if (location.pathname === '/system_error/') {
        const code = new URLSearchParams(location.search).get('code') || '不明';
        failJob(job, `公式サイトでエラーが発生しました（${code}）。`);
        return;
      }

      if (['start-official', 'awaiting-ticket'].includes(job.phase)) {
        await startOnOfficialSite(job);
        return;
      }

      if (job.phase === 'navigating-detail') {
        if (location.pathname !== '/myticket_detail/') {
          location.replace(officialDetailUrl(job.ticketId));
          return;
        }
        verifyOfficialTicket(job);
        const next = { ...job, phase: 'select-reservation' };
        await setSecureJob(next);
        await prepareReservationSelection(next);
        return;
      }

      if (job.phase === 'select-reservation') {
        if (location.pathname !== '/myticket_detail/') {
          location.replace(officialDetailUrl(job.ticketId));
          return;
        }
        await prepareReservationSelection(job);
        return;
      }

      if (location.pathname === '/date_reservation_select/') {
        if (job.phase === 'selecting-date') {
          await automateDateAndTime(job);
        }
        return;
      }

      if (
        location.pathname === '/date_reservation_end/' &&
        job.phase === 'awaiting-final-confirmation'
      ) {
        await clearCurrentOperation();
        hideStopButton();
        return;
      }

    } catch (error) {
      if (job) {
        failJob(
          job,
          error?.message || '自動操作中にエラーが発生しました。',
          error?.stack || '',
        );
      } else {
        hideStopButton();
        console.error(`[${SCRIPT_NAME}] 予約処理の状態を確認できませんでした。`, error);
      }
    } finally {
      ticketRouteRunning = false;
    }
  }

  function startOfficialRouteWatcher() {
    if (officialRouteTimer !== null || !hasOfficialRunToken()) return;
    processTicketRoute();
    officialRouteTimer = window.setInterval(processTicketRoute, 500);
  }

  function runOnOfficialSite() {
    removeLegacyMessagesNowAndWhenReady();
    if (isOfficialLoginPage()) {
      if (isOfficialRunOwner()) {
        void stopCurrentOperationSilently().catch((error) => {
          console.error(`[${SCRIPT_NAME}] 予約処理情報を消去できませんでした。`, error);
        });
      }
      return;
    }
    try {
      void addOfficialStyles().catch((error) => {
        console.warn(`[${SCRIPT_NAME}] 公式サイト用の案内スタイルを追加できませんでした。`, error);
      });
    } catch (error) {
      console.warn(`[${SCRIPT_NAME}] 公式サイト用の案内スタイルを追加できませんでした。`, error);
    }
    document.addEventListener('click', handleOfficialChangeButtonClick, true);
    document.addEventListener('click', handleReservationCloseControlClick, true);

    if (document.readyState === 'loading') {
      document.addEventListener(
        'DOMContentLoaded',
        () => {
          showTicketSettingsButton();
          if (location.hash === '#ge-helper-ticket-setting') showTicketIdPanel();
          startOfficialRouteWatcher();
        },
        { once: true },
      );
    } else {
      showTicketSettingsButton();
      if (location.hash === '#ge-helper-ticket-setting') showTicketIdPanel();
      startOfficialRouteWatcher();
    }
  }

  if (location.hostname === 'ticket.expo2027yokohama.or.jp') {
    initializeOfficialRunToken();
  }

  const initialStorageKeys = [];
  if (location.hostname === 'ticket.expo2027yokohama.or.jp') {
    initialStorageKeys.push(TICKET_ID_KEY);
    const requestKey = requestStorageKey();
    const secureKey = secureJobStorageKey();
    if (requestKey) initialStorageKeys.push(requestKey);
    if (secureKey) initialStorageKeys.push(secureKey);
  }
  await initializeStorageCache(initialStorageKeys);

  try {
    await Promise.all(LEGACY_STORAGE_KEYS.map((key) => deleteStorageValue(key)));
  } catch (error) {
    console.warn(`[${SCRIPT_NAME}] 旧処理データを整理できませんでした。`, error);
  }

  if (location.hostname === 'expo.pengu.info') {
    // 任意機能が失敗しても、クリック処理だけは先に有効化する。
    runOnPengu();
    registerPrivateMenuCommands();
  } else if (location.hostname === 'ticket.expo2027yokohama.or.jp') {
    try {
      await removeExpiredData(true);
    } catch (error) {
      console.warn(`[${SCRIPT_NAME}] 処理データを整理できませんでした。`, error);
    }
    registerPrivateMenuCommands();
    runOnOfficialSite();
    const currentOperationId = getOfficialRunId();
    window.setTimeout(() => {
      void removeExpiredOrphanedOperations(currentOperationId).catch((error) => {
        console.warn(`[${SCRIPT_NAME}] 期限切れの残留データを整理できませんでした。`, error);
      });
    }, 0);
  }
})().catch((error) => {
  console.error('[GREEN×EXPO 2027 来場日時予約ヘルパー] 初期化できませんでした。', error);
});
