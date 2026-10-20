
const http = require('http');
const { initializeApp, getApps, cert } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');

const PORT = Number(process.env.PORT || 3001);
const HOST = '0.0.0.0';

const allowedOrigins = [
  'http://localhost:8080',
  'http://127.0.0.1:8080',
  'http://0.0.0.0:8080',
];

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function initializeFirebase() {
  if (getApps().length > 0) return;

  const json = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

  if (!json) {
    throw new Error('Firebase service account is not configured');
  }

  const serviceAccount = JSON.parse(json);

  initializeApp({
    credential: cert(serviceAccount),
    projectId: serviceAccount.project_id || 'sarisari-store-c63ee',
  });
}

async function readBody(req) {
  let body = '';

  for await (const chunk of req) {
    body += chunk;

    if (body.length > 10000) {
      throw new Error('REQUEST_TOO_LARGE');
    }
  }

  return JSON.parse(body || '{}');
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || '';

  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }

  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET, POST, OPTIONS'
  );
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization'
  );

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const pathname = new URL(
    req.url,
    'http://localhost'
  ).pathname;

  // Health check: does not require Firebase login.
  if (req.method === 'GET' && pathname === '/health') {
    return sendJson(res, 200, {
      ok: true,
      service: 'streetwear-payment-server',
      mode: 'test',
    });
  }

  if (req.method !== 'POST' || pathname !== '/create-invoice') {
    return sendJson(res, 404, {
      error: 'Not found',
      availableRoutes: [
        'GET /health',
        'POST /create-invoice',
      ],
    });
  }

  // Verify Firebase authentication before creating an invoice.
  const authorization = req.headers.authorization || '';

  if (!authorization.startsWith('Bearer ')) {
    return sendJson(res, 401, {
      error: 'Sign-in required. Please log in first.',
    });
  }

  try {
    initializeFirebase();

    const idToken = authorization.slice(7);
    await getAuth().verifyIdToken(idToken);
  } catch (error) {
    console.error('Firebase authentication failed:', error.stack || error.message);

    return sendJson(res, 401, {
      error: 'Invalid or expired Firebase sign-in token',
    });
  }

  const key = process.env.XENDIT_SECRET_KEY;

  if (!key || !key.startsWith('xnd_development_')) {
    return sendJson(res, 503, {
      error: 'Xendit test secret key is missing or has the wrong format',
    });
  }

  let input;

  try {
    input = await readBody(req);
  } catch (error) {
    if (error.message === 'REQUEST_TOO_LARGE') {
      return sendJson(res, 413, {
        error: 'Request is too large',
      });
    }

    return sendJson(res, 400, {
      error: 'Invalid JSON request body',
    });
  }

  const amount = Number(input.amount);

  if (
    !Number.isFinite(amount) ||
    amount <= 0 ||
    amount > 1000000
  ) {
    return sendJson(res, 400, {
      error: 'Invalid invoice amount',
    });
  }

  try {
    const response = await fetch(
      'https://api.xendit.co/v2/invoices',
      {
        method: 'POST',
        headers: {
          Authorization:
            'Basic ' +
            Buffer.from(key + ':').toString('base64'),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          external_id: 'streetwear-test-' + Date.now(),
          amount: Math.round(amount * 100) / 100,
          currency: 'PHP',
          description: 'Streetwear school project test invoice',
          invoice_duration: 86400,
          payer_email:
            typeof input.email === 'string'
              ? input.email.slice(0, 254)
              : undefined,
        }),
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error(
        'Xendit API error:',
        response.status,
        data.error_code || data.message || 'Unknown error'
      );

      return sendJson(res, 502, {
        error: 'Xendit could not create the test invoice',
        details:
          data.message ||
          data.error_code ||
          'Check the test key and Xendit account settings',
      });
    }

    return sendJson(res, 200, {
      success: true,
      invoiceId: data.id,
      invoiceUrl: data.invoice_url,
      status: data.status,
      mode: 'test',
    });
  } catch (error) {
    console.error('Invoice request failed:', error.message);

    return sendJson(res, 500, {
      error: 'Could not create the test invoice',
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Streetwear payment server listening on ${PORT}`);
  console.log('Xendit test key configured:', Boolean(
    process.env.XENDIT_SECRET_KEY
  ));
  console.log('Firebase service account configured:', Boolean(
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON
  ));
});
