// Shared theme controller: light / dark / system. Persisted as wb_theme.
export const THEME_KEY = 'wb_theme';

export async function getTheme() {
  try {
    const r = await chrome.storage.local.get([THEME_KEY]);
    return r[THEME_KEY] || 'system';
  } catch { return 'system'; }
}

export function resolveTheme(stored) {
  if (stored === 'light' || stored === 'dark') return stored;
  try {
    return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  } catch { return 'dark'; }
}

export async function applyTheme() {
  const stored = await getTheme();
  document.documentElement.dataset.theme = resolveTheme(stored);
  return stored;
}

export async function setTheme(next) {
  try { await chrome.storage.local.set({ [THEME_KEY]: next }); } catch {}
  document.documentElement.dataset.theme = resolveTheme(next);
  return next;
}

export function watchSystem() {
  try {
    matchMedia('(prefers-color-scheme: light)').addEventListener('change', async () => {
      if ((await getTheme()) === 'system') applyTheme();
    });
  } catch {}
}

// Theme toggle button wiring: pass button element; swaps sun/moon icon.
export async function wireThemeButton(btn) {
  if (!btn) return;
  const paint = async () => {
    const stored = await getTheme();
    const active = resolveTheme(stored);
    btn.dataset.mode = active;
    btn.title = `Theme: ${stored} (click to switch)`;
    btn.innerHTML = `<svg class="icon lg"><use href="#${active === 'light' ? 'i-moon' : 'i-sun'}"/></svg>`;
  };
  btn.addEventListener('click', async () => {
    const cur = resolveTheme(await getTheme());
    await setTheme(cur === 'light' ? 'dark' : 'light');
    await paint();
  });
  try {
    chrome.storage.onChanged.addListener((chg) => { if (chg[THEME_KEY]) paint(); });
  } catch {}
  await paint();
}
