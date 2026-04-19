import assert from 'node:assert/strict';

import {
  connectVpn,
  disconnectVpn,
  getConfigValidationMessage,
  getEffectiveProfileId,
  normalizeConfig,
} from './api.js';
import {
  PHASE,
  Scheduler,
} from './scheduler.js';

async function runTests() {
  const results = [];
  const test = async (name, fn) => {
    await fn();
    results.push(name);
  };

  await test('normalizeConfig keeps localhost default', async () => {
    const config = normalizeConfig({});
    assert.equal(config.agentBaseUrl, 'http://127.0.0.1:8765');
    assert.equal(config.requestTimeoutMs, 3000);
    assert.equal(config.actionTimeoutMs, 15000);
  });

  await test('normalizeConfig lifts too-small stored timeout values', async () => {
    const config = normalizeConfig({
      requestTimeoutMs: 800,
      actionTimeoutMs: 3000,
    });
    assert.equal(config.requestTimeoutMs, 3000);
    assert.equal(config.actionTimeoutMs, 15000);
  });

  await test('effective raw profile id uses selected relay id', async () => {
    const profileId = getEffectiveProfileId({
      connectionMode: 'softether_vpngate_raw',
      selectedRelayId: 'relay-1',
      selectedSslPort: 443,
    });
    assert.equal(profileId, 'vpngate-relay-1-443');
  });

  await test('raw config validation rejects missing host', async () => {
    const message = getConfigValidationMessage({
      connectionMode: 'softether_vpngate_raw',
      selectedSslPort: 443,
    });
    assert.match(message, /IP 또는 FQDN/);
  });

  await test('raw config validation rejects missing port', async () => {
    const message = getConfigValidationMessage({
      connectionMode: 'softether_vpngate_raw',
      relaySnapshot: { ip: '219.100.37.114' },
    });
    assert.match(message, /SSL 포트/);
  });

  await test('normalizeConfig keeps selected SSL port first in relay sslPorts', async () => {
    const config = normalizeConfig({
      connectionMode: 'softether_vpngate_raw',
      selectedSslPort: 995,
      relaySnapshot: {
        ip: '219.100.37.114',
        sslPorts: [465, 995, 1195, 9008],
      },
    });
    assert.deepEqual(config.relaySnapshot.sslPorts, [995, 465, 1195, 9008]);
  });

  await test('scheduler connected phase keeps running true', async () => {
    const scheduler = new Scheduler();
    scheduler.applyAgentStatus({
      phase: 'CONNECTED',
      profileId: 'profile-a',
      activeAdapterName: 'VPN2',
    });
    assert.equal(scheduler.phase, PHASE.CONNECTED);
    assert.equal(scheduler.isRunning, true);
    assert.equal(scheduler.activeAdapterName, 'VPN2');
  });

  await test('scheduler idle phase clears relay fields', async () => {
    const scheduler = new Scheduler();
    scheduler.activeRelayId = 'relay-a';
    scheduler.activeRelayIp = '219.100.37.114';
    scheduler.activeRelayFqdn = 'public-vpn-142.opengw.net';
    scheduler.activeSelectedSslPort = 443;

    scheduler.applyAgentStatus({ phase: 'IDLE' });

    assert.equal(scheduler.activeRelayId, '');
    assert.equal(scheduler.activeRelayIp, '');
    assert.equal(scheduler.activeRelayFqdn, '');
    assert.equal(scheduler.activeSelectedSslPort, 0);
  });

  await test('scheduler preserves adapter while connecting without adapter payload', async () => {
    const scheduler = new Scheduler();
    scheduler.activeAdapterName = 'VPN2';

    scheduler.applyAgentStatus({ phase: 'CONNECTING' });

    assert.equal(scheduler.activeAdapterName, 'VPN2');
  });

  await test('scheduler clears error on connected state without new error', async () => {
    const scheduler = new Scheduler();
    scheduler.lastErrorCode = 'OLD_CODE';
    scheduler.lastErrorMessage = 'old message';

    scheduler.applyAgentStatus({ phase: 'CONNECTED' });

    assert.equal(scheduler.lastErrorCode, '');
    assert.equal(scheduler.lastErrorMessage, '');
  });

  await test('scheduler keeps explicit error fields', async () => {
    const scheduler = new Scheduler();

    scheduler.applyAgentStatus({
      phase: 'ERROR',
      lastErrorCode: 'RAW_CONNECT_FAILED',
      lastErrorMessage: 'boom',
    });

    assert.equal(scheduler.lastErrorCode, 'RAW_CONNECT_FAILED');
    assert.equal(scheduler.lastErrorMessage, 'boom');
  });

  await test('scheduler infers raw relay from nested relay payload', async () => {
    const scheduler = new Scheduler();

    scheduler.applyAgentStatus({
      phase: 'CONNECTED',
      relay: {
        id: 'relay-r1',
        ip: '219.100.37.114',
        fqdn: 'public-vpn-142.opengw.net',
        selectedSslPort: 443,
      },
    });

    assert.equal(scheduler.activeRelayId, 'relay-r1');
    assert.equal(scheduler.activeRelayIp, '219.100.37.114');
    assert.equal(scheduler.activeSelectedSslPort, 443);
  });

  await test('idle status refresh suppresses unavailable noise', async () => {
    const scheduler = new Scheduler({
      getAgentHealth: async () => {
        throw new Error('health down');
      },
      getVpnStatus: async () => {
        throw new Error('status down');
      },
      getVpnEgress: async () => {
        throw new Error('egress down');
      },
    });
    scheduler.phase = PHASE.IDLE;
    scheduler.isRunning = false;
    scheduler.lastErrorCode = 'OLD';
    scheduler.lastErrorMessage = 'old';
    scheduler.saveState = async () => {};

    await scheduler.refreshStatusFromAgent();

    assert.equal(scheduler.phase, PHASE.IDLE);
    assert.equal(scheduler.lastErrorCode, '');
    assert.equal(scheduler.lastErrorMessage, '');
  });

  await test('connectVpn returns accepted payload on 200', async () => {
    const originalFetch = global.fetch;
    let requestBody = null;
    global.fetch = async (_url, init = {}) => {
      requestBody = JSON.parse(String(init.body || '{}'));
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ accepted: true, operationId: 'op-1' }),
      };
    };

    try {
      const response = await connectVpn({
        connectionMode: 'softether_vpngate_raw',
        relaySnapshot: { ip: '219.100.37.114', sslPorts: [465, 995, 9008] },
        selectedSslPort: 443,
      });
      assert.equal(response.accepted, true);
      assert.equal(response.data.operationId, 'op-1');
      assert.deepEqual(requestBody.relay.sslPorts, [443, 465, 995, 9008]);
    } finally {
      global.fetch = originalFetch;
    }
  });

  await test('disconnectVpn surfaces HTTP error body', async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => ({
      ok: false,
      status: 409,
      text: async () => JSON.stringify({ message: 'conflict' }),
    });

    try {
      await assert.rejects(() => disconnectVpn({}), /HTTP 409/);
    } finally {
      global.fetch = originalFetch;
    }
  });

  console.log(`[self-hosted-vpn] ${results.length}개 api/scheduler test 통과`);
}

await runTests();
