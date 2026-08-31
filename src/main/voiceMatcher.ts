import { VoiceRule } from '../shared/types';

/** Synonimy i odmiany dla typowych intencji głosowych w języku polskim */
const RAW_SYNONYM_GROUPS: Record<string, string[]> = {
  mute_strict: ['wycisz', 'wyciszenie', 'wyciszaj', 'zmutuj', 'mutuj', 'mute', 'zcisz', 'wyciszony', 'wycisz mikrofon', 'zmutuj mikrofon', 'wyłącz mikrofon', 'wylacz mikrofon', 'wylacz mic', 'wycisz mic'],
  unmute_strict: ['odcisz', 'odciszenie', 'odciszaj', 'odmutuj', 'unmute', 'odciszony', 'odcisz mikrofon', 'odmutuj mikrofon', 'włącz mikrofon', 'wlacz mikrofon', 'wlacz mic', 'odcisz mic'],
  toggle_mute: ['przełącz wyciszenie', 'zmień wyciszenie', 'toggle mute', 'wycisz odcisz', 'przełącz mute', 'zmień mute'],
  switch_action: ['przełącz', 'przełączenie', 'przełączaj', 'zmień', 'zmiana', 'ustaw', 'daj', 'wybierz', 'przekieruj', 'włącz', 'wlacz', 'switch'],
  headset: ['słuchawki', 'słuchawek', 'słuchawkach', 'słuchawkowy', 'headset', 'mobilny', 'uszy', 'nauszny', 'bezprzewodowy', 'przełącz na słuchawki', 'włącz słuchawki'],
  desk: ['biurko', 'biurka', 'biurku', 'biurkowy', 'stacjonarny', 'stacjonarnym', 'główny', 'mikrofon główny', 'quadcast', 'hyperx', 'przełącz na biurko', 'włącz biurko'],
  auto: ['auto', 'automatyczny', 'radar', 'przywróć radar', 'włącz radar', 'radarowy', 'przełącz na auto', 'tryb auto', 'tryb automatyczny'],
  screen: ['ekran', 'ekrany', 'ekranu', 'monitor', 'monitory', 'wygaszacz', 'zgaś', 'czarny ekran', 'wygaszenie', 'wygas', 'zgaś ekrany', 'uśpij ekrany', 'wyłącz ekrany', 'wyłącz monitory', 'zgaś monitor'],
  snooze: ['drzemka', 'pauza', 'snooze', 'uśpij radar', 'wstrzymaj radar', 'wstrzymaj', 'pauza radaru', 'drzemka radaru'],
  lux: ['jasność', 'jasności', 'ile luksów', 'luks', 'luksy', 'światło', 'oświetlenie', 'ile światła']
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
  return text
    .toLowerCase()
    .replace(/[.,?!:;'"()\-—_]/g, ' ')
    .replace(/ą/g, 'a').replace(/ć/g, 'c').replace(/ę/g, 'e')
    .replace(/ł/g, 'l').replace(/ń/g, 'n').replace(/ó/g, 'o')
    .replace(/ś/g, 's').replace(/ż/g, 'z').replace(/ź/g, 'z')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Znormalizowane grupy synonimów — gwarancja braku rozbieżności ze znormalizowaną mową */
const SYNONYM_GROUPS: Record<string, string[]> = Object.fromEntries(
  Object.entries(RAW_SYNONYM_GROUPS).map(([k, arr]) => [k, arr.map((s) => normalizeText(s)).filter(Boolean)])
);

export interface MatchResult {
  rule: VoiceRule;
  confidence: number;
  matchedBy: 'exact' | 'contains' | 'token_overlap' | 'fuzzy' | 'intent_synonym';
}

/**
 * Inteligentne dopasowanie wypowiedzianej frazy do listy reguł
 */
export function findBestMatchingRule(spokenText: string, rules: VoiceRule[]): MatchResult | null {
  const normalizedSpoken = normalizeText(spokenText);
  if (!normalizedSpoken) return null;

  const spokenTokens = normalizedSpoken.split(' ').filter(Boolean);

  let bestMatch: MatchResult | null = null;
  let highestScore = 0;

  for (const rule of rules) {
    if (!rule.enabled || !rule.phrase) continue;

    const normalizedRule = normalizeText(rule.phrase);
    if (!normalizedRule) continue;

    const ruleTokens = normalizedRule.split(' ').filter(Boolean);

    // 1. Dokładne dopasowanie (100%)
    if (normalizedSpoken === normalizedRule) {
      return { rule, confidence: 1.0, matchedBy: 'exact' };
    }

    // 2. Zawieranie frazy w całości (95%)
    if (normalizedSpoken.includes(normalizedRule)) {
      const score = 0.95;
      if (score > highestScore) {
        highestScore = score;
        bestMatch = { rule, confidence: score, matchedBy: 'contains' };
      }
      continue;
    }

    if (normalizedRule.includes(normalizedSpoken) && normalizedSpoken.length >= 4) {
      const score = 0.90;
      if (score > highestScore) {
        highestScore = score;
        bestMatch = { rule, confidence: score, matchedBy: 'contains' };
      }
      continue;
    }

    // 3. Pokrycie słów kluczowych (Token overlap / Jaccard)
    const matchingTokens = ruleTokens.filter((token) => spokenTokens.includes(token));
    const tokenRatio = matchingTokens.length / ruleTokens.length;
    if (tokenRatio >= 0.75 && ruleTokens.length >= 2) {
      const score = 0.85 + (tokenRatio * 0.1);
      if (score > highestScore) {
        highestScore = score;
        bestMatch = { rule, confidence: Math.min(0.95, score), matchedBy: 'token_overlap' };
      }
      continue;
    }

    // 4. Dopasowanie przez synonimy intencji wg typu akcji (actionType)
    let intentScore = 0;
    const hasSwitchVerb = SYNONYM_GROUPS.switch_action.some((s) => spokenTokens.includes(s));

    if (rule.actionType === 'mute') {
      const hasMute = SYNONYM_GROUPS.mute_strict.some((s) => spokenTokens.includes(s) || normalizedSpoken.includes(s));
      if (hasMute) intentScore = 0.94;
    } else if (rule.actionType === 'unmute') {
      const hasUnmute = SYNONYM_GROUPS.unmute_strict.some((s) => spokenTokens.includes(s) || normalizedSpoken.includes(s));
      if (hasUnmute) intentScore = 0.94;
    } else if (rule.actionType === 'toggle_mute') {
      const hasToggle = SYNONYM_GROUPS.toggle_mute.some((s) => normalizedSpoken.includes(s));
      if (hasToggle) intentScore = 0.94;
    } else if (rule.actionType === 'switch_headset') {
      const hasHeadset = SYNONYM_GROUPS.headset.some((s) => spokenTokens.includes(s) || normalizedSpoken.includes(s));
      if (hasHeadset) {
        intentScore = hasSwitchVerb ? 0.96 : 0.93;
      }
    } else if (rule.actionType === 'switch_desk') {
      const hasDesk = SYNONYM_GROUPS.desk.some((s) => spokenTokens.includes(s) || normalizedSpoken.includes(s));
      if (hasDesk) {
        intentScore = hasSwitchVerb ? 0.96 : 0.93;
      }
    } else if (rule.actionType === 'switch_auto') {
      const hasAuto = SYNONYM_GROUPS.auto.some((s) => spokenTokens.includes(s) || normalizedSpoken.includes(s));
      if (hasAuto) {
        intentScore = hasSwitchVerb ? 0.96 : 0.93;
      }
    } else if (rule.actionType === 'screensaver' || rule.actionType === 'sleep_display') {
      const hasScreen = SYNONYM_GROUPS.screen.some((s) => spokenTokens.includes(s) || normalizedSpoken.includes(s));
      if (hasScreen) intentScore = 0.94;
    } else if (rule.actionType === 'snooze') {
      const hasSnooze = SYNONYM_GROUPS.snooze.some((s) => spokenTokens.includes(s) || normalizedSpoken.includes(s));
      if (hasSnooze) intentScore = 0.94;
    }

    if (intentScore > highestScore && intentScore >= 0.90) {
      highestScore = intentScore;
      bestMatch = { rule, confidence: intentScore, matchedBy: 'intent_synonym' };
      continue;
    }

    // 5. Podobieństwo rozmyte (Levenshtein)
    const sim = stringSimilarity(normalizedSpoken, normalizedRule);
    if (sim >= 0.78 && sim > highestScore) {
      highestScore = sim;
      bestMatch = { rule, confidence: Math.round(sim * 100) / 100, matchedBy: 'fuzzy' };
    }
  }

  return bestMatch;
}
