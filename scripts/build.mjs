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

// 2. Generate app icons (.ico / .png) & crisp PNG tray icons
const iconCs = path.join(process.cwd(), 'src', 'native', 'IconGenerator.cs');
if (fs.existsSync(iconCs)) {
  console.log('[build] Generating app icons (.ico / .png)...');
  const csc = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
  const cscCmd = fs.existsSync(csc) ? `"${csc}"` : 'csc';
  const iconGenExe = path.join(binDir, 'IconGen.exe');
  execSync(`${cscCmd} /nologo /optimize /out:"${iconGenExe}" "${iconCs}"`, { stdio: 'inherit' });
  execSync(`"${iconGenExe}"`, { stdio: 'inherit' });
  try { fs.unlinkSync(iconGenExe); } catch (_) {}
}

console.log('[build] Generating crisp PNG tray icons...');
execSync('node scripts/generate-tray-icons.mjs', { stdio: 'inherit' });

// 3. Vite Build
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
const builderCmd = `npx electron-builder ${targetFlag} --config.win.signAndEditExecutable=false --config.npmRebuild=false`;

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

if (fs.existsSync(portableSrc)) {
  fs.copyFileSync(portableSrc, path.join(releasesDir, 'Auto Audio Switch (Portable).exe'));
}
if (fs.existsSync(installerSrc)) {
  fs.copyFileSync(installerSrc, path.join(releasesDir, 'Auto Audio Switch Setup 0.2.0.exe'));
}
if (fs.existsSync(latestYml)) {
  fs.copyFileSync(latestYml, path.join(releasesDir, 'latest.yml'));
}

console.log('\n[build] SUCCESS! Result:');
console.log(' -> releases/Auto Audio Switch (Portable).exe');
console.log(' -> releases/Auto Audio Switch Setup 0.2.0.exe');
