import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const root = process.cwd();
const iconGenCs = path.join(root, 'src', 'native', 'IconGenerator.cs');
const binDir = path.join(root, 'bin');
const iconGenExe = path.join(binDir, 'IconGen.exe');

fs.mkdirSync('resources', { recursive: true });
fs.mkdirSync(binDir, { recursive: true });

function cscPath() {
  const csc = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
  return fs.existsSync(csc) ? `"${csc}"` : 'csc';
}

if (fs.existsSync(iconGenCs)) {
  console.log('[icons] Compiling and running IconGenerator.cs...');
  execSync(`${cscPath()} /nologo /optimize /out:"${iconGenExe}" "${iconGenCs}"`, { stdio: 'inherit' });
  execSync(`"${iconGenExe}"`, { stdio: 'inherit' });
  try { fs.unlinkSync(iconGenExe); } catch (_) {}
  console.log('[icons] Generated crisp icons in build/ and resources/');
}

