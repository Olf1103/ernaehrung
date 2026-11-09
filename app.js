const MODEL = 'gemini-3.8-flash';
const LS = { meals: 'ern.meals', key: 'ern.geminiKey', goals: 'ern.goals', prefs: 'ern.prefs', advice: 'ern.advice', week: 'ern.week', shopPersons: 'ern.shopPersons', sync: 'ern.sync', localUpdated: 'ern.localUpdated' };
const SYNC_KEYS = [LS.meals, LS.goals, LS.prefs, LS.week, LS.shopPersons, LS.advice];
const DEFAULT_PREFS = 'Spielt privat Fußball. Möchte zu Hause etwas Sport machen.';
const DEFAULT_TARGETS = { kcal: 2200, protein: 120, carbs: 250, fat: 70 };
const WEEKDAYS = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
const WEEK_ORDER = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];
const WEEK_GETDAY = [1, 2, 3, 4, 5, 6, 0];
const SLOTS = ['Frühstück', 'Mittagessen', 'Abendessen', 'Snack'];

const PROMPT = `Du analysierst ein Foto einer Mahlzeit. Erkenne jedes sichtbare Lebensmittel, schätze die Menge in Gramm und die Nährwerte (kcal, Eiweiß, Kohlenhydrate, Fett in Gramm) für genau diese Menge. Antworte ausschließlich mit JSON. Wenn etwas unklar ist, schätze eher konservativ und vermerke die Unsicherheit im Namen.`;

const MEAL_SCHEMA = {
  type: 'OBJECT',
  properties: {
    items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          name: { type: 'STRING' }, grams: { type: 'NUMBER' }, kcal: { type: 'NUMBER' },
          protein: { type: 'NUMBER' }, carbs: { type: 'NUMBER' }, fat: { type: 'NUMBER' }
        },
        required: ['name', 'grams', 'kcal', 'protein', 'carbs', 'fat']
      }
    }
  },
  required: ['items']
};

const RECIPE_PROPS = {
  ingredients: { type: 'ARRAY', items: { type: 'STRING' } },
  steps: { type: 'ARRAY', items: { type: 'STRING' } },
  kcal: { type: 'NUMBER' }, protein: { type: 'NUMBER' }, carbs: { type: 'NUMBER' }, fat: { type: 'NUMBER' }
};

const MEAL_ITEM = {
  type: 'OBJECT',
  properties: {
    slot: { type: 'STRING', enum: SLOTS },
    time: { type: 'STRING' }, title: { type: 'STRING' }, description: { type: 'STRING' },
    prepMinutes: { type: 'NUMBER' }, servings: { type: 'NUMBER' },
    ...RECIPE_PROPS,
    vegetarian: {
      type: 'OBJECT',
      properties: { title: { type: 'STRING' }, ...RECIPE_PROPS },
      required: ['title', 'ingredients', 'steps', 'kcal', 'protein', 'carbs', 'fat']
    }
  },
  required: ['slot', 'time', 'title', 'description', 'prepMinutes', 'servings', 'ingredients', 'steps', 'kcal', 'protein', 'carbs', 'fat', 'vegetarian']
};

const ADVICE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    summary: { type: 'STRING' },
    meals: { type: 'ARRAY', items: MEAL_ITEM },
    shoppingList: { type: 'ARRAY', items: { type: 'STRING' } },
    tips: { type: 'ARRAY', items: { type: 'STRING' } }
  },
  required: ['summary', 'meals', 'shoppingList', 'tips']
};

const WEEK_SCHEMA = {
  type: 'OBJECT',
  properties: {
    days: {
      type: 'ARRAY',
      items: { type: 'OBJECT', properties: { meals: { type: 'ARRAY', items: MEAL_ITEM } }, required: ['meals'] }
    },
    shoppingList: { type: 'ARRAY', items: { type: 'STRING' } }
  },
  required: ['days', 'shoppingList']
};

const SHOP_SCHEMA = {
  type: 'OBJECT',
  properties: { shoppingList: { type: 'ARRAY', items: { type: 'STRING' } } },
  required: ['shoppingList']
};

const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const save = (k, v) => {
  localStorage.setItem(k, JSON.stringify(v));
  if (SYNC_KEYS.includes(k)) markChanged();
};
const $ = (s) => document.querySelector(s);
const today = () => new Date().toLocaleDateString('sv-SE');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const round = (n) => Math.round(n * 10) / 10;
const sumItems = (items, k) => items.reduce((b, i) => b + (+i[k] || 0), 0);
const shopPersons = () => Math.max(1, +load(LS.shopPersons, 2) || 2);

/* ---------- Geräte-Sync über Firestore ---------- */
let pushTimer = null;

function markChanged() {
  localStorage.setItem(LS.localUpdated, JSON.stringify(Date.now()));
  clearTimeout(pushTimer);
  pushTimer = setTimeout(syncPush, 800);
}

function setSyncStatus(t) {
  const el = $('#syncStatus');
  if (el) el.textContent = t;
}

function syncUrl(cfg) {
  return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(cfg.projectId)}/databases/(default)/documents/sync/${encodeURIComponent(cfg.code)}?key=${encodeURIComponent(cfg.apiKey)}`;
}

function syncConfigured() {
  const cfg = load(LS.sync, null);
  return cfg?.projectId && cfg?.apiKey && cfg?.code ? cfg : null;
}

function syncPayload() {
  return {
    week: load(LS.week, null),
    meals: load(LS.meals, []).map(m => ({ ...m, thumb: null })),
    goals: load(LS.goals, {}),
    prefs: load(LS.prefs, DEFAULT_PREFS),
    shopPersons: load(LS.shopPersons, 2),
    advice: load(LS.advice, null)
  };
}

async function syncPush() {
  const cfg = syncConfigured();
  if (!cfg) return;
  const updated = load(LS.localUpdated, Date.now());
  try {
    const res = await fetch(syncUrl(cfg), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fields: {
          updated: { integerValue: String(updated) },
          data: { stringValue: JSON.stringify(syncPayload()) }
        }
      })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    setSyncStatus('Gespeichert ✓');
  } catch (e) {
    setSyncStatus('Sync fehlgeschlagen: ' + e.message);
  }
}

// Holt den Stand von Firestore. Gibt true zurück, wenn lokale Daten ersetzt wurden.
async function syncPull() {
  const cfg = syncConfigured();
  if (!cfg) return false;
  try {
    const res = await fetch(syncUrl(cfg));
    if (res.status === 404) {
      await syncPush();
      return false;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const doc = await res.json();
    const remoteUpdated = +doc.fields.updated.integerValue;
    if (remoteUpdated <= load(LS.localUpdated, 0)) return false;

    const p = JSON.parse(doc.fields.data.stringValue);
    // Lokale fotos behalten, die Cloud speichert keine Bilder
    const thumbs = Object.fromEntries(load(LS.meals, []).filter(m => m.thumb).map(m => [m.id, m.thumb]));
    localStorage.setItem(LS.meals, JSON.stringify((p.meals || []).map(m => ({ ...m, thumb: thumbs[m.id] ?? null }))));
    localStorage.setItem(LS.week, JSON.stringify(p.week ?? null));
    localStorage.setItem(LS.goals, JSON.stringify(p.goals || {}));
    localStorage.setItem(LS.prefs, JSON.stringify(p.prefs ?? DEFAULT_PREFS));
    localStorage.setItem(LS.shopPersons, JSON.stringify(p.shopPersons ?? 2));
    localStorage.setItem(LS.advice, JSON.stringify(p.advice ?? null));
    localStorage.setItem(LS.localUpdated, JSON.stringify(remoteUpdated));
    setSyncStatus('Aktualisiert');
    return true;
  } catch (e) {
    setSyncStatus('Sync fehlgeschlagen: ' + e.message);
    return false;
  }
}

function pullAndRender() {
  syncPull().then(changed => { if (changed) render(); });
}

let draft = { items: [], image: null, thumb: null, hint: '' };
let adviceBusy = false;
let adviceError = null; // { key, msg }
let portions = {};      // Personenzahl je Rezept, nur im Speicher
let weekBusy = false;
let weekStatus = '';
let weekError = '';
let weekDay = null; // ausgewählter Wochentag (0 = Montag)
const openRecipes = new Set();

/* ---------- Routing ---------- */
function render() {
  const route = (location.hash || '#uebersicht').slice(1);
  const page = route === 'heute' ? 'uebersicht' : route;
  document.querySelectorAll('nav a').forEach(a => a.classList.toggle('on', a.getAttribute('href') === '#' + page));
  ({ uebersicht: viewOverview, woche: viewWeek, neu: viewNew, einstellungen: viewSettings }[page] || viewOverview)();
}

/* ---------- Gemeinsame Bausteine ---------- */
function scaleText(s, f) {
  if (f === 1) return String(s);
  return String(s).replace(/^(\d+(?:[.,]\d+)?)/, (m) => {
    const n = parseFloat(m.replace(',', '.')) * f;
    return (Math.round(n * 10) / 10).toString().replace('.', ',');
  });
}

const UNIT_ALIAS = { g: 'g', gramm: 'g', kg: 'kg', ml: 'ml', l: 'l', el: 'EL', tl: 'TL', stk: 'Stk', 'stück': 'Stk', dose: 'Dose', dosen: 'Dose', bund: 'Bund', becher: 'Becher', scheibe: 'Scheibe', scheiben: 'Scheibe', zehe: 'Zehe', zehen: 'Zehe', prise: 'Prise', prisen: 'Prise', packung: 'Packung', pck: 'Packung', pk: 'Packung' };
const fmtNum = (n) => (Math.round(n * 10) / 10).toString().replace('.', ',');

// Fasst gleiche Zutaten zusammen, z. B. "100 g Reis" + "200 g Reis" → "300 g Reis"
function mergeShopping(list) {
  const groups = new Map();
  for (const raw of list || []) {
    const line = String(raw ?? '').trim().replace(/\s+/g, ' ');
    if (!line) continue;
    const m = line.match(/^(\d+(?:[.,]\d+)?)\s*(.*)$/);
    const amount = m ? parseFloat(m[1].replace(',', '.')) : null;
    let rest = m ? m[2] : line;
    let unit = '';
    const u = rest.match(/^([a-zA-ZäöüÄÖÜ]+\.?)\s+(.+)$/);
    if (amount !== null && u && (u[1].toLowerCase().replace(/\.$/, '') in UNIT_ALIAS)) {
      unit = u[1].toLowerCase().replace(/\.$/, '');
      rest = u[2];
    }
    const name = rest.replace(/,\s*$/, '').trim();
    if (!name) continue;

    const conv = { g: ['g', 1], kg: ['g', 1000], ml: ['ml', 1], l: ['ml', 1000] }[unit];
    let unitKey, value;
    if (conv) { unitKey = conv[0]; value = amount === null ? null : amount * conv[1]; }
    else { unitKey = unit ? UNIT_ALIAS[unit] : ''; value = amount; }

    const key = unitKey + '|' + name.toLowerCase();
    const g = groups.get(key) || { unitKey, name, total: 0, hasAmount: false };
    if (value !== null) { g.total += value; g.hasAmount = true; }
    groups.set(key, g);
  }
  return [...groups.values()].map(g => {
    if (!g.hasAmount) return g.name;
    let total = g.total, unit = g.unitKey;
    if (unit === 'g' && total >= 1000) { total /= 1000; unit = 'kg'; }
    if (unit === 'ml' && total >= 1000) { total /= 1000; unit = 'l'; }
    return `${fmtNum(total)}${unit ? ' ' + unit : ''} ${g.name}`;
  });
}

// Einkaufsliste nur aus den ausgewählten Gerichten (Hauptgericht, vegetarisch oder keins)
function shoppingFromMeals(meals) {
  const list = [];
  for (const m of meals || []) {
    const use = m.use ?? 'main';
    if (use === 'none') continue;
    const src = use === 'veg' && m.vegetarian ? m.vegetarian : m;
    list.push(...(src.ingredients || []));
  }
  return mergeShopping(list);
}

function shopBox(list) {
  const items = mergeShopping(list);
  if (!items.length) return '';
  const p = shopPersons();
  return `
    <h2>Einkaufsliste</h2>
    <div style="display:flex;align-items:center;gap:10px;margin:8px 0">
      <span class="muted">Einkauf für</span>
      <button data-shop="-1" style="width:auto;padding:4px 14px;margin:0">−</button>
      <strong>${p} ${p === 1 ? 'Person' : 'Personen'}</strong>
      <button data-shop="1" style="width:auto;padding:4px 14px;margin:0">+</button>
    </div>
    <ul class="shop">${items.map(i => `<li>${esc(scaleText(i, p))}</li>`).join('')}</ul>
    <button id="copyShop">In die Zwischenablage kopieren</button>
    ${navigator.share ? '<button id="shareShop" class="secondary">Teilen</button>' : ''}
    <p class="muted">Dann in Bring! einfügen. Jede Zeile ist ein Eintrag.</p>`;
}

function recipeBlock(r, id, base, label) {
  const n = portions[id] ?? base;
  const f = n / base;
  const nut = `${Math.round((r.kcal || 0) * f)} kcal · E ${round((r.protein || 0) * f)} g · KH ${round((r.carbs || 0) * f)} g · F ${round((r.fat || 0) * f)} g`;
  return `
    <details class="recipe" data-rid="${id}" ${openRecipes.has(id) ? 'open' : ''}>
      <summary>${label}</summary>
      <div class="portion" style="display:flex;align-items:center;gap:10px;margin:8px 0">
        <span class="muted">Personen</span>
        <button data-port="${id}" data-d="-1" data-base="${base}" style="width:auto;padding:4px 14px;margin:0">−</button>
        <strong>${n}</strong>
        <button data-port="${id}" data-d="1" data-base="${base}" style="width:auto;padding:4px 14px;margin:0">+</button>
      </div>
      <div class="muted">${nut}</div>
      <strong>Zutaten</strong>
      <ul>${(r.ingredients || []).map(i => `<li>${esc(scaleText(i, f))}</li>`).join('')}</ul>
      <strong>Zubereitung</strong>
      <ol>${(r.steps || []).map(s => `<li>${esc(s)}</li>`).join('')}</ol>
    </details>`;
}

function plainRecipe(r, id, label) {
  return `
    <details class="recipe" data-rid="${id}" ${openRecipes.has(id) ? 'open' : ''}>
      <summary>${label}</summary>
      <div class="muted">${Math.round(r.kcal || 0)} kcal · E ${round(r.protein || 0)} g · KH ${round(r.carbs || 0)} g · F ${round(r.fat || 0)} g</div>
      <strong>Zutaten</strong>
      <ul>${(r.ingredients || []).map(i => `<li>${esc(i)}</li>`).join('')}</ul>
      <strong>Zubereitung</strong>
      <ol>${(r.steps || []).map(s => `<li>${esc(s)}</li>`).join('')}</ol>
    </details>`;
}

/* ---------- Heute ---------- */
function todaysMeals() {
  return load(LS.meals, []).filter(m => m.date === today());
}

function currentTargets() {
  const g = load(LS.goals, {});
  const custom = Object.keys(DEFAULT_TARGETS).some(k => +g[k] > 0);
  const targets = Object.fromEntries(Object.entries(DEFAULT_TARGETS).map(([k, d]) => [k, +g[k] > 0 ? +g[k] : d]));
  return { targets, custom };
}

function adviceContext() {
  const meals = todaysMeals();
  const { targets, custom } = currentTargets();
  const prefs = load(LS.prefs, DEFAULT_PREFS);
  const key = `v4|${today()}|${meals.map(m => m.id).join(',')}|${prefs}|${JSON.stringify(targets)}`;
  return { meals, targets, custom, prefs, key };
}

function viewOverview() {
  const meals = todaysMeals();
  const total = (k) => meals.reduce((a, m) => a + sumItems(m.items, k), 0);
  const goals = load(LS.goals, {});
  const { custom } = currentTargets();
  const bar = (label, k, unit) => {
    const t = total(k), g = +goals[k] || 0;
    const pct = g ? Math.min(100, (t / g) * 100) : 0;
    return `<div class="bar">
      <div class="lbl"><span>${label}</span><span>${round(t)} ${unit}${g ? ' / ' + g : ''}</span></div>
      ${g ? `<div class="track"><div style="width:${pct}%"></div></div>` : ''}
    </div>`;
  };
  $('#app').innerHTML = `
    <h1>Übersicht</h1>
    ${bar('Kalorien', 'kcal', 'kcal')}
    ${bar('Eiweiß', 'protein', 'g')}
    ${bar('Kohlenhydrate', 'carbs', 'g')}
    ${bar('Fett', 'fat', 'g')}
    <h2>Mahlzeiten</h2>
    ${meals.length ? meals.map(m => `
      <div class="card meal">
        ${m.thumb ? `<img src="${m.thumb}" alt="">` : ''}
        <div class="grow">
          <strong>${new Date(m.at).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}</strong>
          <div class="muted">${m.items.map(i => esc(i.name)).join(', ')}</div>
          <div class="muted">${Math.round(sumItems(m.items, 'kcal'))} kcal · E ${round(sumItems(m.items, 'protein'))} g · KH ${round(sumItems(m.items, 'carbs'))} g · F ${round(sumItems(m.items, 'fat'))} g</div>
        </div>
        <button class="ghost" data-del="${m.id}">×</button>
      </div>`).join('') : '<p class="muted">Noch keine Mahlzeiten heute.</p>'}
    <h2>Nächste Mahlzeit</h2>
    <p class="muted">${custom ? 'Basierend auf deinen Zielen.' : 'Ohne eigene Ziele rechne ich mit Richtwerten. Du kannst sie unter Einstellungen festlegen.'}</p>
    <div id="advice">${adviceBox()}</div>
  `;
}

// Gerichte für heute aus dem Wochenplan, solange heute noch nichts gegessen wurde
function weekMealsToday() {
  const week = load(LS.week, null);
  if (week?.weekKey !== currentWeekKey()) return null;
  const meals = week.days?.[(new Date().getDay() + 6) % 7]?.meals || [];
  return meals.length ? meals : null;
}

function adviceBox() {
  if (!todaysMeals().length) {
    const wm = weekMealsToday();
    if (wm) return renderAdvice({ summary: 'Heute aus dem Wochenplan. Mit „Anderes Rezept“ ersetzt du ein Gericht, auch im Wochenplan.', meals: wm, shoppingList: [], tips: [] });
  }
  if (!localStorage.getItem(LS.key)) {
    return '<p class="muted">Für Empfehlungen den Gemini-Schlüssel unter Einstellungen eintragen.</p>';
  }
  if (adviceBusy) return '<p class="muted">Empfehlung wird erstellt …</p>';

  const { key } = adviceContext();
  const cache = load(LS.advice, null);
  if (cache?.key === key) {
    const errHtml = adviceError?.key === key ? `<p class="muted">${esc(adviceError.msg)}</p>` : '';
    return errHtml + renderAdvice(cache.data) + '<button class="secondary" data-refresh="1">Neu berechnen</button>';
  }
  if (adviceError?.key === key) {
    return `<p class="muted">${esc(adviceError.msg)}</p><button class="secondary" data-refresh="1">Erneut versuchen</button>`;
  }
  setTimeout(loadAdvice, 0);
  return '<p class="muted">Empfehlung wird erstellt …</p>';
}

function refreshAdviceView() {
  const el = $('#advice');
  if (el) el.innerHTML = adviceBox();
}

async function loadAdvice() {
  const apiKey = localStorage.getItem(LS.key);
  if (adviceBusy || !apiKey) return;
  const ctx = adviceContext();
  const cache = load(LS.advice, null);
  if (cache?.key === ctx.key) return;

  adviceBusy = true;
  adviceError = null;
  refreshAdviceView();
  try {
    const data = await gemini([{ text: advicePrompt(ctx) }], ADVICE_SCHEMA, apiKey);
    portions = {};
    save(LS.advice, { key: ctx.key, data });
  } catch (e) {
    adviceError = { key: ctx.key, msg: 'Empfehlung fehlgeschlagen: ' + e.message };
  } finally {
    adviceBusy = false;
    refreshAdviceView();
  }
}

async function swapAdviceMeal(i) {
  if (!todaysMeals().length && weekMealsToday()) return swapMeal((new Date().getDay() + 6) % 7, i);
  const apiKey = localStorage.getItem(LS.key);
  const cache = load(LS.advice, null);
  if (!apiKey || !cache || adviceBusy) return;
  const data = cache.data;
  const old = data.meals[i];
  adviceBusy = true;
  adviceError = null;
  refreshAdviceView();
  try {
    const titles = data.meals.map(m => m.title).join('; ');
    const prefs = load(LS.prefs, DEFAULT_PREFS);
    const prompt = `Ersetze eine Mahlzeit im Essensplan für heute. Slot: ${slotOf(old)}. Uhrzeit: ${old.time}. Das bisherige Gericht "${old.title}" gefällt nicht. Schlage ein anderes Gericht vor, das nicht in dieser Liste steht: ${titles}.
Tagesablauf: ${routineText()}
Wünsche und Vorlieben der Person: ${prefs || 'keine angegeben'}.
${RECIPE_RULES}
Antworte auf Deutsch und ausschließlich als JSON nach dem vorgegebenen Schema.`;
    const meal = await gemini([{ text: prompt }], MEAL_ITEM, apiKey);
    data.meals[i] = { ...meal, slot: old.slot, time: meal.time || old.time };

    const lines = data.meals.flatMap(m => [...(m.ingredients || []), ...(m.vegetarian?.ingredients || [])]);
    const shop = await gemini([{ text: `Erstelle aus diesen Zutaten eine zusammengefasste Einkaufsliste für 1 Person. Gleiche Zutaten zusammenfassen, Mengen addieren, eine Zeile pro Eintrag mit Menge, z. B. "500 g Hähnchenbrust". Zutaten: ${lines.join('; ')}. Antworte als JSON nach dem Schema.` }], SHOP_SCHEMA, apiKey);
    data.shoppingList = shop.shoppingList || data.shoppingList;

    delete portions[`m${i}`];
    delete portions[`v${i}`];
    save(LS.advice, { key: cache.key, data });
  } catch (e) {
    adviceError = { key: cache.key, msg: 'Ersetzen fehlgeschlagen: ' + e.message };
  } finally {
    adviceBusy = false;
    refreshAdviceView();
  }
}

/* ---------- Tagesablauf & Prompts ---------- */
function dayRoutine(wd) {
  const workday = wd >= 1 && wd <= 5;
  const training = wd === 2 || wd === 4;
  if (workday) {
    return [
      'Arbeitstag: Aufstehen um 7:00, ab 7:30 in der Firma, Mittagessen um 12:00 in der Firma. Ein schnelles Frühstück zu Hause vor der Arbeit (ca. 6:45 bis 7:15) ist sinnvoll, damit die Person nicht bis zur Mittagspause ohne Essen bleibt. Das Mittagessen soll sich gut mitnehmen lassen.',
      training
        ? 'Fußball-Training an diesem Tag: Die Person verlässt um 19:00 das Haus. Plane einen kleinen, leichten Snack um 17:30 bis 18:00 (mit Kohlenhydraten) und das Abendessen nach dem Training ab ca. 20:30.'
        : 'Kein Training an diesem Tag: Abendessen gegen 19:00. Ein kleiner Snack am Nachmittag ist optional.'
    ].join('\n');
  }
  return 'Wochenende: flexible Zeiten. Frühstück ca. 9:00, Mittagessen ca. 13:00, Abendessen ca. 19:00.';
}

function routineText() {
  const wd = new Date().getDay();
  const now = new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  return `Heute ist ${WEEKDAYS[wd]}. Es ist jetzt ${now} Uhr. Plane nur Zeiten, die noch nicht vorbei sind.\n${dayRoutine(wd)}`;
}

const RECIPE_RULES = `Regeln für Rezepte:
- Einfach und schnell: höchstens etwa 20 Minuten aktive Zeit, wenige Zutaten, Alltagsküche, keine aufwendigen Techniken. prepMinutes ist die Gesamtzeit in Minuten.
- Rezepte für 1 Person (servings: 1).
- Jede Zutat beginnt mit einer Menge in Zahlen, z. B. "150 g Haferflocken" oder "2 Eier", damit die Mengen umgerechnet werden können.
- Jede Mahlzeit bekommt zusätzlich eine vegetarische Alternative (vegetarian) mit eigenem Rezept und Nährwerten. Ist die Hauptmahlzeit schon vegetarisch, gib eine andere vegetarische Variante an.
- Abendessen: Das Hauptgericht ist immer vegetarisch. Die vegetarische Alternative ist dann eine andere vegetarische Variante.
- Frühstück und Mittagessen sind vorbereitbar: Sie werden für 2 bis 3 Tage auf einmal gekocht und im Kühlschrank aufbewahrt. In der Firma steht eine Mikrowelle zum Aufwärmen bereit, die Gerichte dürfen also warm gegessen werden. Sie lassen sich gut in einer Dose transportieren.`;

function advicePrompt({ meals, targets, custom, prefs }) {
  const items = meals.flatMap(m => m.items);
  const eaten = {
    kcal: sumItems(items, 'kcal'), protein: sumItems(items, 'protein'),
    carbs: sumItems(items, 'carbs'), fat: sumItems(items, 'fat')
  };
  const open = Object.fromEntries(Object.keys(targets).map(k => [k, Math.max(0, Math.round(targets[k] - eaten[k]))]));
  const foodList = items.length
    ? items.map(i => `${i.name} (${Math.round(i.grams || 0)} g, ${Math.round(i.kcal || 0)} kcal)`).join('; ')
    : 'noch nichts';
  const task = meals.length
    ? 'Schlage 1 bis 3 Mahlzeiten oder Snacks vor, die den offenen Bedarf sinnvoll decken und zum bereits Gegessenen passen. Wenn das Tagesziel schon überschritten ist, schlage nur leichte Optionen vor und sag das offen.'
    : 'Erstelle einen Essensplan für den ganzen Tag mit Frühstück, Mittagessen, Abendessen und einem Snack, der die Tagesziele möglichst genau trifft und zum Tagesablauf passt.';

  return `Du bist ein Ernährungsassistent für eine Privatperson. Du gibst keine medizinische Beratung; bei gesundheitlichen Fragen verweist du auf Ärztinnen und Ärzte. Alle Nährwerte sind Schätzungen.
${routineText()}
Tagesziele${custom ? '' : ' (Richtwerte, da keine eigenen Ziele hinterlegt sind)'}: ${targets.kcal} kcal, ${targets.protein} g Eiweiß, ${targets.carbs} g Kohlenhydrate, ${targets.fat} g Fett.
Bereits heute gegessen: ${foodList}.
Noch offen: ${open.kcal} kcal, ${open.protein} g Eiweiß, ${open.carbs} g Kohlenhydrate, ${open.fat} g Fett.
Wünsche und Vorlieben der Person: ${prefs || 'keine angegeben'}.
Aufgabe: ${task}

${RECIPE_RULES}
- Jede Mahlzeit bekommt eine Zuordnung (slot: Frühstück, Mittagessen, Abendessen oder Snack), eine Uhrzeit, einen kurzen Titel und eine kurze Beschreibung.
- Die Einkaufsliste (shoppingList) gilt für 1 Person und enthält die Zutaten aller Hauptmahlzeiten und vegetarischen Alternativen. Gleiche Zutaten fasst du zusammen. Jeder Eintrag steht in einer eigenen Zeile mit Menge, z. B. "500 g Hähnchenbrust". Die Vorräte sind unbekannt, also listest du alles auf, außer Dingen, die bereits gegessen wurden.
Antworte auf Deutsch und ausschließlich als JSON nach dem vorgegebenen Schema.`;
}

function weekPrompt(targets, prefs, indexes) {
  const dayLines = indexes.map(k => `${WEEK_ORDER[k]}: ${dayRoutine(WEEK_GETDAY[k]).replace(/\n/g, ' ')}`).join('\n');
  return `Du bist ein Ernährungsassistent für eine Privatperson. Du gibst keine medizinische Beratung. Alle Nährwerte sind Schätzungen.
Erstelle einen Wochenplan für ${indexes.length} Tage in genau dieser Reihenfolge: ${indexes.map(k => WEEK_ORDER[k]).join(', ')}. days[0] ist ${WEEK_ORDER[indexes[0]]}.
Tagesabläufe:
${dayLines}
Tagesziele (Richtwerte pro Tag): ${targets.kcal} kcal, ${targets.protein} g Eiweiß, ${targets.carbs} g Kohlenhydrate, ${targets.fat} g Fett.
Wünsche und Vorlieben der Person: ${prefs || 'keine angegeben'}.

${RECIPE_RULES}
- Pro Tag Frühstück, Mittagessen und Abendessen. Einen Snack nur dort, wo der Tagesablauf es nahelegt.
- Wenig Einkauf: Die ganze Woche nutzt nur einen kleinen Kreis an Zutaten (etwa 8 bis 10 Hauptzutaten). Verwende bevorzugt diese, sofern sie zu den Wünschen passen: Hähnchenbrust, Hackfleisch, Vollkornnudeln, Reis, Haferflocken, Magerquark, Eier, Naturjoghurt, Brokkoli, Zucchini, Paprika, Bananen. Dieselbe Zutat in gleicher Menge darf in mehreren Gerichten vorkommen, z. B. Reis mittags und abends. Vermeide Zutaten, die nur in einem einzigen Gericht vorkommen.
- Abwechslung trotzdem: Gerichte, Gewürze und Zubereitung wechseln. Kein Gericht mehr als einmal in der Woche.
- Zeitsparen: Plane Mittagessen so, dass sie für mehrere Tage vorbereitet werden können.
- Jede Mahlzeit bekommt eine Zuordnung (slot), eine Uhrzeit, einen kurzen Titel und eine kurze Beschreibung.
- Die Einkaufsliste (shoppingList) gilt für 1 Person und fasst die Zutaten der ganzen Woche zusammen (Hauptmahlzeiten und vegetarische Alternativen). Gleiche Zutaten zusammenfassen, Mengen addieren, eine Zeile pro Eintrag mit Menge.
Antworte auf Deutsch und ausschließlich als JSON nach dem vorgegebenen Schema.`;
}

/* ---------- Anzeige Empfehlungen (Heute) ---------- */
const slotOf = (m) => (SLOTS.includes(m.slot) ? m.slot : 'Snack');

function mealCard(m, i) {
  const base = m.servings || 1;
  return `
    <div class="card">
      <div class="grow">
        <strong>${esc(m.time)} · ${esc(m.title)}</strong>
        <div class="muted">${esc(m.description)}</div>
        ${m.prepMinutes ? `<div class="muted">⏱ ca. ${Math.round(m.prepMinutes)} Min.</div>` : ''}
        ${recipeBlock(m, `m${i}`, base, 'Rezept anzeigen')}
        ${m.vegetarian ? recipeBlock(m.vegetarian, `v${i}`, base, `Vegetarisch: ${esc(m.vegetarian.title)}`) : ''}
        <button class="secondary" data-aswap="${i}" ${adviceBusy ? 'disabled' : ''} style="margin-top:8px">Anderes Rezept</button>
      </div>
    </div>`;
}

// Index der nächsten Mahlzeit (ab 30 Min. vor der Uhrzeit gilt sie noch als „nächste“)
function nextMealIndex(meals) {
  const d = new Date();
  const nowMin = d.getHours() * 60 + d.getMinutes() - 30;
  return meals.findIndex(m => {
    const t = String(m.time || '').match(/(\d{1,2})[:.](\d{2})/);
    return t && (+t[1]) * 60 + (+t[2]) >= nowMin;
  });
}

function renderAdvice(d) {
  const meals = d.meals || [];
  if (!meals.length) return '<p class="muted">Keine Empfehlung vorhanden.</p>';
  const next = nextMealIndex(meals);
  const later = next === -1 ? [] : meals.map((m, i) => ({ m, i })).filter(({ i }) => i > next);
  const main = next === -1
    ? '<p class="muted">Für heute sind keine weiteren Mahlzeiten geplant.</p>'
    : mealCard(meals[next], next);

  return `
    <p class="muted">${esc(d.summary)}</p>
    ${main}
    ${later.length ? `<h3 class="slot">Danach heute</h3><ul>${later.map(({ m }) => `<li>${esc(m.time)} · ${esc(m.slot)}: ${esc(m.title)}</li>`).join('')}</ul>` : ''}
    ${shoppingFromMeals(meals).length ? `<details style="margin-top:12px"><summary>Einkaufsliste für heute</summary>${shopBox(shoppingFromMeals(meals))}</details>` : ''}
    ${d.tips?.length ? `<details style="margin-top:12px"><summary>Tipps</summary><ul>${d.tips.map(t => `<li>${esc(t)}</li>`).join('')}</ul></details>` : ''}
    <p class="muted">Schätzungen, keine medizinische Beratung.</p>`;
}

/* ---------- Wochenplan ---------- */
function currentWeekKey() {
  const now = new Date();
  const offset = (now.getDay() + 6) % 7;
  const mon = new Date(now);
  mon.setDate(now.getDate() - offset);
  return mon.toLocaleDateString('sv-SE');
}

function dateLabel(weekKey, k) {
  const d = new Date(weekKey + 'T00:00');
  d.setDate(d.getDate() + k);
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
}

function viewWeek() {
  const week = load(LS.week, null);
  const current = week?.weekKey === currentWeekKey() ? week : null;
  let body;
  if (!localStorage.getItem(LS.key)) {
    body = '<p class="muted">Für den Wochenplan den Gemini-Schlüssel unter Einstellungen eintragen.</p>';
  } else if (weekBusy) {
    body = progress ? progressBox() : `<p class="muted">${esc(weekStatus)}</p>`;
  } else if (!current) {
    body = `${weekError ? `<p class="muted">${esc(weekError)}</p>` : ''}
      <p class="muted">Noch kein Wochenplan für diese Woche.</p>
      <button id="createWeek">Wochenplan erstellen</button>`;
  } else {
    body = weekDays(current) + '<details style="margin-top:12px"><summary>Einkaufsliste der ganzen Woche</summary>' + shopBox(shoppingFromMeals(current.days.flatMap(d => d.meals || []))) + '</details>' +
      (weekError ? `<p class="muted">${esc(weekError)}</p>` : '') +
      `<button class="secondary" id="createWeek">Neuen Wochenplan erstellen</button>`;
  }
  $('#app').innerHTML = `
    <h1>Wochenplan</h1>
    <p class="muted">Geplant für 1 Person. Die Einkaufsliste lässt sich auf 1 oder 2 Personen umstellen.</p>
    ${body}`;
}

// Zeigt immer nur einen Tag, umschaltbar über die Tabs Mo–So
function weekDays(week) {
  const d = weekDay ?? ((new Date().getDay() + 6) % 7);
  const day = week.days[d] || { name: WEEK_ORDER[d], meals: [] };
  const meals = (day.meals || [])
    .map((m, i) => ({ m, i }))
    .sort((a, b) => SLOTS.indexOf(a.m.slot) - SLOTS.indexOf(b.m.slot));
  const tabs = `<div style="display:flex;gap:4px;margin:12px 0">${WEEK_ORDER.map((n, k) =>
    `<button data-wday="${k}" class="${k === d ? '' : 'secondary'}" style="flex:1;margin:0;padding:8px 0;font-size:14px">${n.slice(0, 2)}</button>`).join('')}</div>`;
  return `${tabs}
    <h2>${day.name} <span class="muted">${dateLabel(week.weekKey, d)}</span></h2>
    ${meals.length ? meals.map(({ m, i }) => weekMealCard(m, d, i)).join('') : '<p class="muted">Kein Plan für diesen Tag.</p>'}`;
}

function weekMealCard(m, d, i) {
  const use = m.use ?? 'main';
  return `
    <div class="card">
      <div class="grow">
        <div class="muted">${esc(m.slot)} · ${esc(m.time)}</div>
        <strong>${esc(m.title)}</strong>
        <div class="muted">${esc(m.description)}</div>
        ${m.prepMinutes ? `<div class="muted">⏱ ca. ${Math.round(m.prepMinutes)} Min.</div>` : ''}
        ${plainRecipe(m, `w${d}-${i}`, 'Rezept anzeigen')}
        ${m.vegetarian ? plainRecipe(m.vegetarian, `w${d}-${i}-v`, `Vegetarisch: ${esc(m.vegetarian.title)}`) : ''}
        <label class="muted" style="display:block;margin-top:8px">Einkaufen für
          <select data-use="${d}-${i}" style="margin-left:6px">
            <option value="main" ${use === 'main' ? 'selected' : ''}>Hauptgericht</option>
            <option value="veg" ${use === 'veg' ? 'selected' : ''} ${m.vegetarian ? '' : 'disabled'}>Vegetarisch</option>
            <option value="none" ${use === 'none' ? 'selected' : ''}>nicht einkaufen</option>
          </select>
        </label>
        <button class="secondary" data-swap="${d}-${i}" ${weekBusy ? 'disabled' : ''} style="margin-top:8px">Anderes Rezept</button>
      </div>
    </div>`;
}

/* Fortschrittsanzeige für den Wochenplan */
let progress = null;      // { pct, label, start }
let progressTimer = null;

function progressInner() {
  if (!progress) return '';
  const sec = Math.round((Date.now() - progress.start) / 1000);
  return `<div style="background:#1e293b;border-radius:8px;height:12px;overflow:hidden">
      <div style="height:100%;width:${progress.pct}%;background:#34d399;transition:width .5s"></div>
    </div>
    <p class="muted">${esc(progress.label)} · ${sec} s vergangen</p>`;
}

function progressBox() {
  return `<div id="progressBox" style="margin:12px 0">${progressInner()}</div>`;
}

function updateProgress() {
  const el = $('#progressBox');
  if (el) el.innerHTML = progressInner();
}

function setProgress(pct, label) {
  if (!progress) return;
  progress.pct = pct;
  progress.label = label;
  updateProgress();
}

function startProgress(label) {
  progress = { pct: 5, label, start: Date.now() };
  clearInterval(progressTimer);
  progressTimer = setInterval(updateProgress, 1000); // Zeit läuft sichtbar weiter
}

function stopProgress() {
  clearInterval(progressTimer);
  progressTimer = null;
  progress = null;
}

async function weekPart(targets, prefs, idx, apiKey) {
  const res = await gemini([{ text: weekPrompt(targets, prefs, idx) }], WEEK_SCHEMA, apiKey);
  return idx.map((k, j) => ({ name: WEEK_ORDER[k], meals: res.days?.[j]?.meals || [] }));
}

async function createWeek() {
  const apiKey = localStorage.getItem(LS.key);
  if (!apiKey || weekBusy) return;
  weekBusy = true;
  weekError = '';
  startProgress('Wochenplan wird gestartet …');
  render();
  try {
    const { targets } = currentTargets();
    const prefs = load(LS.prefs, DEFAULT_PREFS);
    setProgress(10, 'Teil 1 von 2: Montag bis Donnerstag wird geplant …');
    const first = await weekPart(targets, prefs, [0, 1, 2, 3], apiKey);
    setProgress(55, 'Teil 2 von 2: Freitag bis Sonntag wird geplant …');
    const second = await weekPart(targets, prefs, [4, 5, 6], apiKey);
    setProgress(95, 'Plan wird gespeichert …');
    save(LS.week, { weekKey: currentWeekKey(), days: [...first, ...second], shoppingList: [] });
  } catch (e) {
    weekError = 'Wochenplan fehlgeschlagen: ' + e.message;
  } finally {
    weekBusy = false;
    stopProgress();
    render();
  }
}

async function swapMeal(d, i) {
  const apiKey = localStorage.getItem(LS.key);
  const week = load(LS.week, null);
  if (!apiKey || !week || weekBusy) return;
  const old = week.days[d].meals[i];
  weekBusy = true;
  weekError = '';
  weekStatus = 'Rezept wird ersetzt …';
  render();
  try {
    const titles = week.days.flatMap(x => x.meals.map(m => m.title)).join('; ');
    const prompt = `Ersetze in einem Wochenplan eine Mahlzeit. Tag: ${week.days[d].name}. Slot: ${old.slot}. Uhrzeit: ${old.time}. Das bisherige Gericht "${old.title}" gefällt nicht. Schlage ein anderes Gericht vor, das nicht in dieser Liste steht: ${titles}. Nutze möglichst Zutaten, die in der Woche schon vorkommen, damit weniger eingekauft werden muss.
${RECIPE_RULES}
Wünsche und Vorlieben der Person: ${load(LS.prefs, DEFAULT_PREFS)}.
Antworte auf Deutsch und ausschließlich als JSON nach dem vorgegebenen Schema.`;
    const meal = await gemini([{ text: prompt }], MEAL_ITEM, apiKey);
    week.days[d].meals[i] = { ...meal, slot: old.slot, time: meal.time || old.time, use: old.use ?? 'main' };

    const lines = week.days.flatMap(x => x.meals.flatMap(m => [...(m.ingredients || []), ...(m.vegetarian?.ingredients || [])]));
    const shop = await gemini([{ text: `Erstelle aus diesen Zutaten einer Wochenplanung eine zusammengefasste Einkaufsliste für 1 Person. Gleiche Zutaten zusammenfassen, Mengen addieren, eine Zeile pro Eintrag mit Menge, z. B. "500 g Hähnchenbrust". Zutaten: ${lines.join('; ')}. Antworte als JSON nach dem Schema.` }], SHOP_SCHEMA, apiKey);
    week.shoppingList = shop.shoppingList || week.shoppingList;
    save(LS.week, week);
  } catch (e) {
    weekError = 'Ersetzen fehlgeschlagen: ' + e.message;
  } finally {
    weekBusy = false;
    weekStatus = '';
    render();
  }
}

/* ---------- Neue Mahlzeit ---------- */
function viewNew() {
  const fields = { grams: 'g', kcal: 'kcal', protein: 'Eiweiß', carbs: 'KH', fat: 'Fett' };
  $('#app').innerHTML = `
    <h1>Neue Mahlzeit</h1>
    <label class="file">
      <input type="file" id="photo" accept="image/*" capture="environment">
      <span>Foto aufnehmen oder wählen</span>
    </label>
    ${draft.thumb ? `<img class="preview" src="${draft.thumb}" alt="">` : ''}
    <textarea id="hint" placeholder="Optionaler Hinweis, z. B. Reis mit Hähnchen, ca. 300 g">${esc(draft.hint)}</textarea>
    <button id="analyze" ${draft.image ? '' : 'disabled'}>Analysieren</button>
    <p id="status" class="muted"></p>
    ${draft.items.length ? `
      <h2>Erkannt (bitte prüfen)</h2>
      ${draft.items.map((i, idx) => `
        <div class="card edit" data-idx="${idx}">
          <input data-f="name" value="${esc(i.name)}">
          <div class="grid">
            ${Object.entries(fields).map(([f, label]) =>
              `<label>${label}<input type="number" step="any" data-f="${f}" value="${i[f] ?? ''}"></label>`).join('')}
          </div>
          <button class="ghost" data-rm="${idx}">Entfernen</button>
        </div>`).join('')}
      <p><strong>Summe:</strong> ${Math.round(sumItems(draft.items, 'kcal'))} kcal · E ${round(sumItems(draft.items, 'protein'))} g · KH ${round(sumItems(draft.items, 'carbs'))} g · F ${round(sumItems(draft.items, 'fat'))} g</p>
      <button id="save">Speichern</button>` : ''}
  `;
  $('#photo').onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    draft.image = await compress(f, 1024, 0.8);
    draft.thumb = await compress(f, 240, 0.7);
    draft.items = [];
    render();
  };
  $('#hint').oninput = (e) => { draft.hint = e.target.value; };
  $('#analyze')?.addEventListener('click', analyze);
  $('#save')?.addEventListener('click', saveMeal);
}

async function analyze() {
  const key = localStorage.getItem(LS.key);
  const setStatus = (t) => { const el = $('#status'); if (el) el.textContent = t; };
  if (!key) return setStatus('Bitte zuerst den API-Schlüssel unter Einstellungen eintragen.');
  setStatus('Analysiere …');
  try {
    const parts = [
      { text: PROMPT + (draft.hint ? `\nHinweis vom Nutzer: ${draft.hint}` : '') },
      { inline_data: { mime_type: 'image/jpeg', data: draft.image.split(',')[1] } }
    ];
    const { items } = await gemini(parts, MEAL_SCHEMA, key);
    draft.items = items.map(i => ({ ...i, id: crypto.randomUUID() }));
    render();
  } catch (e) {
    setStatus('Fehler: ' + e.message);
  }
}

/* ---------- Gemini-Aufruf (mit Wiederholung bei Überlastung) ---------- */
async function gemini(parts, schema, apiKey) {
  const body = {
    contents: [{ parts }],
    generationConfig: { responseMimeType: 'application/json', responseSchema: schema }
  };
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body)
    });
    if ((res.status === 503 || res.status === 429) && attempt < 3) {
      await new Promise(r => setTimeout(r, 2000 * attempt));
      continue;
    }
    if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.map(p => p.text).join('') ?? '';
    return JSON.parse(text);
  }
}

function saveMeal() {
  const meals = load(LS.meals, []);
  meals.push({ id: crypto.randomUUID(), date: today(), at: Date.now(), items: draft.items, thumb: draft.thumb });
  save(LS.meals, meals);
  draft = { items: [], image: null, thumb: null, hint: '' };
  location.hash = '#uebersicht';
  render();
}

function compress(file, max, quality) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const s = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * s);
      c.height = Math.round(img.height * s);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', quality));
    };
    img.onerror = reject;
    img.src = url;
  });
}

/* ---------- Einstellungen ---------- */
function viewSettings() {
  const goals = load(LS.goals, {});
  $('#app').innerHTML = `
    <h1>Einstellungen</h1>
    <h2>Gemini-API-Schlüssel</h2>
    <p class="muted">Wird nur auf diesem Gerät gespeichert, nicht im Code.</p>
    <input type="password" id="apikey" value="${esc(localStorage.getItem(LS.key))}" placeholder="API-Schlüssel">
    <button id="saveKey">Schlüssel speichern</button>
    <h2>Wünsche & Vorlieben</h2>
    <p class="muted">Fließen in Essensplan und Empfehlungen ein.</p>
    <textarea id="prefs">${esc(load(LS.prefs, DEFAULT_PREFS))}</textarea>
    <button id="savePrefs">Wünsche speichern</button>
    <h2>Tagesziele (optional)</h2>
    <p class="muted">Ohne Ziele rechnet die App mit Richtwerten: ${DEFAULT_TARGETS.kcal} kcal, ${DEFAULT_TARGETS.protein} g Eiweiß, ${DEFAULT_TARGETS.carbs} g Kohlenhydrate, ${DEFAULT_TARGETS.fat} g Fett.</p>
    <div class="grid">
      ${['kcal', 'protein', 'carbs', 'fat'].map(k => `<label>${k}<input type="number" data-goal="${k}" value="${goals[k] ?? ''}"></label>`).join('')}
    </div>
    <button id="saveGoals">Ziele speichern</button>
    <h2>Geräte-Sync</h2>
    <p class="muted">Alle Geräte mit denselben Angaben sehen denselben Plan. Projekt-ID und Web-API-Schlüssel aus Firebase, den Sync-Code kannst du neu erzeugen.</p>
    <input id="syncPid" placeholder="Firebase Projekt-ID" value="${esc(syncConfigured()?.projectId ?? load(LS.sync, {})?.projectId ?? '')}">
    <input id="syncApi" placeholder="Web-API-Schlüssel" value="${esc(load(LS.sync, {})?.apiKey ?? '')}">
    <input id="syncCode" placeholder="Sync-Code" value="${esc(load(LS.sync, {})?.code ?? '')}">
    <button id="genCode" class="secondary">Neuen Sync-Code erzeugen</button>
    <button id="saveSync">Speichern und synchronisieren</button>
    <p id="syncStatus" class="muted"></p>
    <h2>Daten</h2>
    <button id="exp">Backup exportieren</button>
    <label class="file"><input type="file" id="imp" accept="application/json"><span>Backup importieren</span></label>
  `;
  $('#saveKey').onclick = () => {
    localStorage.setItem(LS.key, $('#apikey').value.trim());
    alert('Gespeichert.');
  };
  $('#genCode').onclick = () => {
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    $('#syncCode').value = Array.from(bytes, b => b.toString(36).padStart(2, '0')).join('').slice(0, 32);
  };
  $('#saveSync').onclick = async () => {
    save(LS.sync, {
      projectId: $('#syncPid').value.trim(),
      apiKey: $('#syncApi').value.trim(),
      code: $('#syncCode').value.trim()
    });
    if (!syncConfigured()) return setSyncStatus('Bitte Projekt-ID, Web-API-Schlüssel und Sync-Code ausfüllen.');
    setSyncStatus('Synchronisiere …');
    await syncPull();
    await syncPush();
  };
  $('#savePrefs').onclick = () => {
    save(LS.prefs, $('#prefs').value.trim());
    alert('Wünsche gespeichert.');
  };
  $('#saveGoals').onclick = () => {
    const g = {};
    document.querySelectorAll('[data-goal]').forEach(i => { g[i.dataset.goal] = parseFloat(i.value) || 0; });
    save(LS.goals, g);
    alert('Ziele gespeichert.');
  };
  $('#exp').onclick = () => {
    const blob = new Blob([JSON.stringify({ meals: load(LS.meals, []), goals: load(LS.goals, {}), prefs: load(LS.prefs, DEFAULT_PREFS), week: load(LS.week, null) }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'ernaehrung-backup.json';
    a.click();
  };
  $('#imp').onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      const current = load(LS.meals, []);
      const ids = new Set(current.map(m => m.id));
      save(LS.meals, [...current, ...(data.meals || []).filter(m => !ids.has(m.id))]);
      if (data.goals) save(LS.goals, data.goals);
      if (data.prefs) save(LS.prefs, data.prefs);
      if (data.week) save(LS.week, data.week);
      alert('Backup importiert.');
    } catch {
      alert('Die Datei konnte nicht gelesen werden.');
    }
  };
}

/* ---------- Globale Ereignisse ---------- */
document.addEventListener('click', async (e) => {
  const t = e.target;
  if (t.dataset?.del && confirm('Mahlzeit löschen?')) {
    save(LS.meals, load(LS.meals, []).filter(m => m.id !== t.dataset.del));
    render();
  }
  if (t.dataset?.rm !== undefined) {
    draft.items.splice(+t.dataset.rm, 1);
    render();
  }
  if (t.dataset?.port) {
    const id = t.dataset.port;
    const base = +t.dataset.base;
    portions[id] = Math.max(1, (portions[id] ?? base) + +t.dataset.d);
    refreshAdviceView();
  }
  if (t.dataset?.shop) {
    save(LS.shopPersons, Math.max(1, shopPersons() + +t.dataset.shop));
    render();
  }
  if (t.id === 'copyShop') {
    const text = Array.from(document.querySelectorAll('ul.shop li')).map(li => li.textContent).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      t.textContent = 'Kopiert ✓';
    } catch {
      alert('Kopieren nicht möglich. Bitte die Liste markieren und kopieren:\n\n' + text);
    }
  }
  if (t.id === 'shareShop') {
    const text = Array.from(document.querySelectorAll('ul.shop li')).map(li => li.textContent).join('\n');
    navigator.share({ title: 'Einkaufsliste', text }).catch(() => {});
  }
  if (t.dataset?.refresh) {
    save(LS.advice, null);
    adviceError = null;
    refreshAdviceView();
  }
  if (t.dataset?.aswap !== undefined) swapAdviceMeal(+t.dataset.aswap);
  if (t.dataset?.wday !== undefined) { weekDay = +t.dataset.wday; render(); }
  if (t.id === 'createWeek') createWeek();
  if (t.dataset?.swap) {
    const [d, i] = t.dataset.swap.split('-').map(Number);
    swapMeal(d, i);
  }
});

// Offene Rezepte merken, damit sie beim Neuzeichnen offen bleiben
document.addEventListener('toggle', (e) => {
  const d = e.target;
  if (d.dataset?.rid) {
    if (d.open) openRecipes.add(d.dataset.rid);
    else openRecipes.delete(d.dataset.rid);
  }
}, true);

document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.dataset?.use) {
    const [d, i] = t.dataset.use.split('-').map(Number);
    const week = load(LS.week, null);
    if (!week?.days?.[d]?.meals?.[i]) return;
    week.days[d].meals[i].use = t.value;
    save(LS.week, week);
    render();
  }
});

document.addEventListener('input', (e) => {
  const t = e.target;
  const card = t.closest?.('[data-idx]');
  if (card && t.dataset.f) {
    const item = draft.items[+card.dataset.idx];
    item[t.dataset.f] = t.dataset.f === 'name' ? t.value : (parseFloat(t.value) || 0);
  }
});

window.addEventListener('hashchange', render);
document.addEventListener('visibilitychange', () => { if (!document.hidden) pullAndRender(); });
render();
pullAndRender();

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
