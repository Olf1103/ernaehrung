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
- Jede Mahlzeit bekommt zusätzlich eine vegetarische Alternative (vegetarian) mit eigenem Rezept und Nährwerten. Ist die Hauptmahlzeit schon vegetarisch, gib eine andere vegetarische Variante an.`;

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
    ?
