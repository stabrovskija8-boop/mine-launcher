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
