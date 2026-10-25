'use strict';

const path = require('path');

const { downloadFile, fileSize, mapLimit } = require('./util');

/**
 * Скачивает набор файлов, показывает общий прогресс по байтам и файлам.
 * Задачи: { url, dest, sha1, size, kind }
 */
async function downloadMany(allTasks, options = {}) {
  const {
    label = 'Скачивание файлов',
    phase = 'files',
    concurrency = 16,
    signal,
    onProgress = () => {},
    onLog = () => {},
  } = options;

  // Одинаковые файлы (например, разные имена ассетов с одним hash)
  // нельзя качать параллельно в один и тот же .part-файл.
  const tasks = [];
  const seen = new Set();
  for (const task of allTasks) {
    if (!task?.dest) continue;
    const key = path.normalize(task.dest);
    if (seen.has(key)) continue;
    seen.add(key);
    tasks.push(task);
  }

  if (!tasks.length) return { downloaded: 0, skipped: 0, bytes: 0 };

  const totalBytes = tasks.reduce((sum, task) => sum + (task.size || 0), 0);
  let doneBytes = 0;
  let filesDone = 0;
  let downloadedFiles = 0;
  let downloadedBytes = 0;
  let lastReport = 0;
  let speed = 0;
  const samples = [];

  const computeSpeed = (now) => {
    samples.push({ t: now, bytes: doneBytes });
    while (samples.length > 2 && now - samples[0].t > 2500) samples.shift();
    if (samples.length >= 2) {
      const first = samples[0];
      const last = samples[samples.length - 1];
      const seconds = (last.t - first.t) / 1000;
      if (seconds > 0.35) speed = Math.max(0, (last.bytes - first.bytes) / seconds);
    }
  };

  const report = (force = false) => {
    const now = Date.now();
    if (!force && now - lastReport < 120) return;
    lastReport = now;
    computeSpeed(now);
    const percent = totalBytes > 0
      ? Math.min(100, Math.max(0, (doneBytes / totalBytes) * 100))
      : Math.min(100, (filesDone / tasks.length) * 100);
    onProgress({
      phase,
      label,
      percent,
      bytesDone: doneBytes,
      bytesTotal: totalBytes,
      filesDone,
      filesTotal: tasks.length,
      bytesPerSecond: speed,
    });
  };

  // Быстрая проверка уже скачанных файлов.
  await mapLimit(
    tasks,
    64,
    async (task) => {
      const size = await fileSize(task.dest);
      const ok = size >= 0 && (task.size == null ? true : size === task.size);
      if (ok) {
        task._done = true;
        doneBytes += task.size ?? size;
        filesDone += 1;
      }
    },
    signal,
  );

  report(true);

  const missing = tasks.filter((task) => !task._done);
  if (!missing.length) {
    onLog('info', `${label}: все файлы уже на месте (${tasks.length}).`);
    return { downloaded: 0, skipped: filesDone, bytes: 0 };
  }

  onLog(
    'info',
    `${label}: ${missing.length} файл(ов), ${(totalBytes / 1048576).toFixed(1)} МБ к загрузке.`,
  );

  await mapLimit(
    missing,
    concurrency,
    async (task) => {
      let taskBytes = 0;
      try {
        await downloadFile({
          url: task.url,
          dest: task.dest,
          sha1: task.sha1,
          size: task.size,
          signal,
          onBytes: (delta) => {
            taskBytes += delta;
            downloadedBytes += delta;
            doneBytes += delta;
            report();
          },
          onRetry: () => {},
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        throw new Error(`Не удалось скачать ${path.basename(task.dest)}: ${error.message}`);
      }
      filesDone += 1;
      downloadedFiles += 1;
      report();
      if (taskBytes < 0) throw new Error('Не удалось загрузить файл полностью.');
    },
    signal,
  );

  report(true);
  onLog(
    'info',
    `${label} завершено: ${downloadedFiles} файл(ов), ${Math.max(0, downloadedBytes / 1048576).toFixed(1)} МБ.`,
  );
  return { downloaded: downloadedFiles, skipped: filesDone - downloadedFiles, bytes: Math.max(0, downloadedBytes) };
}

module.exports = { downloadMany };
