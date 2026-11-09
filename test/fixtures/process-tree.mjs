import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  stdio: 'ignore',
  windowsHide: true,
});
writeFileSync(process.argv[2], JSON.stringify({ parent: process.pid, child: child.pid }), 'utf8');
setInterval(() => {}, 1000);
