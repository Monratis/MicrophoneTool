import os from 'node:os';
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const cpus = os.cpus().length || 4;
const mode = process.argv[2] || 'all'; // 'app', 'portable', 'installer', 'all'

const root = process.cwd();
const binDir = path.join(root, 'bin');
const distDir = path.join(root, 'dist');
const releasesDir = path.join(root, 'releases');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const productName = pkg.build?.productName || pkg.name;
const version = pkg.version;
const appExeName = `${productName}.exe`;

console.log(`[build] Hardware: ${cpus} CPU threads (${os.cpus()[0]?.model || 'Processor'})`);
console.log(`[build] Building ${productName} v${version} (mode: ${mode})`);

// --- Helpers -------------------------------------------------------------

function cscPath() {
  const csc = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
  return fs.existsSync(csc) ? `"${csc}"` : 'csc';
}

function compileIfStale(csSource, outExe) {
  if (!fs.existsSync(csSource)) return false;
  if (fs.existsSync(outExe) && fs.statSync(csSource).mtimeMs <= fs.statSync(outExe).mtimeMs) {
    return false;
  }
  console.log(`[build] Compiling ${path.basename(outExe)}...`);
  execSync(`${cscPath()} /nologo /optimize /out:"${outExe}" "${csSource}"`, { stdio: 'inherit' });
  return true;
}

function sha512Base64(file) {
  return crypto.createHash('sha512').update(fs.readFileSync(file)).digest('base64');
}

// --- 1. Native binaries ----------------------------------------------------

fs.mkdirSync(binDir, { recursive: true });

compileIfStale(
  path.join(root, 'src', 'native', 'AudioSwitcher.cs'),
  path.join(binDir, 'AudioSwitcher.exe')
);

// --- 2. Icons & Assets -----------------------------------------------------

const iconIco = path.join(root, 'build', 'icon.ico');
const iconPng = path.join(root, 'build', 'icon.png');
const resIconPng = path.join(root, 'resources', 'icon.png');
const trayTargets = ['tray-desk.png', 'tray-away.png', 'tray-default.png'].map((f) => path.join(root, 'resources', f));

const iconGenCs = path.join(root, 'src', 'native', 'IconGenerator.cs');
const allIconAssets = [iconIco, iconPng, resIconPng, ...trayTargets];
const iconsStale =
  !fs.existsSync(iconGenCs)
    ? false
    : allIconAssets.some((f) => !fs.existsSync(f)) ||
      fs.statSync(iconGenCs).mtimeMs > Math.min(...allIconAssets.filter(fs.existsSync).map((f) => fs.statSync(f).mtimeMs));

if (iconsStale && fs.existsSync(iconGenCs)) {
  console.log('[build] Generating high-res app & tray icons (.ico / .png)...');
  const iconGenExe = path.join(binDir, 'IconGen.exe');
  execSync(`${cscPath()} /nologo /optimize /out:"${iconGenExe}" "${iconGenCs}"`, { stdio: 'inherit' });
  execSync(`"${iconGenExe}"`, { stdio: 'inherit' });
  try { fs.unlinkSync(iconGenExe); } catch (_) {}
}

// --- 3. Vite Build ---------------------------------------------------------

console.log('[build] Building Vite frontend & Electron bundles...');
execSync('npx electron-vite build', { stdio: 'inherit' });

// --- 4. Packaging ----------------------------------------------------------

// Kill stale instances of the built app (e.g. running in tray) —
// they lock files and makensis would hang waiting forever.
for (const procName of [appExeName, `${productName} (Portable).exe`, 'DeskSense.exe', 'DeskSense (Portable).exe']) {
  try {
    execSync(`taskkill /F /IM "${procName}" 2>nul`, { stdio: 'ignore' });
  } catch (_) {}
}
try {
  execSync(`powershell -NoProfile -Command "Get-Process -Name 'DeskSense*', 'AudioSwitcher*' -ErrorAction SilentlyContinue | Stop-Process -Force"`, { stdio: 'ignore' });
} catch (_) {}

if (fs.existsSync(distDir)) {
  try {
    fs.rmSync(distDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  } catch (err) {
    console.error(`[build] ERROR: cannot remove dist/: ${err.message}`);
    console.error('[build] A file is locked. Close the running app (check tray!), then re-run.');
    process.exit(1);
  }
}

let targetFlag = '--win nsis portable';
if (mode === 'portable') targetFlag = '--win portable';
else if (mode === 'installer') targetFlag = '--win nsis';
else if (mode === 'app') targetFlag = '--win dir';

console.log(`[build] Packaging application (${mode} -> ${targetFlag})...`);
execSync(`npx electron-builder ${targetFlag} --config.win.signExecutable=false --config.npmRebuild=false`, {
  stdio: 'inherit',
  env: {
    ...process.env,
    OMP_NUM_THREADS: String(cpus),
    UV_THREADPOOL_SIZE: String(cpus)
  }
});

// --- 5. Copy release binaries ----------------------------------------------

if (mode !== 'app') {
  fs.mkdirSync(releasesDir, { recursive: true });

  // Remove stale artifacts so releases/ always reflects the current build
  for (const f of fs.readdirSync(releasesDir)) {
    if (f.endsWith('.exe') || f.endsWith('.blockmap') || f === 'latest.yml') {
      try {
        fs.rmSync(path.join(releasesDir, f), { force: true, maxRetries: 5, retryDelay: 300 });
      } catch (_) {}
    }
  }

  const candidates = [
    `${productName} (Portable).exe`,
    `${productName} Setup *.exe`,
    `${productName} Setup *.exe.blockmap`,
    'latest.yml'
  ];

  function findArtifacts(pattern) {
    if (!fs.existsSync(distDir)) return [];
    if (pattern.includes('*')) {
      const rx = new RegExp('^' + pattern.replace(/[.*+?^${}()|[\]\\]/g, (m) => (m === '*' ? '[\\s\\S]*' : '\\' + m)) + '$');
      return fs.readdirSync(distDir).filter((f) => rx.test(f));
    }
    return fs.existsSync(path.join(distDir, pattern)) ? [pattern] : [];
  }

  const copied = [];
  for (const pattern of candidates) {
    const matches = findArtifacts(pattern);
    for (const src of matches) {
      fs.copyFileSync(path.join(distDir, src), path.join(releasesDir, src));
      copied.push(src);
    }
  }

  console.log('\n[build] SUCCESS! Release artifacts in releases/:');
  for (const f of copied) {
    const stat = fs.statSync(path.join(releasesDir, f));
    const mb = (stat.size / (1024 * 1024)).toFixed(2);
    console.log(` -> releases/${f} (${mb} MB)`);
  }

  // Automatyczne uruchomienie wersji Portable po udanym buildzie (chyba że podano --no-launch)
  const portableExe = path.join(releasesDir, `${productName} (Portable).exe`);
  const shouldLaunch = (mode === 'portable' || mode === 'all' || process.argv.includes('--launch')) && !process.argv.includes('--no-launch');
  if (shouldLaunch && fs.existsSync(portableExe)) {
    console.log(`\n[build] 🚀 Uruchamiam nowo zbudowaną wersję: ${path.basename(portableExe)}...`);
    try {
      const child = spawn(portableExe, [], { detached: true, stdio: 'ignore' });
      child.unref();
      console.log('[build] Aplikacja uruchomiona w tle.');
    } catch (err) {
      console.warn(`[build] Nie udało się automatycznie uruchomić aplikacji: ${err.message}`);
    }
  }
} else {
  console.log('\n[build] SUCCESS! Unpacked app in dist/win-unpacked/');
}
