// Serves the renderer in a normal browser (useful for quick testing without Electron).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'dist', 'renderer');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.map': 'application/json' };
const port = Number(process.env.PORT || 5178);
createServer(async (req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  const file = normalize(join(dir, url === '/' ? 'index.html' : url));
  if (!file.startsWith(dir)) { res.writeHead(403); res.end(); return; }
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404); res.end('Not found');
  }
}).listen(port, () => console.log(`Celerity (browser mode) at http://localhost:${port}`));
