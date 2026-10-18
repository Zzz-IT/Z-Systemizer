import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const moduleDir = path.join(rootDir, 'module-template');
const outDir = path.join(rootDir, 'out');
const cliTarget = path.join(rootDir, 'cli/target/aarch64-linux-android/release/systemizer');
const webuiDist = path.join(rootDir, 'webui/dist');

function sha256(filePath) {
  const fileBuffer = fs.readFileSync(filePath);
  const hashSum = crypto.createHash('sha256');
  hashSum.update(fileBuffer);
  return hashSum.digest('hex');
}

function ensureLF(filePath) {
  const content = fs.readFileSync(filePath);
  const normalized = Buffer.from(content.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
  fs.writeFileSync(filePath, normalized);
}

function walkDir(dir, fileList = []) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const filePath = path.join(dir, file);
    if (fs.statSync(filePath).isDirectory()) {
      walkDir(filePath, fileList);
    } else {
      fileList.push(filePath);
    }
  }
  return fileList;
}

// 1. Check prerequisite
if (!fs.existsSync(cliTarget)) {
  console.error('Error: systemizer binary not found at', cliTarget);
  process.exit(1);
}

// 2. Prepare directories
fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(path.join(moduleDir, 'bin/arm64-v8a'), { recursive: true });
fs.mkdirSync(path.join(moduleDir, 'system/app'), { recursive: true });
fs.mkdirSync(path.join(moduleDir, 'state/apks'), { recursive: true });
fs.mkdirSync(path.join(moduleDir, 'checksums'), { recursive: true });

fs.writeFileSync(path.join(moduleDir, 'system/app/.gitkeep'), '');
fs.writeFileSync(path.join(moduleDir, 'state/.gitkeep'), '');
fs.writeFileSync(path.join(moduleDir, 'state/apks/.gitkeep'), '');

// 3. Copy systemizer binary
fs.copyFileSync(cliTarget, path.join(moduleDir, 'bin/arm64-v8a/systemizer'));

// 4. Copy webui dist to webroot
const webroot = path.join(moduleDir, 'webroot');
fs.rmSync(webroot, { recursive: true, force: true });
fs.mkdirSync(webroot, { recursive: true });
fs.cpSync(webuiDist, webroot, { recursive: true });

// 5. Ensure LF for all scripts & text files
for (const file of [
  path.join(moduleDir, 'customize.sh'),
  path.join(moduleDir, 'post-fs-data.sh'),
  path.join(moduleDir, 'service.sh'),
  path.join(moduleDir, 'module.prop'),
]) {
  if (fs.existsSync(file)) {
    ensureLF(file);
  }
}

// 6. Generate SHA256SUMS
const checksums = [];
const binRel = 'bin/arm64-v8a/systemizer';
checksums.push(`${sha256(path.join(moduleDir, binRel))}  ${binRel}`);

const webrootFiles = walkDir(webroot);
for (const f of webrootFiles) {
  const rel = path.relative(moduleDir, f).replace(/\\/g, '/');
  checksums.push(`${sha256(f)}  ${rel}`);
}
fs.writeFileSync(path.join(moduleDir, 'checksums/SHA256SUMS'), checksums.join('\n') + '\n');

// Read version from module.prop
const moduleProp = fs.readFileSync(path.join(moduleDir, 'module.prop'), 'utf8');
const versionMatch = moduleProp.match(/^version=(.+)$/m);
const version = versionMatch ? versionMatch[1].trim() : 'v1.2.5';
const zipName = `Z-Systemizer-${version}.zip`;
const zipPath = path.join(outDir, zipName);

// 7. Zip using 7z
if (fs.existsSync(zipPath)) {
  fs.unlinkSync(zipPath);
}

execSync(`7z a -tzip -mx=9 "${zipPath}" *`, { cwd: moduleDir, stdio: 'inherit' });

console.log(`\nSuccessfully packaged: ${zipPath}`);
console.log(`Package SHA256: ${sha256(zipPath)}`);
