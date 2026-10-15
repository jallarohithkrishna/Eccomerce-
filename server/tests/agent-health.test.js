import { strict as assert } from 'node:assert';
import { describe, it, before, after } from 'node:test';
import http from 'node:http';
import { app } from '../index.js';
import { getModelCallCount, resetModelCallCount } from '../llm/client.js';

let server;
let baseUrl;

before(async () => {
  await new Promise((resolve) => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
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

describe('GET /agent/health endpoint', () => {
  it('returns health object without secrets', async () => {
    const res = await fetch(`${baseUrl}/agent/health`);
    assert.equal(res.status, 200);

    const json = await res.json();
    assert.equal(typeof json.llmConfigured, 'boolean');
    assert.ok('model' in json);
    assert.equal(typeof json.toolCallingProbe, 'boolean');
    assert.equal(typeof json.modelCalls, 'number');

    // Security check: ensure NO secret keys leaked
    const rawBody = JSON.stringify(json);
    assert.ok(!rawBody.includes('Bearer'));
    assert.ok(!rawBody.includes('sk-'));
    assert.ok(!rawBody.includes('api_key'));
  });

  it('reports llmConfigured as false when LLM_API_KEY is not set', async () => {
    const origKey = process.env.LLM_API_KEY;
    const origOpenAI = process.env.OPENAI_API_KEY;
    try {
      delete process.env.LLM_API_KEY;
      delete process.env.OPENAI_API_KEY;

      const res = await fetch(`${baseUrl}/agent/health`);
      const json = await res.json();
      assert.equal(json.llmConfigured, false);
      assert.equal(json.toolCallingProbe, false);
    } finally {
      if (origKey !== undefined) process.env.LLM_API_KEY = origKey;
      if (origOpenAI !== undefined) process.env.OPENAI_API_KEY = origOpenAI;
    }
  });

  it('exposes modelCalls counter from server', async () => {
    resetModelCallCount();
    const res = await fetch(`${baseUrl}/agent/health`);
    const json = await res.json();
    assert.equal(json.modelCalls, 0);
  });
});
