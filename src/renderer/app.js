'use strict';

const api = window.launcher;

const NAME_RE = /^[A-Za-z0-9_]{2,16}$/;
const MAX_LOG_LINES = 650;

const state = {
  config: null,
  limits: { min: 1024, max: 16384, totalMb: 8192, step: 512 },
  manifest: null,
  localVersions: [],
  selectedId: null,
  autoSelected: true,
  details: null,
  detailsLoading: false,
  detailsError: null,
  infoToken: 0,
  filter: 'release',
  query: '',
  game: { status: 'idle' },
  progress: null,
  manifestLoading: false,
  refreshPromise: null,
  offline: false,
  consoleOpen: false,
  appVersion: '1.0.0',
  paths: {},
  settingsOpen: false,
  emptyAction: 'retry',
  refreshTimer: null,
  detailsTimer: null,
  javaCandidates: [],
  javaCandidatesLoaded: false,
  javaListLoading: false,
  javaDetectToken: 0,
  javaDetectTimer: null,
  loaders: {
    open: false,
    installing: false,
    kind: null,
    token: 0,
    loadedFor: '',
    timer: null,
  },
  skin: {
    loaded: false,
    loading: false,
    data: null,
    undo: [],
    redo: [],
    tool: 'pencil',
    color: '#4fc3f7',
    drawing: false,
    last: null,
    dirty: false,
  },
  skinOpen: false,
};

const els = {};

const dateFormatter = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

const timeFormatter = new Intl.DateTimeFormat('ru-RU', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

function cacheElements() {
  const ids = [
    'profileAvatar', 'cardAvatar', 'profileName', 'cardName', 'versionCount',
    'appVersion', 'connectionPill', 'connectionDot', 'connectionText', 'refreshButton',
    'librarySub', 'search', 'filters', 'versionList', 'listLoading', 'listEmpty',
    'emptyTitle', 'emptyText', 'emptyRetry', 'selectedVersion', 'selectedBadges',
    'detailType', 'detailDate', 'detailJava', 'detailSize', 'playButton', 'playLabel',
    'playHint', 'stopButton', 'sessionBox', 'sessionLabel', 'sessionPercent',
    'progressTrack', 'progressBar', 'sessionDetail', 'cancelButton', 'errorBox',
    'errorText', 'launchNote', 'openVersionFolder', 'openGameFolder', 'statJava',
    'statSize', 'statState', 'javaVersion', 'javaSub', 'javaCard', 'consolePanel',
    'consoleBody', 'consoleCount', 'consoleDot', 'clearConsole', 'toggleConsole',
    'statusDot', 'statusText', 'statusPath', 'statusVersion', 'navFolder',
    'settingsModal', 'closeSettings', 'settingsName', 'nameError', 'ramSlider',
    'ramValue', 'ramMin', 'ramMax', 'settingsJvm', 'settingsDir', 'browseDir',
    'openDir', 'settingsResolution', 'resolutionInputs', 'settingsWidth',
    'settingsHeight', 'settingsFullscreen', 'settingsJava', 'browseJava',
    'settingsJavaStatus', 'settingsJavaDot', 'settingsJavaTitle', 'settingsJavaText',
    'detectJava', 'autoJava', 'findJava', 'javaCandidates',
    'cancelSettings', 'saveSettings', 'toasts',
    'navLoaders', 'navSkin', 'loadersModal', 'closeLoaders', 'closeLoadersFoot',
    'loadersFolder', 'loaderGame', 'loaderGameList', 'loaderGameUseSelected',
    'loaderStatus', 'loaderStatusTitle', 'loaderStatusText', 'loaderCancel',
    'optifineSite', 'optifinePick',
    'skinModal', 'closeSkin', 'skinCanvas', 'skinHover', 'skinColor', 'skinPalette',
    'skinUndo', 'skinRedo', 'skinBase', 'skinClear', 'skinImport', 'skinFile',
    'skinPreview', 'skinEnabled', 'skinExport', 'skinReset', 'skinStatus', 'skinSave',
  ];
  for (const id of ids) els[id] = document.getElementById(id);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '0 Б';
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const amount = value / 1024 ** index;
  const digits = index === 0 ? 0 : amount >= 100 ? 0 : amount >= 10 ? 1 : 2;
  return `${amount.toFixed(digits).replace('.', ',')} ${units[index]}`;
}

function formatRam(mb) {
  const gb = Number(mb) / 1024;
  const digits = Number.isInteger(gb) ? 0 : 1;
  return `${gb.toFixed(digits).replace('.', ',')} ГБ`;
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return dateFormatter.format(date).replace(/\s*г\.$/, '');
}

function formatLogTime(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return '--:--:--';
  return timeFormatter.format(date);
}

function shortenPath(value, max = 54) {
  const text = String(value || '');
  if (text.length <= max) return text;
  const tail = text.slice(-Math.max(20, max - 6));
  return `…${tail}`;
}

function isOldVersion(version) {
  if (version.type === 'old_beta' || version.type === 'old_alpha') return true;
  if (version.type !== 'release') return false;
  const match = /^1\.(\d+)(?:\.\d+)?$/.exec(version.id);
  return Boolean(match && Number(match[1]) < 6);
}

function typeMeta(type) {
  switch (type) {
    case 'snapshot':
      return { label: 'Снапшот', className: 'badge-snapshot', kind: 'Снапшот' };
    case 'old_beta':
      return { label: 'Бета', className: 'badge-old', kind: 'Старая бета' };
    case 'old_alpha':
      return { label: 'Альфа', className: 'badge-old', kind: 'Старая альфа' };
    case 'local':
      return { label: 'Локальная', className: 'badge-local', kind: 'Локальная' };
    case 'release':
    default:
      return { label: 'Релиз', className: 'badge-release', kind: 'Релиз' };
  }
}

function cleanError(error) {
  let message = error?.message || String(error || 'Неизвестная ошибка');
  message = message
    .replace(/^Error invoking remote method '[^']+':\s*/i, '')
    .replace(/^Error:\s*/i, '');
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|network/i.test(message)) {
    return 'Не удалось подключиться к серверу. Проверьте интернет.';
  }
  return message;
}

function setStatus(text, kind = '') {
  els.statusText.textContent = text;
  els.statusDot.className = `status-dot${kind ? ` ${kind}` : ''}`;
}

function setConsoleDot(kind = '') {
  els.consoleDot.className = `console-dot${kind ? ` ${kind}` : ''}`;
}

function updateConnection(kind, text, title = '') {
  els.connectionPill.classList.remove('online', 'offline', 'loading');
  if (kind) els.connectionPill.classList.add(kind);
  els.connectionText.textContent = text;
  els.connectionPill.title = title || text;
}

function setRefreshLoading(loading) {
  els.refreshButton.disabled = loading;
  els.refreshButton.classList.toggle('spinning', loading);
}

function getNameHash(name) {
  let hash = 2166136261;
  const value = String(name || 'player');
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function drawAvatar(canvas, name) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const width = canvas.width;
  const height = canvas.height;
  ctx.clearRect(0, 0, width, height);
  if (width !== 8 || height !== 8) return;
  if (state.skin?.data) {
    drawSkinFace(ctx);
    return;
  }

  const hash = getNameHash(name);
  const skins = ['#d6a276', '#c68e63', '#e2b58d', '#b97e55', '#efc8a4', '#a86d4a'];
  const hairs = ['#2e1c12', '#4a2b18', '#6a4424', '#1a1a1a', '#8a5a2b', '#c79b54', '#3c2a3d'];
  const shirts = ['#4cbb6e', '#3e9a5f', '#4f7fc2', '#8b63c7', '#c47f37', '#3f9a9a'];
  const skin = skins[hash % skins.length];
  const hair = hairs[(hash >>> 3) % hairs.length];
  const shirt = shirts[(hash >>> 7) % shirts.length];
  const skinShade = '#b57850';
  const eyeWhite = '#f3efe8';
  const pupil = '#252d35';

  const paint = (x, y, color) => {
    ctx.fillStyle = color;
    ctx.fillRect(x, y, 1, 1);
  };

  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) paint(x, y, skin);
  }

  // Волосы
  for (let x = 0; x < 8; x += 1) {
    paint(x, 0, hair);
    paint(x, 1, hair);
  }
  for (let y = 2; y < 5; y += 1) {
    paint(0, y, hair);
    paint(7, y, hair);
  }
  paint(1, 2, hair);
  paint(6, 2, hair);
  if (hash % 3 === 0) {
    paint(2, 2, hair);
    paint(5, 2, hair);
  }

  // Глаза
  paint(1, 3, eyeWhite);
  paint(2, 3, eyeWhite);
  paint(5, 3, eyeWhite);
  paint(6, 3, eyeWhite);
  paint(2, 3, pupil);
  paint(5, 3, pupil);

  // Нос и рот
  paint(3, 4, skinShade);
  paint(4, 4, skinShade);
  paint(3, 5, '#7e4f36');
  paint(4, 5, '#7e4f36');

  // Плечи
  for (let x = 0; x < 8; x += 1) paint(x, 7, shirt);
  if (hash % 2 === 0) {
    paint(0, 6, shirt);
    paint(7, 6, shirt);
  }

  // Лёгкая тень справа
  ctx.globalAlpha = 0.08;
  ctx.fillStyle = '#000';
  ctx.fillRect(7, 2, 1, 4);
  ctx.globalAlpha = 1;
}

function updateAvatars(name) {
  drawAvatar(els.profileAvatar, name);
  drawAvatar(els.cardAvatar, name);
}

function updateProfileUI(name = state.config?.username || 'Steve') {
  els.profileName.textContent = name;
  els.cardName.textContent = name;
  updateAvatars(name);
}

function updatePathsUI() {
  const gameDir = state.config?.gameDir || '';
  els.statusPath.textContent = shortenPath(gameDir, 58);
  els.statusPath.title = gameDir;
  els.settingsDir.value = gameDir;
}

function getAllVersions() {
  const manifestVersions = state.manifest?.versions || [];
  const localMap = new Map(state.localVersions.map((version) => [version.id, version]));
  const manifestIds = new Set(manifestVersions.map((version) => version.id));

  const localOnly = state.localVersions
    .filter((version) => !manifestIds.has(version.id))
    .slice()
    .sort((a, b) => String(b.releaseTime || '').localeCompare(String(a.releaseTime || '')))
    .map((version) => ({
      id: version.id,
      type: version.type || 'release',
      releaseTime: version.releaseTime || null,
      localOnly: true,
      local: true,
      installed: Boolean(version.jar),
    }));

  const rest = manifestVersions.map((version) => {
    const local = localMap.get(version.id);
    return {
      ...version,
      localOnly: false,
      local: Boolean(local),
      installed: Boolean(local?.jar),
    };
  });

  return [...localOnly, ...rest];
}

function getVersionEntry(id) {
  return getAllVersions().find((version) => version.id === id) || null;
}

function makeBadge(text, className) {
  const badge = document.createElement('span');
  badge.className = `badge ${className}`;
  badge.textContent = text;
  return badge;
}

function createVersionRow(version) {
  const row = document.createElement('div');
  row.className = 'version-row';
  row.dataset.id = version.id;
  row.setAttribute('role', 'option');
  row.setAttribute('aria-selected', String(version.id === state.selectedId));
  row.tabIndex = -1;
  if (version.id === state.selectedId) row.classList.add('selected');

  const dot = document.createElement('span');
  dot.className = `install-dot${version.installed ? ' on' : ''}`;
  dot.title = version.installed ? 'Установлена' : 'Не установлена';

  const main = document.createElement('div');
  main.className = 'version-main';

  const name = document.createElement('span');
  name.className = 'version-name';
  name.textContent = version.id;
  name.title = version.id;

  const meta = typeMeta(version.type);
  main.append(name, makeBadge(meta.label, meta.className));
  if (version.localOnly) main.append(makeBadge('Локальная', 'badge-local'));
  if (state.manifest?.latest?.release === version.id && !version.localOnly) {
    const latest = document.createElement('span');
    latest.className = 'latest-mark';
    latest.textContent = 'NEW';
    main.append(latest);
  }

  const side = document.createElement('div');
  side.className = 'version-side';
  const date = document.createElement('span');
  date.className = 'version-date';
  date.textContent = formatDate(version.releaseTime);
  const kind = document.createElement('span');
  kind.className = 'version-kind';
  kind.textContent = version.localOnly ? 'Локальная' : meta.kind;
  side.append(date, kind);

  row.append(dot, main, side);
  return row;
}

function renderVersions(options = {}) {
  const { keepScroll = false } = options;
  const all = getAllVersions();
  const query = state.query.trim().toLowerCase();

  const filtered = all.filter((version) => {
    if (state.filter === 'release' && version.type !== 'release') return false;
    if (state.filter === 'snapshot' && version.type !== 'snapshot') return false;
    if (state.filter === 'old' && !isOldVersion(version)) return false;
    if (state.filter === 'alpha' && version.type !== 'old_alpha') return false;
    if (state.filter === 'beta' && version.type !== 'old_beta') return false;
    if (state.filter === 'installed' && !version.installed) return false;
    if (query && !version.id.toLowerCase().includes(query)) return false;
    return true;
  });

  const previousScroll = els.versionList.scrollTop;
  const showSkeleton = state.manifestLoading && all.length === 0;
  const showEmpty = !showSkeleton && filtered.length === 0;

  els.listLoading.classList.toggle('hidden', !showSkeleton);
  els.versionList.classList.toggle('hidden', showSkeleton || showEmpty);
  els.listEmpty.classList.toggle('hidden', !showEmpty);

  const fragment = document.createDocumentFragment();
  for (const version of filtered) fragment.append(createVersionRow(version));
  els.versionList.replaceChildren(fragment);
  els.versionList.scrollTop = keepScroll ? previousScroll : 0;

  els.versionCount.textContent = String(all.length);

  const latest = state.manifest?.latest?.release;
  if (showSkeleton) {
    els.librarySub.textContent = 'Загрузка списка версий…';
  } else if (all.length === 0) {
    els.librarySub.textContent = state.offline ? 'Нет подключения к Mojang' : 'Версии не найдены';
  } else {
    const shown = filtered.length === all.length ? String(all.length) : `${filtered.length} из ${all.length}`;
    const suffix = state.manifestLoading
      ? ' · обновление…'
      : state.offline
        ? ' · офлайн-кэш'
        : '';
    els.librarySub.textContent = `${shown} версий · последний релиз ${latest || '—'}${suffix}`;
  }

  if (showEmpty) {
    els.emptyRetry.classList.remove('hidden');
    if (state.query.trim()) {
      els.emptyTitle.textContent = 'Ничего не найдено';
      els.emptyText.textContent = `По запросу «${state.query.trim()}» нет версий. Попробуйте изменить запрос.`;
      els.emptyRetry.textContent = 'Сбросить поиск';
      state.emptyAction = 'clear-search';
    } else if (state.filter === 'installed') {
      els.emptyTitle.textContent = 'Нет установленных версий';
      els.emptyText.textContent = 'Запустите любую версию — после загрузки она появится здесь.';
      els.emptyRetry.textContent = 'Показать все версии';
      state.emptyAction = 'show-all';
    } else if (!state.manifest && state.offline) {
      els.emptyTitle.textContent = 'Нет подключения';
      els.emptyText.textContent = 'Не удалось загрузить список версий Mojang. Проверьте интернет и попробуйте снова.';
      els.emptyRetry.textContent = 'Повторить';
      state.emptyAction = 'retry';
    } else {
      els.emptyTitle.textContent = 'Версии не найдены';
      els.emptyText.textContent = 'Попробуйте обновить список или выбрать другой фильтр.';
      els.emptyRetry.textContent = 'Обновить список';
      state.emptyAction = 'retry';
    }
  }

  if (state.selectedId) {
    const selectedRow = els.versionList.querySelector(`[data-id="${cssEscape(state.selectedId)}"]`);
    if (selectedRow && options.scrollToSelected) selectedRow.scrollIntoView({ block: 'nearest' });
  }
}

function cssEscape(value) {
  if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value);
  return String(value).replace(/["\\]/g, '\\$&');
}

function updateSelectionUI() {
  for (const row of els.versionList.children) {
    const selected = row.dataset.id === state.selectedId;
    row.classList.toggle('selected', selected);
    row.setAttribute('aria-selected', String(selected));
  }
}

function updateSelectedBadges(id, details = null) {
  els.selectedBadges.replaceChildren();
  const entry = getVersionEntry(id) || {};
  const type = typeMeta(details?.type || entry.type || 'release');
  els.selectedBadges.append(makeBadge(type.label, type.className));
  if (details?.installed) els.selectedBadges.append(makeBadge('Установлена', 'badge-installed'));
  if (details?.local && !details?.installed) els.selectedBadges.append(makeBadge('Локальная', 'badge-local'));
  if (details?.chain && details.chain.length > 1) {
    const chain = document.createElement('span');
    chain.className = 'badge badge-old';
    chain.textContent = `+${details.chain.length - 1}`;
    chain.title = `Наследование: ${details.chain.join(' → ')}`;
    els.selectedBadges.append(chain);
  }
}

function renderDetailsLoading() {
  const id = state.selectedId;
  els.selectedVersion.textContent = id || '—';
  els.selectedVersion.title = id || '';
  updateSelectedBadges(id);
  els.detailType.textContent = '…';
  els.detailDate.textContent = '…';
  els.detailJava.textContent = '…';
  els.detailSize.textContent = '…';
  els.statJava.textContent = '…';
  els.statSize.textContent = '…';
  els.statState.textContent = '…';
  els.javaVersion.textContent = '—';
  els.javaSub.textContent = 'Определяется…';
  els.javaCard.title = '';
  els.launchNote.textContent = 'Получение данных версии…';
  els.openVersionFolder.disabled = true;
  updatePlayButton();
}

function renderDetailsError(message) {
  const id = state.selectedId;
  els.selectedVersion.textContent = id || '—';
  els.selectedVersion.title = id || '';
  updateSelectedBadges(id);
  els.detailType.textContent = '—';
  els.detailDate.textContent = '—';
  els.detailJava.textContent = '—';
  els.detailSize.textContent = '—';
  els.statJava.textContent = '—';
  els.statSize.textContent = '—';
  els.statState.textContent = 'Ошибка';
  els.javaVersion.textContent = '—';
  els.javaSub.textContent = 'Данные недоступны';
  els.javaCard.title = '';
  els.launchNote.textContent = 'Не удалось получить информацию о версии.';
  els.openVersionFolder.disabled = true;
  showErrorBox(message);
  updatePlayButton();
}

function renderDetails(info) {
  state.details = info;
  const id = info.id || state.selectedId;
  els.selectedVersion.textContent = id;
  els.selectedVersion.title = id;
  updateSelectedBadges(id, info);

  const type = typeMeta(info.type);
  els.detailType.textContent = type.label;
  els.detailDate.textContent = formatDate(info.releaseTime);
  const java = info.java || {};
  if (java.found) {
    els.detailJava.textContent = `Java ${java.major}${java.exact === false ? ` / ${info.javaMajor}` : ''}`;
    els.detailJava.title = java.path || '';
  } else {
    els.detailJava.textContent = `Java ${info.javaMajor} · авто`;
    els.detailJava.title = 'Java не найдена и будет скачана автоматически';
  }
  const totalBytes = Number(info.sizes?.totalBytes) || 0;
  els.detailSize.textContent = totalBytes ? `~${formatBytes(totalBytes)}` : '—';
  els.detailSize.title = totalBytes ? 'Примерный размер клиента, библиотек и ресурсов' : '';

  els.statJava.textContent = java.found ? `Java ${java.major}` : `Java ${info.javaMajor} · авто`;
  els.statSize.textContent = totalBytes ? `~${formatBytes(totalBytes)}` : '—';
  updateStateStats();
  els.openVersionFolder.disabled = !(info.installed || info.local);

  if (java.found) {
    els.javaVersion.textContent = `Java ${java.major}`;
    els.javaSub.textContent = java.exact === false
      ? `нужна Java ${info.javaMajor}`
      : 'найдена · готова';
    els.javaCard.title = java.path || '';
  } else {
    els.javaVersion.textContent = `Java ${info.javaMajor}`;
    els.javaSub.textContent = 'не найдена · скачается';
    els.javaCard.title = 'Java будет загружена при первом запуске';
  }

  if (!java.found) {
    els.launchNote.textContent = `Java ${info.javaMajor} будет скачана автоматически при первом запуске.`;
  } else if (!info.installed) {
    els.launchNote.textContent = totalBytes
      ? `Будет скачано ~${formatBytes(totalBytes)} с серверов Mojang. Аккаунт не нужен.`
      : 'Файлы будут скачаны с серверов Mojang. Аккаунт не нужен.';
  } else {
    els.launchNote.textContent = 'Все файлы на месте. Запуск без аккаунта, в офлайн-режиме.';
  }

  updatePlayButton();
}

function updateStateStats() {
  const status = state.game.status;
  if (status === 'running') {
    els.statState.textContent = 'Работает';
  } else if (status === 'preparing') {
    els.statState.textContent = 'Подготовка';
  } else if (status === 'error') {
    els.statState.textContent = 'Ошибка';
  } else if (state.details) {
    els.statState.textContent = state.details.installed ? 'Установлена' : 'Не установлена';
  } else {
    els.statState.textContent = '—';
  }
}

function updatePlayButton() {
  const status = state.game.status;
  const details = state.details;
  const validName = NAME_RE.test(state.config?.username || '');
  let disabled = true;
  let label = 'Выберите версию';
  let hint = 'Из библиотеки слева';

  if (status === 'running') {
    label = 'Игра запущена';
    hint = `${state.game.versionId || details?.id || ''} · остановите игру ниже`;
  } else if (status === 'preparing') {
    label = 'Подготовка…';
    hint = 'Идёт проверка и загрузка файлов';
  } else if (state.detailsLoading) {
    label = 'Загрузка данных…';
    hint = 'Проверка версии';
  } else if (!details || state.detailsError || !state.selectedId) {
    label = state.detailsError ? 'Версия недоступна' : 'Выберите версию';
    hint = state.detailsError ? 'Проверьте подключение' : 'Из библиотеки слева';
  } else if (!validName) {
    disabled = false;
    label = 'Укажите никнейм';
    hint = 'Нажмите, чтобы открыть настройки';
  } else {
    disabled = false;
    label = details.installed ? 'Играть' : 'Скачать и играть';
    hint = `${state.config.username} · офлайн${details.installed ? ' · файлы готовы' : ''}`;
  }

  els.playButton.disabled = disabled;
  els.playLabel.textContent = label;
  els.playHint.textContent = hint;
  els.stopButton.classList.toggle('hidden', status !== 'running');
  if (status !== 'running') els.stopButton.disabled = false;
}

function showErrorBox(message) {
  els.errorText.textContent = message;
  els.errorBox.classList.remove('hidden');
}

function hideErrorBox() {
  els.errorBox.classList.add('hidden');
  els.errorText.textContent = '';
}

function showSessionBox() {
  els.sessionBox.classList.remove('hidden');
}

function hideSessionBox() {
  els.sessionBox.classList.add('hidden');
}

function setSessionProgress(percent, detail, label) {
  if (label) els.sessionLabel.textContent = label;
  const numeric = typeof percent === 'number' && Number.isFinite(percent);
  const value = numeric ? clamp(percent, 0, 100) : null;
  els.sessionPercent.textContent = value === null ? '…' : `${Math.round(value)}%`;
  els.progressTrack.classList.toggle('indeterminate', value === null);
  els.progressBar.style.width = value === null ? '' : `${value}%`;
  if (detail !== undefined) els.sessionDetail.textContent = detail || '';
  els.cancelButton.classList.toggle('hidden', state.game.status === 'running');
}

function resetSession() {
  state.progress = null;
  hideSessionBox();
  els.progressTrack.classList.remove('indeterminate');
  els.progressBar.style.width = '0%';
  els.sessionPercent.textContent = '';
  els.sessionDetail.textContent = '';
  els.cancelButton.disabled = false;
  els.cancelButton.classList.remove('hidden');
}

function progressDetail(progress) {
  const parts = [];
  if (Number.isFinite(progress.bytesTotal) && progress.bytesTotal > 0) {
    parts.push(`${formatBytes(progress.bytesDone || 0)} из ${formatBytes(progress.bytesTotal)}`);
  }
  if (progress.filesTotal) {
    parts.push(`${progress.filesDone || 0}/${progress.filesTotal} файлов`);
  }
  if (progress.bytesPerSecond) {
    parts.push(`${formatBytes(progress.bytesPerSecond)}/с`);
  }
  if (progress.phase === 'java' || progress.phase === 'java-extract' || progress.phase === 'java-check') {
    return progress.detail || parts.join(' · ') || 'Проверка Java…';
  }
  if (progress.detail && !parts.length) return progress.detail;
  return parts.join(' · ') || progress.detail || '…';
}

function handleProgress(progress) {
  if (!progress) return;
  if (state.game.status !== 'preparing' && state.game.status !== 'running') return;
  state.progress = progress;
  showSessionBox();
  setStatus(progress.label ? `Подготовка · ${progress.label}` : 'Подготовка…', 'busy');
  setConsoleDot('active');
  els.cancelButton.classList.toggle('hidden', state.game.status === 'running');
  setSessionProgress(progress.percent, progressDetail(progress), progress.label || 'Подготовка');
  if (progress.phase === 'running') {
    els.sessionPercent.textContent = '100%';
    els.progressTrack.classList.remove('indeterminate');
    els.progressBar.style.width = '100%';
    els.sessionLabel.textContent = 'Игра запущена';
    els.sessionDetail.textContent = 'Логи игры выводятся в консоль';
  }
}

function updateGameDetailsInstalled(versionId) {
  if (!state.details || state.details.id !== versionId) return;
  state.details.installed = true;
  updateSelectedBadges(versionId, state.details);
  els.statState.textContent = 'Установлена';
  els.openVersionFolder.disabled = false;
  els.launchNote.textContent = 'Все файлы на месте. Запуск без аккаунта, в офлайн-режиме.';
}

function handleState(payload) {
  if (!payload || !payload.status) return;
  const previous = state.game.status;
  state.game = { ...state.game, ...payload };

  if (payload.status === 'preparing') {
    hideErrorBox();
    showSessionBox();
    els.cancelButton.classList.remove('hidden');
    openConsole();
    setConsoleDot('active');
    setStatus(payload.versionId ? `Подготовка ${payload.versionId}` : 'Подготовка…', 'busy');
    if (!state.progress) {
      setSessionProgress(null, 'Проверка версии…', 'Подготовка…');
    }
    updateStateStats();
    updatePlayButton();
  } else if (payload.status === 'running') {
    hideErrorBox();
    showSessionBox();
    els.cancelButton.classList.add('hidden');
    setSessionProgress(100, 'Minecraft работает · логи в консоли', 'Игра запущена');
    setStatus('Minecraft запущен', 'running');
    setConsoleDot('active');
    openConsole();
    updateGameDetailsInstalled(payload.versionId);
    updateStateStats();
    updatePlayButton();
    if (previous !== 'running') toast('Minecraft запущен. Хорошей игры!', 'info', 3200);
    scheduleLocalRefresh(500);
  } else if (payload.status === 'idle') {
    const wasPreparing = previous === 'preparing';
    resetSession();
    hideSessionBox();
    els.stopButton.classList.add('hidden');
    els.cancelButton.disabled = false;
    setConsoleDot('');

    if (payload.cancelled) {
      hideErrorBox();
      setStatus('Загрузка отменена', '');
      toast('Загрузка отменена.', 'info', 2600);
    } else if (payload.stopped) {
      hideErrorBox();
      setStatus('Игра остановлена', '');
      toast('Игра остановлена.', 'info', 2600);
    } else if (typeof payload.exitCode === 'number' && payload.exitCode !== 0) {
      setStatus(`Игра завершилась с кодом ${payload.exitCode}`, 'error');
      setConsoleDot('error');
      showErrorBox(`Minecraft завершился с кодом ${payload.exitCode}. Подробности в консоли.`);
      openConsole();
      toast('Игра завершилась с ошибкой. Проверьте консоль.', 'error', 6000);
    } else if (!wasPreparing) {
      setStatus('Игра завершена', '');
      toast('Minecraft закрыт.', 'info', 2600);
    } else {
      setStatus('Готов', '');
    }

    updateStateStats();
    updatePlayButton();
    scheduleLocalRefresh(350);
  } else if (payload.status === 'error') {
    resetSession();
    hideSessionBox();
    els.stopButton.classList.add('hidden');
    setConsoleDot('error');
    setStatus('Ошибка', 'error');
    showErrorBox(payload.message || 'Не удалось запустить игру.');
    openConsole();
    updateStateStats();
    updatePlayButton();
    toast(payload.message || 'Не удалось запустить игру.', 'error', 7000);
  }
}

function scheduleLocalRefresh(delay) {
  if (state.refreshTimer) clearTimeout(state.refreshTimer);
  state.refreshTimer = setTimeout(async () => {
    state.refreshTimer = null;
    await refreshLocalVersions({reloadDetails: true});
  }, delay);
}

async function refreshLocalVersions(options = {}) {
  const { reloadDetails = false } = options;
  try {
    const local = await api.localVersions();
    state.localVersions = Array.isArray(local) ? local : [];
    renderVersions({ keepScroll: true });
    if (reloadDetails && state.selectedId) {
      loadDetails(state.selectedId, { quiet: true });
    }
  } catch {
    /* не критично */
  }
}

function selectVersion(id, options = {}) {
  if (!id) return;
  const { auto = false, scroll = false } = options;
  state.autoSelected = auto;
  state.selectedId = id;
  state.details = null;
  state.detailsError = null;
  state.detailsLoading = true;
  updateSelectionUI();
  renderDetailsLoading();
  const row = els.versionList.querySelector(`[data-id="${cssEscape(id)}"]`);
  if (row && scroll) row.scrollIntoView({ block: 'nearest' });
  loadDetails(id);
}

async function loadDetails(id, options = {}) {
  const { quiet = false } = options;
  const token = ++state.infoToken;
  if (!quiet) {
    state.detailsLoading = true;
    state.detailsError = null;
  }
  try {
    const info = await api.getVersionInfo(id);
    if (token !== state.infoToken || state.selectedId !== id) return;
    state.detailsLoading = false;
    state.detailsError = null;
    state.details = info;
    renderDetails(info);
    if (!quiet) hideErrorBox();
  } catch (error) {
    if (token !== state.infoToken || state.selectedId !== id) return;
    state.detailsLoading = false;
    if (quiet) return;
    const message = cleanError(error);
    state.details = null;
    state.detailsError = message;
    renderDetailsError(message);
    toast(message, 'error', 6500);
  }
}

function chooseDefaultVersion() {
  const all = getAllVersions();
  if (!all.length) return;
  if (state.selectedId && !state.autoSelected) return;

  const latestId = state.manifest?.latest?.release;
  const preferred =
    (state.offline ? all.find((version) => version.installed) : null) ||
    all.find((version) => version.id === latestId) ||
    all.find((version) => version.type === 'release' && !version.localOnly) ||
    all.find((version) => version.type === 'release') ||
    all[0];

  if (preferred.id !== state.selectedId) {
    selectVersion(preferred.id, { auto: true, scroll: true });
  }
}

async function refreshManifest() {
  if (state.refreshPromise) return state.refreshPromise;
  state.manifestLoading = true;
  setRefreshLoading(true);
  updateConnection('loading', 'Обновление…', 'Получение списка версий Mojang');
  renderVersions({ keepScroll: true });

  state.refreshPromise = (async () => {
    try {
      const manifest = await api.refreshManifest({ force: true });
      state.manifest = manifest;
      state.offline = Boolean(manifest.offline);
      state.manifestLoading = false;

      if (manifest.offline) {
        updateConnection('offline', 'Офлайн · кэш', manifest.error || 'Серверы Mojang недоступны');
        if (manifest.error) {
          toast(manifest.error, 'warn', 5200);
          addLog('warn', manifest.error);
        }
      } else {
        updateConnection('online', 'Mojang доступен', 'Список версий актуален');
        addLog('info', `Список версий обновлён: ${manifest.versions?.length || 0}.`);
      }

      renderVersions({ keepScroll: true });
      chooseDefaultVersion();
      if (state.selectedId) loadDetails(state.selectedId, { quiet: true });
      if (state.game.status === 'idle') setStatus('Готов', '');
    } catch (error) {
      state.manifestLoading = false;
      state.offline = true;
      const message = cleanError(error);
      const hasLocal = state.localVersions.length > 0;
      updateConnection(
        'offline',
        hasLocal ? 'Офлайн · локальные версии' : 'Нет связи',
        hasLocal ? 'Mojang недоступен, доступны установленные версии' : message,
      );
      addLog(hasLocal ? 'warn' : 'error', message);
      renderVersions({ keepScroll: true });
      chooseDefaultVersion();
      if (state.game.status === 'idle') {
        setStatus(hasLocal ? 'Офлайн-режим' : 'Нет подключения', hasLocal ? '' : 'error');
      }
      if (hasLocal) {
        toast('Mojang недоступен. Установленные версии можно запускать без интернета.', 'warn', 6000);
      } else {
        toast(message, 'error', 7000);
      }
    } finally {
      state.manifestLoading = false;
      state.refreshPromise = null;
      setRefreshLoading(false);
      renderVersions({ keepScroll: true });
    }
  })();

  return state.refreshPromise;
}

function setEmptyAction() {
  if (state.emptyAction === 'clear-search') {
    els.search.value = '';
    state.query = '';
    renderVersions();
  } else if (state.emptyAction === 'show-all') {
    setFilter('all');
  } else {
    refreshManifest();
  }
}

function setFilter(filter) {
  state.filter = filter;
  for (const chip of els.filters.querySelectorAll('.chip')) {
    chip.classList.toggle('active', chip.dataset.filter === filter);
  }
  renderVersions();
}

async function play() {
  if (state.game.status === 'preparing' || state.game.status === 'running') return;
  if (!NAME_RE.test(state.config?.username || '')) {
    openSettings();
    return;
  }
  if (!state.selectedId || !state.details || state.detailsError) return;

  hideErrorBox();
  openConsole();
  state.game.status = 'preparing';
  state.progress = null;
  updatePlayButton();
  updateStateStats();
  showSessionBox();
  setSessionProgress(null, 'Проверка версии…', 'Подготовка…');
  setStatus('Подготовка…', 'busy');
  setConsoleDot('active');

  try {
    await api.play({
      versionId: state.selectedId,
      username: state.config.username,
    });
  } catch (error) {
    state.game.status = 'idle';
    resetSession();
    const message = cleanError(error);
    showErrorBox(message);
    addLog('error', message);
    setStatus('Ошибка', 'error');
    toast(message, 'error', 6500);
    updateStateStats();
    updatePlayButton();
  }
}

async function cancelPreparation() {
  els.cancelButton.disabled = true;
  try {
    await api.cancel();
  } catch (error) {
    toast(cleanError(error), 'error', 4000);
    els.cancelButton.disabled = false;
  }
}

async function stopGame() {
  els.stopButton.disabled = true;
  try {
    await api.stop();
  } catch (error) {
    toast(cleanError(error), 'error', 4000);
    els.stopButton.disabled = false;
  }
}

async function openFolder(kind, versionId) {
  try {
    await api.openFolder({ kind, versionId });
  } catch (error) {
    toast(cleanError(error), 'error', 4500);
  }
}

function addLog(level, text, time = Date.now()) {
  if (!text) return;
  const line = document.createElement('div');
  line.className = `log-line ${level || 'info'}`;
  const stamp = document.createElement('span');
  stamp.className = 'log-time';
  stamp.textContent = formatLogTime(time);
  const body = document.createElement('span');
  body.className = 'log-text';
  body.textContent = String(text);
  line.append(stamp, body);

  const nearBottom =
    els.consoleBody.scrollTop + els.consoleBody.clientHeight >= els.consoleBody.scrollHeight - 30;
  els.consoleBody.append(line);
  while (els.consoleBody.children.length > MAX_LOG_LINES) {
    els.consoleBody.firstElementChild?.remove();
  }
  els.consoleCount.textContent = String(els.consoleBody.children.length);
  if (state.consoleOpen && nearBottom) {
    requestAnimationFrame(() => {
      els.consoleBody.scrollTop = els.consoleBody.scrollHeight;
    });
  }
}

function openConsole() {
  state.consoleOpen = true;
  els.consolePanel.classList.remove('collapsed');
  els.toggleConsole.setAttribute('aria-expanded', 'true');
  requestAnimationFrame(() => {
    els.consoleBody.scrollTop = els.consoleBody.scrollHeight;
  });
}

function closeConsole() {
  state.consoleOpen = false;
  els.consolePanel.classList.add('collapsed');
  els.toggleConsole.setAttribute('aria-expanded', 'false');
}

function toggleConsole() {
  if (state.consoleOpen) closeConsole();
  else openConsole();
}

function toast(message, type = 'info', duration = 4200) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  const text = document.createElement('div');
  text.className = 'toast-message';
  text.textContent = String(message);
  el.append(text);
  els.toasts.append(el);
  while (els.toasts.children.length > 4) els.toasts.firstElementChild?.remove();
  setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 220);
  }, duration);
}

function updateResolutionState() {
  const enabled = els.settingsResolution.checked;
  els.resolutionInputs.classList.toggle('disabled', !enabled);
  els.settingsWidth.disabled = !enabled;
  els.settingsHeight.disabled = !enabled;
}

function updateRamLabel() {
  const value = Number(els.ramSlider.value);
  els.ramValue.textContent = formatRam(value);
}

function javaArchLabel(arch) {
  const value = String(arch || '').toLowerCase();
  if (value === 'x86_64' || value === 'amd64' || value === 'x64') return '64-бит';
  if (value === 'x86' || value === 'i386' || value === 'i686') return '32-бит';
  if (value === 'aarch64' || value === 'arm64') return 'ARM64';
  return arch || '';
}

function setJavaStatus(kind, title, text) {
  els.settingsJavaStatus.classList.remove('found', 'warn', 'error');
  if (kind) els.settingsJavaStatus.classList.add(kind);
  els.settingsJavaTitle.textContent = title;
  els.settingsJavaText.textContent = text;
}

function setActiveJavaCandidate(targetPath) {
  const normalized = String(targetPath || '').toLowerCase();
  for (const button of els.javaCandidates.querySelectorAll('.java-candidate')) {
    button.classList.toggle('active', Boolean(normalized) && button.dataset.path.toLowerCase() === normalized);
  }
}

function showJavaInfo(value, info) {
  const target = String(value || '').trim();
  if (!target) {
    setJavaStatus(
      '',
      'Автоматический выбор',
      'Лаунчер подберёт Java под выбранную версию и при необходимости скачает её.',
    );
    return;
  }

  if (!info) {
    setJavaStatus(
      'error',
      'Java не найдена',
      `${shortenPath(target, 66)} — файл не найден или не запускается. Лаунчер попробует найти Java сам.`,
    );
    return;
  }

  const required = Number(state.details?.javaMajor) || 0;
  const arch = javaArchLabel(info.arch);
  const details = [
    info.version || `Java ${info.major}`,
    arch,
    shortenPath(info.path, 62),
  ]
    .filter(Boolean)
    .join(' · ');

  if (required && info.major !== required) {
    const newer = required > 8 && info.major > required;
    setJavaStatus(
      'warn',
      `Java ${info.major}${newer ? ' · новее рекомендуемой' : ' · не подходит версии'}`,
      `${details}. Для выбранной версии нужна Java ${required}; лаунчер использует другую, если эта не подойдёт.`,
    );
    return;
  }

  setJavaStatus('found', `Java ${info.major}`, details);
}

function renderJavaCandidates(list) {
  state.javaCandidates = Array.isArray(list) ? list : [];
  els.javaCandidates.replaceChildren();

  if (!state.javaCandidates.length) {
    const note = document.createElement('div');
    note.className = 'java-candidate-note';
    note.textContent = 'Установленные Java не найдены. Нужная версия будет скачана автоматически.';
    els.javaCandidates.append(note);
    els.javaCandidates.classList.remove('hidden');
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const info of state.javaCandidates) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'java-candidate';
    button.dataset.path = info.path;
    button.title = info.path;

    const main = document.createElement('span');
    main.className = 'java-candidate-main';
    const title = document.createElement('b');
    title.textContent = `Java ${info.major} · ${info.version || ''}`.trim();
    const subtitle = document.createElement('span');
    subtitle.textContent = [info.vendor, info.path].filter(Boolean).join(' · ');
    main.append(title, subtitle);

    const tag = document.createElement('span');
    tag.className = 'java-candidate-tag';
    const required = Number(state.details?.javaMajor) || 0;
    tag.textContent = required && info.major === required ? 'ПОДХОДИТ' : javaArchLabel(info.arch);

    button.append(main, tag);
    button.addEventListener('click', () => {
      cancelJavaDetectTimer();
      state.javaDetectToken += 1;
      els.settingsJava.value = info.path;
      showJavaInfo(info.path, info);
      setActiveJavaCandidate(info.path);
    });
    fragment.append(button);
  }

  els.javaCandidates.append(fragment);
  els.javaCandidates.classList.remove('hidden');
  setActiveJavaCandidate(els.settingsJava.value.trim());
}

function cancelJavaDetectTimer() {
  if (!state.javaDetectTimer) return;
  clearTimeout(state.javaDetectTimer);
  state.javaDetectTimer = null;
}

async function detectJavaValue(value) {
  cancelJavaDetectTimer();
  const target = String(value || '').trim();
  const token = ++state.javaDetectToken;
  if (!target) {
    showJavaInfo('', null);
    return;
  }

  setJavaStatus('', 'Проверка Java…', shortenPath(target, 66));
  try {
    const info = await api.detectJava(target);
    if (token !== state.javaDetectToken) return;
    showJavaInfo(target, info);
    setActiveJavaCandidate(info?.path || target);
  } catch (error) {
    if (token !== state.javaDetectToken) return;
    setJavaStatus('error', 'Не удалось проверить Java', cleanError(error));
  }
}

function scheduleJavaDetect() {
  cancelJavaDetectTimer();
  const value = els.settingsJava.value.trim();
  setActiveJavaCandidate('');
  if (!value) {
    state.javaDetectToken += 1;
    showJavaInfo('', null);
    return;
  }
  setJavaStatus('', 'Проверка Java…', 'Определяю версию…');
  state.javaDetectTimer = setTimeout(() => {
    state.javaDetectTimer = null;
    detectJavaValue(value);
  }, 350);
}

async function loadJavaList(force = false) {
  if (state.javaListLoading) return;
  state.javaListLoading = true;
  const previousLabel = els.findJava.textContent;
  els.findJava.textContent = 'Поиск…';
  els.findJava.disabled = true;
  try {
    const list = await api.listJava({ force });
    state.javaCandidatesLoaded = true;
    renderJavaCandidates(Array.isArray(list) ? list : []);
  } catch (error) {
    els.javaCandidates.replaceChildren();
    const note = document.createElement('div');
    note.className = 'java-candidate-note';
    note.textContent = `Не удалось выполнить поиск: ${cleanError(error)}`;
    els.javaCandidates.append(note);
    els.javaCandidates.classList.remove('hidden');
  } finally {
    state.javaListLoading = false;
    els.findJava.textContent = previousLabel;
    els.findJava.disabled = false;
  }
}

function resetJavaToAuto() {
  cancelJavaDetectTimer();
  state.javaDetectToken += 1;
  els.settingsJava.value = '';
  setActiveJavaCandidate('');
  showJavaInfo('', null);
}

function openSettings(options = {}) {
  if (!state.config) return;
  state.settingsOpen = true;
  els.settingsName.value = state.config.username;
  els.settingsName.classList.remove('invalid');
  els.nameError.classList.add('hidden');
  els.ramSlider.min = String(state.limits.min);
  els.ramSlider.max = String(state.limits.max);
  els.ramSlider.value = String(state.config.ramMB);
  els.ramMin.textContent = formatRam(state.limits.min);
  els.ramMax.textContent = formatRam(state.limits.max);
  els.settingsJvm.value = state.config.jvmArgs || '';
  els.settingsDir.value = state.config.gameDir;
  els.settingsResolution.checked = Boolean(state.config.resolution);
  els.settingsWidth.value = String(state.config.width || 1280);
  els.settingsHeight.value = String(state.config.height || 720);
  els.settingsFullscreen.checked = Boolean(state.config.fullscreen);
  els.settingsJava.value = state.config.javaPath || '';
  updateRamLabel();
  updateResolutionState();
  if (els.settingsJava.value.trim()) {
    detectJavaValue(els.settingsJava.value);
  } else {
    showJavaInfo('', null);
  }
  if (state.javaCandidatesLoaded) renderJavaCandidates(state.javaCandidates);
  else loadJavaList(false);
  els.settingsModal.classList.remove('hidden');
  requestAnimationFrame(() => {
    if (options?.focusJava) {
      els.settingsJava.closest('.settings-section')?.scrollIntoView({ block: 'start' });
      els.settingsJava.focus();
      return;
    }
    els.settingsName.focus();
    els.settingsName.select();
  });
}

function closeSettings() {
  state.settingsOpen = false;
  els.settingsModal.classList.add('hidden');
  if (state.config) updateProfileUI(state.config.username);
}

async function saveSettings() {
  if (!state.config) return;
  const name = els.settingsName.value.trim();
  if (!NAME_RE.test(name)) {
    els.settingsName.classList.add('invalid');
    els.nameError.classList.remove('hidden');
    els.settingsName.focus();
    return;
  }
  els.settingsName.classList.remove('invalid');
  els.nameError.classList.add('hidden');

  const width = clamp(Math.round(Number(els.settingsWidth.value) || 1280), 320, 7680);
  const height = clamp(Math.round(Number(els.settingsHeight.value) || 720), 240, 4320);
  const patch = {
    username: name,
    ramMB: Number(els.ramSlider.value),
    jvmArgs: els.settingsJvm.value.trim(),
    gameDir: els.settingsDir.value.trim(),
    javaPath: els.settingsJava.value.trim(),
    resolution: els.settingsResolution.checked,
    width,
    height,
    fullscreen: els.settingsFullscreen.checked,
  };

  els.saveSettings.disabled = true;
  els.saveSettings.textContent = 'Сохранение…';
  try {
    const result = await api.saveConfig(patch);
    const gameDirChanged = result.config.gameDir !== state.config.gameDir;
    state.config = result.config;
    state.limits = result.limits || state.limits;
    state.paths = result.paths || state.paths;
    updateProfileUI();
    updatePathsUI();
    updatePlayButton();
    closeSettings();
    toast('Настройки сохранены.', 'info', 2600);
    if (gameDirChanged) {
      await refreshLocalVersions({ reloadDetails: false });
      if (state.selectedId) loadDetails(state.selectedId, { quiet: true });
    } else if (state.selectedId) {
      loadDetails(state.selectedId, { quiet: true });
    }
  } catch (error) {
    toast(cleanError(error), 'error', 6000);
  } finally {
    els.saveSettings.disabled = false;
    els.saveSettings.textContent = 'Сохранить';
  }
}

/* =============================================================== Загрузчики */

function selectedGameVersion() {
  const chain = state.details?.chain;
  if (Array.isArray(chain)) {
    for (const id of chain) {
      if (/^\d+\.\d+(?:\.\d+)?$/.test(String(id))) return String(id);
    }
  }
  const id = String(state.selectedId || '');
  if (/^\d+\.\d+(?:\.\d+)?$/.test(id)) return id;
  return state.manifest?.latest?.release || '';
}

function populateLoaderGameList() {
  const list = [];
  const seen = new Set();
  const add = (id) => {
    const value = String(id || '');
    if (!value || seen.has(value) || !/^\d+\.\d+(?:\.\d+)?$/.test(value)) return;
    seen.add(value);
    list.push(value);
  };

  for (const version of state.localVersions) add(version.id);
  for (const version of state.manifest?.versions || []) {
    if (version.type === 'release' || version.type === 'snapshot') add(version.id);
  }

  els.loaderGameList.replaceChildren();
  for (const id of list.slice(0, 400)) {
    const option = document.createElement('option');
    option.value = id;
    els.loaderGameList.append(option);
  }
}

function plural(count, one, few, many) {
  const value = Math.abs(Number(count) || 0);
  const mod100 = value % 100;
  const mod10 = value % 10;
  if (mod100 > 10 && mod100 < 20) return many;
  if (mod10 > 1 && mod10 < 5) return few;
  if (mod10 === 1) return one;
  return many;
}

function setLoaderHint(kind, text, isError = false) {
  const hint = document.getElementById(`loaderHint-${kind}`);
  if (!hint) return;
  hint.textContent = text;
  hint.classList.toggle('error', isError);
}

async function loadLoaderVersions(kind, gameVersion, token) {
  const select = document.getElementById(`loaderVersion-${kind}`);
  const button = document.querySelector(`[data-install="${kind}"]`);
  if (!select || !button) return;

  select.replaceChildren();
  button.disabled = true;
  setLoaderHint(kind, 'Загрузка списка…');

  try {
    const list = await api.loaderVersions({ kind, gameVersion });
    if (token !== state.loaders.token) return;
    if (!Array.isArray(list) || list.length === 0) {
      const text =
        kind === 'neoforge'
          ? `NeoForge не поддерживает Minecraft ${gameVersion}.`
          : `Для Minecraft ${gameVersion} нет версий ${kind}.`;
      setLoaderHint(kind, text, true);
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const item of list) {
      const option = document.createElement('option');
      option.value = item.version;
      option.textContent =
        kind === 'forge'
          ? String(item.version).replace(`${gameVersion}-`, '')
          : item.stable === false
            ? `${item.version} · beta`
            : item.version;
      fragment.append(option);
    }
    select.append(fragment);
    const preferred = list.find((item) => item.stable) || list[0];
    select.value = preferred.version;
    setLoaderHint(kind, `${list.length} ${plural(list.length, 'версия', 'версии', 'версий')} · выбрана ${select.options[select.selectedIndex].textContent}`);
    button.disabled = state.loaders.installing;
  } catch (error) {
    if (token !== state.loaders.token) return;
    setLoaderHint(kind, cleanError(error), true);
  }
}

async function loadAllLoaderVersions() {
  const gameVersion = els.loaderGame.value.trim();
  state.loaders.token += 1;
  const token = state.loaders.token;
  state.loaders.loadedFor = gameVersion;

  if (!gameVersion) {
    for (const kind of ['fabric', 'quilt', 'forge', 'neoforge']) {
      const select = document.getElementById(`loaderVersion-${kind}`);
      if (select) select.replaceChildren();
      setLoaderHint(kind, 'Укажите версию Minecraft, чтобы увидеть список.', true);
    }
    return;
  }

  for (const kind of ['fabric', 'quilt', 'forge', 'neoforge']) {
    const select = document.getElementById(`loaderVersion-${kind}`);
    const button = document.querySelector(`[data-install="${kind}"]`);
    if (select) select.replaceChildren();
    if (button) button.disabled = true;
  }

  await Promise.all(
    ['fabric', 'quilt', 'forge', 'neoforge'].map((kind) =>
      loadLoaderVersions(kind, gameVersion, token),
    ),
  );
}

function openLoaders() {
  if (state.game.status === 'preparing' || state.game.status === 'running') {
    toast('Дождитесь завершения игры или подготовки.', 'warn');
    return;
  }
  state.loaders.open = true;
  els.loadersModal.classList.remove('hidden');
  populateLoaderGameList();
  if (!els.loaderGame.value.trim()) els.loaderGame.value = selectedGameVersion();
  if (state.loaders.loadedFor !== els.loaderGame.value.trim()) loadAllLoaderVersions();
  els.loaderGame.focus();
}

function closeLoaders() {
  if (state.loaders.installing) {
    toast('Установка ещё идёт — дождитесь завершения или нажмите «Отмена».', 'warn');
    return;
  }
  state.loaders.open = false;
  els.loadersModal.classList.add('hidden');
}

function setLoaderBusy(busy, kind = null) {
  state.loaders.installing = busy;
  state.loaders.kind = busy ? kind : null;
  for (const button of document.querySelectorAll('[data-install]')) {
    button.disabled = busy;
  }
  if (busy) {
    els.loaderStatus.classList.remove('hidden');
    const spinner = els.loaderStatus.querySelector('.spinner');
    if (spinner) spinner.classList.remove('hidden');
    els.loaderStatusTitle.textContent =
      kind === 'optifine' ? 'Установка OptiFine' : `Установка ${kind || 'загрузчика'}`;
    els.loaderStatusText.textContent = 'Подробности — в консоли ниже.';
    els.loaderCancel.disabled = false;
    els.loaderCancel.classList.remove('hidden');
  } else {
    els.loaderStatus.classList.add('hidden');
  }
}

function handleLoaderState(payload = {}) {
  const status = payload.status;
  const spinner = els.loaderStatus.querySelector('.spinner');
  if (status === 'installing') {
    els.loaderStatus.classList.remove('hidden');
    if (spinner) spinner.classList.remove('hidden');
    els.loaderStatusTitle.textContent = `Установка ${payload.kind || 'загрузчика'}…`;
    els.loaderStatusText.textContent = 'Скачивание и настройка файлов.';
  } else if (status === 'done') {
    if (spinner) spinner.classList.add('hidden');
    els.loaderStatusTitle.textContent = 'Готово';
    els.loaderStatusText.textContent = payload.id
      ? `Версия «${payload.id}» добавлена в библиотеку.`
      : 'Загрузчик установлен.';
    els.loaderCancel.classList.add('hidden');
    if (!state.loaders.installing) {
      setTimeout(() => {
        if (!state.loaders.installing) els.loaderStatus.classList.add('hidden');
      }, 4000);
    }
  } else if (status === 'error') {
    if (spinner) spinner.classList.add('hidden');
    els.loaderStatus.classList.remove('hidden');
    els.loaderStatusTitle.textContent = 'Ошибка установки';
    els.loaderStatusText.textContent = payload.error || 'Подробности — в консоли.';
    els.loaderCancel.classList.add('hidden');
  }
}

async function installLoaderKind(kind) {
  if (state.loaders.installing) return;
  const gameVersion = els.loaderGame.value.trim();
  if (!gameVersion) {
    toast('Сначала укажите версию Minecraft.', 'warn');
    return;
  }

  let jarPath;
  if (kind === 'optifine') {
    try {
      jarPath = await api.pickOptifine();
    } catch (error) {
      toast(cleanError(error), 'error', 5000);
      return;
    }
    if (!jarPath) return;
  }

  const select = document.getElementById(`loaderVersion-${kind}`);
  const loaderVersion = select?.value || undefined;

  setLoaderBusy(true, kind);
  els.loaderStatusTitle.textContent =
    kind === 'optifine' ? 'Установка OptiFine' : `Установка ${kind} ${loaderVersion || ''}`;
  els.loaderStatusText.textContent =
    kind === 'forge' || kind === 'neoforge' || kind === 'optifine'
      ? 'Запуск установщика. Это может занять несколько минут.'
      : 'Загрузка профиля версии…';

  try {
    const result = await api.installLoader({ kind, gameVersion, loaderVersion, jarPath });
    if (Array.isArray(result?.localVersions)) {
      state.localVersions = result.localVersions;
      renderVersions({ keepScroll: true });
    }
    if (result?.id) {
      selectVersion(result.id, { auto: false });
      setLoaderHint(kind, `Установлено: ${result.id}`);
      toast(`Готово: ${result.id}`, 'success', 6000);
    }
  } catch (error) {
    const message = cleanError(error);
    setLoaderHint(kind, message, true);
    els.loaderStatusTitle.textContent = 'Ошибка установки';
    els.loaderStatusText.textContent = message;
    toast(message, 'error', 7000);
  } finally {
    setLoaderBusy(false);
  }
}

async function cancelLoaderInstall() {
  els.loaderCancel.disabled = true;
  els.loaderStatusTitle.textContent = 'Отмена…';
  try {
    await api.cancelLoader();
  } catch (error) {
    toast(cleanError(error), 'error', 4000);
  }
}

/* ==================================================================== Скин */

const SKIN_SIZE = 64;
const SKIN_REGIONS = {
  headTop: [8, 0, 8, 8],
  headBottom: [16, 0, 8, 8],
  headRight: [0, 8, 8, 8],
  headFront: [8, 8, 8, 8],
  headLeft: [16, 8, 8, 8],
  headBack: [24, 8, 8, 8],
  bodyTop: [20, 16, 8, 4],
  bodyBottom: [28, 16, 8, 4],
  bodyRight: [16, 20, 4, 12],
  bodyFront: [20, 20, 8, 12],
  bodyLeft: [28, 20, 4, 12],
  bodyBack: [32, 20, 8, 12],
};

const SKIN_PALETTE = [
  '#f2f2f0', '#d7d7d2', '#9b9b96', '#5f5f5c', '#2e2e2e', '#111111', '#7a4a32', '#3a2414',
  '#efc8a4', '#d9a878', '#c69c6d', '#a87d52', '#8a5c3a', '#6a4424', '#4a2b18', '#2b1a10',
  '#e57373', '#c94f4f', '#f2a65a', '#c47f37', '#ffe066', '#d4b83a', '#8bc34a', '#4caf50',
  '#26a69a', '#1f8a80', '#4fc3f7', '#3d8fd1', '#5c6bc0', '#3b5fa0', '#9c64d8', '#7b3fa8',
];

function skinHexToRgba(hex) {
  const value = String(hex || '').replace('#', '');
  const full = value.length === 3 ? value.split('').map((c) => c + c).join('') : value.padEnd(6, '0');
  return [
    parseInt(full.slice(0, 2), 16) || 0,
    parseInt(full.slice(2, 4), 16) || 0,
    parseInt(full.slice(4, 6), 16) || 0,
    255,
  ];
}

function skinRgbToHex(r, g, b) {
  return `#${[r, g, b].map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('')}`;
}

function skinPut(data, x, y, rgba) {
  if (x < 0 || y < 0 || x >= SKIN_SIZE || y >= SKIN_SIZE) return;
  const offset = (y * SKIN_SIZE + x) * 4;
  data[offset] = rgba[0];
  data[offset + 1] = rgba[1];
  data[offset + 2] = rgba[2];
  data[offset + 3] = rgba[3] ?? 255;
}

function skinGet(data, x, y) {
  const offset = (y * SKIN_SIZE + x) * 4;
  return [data[offset], data[offset + 1], data[offset + 2], data[offset + 3]];
}

function skinFill(data, region, rgba) {
  const [rx, ry, rw, rh] = region;
  for (let y = 0; y < rh; y += 1) {
    for (let x = 0; x < rw; x += 1) skinPut(data, rx + x, ry + y, rgba);
  }
}

function createTemplateSkin() {
  const data = new Uint8ClampedArray(SKIN_SIZE * SKIN_SIZE * 4);
  const skin = [198, 156, 109, 255];
  const shade = [168, 125, 82, 255];
  const hair = [58, 36, 20, 255];
  const shirt = [47, 163, 150, 255];
  const shirtDark = [36, 135, 124, 255];
  const pants = [59, 95, 160, 255];
  const shoes = [51, 51, 58, 255];
  const white = [244, 244, 240, 255];
  const dark = [42, 47, 54, 255];
  const mouth = [122, 69, 48, 255];

  for (const key of ['headTop', 'headBottom', 'headLeft', 'headRight', 'headBack', 'headFront']) {
    skinFill(data, SKIN_REGIONS[key], skin);
  }
  skinFill(data, SKIN_REGIONS.headTop, hair);
  skinFill(data, SKIN_REGIONS.headBottom, shade);
  skinFill(data, SKIN_REGIONS.headBack, hair);
  for (const key of ['headLeft', 'headRight']) {
    const [rx, ry, rw] = SKIN_REGIONS[key];
    for (let y = 0; y < 3; y += 1) {
      for (let x = 0; x < rw; x += 1) skinPut(data, rx + x, ry + y, hair);
    }
  }
  // Лицо
  for (let x = 0; x < 8; x += 1) skinPut(data, 8 + x, 8, hair);
  for (let y = 1; y < 3; y += 1) {
    skinPut(data, 8, 8 + y, hair);
    skinPut(data, 15, 8 + y, hair);
  }
  for (const x of [9, 10, 13, 14]) skinPut(data, x, 10, hair);
  for (const x of [9, 10, 13, 14]) skinPut(data, x, 11, white);
  skinPut(data, 10, 11, dark);
  skinPut(data, 13, 11, dark);
  skinPut(data, 11, 12, shade);
  skinPut(data, 12, 12, shade);
  skinPut(data, 11, 13, mouth);
  skinPut(data, 12, 13, mouth);

  // Тело
  for (const key of ['bodyTop', 'bodyBottom', 'bodyRight', 'bodyFront', 'bodyLeft', 'bodyBack']) {
    skinFill(data, SKIN_REGIONS[key], shirt);
  }
  skinFill(data, SKIN_REGIONS.bodyTop, shirtDark);
  skinFill(data, SKIN_REGIONS.bodyBottom, shirtDark);
  for (let x = 0; x < 8; x += 1) skinPut(data, 20 + x, 29, shirtDark);

  // Руки
  const armSets = [
    { front: [44, 20, 4, 12], top: [44, 16, 4, 4], right: [40, 20, 4, 12], left: [48, 20, 4, 12], back: [52, 20, 4, 12], bottom: [48, 16, 4, 4] },
    { front: [36, 52, 4, 12], top: [36, 48, 4, 4], right: [32, 52, 4, 12], left: [40, 52, 4, 12], back: [44, 52, 4, 12], bottom: [40, 48, 4, 4] },
  ];
  for (const set of armSets) {
    for (const key of ['front', 'top', 'right', 'left', 'back', 'bottom']) {
      skinFill(data, set[key], skin);
    }
    for (const key of ['front', 'right', 'left', 'back']) {
      const [rx, ry, rw] = set[key];
      for (let y = 0; y < 4; y += 1) {
        for (let x = 0; x < rw; x += 1) skinPut(data, rx + x, ry + y, shirt);
      }
    }
    skinFill(data, set.top, shirt);
    skinFill(data, set.bottom, shade);
  }

  // Ноги
  const legSets = [
    { front: [4, 20, 4, 12], top: [4, 16, 4, 4], right: [0, 20, 4, 12], left: [8, 20, 4, 12], back: [12, 20, 4, 12], bottom: [8, 16, 4, 4] },
    { front: [20, 52, 4, 12], top: [20, 48, 4, 4], right: [16, 52, 4, 12], left: [24, 52, 4, 12], back: [28, 52, 4, 12], bottom: [24, 48, 4, 4] },
  ];
  for (const set of legSets) {
    for (const key of ['front', 'top', 'right', 'left', 'back', 'bottom']) {
      skinFill(data, set[key], pants);
    }
    for (const key of ['front', 'right', 'left', 'back']) {
      const [rx, ry, rw] = set[key];
      for (let y = 10; y < 12; y += 1) {
        for (let x = 0; x < rw; x += 1) skinPut(data, rx + x, ry + y, shoes);
      }
    }
    skinFill(data, set.top, pants);
    skinFill(data, set.bottom, shoes);
  }

  return data;
}

function skinToDataUrl() {
  const canvas = document.createElement('canvas');
  canvas.width = SKIN_SIZE;
  canvas.height = SKIN_SIZE;
  const ctx = canvas.getContext('2d');
  ctx.putImageData(new ImageData(new Uint8ClampedArray(state.skin.data), SKIN_SIZE, SKIN_SIZE), 0, 0);
  return canvas.toDataURL('image/png');
}

function loadImageElement(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Не удалось прочитать PNG.'));
    image.src = url;
  });
}

async function imageToSkinData(url) {
  const image = await loadImageElement(url);
  const canvas = document.createElement('canvas');
  canvas.width = SKIN_SIZE;
  canvas.height = SKIN_SIZE;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, SKIN_SIZE, SKIN_SIZE);
  if (image.width === SKIN_SIZE && image.height === 32) {
    ctx.drawImage(image, 0, 0);
  } else {
    ctx.drawImage(image, 0, 0, SKIN_SIZE, SKIN_SIZE);
  }
  return ctx.getImageData(0, 0, SKIN_SIZE, SKIN_SIZE).data;
}

function drawSkinFace(ctx) {
  const data = state.skin.data;
  if (!data) return;
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      const [r, g, b, a] = skinGet(data, 8 + x, 8 + y);
      if (!a) continue;
      ctx.fillStyle = `rgba(${r},${g},${b},${(a / 255).toFixed(3)})`;
      ctx.fillRect(x, y, 1, 1);
    }
  }
}

function redrawSkinCanvas() {
  if (!els.skinCanvas || !state.skin.data) return;
  const ctx = els.skinCanvas.getContext('2d');
  ctx.clearRect(0, 0, SKIN_SIZE, SKIN_SIZE);
  ctx.putImageData(
    new ImageData(new Uint8ClampedArray(state.skin.data), SKIN_SIZE, SKIN_SIZE),
    0,
    0,
  );
}

function drawSkinPreview() {
  if (!els.skinPreview || !state.skin.data || !els.skinCanvas) return;
  const ctx = els.skinPreview.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, els.skinPreview.width, els.skinPreview.height);

  const scale = 6;
  const parts = [
    [8, 8, 8, 8, 36, 8],
    [20, 20, 8, 12, 36, 56],
    [44, 20, 4, 12, 12, 56],
    [36, 52, 4, 12, 84, 56],
    [4, 20, 4, 12, 36, 128],
    [20, 52, 4, 12, 60, 128],
  ];
  for (const [sx, sy, sw, sh, dx, dy] of parts) {
    ctx.drawImage(els.skinCanvas, sx, sy, sw, sh, dx, dy, sw * scale, sh * scale);
  }
}

function skinCommit() {
  redrawSkinCanvas();
  drawSkinPreview();
  if (state.config) updateAvatars(state.config.username || 'Steve');
  state.skin.dirty = true;
  els.skinStatus.textContent = 'Есть несохранённые изменения';
  skinUpdateHistoryButtons();
}

function skinUpdateHistoryButtons() {
  if (!els.skinUndo) return;
  els.skinUndo.disabled = state.skin.undo.length === 0;
  els.skinRedo.disabled = state.skin.redo.length === 0;
}

function pushSkinUndo() {
  if (!state.skin.data) return;
  state.skin.undo.push(new Uint8ClampedArray(state.skin.data));
  if (state.skin.undo.length > 60) state.skin.undo.shift();
  state.skin.redo.length = 0;
  skinUpdateHistoryButtons();
}

function skinUndo() {
  if (!state.skin.data || state.skin.undo.length === 0) return;
  state.skin.redo.push(new Uint8ClampedArray(state.skin.data));
  state.skin.data = state.skin.undo.pop();
  skinCommit();
}

function skinRedo() {
  if (!state.skin.data || state.skin.redo.length === 0) return;
  state.skin.undo.push(new Uint8ClampedArray(state.skin.data));
  state.skin.data = state.skin.redo.pop();
  skinCommit();
}

function skinToolColor(tool = state.skin.tool) {
  return tool === 'eraser' ? [0, 0, 0, 0] : skinHexToRgba(state.skin.color);
}

function skinPaintLine(from, to) {
  if (!state.skin.data) return;
  const rgba = skinToolColor();
  let { x: x0, y: y0 } = from;
  const { x: x1, y: y1 } = to;
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let error = dx - dy;

  for (;;) {
    skinPut(state.skin.data, x0, y0, rgba);
    if (x0 === x1 && y0 === y1) break;
    const e2 = error * 2;
    if (e2 > -dy) {
      error -= dy;
      x0 += sx;
    }
    if (e2 < dx) {
      error += dx;
      y0 += sy;
    }
  }
}

function skinFloodFill(startX, startY) {
  const data = state.skin.data;
  if (!data) return;
  const target = skinGet(data, startX, startY);
  const replacement = skinToolColor('pencil');
  if (target.every((value, index) => value === replacement[index])) return;

  const stack = [[startX, startY]];
  const seen = new Uint8Array(SKIN_SIZE * SKIN_SIZE);
  while (stack.length) {
    const [x, y] = stack.pop();
    if (x < 0 || y < 0 || x >= SKIN_SIZE || y >= SKIN_SIZE) continue;
    const index = y * SKIN_SIZE + x;
    if (seen[index]) continue;
    seen[index] = 1;
    const current = skinGet(data, x, y);
    if (!current.every((value, i) => value === target[i])) continue;
    skinPut(data, x, y, replacement);
    stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }
}

function skinPointFromEvent(event) {
  const rect = els.skinCanvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const x = Math.floor(((event.clientX - rect.left) / rect.width) * SKIN_SIZE);
  const y = Math.floor(((event.clientY - rect.top) / rect.height) * SKIN_SIZE);
  if (x < 0 || y < 0 || x >= SKIN_SIZE || y >= SKIN_SIZE) return null;
  return { x, y };
}

function skinPointerDown(event) {
  if (!state.skin.data) return;
  event.preventDefault();
  const point = skinPointFromEvent(event);
  if (!point) return;

  if (state.skin.tool === 'picker') {
    const [r, g, b, a] = skinGet(state.skin.data, point.x, point.y);
    if (a > 0) {
      state.skin.color = skinRgbToHex(r, g, b);
      els.skinColor.value = state.skin.color;
    }
    return;
  }

  if (state.skin.tool === 'fill') {
    pushSkinUndo();
    skinFloodFill(point.x, point.y);
    skinCommit();
    return;
  }

  pushSkinUndo();
  state.skin.drawing = true;
  state.skin.last = point;
  skinPaintLine(point, point);
  skinCommit();
  try {
    els.skinCanvas.setPointerCapture(event.pointerId);
  } catch {
    /* игнорируем */
  }
}

function skinPointerMove(event) {
  const point = skinPointFromEvent(event);
  if (point) {
    const [r, g, b, a] = state.skin.data
      ? skinGet(state.skin.data, point.x, point.y)
      : [0, 0, 0, 0];
    els.skinHover.textContent = `${point.x}, ${point.y}${a ? ` · ${skinRgbToHex(r, g, b)}` : ' · пусто'}`;
  }
  if (!state.skin.drawing || !point) return;
  skinPaintLine(state.skin.last || point, point);
  state.skin.last = point;
  skinCommit();
}

function skinPointerUp(event) {
  if (!state.skin.drawing) return;
  state.skin.drawing = false;
  state.skin.last = null;
  try {
    els.skinCanvas.releasePointerCapture(event.pointerId);
  } catch {
    /* игнорируем */
  }
}

function buildSkinPalette() {
  els.skinPalette.replaceChildren();
  for (const color of SKIN_PALETTE) {
    const swatch = document.createElement('button');
    swatch.className = 'skin-swatch';
    swatch.type = 'button';
    swatch.style.background = color;
    swatch.title = color;
    swatch.addEventListener('click', () => {
      state.skin.color = color;
      els.skinColor.value = color;
      if (state.skin.tool === 'eraser') setSkinTool('pencil');
    });
    els.skinPalette.append(swatch);
  }
}

function setSkinTool(tool) {
  state.skin.tool = tool;
  for (const button of document.querySelectorAll('[data-tool]')) {
    button.classList.toggle('active', button.dataset.tool === tool);
  }
}

async function loadSkinState() {
  if (state.skin.loading || state.skin.loaded) return;
  state.skin.loading = true;
  try {
    const result = await api.getSkin();
    state.skin.enabled = result?.enabled !== false;
    els.skinEnabled.checked = state.skin.enabled;
    if (result?.png) {
      const data = await imageToSkinData(`data:image/png;base64,${result.png}`);
      if (data) state.skin.data = data;
    }
    if (!state.skin.data) state.skin.data = createTemplateSkin();
    state.skin.loaded = true;
  } catch {
    if (!state.skin.data) state.skin.data = createTemplateSkin();
    state.skin.loaded = true;
  } finally {
    state.skin.loading = false;
    redrawSkinCanvas();
    drawSkinPreview();
    skinUpdateHistoryButtons();
    if (state.config) updateAvatars(state.config.username || 'Steve');
  }
}

async function openSkin() {
  state.skinOpen = true;
  els.skinModal.classList.remove('hidden');
  buildSkinPalette();
  setSkinTool(state.skin.tool);
  await loadSkinState();
  redrawSkinCanvas();
  drawSkinPreview();
  skinUpdateHistoryButtons();
  els.skinStatus.textContent = state.skin.dirty
    ? 'Есть несохранённые изменения'
    : state.skin.enabled
      ? 'Скин применяется при запуске'
      : 'Применение скина отключено';
}

function closeSkin() {
  state.skinOpen = false;
  els.skinModal.classList.add('hidden');
}

async function saveSkin() {
  if (!state.skin.data) return;
  els.skinSave.disabled = true;
  els.skinStatus.textContent = 'Сохранение…';
  try {
    const enabled = els.skinEnabled.checked;
    await api.saveSkin({ png: skinToDataUrl(), enabled });
    state.skin.enabled = enabled;
    state.skin.dirty = false;
    els.skinStatus.textContent = enabled
      ? 'Сохранено · скин применится при следующем запуске'
      : 'Сохранено · применение отключено';
    toast('Скин сохранён', 'success');
  } catch (error) {
    els.skinStatus.textContent = 'Не удалось сохранить';
    toast(cleanError(error), 'error', 6000);
  } finally {
    els.skinSave.disabled = false;
  }
}

async function resetSkinState() {
  if (!window.confirm('Сбросить скин и вернуть стандартного Стива?')) return;
  try {
    await api.resetSkin();
    state.skin.data = createTemplateSkin();
    state.skin.undo.length = 0;
    state.skin.redo.length = 0;
    state.skin.dirty = false;
    els.skinEnabled.checked = true;
    state.skin.enabled = true;
    redrawSkinCanvas();
    drawSkinPreview();
    skinUpdateHistoryButtons();
    if (state.config) updateAvatars(state.config.username || 'Steve');
    els.skinStatus.textContent = 'Сброшено · используется стандартный Стив';
    toast('Скин сброшен', 'info');
  } catch (error) {
    toast(cleanError(error), 'error', 5000);
  }
}

async function exportSkinFile() {
  if (!state.skin.data) return;
  try {
    const result = await api.exportSkin({ png: skinToDataUrl() });
    if (result?.ok) toast(`Скин сохранён: ${result.filePath}`, 'success', 6000);
  } catch (error) {
    toast(cleanError(error), 'error', 5000);
  }
}

async function importSkinFile(file) {
  if (!file) return;
  const url = URL.createObjectURL(file);
  try {
    const data = await imageToSkinData(url);
    if (!data) return;
    pushSkinUndo();
    state.skin.data = data;
    skinCommit();
    toast('Скин загружен — не забудьте сохранить', 'info', 5000);
  } catch (error) {
    toast(cleanError(error), 'error', 5000);
  } finally {
    URL.revokeObjectURL(url);
    els.skinFile.value = '';
  }
}

function bindSkinEvents() {
  els.navSkin.addEventListener('click', openSkin);
  els.closeSkin.addEventListener('click', closeSkin);
  els.skinModal.addEventListener('click', (event) => {
    if (event.target === els.skinModal) closeSkin();
  });

  els.skinCanvas.addEventListener('pointerdown', skinPointerDown);
  els.skinCanvas.addEventListener('pointermove', skinPointerMove);
  els.skinCanvas.addEventListener('pointerup', skinPointerUp);
  els.skinCanvas.addEventListener('pointercancel', skinPointerUp);
  els.skinCanvas.addEventListener('pointerleave', () => {
    els.skinHover.textContent = '—';
  });
  els.skinCanvas.addEventListener('contextmenu', (event) => event.preventDefault());

  for (const button of document.querySelectorAll('[data-tool]')) {
    button.addEventListener('click', () => setSkinTool(button.dataset.tool));
  }
  els.skinColor.addEventListener('input', () => {
    state.skin.color = els.skinColor.value;
    if (state.skin.tool === 'eraser') setSkinTool('pencil');
  });

  els.skinUndo.addEventListener('click', skinUndo);
  els.skinRedo.addEventListener('click', skinRedo);
  els.skinBase.addEventListener('click', () => {
    pushSkinUndo();
    state.skin.data = createTemplateSkin();
    skinCommit();
  });
  els.skinClear.addEventListener('click', () => {
    pushSkinUndo();
    state.skin.data = new Uint8ClampedArray(SKIN_SIZE * SKIN_SIZE * 4);
    skinCommit();
  });
  els.skinImport.addEventListener('click', () => els.skinFile.click());
  els.skinFile.addEventListener('change', () => importSkinFile(els.skinFile.files?.[0]));
  els.skinSave.addEventListener('click', saveSkin);
  els.skinReset.addEventListener('click', resetSkinState);
  els.skinExport.addEventListener('click', exportSkinFile);
  els.skinEnabled.addEventListener('change', () => {
    state.skin.dirty = true;
    els.skinStatus.textContent = 'Есть несохранённые изменения';
  });
}

function bindLoaderEvents() {
  els.navLoaders.addEventListener('click', openLoaders);
  els.closeLoaders.addEventListener('click', closeLoaders);
  els.closeLoadersFoot.addEventListener('click', closeLoaders);
  els.loadersModal.addEventListener('click', (event) => {
    if (event.target === els.loadersModal) closeLoaders();
  });
  els.loadersFolder.addEventListener('click', () => openFolder('game'));
  els.loaderCancel.addEventListener('click', cancelLoaderInstall);

  els.loaderGame.addEventListener('change', () => {
    if (state.loaders.timer) clearTimeout(state.loaders.timer);
    loadAllLoaderVersions();
  });
  els.loaderGame.addEventListener('input', () => {
    if (state.loaders.timer) clearTimeout(state.loaders.timer);
    state.loaders.timer = setTimeout(() => loadAllLoaderVersions(), 500);
  });
  els.loaderGameUseSelected.addEventListener('click', () => {
    const version = selectedGameVersion();
    if (!version) {
      toast('Сначала выберите версию в библиотеке.', 'warn');
      return;
    }
    els.loaderGame.value = version;
    loadAllLoaderVersions();
  });

  for (const button of document.querySelectorAll('[data-install]')) {
    button.addEventListener('click', () => installLoaderKind(button.dataset.install));
  }

  els.optifineSite.addEventListener('click', () => {
    api.openExternal('https://optifine.net/downloads').catch((error) => {
      toast(cleanError(error), 'error', 5000);
    });
  });
  els.optifinePick.addEventListener('click', () => installLoaderKind('optifine'));
}

function bindEvents() {
  api.onProgress(handleProgress);
  api.onLog((payload) => addLog(payload.level, payload.text, payload.time));
  api.onState(handleState);
  api.onLoaderState(handleLoaderState);

  bindSkinEvents();
  bindLoaderEvents();

  for (const trigger of document.querySelectorAll('[data-open-settings]')) {
    trigger.addEventListener('click', openSettings);
  }

  els.navFolder.addEventListener('click', () => openFolder('game'));
  els.javaCard.addEventListener('click', () => openSettings({ focusJava: true }));
  els.openGameFolder.addEventListener('click', () => openFolder('game'));
  els.openVersionFolder.addEventListener('click', () => {
    if (state.selectedId) openFolder('version', state.selectedId);
  });

  els.refreshButton.addEventListener('click', (event) => {
    event.stopPropagation();
    refreshManifest();
  });
  els.emptyRetry.addEventListener('click', setEmptyAction);

  els.search.addEventListener('input', () => {
    state.query = els.search.value;
    renderVersions();
  });
  els.search.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      els.search.value = '';
      state.query = '';
      renderVersions();
      els.search.blur();
    }
  });

  els.filters.addEventListener('click', (event) => {
    const chip = event.target.closest('.chip');
    if (!chip) return;
    setFilter(chip.dataset.filter);
  });

  els.versionList.addEventListener('click', (event) => {
    const row = event.target.closest('.version-row');
    if (!row) return;
    selectVersion(row.dataset.id, { auto: false });
  });

  els.playButton.addEventListener('click', play);
  els.stopButton.addEventListener('click', stopGame);
  els.cancelButton.addEventListener('click', cancelPreparation);

  const consoleHead = els.consolePanel.querySelector('.console-head');
  consoleHead.addEventListener('click', (event) => {
    if (event.target.closest('#clearConsole')) return;
    toggleConsole();
  });
  els.clearConsole.addEventListener('click', (event) => {
    event.stopPropagation();
    els.consoleBody.replaceChildren();
    els.consoleCount.textContent = '0';
  });

  els.closeSettings.addEventListener('click', closeSettings);
  els.cancelSettings.addEventListener('click', closeSettings);
  els.saveSettings.addEventListener('click', saveSettings);
  els.settingsModal.addEventListener('click', (event) => {
    if (event.target === els.settingsModal) closeSettings();
  });

  els.settingsName.addEventListener('input', () => {
    const value = els.settingsName.value.trim();
    els.settingsName.classList.remove('invalid');
    els.nameError.classList.add('hidden');
    if (NAME_RE.test(value)) updateProfileUI(value);
  });

  els.ramSlider.addEventListener('input', updateRamLabel);
  els.settingsResolution.addEventListener('change', updateResolutionState);

  els.browseDir.addEventListener('click', async () => {
    try {
      const dir = await api.pickGameDir();
      if (dir) els.settingsDir.value = dir;
    } catch (error) {
      toast(cleanError(error), 'error', 4000);
    }
  });
  els.browseJava.addEventListener('click', async () => {
    try {
      const file = await api.pickJava();
      if (file) {
        els.settingsJava.value = file;
        detectJavaValue(file);
      }
    } catch (error) {
      toast(cleanError(error), 'error', 4000);
    }
  });
  els.settingsJava.addEventListener('input', scheduleJavaDetect);
  els.detectJava.addEventListener('click', () => {
    const value = els.settingsJava.value.trim();
    if (value) detectJavaValue(value);
    else loadJavaList(true);
  });
  els.findJava.addEventListener('click', () => loadJavaList(true));
  els.autoJava.addEventListener('click', resetJavaToAuto);
  els.openDir.addEventListener('click', () => openFolder('game'));

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (state.skinOpen) {
        closeSkin();
        return;
      }
      if (state.loaders.open) {
        closeLoaders();
        return;
      }
      if (state.settingsOpen) {
        closeSettings();
        return;
      }
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      if (state.settingsOpen || state.loaders.open || state.skinOpen) return;
      event.preventDefault();
      els.search.focus();
      els.search.select();
      return;
    }
    if (event.key === 'Enter' && !state.settingsOpen && !state.loaders.open && !state.skinOpen) {
      const active = document.activeElement;
      const typing =
        active &&
        (active.tagName === 'INPUT' ||
          active.tagName === 'TEXTAREA' ||
          active.tagName === 'BUTTON' ||
          active.tagName === 'SELECT');
      if (typing) return;
      if (!els.playButton.disabled) play();
    }
  });
}

function addInitialLogs() {
  addLog('info', `MINE Launcher ${state.appVersion} · офлайн-режим`);
  addLog('info', `Профиль: ${state.config?.username || 'Steve'} · Java подбирается автоматически`);
  addLog('info', `Папка игры: ${state.config?.gameDir || ''}`);
}

async function init() {
  cacheElements();
  updateAvatars('Steve');
  bindEvents();
  updateConnection('loading', 'Подключение…');
  setStatus('Инициализация…');

  try {
    const boot = await api.bootstrap();
    state.config = boot.config;
    state.limits = boot.limits || state.limits;
    state.manifest = boot.manifest || null;
    state.localVersions = Array.isArray(boot.localVersions) ? boot.localVersions : [];
    state.paths = boot.paths || {};
    state.appVersion = boot.appVersion || state.appVersion;
    state.manifestLoading = !state.manifest;

    els.appVersion.textContent = state.appVersion;
    els.statusVersion.textContent = `v${state.appVersion}`;
    updateProfileUI();
    updatePathsUI();
    addInitialLogs();
    loadSkinState().catch(() => {});

    renderVersions({ keepScroll: true });
    chooseDefaultVersion();

    if (state.game.status === 'idle') setStatus('Готов', '');
    await refreshManifest();
  } catch (error) {
    state.manifestLoading = false;
    const message = cleanError(error);
    setStatus('Ошибка запуска', 'error');
    updateConnection('offline', 'Ошибка', message);
    addLog('error', message);
    renderVersions();
    openConsole();
    showErrorBox(message);
    toast(message, 'error', 8000);
  }
}

init();
