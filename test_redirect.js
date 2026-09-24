const https = require('https');
const WebSocket = require('ws');

// 1. Follow HTTP 301 to see the redirect target
function checkRedirect(url) {
  return new Promise((resolve) => {
    https.get(url, (res) => {
      console.log(`\nHTTP ${url}`);
      console.log(`Status: ${res.statusCode}`);
      console.log(`Location: ${res.headers.location || 'none'}`);
      resolve(res.headers.location);
    }).on('error', (e) => {
      console.log(`HTTP error: ${e.message}`);
      resolve(null);
    });
  });
}

// 2. Test WebSocket with full 15s timeout
function testWs(url) {
  return new Promise((resolve) => {
    console.log(`\nConnecting WebSocket: ${url} (15s timeout)...`);
    const start = Date.now();
    const ws = new WebSocket(url, {
      family: 4,
      headers: {
        'Origin': 'https://app.deriv.com',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    const timer = setTimeout(() => {
      console.log(`⏱️ Timed out after ${((Date.now() - start)/1000).toFixed(1)}s`);
      try { ws.terminate(); } catch(e){}
      resolve(false);
    }, 15000);

    ws.on('unexpected-response', (req, res) => {
      clearTimeout(timer);
      console.log(`❌ Unexpected Response: ${res.statusCode} ${res.statusMessage} in ${((Date.now() - start)/1000).toFixed(1)}s`);
      resolve(false);
    });

    ws.on('open', () => {
      console.log(`✅ CONNECTED in ${((Date.now() - start)/1000).toFixed(1)}s! Sending ping...`);
      ws.send(JSON.stringify({ ping: 1 }));
    });

    ws.on('message', (d) => {
      clearTimeout(timer);
      console.log(`🎉 SUCCESS in ${((Date.now() - start)/1000).toFixed(1)}s! Response: ${d.toString()}`);
      try { ws.close(); } catch(e){}
      resolve(true);
    });

    ws.on('error', (e) => {
      clearTimeout(timer);
      console.log(`❌ Error in ${((Date.now() - start)/1000).toFixed(1)}s: ${e.message}`);
      resolve(false);
    });
  });
}

async function run() {
  await checkRedirect('https://api.deriv.com/websockets/v3?app_id=1089');
  await checkRedirect('https://smarttrader.deriv.com/websockets/v3?app_id=1089');
  await testWs('wss://ws.derivws.com/websockets/v3?app_id=1089');
  await testWs('wss://ws.binaryws.com/websockets/v3?app_id=1089');
}

run();
