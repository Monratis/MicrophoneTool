import os from 'node:os';
import { execSync } from 'node:child_process';
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

// --- 2. Icons --------------------------------------------------------------

const iconIco = path.join(root, 'build', 'icon.ico');

// High-res multi-resolution .ico generator (only when sources changed)
const iconGenCs = path.join(root, 'src', 'native', 'IconGenerator.cs');
if (fs.existsSync(iconGenCs)) {
  const iconGenExe = path.join(binDir, 'IconGen.exe');
  if (compileIfStale(iconGenCs, iconGenExe) || !fs.existsSync(iconIco)) {
    console.log('[build] Generating high-res app icons (.ico / .png)...');
    execSync(`"${iconGenExe}"`, { stdio: 'inherit' });
    try { fs.unlinkSync(iconGenExe); } catch (_) {}
  }
}

// Tray PNGs (only when missing or generator script changed)
const trayScript = path.join(root, 'scripts', 'generate-tray-icons.mjs');
const trayTargets = ['tray-desk.png', 'tray-away.png', 'tray-default.png'].map((f) => path.join(root, 'resources', f));
const trayStale = trayTargets.some((f) => !fs.existsSync(f)) ||
  fs.statSync(trayScript).mtimeMs > Math.min(...trayTargets.filter(fs.existsSync).map((f) => fs.statSync(f).mtimeMs));
if (trayStale || trayTargets.some((f) => !fs.existsSync(f))) {
  console.log('[build] Generating PNG tray icons...');
  execSync(`node "${trayScript}"`, { stdio: 'inherit' });
}

// --- 3. Vite Build -----------------------------------------------------------

console.log('[build] Building Vite frontend & Electron bundles...');
execSync('npx electron-vite build', { stdio: 'inherit' });

// --- 4. Packaging ----------------------------------------------------------

// Kill stale instances of the built app (e.g. still running in tray) —
// they lock dist/ artifacts and makensis would wait for the unlock FOREVER
// ("output file is locked for writing" hang).
for (const procName of [appExeName, `${productName} (Portable).exe`, 'DeskSense.exe', 'DeskSense (Portable).exe']) {
  try {
    execSync(`taskkill /F /IM "${procName}" 2>nul`, { stdio: 'ignore' });
  } catch (_) {}
}
try {
  execSync(`powershell -NoProfile -Command "Get-Process | Where-Object { $_.Name -like 'DeskSense*' -or $_.Name -like 'AudioSwitcher*' } | Stop-Process -Force"`, { stdio: 'ignore' });
} catch (_) {}

if (fs.existsSync(distDir)) {
  try {
    fs.rmSync(distDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  } catch (err) {
    console.error(`[build] ERROR: cannot remove dist/: ${err.message}`);
    console.error('[build] A file is locked. Close the running app (check tray!), Explorer preview or any AV scanner, then re-run.');
    process.exit(1);
  }
}

let targetFlag = '--win nsis portable';
if (mode === 'portable') targetFlag = '--win portable';
else if (mode === 'installer') targetFlag = '--win nsis';

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

try {
  execSync(`powershell -NoProfile -Command "Get-Process | Where-Object { $_.Name -like 'DeskSense*' -or $_.Name -like 'AudioSwitcher*' } | Stop-Process -Force"`, { stdio: 'ignore' });
} catch (_) {}

fs.mkdirSync(releasesDir, { recursive: true });

// Remove stale artifacts so releases/ always reflects the last build mode
for (const f of fs.readdirSync(releasesDir)) {
  if (f.endsWith('.exe') || f.endsWith('.blockmap') || f === 'latest.yml') {
    try {
      fs.rmSync(path.join(releasesDir, f), { force: true, maxRetries: 5, retryDelay: 300 });
    } catch (_) {}
  }
}

const candidates = [
  `${productName} (Portable).exe`,
  `${productName} Setup *.exe`
];

function findArtifact(pattern) {
  return fs.readdirSync(distDir).find((f) => {
    if (pattern.includes('*')) {
      const rx = new RegExp('^' + pattern.replace(/[.*+?^${}()|[\]\\]/g, (m) => (m === '*' ? '[\\s\\S]*' : '\\' + m)) + '$');
      return rx.test(f);
    }
    return f === pattern;
  });
}

const copied = [];
for (const pattern of candidates) {
  const src = findArtifact(pattern);
  if (!src) continue;
  fs.copyFileSync(path.join(distDir, src), path.join(releasesDir, src));
  copied.push(src);
}
if (mode !== 'app' && fs.existsSync(path.join(distDir, 'win-unpacked'))) {
  console.log('[build] win-unpacked available at dist/win-unpacked/');
}

// --- 6. Patch custom icon into all release executables ----------------------

const iconPatcherExe = path.join(binDir, 'IconPatcher.exe');
compileIfStale(path.join(root, 'src', 'native', 'IconPatcher.cs'), iconPatcherExe);

const patchedFiles = [];

if (fs.existsSync(iconPatcherExe) && fs.existsSync(iconIco)) {
  console.log('[build] Patching all PE icon groups in release executables...');
  const targets = [
    ...copied.filter((f) => f.endsWith('.exe')).map((f) => path.join(releasesDir, f)),
    path.join(distDir, 'win-unpacked', appExeName)
  ];
  for (const exe of targets) {
    if (!fs.existsSync(exe)) continue;
    const sizeBefore = fs.statSync(exe).size;
    try {
      execSync(`"${iconPatcherExe}" "${exe}" "${iconIco}"`, { stdio: 'inherit' });
      // Guard: resource update must never drop the NSIS payload overlay
      const sizeAfter = fs.statSync(exe).size;
      if (sizeAfter < sizeBefore * 0.9) {
        console.error(`[build] FATAL: ${path.basename(exe)} truncated by icon patch (${sizeBefore} -> ${sizeAfter} bytes)`);
        process.exit(1);
      }
      patchedFiles.push(exe);
    } catch (err) {
      console.warn(`[build] Notice: icon patch failed for ${path.basename(exe)}: ${err.message}`);
    }
  }
}

// --- 7. Fix latest.yml AFTER icon patching (hashes must match final bytes) --
//
// WAŻNE: latest.yml w trybie "all" zawiera WPISY DLA KAŻDEGO ARTEFAKTU
// (portable + setup). Naiwne regexy z flagą /g podmieniałyby sha512/size
// WSZYSTKICH wpisów wartościami jednego pliku → auto-update klienta
// odrzucałby pobrany instalator/portable przy weryfikacji hasha.
// Stąd przetwarzanie blokami: każdy wpis (top-level path: oraz każdy
// "- url:") dopasowywany i przeliczany osobno.

const latestYmlSrc = path.join(distDir, 'latest.yml');
if (fs.existsSync(latestYmlSrc)) {
  const lines = fs.readFileSync(latestYmlSrc, 'utf8').split(/\r?\n/);
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9.]/g, '');
  const releasesExes = fs.readdirSync(releasesDir).filter((f) => f.toLowerCase().endsWith('.exe'));
  const findByNorm = (name) => releasesExes.find((f) => norm(f) === norm(String(name).trim()));

  // Granice bloków: linia "path:" oraz każda linia "- url:"
  const starts = [];
  lines.forEach((l, i) => {
    if (/^path:\s*\S/.test(l) || /^\s*-\s*url:\s*\S/.test(l)) starts.push(i);
  });

  let patchedEntries = 0;
  for (let b = 0; b < starts.length; b++) {
    const from = starts[b];
    const to = b + 1 < starts.length ? starts[b + 1] : lines.length;
    const m = lines[from].match(/^(?:path:\s*|\s*-\s*url:\s*)(.+)$/);
    if (!m) continue;
    const localFile = findByNorm(m[1]);
    if (!localFile) continue;

    const localPath = path.join(releasesDir, localFile);
    const hash = sha512Base64(localPath);
    const size = fs.statSync(localPath).size;

    for (let i = from; i < to; i++) {
      if (i === from) {
        // Nazwa pliku to cały ogon linii po prefiksie ("path: " / "- url: ")
        lines[i] = lines[i].slice(0, lines[i].length - m[1].length) + localFile;
      } else if (/^\s*sha512:/.test(lines[i])) {
        lines[i] = lines[i].replace(/sha512:\s*.+$/, `sha512: ${hash}`);
      } else if (/^\s*size:\s*\d/.test(lines[i])) {
        lines[i] = lines[i].replace(/size:\s*\d+\s*$/, `size: ${size}`);
      }
    }
    patchedEntries++;
  }

  if (patchedEntries > 0) {
    fs.writeFileSync(path.join(releasesDir, 'latest.yml'), lines.join('\n'));
    copied.push('latest.yml');
    console.log(`[build] latest.yml re-hashed after icon patch (${patchedEntries} entr${patchedEntries === 1 ? 'y' : 'ies'})`);
  } else {
    console.log(`[build] Skipping latest.yml (no matching artifacts in mode "${mode}")`);
  }
} else if (patchedFiles.length > 0 && mode !== 'all') {
  console.warn('[build] Warning: no latest.yml found — auto-update metadata will be stale.');
}

console.log('\n[build] SUCCESS! Result:');
for (const f of copied) console.log(` -> releases/${f}`);
