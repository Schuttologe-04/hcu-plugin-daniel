import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

// Scan only files admitted to the Docker context. Never read private .env/config.
const root = resolve(process.argv[2] ?? '.');
const topLevel = ['Dockerfile', '.dockerignore', 'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.build.json', 'config.installed.json'];
const expectedDockerignore = [...topLevel.map((name) => `!${name}`), '!src/', '!src/**'];
const admitted = [];
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Symbolic links are not accepted in the package source.');
    if (entry.isDirectory()) await walk(path);
    else if (entry.isFile()) admitted.push(path);
  }
}
try {
  const ignore = (await readFile(join(root, '.dockerignore'), 'utf8')).split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
  if (ignore[0] !== '**' || JSON.stringify(ignore.slice(1).sort()) !== JSON.stringify(expectedDockerignore.sort())) {
    throw new Error('Docker context allowlist differs from the reviewed package inputs.');
  }
  await walk(join(root, 'src'));
  for (const name of topLevel) admitted.push(join(root, name));
  for (const path of admitted) {
    const content = await readFile(path, 'utf8');
    if (/(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)|(?:\b(?:authToken|authtoken|HCU_AUTHTOKEN|activationKey|clientId|token)['"]?\s*[:=]\s*['"][^'"\r\n]+['"])/i.test(content)) {
      throw new Error('A package input contains a literal credential or private key; content has not been logged.');
    }
  }
  const seed = JSON.parse(await readFile(join(root, 'config.installed.json'), 'utf8'));
  if (seed?.loadManagement?.liveControlEnabled !== false) throw new Error('Installed seed must disable automatic real control.');
  const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (metadata.version !== '0.2.1') throw new Error('Package version must be 0.2.1.');
  console.log(JSON.stringify({ status: 'PACKAGE_INPUTS_CHECKED', admittedFiles: admitted.length, privateDevelopmentFilesRead: false }));
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Package input validation failed.');
  process.exitCode = 1;
}
