import { exec, toast } from 'kernelsu';

const CLI = '/data/adb/modules/ksu-systemizer/bin/systemizer';

const state = {
  apps: [],
  systemized: new Set(),
  unlocked: new Set(),
  filter: '',
};

function $(id) {
  return document.getElementById(id);
}

function isSafePkg(pkg) {
  return /^[A-Za-z0-9._]+$/.test(pkg)
    && !pkg.startsWith('.')
    && !pkg.endsWith('.')
    && !pkg.includes('..');
}

async function run(args) {
  const { errno, stdout, stderr } = await exec(`${CLI} ${args}`);

  if (errno !== 0) {
    throw new Error(stderr || stdout || `Command failed: ${args}`);
  }

  return stdout.trim();
}

function setStatus(text) {
  $('status').textContent = text;
}

async function loadDiagnose() {
  const output = await run('diagnose');
  $('diagnoseBox').textContent = output || 'No diagnose output';
}

async function refresh() {
  setStatus('Refreshing...');

  const users = await run('list-user-apps');
  const done = await run('list-systemized');

  state.apps = users
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean);

  state.systemized = new Set(
    done
      .split('\n')
      .map(s => s.trim().split(/\s+/)[0])
      .filter(Boolean)
  );

  await loadDiagnose();

  render();
  setStatus(`Loaded ${state.apps.length} apps`);
}

async function systemize(pkg) {
  if (!isSafePkg(pkg)) {
    await toast('Invalid package name');
    return;
  }

  setStatus(`Systemizing ${pkg}...`);
  await run(`systemize ${pkg} app`);
  await toast('Done. Reboot required.');
  await refresh();
}

async function unsystemize(pkg) {
  if (!isSafePkg(pkg)) {
    await toast('Invalid package name');
    return;
  }

  if (!state.unlocked.has(pkg)) {
    state.unlocked.add(pkg);
    await toast('Unlocked. Tap Remove to confirm.');
    render();
    return;
  }

  setStatus(`Removing ${pkg}...`);
  await run(`unsystemize ${pkg}`);
  state.unlocked.delete(pkg);
  await toast('Removed. Reboot required.');
  await refresh();
}

function render() {
  const list = $('appList');
  const q = state.filter.trim().toLowerCase();

  const rows = state.apps
    .filter(pkg => pkg.toLowerCase().includes(q))
    .sort((a, b) => {
      const aa = state.systemized.has(a) ? 0 : 1;
      const bb = state.systemized.has(b) ? 0 : 1;
      return aa - bb || a.localeCompare(b);
    });

  list.innerHTML = '';

  for (const pkg of rows) {
    const processed = state.systemized.has(pkg);
    const unlocked = state.unlocked.has(pkg);

    const item = document.createElement('article');
    item.className = 'app-card card';

    const info = document.createElement('div');
    info.className = 'app-info';

    const title = document.createElement('strong');
    title.textContent = pkg;

    const subtitle = document.createElement('span');
    subtitle.textContent = processed ? 'system/app locked' : 'not processed';

    info.appendChild(title);
    info.appendChild(subtitle);

    const btn = document.createElement('button');
    btn.textContent = processed ? (unlocked ? 'Remove' : 'Unlock') : 'SYS';
    btn.className = processed ? (unlocked ? 'danger' : 'ghost') : 'primary';
    btn.onclick = () => {
      const action = processed ? unsystemize(pkg) : systemize(pkg);
      action.catch(async e => {
        setStatus(e.message);
        await toast(e.message);
      });
    };

    item.appendChild(info);
    item.appendChild(btn);
    list.appendChild(item);
  }
}

$('refreshBtn').onclick = () => {
  refresh().catch(async e => {
    setStatus(e.message);
    await toast(e.message);
  });
};

$('searchInput').oninput = e => {
  state.filter = e.target.value;
  render();
};

refresh().catch(e => {
  setStatus(e.message);
  $('diagnoseBox').textContent = e.message;
});
