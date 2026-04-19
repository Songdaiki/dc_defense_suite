import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

import {
  buildCompatibilityProfileId,
  buildPublicParallelProbeState,
  buildPublicRawRelayCatalogState,
  CONNECTION_MODE,
  extractTokenFromRequest,
  normalizeParallelProbeRequest,
  normalizeConnectRequest,
  normalizeRawRelayCatalogPrepareRequest,
  normalizeConnectionMode,
  PARALLEL_PROBE_PHASE,
  SelfHostedVpnAgent,
} from './server.mjs';
import {
  buildRelayCatalog,
  fetchOfficialVpnGateRelayCatalog,
  fetchOfficialVpnGateRelays,
} from './lib/vpngate_feed.mjs';
import {
  buildDnsSignature,
  buildRouteKey,
  compareBaseline,
  ensureArray,
  normalizeRoute,
} from './lib/network_state.mjs';
import {
  SoftEtherCli,
  buildRawCatalogAccountName,
  buildSoftEtherNicCandidateList,
  buildSoftEtherNicName,
  classifyAccountListStatus,
  classifySessionStatus,
  extractCsvText,
  isManagedAccountName,
  isRawCatalogAccountName,
  isSoftEtherNicName,
  normalizePreferredSoftEtherNicName,
  parseAccountListServerEndpoint,
  parseCsvLine,
  parseCsvTable,
  parseKeyValueTable,
  sanitizeManagedToken,
} from './lib/softether_cli.mjs';

async function runTests() {
  const results = [];
  const test = async (name, fn) => {
    await fn();
    results.push(name);
  };

  await test('mode profile default', () => {
    assert.equal(normalizeConnectionMode(''), CONNECTION_MODE.PROFILE);
  });
  await test('mode raw explicit', () => {
    assert.equal(normalizeConnectionMode('softether_vpngate_raw'), CONNECTION_MODE.SOFTETHER_VPNGATE_RAW);
  });
  await test('mode raw uppercase', () => {
    assert.equal(normalizeConnectionMode('SOFTETHER_VPNGATE_RAW'), CONNECTION_MODE.SOFTETHER_VPNGATE_RAW);
  });
  await test('mode unknown fallback', () => {
    assert.equal(normalizeConnectionMode('abc'), CONNECTION_MODE.PROFILE);
  });

  await test('profile request keeps profile id', () => {
    const request = normalizeConnectRequest({ mode: 'profile', profileId: 'abc' });
    assert.equal(request.profileId, 'abc');
  });
  await test('profile request without id fails', () => {
    assert.throws(() => normalizeConnectRequest({ mode: 'profile' }), /profileId/);
  });
  await test('profile request with quote fails', () => {
    assert.throws(() => normalizeConnectRequest({ mode: 'profile', profileId: 'a"b' }), /큰따옴표/);
  });
  await test('raw request ip only', () => {
    const request = normalizeConnectRequest({
      mode: 'softether_vpngate_raw',
      relay: {
        ip: '121.138.132.127',
        selectedSslPort: 1698,
      },
    });
    assert.equal(request.relay.ip, '121.138.132.127');
    assert.equal(request.profileId, 'vpngate-121-138-132-127-1698');
  });
  await test('raw request fqdn fallback', () => {
    const request = normalizeConnectRequest({
      mode: 'softether_vpngate_raw',
      relay: {
        fqdn: 'vpn204414021.opengw.net',
        selectedSslPort: 1698,
      },
    });
    assert.equal(request.relay.fqdn, 'vpn204414021.opengw.net');
  });
  await test('raw request keeps relay id stringified', () => {
    const request = normalizeConnectRequest({
      mode: 'softether_vpngate_raw',
      relay: {
        id: 18786933,
        ip: '121.138.132.127',
        selectedSslPort: 1698,
      },
    });
    assert.equal(request.relay.id, '18786933');
  });
  await test('raw request keeps sslPorts with selected port first', () => {
    const request = normalizeConnectRequest({
      mode: 'softether_vpngate_raw',
      relay: {
        ip: '121.138.132.127',
        selectedSslPort: 995,
        sslPorts: [465, 995, 1195, 9008],
      },
    });
    assert.deepEqual(request.relay.sslPorts, [995, 465, 1195, 9008]);
  });
  await test('raw request missing host fails', () => {
    assert.throws(() => normalizeConnectRequest({
      mode: 'softether_vpngate_raw',
      relay: { selectedSslPort: 1698 },
    }), /relay\.ip/);
  });
  await test('raw request missing port fails', () => {
    assert.throws(() => normalizeConnectRequest({
      mode: 'softether_vpngate_raw',
      relay: { ip: '121.138.132.127' },
    }), /selectedSslPort/);
  });
  await test('raw request invalid port fails', () => {
    assert.throws(() => normalizeConnectRequest({
      mode: 'softether_vpngate_raw',
      relay: { ip: '121.138.132.127', selectedSslPort: 0 },
    }), /selectedSslPort/);
  });
  await test('compat profile id sanitizes relay token', () => {
    assert.equal(buildCompatibilityProfileId('vpn 2044', 1698), 'vpngate-vpn-2044-1698');
  });

  await test('parallel probe request defaults to 3 slots', () => {
    const request = normalizeParallelProbeRequest({});
    assert.equal(request.limit, 3);
    assert.deepEqual(request.slotNicNames, ['VPN2', 'VPN3', 'VPN4']);
  });

  await test('parallel probe request normalizes explicit raw relays', () => {
    const request = normalizeParallelProbeRequest({
      relays: [
        {
          ip: '121.138.132.127',
          selectedSslPort: 1698,
          countryShort: 'kr',
        },
      ],
    });
    assert.equal(request.relays[0].ip, '121.138.132.127');
    assert.equal(request.relays[0].selectedSslPort, 1698);
    assert.equal(request.relays[0].countryShort, 'KR');
  });

  await test('raw catalog prepare request defaults to 200 relays', () => {
    const request = normalizeRawRelayCatalogPrepareRequest({});
    assert.equal(request.limit, 200);
    assert.equal(request.logicalSlotCount, 200);
    assert.equal(request.requestedPhysicalNicCount, 200);
    assert.equal(request.connectConcurrency, 24);
    assert.equal(request.nicPrepareConcurrency, 8);
    assert.equal(request.verifyConcurrency, 1);
    assert.equal(request.experimentalMaxNicIndex, 200);
    assert.equal(request.statusPollIntervalMs, 1000);
    assert.equal(request.connectTimeoutMs, 45000);
    assert.deepEqual(request.preferredCountries, ['KR', 'JP']);
    assert.ok(request.preferredPorts.includes(443));
  });

  await test('raw catalog public state derives usable counts from verified slots and keeps item fields', () => {
    const publicState = buildPublicRawRelayCatalogState({
      phase: 'READY',
      stage: 'READY',
      sourceHostCount: 12,
      logicalSlotCount: 200,
      requestedPhysicalNicCount: 200,
      preparedNicCount: 126,
      connectAttemptedCount: 126,
      capacityDeferredSlotCount: 74,
      items: [
        {
          slotId: 'slot-1',
          id: 'relay-1',
          ip: '121.142.148.62',
          selectedSslPort: 995,
          accountName: 'DCDSVPNRAWCACHE-slot-1',
          preferredNicName: 'VPN3',
          accountStatusKind: 'CONNECTED',
          poolState: 'VERIFIED',
          isActive: false,
        },
      ],
      logs: ['prepared'],
    }, {
      activeAccountName: '',
    });
    assert.equal(publicState.phase, 'READY');
    assert.equal(publicState.stage, 'READY');
    assert.equal(publicState.usableRelayCount, 1);
    assert.equal(publicState.logicalSlotCount, 200);
    assert.equal(publicState.preparedNicCount, 1);
    assert.equal(publicState.connectAttemptedCount, 0);
    assert.equal(publicState.capacityDeferredSlotCount, 0);
    assert.equal(publicState.items[0].id, 'relay-1');
    assert.equal(publicState.items[0].selectedSslPort, 995);
    assert.equal(publicState.items[0].preferredNicName, 'VPN3');
    assert.equal(publicState.items[0].accountStatusKind, 'CONNECTED');
    assert.equal(publicState.items[0].poolState, 'VERIFIED');
  });

  await test('agent getStatus collapses stale raw catalog when catalog is off', async () => {
    const agent = new SelfHostedVpnAgent({ stateFile: 'memory-state.json' });
    agent.refreshState = async () => agent.state;
    agent.state.phase = 'IDLE';
    agent.state.catalogEnabled = false;
    agent.state.accountName = '';
    agent.state.rawRelayCatalog = {
      phase: 'PREPARING',
      startedAt: '2026-04-19T00:00:00.000Z',
      sourceHostCount: 12,
      usableRelayCount: 5,
      items: [
        {
          id: 'relay-1',
          ip: '121.142.148.62',
          selectedSslPort: 995,
          accountName: 'DCDSVPNRAWCACHE-relay-1-995',
        },
      ],
      logs: ['prepare started'],
    };

    const status = await agent.getStatus();

    assert.equal(status.phase, 'IDLE');
    assert.equal(status.rawRelayCatalog.phase, 'IDLE');
    assert.equal(status.rawRelayCatalog.sourceHostCount, 0);
    assert.equal(status.rawRelayCatalog.usableRelayCount, 0);
    assert.equal(status.rawRelayCatalog.items.length, 0);
    assert.deepEqual(status.rawRelayCatalog.logs, ['prepare started']);
  });

  await test('agent refreshState recovers abandoned raw PREPARING state after restart', async () => {
    const agent = new SelfHostedVpnAgent({ stateFile: 'memory-state.json' });
    let restoredMetricCount = 0;
    let cleanedAccountCount = 0;
    let routeSnapshotCount = 0;

    agent.softEtherCli = {
      listAccounts: async () => [],
      listNics: async () => [],
    };
    agent.restoreRawRelayCatalogMetrics = async () => {
      restoredMetricCount += 1;
    };
    agent.cleanupAllRawCatalogAccounts = async () => {
      cleanedAccountCount += 1;
    };
    agent.refreshRawRelayCatalogRouteSnapshot = async () => {
      routeSnapshotCount += 1;
    };
    agent.saveState = async () => {};
    agent.state.phase = 'PREPARING';
    agent.state.catalogEnabled = true;
    agent.state.connectionMode = CONNECTION_MODE.SOFTETHER_VPNGATE_RAW;
    agent.state.operationId = 'catalog-test';
    agent.state.rawRelayCatalog = {
      phase: 'PREPARING',
      stage: 'CONNECTING_SLOTS',
      startedAt: '2026-04-19T00:00:00.000Z',
      sourceHostCount: 12,
      usableRelayCount: 4,
      requestedCandidateCount: 12,
      logicalSlotCount: 4,
      requestedPhysicalNicCount: 4,
      items: [
        {
          id: 'relay-1',
          slotId: 'slot-001',
          ip: '121.142.148.62',
          selectedSslPort: 995,
          accountName: 'DCDSVPNRAWCACHE-slot-001',
          poolState: 'CONNECTING',
          accountStatusKind: 'MISSING',
        },
      ],
      logs: ['prepare started'],
    };

    await agent.refreshState({ force: true, includeNetwork: false });

    assert.equal(routeSnapshotCount, 1);
    assert.equal(restoredMetricCount, 1);
    assert.equal(cleanedAccountCount, 1);
    assert.equal(agent.state.phase, 'IDLE');
    assert.equal(agent.state.catalogEnabled, false);
    assert.equal(agent.state.operationId, '');
    assert.equal(agent.state.connectionMode, CONNECTION_MODE.PROFILE);
    assert.equal(agent.state.rawRelayCatalog.phase, 'IDLE');
    assert.equal(agent.state.rawRelayCatalog.stage, 'IDLE');
    assert.equal(agent.state.rawRelayCatalog.items.length, 0);
    assert.match(agent.state.rawRelayCatalog.logs[0], /agent 재시작으로 이전 raw 준비 상태가 중간에 끊겨 정리 후 IDLE로 복구했습니다/);
    assert.match(agent.state.rawRelayCatalog.logs[1], /prepare started/);
  });

  await test('transitionToIdle clears stale raw catalog state', async () => {
    const agent = new SelfHostedVpnAgent({ stateFile: 'memory-state.json' });
    agent.saveState = async () => {};
    agent.state.catalogEnabled = false;
    agent.state.accountName = '';
    agent.state.rawRelayCatalog = {
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
          accountName: 'DCDSVPNRAWCACHE-relay-3-995',
        },
      ],
      logs: ['catalog ready'],
    };

    await agent.transitionToIdle();

    assert.equal(agent.state.rawRelayCatalog.phase, 'IDLE');
    assert.equal(agent.state.rawRelayCatalog.sourceHostCount, 0);
    assert.equal(agent.state.rawRelayCatalog.usableRelayCount, 0);
    assert.equal(agent.state.rawRelayCatalog.items.length, 0);
    assert.deepEqual(agent.state.rawRelayCatalog.logs, ['catalog ready']);
  });

  await test('agent getHealth stays lightweight and avoids vpncmd probe', async () => {
    const agent = new SelfHostedVpnAgent({ stateFile: 'memory-state.json' });
    let probeCallCount = 0;
    agent.softEtherCli = {
      vpncmdPath: 'C:\\Program Files\\SoftEther VPN Client\\vpncmd.exe',
      isAvailable: async () => true,
      probeClient: async () => {
        probeCallCount += 1;
        throw new Error('probeClient should not run in health check');
      },
    };

    const health = await agent.getHealth();
    const cachedHealth = await agent.getHealth();

    assert.equal(health.ok, true);
    assert.equal(health.softEtherReady, true);
    assert.equal(cachedHealth.ok, true);
    assert.equal(probeCallCount, 0);
  });

  await test('relay catalog keeps full usable count and sorts preferred candidates before slicing', () => {
    const catalog = buildRelayCatalog([
      {
        ID: 'slow-us',
        IP: '10.0.0.3',
        Fqdn: 'slow-us.example',
        CountryShort: 'US',
        CountryFull: 'United States',
        SslPorts: '443 995',
        Score: 1,
        VerifyDate: 100,
      },
      {
        ID: 'kr-fast',
        IP: '10.0.0.1',
        Fqdn: 'kr-fast.example',
        CountryShort: 'KR',
        CountryFull: 'Korea Republic of',
        SslPorts: '443 995',
        Score: 50,
        VerifyDate: 300,
      },
      {
        ID: 'jp-mid',
        IP: '10.0.0.2',
        Fqdn: 'jp-mid.example',
        CountryShort: 'JP',
        CountryFull: 'Japan',
        SslPorts: '995 443',
        Score: 20,
        VerifyDate: 200,
      },
    ], {
      limit: 2,
      preferredCountries: ['KR', 'JP'],
      preferredPorts: [443, 995],
    });

    assert.equal(catalog.totalHosts, 3);
    assert.equal(catalog.usableRelayCount, 3);
    assert.equal(catalog.relays.length, 2);
    assert.equal(catalog.relays[0].id, 'kr-fast');
    assert.equal(catalog.relays[1].id, 'jp-mid');
  });

  await test('parallel probe public state strips internal fields', () => {
    const publicState = buildPublicParallelProbeState({
      isRunning: true,
      operationId: 'probe-1',
      phase: PARALLEL_PROBE_PHASE.COMPLETE,
      request: {
        limit: 3,
      },
      lastVerifiedPublicIp: '112.172.66.106',
      slots: [
        {
          slotId: 'slot-1',
          nicName: 'VPN2',
          phase: 'CONNECTED',
        },
      ],
    });
    assert.equal(publicState.isRunning, true);
    assert.equal(publicState.phase, 'COMPLETE');
    assert.equal(publicState.lastVerifiedPublicIp, '112.172.66.106');
    assert.equal(Object.prototype.hasOwnProperty.call(publicState, 'operationId'), false);
  });

  await test('parallel probe start blocks when foreign SoftEther account is active', async () => {
    const agent = new SelfHostedVpnAgent({ stateFile: 'memory-state.json' });
    agent.saveState = async () => {};
    agent.refreshState = async () => {
      agent.state.accountRows = [
        {
          name: 'VPN Gate Connection',
          statusKind: 'CONNECTED',
        },
      ];
      return agent.state;
    };

    await assert.rejects(
      () => agent.startParallelProbe({}),
      /다른 연결이 살아 있습니다/,
    );
  });

  await test('catalog prepare blocks when multiple agent-owned accounts are already active', async () => {
    const agent = new SelfHostedVpnAgent({ stateFile: 'memory-state.json' });
    agent.saveState = async () => {};
    agent.refreshState = async () => {
      agent.state.accountRows = [
        { name: 'DCDSVPNRAWCACHE-relay-1-443', statusKind: 'CONNECTED' },
        { name: 'DCDSVPNGATE-relay-2-443-abc', statusKind: 'CONNECTED' },
      ];
      agent.state.accountName = '';
      agent.state.phase = 'ERROR';
      return agent.state;
    };

    await assert.rejects(
      () => agent.prepareRawRelayCatalog({}),
      /agent 관리용 SoftEther 연결이 이미 살아 있습니다/,
    );
  });

  await test('catalog activate blocks when multiple single-connection agent accounts are already active', async () => {
    const agent = new SelfHostedVpnAgent({ stateFile: 'memory-state.json' });
    agent.saveState = async () => {};
    agent.refreshState = async () => {
      agent.state.accountRows = [
        { name: 'DCDSVPNGATE-relay-1-443-abc', statusKind: 'CONNECTED' },
        { name: 'DCDSVPNGATE-relay-2-443-def', statusKind: 'CONNECTED' },
      ];
      agent.state.accountName = '';
      agent.state.phase = 'ERROR';
      agent.state.catalogEnabled = true;
      agent.state.rawRelayCatalog = {
        ...agent.state.rawRelayCatalog,
        items: [
          {
            slotId: 'slot-3',
            id: 'relay-3',
            ip: '121.138.132.127',
            fqdn: '',
            selectedSslPort: 1698,
            accountName: 'DCDSVPNRAWCACHE-slot-3',
            accountStatusKind: 'CONNECTED',
            poolState: 'VERIFIED',
          },
        ],
      };
      return agent.state;
    };

    await assert.rejects(
      () => agent.activateCatalogRelay({
        relay: {
          slotId: 'slot-3',
          id: 'relay-3',
          ip: '121.138.132.127',
          selectedSslPort: 1698,
        },
      }),
      /agent 관리용 SoftEther 연결이 이미 살아 있습니다/,
    );
  });

  await test('official DAT fetch abort surfaces timeout message', async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    };

    try {
      await assert.rejects(
        () => fetchOfficialVpnGateRelays({ limit: 1 }),
        /official DAT fetch timeout/,
      );
    } finally {
      global.fetch = originalFetch;
    }
  });

  await test('official relay catalog fetch abort surfaces timeout message', async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    };

    try {
      await assert.rejects(
        () => fetchOfficialVpnGateRelayCatalog({ limit: 1 }),
        /official DAT fetch timeout/,
      );
    } finally {
      global.fetch = originalFetch;
    }
  });

  await test('parallel probe route snapshot skips late writes after stop', async () => {
    const agent = new SelfHostedVpnAgent({ stateFile: 'memory-state.json' });
    agent.saveState = async () => {};
    agent.state.parallelProbe = {
      isRunning: true,
      operationId: 'probe-1',
      phase: PARALLEL_PROBE_PHASE.VERIFYING,
      routeOwnerSlotId: '',
      slots: [
        {
          slotId: 'slot-1',
          nicName: 'VPN2',
          phase: 'CONNECTED',
          interfaceAlias: '',
          interfaceIndex: 0,
          defaultRouteIfIndex: 0,
          routeReady: false,
          routeOwned: false,
          relay: {},
        },
      ],
      logs: [],
    };
    agent.networkObserver = {
      getLocalSnapshot: async () => {
        agent.state.parallelProbe.phase = PARALLEL_PROBE_PHASE.STOPPING;
        return {
          primaryIpv4Route: { ifIndex: 77 },
          ipConfigs: [{ InterfaceAlias: 'VPN2 - VPN Client', InterfaceIndex: 77 }],
          ipv4DefaultRoutes: [{ ifIndex: 77 }],
        };
      },
    };

    await agent.refreshParallelProbeRouteSnapshot({ operationId: 'probe-1' });

    assert.equal(agent.state.parallelProbe.routeOwnerSlotId, '');
    assert.equal(agent.state.parallelProbe.slots[0].interfaceIndex, 0);
    assert.equal(agent.state.parallelProbe.slots[0].routeOwned, false);
  });

  await test('parallel slot connect skips success log after stop transition', async () => {
    const agent = new SelfHostedVpnAgent({ stateFile: 'memory-state.json' });
    agent.saveState = async () => {};
    agent.ensureSpecificNic = async () => 'VPN2';
    agent.safeDeleteParallelProbeAccount = async () => {};
    agent.waitForNamedAccountConnected = async () => ({ name: 'probe-row', statusKind: 'CONNECTED' });
    agent.refreshParallelProbeRouteSnapshot = async () => {
      agent.state.parallelProbe.phase = PARALLEL_PROBE_PHASE.STOPPING;
    };
    agent.softEtherCli = {
      createAccount: async () => {},
      setAccountAnonymous: async () => {},
      setAccountRetry: async () => {},
      disableServerCertCheck: async () => {},
      setAccountDetails: async () => {},
      connectAccount: async () => {},
      getAccountStatus: async () => ({
        connectedAt: '2026-04-19T00:00:00.000Z',
        underlayProtocol: 'TCP',
        udpAccelerationActive: false,
      }),
    };
    agent.state.parallelProbe = {
      isRunning: true,
      operationId: 'probe-1',
      phase: PARALLEL_PROBE_PHASE.CONNECTING,
      routeOwnerSlotId: '',
      slots: [
        {
          slotId: 'slot-1',
          nicName: 'VPN2',
          phase: 'IDLE',
          accountName: '',
          connectedAt: '',
          lastVerifiedAt: '',
          routeOwned: false,
          routeReady: false,
          interfaceAlias: '',
          interfaceIndex: 0,
          defaultRouteIfIndex: 0,
          exitPublicIp: '',
          exitPublicIpProvider: '',
          lastErrorCode: '',
          lastErrorMessage: '',
          underlayProtocol: '',
          udpAccelerationActive: false,
          relay: {
            id: 'relay-1',
            ip: '121.138.132.127',
            fqdn: '',
            countryShort: 'KR',
            countryFull: 'Korea Republic of',
            selectedSslPort: 1698,
            udpPort: 0,
            hostUniqueKey: '',
          },
        },
      ],
      logs: [],
    };

    await agent.connectParallelProbeSlot('probe-1', 'slot-1');

    assert.equal(
      agent.state.parallelProbe.logs.some(entry => entry.includes('연결 성공')),
      false,
    );
  });

  await test('sanitize managed token strips symbols', () => {
    assert.equal(sanitizeManagedToken(' vpn#1 '), 'vpn-1');
  });
  await test('sanitize managed token fallback', () => {
    assert.equal(sanitizeManagedToken('***', 'relay'), 'relay');
  });
  await test('softether nic name VPN is valid', () => {
    assert.equal(isSoftEtherNicName('VPN'), true);
  });
  await test('softether nic name VPN2 is valid', () => {
    assert.equal(isSoftEtherNicName('VPN2'), true);
  });
  await test('softether nic name DCDSVPN is invalid', () => {
    assert.equal(isSoftEtherNicName('DCDSVPN'), false);
  });
  await test('softether nic builder maps 1 to VPN', () => {
    assert.equal(buildSoftEtherNicName(1), 'VPN');
  });
  await test('softether nic builder maps 2 to VPN2', () => {
    assert.equal(buildSoftEtherNicName(2), 'VPN2');
  });
  await test('preferred nic invalid falls back to VPN2', () => {
    assert.equal(normalizePreferredSoftEtherNicName('DCDSVPN'), 'VPN2');
  });
  await test('nic candidate list starts from preferred valid nic', () => {
    const candidates = buildSoftEtherNicCandidateList('VPN5');
    assert.equal(candidates[0], 'VPN5');
    assert.ok(candidates.includes('VPN2'));
    assert.ok(candidates.includes('VPN'));
  });
  await test('managed account prefix positive', () => {
    assert.equal(isManagedAccountName('DCDSVPNGATE-x-1'), true);
  });
  await test('managed account prefix negative', () => {
    assert.equal(isManagedAccountName('VPN Gate Connection'), false);
  });
  await test('raw catalog account prefix positive', () => {
    assert.equal(isRawCatalogAccountName('DCDSVPNRAWCACHE-relay-1-995'), true);
  });
  await test('raw catalog account name builder keeps relay id and port', () => {
    assert.equal(
      buildRawCatalogAccountName({ id: 'relay-1' }, 995),
      'DCDSVPNRAWCACHE-relay-1-995',
    );
  });

  await test('account status connected', () => {
    assert.equal(classifyAccountListStatus('Connected'), 'CONNECTED');
  });
  await test('account status connecting', () => {
    assert.equal(classifyAccountListStatus('Connecting'), 'CONNECTING');
  });
  await test('account status retrying', () => {
    assert.equal(classifyAccountListStatus('Retrying'), 'CONNECTING');
  });
  await test('account status disconnected', () => {
    assert.equal(classifyAccountListStatus('Disconnected'), 'DISCONNECTED');
  });
  await test('account status unknown', () => {
    assert.equal(classifyAccountListStatus('Idle?'), 'UNKNOWN');
  });

  await test('session status connected', () => {
    assert.equal(classifySessionStatus('Connection Completed (Session Established)'), 'CONNECTED');
  });
  await test('session status connecting', () => {
    assert.equal(classifySessionStatus('Now Connecting'), 'CONNECTING');
  });
  await test('session status error', () => {
    assert.equal(classifySessionStatus('Connection Error'), 'ERROR');
  });
  await test('session status unknown', () => {
    assert.equal(classifySessionStatus('Something Else'), 'UNKNOWN');
  });

  await test('csv line simple', () => {
    assert.deepEqual(parseCsvLine('a,b,c'), ['a', 'b', 'c']);
  });
  await test('csv line quoted comma', () => {
    assert.deepEqual(parseCsvLine('"a,b",c'), ['a,b', 'c']);
  });
  await test('csv line escaped quote', () => {
    assert.deepEqual(parseCsvLine('"a""b",c'), ['a"b', 'c']);
  });
  await test('extract csv text strips prelude', () => {
    const text = extractCsvText('Connected to VPN Client "localhost".\n\nA,B\n1,2\n');
    assert.equal(text, 'A,B\n1,2');
  });
  await test('parse csv table rows', () => {
    const rows = parseCsvTable('Header1,Header2\nx,y\n');
    assert.deepEqual(rows, [{ Header1: 'x', Header2: 'y' }]);
  });
  await test('parse key value table', () => {
    const map = parseKeyValueTable('Item,Value\nA,1\nB,2\n');
    assert.deepEqual(map, { A: '1', B: '2' });
  });
  await test('parse account list server endpoint ipv4', () => {
    assert.deepEqual(
      parseAccountListServerEndpoint('121.138.132.127:1698 (Direct TCP/IP Connection)'),
      {
        endpointText: '121.138.132.127:1698',
        host: '121.138.132.127',
        port: 1698,
      },
    );
  });
  await test('parse account list server endpoint ipv6', () => {
    assert.deepEqual(
      parseAccountListServerEndpoint('[2001:db8::1]:443 (Direct TCP/IP Connection)'),
      {
        endpointText: '[2001:db8::1]:443',
        host: '2001:db8::1',
        port: 443,
      },
    );
  });
  await test('parse account list server endpoint host only', () => {
    assert.deepEqual(
      parseAccountListServerEndpoint('vpn.example.com'),
      {
        endpointText: 'vpn.example.com',
        host: 'vpn.example.com',
        port: 0,
      },
    );
  });
  await test('account detail set fills all non-interactive parameters', async () => {
    const cli = new SoftEtherCli({
      vpncmdPath: '/tmp/fake-vpncmd.exe',
    });
    let executedCommand = [];
    cli.run = async (commandTokens) => {
      executedCommand = commandTokens;
      return { stdout: '', stderr: '' };
    };

    await cli.setAccountDetails('VPNTEST', {
      maxTcp: 1,
      additionalConnectionInterval: 1,
      connectionTtl: 0,
      halfDuplex: false,
      bridgeMode: false,
      monitorMode: false,
      noRoutingTracking: false,
      noQos: true,
    });

    assert.ok(executedCommand.includes('/TTL:0'));
    assert.ok(executedCommand.includes('/HALF:no'));
    assert.ok(executedCommand.includes('/BRIDGE:no'));
    assert.ok(executedCommand.includes('/MONITOR:no'));
    assert.ok(executedCommand.includes('/NOTRACK:no'));
    assert.ok(executedCommand.includes('/NOQOS:yes'));
  });
  await test('account create keeps name as separate vpncmd token', async () => {
    const cli = new SoftEtherCli({
      vpncmdPath: '/tmp/fake-vpncmd.exe',
    });
    let executedCommand = [];
    cli.run = async (commandTokens) => {
      executedCommand = commandTokens;
      return { stdout: '', stderr: '' };
    };

    await cli.createAccount({
      name: 'VPN Gate Connection',
      serverHost: '219.100.37.114',
      serverPort: 443,
      hubName: 'VPNGATE',
      username: 'VPN',
      nicName: 'VPN2',
    });

    assert.equal(executedCommand[0], 'AccountCreate');
    assert.equal(executedCommand[1], 'VPN Gate Connection');
    assert.ok(executedCommand.includes('/SERVER:219.100.37.114:443'));
  });

  await test('ensureArray preserves array', () => {
    assert.deepEqual(ensureArray([1, 2]), [1, 2]);
  });
  await test('ensureArray wraps object', () => {
    assert.deepEqual(ensureArray({ a: 1 }), [{ a: 1 }]);
  });
  await test('ensureArray empty for null', () => {
    assert.deepEqual(ensureArray(null), []);
  });
  await test('normalize route fields', () => {
    assert.deepEqual(normalizeRoute({
      ifIndex: '8',
      InterfaceAlias: 'VPN',
      NextHop: '0.0.0.0',
      RouteMetric: '3',
      InterfaceMetric: '10',
      DestinationPrefix: '0.0.0.0/0',
    }), {
      ifIndex: 8,
      interfaceAlias: 'VPN',
      nextHop: '0.0.0.0',
      routeMetric: 3,
      interfaceMetric: 10,
      destinationPrefix: '0.0.0.0/0',
    });
  });
  test('build route key stable', () => {
    const key = buildRouteKey({
      ifIndex: 8,
      interfaceAlias: 'VPN',
      nextHop: '0.0.0.0',
      routeMetric: 3,
      interfaceMetric: 10,
      destinationPrefix: '0.0.0.0/0',
    });
    assert.ok(key.includes('"interfaceAlias":"VPN"'));
  });
  await test('build dns signature sorts servers', () => {
    const signature = buildDnsSignature([{
      InterfaceAlias: 'VPN',
      InterfaceIndex: 8,
      DNSServer: {
        ServerAddresses: ['1.1.1.1', '8.8.8.8'],
      },
    }]);
    assert.ok(signature.includes('1.1.1.1'));
    assert.ok(signature.includes('8.8.8.8'));
  });
  await test('baseline diff ip and route change', () => {
    const diff = compareBaseline({
      publicIp: '1.1.1.1',
      ipv4DefaultRouteKey: 'A',
      ipv6DefaultRouteKey: 'B',
      dnsSignature: 'C',
    }, {
      ipv4DefaultRouteKey: 'X',
      ipv6DefaultRouteKey: 'B',
      dnsSignature: 'Y',
    }, {
      ip: '2.2.2.2',
      provider: 'api.ipify.org',
    });
    assert.equal(diff.publicIpBefore, '1.1.1.1');
    assert.equal(diff.publicIpAfter, '2.2.2.2');
    assert.equal(diff.ipv4DefaultRouteChanged, true);
    assert.equal(diff.ipv6DefaultRouteChanged, false);
    assert.equal(diff.dnsChanged, true);
  });

  await test('authorization bearer token wins', () => {
    const token = extractTokenFromRequest({
      headers: {
        authorization: 'Bearer abc',
        'x-defensesuite-token': 'zzz',
      },
    });
    assert.equal(token, 'abc');
  });
  await test('custom header token fallback', () => {
    const token = extractTokenFromRequest({
      headers: {
        'x-defensesuite-token': 'abc',
      },
    });
    assert.equal(token, 'abc');
  });
  await test('missing token empty string', () => {
    const token = extractTokenFromRequest({
      headers: {},
    });
    assert.equal(token, '');
  });

  await test('profile connect ignores requested busy profile', () => {
    const agent = new SelfHostedVpnAgent({
      stateFile: '/tmp/self-hosted-vpn-agent-test-profile.json',
    });
    const row = {
      name: 'VPN Gate Connection',
      statusKind: 'CONNECTED',
    };
    const conflict = agent.findForeignBusyAccount([row], {
      mode: CONNECTION_MODE.PROFILE,
      profileId: 'VPN Gate Connection',
    });
    assert.equal(conflict, null);
  });
  await test('profile connect still blocks other busy profile', () => {
    const agent = new SelfHostedVpnAgent({
      stateFile: '/tmp/self-hosted-vpn-agent-test-profile2.json',
    });
    const row = {
      name: 'Another Profile',
      statusKind: 'CONNECTED',
    };
    const conflict = agent.findForeignBusyAccount([row], {
      mode: CONNECTION_MODE.PROFILE,
      profileId: 'VPN Gate Connection',
    });
    assert.equal(conflict?.name, 'Another Profile');
  });
  await test('managed active account can be adopted after state loss', () => {
    const agent = new SelfHostedVpnAgent({
      stateFile: '/tmp/self-hosted-vpn-agent-test-adopt.json',
    });
    const row = {
      name: 'DCDSVPNGATE-relay-1698-abc',
      statusKind: 'CONNECTED',
      host: '121.138.132.127',
      port: 1698,
      nicName: 'DCDSVPN',
    };
    const tracked = agent.resolveTrackedAccount([row]);
    assert.equal(tracked?.name, row.name);
    agent.adoptTrackedAccount(row);
    assert.equal(agent.state.accountOwnership, 'managed_raw');
    assert.equal(agent.state.connectionMode, CONNECTION_MODE.SOFTETHER_VPNGATE_RAW);
    assert.equal(agent.state.activeRelayIp, '121.138.132.127');
    assert.equal(agent.state.activeSelectedSslPort, 1698);
    assert.equal(agent.state.profileId, 'vpngate-121-138-132-127-1698');
  });
  await test('ensureManagedNic uses existing regulated nic when configured name is invalid', async () => {
    const agent = new SelfHostedVpnAgent({
      managedNicName: 'DCDSVPN',
      stateFile: '/tmp/self-hosted-vpn-agent-test-nic-existing.json',
    });
    agent.softEtherCli.listNics = async () => ([
      { name: 'VPN', status: 'Enabled' },
      { name: 'VPN2', status: 'Enabled' },
    ]);
    agent.softEtherCli.createNic = async () => {
      throw new Error('should not create');
    };

    const nicName = await agent.ensureManagedNic();

    assert.equal(nicName, 'VPN2');
    assert.equal(agent.managedNicName, 'VPN2');
  });
  await test('ensureManagedNic creates regulated nic candidate when missing', async () => {
    const agent = new SelfHostedVpnAgent({
      managedNicName: 'DCDSVPN',
      stateFile: '/tmp/self-hosted-vpn-agent-test-nic-create.json',
    });
    let createdName = '';
    let created = false;
    agent.softEtherCli.listNics = async () => {
      if (!created) {
        return [{ name: 'VPN', status: 'Enabled' }];
      }
      return [
        { name: 'VPN', status: 'Enabled' },
        { name: 'VPN2', status: 'Enabled' },
      ];
    };
    agent.softEtherCli.createNic = async (nicName) => {
      createdName = nicName;
      created = true;
    };

    const nicName = await agent.ensureManagedNic();

    assert.equal(createdName, 'VPN2');
    assert.equal(nicName, 'VPN2');
    assert.equal(agent.managedNicName, 'VPN2');
  });
  await test('primeRawCatalogNics summarizes existing and newly created nic counts', async () => {
    const agent = new SelfHostedVpnAgent({
      managedNicName: 'DCDSVPN',
      stateFile: '/tmp/self-hosted-vpn-agent-test-prime-raw-nics.json',
    });
    let createdNames = [];
    let created = false;
    agent.refreshState = async () => {
      agent.state.phase = 'IDLE';
      agent.state.catalogEnabled = false;
      agent.state.parallelProbe = buildPublicParallelProbeState({ phase: 'IDLE', isRunning: false });
      return agent.state;
    };
    agent.statusCli.listNics = async () => {
      if (!created) {
        return [
          { name: 'VPN', status: 'Enabled' },
          { name: 'VPN2', status: 'Enabled' },
          { name: 'VPN3', status: 'Enabled' },
        ];
      }

      return [
        { name: 'VPN', status: 'Enabled' },
        { name: 'VPN2', status: 'Enabled' },
        { name: 'VPN3', status: 'Enabled' },
        { name: 'VPN4', status: 'Enabled' },
      ];
    };
    agent.createProvisionCli = () => ({
      createNic: async (nicName) => {
        createdNames.push(nicName);
        created = true;
      },
    });
    agent.saveState = async () => {};

    const result = await agent.primeRawCatalogNics({
      requestedPhysicalNicCount: 3,
      nicPrepareConcurrency: 3,
      experimentalMaxNicIndex: 4,
    });

    assert.equal(result.accepted, true);
    assert.equal(result.existingNicCount, 2);
    assert.equal(result.createdNicCount, 1);
    assert.equal(result.preparedNicCount, 3);
    assert.equal(result.remainingMissingCount, 0);
    assert.deepEqual(createdNames, ['VPN4']);
  });
  await test('multiple managed accounts are reported as conflicting', () => {
    const agent = new SelfHostedVpnAgent({
      stateFile: '/tmp/self-hosted-vpn-agent-test-managed.json',
    });
    const rows = [
      { name: 'DCDSVPNGATE-a', statusKind: 'CONNECTED' },
      { name: 'DCDSVPNGATE-b', statusKind: 'CONNECTING' },
    ];
    const conflicts = agent.findConflictingManagedBusyAccounts(rows);
    assert.equal(conflicts.length, 2);
  });
  await test('current managed account is not a conflicting managed account', () => {
    const agent = new SelfHostedVpnAgent({
      stateFile: '/tmp/self-hosted-vpn-agent-test-managed2.json',
    });
    agent.state.accountName = 'DCDSVPNGATE-a';
    const rows = [
      { name: 'DCDSVPNGATE-a', statusKind: 'CONNECTED' },
      { name: 'DCDSVPNGATE-b', statusKind: 'DISCONNECTED' },
    ];
    const conflicts = agent.findConflictingManagedBusyAccounts(rows);
    assert.equal(conflicts.length, 0);
  });
  await test('captureBaseline reuses only fresh cached local snapshot', async () => {
    const agent = new SelfHostedVpnAgent({
      stateFile: '/tmp/self-hosted-vpn-agent-test-baseline-fresh.json',
    });
    const cachedSnapshot = {
      observedAt: '2026-04-19T00:00:00.000Z',
      ipv4DefaultRouteKey: 'cached-ipv4',
      ipv6DefaultRouteKey: 'cached-ipv6',
      dnsSignature: 'cached-dns',
    };
    agent.networkObserver.localSnapshotCache = {
      observedAtMs: Date.now(),
      value: cachedSnapshot,
    };
    agent.networkObserver.getLocalSnapshot = async () => {
      throw new Error('fresh cache should be reused');
    };
    agent.networkObserver.getPublicIp = async () => ({
      ip: '1.2.3.4',
      provider: 'ifconfig.me',
    });

    const baseline = await agent.captureBaseline();

    assert.equal(baseline.observedAt, '2026-04-19T00:00:00.000Z');
    assert.equal(baseline.ipv4DefaultRouteKey, 'cached-ipv4');
    assert.equal(baseline.publicIp, '1.2.3.4');
  });
  await test('captureBaseline falls back to current state when connect baseline cache is missing', async () => {
    const agent = new SelfHostedVpnAgent({
      stateFile: '/tmp/self-hosted-vpn-agent-test-baseline-stale.json',
    });
    agent.state.currentPublicIp = '5.6.7.8';
    agent.state.publicIpProvider = 'api.ipify.org';
    let refreshAttempted = false;
    agent.networkObserver.getLocalSnapshot = async () => {
      refreshAttempted = true;
      return {
        observedAt: '2026-04-19T01:00:00.000Z',
        ipv4DefaultRouteKey: 'fresh-ipv4',
        ipv6DefaultRouteKey: 'fresh-ipv6',
        dnsSignature: 'fresh-dns',
      };
    };
    agent.networkObserver.getPublicIp = async () => {
      throw new Error('current state public ip should be reused');
    };

    const baseline = await agent.captureBaseline();

    assert.equal(refreshAttempted, true);
    assert.equal(baseline.publicIp, '5.6.7.8');
    assert.equal(baseline.ipv4DefaultRouteKey, '');
  });
  await test('captureBaseline reuses cached public ip within connect window', async () => {
    const agent = new SelfHostedVpnAgent({
      stateFile: '/tmp/self-hosted-vpn-agent-test-baseline-public-ip-cache.json',
    });
    agent.networkObserver.localSnapshotCache = {
      observedAtMs: Date.now(),
      value: {
        observedAt: '2026-04-19T02:00:00.000Z',
        ipv4DefaultRouteKey: 'cached-ipv4',
        ipv6DefaultRouteKey: 'cached-ipv6',
        dnsSignature: 'cached-dns',
      },
    };
    agent.networkObserver.publicIpCache = {
      observedAtMs: Date.now(),
      value: {
        ip: '9.9.9.9',
        provider: 'ifconfig.me',
      },
    };
    agent.networkObserver.getLocalSnapshot = async () => {
      throw new Error('local snapshot cache should be reused');
    };
    agent.networkObserver.getPublicIp = async () => {
      throw new Error('public ip cache should be reused');
    };

    const baseline = await agent.captureBaseline();

    assert.equal(baseline.observedAt, '2026-04-19T02:00:00.000Z');
    assert.equal(baseline.publicIp, '9.9.9.9');
  });
  await test('refreshState skips non-forced SoftEther query while mutation is running', async () => {
    const agent = new SelfHostedVpnAgent({
      stateFile: '/tmp/self-hosted-vpn-agent-test-mutation-refresh.json',
    });
    agent.state.phase = 'CONNECTING';
    agent.softEtherMutationInFlight = true;
    let queryCount = 0;
    agent.softEtherCli.listAccounts = async () => {
      queryCount += 1;
      return [];
    };
    agent.softEtherCli.listNics = async () => {
      queryCount += 1;
      return [];
    };

    const state = await agent.refreshState({ includeNetwork: false });

    assert.equal(state, agent.state);
    assert.equal(queryCount, 0);
  });
  await test('refreshState returns current state during in-flight transition refresh', async () => {
    const agent = new SelfHostedVpnAgent({
      stateFile: '/tmp/self-hosted-vpn-agent-test-transition-refresh.json',
    });
    agent.state.phase = 'DISCONNECTING';
    let resolveRefresh = () => {};
    agent.refreshPromise = new Promise((resolve) => {
      resolveRefresh = () => resolve(agent.state);
    });

    const state = await agent.refreshState({ includeNetwork: false });

    assert.equal(state, agent.state);
    resolveRefresh();
    await delay(0);
  });
  await test('refreshState returns current state during non-network refresh promise', async () => {
    const agent = new SelfHostedVpnAgent({
      stateFile: '/tmp/self-hosted-vpn-agent-test-refresh-promise-status.json',
    });
    agent.state.phase = 'CONNECTED';
    let resolveRefresh = () => {};
    agent.refreshPromise = new Promise((resolve) => {
      resolveRefresh = () => resolve(agent.state);
    });

    const state = await agent.refreshState({ includeNetwork: false });

    assert.equal(state, agent.state);
    resolveRefresh();
    await delay(0);
  });
  await test('findAccountByName uses cached account rows first', async () => {
    const agent = new SelfHostedVpnAgent({
      stateFile: '/tmp/self-hosted-vpn-agent-test-cached-account.json',
    });
    agent.state.accountRows = [{ name: 'cached-profile', statusKind: 'DISCONNECTED' }];
    let listCalls = 0;
    agent.softEtherCli.listAccounts = async () => {
      listCalls += 1;
      return [];
    };

    const row = await agent.findAccountByName('cached-profile');
    assert.equal(row?.name, 'cached-profile');
    assert.equal(listCalls, 0);
  });
  await test('connect refresh fallback preserves connected state with warning', async () => {
    const agent = new SelfHostedVpnAgent({
      stateFile: '/tmp/self-hosted-vpn-agent-test-connect-fallback.json',
    });
    agent.state.operationId = 'connect-op-1';
    agent.state.phase = 'CONNECTING';
    agent.saveState = async () => {};

    let refreshCallCount = 0;
    agent.state.phase = 'CONNECTED';
    agent.refreshNetworkState = async () => {
      refreshCallCount += 1;
      throw new Error('network observe failed');
    };

    await agent.finalizePostConnectRefresh('connect-op-1');

    assert.equal(refreshCallCount, 1);
    assert.equal(agent.state.phase, 'CONNECTED');
    assert.equal(agent.state.lastErrorCode, 'NETWORK_OBSERVE_FAILED');
    assert.match(agent.state.lastErrorMessage, /관측이 실패/);
  });
  await test('disconnect refresh fallback still settles idle state', async () => {
    const agent = new SelfHostedVpnAgent({
      stateFile: '/tmp/self-hosted-vpn-agent-test-disconnect-fallback.json',
    });
    agent.state.operationId = '';
    agent.state.phase = 'IDLE';

    let refreshCallCount = 0;
    agent.refreshNetworkState = async () => {
      refreshCallCount += 1;
      throw new Error('network observe failed');
    };

    await agent.finalizePostDisconnectRefresh('disconnect-op-1');

    assert.equal(refreshCallCount, 1);
    assert.equal(agent.state.phase, 'IDLE');
  });
  await test('disconnect immediately settles idle when tracked account is already missing', async () => {
    const agent = new SelfHostedVpnAgent({
      stateFile: '/tmp/self-hosted-vpn-agent-test-disconnect-missing.json',
    });
    agent.state.accountName = 'DCDSVPNGATE-relay-443-old';
    agent.state.accountOwnership = 'managed_raw';
    agent.state.profileId = 'vpngate-203-0-113-1-443';
    agent.state.phase = 'ERROR';
    agent.refreshState = async () => {
      agent.state.accountRows = [];
      return agent.state;
    };
    agent.saveState = async () => {};

    const response = await agent.disconnect();

    assert.equal(response.accepted, true);
    assert.equal(response.phase, 'IDLE');
    assert.equal(agent.state.phase, 'IDLE');
    assert.equal(agent.state.accountName, '');
  });
  await test('refreshState keeps raw connect phase during pre-create provisioning gap', async () => {
    const agent = new SelfHostedVpnAgent({
      stateFile: '/tmp/self-hosted-vpn-agent-test-provision-gap.json',
    });
    agent.state.phase = 'CONNECTING';
    agent.state.accountName = 'DCDSVPNGATE-relay-443-gap';
    agent.state.accountOwnership = 'managed_raw';
    agent.state.accountProvisioning = true;
    agent.saveState = async () => {};
    agent.softEtherCli.listAccounts = async () => [];
    agent.softEtherCli.listNics = async () => [{ name: 'VPN2', status: 'Enabled' }];
    agent.refreshNetworkState = async () => {};

    await agent.refreshState({ force: true, includeNetwork: false });

    assert.equal(agent.state.phase, 'CONNECTING');
    assert.equal(agent.state.accountName, 'DCDSVPNGATE-relay-443-gap');
    assert.equal(agent.state.accountProvisioning, true);
  });
  await test('refreshState marks connect error when tracked account disappears after provisioning', async () => {
    const agent = new SelfHostedVpnAgent({
      stateFile: '/tmp/self-hosted-vpn-agent-test-connect-missing.json',
    });
    agent.state.phase = 'CONNECTING';
    agent.state.accountName = 'DCDSVPNGATE-relay-443-missing';
    agent.state.accountOwnership = 'managed_raw';
    agent.state.accountProvisioning = false;
    agent.saveState = async () => {};
    agent.softEtherCli.listAccounts = async () => [];
    agent.softEtherCli.listNics = async () => [{ name: 'VPN2', status: 'Enabled' }];
    agent.refreshNetworkState = async () => {};

    await agent.refreshState({ force: true, includeNetwork: false });

    assert.equal(agent.state.phase, 'ERROR');
    assert.equal(agent.state.lastErrorCode, 'CONNECT_ACCOUNT_MISSING');
    assert.match(agent.state.lastErrorMessage, /연결 중 사라져/);
  });
  await test('raw connect returns accepted before background worker completes', async () => {
    const agent = new SelfHostedVpnAgent({
      stateFile: '/tmp/self-hosted-vpn-agent-test-async-connect.json',
    });
    agent.refreshState = async () => agent.state;
    agent.saveState = async () => {};
    agent.ensureBackgroundMonitor = () => {};

    let releaseWorker = () => {};
    const workerStarted = new Promise((resolve) => {
      releaseWorker = resolve;
    });

    let backgroundEntered = false;
    agent.executeRawRelayConnect = async () => {
      backgroundEntered = true;
      await workerStarted;
    };

    const response = await agent.connect({
      mode: CONNECTION_MODE.SOFTETHER_VPNGATE_RAW,
      relay: {
        ip: '121.138.132.127',
        selectedSslPort: 1698,
      },
    });

    assert.equal(response.accepted, true);
    assert.equal(response.phase, 'CONNECTING');
    assert.equal(response.connectionMode, CONNECTION_MODE.SOFTETHER_VPNGATE_RAW);
    assert.equal(backgroundEntered, true);
    releaseWorker();
    await delay(0);
  });
  await test('disconnect returns accepted before background worker completes', async () => {
    const agent = new SelfHostedVpnAgent({
      stateFile: '/tmp/self-hosted-vpn-agent-test-async-disconnect.json',
    });
    agent.refreshState = async () => {
      agent.state.accountRows = [{
        name: 'DCDSVPNGATE-relay-1698-abc',
        statusKind: 'CONNECTED',
      }];
      return agent.state;
    };
    agent.saveState = async () => {};
    agent.ensureBackgroundMonitor = () => {};
    agent.state.accountName = 'DCDSVPNGATE-relay-1698-abc';
    agent.state.accountOwnership = 'managed_raw';
    agent.state.profileId = 'vpngate-121-138-132-127-1698';
    agent.state.phase = 'CONNECTED';

    let releaseWorker = () => {};
    const workerStarted = new Promise((resolve) => {
      releaseWorker = resolve;
    });

    let backgroundEntered = false;
    agent.executeDisconnect = async () => {
      backgroundEntered = true;
      await workerStarted;
    };

    const response = await agent.disconnect();

    assert.equal(response.accepted, true);
    assert.equal(response.phase, 'DISCONNECTING');
    assert.ok(String(response.operationId || '').startsWith('disconnect-'));
    assert.equal(backgroundEntered, true);
    releaseWorker();
    await delay(0);
  });
  await test('disconnect reuses tracked state while connect mutation is still in flight', async () => {
    const agent = new SelfHostedVpnAgent({
      stateFile: '/tmp/self-hosted-vpn-agent-test-disconnect-during-mutation.json',
    });
    agent.softEtherMutationInFlight = true;
    agent.state.phase = 'CONNECTING';
    agent.state.accountName = 'DCDSVPNGATE-relay-1698-pending';
    agent.state.accountOwnership = 'managed_raw';
    agent.state.accountProvisioning = true;
    agent.state.profileId = 'vpngate-121-138-132-127-1698';
    agent.saveState = async () => {};
    agent.ensureBackgroundMonitor = () => {};
    agent.refreshState = async () => {
      throw new Error('disconnect should not block on forced refresh during mutation');
    };

    let backgroundEntered = false;
    agent.executeDisconnect = async () => {
      backgroundEntered = true;
    };

    const response = await agent.disconnect();

    assert.equal(response.accepted, true);
    assert.equal(response.phase, 'DISCONNECTING');
    assert.equal(backgroundEntered, true);
  });
  await test('disconnect treats missing account after disconnect error as settled idle', async () => {
    const agent = new SelfHostedVpnAgent({
      stateFile: '/tmp/self-hosted-vpn-agent-test-disconnect-missing-after-error.json',
    });
    agent.saveState = async () => {};
    agent.state.phase = 'DISCONNECTING';
    agent.state.operationId = 'disconnect-op-1';
    agent.state.accountName = 'DCDSVPNGATE-relay-1698-gone';
    agent.state.accountOwnership = 'managed_raw';
    agent.softEtherCli.disconnectAccount = async () => {
      throw new Error('vpncmd 실패 (AccountDisconnect DCDSVPNGATE-relay-1698-gone) - generic');
    };
    agent.softEtherCli.listAccounts = async () => [];
    agent.softEtherCli.deleteAccount = async () => {};

    await agent.executeDisconnect({
      operationId: 'disconnect-op-1',
      accountName: 'DCDSVPNGATE-relay-1698-gone',
    });

    assert.equal(agent.state.phase, 'IDLE');
    assert.equal(agent.state.accountName, '');
    assert.equal(agent.state.lastErrorCode, '');
  });
  await test('waitForTrackedAccountConnected returns connected snapshot', async () => {
    const agent = new SelfHostedVpnAgent({
      stateFile: '/tmp/self-hosted-vpn-agent-test-wait-connected.json',
    });
    agent.state.phase = 'CONNECTING';
    agent.state.operationId = 'connect-op-1';
    agent.state.accountProvisioning = false;
    let accountListCalls = 0;
    agent.softEtherCli.listAccounts = async () => {
      accountListCalls += 1;
      if (accountListCalls === 1) {
        return [{
          name: 'DCDSVPNGATE-relay-443-ok',
          statusKind: 'CONNECTING',
          statusText: 'Connecting',
        }];
      }
      return [{
        name: 'DCDSVPNGATE-relay-443-ok',
        statusKind: 'CONNECTED',
        statusText: 'Connected',
        nicName: 'VPN2',
        host: '203.0.113.5',
        port: 443,
      }];
    };
    agent.softEtherCli.listNics = async () => [{ name: 'VPN2', status: 'Enabled' }];
    agent.softEtherCli.getAccountStatus = async () => ({
      connectedAt: '2026-04-19T09:00:00.000Z',
      underlayProtocol: 'TCP',
      udpAccelerationActive: false,
    });

    const context = await agent.waitForTrackedAccountConnected({
      accountName: 'DCDSVPNGATE-relay-443-ok',
      operationId: 'connect-op-1',
      timeoutMs: 5000,
      pollIntervalMs: 1,
    });

    assert.equal(context?.trackedAccount?.statusKind, 'CONNECTED');
    assert.equal(context?.accountStatus, null);
    assert.equal(agent.state.accountRows.length > 0, true);
  });
  await test('executeRawRelayConnect releases mutation before network observation finishes', async () => {
    const agent = new SelfHostedVpnAgent({
      stateFile: '/tmp/self-hosted-vpn-agent-test-connect-release-before-network.json',
    });
    agent.state.phase = 'CONNECTING';
    agent.state.operationId = 'connect-op-1';
    agent.state.profileId = 'vpngate-203-0-113-5-443';
    agent.state.accountName = 'DCDSVPNGATE-relay-443-ok';
    agent.state.accountOwnership = 'managed_raw';
    agent.saveState = async () => {};
    agent.ensureManagedNic = async () => 'VPN2';
    agent.cleanupManagedInactiveAccounts = async () => {};
    agent.captureBaseline = async () => ({
      observedAt: '2026-04-19T09:00:00.000Z',
      publicIp: '1.1.1.1',
    });
    agent.softEtherCli.createAccount = async () => {};
    agent.softEtherCli.setAccountAnonymous = async () => {};
    agent.softEtherCli.setAccountRetry = async () => {};
    agent.softEtherCli.disableServerCertCheck = async () => {};
    agent.softEtherCli.setAccountDetails = async () => {};
    agent.softEtherCli.connectAccount = async () => {};
    agent.waitForTrackedAccountConnected = async () => ({
      trackedAccount: {
        name: 'DCDSVPNGATE-relay-443-ok',
        statusKind: 'CONNECTED',
        statusText: 'Connected',
        nicName: 'VPN2',
        host: '203.0.113.5',
        port: 443,
      },
      accountStatus: {
        connectedAt: '2026-04-19T09:00:00.000Z',
        underlayProtocol: 'TCP',
        udpAccelerationActive: false,
      },
      accountRows: [],
      nicRows: [],
    });
    let resolveObservation = () => {};
    const observationStarted = new Promise((resolve) => {
      resolveObservation = resolve;
    });
    let finishObservation = () => {};
    const observationDone = new Promise((resolve) => {
      finishObservation = resolve;
    });
    agent.refreshNetworkState = async () => {
      resolveObservation();
      await observationDone;
    };

    const worker = agent.executeRawRelayConnect({
      operationId: 'connect-op-1',
      request: {
        relay: {
          id: '203.0.113.5:443',
          ip: '203.0.113.5',
          fqdn: '',
          selectedSslPort: 443,
        },
      },
      accountName: 'DCDSVPNGATE-relay-443-ok',
    });

    await observationStarted;
    assert.equal(agent.state.phase, 'CONNECTED');
    assert.equal(agent.softEtherMutationInFlight, false);
    finishObservation();
    await worker;
  });
  await test('executeRawRelayConnect applies same account detail flags as direct probe', async () => {
    const agent = new SelfHostedVpnAgent({
      stateFile: '/tmp/self-hosted-vpn-agent-test-connect-detail-flags.json',
    });
    agent.state.phase = 'CONNECTING';
    agent.state.operationId = 'connect-op-1';
    agent.state.profileId = 'vpngate-203-0-113-5-443';
    agent.state.accountName = 'DCDSVPNGATE-relay-443-ok';
    agent.state.accountOwnership = 'managed_raw';
    agent.saveState = async () => {};
    agent.ensureManagedNic = async () => 'VPN2';
    agent.cleanupManagedInactiveAccounts = async () => {};
    agent.captureBaseline = async () => ({
      observedAt: '2026-04-19T09:00:00.000Z',
      publicIp: '1.1.1.1',
    });
    agent.softEtherCli.createAccount = async () => {};
    agent.softEtherCli.setAccountAnonymous = async () => {};
    agent.softEtherCli.setAccountRetry = async () => {};
    agent.softEtherCli.disableServerCertCheck = async () => {};
    let detailOptions = null;
    agent.softEtherCli.setAccountDetails = async (_name, options) => {
      detailOptions = options;
    };
    agent.softEtherCli.connectAccount = async () => {};
    agent.waitForTrackedAccountConnected = async () => ({
      trackedAccount: {
        name: 'DCDSVPNGATE-relay-443-ok',
        statusKind: 'CONNECTED',
        statusText: 'Connected',
        nicName: 'VPN2',
        host: '203.0.113.5',
        port: 443,
      },
      accountStatus: {
        connectedAt: '2026-04-19T09:00:00.000Z',
        underlayProtocol: 'TCP',
        udpAccelerationActive: false,
      },
      accountRows: [],
      nicRows: [],
    });
    agent.refreshNetworkState = async () => {};

    await agent.executeRawRelayConnect({
      operationId: 'connect-op-1',
      request: {
        relay: {
          id: '203.0.113.5:443',
          ip: '203.0.113.5',
          fqdn: '',
          selectedSslPort: 443,
        },
      },
      accountName: 'DCDSVPNGATE-relay-443-ok',
    });

    assert.deepEqual(detailOptions, {
      maxTcp: 1,
      additionalConnectionInterval: 1,
      connectionTtl: 0,
      halfDuplex: false,
      bridgeMode: false,
      monitorMode: false,
      noRoutingTracking: false,
      noQos: true,
    });
  });
  await test('executeRawRelayConnect retries alternate SSL port after first failure', async () => {
    const agent = new SelfHostedVpnAgent({
      stateFile: '/tmp/self-hosted-vpn-agent-test-connect-port-fallback.json',
    });
    agent.state.phase = 'CONNECTING';
    agent.state.operationId = 'connect-op-1';
    agent.state.profileId = 'vpngate-203-0-113-5-995';
    agent.state.accountName = 'DCDSVPNGATE-relay-995-ok';
    agent.state.accountOwnership = 'managed_raw';
    agent.saveState = async () => {};
    agent.ensureManagedNic = async () => 'VPN2';
    agent.cleanupManagedInactiveAccounts = async () => {};
    agent.captureBaseline = async () => ({
      observedAt: '2026-04-19T09:00:00.000Z',
      publicIp: '1.1.1.1',
    });
    const attemptedPorts = [];
    agent.softEtherCli.createAccount = async (options = {}) => {
      attemptedPorts.push(options.serverPort);
    };
    agent.softEtherCli.setAccountAnonymous = async () => {};
    agent.softEtherCli.setAccountRetry = async () => {};
    agent.softEtherCli.disableServerCertCheck = async () => {};
    agent.softEtherCli.setAccountDetails = async () => {};
    agent.softEtherCli.connectAccount = async () => {};
    agent.softEtherCli.getAccountStatus = async () => ({
      connectedAt: '2026-04-19T09:00:00.000Z',
      underlayProtocol: 'TCP',
      udpAccelerationActive: false,
    });
    agent.safeDeleteManagedAccount = async () => {};
    agent.waitForTrackedAccountConnected = async () => {
      if (agent.state.activeSelectedSslPort === 995) {
        throw new Error('995 failed');
      }
      return {
        trackedAccount: {
          name: 'DCDSVPNGATE-relay-995-ok',
          statusKind: 'CONNECTED',
          statusText: 'Connected',
          nicName: 'VPN2',
          host: '203.0.113.5',
          port: 465,
        },
        accountStatus: null,
        accountRows: [],
        nicRows: [],
      };
    };
    agent.refreshNetworkState = async () => {};

    await agent.executeRawRelayConnect({
      operationId: 'connect-op-1',
      request: {
        relay: {
          id: '203.0.113.5:995',
          ip: '203.0.113.5',
          fqdn: '',
          selectedSslPort: 995,
          sslPorts: [995, 465, 1195],
        },
      },
      accountName: 'DCDSVPNGATE-relay-995-ok',
    });

    assert.deepEqual(attemptedPorts, [995, 465]);
    assert.equal(agent.state.phase, 'CONNECTED');
    assert.equal(agent.state.activeSelectedSslPort, 465);
  });
  await test('executeDisconnect releases idle state before network observation finishes', async () => {
    const agent = new SelfHostedVpnAgent({
      stateFile: '/tmp/self-hosted-vpn-agent-test-disconnect-release-before-network.json',
    });
    agent.saveState = async () => {};
    agent.state.phase = 'DISCONNECTING';
    agent.state.operationId = 'disconnect-op-1';
    agent.state.accountName = 'DCDSVPNGATE-relay-443-ok';
    agent.state.accountOwnership = 'managed_raw';
    agent.softEtherCli.disconnectAccount = async () => {};
    agent.waitForTrackedAccountDisconnected = async () => ({
      trackedAccount: {
        name: 'DCDSVPNGATE-relay-443-ok',
        statusKind: 'DISCONNECTED',
      },
      accountRows: [],
    });
    agent.finishDisconnectCleanup = async () => {
      agent.state.phase = 'IDLE';
      agent.state.operationId = '';
      agent.state.accountName = '';
    };
    let resolveObservation = () => {};
    const observationStarted = new Promise((resolve) => {
      resolveObservation = resolve;
    });
    let finishObservation = () => {};
    const observationDone = new Promise((resolve) => {
      finishObservation = resolve;
    });
    agent.refreshNetworkState = async () => {
      resolveObservation();
      await observationDone;
    };

    const worker = agent.executeDisconnect({
      operationId: 'disconnect-op-1',
      accountName: 'DCDSVPNGATE-relay-443-ok',
    });

    await observationStarted;
    assert.equal(agent.state.phase, 'IDLE');
    assert.equal(agent.softEtherMutationInFlight, false);
    finishObservation();
    await worker;
  });

  console.log(`[self-hosted-vpn-agent] ${results.length}개 self-test 통과`);
}

await runTests();
