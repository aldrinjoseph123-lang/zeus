import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyRequest } from 'fastify';
import { describeWhere, geoFromHeaders, geoFromLookup, isPublicIp, visitorIp, whereFrom } from '../lib/whereFrom.js';

/**
 * Where a request came from. Behind Cloudflare the answer is on the request and costs
 * nothing; everywhere else it falls back to one external lookup, which must never be
 * asked about a private address and must never be able to hold up a sign-in.
 */
const req = (headers: Record<string, string>, ip = '10.0.0.5') => ({ headers, ip }) as unknown as FastifyRequest;
const stub = (body: unknown, ok = true) => (async () => new Response(JSON.stringify(body), { status: ok ? 200 : 500 })) as unknown as typeof fetch;

describe('where from: the address', () => {
  it('prefers Cloudflare\'s header, then the forwarded chain, then the socket', () => {
    assert.equal(visitorIp(req({ 'cf-connecting-ip': '94.207.1.1', 'x-forwarded-for': '172.18.0.1' })), '94.207.1.1');
    assert.equal(visitorIp(req({ 'x-forwarded-for': '94.207.2.2, 172.18.0.1' })), '94.207.2.2', 'the visitor is the first hop, not the proxy');
    assert.equal(visitorIp(req({})), '10.0.0.5', 'nothing in front: the socket it is');
  });

  it('knows a private address when it sees one', () => {
    for (const ip of ['127.0.0.1', '::1', '10.1.2.3', '192.168.1.9', '172.20.0.4', '169.254.1.1', 'fe80::1']) {
      assert.equal(isPublicIp(ip), false, ip);
    }
    for (const ip of ['94.207.1.1', '8.8.8.8', '172.15.0.1', '2001:db8::1']) {
      assert.equal(isPublicIp(ip), true, ip);
    }
  });
});

describe('where from: the place', () => {
  it('reads the visitor-location headers when Cloudflare adds them', () => {
    const geo = geoFromHeaders(req({ 'cf-ipcity': 'Dubai', 'cf-region': 'Dubai', 'cf-ipcountry': 'AE' }));
    assert.deepEqual(geo, { city: 'Dubai', region: 'Dubai', country: 'AE', isp: null });
  });

  it('treats Cloudflare\'s "do not know" and Tor markers as nothing', () => {
    assert.equal(geoFromHeaders(req({ 'cf-ipcountry': 'XX' })), null);
    assert.equal(geoFromHeaders(req({ 'cf-ipcountry': 'T1' })), null);
    assert.equal(geoFromHeaders(req({})), null, 'the toggle is off, or Cloudflare is not in front');
  });

  it('never asks a third party about a private address', async () => {
    let asked = false;
    const spy = (async () => { asked = true; return new Response('{}'); }) as unknown as typeof fetch;
    assert.equal(await geoFromLookup('192.168.1.20', spy), null);
    assert.equal(asked, false, 'nothing to learn, and nobody outside needs to hear about it');
  });

  it('falls back to the lookup, and shrugs when it fails', async () => {
    const looked = await geoFromLookup('94.207.1.1', stub({ city: 'Dubai', region: 'Dubai', country: 'AE', org: 'AS5384 Emirates Telecom' }));
    assert.deepEqual(looked, { city: 'Dubai', region: 'Dubai', country: 'AE', isp: 'AS5384 Emirates Telecom' });
    assert.equal(await geoFromLookup('94.207.1.1', stub({}, false)), null, 'a bad response is not a location');
    assert.equal(await geoFromLookup('94.207.1.1', (async () => { throw new Error('offline'); }) as unknown as typeof fetch), null);
  });

  it('combines both: headers place it, the lookup names the network', async () => {
    const w = await whereFrom(
      req({ 'cf-connecting-ip': '94.207.1.1', 'cf-ipcity': 'Dubai', 'cf-region': 'Dubai', 'cf-ipcountry': 'AE' }),
      stub({ city: 'Somewhere else', country: 'ZZ', org: 'AS5384 Emirates Telecom' }),
    );
    assert.deepEqual(w, { ip: '94.207.1.1', city: 'Dubai', region: 'Dubai', country: 'AE', isp: 'AS5384 Emirates Telecom' },
      'Cloudflare wins on place; the lookup only adds what it cannot say');
  });

  it('on the LAN, records the address and nothing it cannot know', async () => {
    let asked = false;
    const spy = (async () => { asked = true; return new Response('{}'); }) as unknown as typeof fetch;
    const w = await whereFrom(req({}, '192.168.1.45'), spy);
    assert.deepEqual(w, { ip: '192.168.1.45', city: null, region: null, country: null, isp: null });
    assert.equal(asked, false);
  });
});

describe('where from: how it reads', () => {
  it('says the place and the network, and falls back to the address', () => {
    assert.equal(describeWhere({ city: 'Dubai', region: 'Dubai', country: 'AE', isp: 'Emirates Telecom' }), 'Dubai, AE · Emirates Telecom',
      'the region is dropped when it only repeats the city');
    assert.equal(describeWhere({ city: 'Sharjah', region: 'Sharjah Emirate', country: 'AE', isp: null }), 'Sharjah, Sharjah Emirate, AE');
    assert.equal(describeWhere({ ip: '192.168.1.45' }), '192.168.1.45', 'nothing known: at least say the address');
    assert.equal(describeWhere({}), 'Unknown');
  });
});
