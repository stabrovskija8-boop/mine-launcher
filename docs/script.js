'use strict';

const nav = document.getElementById('nav');
const toggle = document.querySelector('.nav-toggle');

if (nav && toggle) {
  toggle.addEventListener('click', () => {
    const open = nav.classList.toggle('open');
    toggle.setAttribute('aria-expanded', String(open));
  });

  nav.addEventListener('click', (event) => {
    if (event.target.closest('a') && nav.classList.contains('open')) {
      nav.classList.remove('open');
      toggle.setAttribute('aria-expanded', 'false');
    }
  });
}

const year = document.getElementById('year');
if (year) year.textContent = String(new Date().getFullYear());

const items = document.querySelectorAll('.reveal');
if ('IntersectionObserver' in window && items.length) {
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add('visible');
          observer.unobserve(entry.target);
        }
      }
    },
    { threshold: 0.12, rootMargin: '0px 0px -40px 0px' },
  );
  for (const item of items) observer.observe(item);
} else {
  for (const item of items) item.classList.add('visible');
}

// Видео-демо: muted-автоплей, когда ролик в кадре, плюс свои кнопки и перемотка.
const demoVideo = document.getElementById('demoVideo');
const videoFrame = document.getElementById('videoFrame');
const videoToggle = document.getElementById('videoToggle');
const videoProgress = document.getElementById('videoProgress');
const videoBar = document.getElementById('videoBar');
const videoTime = document.getElementById('videoTime');

if (demoVideo && videoFrame && videoToggle && videoProgress && videoBar && videoTime) {
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let autoPlay = !reduceMotion;
  let userPaused = reduceMotion;
  let inView = false;

  const clock = (value) => {
    if (!Number.isFinite(value) || value < 0) return '0:00';
    const total = Math.round(value);
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  };

  const paint = () => {
    const duration = Number.isFinite(demoVideo.duration) ? demoVideo.duration : 0;
    const current = demoVideo.currentTime || 0;
    videoBar.style.width = duration ? `${Math.min(100, (current / duration) * 100)}%` : '0%';
    videoTime.textContent = `${clock(current)} / ${clock(duration)}`;
    videoProgress.setAttribute('aria-valuemax', String(Math.round(duration)));
    videoProgress.setAttribute('aria-valuenow', String(Math.round(current)));
  };

  const sync = () => {
    const paused = demoVideo.paused;
    videoFrame.classList.toggle('paused', paused);
    videoToggle.setAttribute('aria-label', paused ? 'Воспроизвести видео' : 'Пауза');
  };

  const start = () => {
    const result = demoVideo.play();
    if (result && typeof result.catch === 'function') result.catch(() => sync());
  };

  const flip = () => {
    if (demoVideo.paused) {
      userPaused = false;
      start();
    } else {
      userPaused = true;
      demoVideo.pause();
    }
  };

  const seek = (ratio) => {
    if (!Number.isFinite(demoVideo.duration)) return;
    demoVideo.currentTime = Math.min(1, Math.max(0, ratio)) * demoVideo.duration;
    paint();
  };

  videoToggle.addEventListener('click', flip);
  demoVideo.addEventListener('click', flip);

  demoVideo.addEventListener('loadedmetadata', paint);
  demoVideo.addEventListener('timeupdate', paint);
  demoVideo.addEventListener('play', sync);
  demoVideo.addEventListener('pause', sync);

  videoProgress.addEventListener('pointerdown', (event) => {
    const rect = videoProgress.getBoundingClientRect();
    const move = (pointerEvent) => {
      seek((pointerEvent.clientX - rect.left) / rect.width);
    };
    const up = () => {
      videoProgress.removeEventListener('pointermove', move);
      videoProgress.removeEventListener('pointerup', up);
      videoProgress.removeEventListener('pointercancel', up);
    };
    videoProgress.setPointerCapture?.(event.pointerId);
    videoProgress.addEventListener('pointermove', move);
    videoProgress.addEventListener('pointerup', up);
    videoProgress.addEventListener('pointercancel', up);
    move(event);
  });

  videoProgress.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const delta = event.key === 'ArrowRight' ? 2 : -2;
    seek((demoVideo.currentTime + delta) / (demoVideo.duration || 1));
  });

  if ('IntersectionObserver' in window) {
    const videoObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          inView = entry.isIntersecting;
          if (!autoPlay || userPaused) continue;
          if (inView) start();
          else demoVideo.pause();
        }
      },
      { threshold: 0.35 },
    );
    videoObserver.observe(videoFrame);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      autoPlay = false;
      demoVideo.pause();
    }
  });

  paint();
  sync();
}
