const WebSocket = require('ws');

const domains = [
  'wss://ws.deriv.com/websockets/v3?app_id=1089',
  'wss://api.deriv.com/websockets/v3?app_id=1089',
  'wss://smarttrader.deriv.com/websockets/v3?app_id=1089',
  'wss://staging-ws.derivws.com/websockets/v3?app_id=1089',
  'wss://oauth.deriv.com/websockets/v3?app_id=1089',
  'wss://ws.derivws.com/websockets/v3?app_id=1089',
  'wss://ws.binaryws.com/websockets/v3?app_id=1089'
];

async function test(url) {
  return new Promise((resolve) => {
    console.log(`\nTesting: ${url}`);
    const ws = new WebSocket(url, {
      family: 4,
      headers: {
        'Origin': 'https://app.deriv.com',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    const timer = setTimeout(() => {
      console.log(`⏱️ TIMEOUT (4s)`);
      try { ws.terminate(); } catch(e){}
      resolve(false);
    }, 4000);

    ws.on('unexpected-response', (req, res) => {
      clearTimeout(timer);
      console.log(`❌ HTTP ${res.statusCode} ${res.statusMessage}`);
      resolve(false);
    });

    ws.on('open', () => {
      console.log(`✅ CONNECTED!`);
      ws.send(JSON.stringify({ ping: 1 }));
    });

    ws.on('message', (d) => {
      clearTimeout(timer);
      console.log(`🎉 SUCCESS! Got response:`, d.toString().slice(0, 100));
      try { ws.close(); } catch(e){}
      resolve(true);
    });

    ws.on('error', (e) => {
      clearTimeout(timer);
      console.log(`❌ Error: ${e.message}`);
      resolve(false);
    });
  });
}

async function run() {
  for (const d of domains) {
    const ok = await test(d);
    if (ok) {
      console.log(`\n🎯 FOUND WORKING DOMAIN: ${d}`);
    }
  }
}

run();
