/**
 * Rejestr i definicje profili sensorów mmWave w DeskSense.
 * Pozwala na łatwe podłączanie i obsługę nowych sensorów radarowych w przyszłości
 * z osobnymi konfiguracjami, zestawem obsługiwanych funkcji (features) i szablonami YAML.
 */

export type SensorFeature =
  | 'presence'        // Podstawowa detekcja obecności człowieka
  | 'distance'        // Pomiar odległości w cm
  | 'moving_target'   // Śledzenie celu ruchomego (ruch / moving distance)
  | 'still_target'    // Śledzenie celu statycznego (bezruch / still distance)
  | 'heart_rate'      // Pomiar tętna (BPM)
  | 'breath_rate'     // Pomiar oddechu (RPM)
  | 'illuminance'     // Czujnik natężenia oświetlenia (BH1750 / lux)
  | 'ws2812_rgb'      // Programowalna dioda WS2812 RGB na sensorze
  | 'status_led'      // Wbudowana dioda LED na mikrokontrolerze
  | 'motion_gates';   // Bramkowanie odległości i czułości strefowej

export interface SensorProfile {
  id: string;
  name: string;
  shortName: string;
  frequency: '24GHz' | '60GHz' | 'other';
  baudRate: number;
  yamlTemplate: string;
  features: SensorFeature[];
  defaultTimeoutAwayMs: number;
  defaultTimeoutDeskMs: number;
  description: string;
}

export const SENSOR_PROFILES: Record<string, SensorProfile> = {
  seeed_24ghz_xiao: {
    id: 'seeed_24ghz_xiao',
    name: 'Seeed Studio 24GHz for XIAO (101010001)',
    shortName: 'Seeed 24GHz (101010001)',
    frequency: '24GHz',
    baudRate: 256000,
    yamlTemplate: 'seeedstudio-24ghz-xiao.yaml',
    features: ['presence', 'distance', 'moving_target', 'still_target', 'status_led', 'motion_gates'],
    defaultTimeoutAwayMs: 500,
    defaultTimeoutDeskMs: 50,
    description: 'Błyskawiczny radar 24GHz ze strefami obecności ruchomej i statycznej pod biurko.'
  },
  seeed_mr60bha2_60ghz: {
    id: 'seeed_mr60bha2_60ghz',
    name: 'Seeed Studio MR60BHA2 Kit (60GHz)',
    shortName: 'Seeed MR60BHA2 (60GHz)',
    frequency: '60GHz',
    baudRate: 115200,
    yamlTemplate: 'seeedstudio-mr60bha2-60ghz.yaml',
    features: ['presence', 'distance', 'heart_rate', 'breath_rate', 'illuminance', 'ws2812_rgb'],
    defaultTimeoutAwayMs: 800,
    defaultTimeoutDeskMs: 50,
    description: 'Medyczny radar 60GHz ze śledzeniem oddechu, tętna, czujnikiem światła BH1750 i diodą WS2812.'
  },
  generic_uart: {
    id: 'generic_uart',
    name: 'Uniwersalny Sensor UART mmWave',
    shortName: 'Radar UART',
    frequency: 'other',
    baudRate: 115200,
    yamlTemplate: 'seeedstudio-mr60bha2-60ghz.yaml',
    features: ['presence', 'distance'],
    defaultTimeoutAwayMs: 800,
    defaultTimeoutDeskMs: 50,
    description: 'Uniwersalny profil dla dowolnego czujnika przesyłającego tekstowe stany obecności i odległości.'
  }
};

/**
 * Zwraca profil sensora po ID lub nazwie modelu; fallback do profili 24GHz/60GHz/generic.
 */
export function getSensorProfile(modelOrId?: string): SensorProfile {
  if (!modelOrId) return SENSOR_PROFILES.seeed_mr60bha2_60ghz;
  const key = modelOrId.toLowerCase();

  if (SENSOR_PROFILES[key]) {
    return SENSOR_PROFILES[key];
  }

  if (key.includes('24g') || key.includes('101010001') || key.includes('ld2410') || key.includes('mr24')) {
    return SENSOR_PROFILES.seeed_24ghz_xiao;
  }

  if (key.includes('60g') || key.includes('60') || key.includes('mr60') || key.includes('bha2')) {
    return SENSOR_PROFILES.seeed_mr60bha2_60ghz;
  }

  return SENSOR_PROFILES.generic_uart;
}

/**
 * Sprawdza czy dany profil sensora obsługuje konkretną funkcjonalność.
 */
export function hasSensorFeature(profile: SensorProfile | undefined, feature: SensorFeature): boolean {
  if (!profile || !Array.isArray(profile.features)) return false;
  return profile.features.includes(feature);
}
