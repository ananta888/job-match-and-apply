import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { MemoryConfigStore } from './config-store.js';
import { isLoopbackHostHeader, isLoopbackOrigin, loopbackRequestRejection } from './loopback-request-guard.js';

describe('loopback request guard', () => {
  it.each(['127.0.0.1:3000', 'localhost:4201', 'LOCALHOST', '[::1]:3000', 'localhost'])('accepts loopback Host %s', (host) => {
    expect(isLoopbackHostHeader(host)).toBe(true);
  });

  it.each([
    'attacker.example:3000', '127.0.0.1.attacker.example', 'localhost.attacker.example',
    'localhost@attacker.example', '192.168.1.10:3000', '0.0.0.0:3000', '', 'exa mple',
  ])('rejects non-loopback Host %s', (host) => {
    expect(isLoopbackHostHeader(host)).toBe(false);
  });

  it.each(['http://localhost:4201', 'http://127.0.0.1:4201', 'https://[::1]:8443'])('accepts loopback Origin %s', (origin) => {
    expect(isLoopbackOrigin(origin)).toBe(true);
  });

  it.each(['http://attacker.example', 'null', 'file://', 'chrome-extension://abc', 'ws://localhost:4201', 'http://localhost.attacker.example'])(
    'rejects Origin %s', (origin) => {
      expect(isLoopbackOrigin(origin)).toBe(false);
    },
  );

  it('names the rejected header', () => {
    expect(loopbackRequestRejection(undefined, undefined)).toBe('host_missing');
    expect(loopbackRequestRejection('attacker.example', undefined)).toBe('host_not_loopback');
    expect(loopbackRequestRejection('127.0.0.1:3000', 'http://attacker.example')).toBe('origin_not_loopback');
    expect(loopbackRequestRejection('127.0.0.1:3000', undefined)).toBeUndefined();
    expect(loopbackRequestRejection('127.0.0.1:3000', 'http://localhost:4201')).toBeUndefined();
  });
});

describe('API DNS-rebinding protection', () => {
  const app = () => createApp(new MemoryConfigStore());

  it('serves local clients and the Angular dev origin', async () => {
    await request(app()).get('/api/config').expect(200);
    await request(app()).get('/api/config').set('Host', 'localhost:4201').set('Origin', 'http://localhost:4201').expect(200);
  });

  it('refuses a rebound attacker host before any data is returned', async () => {
    const response = await request(app()).get('/api/config').set('Host', 'attacker.example:3000').expect(403);
    expect(response.body).toMatchObject({ status: 403, category: 'authentication', errorCode: 'host_not_loopback' });
    expect(JSON.stringify(response.body)).not.toContain('searchProfile');
  });

  it('refuses state-changing requests and preflights from a foreign origin', async () => {
    await request(app()).post('/api/search-runs').set('Origin', 'http://attacker.example').send({}).expect(403);
    const preflight = await request(app()).options('/api/config')
      .set('Origin', 'http://attacker.example').set('Access-Control-Request-Method', 'PUT').expect(403);
    expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
  });
});
