// Erstellt jeden Morgen um 6 Uhr (Berlin) den Tagesplan und montags den Wochenplan
// und legt beides in Firestore ab. Läuft über GitHub Actions.
// Hinweis: Die Prompts sind Kopien aus app.js. Bei Änderungen dort auch hier anpassen.

const env = process.env;
const PID = env.FIREBASE_PROJECT_ID;
const FAPI = env.FIREBASE_WEB_API_KEY;
const CODE = env.SYNC_CODE;
const GKEY = env.GEMINI_API_KEY;
const FORCE = env.FORCE === 'true';
const MODEL = 'gemini-3.8-flash';

const DEFAULT_PREFS = 'Spielt privat Fußball. Möchte zu Hause etwas Sport machen.';
const DEFAULT_TARGETS = { kcal: 2200, protein: 120, carbs: 250, fat: 70 };
const WEEKDAYS = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
const WEEK_ORDER = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];
const WEEK_GETDAY = [1, 2, 3, 4, 5, 6, 0];
const SLOTS = ['Frühstück', 'Mittagessen', 'Abendessen', 'Snack'];

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
    days: { type: 'ARRAY', items: { type: 'OBJECT', properties: { meals: { type: 'ARRAY', items: MEAL_ITEM } }, required: ['meals'] } },
    shoppingList: { type: 'ARRAY', items: { type: 'STRING' } }
  },
  required: ['days', 'shoppingList']
};

const RECIPE_RULES = `Regeln für Rezepte:
- Einfach und schnell: höchstens etwa 20 Minuten aktive Zeit, wenige Zutaten, Alltagsküche, keine aufwendigen Techniken. prepMinutes ist die Gesamtzeit in Minuten.
- Rezepte für 1 Person (servings: 1).
- Jede Zutat beginnt mit einer Menge in Zahlen, z. B. "150 g Haferflocken" oder "2 Eier", damit die Mengen umgerechnet werden können.
- Jede Mahlzeit bekommt zusätzlich eine vegetarische Alternative (vegetarian) mit eigenem Rezept und Nährwerten. Ist die Hauptmahlzeit schon vegetarisch, gib eine andere vegetarische Variante an.
- Abendessen: Das Hauptgericht ist immer vegetarisch. Die vegetarische Alternative ist dann eine andere vegetarische Variante.
- Frühstück und Mittagessen sind vorbereitbar: Sie werden für 2 bis 3 Tage auf einmal gekocht und im Kühlschrank aufbewahrt. In der Firma steht eine Mikrowelle zum Aufwärmen bereit, die Gerichte dürfen also warm gegessen werden. Sie lassen sich gut in einer Dose transportieren.`;

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

function advicePrompt({ meals, targets, custom, prefs, routine }) {
  const items = meals.flatMap(m => m.items || []);
  const sum = (k) => items.reduce((b, i) => b + (+i[k] || 0), 0);
  const open = Object.fromEntries(Object.keys(targets).map(k => {
    const eaten = { kcal: sum('kcal'), protein: sum('protein'), carbs: sum('carbs'), fat: sum('fat') }[k];
    return [k, Math.max(0, Math.round(targets[k] - eaten))];
  }));
  const foodList = items.length
    ? items.map(i => `${i.name} (${Math.round(i.grams || 0)} g, ${Math.round(i.kcal || 0)} kcal)`).join('; ')
    : 'noch nichts';
  const task = meals.length
    ? 'Schlage 1 bis 3 Mahlzeiten oder Snacks vor, die den offenen Bedarf sinnvoll decken und zum bereits Gegessenen passen. Wenn das Tagesziel schon überschritten ist, schlage nur leichte Optionen vor und sag das offen.'
    : 'Erstelle einen Essensplan für den ganzen Tag mit Frühstück, Mittagessen, Abendessen und einem Snack, der die Tagesziele möglichst genau trifft und zum Tagesablauf passt.';

  return `Du bist ein Ernährungsassistent für eine Privatperson. Du gibst keine medizinische Beratung; bei gesundheitlichen Fragen verweist du auf Ärztinnen und Ärzte. Alle Nährwerte sind Schätzungen.
${routine}
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

const SHOP_SCHEMA = { type: 'OBJECT', properties: { shoppingList: { type: 'ARRAY', items: { type: 'STRING' } } }, required: ['shoppingList'] };

function weekPrompt({ targets, prefs }, indexes) {
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

async function gemini(text, schema) {
  const body = {
    contents: [{ parts: [{ text }] }],
    generationConfig: { responseMimeType: 'application/json', responseSchema: schema }
  };
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GKEY },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(150000)
      });
    } catch (e) {
      // Zeitüberschreitung oder Verbindungsfehler: erneut versuchen
      if (attempt < 3) {
        console.log(`Versuch ${attempt} ist fehlgeschlagen (${e.message}), neuer Versuch …`);
        await new Promise(r => setTimeout(r, 5000 * attempt));
        continue;
      }
      throw e;
    }
    if ((res.status === 503 || res.status === 429) && attempt < 4) {
      await new Promise(r => setTimeout(r, 5000 * attempt));
      continue;
    }
    if (!res.ok) throw new Error(`Gemini HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    return JSON.parse(data.candidates[0].content.parts.map(p => p.text).join(''));
  }
}

const docUrl = () =>
  `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(PID)}/databases/(default)/documents/sync/${encodeURIComponent(CODE)}?key=${encodeURIComponent(FAPI)}`;

async function readPayload() {
  const res = await fetch(docUrl());
  if (res.status === 404) return {};
  if (!res.ok) throw new Error(`Firestore lesen: HTTP ${res.status}`);
  const doc = await res.json();
  return JSON.parse(doc.fields.data.stringValue);
}

async function writePayload(payload) {
  const res = await fetch(docUrl(), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fields: {
        updated: { integerValue: String(Date.now()) },
        data: { stringValue: JSON.stringify(payload) }
      }
    })
  });
  if (!res.ok) throw new Error(`Firestore schreiben: HTTP ${res.status}`);
}

async function main() {
  const now = new Date();
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', hour: '2-digit', hour12: false }).format(now));
  if (!FORCE && hour !== 6) {
    console.log(`In Berlin ist es ${hour} Uhr. Der Plan wird nur um 6 Uhr erstellt.`);
    return;
  }

  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' }).format(now);
  const todayUTC = new Date(today + 'T12:00:00Z');
  const wd = todayUTC.getUTCDay();
  const clock = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' }).format(now);
  const monday = new Date(todayUTC);
  monday.setUTCDate(todayUTC.getUTCDate() - ((wd + 6) % 7));
  const weekKey = monday.toISOString().slice(0, 10);

  const stored = await readPayload();
  const p = { week: null, meals: [], goals: {}, prefs: DEFAULT_PREFS, shopPersons: 2, advice: null, ...stored };

  const g = p.goals || {};
  const custom = Object.keys(DEFAULT_TARGETS).some(k => +g[k] > 0);
  const targets = Object.fromEntries(Object.entries(DEFAULT_TARGETS).map(([k, d]) => [k, +g[k] > 0 ? +g[k] : d]));
  const meals = (p.meals || []).filter(m => m.date === today);
  const prefs = p.prefs ?? DEFAULT_PREFS;
  const routine = `Heute ist ${WEEKDAYS[wd]}. Es ist jetzt ${clock} Uhr. Plane nur Zeiten, die noch nicht vorbei sind.\n${dayRoutine(wd)}`;

  // Der Tagesplan kommt nach dem Wochenplan, siehe unten

  // Wochenplan, wenn für diese Woche noch keiner existiert
  if (p.week?.weekKey !== weekKey || FORCE) {
    try {
      console.log('Erstelle Wochenplan in zwei Teilen …');
      const part = async (idx) => {
        const res = await gemini(weekPrompt({ targets, prefs }, idx), WEEK_SCHEMA);
        return idx.map((k, j) => ({ name: WEEK_ORDER[k], meals: res.days?.[j]?.meals || [] }));
      };
      const days = [...(await part([0, 1, 2, 3])), ...(await part([4, 5, 6]))];
      const lines = days.flatMap(d => d.meals.flatMap(m => [...(m.ingredients || []), ...(m.vegetarian?.ingredients || [])]));
      const shop = await gemini(`Erstelle aus diesen Zutaten einer Wochenplanung eine zusammengefasste Einkaufsliste für 1 Person. Gleiche Zutaten zusammenfassen, Mengen addieren, eine Zeile pro Eintrag mit Menge, z. B. "500 g Hähnchenbrust". Zutaten: ${lines.join('; ')}. Antworte als JSON nach dem Schema.`, SHOP_SCHEMA);
      p.week = { weekKey, days, shoppingList: shop.shoppingList || [] };
      await writePayload(p);
      console.log('Wochenplan gespeichert.');
    } catch (e) {
      console.error('Wochenplan fehlgeschlagen, der Tagesplan ist trotzdem gespeichert:', e.message);
    }
  }
  // Tagesplan: Gibt es für heute schon Gerichte im Wochenplan, werden genau die übernommen
  const dayWeek = p.week?.weekKey === weekKey ? p.week.days?.[(wd + 6) % 7] : null;
  const key = `v4|${today}|${meals.map(m => m.id).join(',')}|${prefs}|${JSON.stringify(targets)}`;
  if (!meals.length && dayWeek?.meals?.length) {
    p.advice = { key, data: { summary: 'Plan aus dem Wochenplan für heute.', meals: dayWeek.meals, shoppingList: [], tips: [] } };
    console.log('Tagesplan aus dem Wochenplan übernommen.');
  } else if (FORCE || p.advice?.key !== key) {
    console.log('Erstelle Tagesplan …');
    const data = await gemini(advicePrompt({ meals, targets, custom, prefs, routine }), ADVICE_SCHEMA);
    p.advice = { key, data };
  } else {
    console.log('Tagesplan ist schon aktuell.');
  }
  await writePayload(p);
  console.log('Tagesplan gespeichert.');
  console.log('Fertig.');
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
