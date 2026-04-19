import assert from 'node:assert/strict';

import {
  buildAgentProbeConfig,
  buildCandidate,
  buildPortAttemptList,
  waitForAgentConnected,
} from './probe_latest_vpngate_relays.mjs';

async function runTests() {
  const results = [];
  const test = async (name, fn) => {
    await fn();
    results.push(name);
  };

  await test('buildPortAttemptList keeps selected first and deduplicates', async () => {
    const attempts = buildPortAttemptList([465, 995, 995, 1195, 9008], [443, 995, 465], 1195);
    assert.deepEqual(attempts, [1195, 995, 465, 9008]);
  });

  await test('buildCandidate keeps fallback port attempts', async () => {
    const candidate = buildCandidate({
      ID: 123,
      IP: '121.138.132.127',
      Fqdn: 'vpn204414021.opengw.net',
      HostUniqueKey: 'ABCDEF0123456789ABCDEF0123456789ABCDEF01',
      CountryShort: 'KR',
      CountryFull: 'Korea Republic of',
      Score: 100,
      VerifyDate: 200,
      SslPorts: '465 995 1195 9008',
    }, ['KR'], [443, 995, 1698]);

    assert.equal(candidate?.selectedSslPort, 995);
    assert.deepEqual(candidate?.portAttempts, [995, 465, 1195, 9008]);
  });

  await test('buildAgentProbeConfig passes selected port and sslPorts together', async () => {
    const config = buildAgentProbeConfig({
      agentBaseUrl: 'http://127.0.0.1:8765',
    }, {
      id: 'relay-1',
      ip: '121.138.132.127',
      fqdn: 'vpn204414021.opengw.net',
      selectedSslPort: 995,
      portAttempts: [995, 465, 1195, 9008],
      hostUniqueKey: 'ABCDEF0123456789ABCDEF0123456789ABCDEF01',
    });

    assert.equal(config.selectedSslPort, 995);
    assert.deepEqual(config.relaySnapshot.sslPorts, [995, 465, 1195, 9008]);
  });

  await test('waitForAgentConnected resolves when connected appears', async () => {
    const statuses = [
      { phase: 'CONNECTING', operationId: 'op-1' },
      { phase: 'CONNECTED', operationId: 'op-1', activeAccountName: 'DCDSVPNGATE-test' },
    ];
    let callCount = 0;

    const status = await waitForAgentConnected({}, 1000, {
      operationId: 'op-1',
      pollIntervalMs: 1,
      statusFetcher: async () => statuses[callCount++] || statuses.at(-1),
    });

    assert.equal(status.phase, 'CONNECTED');
    assert.equal(callCount >= 2, true);
  });

  await test('waitForAgentConnected fails fast on error phase', async () => {
    const startedAt = Date.now();

    await assert.rejects(() => waitForAgentConnected({}, 5000, {
      operationId: 'op-1',
      pollIntervalMs: 1,
      statusFetcher: async () => ({
        phase: 'ERROR',
        operationId: 'op-1',
        lastErrorMessage: 'boom',
      }),
    }), /boom/);

    assert.equal((Date.now() - startedAt) < 1000, true);
  });

  await test('waitForAgentConnected fails fast when connect operation returns to idle', async () => {
    const statuses = [
      { phase: 'CONNECTING', operationId: 'op-1' },
      { phase: 'IDLE', operationId: '', lastErrorMessage: 'dropped' },
    ];
    let callCount = 0;
    const startedAt = Date.now();

    await assert.rejects(() => waitForAgentConnected({}, 5000, {
      operationId: 'op-1',
      pollIntervalMs: 1,
      statusFetcher: async () => statuses[callCount++] || statuses.at(-1),
    }), /dropped|IDLE로 복귀/);

    assert.equal((Date.now() - startedAt) < 1500, true);
    assert.equal(callCount >= 2, true);
  });

  console.log(`[self-hosted-vpn-probe] ${results.length}개 test 통과`);
}

await runTests();
