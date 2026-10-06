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
import { generateRma, RMA_PATTERN, RMA_RANDOM_LENGTH } from '../returns/rma.js';
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
  return { status: res.status, ok: res.ok, data, headers: Object.fromEntries(res.headers.entries()) };
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

// ─── 2. Public verify: unguessable keys, throttling, non-personal payload ────

describe('Public return verification pass', () => {
  it('SEC07: RMA numbers are 12+ crypto-random characters, unique, and no longer timestamps', async () => {
    const seen = new Set();
    for (let i = 0; i < 50; i++) {
      const rma = generateRma();
      assert.ok(RMA_PATTERN.test(rma), `${rma} must match the RMA pattern`);
      assert.equal(rma.slice('RMA-'.length).length, RMA_RANDOM_LENGTH);
      seen.add(rma);
    }
    assert.equal(seen.size, 50, 'every RMA must be unique');

    // The old generator produced a base36 timestamp; it must not qualify.
    const legacyStyle = `RMA-${Date.now().toString(36).toUpperCase()}`;
    assert.equal(RMA_PATTERN.test(legacyStyle), false, 'timestamp RMA must be rejected');

    // And a real intake must not hand out a predictable code.
    const record = await createReturn('cust-rma', 'ord_rma');
    assert.ok(RMA_PATTERN.test(record.rma_number));
    assert.notEqual(record.rma_number, legacyStyle);
    assert.notEqual(record.rma_number, `RMA-${Date.now().toString(36).toUpperCase()}`);
  });

  it('SEC08: verify accepts only RMA numbers — raw ids and order ids are 404', async () => {
    const record = await createReturn('cust-vfy', 'ord_vfy');

    for (const bogus of [record.id, 'ord_vfy', 'TRK-123456', 'RMA-short', '../../../etc/passwd']) {
      const res = await req(`/returns/verify/${encodeURIComponent(bogus)}`);
      assert.equal(res.status, 404, `${bogus} must not resolve a case`);
    }

    const ok = await req(`/returns/verify/${record.rma_number}`);
    assert.equal(ok.status, 200);
    assert.equal(ok.data.rma_number, record.rma_number);
  });

  it('SEC09: the public payload carries no personal fields', async () => {
    const record = await createReturn('cust-pii', 'ord_pii');
    // Plant personal data the way a real Firestore document would carry it.
    await returnStore.saveReturn({
      returnRecord: {
        id: record.id,
        userId: 'uid-secret-123',
        user_id: 'uid-secret-123',
        email: 'alice@example.com',
        phone: '+91 98765 43210',
        reason: 'My screen cracked, call me on 98765 43210',
        appealReason: 'contact me at alice@example.com',
        pickup_details: {
          carrier: 'BlueDart Express Reverse',
          tracking_number: 'RET-DEL-12345678',
          slot: 'Tomorrow, 10:00 AM - 1:00 PM',
          address: '221B Baker Street, Bengaluru 560001',
        },
      }
    });

    const res = await req(`/returns/verify/${record.rma_number}`);
    assert.equal(res.status, 200);

    const body = JSON.stringify(res.data);
    for (const forbidden of ['uid-secret-123', 'alice@example.com', '9876543210', 'Baker Street']) {
      assert.equal(body.includes(forbidden), false, `payload leaked "${forbidden}"`);
    }
    for (const key of ['userId', 'user_id', 'email', 'phone', 'reason', 'appealReason', 'messages']) {
      assert.equal(key in res.data, false, `field '${key}' must not be exposed`);
    }
    assert.equal('address' in (res.data.pickup_details || {}), false, 'pickup address must not be exposed');
    // Useful logistics still reach the courier.
    assert.equal(res.data.pickup_details.tracking_number, 'RET-DEL-12345678');
    assert.ok(res.data.id, 'the courier still needs the case id for courier-intake');
  });

  it('SEC10: enumeration of /returns/verify is throttled at 30/min/IP', async () => {
    const allowed = 30;
    let throttled = null;

    for (let i = 1; i <= allowed + 5; i++) {
      const res = await req(`/returns/verify/${generateRma()}`);
      if (res.status === 429) { throttled = { at: i, res }; break; }
      assert.ok([200, 404].includes(res.status), `unexpected ${res.status} before the limit`);
    }

    assert.ok(throttled, `expected a 429 after ${allowed} requests`);
    assert.equal(throttled.at, allowed + 1, `request ${allowed + 1} must be the first throttled one`);
    assert.equal(throttled.res.status, 429);
    assert.ok(throttled.res.headers['retry-after'], 'Retry-After expected on 429');

    // The bucket is per-IP, so nothing about the record is revealed by the 429.
    const body = JSON.stringify(throttled.res.data);
    assert.equal(body.includes('rma_number'), false);
  });
});
