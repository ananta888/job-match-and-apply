// Starts the Angular dev server reachable from the local network (for example a Windows PC).
// Usage: LAN_ALLOWED_HOSTS=192.168.1.20 npm --prefix web run start:lan
// The API stays on 127.0.0.1; the dev server proxies /api to it. Set LAN_ALLOWED_HOSTS in the
// environment of the API process too (npm run dev:lan does this for both processes).
import { spawn } from 'node:child_process';

const HOSTNAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const hosts = (process.env.LAN_ALLOWED_HOSTS ?? '')
  .split(',').map((value) => value.trim()).filter((value) => value.length > 0);

if (hosts.length === 0 || hosts.some((host) => !HOSTNAME.test(host))) {
  console.error('LAN_ALLOWED_HOSTS fehlt oder ist ungültig, z. B. LAN_ALLOWED_HOSTS=192.168.1.20');
  process.exit(1);
}

const args = ['ng', 'serve', '--port', '4201', '--host', '0.0.0.0', '--proxy-config', 'proxy.conf.json'];
// The "=" form keeps each host as one value; a separate argument would be read as the project name.
for (const host of hosts) args.push(`--allowed-hosts=${host}`);

const child = spawn('npx', args, { stdio: 'inherit', shell: process.platform === 'win32' });
child.on('exit', (code) => process.exit(code ?? 0));
