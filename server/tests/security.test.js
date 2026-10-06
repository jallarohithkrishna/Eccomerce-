/**
 * Security Test Suite — PS-01 Phase 4b
 *
 * Covers the Returns API hardening gaps:
 *  - carrier webhook shared secret (missing / wrong / valid) + production boot guard
 *  - public verify enumeration throttling and non-personal payload
 *  - duplicate route detection across server/index.js and server/routes/*
 *  - signed, expiring courier-intake token restricted to PICKUP_SCHEDULED → IN_TRANSIT
 *  - intake ignores client-supplied decision and refund amount
 *
 * Run: node --test tests/security.test.js
 */

import { strict as assert } from 'assert';
import { describe, it, before, after, beforeEach } from 'node:test';
import http from 'node:http';

import { app } from '../index.js';
import {
  createReturnsRouter,
  secretsMatch,
  carrierWebhookSecret,
  CARRIER_SECRET_HEADER,
} from '../routes/returns.js';
import * as returnStore from '../returns/store.js';
import { _clearWindows } from '../middleware/rateLimit.js';

const SECRET = 'unit-test-carrier-secret';

let server;
let baseUrl;

before(async () => {
  process.env.NODE_ENV = 'test';
  process.env.CARRIER_WEBHOOK_SECRET = SECRET;
  await new Promise((resolve) => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      server.unref();
      resolve();
    });
  });
});

after(async () => {
  if (server) {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

beforeEach(() => {
  returnStore._clearAll();
  _clearWindows();
});

async function req(endpoint, { method = 'GET', headers = {}, body } = {}) {
  const reqHeaders = { Connection: 'close', ...headers };
  let payload;
  if (body !== undefined) {
    reqHeaders['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${baseUrl}${endpoint}`, { method, headers: reqHeaders, body: payload });
  const contentType = res.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await res.json() : await res.text();
  return { status: res.status, ok: res.ok, data };
}

async function createReturn(uid = 'cust-sec', orderId = 'ord_sec') {
  const res = await req('/returns/intake', {
    method: 'POST',
    headers: { 'x-dev-uid': uid, 'x-dev-role': 'customer' },
    body: { orderId, reason: 'defect' },
  });
  assert.equal(res.status, 201, `intake failed: ${JSON.stringify(res.data)}`);
  return res.data.returnRecord;
}

// ─── 1. Carrier webhook shared secret ────────────────────────────────────────

describe('Carrier webhook shared secret', () => {
  it('SEC01: refuses to start in production without CARRIER_WEBHOOK_SECRET', () => {
    const prevEnv = process.env.NODE_ENV;
    const prevSecret = process.env.CARRIER_WEBHOOK_SECRET;
    try {
      process.env.NODE_ENV = 'production';
      delete process.env.CARRIER_WEBHOOK_SECRET;
      assert.throws(
        () => createReturnsRouter(null),
        /CARRIER_WEBHOOK_SECRET must be set in production/
      );
      assert.equal(carrierWebhookSecret(), null, 'no secret may be invented in production');
    } finally {
      process.env.NODE_ENV = prevEnv;
      if (prevSecret === undefined) delete process.env.CARRIER_WEBHOOK_SECRET;
      else process.env.CARRIER_WEBHOOK_SECRET = prevSecret;
    }
  });

  it('SEC02: carrier webhook without the header is refused (401)', async () => {
    const record = await createReturn('cust-wh', 'ord_wh');
    const res = await req('/webhooks/carrier', {
      method: 'POST',
      body: { returnId: record.id, carrierStatus: 'PICKED_UP' },
    });
    assert.equal(res.status, 401);
    const after = await returnStore.getReturn({ db: null, identifier: record.id });
    assert.equal(after.status, 'REQUESTED', 'no state change may happen without the secret');
  });

  it('SEC03: carrier webhook with a wrong secret is refused (403)', async () => {
    const record = await createReturn('cust-wh2', 'ord_wh2');
    const res = await req('/webhooks/carrier', {
      method: 'POST',
      headers: { [CARRIER_SECRET_HEADER]: 'not-the-secret' },
      body: { returnId: record.id, carrierStatus: 'PICKED_UP' },
    });
    assert.equal(res.status, 403);

    // A near-miss secret must fail too (timing-safe compare, exact match only).
    const nearMiss = await req('/webhooks/carrier', {
      method: 'POST',
      headers: { [CARRIER_SECRET_HEADER]: SECRET + 'x' },
      body: { returnId: record.id, carrierStatus: 'PICKED_UP' },
    });
    assert.equal(nearMiss.status, 403);

    const after = await returnStore.getReturn({ db: null, identifier: record.id });
    assert.equal(after.status, 'REQUESTED');
  });

  it('SEC04: carrier webhook with the valid secret applies only legal transitions', async () => {
    const record = await createReturn('cust-wh3', 'ord_wh3');
    await returnStore.saveReturn({ returnRecord: { id: record.id, status: 'PICKUP_SCHEDULED' } });

    const res = await req('/webhooks/carrier', {
      method: 'POST',
      headers: { [CARRIER_SECRET_HEADER]: SECRET },
      body: { returnId: record.id, carrierStatus: 'PICKED_UP', trackingNumber: 'TRK-1' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.status, 'IN_TRANSIT');

    const after = await returnStore.getReturn({ db: null, identifier: record.id });
    assert.equal(after.status, 'IN_TRANSIT');
    assert.equal(after.last_carrier_status, 'PICKED_UP');
  });

  it('SEC05: valid secret still cannot perform an illegal transition (409)', async () => {
    const record = await createReturn('cust-wh4', 'ord_wh4'); // REQUESTED

    const jump = await req('/webhooks/carrier', {
      method: 'POST',
      headers: { [CARRIER_SECRET_HEADER]: SECRET },
      body: { returnId: record.id, carrierStatus: 'DELIVERED_TO_WAREHOUSE' },
    });
    assert.equal(jump.status, 409, 'REQUESTED → RECEIVED must be refused');

    await returnStore.saveReturn({ returnRecord: { id: record.id, status: 'COMPLETED' } });
    const reopen = await req('/webhooks/carrier', {
      method: 'POST',
      headers: { [CARRIER_SECRET_HEADER]: SECRET },
      body: { returnId: record.id, carrierStatus: 'EXCEPTION' },
    });
    assert.equal(reopen.status, 409, 'COMPLETED must stay terminal');

    const after = await returnStore.getReturn({ db: null, identifier: record.id });
    assert.equal(after.status, 'COMPLETED');
  });

  it('SEC06: secretsMatch is exact and never throws on odd input', () => {
    assert.equal(secretsMatch(SECRET, SECRET), true);
    assert.equal(secretsMatch(SECRET, SECRET + 'x'), false);
    assert.equal(secretsMatch('', SECRET), false);
    assert.equal(secretsMatch(SECRET, ''), false);
    assert.equal(secretsMatch(undefined, SECRET), false);
    assert.equal(secretsMatch(null, null), false);
    // Very different lengths must not blow up timingSafeEqual.
    assert.equal(secretsMatch('a'.repeat(5000), 'b'), false);
  });
});
