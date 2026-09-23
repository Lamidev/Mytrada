const dns = require('dns');
if (dns.setDefaultResultOrder) {
  dns.setDefaultResultOrder('ipv4first');
}
const WebSocket = require('ws');
const https = require('https');

const configs = [
  { name: '1. IPv4-Forced blue.derivws.com (with Origin & UA)', url: 'wss://blue.derivws.com/websockets/v3?app_id=1089', family: 4, origin: 'https://app.deriv.com', ua: true },
  { name: '2. IPv4-Forced ws.derivws.com (with Origin & UA)', url: 'wss://ws.derivws.com/websockets/v3?app_id=1089', family: 4, origin: 'https://app.deriv.com', ua: true },
  { name: '3. IPv4-Forced red.derivws.com (with Origin & UA)', url: 'wss://red.derivws.com/websockets/v3?app_id=1089', family: 4, origin: 'https://app.deriv.com', ua: true },
  { name: '4. IPv4-Forced ws.derivws.com (no Origin, with UA)', url: 'wss://ws.derivws.com/websockets/v3?app_id=1089', family: 4, origin: null, ua: true },
  { name: '5. IPv4-Forced ws.derivws.com (no Origin, no UA)', url: 'wss://ws.derivws.com/websockets/v3?app_id=1089', family: 4, origin: null, ua: false },
  { name: '6. IPv4-Forced ws.derivws.com (app_id 16929, no Origin)', url: 'wss://ws.derivws.com/websockets/v3?app_id=16929', family: 4, origin: null, ua: false },
  { name: '7. IPv4-Forced green.derivws.com (with Origin & UA)', url: 'wss://green.derivws.com/websockets/v3?app_id=1089', family: 4, origin: 'https://app.deriv.com', ua: true },
  { name: '8. IPv4-Forced frontend.derivws.com (with Origin & UA)', url: 'wss://frontend.derivws.com/websockets/v3?app_id=1089', family: 4, origin: 'https://app.deriv.com', ua: true },
];

function testConfig(cfg) {
  return new Promise((resolve) => {
    console.log(`\n========================================\nTesting ${cfg.name}...\nURL: ${cfg.url}`);
    const headers = {};
    if (cfg.origin) headers['Origin'] = cfg.origin;
    if (cfg.ua) headers['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

    const wsOptions = { headers };
    if (cfg.family) wsOptions.family = cfg.family;

    const ws = new WebSocket(cfg.url, wsOptions);
    let resolved = false;

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        console.log("⏱️ TIMEOUT after 6s");
        try { ws.terminate(); } catch(e){}
        resolve();
      }
    }, 6000);

    ws.on('unexpected-response', (req, res) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        console.log(`❌ Unexpected Response: ${res.statusCode} ${res.statusMessage}`);
        console.log(`   cf-ray: ${res.headers['cf-ray'] || 'none'}`);
        resolve();
      });
    });

    ws.on('open', () => {
      if (resolved) return;
      console.log(`✅ CONNECTED! Sending ticks_history for BOOM500...`);
      ws.send(JSON.stringify({
        ticks_history: 'BOOM500',
        adjust_start_time: 1,
        count: 5,
        end: 'latest',
        style: 'candles',
        granularity: 300,
        req_id: 1
      }));
    });

    ws.on('message', (d) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      const res = JSON.parse(d.toString());
      if (res.candles) {
        console.log(`🎉 SUCCESS! Received ${res.candles.length} candles from Deriv! Latest: ${res.candles[res.candles.length - 1].close}`);
      } else {
        console.log(`Got message:`, d.toString().slice(0, 150));
      }
      try { ws.close(); } catch(e){}
      resolve();
    });

    ws.on('error', (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        console.log(`❌ Error: ${err.message}`);
        resolve();
      }
    });
  });
}

async function run() {
  for (const cfg of configs) {
    await testConfig(cfg);
  }
  console.log("\n========================================\nDiagnostic Complete.");
  process.exit(0);
}

run();
