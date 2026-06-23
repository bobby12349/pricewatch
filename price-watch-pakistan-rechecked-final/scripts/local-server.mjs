import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const root = process.cwd();
const types = { '.html':'text/html', '.css':'text/css', '.js':'text/javascript', '.json':'application/json' };
http.createServer((req,res)=>{
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/') p = '/index.html';
  if (p === '/admin' || p === '/admin/') p = '/admin/index.html';
  const file = path.join(root, p);
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('Not found'); return; }
  res.writeHead(200, {'content-type': types[path.extname(file)] || 'text/plain'}); fs.createReadStream(file).pipe(res);
}).listen(3000, ()=>console.log('Local server: http://localhost:3000'));
