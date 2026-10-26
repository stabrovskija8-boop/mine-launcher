'use strict';

const { fetchWithTimeout, mapLimit } = require('./util');

/* ---------------------------------------------------------------- Каталог */

// Скины не вшиваются в сборку: в приложении лежит только список ников,
// а PNG (64×64) и превью лица подгружаются с mc-heads.net по клику.
const SKINS = [
  { name: 'Стив', nick: 'Steve', tag: 'классика' },
  { name: 'Алекс', nick: 'Alex', tag: 'классика' },
  { name: 'Нотч', nick: 'Notch', tag: 'классика' },
  { name: 'jeb_', nick: 'jeb_', tag: 'классика' },
  { name: 'Херобрин', nick: 'Herobrine', tag: 'классика' },
  { name: 'Диннербон', nick: 'Dinnerbone', tag: 'разработчики' },
  { name: 'Грам', nick: 'Grumm', tag: 'разработчики' },
  { name: 'Марк', nick: 'Marc', tag: 'разработчики' },
  { name: 'Сердж', nick: 'Searge', tag: 'разработчики' },
  { name: 'Дрим', nick: 'Dream', tag: 'ютуб' },
  { name: 'Техноблейд', nick: 'Technoblade', tag: 'ютуб' },
  { name: 'Джордж', nick: 'GeorgeNotFound', tag: 'ютуб' },
  { name: 'Снапнап', nick: 'Sapnap', tag: 'ютуб' },
  { name: 'Томми', nick: 'TommyInnit', tag: 'ютуб' },
  { name: 'Уилбур', nick: 'WilburSoot', tag: 'ютуб' },
  { name: 'Филза', nick: 'Philza', tag: 'ютуб' },
  { name: 'Туббо', nick: 'Tubbo', tag: 'ютуб' },
  { name: 'Ранбу', nick: 'Ranboo', tag: 'ютуб' },
  { name: 'Квокети', nick: 'Quackity', tag: 'ютуб' },
  { name: 'Фанди', nick: 'Fundy', tag: 'ютуб' },
  { name: 'Карл', nick: 'KarlJacobs', tag: 'ютуб' },
  { name: 'Бэдбойхалло', nick: 'BadBoyHalo', tag: 'ютуб' },
  { name: 'Скеппи', nick: 'Skeppy', tag: 'ютуб' },
  { name: 'Капитан', nick: 'CaptainSparklez', tag: 'ютуб' },
  { name: 'ДэнТДМ', nick: 'DanTDM', tag: 'ютуб' },
  { name: 'Стэмпи', nick: 'Stampycat', tag: 'ютуб' },
  { name: 'Пьюдипай', nick: 'PewDiePie', tag: 'ютуб' },
  { name: 'Смоллиш', nick: 'Smallishbeans', tag: 'ютуб' },
  { name: 'ЛДШэдоу', nick: 'LDShadowLady', tag: 'ютуб' },
  { name: 'Мамбо', nick: 'MumboJumbo', tag: 'хермит' },
  { name: 'Гриан', nick: 'Grian', tag: 'хермит' },
  { name: 'Искалл', nick: 'Iskall85', tag: 'хермит' },
  { name: 'Рендог', nick: 'Rendog', tag: 'хермит' },
  { name: 'Ксисума', nick: 'Xisuma', tag: 'хермит' },
  { name: 'Кералис', nick: 'Keralis', tag: 'хермит' },
  { name: 'БдублО', nick: 'BdoubleO100', tag: 'хермит' },
];

/* ------------------------------------------------------------- Загрузки */

const FACE_URL = (nick) => `https://mc-heads.net/avatar/${encodeURIComponent(nick)}/64`;
const SKIN_URL = (nick) => `https://mc-heads.net/skin/${encodeURIComponent(nick)}`;

const faceCache = new Map();
const skinCache = new Map();

async function fetchBuffer(url, signal) {
  const response = await fetchWithTimeout(url, { signal, redirect: 'follow' }, 15000);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function faceDataUrl(nick, signal) {
  if (faceCache.has(nick)) return faceCache.get(nick);
  try {
    const buffer = await fetchBuffer(FACE_URL(nick), signal);
    const url = `data:image/png;base64,${buffer.toString('base64')}`;
    faceCache.set(nick, url);
    return url;
  } catch {
    return null;
  }
}

async function skinGallery(options = {}) {
  const { signal, force = false } = options;
  if (force) {
    faceCache.clear();
    skinCache.clear();
  }
  const items = new Array(SKINS.length);
  await mapLimit(
    SKINS,
    8,
    async (entry, index) => {
      items[index] = { ...entry, face: await faceDataUrl(entry.nick, signal) };
    },
    signal,
  );
  return { items: items.filter(Boolean) };
}

function pngSize(buffer) {
  if (!buffer || buffer.length < 24) return null;
  if (buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/** Скачивает настоящий PNG скина (64×64 или 64×32) по нику и проверяет формат. */
async function fetchSkinBuffer(nick, signal) {
  if (skinCache.has(nick)) return skinCache.get(nick);
  const buffer = await fetchBuffer(SKIN_URL(nick), signal);
  const size = pngSize(buffer);
  if (!size || size.width !== 64 || (size.height !== 64 && size.height !== 32)) {
    throw new Error('Не удалось получить скин: сервер вернул не PNG 64×64.');
  }
  skinCache.set(nick, buffer);
  return buffer;
}

module.exports = { SKINS, skinGallery, fetchSkinBuffer };
