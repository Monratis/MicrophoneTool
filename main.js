'use strict';

const { app, Menu, Tray, nativeImage } = require('electron');
const path = require('path');

const Config = require('./src/config');
const RadarListener = require('./src/radarListener');
const AudioController = require('./src/audioController');
const AppController = require('./src/appController');

let tray = null;
let controller = null;
let lastRadarStatus = null;

const STATE_LABEL = {
  desk: 'Przy biurku',
  away: 'Poza biurkiem'
};

function buildIcon(state) {
  // Prosta ikona SVG jako PNG (24x24), kolor wg stanu.
  const color = state === 'desk' ? '#2e7d32' : '#757575';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24">
    <rect width="24" height="24" rx="5" fill="${color}"/>
    <circle cx="12" cy="10" r="5" fill="white"/>
    <rect x="5" y="17" width="14" height="3" rx="1.5" fill="white"/>
  </svg>`;
  const img = nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
  img.setTemplateImage(false);
  return img;
}

function refreshMenu() {
  const state = controller.currentDevice;
  const stateText = state ? STATE_LABEL[state] : '---';

  const template = [
    { label: `Stan: ${stateText}`, enabled: false },
    { type: 'separator' },
    {
      label: 'Tryb automatyczny (radar)',
      type: 'radio',
      checked: controller.mode === 'auto',
      click: () => controller.setMode('auto')
    },
    {
      label: 'Wymuś mikrofon: QuadCast 2',
      type: 'radio',
      checked: controller.mode === 'desk',
      click: () => controller.setMode('desk')
    },
    {
      label: 'Wymuś mikrofon: Słuchawki',
      type: 'radio',
      checked: controller.mode === 'headset',
      click: () => controller.setMode('headset')
    },
    { type: 'separator' },
    { label: 'Port COM: ' + (controller.config.get('port') || 'auto'), enabled: false },
    { label: 'Odśwież / wykryj port COM', click: () => controller.radar.stop().then(() => controller.radar.start()) },
    { type: 'separator' },
    { label: 'Wyjdź', click: () => app.quit() }
  ];

  tray.setContextMenu(Menu.buildFromTemplate(template));
  tray.setToolTip(`Auto Audio Switch\n${stateText}\nTryb: ${controller.mode}`);
}

function initTray() {
  tray = new Tray(buildIcon(controller.currentDevice));
  tray.on('click', () => {
    // lewy klik = przełącz manualnie desk/headset (debug bez radaru)
    controller.setMode(controller.mode === 'desk' ? 'headset' : 'desk');
  });
  refreshMenu();
  tray.setContextMenu(Menu.buildFromTemplate([{ label: 'Ładowanie…', enabled: false }]));
}

app.whenReady().then(() => {
  const config = new Config(path.join(app.getPath('userData'), 'config.json'));
  const audio = new AudioController(path.join(__dirname, 'bin'));
  const radar = new RadarListener(config);

  controller = new AppController(radar, audio, config);

  controller.on('switch', ({ state, device }) => console.log(`[main] switch -> ${state}: ${device}`));
  controller.on('switched', ({ state, ok }) => {
    if (ok) {
      tray.setImage(buildIcon(state));
      refreshMenu();
    }
  });
  controller.on('radarStatus', (s) => {
    lastRadarStatus = s;
    refreshMenu();
  });
  controller.on('error', (err) => {
    console.error('[main] error:', err.message);
    if (tray) {
      tray.displayBalloon({ title: 'Auto Audio Switch', content: `Błąd: ${err.message}` });
    }
  });
  controller.on('mode', () => refreshMenu());

  initTray();
  controller.start();
});

app.on('window-all-closed', (e) => {
  // bez okien głównych — tylko tray, nie zamykamy aplikacji
  e.preventDefault();
});