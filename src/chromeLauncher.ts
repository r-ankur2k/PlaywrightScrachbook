import { spawn } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

export async function isPortOpen(port: number = 9222): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`);
    return res.ok;
  } catch {
    return false;
  }
}

export async function launchChrome(port: number = 9222): Promise<boolean> {
  if (await isPortOpen(port)) {
    return true;
  }

  const userDataDir = path.join(os.tmpdir(), 'chrome-pw-debug');

  if (process.platform === 'win32') {
    const defaultPaths = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(process.env.PROGRAMFILES || '', 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || '', 'Google\\Chrome\\Application\\chrome.exe'),
    ];

    const chromePath = defaultPaths.find((p) => p && fs.existsSync(p));
    if (chromePath) {
      spawn(chromePath, [`--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`], {
        detached: true,
        stdio: 'ignore',
      }).unref();
    } else {
      spawn('cmd.exe', ['/c', 'start', 'chrome', `--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`], {
        detached: true,
        stdio: 'ignore',
      }).unref();
    }
  } else if (process.platform === 'darwin') {
    spawn('open', ['-a', 'Google Chrome', '--args', `--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`], {
      detached: true,
      stdio: 'ignore',
    }).unref();
  } else {
    spawn('google-chrome', [`--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`], {
      detached: true,
      stdio: 'ignore',
    }).unref();
  }

  // Poll for up to 5 seconds until Chrome's CDP endpoint is up
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await isPortOpen(port)) {
      return true;
    }
  }

  return false;
}
