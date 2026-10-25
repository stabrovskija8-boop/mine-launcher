'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeTheme, screen } = require('electron');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const {
  sanitizeConfig,
  sanitizeUsername,
  memoryLimits,
  buildPaths,
  loadConfig,
  saveConfig,
  ensureGameDir,
} = require('./core/config');
const { readCachedManifest, getManifest, listLocalVersions, hasLocalJar } = require('./core/mojang');
const { getVersionRuntimeInfo, startGame } = require('./core/launch');
const {
  clearJavaCaches,
  detectJava,
  listInstalledJava,
  minecraftRuntimeDirs,
} = require('./core/java');
const { loaderVersions, installLoader } = require('./core/loaders');
const { getSkin, saveSkinFile, resetSkin } = require('./core/skin');
const { USER_AGENT } = require('./core/util');

app.setName('MINE Launcher');
app.setPath('userData', path.join(app.getPath('appData'), 'MINE Launcher'));
app.setAppUserModelId('ru.mine.launcher');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  run();
}

let win = null;
let config = null;
let paths = null;
let gameProcess = null;
let preparing = false;
let stopping = false;
let quitting = false;
let activeSession = null;
let logStream = null;
let installingLoader = false;
let loaderController = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function run() {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('before-quit', () => {
    quitting = true;
    activeSession?.controller?.abort();
    if (gameProcess) killGameProcess();
  });

  app.whenReady().then(async () => {
    nativeTheme.themeSource = 'dark';
    Menu.setApplicationMenu(null);
    config = await loadConfig(app.getPath('userData'));
    paths = buildPaths(config, app.getPath('userData'));
    registerIpc();
    createWindow();
  });
}

function createWindow() {
  const workArea = screen.getPrimaryDisplay().workAreaSize;
  const width = Math.min(1240, Math.max(980, workArea.width - 60));
  const height = Math.min(830, Math.max(680, workArea.height - 60));

  win = new BrowserWindow({
    width,
    height,
    minWidth: 980,
    minHeight: 660,
    show: false,
    backgroundColor: '#0a0d10',
    title: 'MINE Launcher',
    titleBarStyle: process.platform === 'win32' ? 'hidden' : 'default',
    titleBarOverlay:
      process.platform === 'win32'
        ? { color: '#0a0e12', symbolColor: '#9aa9b5', height: 52 }
        : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.once('ready-to-show', () => {
    win.show();
    if (process.env.MINE_DEVTOOLS === '1') win.webContents.openDevTools({ mode: 'detach' });
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });

  win.webContents.on('before-input-event', (event, input) => {
    if (
      input.type === 'keyDown' &&
      (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i'))
    ) {
      win.webContents.toggleDevTools();
      event.preventDefault();
    }
  });

  win.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });

  win.on('close', async (event) => {
    if (quitting) return;
    if (gameProcess) {
      event.preventDefault();
      const result = await dialog.showMessageBox(win, {
        type: 'question',
        title: 'Minecraft запущен',
        message: 'Игра сейчас работает.',
        detail: 'Если закрыть лаунчер, Minecraft будет остановлен.',
        buttons: ['Остановить игру и выйти', 'Отмена'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      });
      if (result.response === 0) {
        quitting = true;
        stopping = true;
        pushLog('warn', 'Лаунчер закрывается, игра останавливается…');
        killGameProcess();
        setTimeout(() => app.quit(), 700);
      }
      return;
    }
    quitting = true;
    activeSession?.controller?.abort();
  });

  const screenshotPath = process.env.MINE_SCREENSHOT;
  if (screenshotPath) {
    win.webContents.once('did-finish-load', async () => {
      await sleep(Number(process.env.MINE_SCREENSHOT_DELAY || 6000));
      if (process.env.MINE_SCREENSHOT_VIEW === 'settings') {
        await win.webContents.executeJavaScript(
          "document.querySelector('[data-open-settings]')?.click(); true;",
        );
        await sleep(900);
      }
      const image = await win.webContents.capturePage();
      const target = path.resolve(screenshotPath);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, image.toPNG());
      app.exit(0);
    });
  }
}

function send(channel, payload) {
  if (!win || win.isDestroyed()) return;
  win.webContents.send(channel, payload);
}

function sendState(payload) {
  send('game:state', payload);
}

function pushLog(level, text) {
  const value = String(text ?? '');
  if (!value.trim()) return;
  send('game:log', { level, text: value, time: Date.now() });
  if (logStream) {
    logStream.write(`${new Date().toISOString()} [${level}] ${value}\n`);
  }
}

function openLogFile(versionId) {
  closeLogFile();
  try {
    fs.mkdirSync(paths.logsDir, { recursive: true });
    logStream = fs.createWriteStream(path.join(paths.logsDir, 'latest.log'), { flags: 'w' });
    logStream.write(`=== ${new Date().toISOString()} · ${versionId} ===\n`);
  } catch {
    logStream = null;
  }
}

function closeLogFile() {
  if (!logStream) return;
  try {
    logStream.end();
  } catch {
    /* ignore */
  }
  logStream = null;
}

function validateVersionId(value) {
  const id = String(value || '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,79}$/.test(id)) throw new Error('Некорректный идентификатор версии.');
  return id;
}

function registerIpc() {
  ipcMain.handle('app:bootstrap', async () => {
    const cached = await readCachedManifest(paths);
    let localVersions = [];
    try {
      localVersions = await listLocalVersions(paths);
    } catch {
      localVersions = [];
    }
    return {
      config,
      limits: memoryLimits(),
      manifest: cached,
      localVersions,
      paths: { gameDir: config.gameDir, dataDir: paths.dataDir, logsDir: paths.logsDir },
      appVersion: app.getVersion(),
      platform: process.platform,
      userAgent: USER_AGENT,
    };
  });

  ipcMain.handle('manifest:refresh', async (_event, options = {}) => {
    const force = options?.force !== false;
    return getManifest(paths, { force });
  });

  ipcMain.handle('versions:local', async () => listLocalVersions(paths));

  ipcMain.handle('version:info', async (_event, versionId) => {
    const id = validateVersionId(versionId);
    const info = await getVersionRuntimeInfo(id, { paths, config });
    const installed = await hasLocalJar(paths, id);
    return { ...info, installed };
  });

  ipcMain.handle('game:play', async (_event, payload = {}) => {
    if (preparing) throw new Error('Подготовка уже идёт. Подождите или отмените загрузку.');
    if (gameProcess) throw new Error('Игра уже запущена.');
    const versionId = validateVersionId(payload.versionId);
    const username = sanitizeUsername(payload.username, '');
    if (!username) throw new Error('Никнейм должен содержать 2–16 символов: латиница, цифры или «_».');

    if (username !== config.username) {
      config.username = username;
      await saveConfig(paths.dataDir, config);
    }

    const controller = new AbortController();
    const session = {
      id: crypto.randomUUID(),
      versionId,
      controller,
      exited: false,
      child: null,
    };
    activeSession = session;
    preparing = true;
    stopping = false;
    openLogFile(versionId);
    pushLog('info', `=== Запуск ${versionId} · игрок ${username} ===`);
    sendState({ status: 'preparing', versionId });

    runSession(session, username).catch((error) => {
      handleFatalSessionError(session, error);
    });

    return { ok: true, username };
  });

  ipcMain.handle('game:cancel', async () => {
    if (!preparing || !activeSession) return { ok: false };
    activeSession.controller.abort();
    pushLog('warn', 'Загрузка отменена пользователем.');
    return { ok: true };
  });

  ipcMain.handle('game:stop', async () => {
    if (!gameProcess) return { ok: false };
    stopping = true;
    pushLog('warn', 'Остановка игры…');
    killGameProcess();
    return { ok: true };
  });

  ipcMain.handle('config:save', async (_event, patch = {}) => {
    if ((preparing || gameProcess) && patch.gameDir && patch.gameDir !== config.gameDir) {
      throw new Error('Нельзя менять папку игры во время подготовки или запущенной игры.');
    }
    const previousJavaPath = config.javaPath;
    const previousGameDir = config.gameDir;
    const next = sanitizeConfig({ ...config, ...(patch || {}) }, config);
    try {
      await ensureGameDir(next);
    } catch (error) {
      throw new Error(`Не удалось использовать папку игры: ${error.message}`);
    }
    config = next;
    paths = buildPaths(config, app.getPath('userData'));
    if (previousJavaPath !== config.javaPath || previousGameDir !== config.gameDir) {
      clearJavaCaches();
    }
    await saveConfig(paths.dataDir, config);
    pushLog('info', 'Настройки сохранены.');
    return { config, limits: memoryLimits(), paths: { gameDir: config.gameDir, dataDir: paths.dataDir, logsDir: paths.logsDir } };
  });

  ipcMain.handle('dialog:game-dir', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: 'Выберите папку игры',
      defaultPath: config.gameDir,
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Выбрать',
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('dialog:java', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: 'Выберите java.exe',
      defaultPath: config.javaPath || 'C:\\Program Files',
      properties: ['openFile'],
      filters:
        process.platform === 'win32'
          ? [{ name: 'Java', extensions: ['exe'] }]
          : [{ name: 'Все файлы', extensions: ['*'] }],
      buttonLabel: 'Выбрать',
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('java:detect', async (_event, value) => {
    const target = String(value || '').trim();
    if (!target) return null;
    const info = await detectJava(target, { useCache: false });
    if (!info) return null;
    return {
      path: info.path,
      major: info.major,
      version: info.version,
      arch: info.arch,
      vendor: info.vendor,
    };
  });

  ipcMain.handle('java:list', async (_event, options = {}) => {
    return listInstalledJava({
      customPath: config.javaPath,
      javaDir: paths.javaDir,
      extraDirs: minecraftRuntimeDirs(config.gameDir),
      force: Boolean(options?.force),
    });
  });

  ipcMain.handle('loader:versions', async (_event, payload = {}) => {
    return loaderVersions(String(payload.kind || ''), String(payload.gameVersion || ''));
  });

  ipcMain.handle('loader:install', async (_event, payload = {}) => {
    if (preparing || gameProcess) {
      throw new Error('Сейчас идёт подготовка или игра уже запущена.');
    }
    if (installingLoader) throw new Error('Установка уже идёт.');
    installingLoader = true;
    const controller = new AbortController();
    loaderController = controller;
    openLogFile(`установка · ${payload.kind || 'loader'}`);
    pushLog(
      'info',
      `=== Установка ${payload.kind || 'загрузчика'} для ${payload.gameVersion || '?'} ===`,
    );
    send('loader:state', { status: 'installing', kind: payload.kind || null });
    try {
      const result = await installLoader(payload, {
        paths,
        config,
        signal: controller.signal,
        onLog: pushLog,
        onProgress: (progress) => send('game:progress', progress),
      });
      pushLog('info', 'Установка завершена. Версия добавлена в библиотеку.');
      send('loader:state', { status: 'done', kind: payload.kind || null, id: result.id });
      return { ok: true, ...result, localVersions: await listLocalVersions(paths) };
    } catch (error) {
      pushLog('error', error.message);
      send('loader:state', { status: 'error', kind: payload.kind || null, error: error.message });
      throw error;
    } finally {
      installingLoader = false;
      loaderController = null;
    }
  });

  ipcMain.handle('loader:cancel', async () => {
    loaderController?.abort();
    return { ok: true };
  });

  ipcMain.handle('dialog:optifine', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: 'Выберите установщик OptiFine (.jar)',
      defaultPath: app.getPath('downloads'),
      properties: ['openFile'],
      filters: [
        { name: 'OptiFine / установщик', extensions: ['jar'] },
        { name: 'Все файлы', extensions: ['*'] },
      ],
      buttonLabel: 'Выбрать',
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('skin:get', async () => getSkin(paths, config));

  ipcMain.handle('skin:save', async (_event, payload = {}) => {
    if (payload?.png) await saveSkinFile(paths, payload.png);
    if (payload?.enabled !== undefined) {
      config.skinEnabled = payload.enabled !== false;
      await saveConfig(paths.dataDir, config);
    }
    return { ok: true, enabled: config.skinEnabled !== false };
  });

  ipcMain.handle('skin:reset', async () => {
    await resetSkin(paths);
    return { ok: true };
  });

  ipcMain.handle('skin:export', async (_event, payload = {}) => {
    const data = String(payload?.png || '');
    if (!data) throw new Error('Скин ещё не нарисован.');
    const result = await dialog.showSaveDialog(win, {
      title: 'Сохранить скин',
      defaultPath: path.join(app.getPath('pictures'), 'mine-skin.png'),
      filters: [{ name: 'PNG', extensions: ['png'] }],
      buttonLabel: 'Сохранить',
    });
    if (result.canceled || !result.filePath) return { ok: false };
    const base64 = data.includes(',') ? data.slice(data.indexOf(',') + 1) : data;
    await fsp.writeFile(result.filePath, Buffer.from(base64, 'base64'));
    return { ok: true, filePath: result.filePath };
  });

  ipcMain.handle('shell:external', async (_event, url) => {
    const target = String(url || '').trim();
    if (!/^https?:\/\//i.test(target)) throw new Error('Ссылка должна начинаться с http:// или https://');
    await shell.openExternal(target);
    return { ok: true };
  });

  ipcMain.handle('shell:open', async (_event, payload = {}) => {
    const kind = payload.kind;
    let target = null;
    if (kind === 'game') target = config.gameDir;
    else if (kind === 'data') target = paths.dataDir;
    else if (kind === 'logs') target = paths.logsDir;
    else if (kind === 'version') {
      const id = validateVersionId(payload.versionId);
      target = path.join(paths.gameDir, 'versions', id);
    } else {
      throw new Error('Неизвестная папка.');
    }
    await fsp.mkdir(target, { recursive: true }).catch(() => {});
    const error = await shell.openPath(target);
    if (error) throw new Error(error);
    return { ok: true };
  });
}

async function runSession(session, username) {
  const { versionId, controller } = session;
  try {
    const result = await startGame(versionId, {
      paths,
      config,
      username,
      signal: controller.signal,
      onSpawn: (child) => {
        if (session.exited) return;
        session.child = child;
        gameProcess = child;
      },
      onProgress: (progress) => {
        if (session.exited) return;
        send('game:progress', { versionId, ...progress });
      },
      onLog: (level, text) => pushLog(level, text),
      onExit: (code, signalName, child) => {
        if (session.exited) return;
        session.exited = true;
        session.child = child || session.child;
        if (gameProcess && child && gameProcess.pid === child.pid) gameProcess = null;
        else if (!child) gameProcess = null;
        preparing = false;
        if (activeSession === session) activeSession = null;
        const wasStopping = stopping;
        stopping = false;

        if (wasStopping) {
          pushLog('warn', 'Игра остановлена.');
        } else if (code === 0) {
          pushLog('info', 'Игра завершена.');
        } else {
          pushLog('error', `Игра завершилась с кодом ${code}${signalName ? ` (${signalName})` : ''}.`);
        }
        sendState({
          status: 'idle',
          versionId,
          exitCode: code,
          stopped: wasStopping,
        });
        closeLogFile();
      },
    });

    session.child = result.child;
    if (session.exited || result.child.exitCode !== null) return;

    gameProcess = result.child;
    preparing = false;
    sendState({
      status: 'running',
      versionId,
      pid: result.child.pid,
      javaMajor: result.java.major,
    });
    pushLog('info', 'Игра запущена. Ожидание закрытия окна Minecraft…');
    if (logStream) {
      logStream.write(`COMMAND: ${result.args.join(' ')}\n`);
    }
  } catch (error) {
    if (error?.name === 'AbortError' || controller.signal.aborted) {
      if (!session.exited) {
        session.exited = true;
        preparing = false;
        if (activeSession === session) activeSession = null;
        pushLog('warn', 'Загрузка отменена.');
        sendState({ status: 'idle', versionId, cancelled: true });
      }
      closeLogFile();
      return;
    }
    throw error;
  }
}

function handleFatalSessionError(session, error) {
  if (session.exited) return;
  session.exited = true;
  preparing = false;
  if (activeSession === session) activeSession = null;
  const message = error?.message || 'Неизвестная ошибка.';
  pushLog('error', message);
  if (error?.stack && logStream) logStream.write(`${error.stack}\n`);
  sendState({ status: 'error', versionId: session.versionId, message });
  closeLogFile();
}

function killGameProcess() {
  if (!gameProcess) return;
  const pid = gameProcess.pid;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true });
    killer.on('error', (error) => pushLog('error', `Не удалось остановить игру: ${error.message}`));
  } else {
    try {
      gameProcess.kill('SIGTERM');
    } catch (error) {
      pushLog('error', `Не удалось остановить игру: ${error.message}`);
    }
  }
}
