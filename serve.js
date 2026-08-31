// ══════════════════════════════════════════════════════════════════
//  THROW — fallback static server (Node).
//  start.bat prefers Python's http.server; this stands in when Python
//  isn't installed. Same job, same port, still zero dependencies:
//  serve app/ to 127.0.0.1 so the editor and display tabs share an
//  origin (BroadcastChannel needs one — see docs/NOTES.md).
// ══════════════════════════════════════════════════════════════════
const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT = Number(process.argv[2]) || 8420;
// Resolved from this file's location, not the cwd, so the server is correct
// however it was launched.
const ROOT = path.resolve(__dirname, 'app');

const MIME = {
  '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
  '.json':'application/json', '.css':'text/css; charset=utf-8',
  '.svg':'image/svg+xml', '.png':'image/png', '.jpg':'image/jpeg', '.ico':'image/x-icon',
};

http.createServer((req, res) => {
  let rel;
  try{ rel = decodeURIComponent(req.url.split('?')[0]); }
  catch(_){ res.writeHead(400); res.end('bad request'); return; }
  if(rel === '/') rel = '/THROW.html';

  // Resolve, then confirm the result is still inside ROOT — "..%2f.." must not
  // reach outside the served folder.
  const fp = path.resolve(ROOT, '.' + rel);
  if(fp !== ROOT && !fp.startsWith(ROOT + path.sep)){
    res.writeHead(403); res.end('forbidden'); return;
  }
  fs.readFile(fp, (err, data) => {
    if(err){ res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, {'Content-Type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream'});
    res.end(data);
  });
}).listen(PORT, '127.0.0.1', () => {
  console.log('THROW serving ' + ROOT + ' at http://localhost:' + PORT + '/THROW.html');
}).on('error', (err) => {
  console.error(err.code === 'EADDRINUSE'
    ? 'Port ' + PORT + ' is already in use — THROW may already be running.'
    : 'Server failed to start: ' + err.message);
  process.exit(1);
});
