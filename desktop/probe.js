const { WebSocketServer } = require('ws');

const wss = new WebSocketServer({ host: '127.0.0.1', port: 8787 });

wss.on('connection', (ws, req) => {
  console.log('[probe] CONNECTED. origin =', req.headers.origin);
  ws.on('message', (m) => {
    console.log('[probe] received:', m.toString());
    ws.send('echo: ' + m.toString());
  });
});

console.log('[probe] listening on 127.0.0.1:8787');
