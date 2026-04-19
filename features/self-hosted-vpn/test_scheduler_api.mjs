import assert from 'node:assert/strict';

import {
  activateCatalogRelay,
  connectVpn,
  disconnectVpn,
  getConfigValidationMessage,
  getEffectiveProfileId,
  getParallelProbeStatus,
  normalizeConfig,
  primeRawRelayCatalogNics,
  prepareRawRelayCatalog,
  startParallelProbe,
  stopParallelProbe,
} from './api.js';
import {
  PHASE,
  Scheduler,
  normalizeConfig as normalizeSchedulerConfig,
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
    assert.equal(config.connectionMode, 'softether_vpngate_raw');
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

  await test('scheduler raw-only normalizeConfig coerces legacy profile config', async () => {
    const config = normalizeSchedulerConfig({
      connectionMode: 'profile',
      profileId: 'legacy-profile',
      agentBaseUrl: 'http://127.0.0.1:8765',
    });
    assert.equal(config.connectionMode, 'softether_vpngate_raw');
    assert.equal(config.profileId, '');
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

  await test('profile validation explains switching mode when raw relay fields are filled', async () => {
    const message = getConfigValidationMessage({
      connectionMode: 'profile',
      relaySnapshot: { ip: '219.100.37.114' },
      selectedSslPort: 443,
    });
    assert.match(message, /연결 모드가 profile/);
    assert.match(message, /SoftEther VPNGate raw/);
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

  await test('scheduler explicit catalogEnabled false clears catalog mode', async () => {
    const scheduler = new Scheduler();
    scheduler.catalogEnabled = true;

    scheduler.applyAgentStatus({
      phase: 'IDLE',
      catalogEnabled: false,
    });

    assert.equal(scheduler.catalogEnabled, false);
    assert.equal(scheduler.isRunning, false);
  });

  await test('scheduler idle phase clears stale raw catalog cache', async () => {
    const scheduler = new Scheduler();
    scheduler.rawRelayCatalog = {
      phase: 'READY',
      startedAt: '2026-04-19T00:00:00.000Z',
      completedAt: '2026-04-19T00:00:02.000Z',
      sourceHostCount: 7,
      usableRelayCount: 4,
      request: {
        limit: 200,
        preferredCountries: ['KR', 'JP'],
        preferredPorts: [443, 995],
      },
      items: [
        {
          id: 'relay-1',
          ip: '121.142.148.62',
          selectedSslPort: 995,
          sslPorts: [995, 443],
          accountStatusKind: 'DISCONNECTED',
          nicName: 'VPN2',
        },
      ],
      logs: ['catalog prepared'],
    };

    scheduler.applyAgentStatus({
      phase: 'IDLE',
      catalogEnabled: false,
      rawRelayCatalog: {
        phase: 'READY',
        startedAt: '2026-04-19T00:00:00.000Z',
        usableRelayCount: 4,
        sourceHostCount: 7,
        items: [
          {
            id: 'relay-1',
            ip: '121.142.148.62',
            selectedSslPort: 995,
          },
        ],
      },
    });

    assert.equal(scheduler.rawRelayCatalog.phase, PHASE.IDLE);
    assert.equal(scheduler.rawRelayCatalog.sourceHostCount, 0);
    assert.equal(scheduler.rawRelayCatalog.usableRelayCount, 0);
    assert.equal(scheduler.rawRelayCatalog.items.length, 0);
    assert.deepEqual(scheduler.rawRelayCatalog.logs, ['catalog prepared']);
  });

  await test('idle refresh collapses stale raw catalog state from storage', async () => {
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
      getParallelProbeStatus: async () => {
        throw new Error('parallel down');
      },
    });
    scheduler.phase = PHASE.IDLE;
    scheduler.isRunning = false;
    scheduler.catalogEnabled = false;
    scheduler.rawRelayCatalog = {
      phase: 'PREPARING',
      startedAt: '2026-04-19T00:00:00.000Z',
      sourceHostCount: 11,
      usableRelayCount: 0,
      items: [
        {
          id: 'relay-2',
          ip: '219.100.37.114',
          selectedSslPort: 443,
        },
      ],
      logs: ['catalog still running?'],
    };
    scheduler.saveState = async () => {};

    await scheduler.refreshStatusFromAgent();

    assert.equal(scheduler.phase, PHASE.IDLE);
    assert.equal(scheduler.rawRelayCatalog.phase, PHASE.IDLE);
    assert.equal(scheduler.rawRelayCatalog.sourceHostCount, 0);
    assert.equal(scheduler.rawRelayCatalog.items.length, 0);
    assert.deepEqual(scheduler.rawRelayCatalog.logs, ['catalog still running?']);
  });

  await test('status response keeps agent healthy even when health endpoint times out', async () => {
    const scheduler = new Scheduler({
      getAgentHealth: async () => {
        throw new Error('health timeout');
      },
      getVpnStatus: async () => ({
        data: {
          phase: 'IDLE',
          catalogEnabled: false,
        },
      }),
      getVpnEgress: async () => ({
        data: {
          publicIp: '1.2.3.4',
          provider: 'ifconfig.me',
        },
      }),
      getParallelProbeStatus: async () => ({
        data: {
          phase: 'IDLE',
          isRunning: false,
        },
      }),
    });
    scheduler.saveState = async () => {};

    await scheduler.refreshStatusFromAgent();

    assert.equal(scheduler.agentReachable, true);
    assert.equal(scheduler.healthOk, true);
    assert.equal(scheduler.phase, PHASE.IDLE);
    assert.ok(scheduler.lastHealthAt);
    assert.equal(scheduler.lastErrorCode, '');
    assert.equal(scheduler.lastErrorMessage, '');
  });

  await test('loadState collapses stale raw catalog when scheduler is off', async () => {
    const originalChrome = global.chrome;
    global.chrome = {
      storage: {
        local: {
          get: async () => ({
            selfHostedVpnSchedulerState: {
              isRunning: false,
              phase: 'IDLE',
              catalogEnabled: false,
              healthOk: false,
              agentReachable: false,
              rawRelayCatalog: {
                phase: 'READY',
                startedAt: '2026-04-19T00:00:00.000Z',
                completedAt: '2026-04-19T00:00:02.000Z',
                sourceHostCount: 3,
                usableRelayCount: 2,
                items: [
                  {
                    id: 'relay-3',
                    ip: '121.138.132.127',
                    selectedSslPort: 995,
                  },
                ],
                logs: ['loaded from storage'],
              },
              parallelProbe: {},
              logs: [],
              config: {},
            },
          }),
        },
      },
    };

    try {
      const scheduler = new Scheduler();
      await scheduler.loadState();

      assert.equal(scheduler.rawRelayCatalog.phase, PHASE.IDLE);
      assert.equal(scheduler.rawRelayCatalog.sourceHostCount, 0);
      assert.equal(scheduler.rawRelayCatalog.usableRelayCount, 0);
      assert.equal(scheduler.rawRelayCatalog.items.length, 0);
      assert.deepEqual(scheduler.rawRelayCatalog.logs, ['loaded from storage']);
    } finally {
      global.chrome = originalChrome;
    }
  });

  await test('stop clears stale raw catalog when agent becomes unavailable', async () => {
    const scheduler = new Scheduler({
      disconnectVpn: async () => ({ accepted: true, data: {} }),
    });
    scheduler.saveState = async () => {};
    scheduler.phase = PHASE.READY;
    scheduler.isRunning = true;
    scheduler.catalogEnabled = true;
    scheduler.agentReachable = true;
    scheduler.rawRelayCatalog = {
      phase: 'READY',
      startedAt: '2026-04-19T00:00:00.000Z',
      completedAt: '2026-04-19T00:00:02.000Z',
      sourceHostCount: 5,
      usableRelayCount: 3,
      items: [
        {
          id: 'relay-4',
          ip: '219.100.37.114',
          selectedSslPort: 443,
        },
      ],
      logs: ['stop test'],
    };
    scheduler.refreshStatusFromAgent = async () => {
      scheduler.phase = PHASE.AGENT_UNAVAILABLE;
      scheduler.agentReachable = false;
      return scheduler.getStatus();
    };

    await scheduler.stop();

    assert.equal(scheduler.catalogEnabled, false);
    assert.equal(scheduler.isRunning, false);
    assert.equal(scheduler.rawRelayCatalog.phase, PHASE.IDLE);
    assert.equal(scheduler.rawRelayCatalog.items.length, 0);
    assert.deepEqual(scheduler.rawRelayCatalog.logs, ['stop test']);
  });

  await test('stop falls back to local off when disconnect request cannot reach agent', async () => {
    const scheduler = new Scheduler({
      disconnectVpn: async () => {
        throw new Error('local agent 요청 실패 - fetch failed');
      },
    });
    scheduler.saveState = async () => {};
    scheduler.phase = PHASE.CONNECTED;
    scheduler.isRunning = true;
    scheduler.catalogEnabled = true;
    scheduler.agentReachable = true;
    scheduler.activeProfileId = 'profile-a';
    scheduler.activeRelayIp = '121.142.148.62';
    scheduler.currentPublicIp = '121.142.148.62';
    scheduler.rawRelayCatalog = {
      phase: 'CONNECTED',
      startedAt: '2026-04-19T00:00:00.000Z',
      completedAt: '2026-04-19T00:00:02.000Z',
      sourceHostCount: 5,
      usableRelayCount: 3,
      items: [
        {
          id: 'relay-4',
          ip: '219.100.37.114',
          selectedSslPort: 443,
        },
      ],
      logs: ['disconnect failed test'],
    };

    await scheduler.stop();

    assert.equal(scheduler.phase, PHASE.IDLE);
    assert.equal(scheduler.isRunning, false);
    assert.equal(scheduler.catalogEnabled, false);
    assert.equal(scheduler.agentReachable, false);
    assert.equal(scheduler.activeProfileId, '');
    assert.equal(scheduler.activeRelayIp, '');
    assert.equal(scheduler.currentPublicIp, '');
    assert.equal(scheduler.lastErrorCode, '');
    assert.equal(scheduler.rawRelayCatalog.phase, PHASE.IDLE);
    assert.equal(scheduler.rawRelayCatalog.items.length, 0);
    assert.deepEqual(scheduler.rawRelayCatalog.logs, ['disconnect failed test']);
  });

  await test('scheduler raw start uses catalog prepare request', async () => {
    let prepareCalled = false;
    let connectCalled = false;
    let prepareBody = null;
    const scheduler = new Scheduler({
      prepareRawRelayCatalog: async (_config, options = {}) => {
        prepareCalled = true;
        prepareBody = options.body || null;
        return {
          accepted: true,
          data: {
            operationId: 'catalog-1',
            connectionMode: 'softether_vpngate_raw',
            rawRelayCatalog: {
              phase: 'PREPARING',
              sourceHostCount: 5,
              usableRelayCount: 3,
              items: [],
            },
          },
        };
      },
      connectVpn: async () => {
        connectCalled = true;
        return {
          accepted: true,
          data: { operationId: 'connect-1' },
        };
      },
    });
    scheduler.saveState = async () => {};
    scheduler.refreshStatusFromAgent = async () => scheduler.getStatus();
    scheduler.config = normalizeConfig({
      connectionMode: 'softether_vpngate_raw',
      agentBaseUrl: 'http://127.0.0.1:8765',
    });

    await scheduler.start();

    assert.equal(prepareCalled, true);
    assert.equal(connectCalled, false);
    assert.deepEqual(prepareBody, {
      limit: 200,
      logicalSlotCount: 200,
      requestedPhysicalNicCount: 200,
      connectConcurrency: 24,
      nicPrepareConcurrency: 8,
      verifyConcurrency: 1,
      experimentalMaxNicIndex: 200,
      statusPollIntervalMs: 1000,
      connectTimeoutMs: 45000,
      preferredCountries: ['KR', 'JP'],
      preferredPorts: [443, 995, 1698, 5555, 992, 1194],
    });
    assert.equal(scheduler.phase, PHASE.PREPARING);
    assert.equal(scheduler.catalogEnabled, true);
  });

  await test('scheduler raw start request failure leaves catalog disabled and error visible', async () => {
    const scheduler = new Scheduler({
      prepareRawRelayCatalog: async () => {
        throw new Error('agent down');
      },
    });
    scheduler.saveState = async () => {};
    scheduler.config = normalizeConfig({
      connectionMode: 'softether_vpngate_raw',
      agentBaseUrl: 'http://127.0.0.1:8765',
    });

    await assert.rejects(() => scheduler.start(), /agent down/);

    assert.equal(scheduler.catalogEnabled, false);
    assert.equal(scheduler.isRunning, false);
    assert.equal(scheduler.phase, PHASE.ERROR);
    assert.equal(scheduler.rawRelayCatalog.phase, PHASE.ERROR);
    assert.match(scheduler.rawRelayCatalog.lastErrorMessage, /agent down/);
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

  await test('scheduler default parallel probe is idle', async () => {
    const scheduler = new Scheduler();
    assert.equal(scheduler.getStatus().parallelProbe.phase, 'IDLE');
    assert.equal(scheduler.getStatus().parallelProbe.isRunning, false);
  });

  await test('scheduler start block reason includes parallel probe', async () => {
    const scheduler = new Scheduler();
    scheduler.parallelProbe = {
      isRunning: true,
      phase: 'COMPLETE',
      logs: [],
      slots: [],
    };
    assert.match(scheduler.getStartBlockReason(), /병렬 3슬롯 시험/);
  });

  await test('scheduler applies parallel probe status', async () => {
    const scheduler = new Scheduler();
    scheduler.applyParallelProbeStatus({
      isRunning: true,
      phase: 'VERIFYING',
      routeOwnerSlotId: 'slot-2',
      lastVerifiedPublicIp: '112.172.66.106',
      slots: [
        {
          slotId: 'slot-2',
          nicName: 'VPN3',
          phase: 'CONNECTED',
          relay: {
            ip: '121.142.148.62',
            selectedSslPort: 995,
          },
        },
      ],
    });

    assert.equal(scheduler.parallelProbe.phase, 'VERIFYING');
    assert.equal(scheduler.parallelProbe.routeOwnerSlotId, 'slot-2');
    assert.equal(scheduler.parallelProbe.slots[0].nicName, 'VPN3');
  });

  await test('scheduler catalog activate request failure returns to READY and keeps catalog', async () => {
    const scheduler = new Scheduler({
      activateCatalogRelay: async () => {
        throw new Error('connect rejected');
      },
    });
    scheduler.saveState = async () => {};
    scheduler.refreshStatusFromAgent = async () => scheduler.getStatus();
    scheduler.config = normalizeConfig({
      connectionMode: 'softether_vpngate_raw',
      agentBaseUrl: 'http://127.0.0.1:8765',
    });
    scheduler.phase = PHASE.READY;
    scheduler.catalogEnabled = true;
    scheduler.isRunning = true;
    scheduler.rawRelayCatalog = {
      phase: 'READY',
      startedAt: '2026-04-19T00:00:00.000Z',
      completedAt: '2026-04-19T00:00:01.000Z',
      sourceHostCount: 1,
      usableRelayCount: 1,
      lastErrorCode: '',
      lastErrorMessage: '',
      request: {
        limit: 200,
        preferredCountries: ['KR', 'JP'],
        preferredPorts: [443, 995],
      },
      items: [
        {
          id: 'relay-1',
          ip: '121.142.148.62',
          fqdn: '',
          selectedSslPort: 995,
          sslPorts: [995, 443],
          udpPort: 0,
          hostUniqueKey: '',
          accountName: 'DCDSVPNRAWCACHE-relay-1-995',
          accountStatusKind: 'DISCONNECTED',
          accountStatusText: 'Offline',
          nicName: 'VPN2',
          isActive: false,
        },
      ],
      logs: [],
    };

    await assert.rejects(() => scheduler.activateCatalogRelay({
      id: 'relay-1',
      ip: '121.142.148.62',
      selectedSslPort: 995,
      sslPorts: [995, 443],
      accountName: 'DCDSVPNRAWCACHE-relay-1-995',
      nicName: 'VPN2',
    }), /connect rejected/);

    assert.equal(scheduler.phase, PHASE.READY);
    assert.equal(scheduler.catalogEnabled, true);
    assert.equal(scheduler.isRunning, true);
    assert.equal(scheduler.activeRelayId, '');
    assert.equal(scheduler.rawRelayCatalog.items[0].isActive, false);
    assert.equal(scheduler.lastErrorCode, 'RAW_CATALOG_CONNECT_REQUEST_FAILED');
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
      getParallelProbeStatus: async () => {
        throw new Error('parallel down');
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

  await test('parallel probe status uses dedicated GET endpoint', async () => {
    const originalFetch = global.fetch;
    let requestedUrl = '';
    global.fetch = async (url) => {
      requestedUrl = String(url || '');
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ phase: 'COMPLETE', isRunning: true }),
      };
    };

    try {
      const response = await getParallelProbeStatus({});
      assert.equal(response.data.phase, 'COMPLETE');
      assert.match(requestedUrl, /\/v1\/vpn\/parallel-probe\/status$/);
    } finally {
      global.fetch = originalFetch;
    }
  });

  await test('parallel probe start uses dedicated POST endpoint', async () => {
    const originalFetch = global.fetch;
    let requestedUrl = '';
    global.fetch = async (url) => {
      requestedUrl = String(url || '');
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ accepted: true, phase: 'PREPARING' }),
      };
    };

    try {
      const response = await startParallelProbe({});
      assert.equal(response.accepted, true);
      assert.match(requestedUrl, /\/v1\/vpn\/parallel-probe\/start$/);
    } finally {
      global.fetch = originalFetch;
    }
  });

  await test('parallel probe stop uses dedicated POST endpoint', async () => {
    const originalFetch = global.fetch;
    let requestedUrl = '';
    global.fetch = async (url) => {
      requestedUrl = String(url || '');
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ accepted: true, phase: 'STOPPING' }),
      };
    };

    try {
      const response = await stopParallelProbe({});
      assert.equal(response.accepted, true);
      assert.match(requestedUrl, /\/v1\/vpn\/parallel-probe\/stop$/);
    } finally {
      global.fetch = originalFetch;
    }
  });

  await test('raw catalog prepare uses dedicated POST endpoint', async () => {
    const originalFetch = global.fetch;
    let requestedUrl = '';
    global.fetch = async (url) => {
      requestedUrl = String(url || '');
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ accepted: true, phase: 'PREPARING' }),
      };
    };

    try {
      const response = await prepareRawRelayCatalog({});
      assert.equal(response.accepted, true);
      assert.match(requestedUrl, /\/v1\/vpn\/catalog\/prepare$/);
    } finally {
      global.fetch = originalFetch;
    }
  });

  await test('raw catalog nic prime uses dedicated POST endpoint', async () => {
    const originalFetch = global.fetch;
    let requestedUrl = '';
    global.fetch = async (url) => {
      requestedUrl = String(url || '');
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ accepted: true, preparedNicCount: 200 }),
      };
    };

    try {
      const response = await primeRawRelayCatalogNics({});
      assert.equal(response.accepted, true);
      assert.match(requestedUrl, /\/v1\/vpn\/catalog\/prime-nics$/);
    } finally {
      global.fetch = originalFetch;
    }
  });

  await test('scheduler primeCatalogNics logs summarized result', async () => {
    const scheduler = new Scheduler({
      primeRawRelayCatalogNics: async () => ({
        accepted: true,
        data: {
          requestedPhysicalNicCount: 200,
          existingNicCount: 52,
          createdNicCount: 148,
          preparedNicCount: 200,
          remainingMissingCount: 0,
        },
      }),
    });
    scheduler.saveState = async () => {};

    const summary = await scheduler.primeCatalogNics();

    assert.equal(summary.preparedNicCount, 200);
    assert.equal(scheduler.phase, PHASE.IDLE);
    assert.equal(scheduler.isRunning, false);
    assert.match(scheduler.logs[0], /목표 200/);
    assert.match(scheduler.logs[0], /기존 52/);
    assert.match(scheduler.logs[0], /신규 148/);
    assert.match(scheduler.logs[1], /VPN1~200 준비 시작/);
  });

  await test('scheduler primeCatalogNics uses long timeout override', async () => {
    let observedTimeoutMs = 0;
    const scheduler = new Scheduler({
      primeRawRelayCatalogNics: async (_config, options = {}) => {
        observedTimeoutMs = Number(options.timeoutMs || 0);
        return {
          accepted: true,
          data: {
            requestedPhysicalNicCount: 200,
            existingNicCount: 52,
            createdNicCount: 148,
            preparedNicCount: 200,
            remainingMissingCount: 0,
          },
        };
      },
    });
    scheduler.saveState = async () => {};
    scheduler.config.actionTimeoutMs = 15000;

    await scheduler.primeCatalogNics();

    assert.equal(observedTimeoutMs, 10 * 60 * 1000);
  });

  await test('scheduler primeCatalogNics exposes start state while request is pending', async () => {
    let resolveRequest = () => {};
    const requestStarted = new Promise((resolve) => {
      resolveRequest = resolve;
    });
    let finishRequest = () => {};
    const requestFinished = new Promise((resolve) => {
      finishRequest = resolve;
    });
    const scheduler = new Scheduler({
      primeRawRelayCatalogNics: async () => {
        resolveRequest();
        await requestFinished;
        return {
          accepted: true,
          data: {
            requestedPhysicalNicCount: 200,
            existingNicCount: 10,
            createdNicCount: 190,
            preparedNicCount: 200,
            remainingMissingCount: 0,
          },
        };
      },
    });
    scheduler.saveState = async () => {};

    const work = scheduler.primeCatalogNics();
    await requestStarted;

    assert.equal(scheduler.phase, PHASE.PREPARING);
    assert.equal(scheduler.isRunning, true);
    assert.match(scheduler.logs[0], /VPN1~200 준비 시작/);
    assert.match(scheduler.logs[0], /local agent 응답 대기 중/);

    finishRequest();
    await work;
  });

  await test('raw catalog activate uses dedicated POST endpoint', async () => {
    const originalFetch = global.fetch;
    let requestedUrl = '';
    let requestBody = null;
    global.fetch = async (url, init = {}) => {
      requestedUrl = String(url || '');
      requestBody = JSON.parse(String(init.body || '{}'));
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ accepted: true, phase: 'CONNECTING' }),
      };
    };

    try {
      const response = await activateCatalogRelay({}, {
        id: 'relay-1',
        ip: '121.142.148.62',
        selectedSslPort: 995,
        sslPorts: [995, 443],
      });
      assert.equal(response.accepted, true);
      assert.match(requestedUrl, /\/v1\/vpn\/catalog\/activate$/);
      assert.equal(requestBody.relay.id, 'relay-1');
      assert.equal(requestBody.relay.ip, '121.142.148.62');
      assert.equal(requestBody.relay.selectedSslPort, 995);
    } finally {
      global.fetch = originalFetch;
    }
  });

  console.log(`[self-hosted-vpn] ${results.length}개 api/scheduler test 통과`);
}

await runTests();
