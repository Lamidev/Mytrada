const WebSocket = require('ws');

const configs = [
  { name: '1. blue.derivws.com (origin app.deriv.com)', url: 'wss://blue.derivws.com/websockets/v3?app_id=1089', origin: 'https://app.deriv.com' },
  { name: '2. blue.derivws.com (no origin)', url: 'wss://blue.derivws.com/websockets/v3?app_id=1089', origin: null },
  { name: '3. ws.derivws.com (origin app.deriv.com)', url: 'wss://ws.derivws.com/websockets/v3?app_id=1089', origin: 'https://app.deriv.com' },
  { name: '4. ws.derivws.com (no origin)', url: 'wss://ws.derivws.com/websockets/v3?app_id=1089', origin: null },
  { name: '5. ws.derivws.com (app_id 16929)', url: 'wss://ws.derivws.com/websockets/v3?app_id=16929', origin: null },
  { name: '6. ws.derivws.com (app_id 36300)', url: 'wss://ws.derivws.com/websockets/v3?app_id=36300', origin: null },
  { name: '7. frontend.derivws.com', url: 'wss://frontend.derivws.com/websockets/v3?app_id=1089', origin: 'https://app.deriv.com' },
  { name: '8. ws.binaryws.com (origin binary.com)', url: 'wss://ws.binaryws.com/websockets/v3?app_id=1089', origin: 'https://tradingview.binary.com' },
  { name: '9. ws.binaryws.com (no origin)', url: 'wss://ws.binaryws.com/websockets/v3?app_id=1089', origin: null },
  { name: '10. red.derivws.com (origin app.deriv.com)', url: 'wss://red.derivws.com/websockets/v3?app_id=1089', origin: 'https://app.deriv.com' }
];

function testConfig(cfg) {
  return new Promise((resolve) => {
    console.log(`\n========================================\nTesting ${cfg.name}...\nURL: ${cfg.url}`);
    const headers = {};
    if (cfg.origin) {
      headers['Origin'] = cfg.origin;
    }

    const ws = new WebSocket(cfg.url, { headers });
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
        console.log(`   server: ${res.headers['server'] || 'none'}`);
        const titleMatch = body.match(/<title>(.*?)<\/title>/i);
        if (titleMatch) console.log(`   Page title: ${titleMatch[1]}`);
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
