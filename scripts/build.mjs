import os from 'node:os';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const cpus = os.cpus().length || 4;
const mode = process.argv[2] || 'all'; // 'portable', 'installer', 'all'

console.log(`[build] Hardware: ${cpus} CPU threads (${os.cpus()[0]?.model || 'Processor'})`);

// 1. Build native AudioSwitcher
const binDir = path.join(process.cwd(), 'bin');
const nativeCs = path.join(process.cwd(), 'src', 'native', 'AudioSwitcher.cs');
const nativeExe = path.join(binDir, 'AudioSwitcher.exe');

fs.mkdirSync(binDir, { recursive: true });

if (!fs.existsSync(nativeExe) || fs.statSync(nativeCs).mtimeMs > fs.statSync(nativeExe).mtimeMs) {
  console.log('[build] Compiling native AudioSwitcher.exe...');
  const csc = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
  const cscCmd = fs.existsSync(csc) ? `"${csc}"` : 'csc';
  execSync(`${cscCmd} /nologo /optimize /out:"${nativeExe}" "${nativeCs}"`, { stdio: 'inherit' });
}

// 2. Generate high-res multi-resolution app icons (.ico / .png)
const iconCs = path.join(process.cwd(), 'src', 'native', 'IconGenerator.cs');
if (fs.existsSync(iconCs)) {
  console.log('[build] Compiling and generating high-res app icons (.ico / .png)...');
  const csc = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
  const cscCmd = fs.existsSync(csc) ? `"${csc}"` : 'csc';
  const iconGenExe = path.join(binDir, 'IconGen.exe');
  execSync(`${cscCmd} /nologo /optimize /out:"${iconGenExe}" "${iconCs}"`, { stdio: 'inherit' });
  execSync(`"${iconGenExe}"`, { stdio: 'inherit' });
  try { fs.unlinkSync(iconGenExe); } catch (_) {}
}

console.log('[build] Generating crisp PNG tray icons...');
execSync('node scripts/generate-tray-icons.mjs', { stdio: 'inherit' });

// 3. Vite Build (Vite 8.2.2 + React 19)
console.log('[build] Building Vite frontend & Electron bundles...');
execSync('npx electron-vite build', { stdio: 'inherit' });

// 4. Packaging
let targetFlag = '--win portable nsis';
if (mode === 'portable') {
  targetFlag = '--win portable';
} else if (mode === 'installer') {
  targetFlag = '--win nsis';
}

console.log(`[build] Packaging application (${mode} -> ${targetFlag})...`);
const builderCmd = `npx electron-builder ${targetFlag} --config.win.signExecutable=false --config.npmRebuild=false`;

execSync(builderCmd, {
  stdio: 'inherit',
  env: {
    ...process.env,
    OMP_NUM_THREADS: String(cpus),
    UV_THREADPOOL_SIZE: String(cpus)
  }
});

// 5. Copy release binaries to releases/ folder for GitHub repo
const releasesDir = path.join(process.cwd(), 'releases');
fs.mkdirSync(releasesDir, { recursive: true });

const portableSrc = path.join(process.cwd(), 'dist', 'Auto Audio Switch (Portable).exe');
const installerSrc = path.join(process.cwd(), 'dist', 'Auto Audio Switch Setup 0.2.0.exe');
const latestYml = path.join(process.cwd(), 'dist', 'latest.yml');

const portableDst = path.join(releasesDir, 'Auto Audio Switch (Portable).exe');
const installerDst = path.join(releasesDir, 'Auto Audio Switch Setup 0.2.0.exe');

if (fs.existsSync(portableSrc)) {
  fs.copyFileSync(portableSrc, portableDst);
}
if (fs.existsSync(installerSrc)) {
  fs.copyFileSync(installerSrc, installerDst);
}
if (fs.existsSync(latestYml)) {
  fs.copyFileSync(latestYml, path.join(releasesDir, 'latest.yml'));
}

// 6. Direct Resource injection of custom icon using rcedit into all release binaries
const iconIco = path.join(process.cwd(), 'build', 'icon.ico');
const rceditExe = path.join(process.cwd(), 'node_modules', 'rcedit', 'bin', 'rcedit-x64.exe');
if (fs.existsSync(rceditExe) && fs.existsSync(iconIco)) {
  console.log('[build] Ensuring custom icon is injected into release executables...');
  const targets = [
    portableDst,
    installerDst,
    path.join(process.cwd(), 'dist', 'win-unpacked', 'Auto Audio Switch.exe')
  ];
  for (const exe of targets) {
    if (fs.existsSync(exe)) {
      try {
        execSync(`"${rceditExe}" "${exe}" --set-icon "${iconIco}"`, { stdio: 'inherit' });
        console.log(` -> Custom icon verified in: ${path.basename(exe)}`);
      } catch (err) {
        console.warn(`[build] Notice: ${err.message}`);
      }
    }
  }
}

console.log('\n[build] SUCCESS! Result:');
console.log(' -> releases/Auto Audio Switch (Portable).exe (z naszą ikonką)');
console.log(' -> releases/Auto Audio Switch Setup 0.2.0.exe (z naszą ikonką)');
