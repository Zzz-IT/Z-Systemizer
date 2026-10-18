import http from 'node:http';
import { exec } from 'node:child_process';

const html = `<!DOCTYPE html>
<html>
<head>
<style>
.ptr-spinner {
  width: 24px; height: 24px; border: 2px solid red; border-top-color: transparent; border-radius: 50%;
  transform: scale(0.6);
}
.ptr-spinner.active {
  animation:
    ptr-spin-up 800ms cubic-bezier(0.4, 0.05, 0.9, 0.9) forwards,
    ptr-spin    800ms linear 800ms infinite;
  transform: scale(1);
}
@keyframes ptr-spin-up {
  from { transform: rotate(0deg) scale(1); }
  to   { transform: rotate(360deg) scale(1); }
}
@keyframes ptr-spin {
  from { transform: rotate(0deg) scale(1); }
  to { transform: rotate(360deg) scale(1); }
}
</style>
</head>
<body>
<div class="ptr-spinner active" id="s"></div>
<script>
let count = 0;
const logs = [];
const interval = setInterval(() => {
  const el = document.getElementById('s');
  const anims = el.getAnimations();
  const info = [];
  info.push('TICK ' + count);
  for (const a of anims) {
    info.push(a.animationName + ':' + a.playState + ':' + Math.round(a.currentTime));
  }
  info.push('transform=' + getComputedStyle(el).transform);
  logs.push(info.join(' | '));
  count++;
  if (count > 5) {
    clearInterval(interval);
    fetch('/done', { method: 'POST', body: logs.join('\\n') });
  }
}, 250);
</script>
</body>
</html>`;

const server = http.createServer((req, res) => {
  if (req.url === '/done') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      console.log('RESULTS FROM BROWSER:\n' + body);
      res.end();
      cleanup();
    });
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(html);
});

let chromeProc;
function cleanup() {
  if (chromeProc) chromeProc.kill();
  server.close(() => process.exit(0));
}

server.listen(5199, () => {
  const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  chromeProc = exec(`"${chrome}" --headless=new http://localhost:5199`);
  setTimeout(cleanup, 5000);
});
