const MODEL = 'gemini-2.5-flash';
const LS = { meals: 'ern.meals', key: 'ern.geminiKey', goals: 'ern.goals' };
const PROMPT = `Du analysierst ein Foto einer Mahlzeit. Erkenne jedes sichtbare Lebensmittel, schätze die Menge in Gramm und die Nährwerte (kcal, Eiweiß, Kohlenhydrate, Fett in Gramm) für genau diese Menge. Antworte ausschließlich mit JSON. Wenn etwas unklar ist, schätze eher konservativ und vermerke die Unsicherheit im Namen.`;

const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const save = (k, v) => localStorage.setItem(k, JSON.stringify(v));
const $ = (s) => document.querySelector(s);
const today = () => new Date().toLocaleDateString('sv-SE');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const round = (n) => Math.round(n * 10) / 10;
const sumItems = (items, k) => items.reduce((b, i) => b + (+i[k] || 0), 0);

let draft = { items: [], image: null, thumb: null, hint: '' };

/* ---------- Routing ---------- */
function render() {
  const route = (location.hash || '#heute').slice(1);
  document.querySelectorAll('nav a').forEach(a => a.classList.toggle('on', a.getAttribute('href') === '#' + route));
  ({ heute: viewToday, neu: viewNew, einstellungen: viewSettings }[route] || viewToday)();
}

/* ---------- Heute ---------- */
function viewToday() {
  const meals = load(LS.meals, []).filter(m => m.date === today());
  const total = (k) => meals.reduce((a, m) => a + sumItems(m.items, k), 0);
  const goals = load(LS.goals, {});
  const bar = (label, k, unit) => {
    const t = total(k), g = +goals[k] || 0;
    const pct = g ? Math.min(100, (t / g) * 100) : 0;
    return `<div class="bar">
      <div class="lbl"><span>${label}</span><span>${round(t)} ${unit}${g ? ' / ' + g : ''}</span></div>
      ${g ? `<div class="track"><div style="width:${pct}%"></div></div>` : ''}
    </div>`;
  };
  $('#app').innerHTML = `
    <h1>Heute</h1>
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
  `;
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
    const items = await callGemini(draft.image.split(',')[1], draft.hint, key);
    draft.items = items.map(i => ({ ...i, id: crypto.randomUUID() }));
    render();
  } catch (e) {
    setStatus('Fehler: ' + e.message);
  }
}

async function callGemini(base64, hint, apiKey) {
  const body = {
    contents: [{
      parts: [
        { text: PROMPT + (hint ? `\nHinweis vom Nutzer: ${hint}` : '') },
        { inline_data: { mime_type: 'image/jpeg', data: base64 } }
      ]
    }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: {
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
      }
    }
  };
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.map(p => p.text).join('') ?? '';
  return JSON.parse(text).items;
}

function saveMeal() {
  const meals = load(LS.meals, []);
  meals.push({ id: crypto.randomUUID(), date: today(), at: Date.now(), items: draft.items, thumb: draft.thumb });
  save(LS.meals, meals);
  draft = { items: [], image: null, thumb: null, hint: '' };
  location.hash = '#heute';
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
    <h2>Tagesziele (optional)</h2>
    <div class="grid">
      ${['kcal', 'protein', 'carbs', 'fat'].map(k => `<label>${k}<input type="number" data-goal="${k}" value="${goals[k] ?? ''}"></label>`).join('')}
    </div>
    <button id="saveGoals">Ziele speichern</button>
    <h2>Daten</h2>
    <button id="exp">Backup exportieren</button>
    <label class="file"><input type="file" id="imp" accept="application/json"><span>Backup importieren</span></label>
  `;
  $('#saveKey').onclick = () => {
    localStorage.setItem(LS.key, $('#apikey').value.trim());
    alert('Gespeichert.');
  };
  $('#saveGoals').onclick = () => {
    const g = {};
    document.querySelectorAll('[data-goal]').forEach(i => { g[i.dataset.goal] = parseFloat(i.value) || 0; });
    save(LS.goals, g);
    alert('Ziele gespeichert.');
  };
  $('#exp').onclick = () => {
    const blob = new Blob([JSON.stringify({ meals: load(LS.meals, []), goals: load(LS.goals, {}) }, null, 2)], { type: 'application/json' });
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
      alert('Backup importiert.');
    } catch {
      alert('Die Datei konnte nicht gelesen werden.');
    }
  };
}

/* ---------- Globale Ereignisse ---------- */
document.addEventListener('click', (e) => {
  const t = e.target;
  if (t.dataset?.del && confirm('Mahlzeit löschen?')) {
    save(LS.meals, load(LS.meals, []).filter(m => m.id !== t.dataset.del));
    render();
  }
  if (t.dataset?.rm !== undefined) {
    draft.items.splice(+t.dataset.rm, 1);
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
render();

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
