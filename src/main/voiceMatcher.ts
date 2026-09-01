import { VoiceRule } from '../shared/types';

/** Synonimy i odmiany dla typowych intencji głosowych w języku polskim — rozbudowane o potoczne i niewyraźne formy */
const RAW_SYNONYM_GROUPS: Record<string, string[]> = {
  mute_strict: [
    'wycisz', 'wyciszenie', 'wyciszaj', 'zmutuj', 'mutuj', 'mute', 'zcisz', 'scisz', 'wyciszony', 'wyciszone',
    'wycisz mikrofon', 'zmutuj mikrofon', 'wyłącz mikrofon', 'wylacz mikrofon', 'wylacz mic', 'wycisz mic',
    'zamknij mikrofon', 'zcisz mic', 'scisz mic', 'zcisz mikrofon', 'scisz mikrofon', 'zciszenie', 'cisza',
    'wycisz mik', 'zmutuj mik', 'wyłącz mic', 'odłącz mikrofon', 'odlacz mikrofon', 'zablokuj mikrofon',
    'wycisz dźwięk', 'wycisz dzwiek', 'mute mic', 'bez głosu', 'bez glosu'
  ],
  unmute_strict: [
    'odcisz', 'odciszenie', 'odciszaj', 'odmutuj', 'unmute', 'odciszony', 'odciszone',
    'odcisz mikrofon', 'odmutuj mikrofon', 'włącz mikrofon', 'wlacz mikrofon', 'wlacz mic', 'odcisz mic',
    'otwórz mikrofon', 'otworz mikrofon', 'wlacz mik', 'włącz mik', 'odcisz mik', 'odmutuj mik',
    'odblokuj mikrofon', 'przywróć mikrofon', 'przywroc mikrofon', 'aktywuj mikrofon', 'włącz dźwięk', 'wlacz dzwiek'
  ],
  toggle_mute: [
    'przełącz wyciszenie', 'zmień wyciszenie', 'toggle mute', 'wycisz odcisz', 'przełącz mute', 'zmień mute',
    'przelacz wyciszenie', 'zmien mute', 'toggle', 'odwróć wyciszenie', 'odwroc wyciszenie', 'toggle mikrofon',
    'przełącz stan mikrofonu', 'przelacz stan mikrofonu'
  ],
  switch_action: [
    'przełącz', 'przelacz', 'przełączenie', 'przełączaj', 'zmień', 'zmien', 'zmiana', 'ustaw', 'daj',
    'wybierz', 'przekieruj', 'włącz', 'wlacz', 'switch', 'zmień na', 'zmien na', 'przełącz na', 'przelacz na',
    'ustaw na', 'daj na', 'przekaż na', 'przekaz na'
  ],
  headset: [
    'słuchawki', 'sluchawki', 'słuchawek', 'sluchawek', 'słuchawkach', 'sluchawkach', 'słuchawkowy', 'sluchawkowy',
    'headset', 'hedset', 'mobilny', 'mobilka', 'uszy', 'nauszny', 'bezprzewodowy', 'przełącz na słuchawki',
    'włącz słuchawki', 'sluchawce', 'sluchawkom', 'na słuchawki', 'na sluchawki', 'do słuchawek', 'do sluchawek',
    'w słuchawkach', 'w sluchawkach', 'słuchawka', 'sluchawka', 'pchełki', 'pchelki', 'airpods'
  ],
  desk: [
    'biurko', 'biurka', 'biurku', 'biurkowy', 'biuro', 'stacjonarny', 'stacjonarnym', 'stacjonarka',
    'główny', 'mikrofon główny', 'quadcast', 'hyperx', 'przełącz na biurko', 'włącz biurko', 'biurkowe',
    'na biurko', 'do biurka', 'na biurku', 'mikrofon biurkowy', 'mikrofon stacjonarny', 'mikrofon biurka'
  ],
  auto: [
    'auto', 'automatyczny', 'automatyka', 'radar', 'przywróć radar', 'włącz radar', 'radarowy',
    'przełącz na auto', 'tryb auto', 'tryb automatyczny', 'przywróć automat', 'przywroc automat',
    'włącz automat', 'wlacz automat', 'radar stacjonarny', 'tryb radaru'
  ],
  screen: [
    'ekran', 'ekrany', 'ekranu', 'ekranie', 'monitor', 'monitory', 'wygaszacz', 'wygaszacze',
    'zgaś', 'zgas', 'czarny ekran', 'wygaszenie', 'wygaś', 'zgaś ekrany', 'uśpij ekrany', 'wyłącz ekrany',
    'wyłącz monitory', 'zgaś monitor', 'wygas ekrany', 'wygaś monitory', 'wygas monitory', 'zgaś monitory',
    'zgas monitory', 'czarny monitor', 'czarne ekrany', 'uśpij monitor', 'uspij monitor'
  ],
  snooze: [
    'drzemka', 'drzemke', 'pauza', 'pauze', 'pauzuj', 'snooze', 'snuz', 'uśpij radar',
    'wstrzymaj radar', 'wstrzymaj', 'pauza radaru', 'drzemka radaru', 'chwila przerwy', 'stop radar',
    'spauzuj radar', 'zrób przerwę', 'zrob przerwe', 'uśpij na chwilę', 'uspij na chwile'
  ],
  open_app: [
    'otwórz', 'otworz', 'pokaż', 'pokaz', 'otwórz okno', 'otworz okno', 'pokaż okno', 'pokaz okno',
    'otwórz aplikację', 'otworz aplikacje', 'pokaż aplikację', 'pokaz aplikacje', 'otwórz apkę', 'otworz apke',
    'pokaż apkę', 'pokaz apke', 'otwórz tutaj', 'otworz tutaj', 'pokaż tutaj', 'pokaz tutaj', 'open',
    'otwórz desksense', 'otworz desksense', 'pokaż desksense', 'pokaz desksense'
  ],
  show_commands: [
    'pokaż listę komend', 'pokaz liste komend', 'pokaż komendy', 'pokaz komendy',
    'lista komend', 'jakie są komendy', 'jakie sa komendy', 'co potrafisz',
    'pomoc', 'komendy', 'pokaż co potrafisz', 'pokaz co potrafisz',
    'otwórz listę komend', 'otworz liste komend', 'pomoc głosowa', 'spis komend',
    'jakie są polecenia', 'jakie sa polecenia', 'spis poleceń', 'spis polecen', 'pokaż opcje', 'pokaz opcje'
  ],
  light_on: [
    'zapal światło', 'włącz światło', 'zapal swiatlo', 'wlacz swiatlo', 'zaświeć światło', 'zaswiec swiatlo',
    'światło włącz', 'swiatlo wlacz', 'światło', 'swiatlo', 'światła', 'swiatla', 'zapal lampę', 'wlacz lampe',
    'włącz lampę', 'jasno', 'zapal', 'zaświeć'
  ],
  light_off: [
    'zgaś światło', 'wyłącz światło', 'zgas swiatlo', 'wylacz swiatlo', 'zgaś lampę', 'wylacz lampe',
    'zgaś lampy', 'wylacz lampy', 'ciemno', 'zgaś', 'zgas', 'wyłącz lampę', 'wyłącz światła', 'wylacz swiatla',
    'zgaś światła', 'zgas swiatla', 'wygaś światło', 'wygas swiatlo'
  ]
};

/** Oblicza odległość Levenshteina między dwoma ciągami znaków */
export function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  const d: number[][] = [];
  for (let i = 0; i <= m; i++) d[i] = [i];
  for (let j = 0; j <= n; j++) d[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(
        d[i - 1][j] + 1, // usunięcie
        d[i][j - 1] + 1, // wstawienie
        d[i - 1][j - 1] + cost // zamiana
      );
    }
  }

  return d[m][n];
}

/** Oblicza procent podobieństwa (0.0 .. 1.0) */
export function stringSimilarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1.0;
  const dist = levenshteinDistance(a, b);
  return Math.max(0, (maxLen - dist) / maxLen);
}

/** Czyści i normalizuje tekst do porównań (usuwa interpunkcję i diakrytyki) */
export function normalizeText(text: string): string {
  return (text || '')
    .toLowerCase()
    .replace(/[.,?!:;'"()\-—_…„”«»/\\#@*~`\[\]{}]/g, ' ')
    .replace(/ą/g, 'a').replace(/ć/g, 'c').replace(/ę/g, 'e')
    .replace(/ł/g, 'l').replace(/ń/g, 'n').replace(/ó/g, 'o')
    .replace(/ś/g, 's').replace(/ż/g, 'z').replace(/ź/g, 'z')
    .replace(/\s+/g, ' ')
    .trim();
}

export const CONFIRMATION_SYNONYMS = [
  'tak', 'no', 'dokladnie', 'jasne', 'zgadza sie', 'dobrze', 'pewnie',
  'potwierdzam', 'yep', 'yes', 'dawaj', 'wykonaj', 'tak jest', 'oczywiscie',
  'dokladnie tak', 'wlasnie tak', 'tak poprosze', 'prosilbym', 'jasna sprawa'
];

export const REJECTION_SYNONYMS = [
  'nie', 'nie nie', 'anuluj', 'zostaw', 'blad', 'pomylka', 'odrzuc', 'stop',
  'nie dzieki', 'wcale nie', 'nie o to', 'nie to', 'zrezygnuj'
];

/** Usuwa przedrostki korygujące typu "chodziło mi o", "miałem na myśli" */
export function stripCorrectionPrefix(text: string): string {
  const norm = normalizeText(text);
  return norm
    .replace(/^(nie\s+)?(chodzilo mi o|chodzilo o|mialem na mysli|mialam na mysli|mialo byc|chcialem|chcialam)\s+/i, '')
    .trim();
}

/**
 * Sprowadza tekst do postaci fonetycznej języka polskiego — niweluje typowe różnice
 * fonetyczne w szybkiej i niewyraźnej mowie:
 * - rz, ż, ź, zi -> z
 * - ch -> h
 * - ó -> u
 * - ę -> e, ą -> o
 * - cz, dż, ć, ci -> c
 * - sz, ś, si -> s
 * - dz, dź, dzi -> z
 * - ubezdźwięcznienia w wygłosie (koniec słowa: w->f, b->p, d->t, g->k, z->s)
 * - ubezdźwięcznienia wsteczne przed spółgłoskami bezdźwięcznymi (odcisz -> otcisz, wstrzymaj -> fstrymaj)
 *
 * Uwaga: NIE ubezdźwięcznia nagłosów przed samogłoskami (np. "biurko" pozostaje z "b", nie staje się "piurko").
 */
export function toPolishPhonetic(text: string): string {
  const s = normalizeText(text);
  if (!s) return '';
  return s
    .replace(/rz/g, 'z')
    .replace(/ch/g, 'h')
    .replace(/ó/g, 'u')
    .replace(/ę/g, 'e')
    .replace(/ą/g, 'o')
    .replace(/dzi/g, 'z')
    .replace(/dź/g, 'z')
    .replace(/dż/g, 'z')
    .replace(/dz/g, 'z')
    .replace(/cz/g, 'c')
    .replace(/sz/g, 's')
    .replace(/ci/g, 'c')
    .replace(/ć/g, 'c')
    .replace(/si/g, 's')
    .replace(/ś/g, 's')
    .replace(/zi/g, 'z')
    .replace(/ź/g, 'z')
    .replace(/ni/g, 'n')
    .replace(/ń/g, 'n')
    // Ubezdźwięcznienia wsteczne przed spółgłoskami bezdźwięcznymi (p, t, k, f, s, c, h)
    .replace(/w(?=[ptkschfc])/g, 'f')
    .replace(/b(?=[ptkschfc])/g, 'p')
    .replace(/d(?=[ptkschfc])/g, 't')
    .replace(/g(?=[ptkschfc])/g, 'k')
    .replace(/z(?=[ptkschfc])/g, 's')
    // Ubezdźwięcznienia w wygłosie (na końcu słowa: w, b, d, g, z -> f, p, t, k, s)
    .replace(/w\b/g, 'f')
    .replace(/b\b/g, 'p')
    .replace(/d\b/g, 't')
    .replace(/g\b/g, 'k')
    .replace(/z\b/g, 's')
    // Uproszczenia złożeń
    .replace(/wł/g, 'wl')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Znormalizowane grupy synonimów — gwarancja braku rozbieżności ze znormalizowaną mową */
const SYNONYM_GROUPS: Record<string, string[]> = Object.fromEntries(
  Object.entries(RAW_SYNONYM_GROUPS).map(([k, arr]) => [k, arr.map((s) => normalizeText(s)).filter(Boolean)])
);

/**
 * Buduje słownik komend (słowo wywołania + frazy reguł użytkownika + synonimy intencji),
 * który zasila dekoder jako bias słownictwa:
 * - Whisper: initial_prompt — dekoder preferuje te frazy (mniej halucynacji i pomyłek),
 * - Vosk: gramatyka JSON (vosk_recognizer_new_grm) — dekodowanie ograniczone do zadanego słownictwa.
 *
 * Każda fraza zapisywana jest w DWÓCH formach: z zachowaniem polskich znaków (wymaga tego
 * leksykon modeli PL — vosk/whisper wypisują poprawną ortografię) oraz znormalizowanej ASCII
 * (fallback dla modeli/modele wypisujące tekst bez diakrytyków).
 */
/**
 * Generuje warianty słowa wywołania (Wake Word) dopasowane do intencji użytkownika.
 * Jeśli użytkownik ustawił własne słowo (np. "jarvis", "komputer", "alexa"), rozpoznawane
 * jest TYLKO to słowo i jego fonetyczne prefiksy ("hej jarvis", "ok jarvis").
 */
export function getWakeWordVariations(wakeWord: string): string[] {
  const clean = normalizeText(wakeWord || 'ok').trim();
  const list = new Set<string>();

  // 1. Zawsze dodajemy dokładnie to słowo/frazę, którą ustawił użytkownik
  if (clean) {
    list.add(clean);
    const phonetic = toPolishPhonetic(clean);
    if (phonetic && phonetic !== clean) list.add(phonetic);
  }

  // 2. Jeśli użytkownik ma ustawione domyślne "ok", "okej", dodajemy naturalne polskie warianty
  const isDefault = !clean || ['ok', 'okej', 'hej', 'halo'].includes(clean);
  if (isDefault) {
    list.add('ok');
    list.add('okej');
    list.add('hej');
    list.add('halo');
    list.add('ok biurko');
    list.add('hej biurko');
  } else {
    // Własne słowo użytkownika (np. "jarvis", "komputer")
    list.add(`hej ${clean}`);
    list.add(`halo ${clean}`);
    list.add(`ok ${clean}`);
    list.add(`okej ${clean}`);
  }

  return Array.from(list);
}

/**
 * Buduje zoptymalizowany kontekst początkowy (initial_prompt) dla dekodera OpenAI Whisper.
 *
 * Zgodnie z wytycznymi OpenAI & whisper.cpp dla parametrów prompt biasing:
 * 1. Whisper traktuje initial_prompt jako "dotychczasowy zapis rozmowy", a NIE zestaw komend czy suchą listę słów.
 * 2. Zwykła lista słów po przecinku ("keyword stuffing") rozbija model językowy i przekracza limit tokenów.
 * 3. Limit wynosi ściśle 224 tokeny (~650-750 znaków). Jeśli prompt przekroczy limit, Whisper bez ostrzeżenia
 *    odcina początek promptu (zostawiając tylko końcowe 224 tokeny).
 * 4. Prawidłowa struktura: naturalne polskie zdania z pełnymi diakrytykami i trybem rozkazującym, wzbogacone
 *    o specyficzne frazy aktywnych reguł użytkownika.
 */
export function buildWhisperInitialPrompt(rules: VoiceRule[], wakeWord: string): string {
  // Bazowy szkielet konwersacyjny ustalający styl polskich komend
  const baseSentences = [
    'Okej, przełącz mikrofon na słuchawki bezprzewodowe.',
    'Wycisz mikrofon biurkowy, odcisz dźwięk.',
    'Włącz tryb automatyczny i przywróć działanie radaru.',
    'Otwórz okno aplikacji, zgaś ekrany.'
  ];

  // Własne słowo wywołania użytkownika, jeśli nietypowe (np. "jarvis", "komputer")
  const customPhrases: string[] = [];
  const cleanWake = normalizeText(wakeWord || 'ok').trim();
  if (cleanWake && !['ok', 'okej', 'hej', 'halo'].includes(cleanWake)) {
    const capitalizedWake = cleanWake.charAt(0).toUpperCase() + cleanWake.slice(1);
    customPhrases.push(`Hej ${capitalizedWake}, włącz nasłuch.`);
  }

  // Własne frazy ze zdefiniowanych reguł użytkownika
  for (const rule of rules) {
    if (!rule.enabled || !rule.phrase) continue;
    const phrase = rule.phrase.trim();
    if (!phrase) continue;
    const sentence = phrase.charAt(0).toUpperCase() + phrase.slice(1) + '.';
    if (!baseSentences.some((s) => s.toLowerCase().includes(phrase.toLowerCase())) && !customPhrases.includes(sentence)) {
      customPhrases.push(sentence);
    }
  }

  // Łączymy bazę ze specyficznymi regułami użytkownika, dbając o limit ~650 znaków (~160-180 tokenów)
  const fullPromptParts = [...baseSentences];
  for (const cp of customPhrases) {
    const candidate = `${fullPromptParts.join(' ')} ${cp}`;
    if (candidate.length > 680) break; // Bezpieczny margines pod 224 tokeny BPE
    fullPromptParts.push(cp);
  }

  return fullPromptParts.join(' ');
}

export function buildVoiceVocabulary(rules: VoiceRule[], wakeWord: string): string[] {
  const items = new Set<string>();

  // Małe litery + czysta interpunkcja, ale ZACHOWANE polskie znaki
  const addLoose = (s: string): void => {
    const loose = (s || '')
      .toLowerCase()
      .replace(/[.,?!:;'"()\-—_…„”«»/\\#@*~`\[\]{}]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (loose && loose.length >= 2) {
      items.add(loose);
      const ascii = normalizeText(s);
      if (ascii && ascii !== loose) items.add(ascii);
    }
  };

  // Warianty słowa wywołania z getWakeWordVariations
  const wakeVariants = getWakeWordVariations(wakeWord);
  for (const w of wakeVariants) addLoose(w);

  // Frazy zdefiniowanych i aktywnych reguł użytkownika
  for (const rule of rules) {
    if (!rule.enabled) continue;
    addLoose(rule.phrase);
  }

  // Synonimy intencji — pokrywają słownictwo dopasowań fonetycznych/fuzzy matchera
  for (const group of Object.values(RAW_SYNONYM_GROUPS)) {
    for (const s of group) addLoose(s);
  }

  return Array.from(items).sort();
}

export interface MatchResult {
  rule: VoiceRule;
  confidence: number;
  matchedBy: 'exact' | 'contains' | 'token_overlap' | 'fuzzy' | 'intent_synonym';
}

/**
 * Inteligentne dopasowanie wypowiedzianej frazy do listy reguł z wielowarstwową analizą fonetyczną
 */
export function findBestMatchingRule(spokenText: string, rules: VoiceRule[]): MatchResult | null {
  const normalizedSpoken = normalizeText(spokenText);
  if (!normalizedSpoken) return null;

  const phoneticSpoken = toPolishPhonetic(normalizedSpoken);
  const spokenTokens = normalizedSpoken.split(' ').filter(Boolean);

  let bestMatch: MatchResult | null = null;
  let highestScore = 0;

  for (const rule of rules) {
    if (!rule.enabled || !rule.phrase) continue;

    const normalizedRule = normalizeText(rule.phrase);
    if (!normalizedRule) continue;

    const phoneticRule = toPolishPhonetic(normalizedRule);
    const ruleTokens = normalizedRule.split(' ').filter(Boolean);

    // 1. Dokładne dopasowanie leksykalne (100%)
    if (normalizedSpoken === normalizedRule) {
      return { rule, confidence: 1.0, matchedBy: 'exact' };
    }

    // 2. Dokładne dopasowanie fonetyczne (98%)
    if (phoneticSpoken === phoneticRule) {
      const score = 0.98;
      if (score > highestScore) {
        highestScore = score;
        bestMatch = { rule, confidence: score, matchedBy: 'exact' };
      }
      continue;
    }

    // 3. Zawieranie frazy w obu kierunkach (np. "proszę przełącz na słuchawki" -> 95%, lub mówiąc "światło" -> 92% dla reguły "Zapal Światło")
    const escapedRule = normalizedRule.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const escapedPhonetic = phoneticRule.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const ruleRx = new RegExp(`(^|\\s)${escapedRule}(\\s|$)`);
    const phoneticRx = new RegExp(`(^|\\s)${escapedPhonetic}(\\s|$)`);

    if (ruleRx.test(normalizedSpoken) || phoneticRx.test(phoneticSpoken)) {
      const score = 0.95;
      if (score > highestScore) {
        highestScore = score;
        bestMatch = { rule, confidence: score, matchedBy: 'contains' };
      }
      continue;
    }

    // Reguła zawiera wypowiedziane słowo kluczowe (np. wypowiedź "światło" lub "słuchawki")
    if (normalizedSpoken.length >= 4) {
      const isSubstring = normalizedRule.includes(normalizedSpoken) || phoneticRule.includes(phoneticSpoken);
      if (isSubstring) {
        const score = normalizedSpoken.length >= 6 ? 0.92 : 0.88;
        if (score > highestScore) {
          highestScore = score;
          bestMatch = { rule, confidence: score, matchedBy: 'contains' };
        }
      }
    }

    // 4. Pokrycie słów kluczowych (dla reguł wielowyrazowych, min 2 słowa)
    if (ruleTokens.length >= 2) {
      const matchingTokens = ruleTokens.filter((rToken) => {
        const pRToken = toPolishPhonetic(rToken);
        return spokenTokens.some((sToken) => {
          const pSToken = toPolishPhonetic(sToken);
          return (
            sToken === rToken ||
            pSToken === pRToken ||
            stringSimilarity(rToken, sToken) >= 0.82 ||
            stringSimilarity(pRToken, pSToken) >= 0.82
          );
        });
      });

      const tokenRatio = matchingTokens.length / ruleTokens.length;
      if (tokenRatio >= 0.50) {
        const score = 0.80 + tokenRatio * 0.15;
        if (score > highestScore) {
          highestScore = score;
          bestMatch = { rule, confidence: Math.min(0.95, score), matchedBy: 'token_overlap' };
        }
      }
    }

    // 5. Dopasowanie przez synonimy intencji wg typu akcji i słów kluczowych
    let intentScore = 0;
    const hasSwitchVerb = SYNONYM_GROUPS.switch_action.some((s) => {
      const pS = toPolishPhonetic(s);
      return spokenTokens.includes(s) || spokenTokens.some((t) => stringSimilarity(t, s) >= 0.72 || stringSimilarity(toPolishPhonetic(t), pS) >= 0.72);
    });

    const matchesSynonymGroup = (group: string[]): boolean =>
      group.some((s) => {
        const pS = toPolishPhonetic(s);
        const sEsc = s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pSEsc = pS.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const sRx = new RegExp(`(^|\\s)${sEsc}(\\s|$)`);
        const pSRx = new RegExp(`(^|\\s)${pSEsc}(\\s|$)`);

        return (
          sRx.test(normalizedSpoken) ||
          pSRx.test(phoneticSpoken) ||
          spokenTokens.includes(s) ||
          spokenTokens.some((t) => stringSimilarity(t, s) >= 0.82 || stringSimilarity(toPolishPhonetic(t), pS) >= 0.82)
        );
      });

    if (rule.actionType === 'mute') {
      if (matchesSynonymGroup(SYNONYM_GROUPS.mute_strict)) intentScore = 0.94;
    } else if (rule.actionType === 'unmute') {
      if (matchesSynonymGroup(SYNONYM_GROUPS.unmute_strict)) intentScore = 0.94;
    } else if (rule.actionType === 'toggle_mute') {
      if (matchesSynonymGroup(SYNONYM_GROUPS.toggle_mute)) intentScore = 0.94;
    } else if (rule.actionType === 'switch_headset') {
      if (matchesSynonymGroup(SYNONYM_GROUPS.headset)) {
        intentScore = hasSwitchVerb ? 0.96 : 0.93;
      }
    } else if (rule.actionType === 'switch_desk') {
      if (matchesSynonymGroup(SYNONYM_GROUPS.desk)) {
        intentScore = hasSwitchVerb ? 0.96 : 0.93;
      }
    } else if (rule.actionType === 'switch_auto') {
      if (matchesSynonymGroup(SYNONYM_GROUPS.auto)) {
        intentScore = hasSwitchVerb ? 0.96 : 0.93;
      }
    } else if (rule.actionType === 'screensaver' || rule.actionType === 'sleep_display') {
      if (matchesSynonymGroup(SYNONYM_GROUPS.screen)) intentScore = 0.94;
    } else if (rule.actionType === 'snooze') {
      if (matchesSynonymGroup(SYNONYM_GROUPS.snooze)) intentScore = 0.94;
    } else if (rule.actionType === 'open_app') {
      if (matchesSynonymGroup(SYNONYM_GROUPS.open_app)) intentScore = 0.96;
    } else if (rule.actionType === 'show_commands') {
      if (matchesSynonymGroup(SYNONYM_GROUPS.show_commands)) intentScore = 0.96;
    }

    // Inteligentne synonimy dla oświetlenia (Home Assistant / custom rules)
    const ruleCombined = `${normalizedRule} ${normalizeText(rule.name)}`;
    if (ruleCombined.includes('swiatl') || ruleCombined.includes('lamp') || ruleCombined.includes('light')) {
      if (ruleCombined.includes('zapal') || ruleCombined.includes('wlacz') || ruleCombined.includes('on')) {
        if (matchesSynonymGroup(SYNONYM_GROUPS.light_on)) intentScore = Math.max(intentScore, 0.95);
      }
      if (ruleCombined.includes('zgas') || ruleCombined.includes('wylacz') || ruleCombined.includes('off')) {
        if (matchesSynonymGroup(SYNONYM_GROUPS.light_off)) intentScore = Math.max(intentScore, 0.95);
      }
    }

    if (intentScore > highestScore && intentScore >= 0.88) {
      highestScore = intentScore;
      bestMatch = { rule, confidence: intentScore, matchedBy: 'intent_synonym' };
      continue;
    }

    // 6. Podobieństwo rozmyte (Levenshtein leksykalny i fonetyczny — próg adaptacyjny 0.58 - 0.70)
    const simLex = stringSimilarity(normalizedSpoken, normalizedRule);
    const simPhonetic = stringSimilarity(phoneticSpoken, phoneticRule);
    const maxSim = Math.max(simLex, simPhonetic);
    const minThreshold = normalizedRule.length <= 6 ? 0.70 : 0.58;

    if (maxSim >= minThreshold && maxSim > highestScore) {
      highestScore = maxSim;
      bestMatch = { rule, confidence: Math.round(maxSim * 100) / 100, matchedBy: 'fuzzy' };
    }
  }

  return bestMatch;
}
