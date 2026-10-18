const http = require('http');
const admin = require('firebase-admin');

const PORT = Number(process.env.PORT || 3001);
const HOST = '0.0.0.0';

const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');

  const origin = req.headers.origin || '';
  const allowedOrigins = [
    'http://localhost:8080',
    'http://127.0.0.1:8080',
    'http://0.0.0.0:8080',
  ];

  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }

  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200);
    return res.end(JSON.stringify({
      ok: true,
      mode: 'local-test-server'
    }));
  }

  if (req.method !== 'POST' || req.url !== '/create-invoice') {
    res.writeHead(404);
    return res.end(JSON.stringify({ error: 'Not found' }));
  }

  // Require a valid Firebase ID token before creating invoices.
  try {
    const header = req.headers.authorization || '';
    if (!header.startsWith('Bearer ')) {
      res.writeHead(401);
      return res.end(JSON.stringify({ error: 'Sign-in required' }));
    }

    const serviceAccountText = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (!serviceAccountText) {
      res.writeHead(503);
      return res.end(JSON.stringify({ error: 'Server authentication is not configured' }));
    }

    if (admin.apps.length === 0) {
      const serviceAccount = JSON.parse(serviceAccountText);
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
      });
    }

    await admin.auth().verifyIdToken(header.substring(7));
  } catch (error) {
    console.error('Firebase authentication failed:', error.message);
    res.writeHead(401);
    return res.end(JSON.stringify({ error: 'Invalid or expired sign-in token' }));
  }

  const key = process.env.XENDIT_SECRET_KEY;
  if (!key || !key.startsWith('xnd_development_')) {
    res.writeHead(500);
    return res.end(JSON.stringify({
      error: 'Missing test key. Use an Xendit TEST secret key.'
    }));
  }

  try {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 10000) {
        res.writeHead(413);
        return res.end(JSON.stringify({ error: 'Request too large' }));
      }
    }

    const input = JSON.parse(body || '{}');
    const amount = Number(input.amount);

    if (!Number.isFinite(amount) || amount <= 0 || amount > 1000000) {
      res.writeHead(400);
      return res.end(JSON.stringify({ error: 'Invalid amount' }));
    }

    const response = await fetch('https://api.xendit.co/v2/invoices', {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' +
          Buffer.from(key + ':').toString('base64'),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        external_id: 'streetwear-demo-' + Date.now(),
        amount: Math.round(amount * 100) / 100,
        currency: 'PHP',
        description: 'Streetwear school project - test payment',
        invoice_duration: 86400,
        payer_email: typeof input.email === 'string'
          ? input.email.slice(0, 254)
          : undefined,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Xendit API returned HTTP', response.status);
      res.writeHead(502);
      return res.end(JSON.stringify({
        error: 'Xendit rejected the request',
        details: data.message || data.error_code || 'Check test key and API permissions',
      }));
    }

    res.writeHead(200);
    return res.end(JSON.stringify({
      success: true,
      invoiceId: data.id,
      invoiceUrl: data.invoice_url,
      status: data.status,
      mode: 'test',
    }));
  } catch (error) {
    console.error('Invoice request failed:', error.message);
    res.writeHead(500);
    return res.end(JSON.stringify({ error: 'Could not create test invoice' }));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Local Xendit test server: http://${HOST}:${PORT}`);
  console.log('Test key loaded:', Boolean(process.env.XENDIT_SECRET_KEY));
});
