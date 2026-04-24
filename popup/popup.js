const featureTabs = document.querySelectorAll('.tab-button');
const featurePanels = document.querySelectorAll('.panel');
const sharedGalleryIdInput = document.getElementById('sharedGalleryId');
const sharedHeadtextIdInput = document.getElementById('sharedHeadtextId');
const sharedSaveConfigBtn = document.getElementById('sharedSaveConfigBtn');
const DIRTY_FEATURES = {
  conceptMonitor: false,
  conceptPatrol: false,
  hanRefreshIpBan: false,
  bumpPost: false,
  sinmungoComment: false,
  selfHostedVpn: false,
  refluxDatasetCollector: false,
  refluxOverlayCollector: false,
  commentRefluxCollector: false,
  commentMonitor: false,
  trustedCommandDefense: false,
  comment: false,
  post: false,
  semiPost: false,
  ip: false,
  monitor: false,
  uidWarningAutoBan: false,
};
const INLINE_SETTING_DIRTY = {
  commentVpnGate: false,
  postVpnGate: false,
};
let sharedConfigDirty = false;
let sessionFallbackDirty = false;
let latestMonitorStatus = null;
let latestConceptMonitorStatus = null;
let latestConceptPatrolStatus = null;
let latestSessionFallbackStatus = null;
let latestUidRatioWarningStatus = null;
let latestUidWarningAutoBanStatus = null;
let latestBumpPostStatus = null;
let latestSinmungoCommentStatus = null;
let latestRenderedSinmungoCommentChallengeId = '';
let latestCommentStatus = null;
let latestPostStatus = null;
let latestSelfHostedVpnStatus = null;
let latestRefluxDatasetCollectorStatus = null;
let latestRefluxOverlayCollectorStatus = null;
let latestRefluxOverlayCollectorOverlays = [];
let latestRefluxOverlayCollectorOverlaysLoaded = false;
let latestCommentRefluxCollectorStatus = null;
let latestTrustedCommandDefenseStatus = null;
let draftTrustedCommandDefenseTrustedUsers = [];
const SELF_HOSTED_VPN_AGENT_WINDOWS_REPO_PATH = 'C:\\Users\\eorb9\\projects\\dc_defense_suite_repo';

const SESSION_FALLBACK_DOM = {
  keepaliveToggle: document.getElementById('sessionFallbackKeepaliveToggle'),
  keepaliveLabel: document.getElementById('sessionFallbackKeepaliveLabel'),
  primaryUserIdInput: document.getElementById('sessionFallbackPrimaryUserId'),
  primaryPasswordInput: document.getElementById('sessionFallbackPrimaryPassword'),
  backupUserIdInput: document.getElementById('sessionFallbackBackupUserId'),
  backupPasswordInput: document.getElementById('sessionFallbackBackupPassword'),
  testSwitchBtn: document.getElementById('sessionFallbackTestSwitchBtn'),
  saveConfigBtn: document.getElementById('sessionFallbackSaveConfigBtn'),
  activeAccountText: document.getElementById('sessionFallbackActiveAccountText'),
  automationStateText: document.getElementById('sessionFallbackAutomationStateText'),
  switchStateText: document.getElementById('sessionFallbackSwitchStateText'),
  loginHealthText: document.getElementById('sessionFallbackLoginHealthText'),
  lastDeleteLimitAccountText: document.getElementById('sessionFallbackLastDeleteLimitAccountText'),
  metaText: document.getElementById('sessionFallbackMetaText'),
};

const FEATURE_DOM = {
  conceptMonitor: {
    toggleBtn: document.getElementById('conceptMonitorToggleBtn'),
    toggleLabel: document.getElementById('conceptMonitorToggleLabel'),
    statusText: document.getElementById('conceptMonitorStatusText'),
    modeText: document.getElementById('conceptMonitorModeText'),
    autoCutStateText: document.getElementById('conceptMonitorAutoCutStateText'),
    lastPollAt: document.getElementById('conceptMonitorLastPollAt'),
    currentPostNo: document.getElementById('conceptMonitorCurrentPostNo'),
    lastScanCount: document.getElementById('conceptMonitorLastScanCount'),
    lastCandidateCount: document.getElementById('conceptMonitorLastCandidateCount'),
    totalDetectedCount: document.getElementById('conceptMonitorTotalDetectedCount'),
    totalReleasedCount: document.getElementById('conceptMonitorTotalReleasedCount'),
    totalFailedCount: document.getElementById('conceptMonitorTotalFailedCount'),
    totalUnclearCount: document.getElementById('conceptMonitorTotalUnclearCount'),
    lastRecommendDelta: document.getElementById('conceptMonitorLastRecommendDelta'),
    lastComparedPostCount: document.getElementById('conceptMonitorLastComparedPostCount'),
    lastCutChangedAt: document.getElementById('conceptMonitorLastCutChangedAt'),
    logList: document.getElementById('conceptMonitorLogList'),
    pollIntervalMsInput: document.getElementById('conceptMonitorPollIntervalMs'),
    snapshotPostLimitInput: document.getElementById('conceptMonitorSnapshotPostLimit'),
    fluidRatioThresholdInput: document.getElementById('conceptMonitorFluidRatioThreshold'),
    testModeInput: document.getElementById('conceptMonitorTestMode'),
    autoCutEnabledInput: document.getElementById('conceptMonitorAutoCutEnabled'),
    autoCutEnabledLabel: document.getElementById('conceptMonitorAutoCutEnabledLabel'),
    autoCutPollIntervalMsInput: document.getElementById('conceptMonitorAutoCutPollIntervalMs'),
    autoCutAttackThresholdInput: document.getElementById('conceptMonitorAutoCutAttackThreshold'),
    autoCutAttackConsecutiveCountInput: document.getElementById('conceptMonitorAutoCutAttackConsecutiveCount'),
    autoCutReleaseThresholdInput: document.getElementById('conceptMonitorAutoCutReleaseThreshold'),
    autoCutReleaseConsecutiveCountInput: document.getElementById('conceptMonitorAutoCutReleaseConsecutiveCount'),
    saveConfigBtn: document.getElementById('conceptMonitorSaveConfigBtn'),
    resetBtn: document.getElementById('conceptMonitorResetBtn'),
  },
  conceptPatrol: {
    toggleBtn: document.getElementById('conceptPatrolToggleBtn'),
    toggleLabel: document.getElementById('conceptPatrolToggleLabel'),
    statusText: document.getElementById('conceptPatrolStatusText'),
    modeText: document.getElementById('conceptPatrolModeText'),
    holdStateText: document.getElementById('conceptPatrolHoldStateText'),
    effectiveRecommendCutText: document.getElementById('conceptPatrolEffectiveRecommendCutText'),
    lastPollAt: document.getElementById('conceptPatrolLastPollAt'),
    currentPosition: document.getElementById('conceptPatrolCurrentPosition'),
    lastDetectedMaxPage: document.getElementById('conceptPatrolLastDetectedMaxPage'),
    lastWindowSize: document.getElementById('conceptPatrolLastWindowSize'),
    lastNewPostCount: document.getElementById('conceptPatrolLastNewPostCount'),
    lastCandidateCount: document.getElementById('conceptPatrolLastCandidateCount'),
    totalDetectedCount: document.getElementById('conceptPatrolTotalDetectedCount'),
    totalReleasedCount: document.getElementById('conceptPatrolTotalReleasedCount'),
    totalFailedCount: document.getElementById('conceptPatrolTotalFailedCount'),
    totalUnclearCount: document.getElementById('conceptPatrolTotalUnclearCount'),
    holdUntilText: document.getElementById('conceptPatrolHoldUntilText'),
    lastCutChangedAt: document.getElementById('conceptPatrolLastCutChangedAt'),
    logList: document.getElementById('conceptPatrolLogList'),
    pollIntervalMsInput: document.getElementById('conceptPatrolPollIntervalMs'),
    patrolPagesInput: document.getElementById('conceptPatrolPages'),
    pageRequestDelayInput: document.getElementById('conceptPatrolPageRequestDelayMs'),
    fluidRatioThresholdInput: document.getElementById('conceptPatrolFluidRatioThreshold'),
    candidateThresholdInput: document.getElementById('conceptPatrolCandidateThreshold'),
    holdMsInput: document.getElementById('conceptPatrolHoldMs'),
    testModeInput: document.getElementById('conceptPatrolTestMode'),
    saveConfigBtn: document.getElementById('conceptPatrolSaveConfigBtn'),
    resetBtn: document.getElementById('conceptPatrolResetBtn'),
  },
  hanRefreshIpBan: {
    toggleBtn: document.getElementById('hanRefreshIpBanToggleBtn'),
    toggleLabel: document.getElementById('hanRefreshIpBanToggleLabel'),
    statusText: document.getElementById('hanRefreshIpBanStatusText'),
    phaseText: document.getElementById('hanRefreshIpBanPhaseText'),
    currentPage: document.getElementById('hanRefreshIpBanCurrentPage'),
    detectedMaxPage: document.getElementById('hanRefreshIpBanDetectedMaxPage'),
    currentCycleScannedRows: document.getElementById('hanRefreshIpBanCurrentCycleScannedRows'),
    currentCycleMatchedRows: document.getElementById('hanRefreshIpBanCurrentCycleMatchedRows'),
    currentCycleBanSuccessCount: document.getElementById('hanRefreshIpBanCurrentCycleBanSuccessCount'),
    currentCycleBanFailureCount: document.getElementById('hanRefreshIpBanCurrentCycleBanFailureCount'),
    lastRunAt: document.getElementById('hanRefreshIpBanLastRunAt'),
    nextRunAt: document.getElementById('hanRefreshIpBanNextRunAt'),
    logList: document.getElementById('hanRefreshIpBanLogList'),
    requestDelayInput: document.getElementById('hanRefreshIpBanRequestDelay'),
    fallbackMaxPageInput: document.getElementById('hanRefreshIpBanFallbackMaxPage'),
    saveConfigBtn: document.getElementById('hanRefreshIpBanSaveConfigBtn'),
    resetBtn: document.getElementById('hanRefreshIpBanResetBtn'),
  },
  bumpPost: {
    toggleBtn: document.getElementById('bumpPostToggleBtn'),
    toggleLabel: document.getElementById('bumpPostToggleLabel'),
    statusText: document.getElementById('bumpPostStatusText'),
    phaseText: document.getElementById('bumpPostPhaseText'),
    targetPostNoText: document.getElementById('bumpPostTargetPostNo'),
    startedAtText: document.getElementById('bumpPostStartedAt'),
    endsAtText: document.getElementById('bumpPostEndsAt'),
    nextRunAtText: document.getElementById('bumpPostNextRunAt'),
    lastBumpedAtText: document.getElementById('bumpPostLastBumpedAt'),
    lastBumpedPostNoText: document.getElementById('bumpPostLastBumpedPostNo'),
    totalBumpedCountText: document.getElementById('bumpPostTotalBumpedCount'),
    totalFailedCountText: document.getElementById('bumpPostTotalFailedCount'),
    cycleCountText: document.getElementById('bumpPostCycleCount'),
    lastErrorAtText: document.getElementById('bumpPostLastErrorAt'),
    metaText: document.getElementById('bumpPostMetaText'),
    logList: document.getElementById('bumpPostLogList'),
    postNoInput: document.getElementById('bumpPostPostNo'),
    durationMinutesInput: document.getElementById('bumpPostDurationMinutes'),
    intervalMinutesInput: document.getElementById('bumpPostIntervalMinutes'),
    saveConfigBtn: document.getElementById('bumpPostSaveConfigBtn'),
    resetBtn: document.getElementById('bumpPostResetBtn'),
  },
  sinmungoComment: {
    toggleBtn: document.getElementById('sinmungoCommentToggleBtn'),
    toggleLabel: document.getElementById('sinmungoCommentToggleLabel'),
    statusText: document.getElementById('sinmungoCommentStatusText'),
    phaseText: document.getElementById('sinmungoCommentPhaseText'),
    targetPostNoText: document.getElementById('sinmungoCommentTargetPostNo'),
    lastSubmittedAtText: document.getElementById('sinmungoCommentLastSubmittedAt'),
    lastVerifiedAtText: document.getElementById('sinmungoCommentLastVerifiedAt'),
    lastCommentNoText: document.getElementById('sinmungoCommentLastCommentNo'),
    totalSubmittedCountText: document.getElementById('sinmungoCommentTotalSubmittedCount'),
    totalFailedCountText: document.getElementById('sinmungoCommentTotalFailedCount'),
    lastErrorAtText: document.getElementById('sinmungoCommentLastErrorAt'),
    metaText: document.getElementById('sinmungoCommentMetaText'),
    logList: document.getElementById('sinmungoCommentLogList'),
    postNoInput: document.getElementById('sinmungoCommentPostNo'),
    submitModeInput: document.getElementById('sinmungoCommentSubmitMode'),
    memoInput: document.getElementById('sinmungoCommentMemo'),
    anonymousNameSetting: document.getElementById('sinmungoCommentAnonymousNameSetting'),
    anonymousNameInput: document.getElementById('sinmungoCommentAnonymousName'),
    passwordSetting: document.getElementById('sinmungoCommentPasswordSetting'),
    passwordInput: document.getElementById('sinmungoCommentPassword'),
    challengeSection: document.getElementById('sinmungoCommentChallengeSection'),
    challengeMetaText: document.getElementById('sinmungoCommentChallengeMetaText'),
    challengePreparedAtText: document.getElementById('sinmungoCommentCaptchaPreparedAt'),
    challengeIdentityText: document.getElementById('sinmungoCommentChallengeIdentityText'),
    captchaImage: document.getElementById('sinmungoCommentCaptchaImage'),
    challengeNameItem: document.getElementById('sinmungoCommentChallengeNameItem'),
    challengeNameInput: document.getElementById('sinmungoCommentChallengeName'),
    codeInput: document.getElementById('sinmungoCommentCodeInput'),
    refreshCaptchaBtn: document.getElementById('sinmungoCommentRefreshCaptchaBtn'),
    submitCaptchaBtn: document.getElementById('sinmungoCommentSubmitCaptchaBtn'),
    cancelCaptchaBtn: document.getElementById('sinmungoCommentCancelCaptchaBtn'),
    saveConfigBtn: document.getElementById('sinmungoCommentSaveConfigBtn'),
    resetBtn: document.getElementById('sinmungoCommentResetBtn'),
  },
  selfHostedVpn: {
    toggleBtn: document.getElementById('selfHostedVpnToggleBtn'),
    toggleLabel: document.getElementById('selfHostedVpnToggleLabel'),
    statusText: document.getElementById('selfHostedVpnStatusText'),
    agentHealthText: document.getElementById('selfHostedVpnAgentHealthText'),
    agentVersionText: document.getElementById('selfHostedVpnAgentVersionText'),
    profileIdText: document.getElementById('selfHostedVpnProfileIdText'),
    connectionModeText: document.getElementById('selfHostedVpnConnectionModeText'),
    relayText: document.getElementById('selfHostedVpnRelayText'),
    sslPortText: document.getElementById('selfHostedVpnSslPortText'),
    currentPublicIpText: document.getElementById('selfHostedVpnCurrentPublicIpText'),
    publicIpBeforeText: document.getElementById('selfHostedVpnPublicIpBeforeText'),
    publicIpAfterText: document.getElementById('selfHostedVpnPublicIpAfterText'),
    activeAdapterText: document.getElementById('selfHostedVpnActiveAdapterText'),
    ipv4RouteText: document.getElementById('selfHostedVpnIpv4RouteText'),
    ipv6RouteText: document.getElementById('selfHostedVpnIpv6RouteText'),
    dnsChangedText: document.getElementById('selfHostedVpnDnsChangedText'),
    lastSyncAtText: document.getElementById('selfHostedVpnLastSyncAtText'),
    lastHealthAtText: document.getElementById('selfHostedVpnLastHealthAtText'),
    connectedAtText: document.getElementById('selfHostedVpnConnectedAtText'),
    lastErrorCodeText: document.getElementById('selfHostedVpnLastErrorCodeText'),
    metaText: document.getElementById('selfHostedVpnMetaText'),
    agentGuideCard: document.getElementById('selfHostedVpnAgentGuideCard'),
    agentGuideMetaText: document.getElementById('selfHostedVpnAgentGuideMetaText'),
    agentGuideStatusText: document.getElementById('selfHostedVpnAgentGuideStatusText'),
    agentGuideAddressText: document.getElementById('selfHostedVpnAgentGuideAddressText'),
    agentGuideFallbackAddressText: document.getElementById('selfHostedVpnAgentGuideFallbackAddressText'),
    agentGuideRepoPathText: document.getElementById('selfHostedVpnAgentGuideRepoPathText'),
    agentGuideCommandLabelText: document.getElementById('selfHostedVpnAgentGuideCommandLabelText'),
    agentGuideCommandText: document.getElementById('selfHostedVpnAgentGuideCommandText'),
    parallelStatusText: document.getElementById('selfHostedVpnParallelStatusText'),
    parallelRouteOwnerText: document.getElementById('selfHostedVpnParallelRouteOwnerText'),
    parallelVerifiedIpText: document.getElementById('selfHostedVpnParallelVerifiedIpText'),
    parallelSlotsText: document.getElementById('selfHostedVpnParallelSlotsText'),
    parallelMetaText: document.getElementById('selfHostedVpnParallelMetaText'),
    catalogStatusText: document.getElementById('selfHostedVpnCatalogStatusText'),
    catalogCountText: document.getElementById('selfHostedVpnCatalogCountText'),
    catalogMetaText: document.getElementById('selfHostedVpnCatalogMetaText'),
    catalogList: document.getElementById('selfHostedVpnCatalogList'),
    logList: document.getElementById('selfHostedVpnLogList'),
    agentBaseUrlInput: document.getElementById('selfHostedVpnAgentBaseUrl'),
    authTokenInput: document.getElementById('selfHostedVpnAuthToken'),
    connectionModeInput: document.getElementById('selfHostedVpnConnectionMode'),
    profileIdInput: document.getElementById('selfHostedVpnProfileId'),
    relayIdInput: document.getElementById('selfHostedVpnRelayId'),
    relayFqdnInput: document.getElementById('selfHostedVpnRelayFqdn'),
    relayIpInput: document.getElementById('selfHostedVpnRelayIp'),
    selectedSslPortInput: document.getElementById('selfHostedVpnSelectedSslPort'),
    relayUdpPortInput: document.getElementById('selfHostedVpnRelayUdpPort'),
    relayHostUniqueKeyInput: document.getElementById('selfHostedVpnRelayHostUniqueKey'),
    requestTimeoutMsInput: document.getElementById('selfHostedVpnRequestTimeoutMs'),
    actionTimeoutMsInput: document.getElementById('selfHostedVpnActionTimeoutMs'),
    settingsDetails: document.getElementById('selfHostedVpnSettingsDetails'),
    saveConfigBtn: document.getElementById('selfHostedVpnSaveConfigBtn'),
    refreshBtn: document.getElementById('selfHostedVpnRefreshBtn'),
    primeNicsBtn: document.getElementById('selfHostedVpnPrimeNicsBtn'),
    copyAgentStartBtn: document.getElementById('selfHostedVpnCopyAgentStartBtn'),
    copyAgentFallbackBtn: document.getElementById('selfHostedVpnCopyAgentFallbackBtn'),
    useFallbackAgentUrlBtn: document.getElementById('selfHostedVpnUseFallbackAgentUrlBtn'),
    copyAgentStopBtn: document.getElementById('selfHostedVpnCopyAgentStopBtn'),
    parallelStartBtn: document.getElementById('selfHostedVpnParallelStartBtn'),
    parallelRefreshBtn: document.getElementById('selfHostedVpnParallelRefreshBtn'),
    parallelStopBtn: document.getElementById('selfHostedVpnParallelStopBtn'),
    resetBtn: document.getElementById('selfHostedVpnResetBtn'),
  },
  refluxDatasetCollector: {
    toggleBtn: document.getElementById('refluxDatasetCollectorToggleBtn'),
    toggleLabel: document.getElementById('refluxDatasetCollectorToggleLabel'),
    statusText: document.getElementById('refluxDatasetCollectorStatusText'),
    phaseText: document.getElementById('refluxDatasetCollectorPhaseText'),
    galleryIdText: document.getElementById('refluxDatasetCollectorGalleryIdText'),
    progressText: document.getElementById('refluxDatasetCollectorProgressText'),
    fetchedPageCountText: document.getElementById('refluxDatasetCollectorFetchedPageCountText'),
    rawTitleCountText: document.getElementById('refluxDatasetCollectorRawTitleCountText'),
    normalizedTitleCountText: document.getElementById('refluxDatasetCollectorNormalizedTitleCountText'),
    startedAtText: document.getElementById('refluxDatasetCollectorStartedAtText'),
    finishedAtText: document.getElementById('refluxDatasetCollectorFinishedAtText'),
    exportVersionText: document.getElementById('refluxDatasetCollectorExportVersionText'),
    lastErrorText: document.getElementById('refluxDatasetCollectorLastErrorText'),
    metaText: document.getElementById('refluxDatasetCollectorMetaText'),
    logList: document.getElementById('refluxDatasetCollectorLogList'),
    galleryIdInput: document.getElementById('refluxDatasetCollectorGalleryId'),
    startPageInput: document.getElementById('refluxDatasetCollectorStartPage'),
    endPageInput: document.getElementById('refluxDatasetCollectorEndPage'),
    requestDelayMsInput: document.getElementById('refluxDatasetCollectorRequestDelayMs'),
    jitterMsInput: document.getElementById('refluxDatasetCollectorJitterMs'),
    saveConfigBtn: document.getElementById('refluxDatasetCollectorSaveConfigBtn'),
    downloadBtn: document.getElementById('refluxDatasetCollectorDownloadBtn'),
    resetBtn: document.getElementById('refluxDatasetCollectorResetBtn'),
  },
  refluxOverlayCollector: {
    toggleBtn: document.getElementById('refluxOverlayCollectorToggleBtn'),
    toggleLabel: document.getElementById('refluxOverlayCollectorToggleLabel'),
    statusText: document.getElementById('refluxOverlayCollectorStatusText'),
    phaseText: document.getElementById('refluxOverlayCollectorPhaseText'),
    galleryIdText: document.getElementById('refluxOverlayCollectorGalleryIdText'),
    targetPostNoText: document.getElementById('refluxOverlayCollectorTargetPostNoText'),
    foundPageText: document.getElementById('refluxOverlayCollectorFoundPageText'),
    progressText: document.getElementById('refluxOverlayCollectorProgressText'),
    normalizedTitleCountText: document.getElementById('refluxOverlayCollectorNormalizedTitleCountText'),
    appliedOverlayIdText: document.getElementById('refluxOverlayCollectorAppliedOverlayIdText'),
    startedAtText: document.getElementById('refluxOverlayCollectorStartedAtText'),
    finishedAtText: document.getElementById('refluxOverlayCollectorFinishedAtText'),
    lastErrorText: document.getElementById('refluxOverlayCollectorLastErrorText'),
    metaText: document.getElementById('refluxOverlayCollectorMetaText'),
    logList: document.getElementById('refluxOverlayCollectorLogList'),
    overlayList: document.getElementById('refluxOverlayCollectorOverlayList'),
    viewUrlInput: document.getElementById('refluxOverlayCollectorViewUrl'),
    beforePagesInput: document.getElementById('refluxOverlayCollectorBeforePages'),
    afterPagesInput: document.getElementById('refluxOverlayCollectorAfterPages'),
    requestDelayMsInput: document.getElementById('refluxOverlayCollectorRequestDelayMs'),
    jitterMsInput: document.getElementById('refluxOverlayCollectorJitterMs'),
    transportModeInput: document.getElementById('refluxOverlayCollectorTransportMode'),
    proxyWorkerCountInput: document.getElementById('refluxOverlayCollectorProxyWorkerCount'),
    saveConfigBtn: document.getElementById('refluxOverlayCollectorSaveConfigBtn'),
    resetBtn: document.getElementById('refluxOverlayCollectorResetBtn'),
    clearOverlaysBtn: document.getElementById('refluxOverlayCollectorClearOverlaysBtn'),
  },
  commentRefluxCollector: {
    toggleBtn: document.getElementById('commentRefluxCollectorToggleBtn'),
    toggleLabel: document.getElementById('commentRefluxCollectorToggleLabel'),
    statusText: document.getElementById('commentRefluxCollectorStatusText'),
    phaseText: document.getElementById('commentRefluxCollectorPhaseText'),
    galleryIdText: document.getElementById('commentRefluxCollectorGalleryIdText'),
    progressText: document.getElementById('commentRefluxCollectorProgressText'),
    currentPostNoText: document.getElementById('commentRefluxCollectorCurrentPostNoText'),
    fetchedPageCountText: document.getElementById('commentRefluxCollectorFetchedPageCountText'),
    processedPostCountText: document.getElementById('commentRefluxCollectorProcessedPostCountText'),
    failedPostCountText: document.getElementById('commentRefluxCollectorFailedPostCountText'),
    rawCommentCountText: document.getElementById('commentRefluxCollectorRawCommentCountText'),
    normalizedMemoCountText: document.getElementById('commentRefluxCollectorNormalizedMemoCountText'),
    startedAtText: document.getElementById('commentRefluxCollectorStartedAtText'),
    finishedAtText: document.getElementById('commentRefluxCollectorFinishedAtText'),
    exportVersionText: document.getElementById('commentRefluxCollectorExportVersionText'),
    lastErrorText: document.getElementById('commentRefluxCollectorLastErrorText'),
    metaText: document.getElementById('commentRefluxCollectorMetaText'),
    logList: document.getElementById('commentRefluxCollectorLogList'),
    galleryIdInput: document.getElementById('commentRefluxCollectorGalleryId'),
    startPageInput: document.getElementById('commentRefluxCollectorStartPage'),
    endPageInput: document.getElementById('commentRefluxCollectorEndPage'),
    requestDelayMsInput: document.getElementById('commentRefluxCollectorRequestDelayMs'),
    cycleDelayMsInput: document.getElementById('commentRefluxCollectorCycleDelayMs'),
    postConcurrencyInput: document.getElementById('commentRefluxCollectorPostConcurrency'),
    saveConfigBtn: document.getElementById('commentRefluxCollectorSaveConfigBtn'),
    downloadBtn: document.getElementById('commentRefluxCollectorDownloadBtn'),
    resetBtn: document.getElementById('commentRefluxCollectorResetBtn'),
  },
  commentMonitor: {
    toggleBtn: document.getElementById('commentMonitorToggleBtn'),
    toggleLabel: document.getElementById('commentMonitorToggleLabel'),
    statusText: document.getElementById('commentMonitorStatusText'),
    phaseText: document.getElementById('commentMonitorPhaseText'),
    lastPollAt: document.getElementById('commentMonitorLastPollAt'),
    newCommentCount: document.getElementById('commentMonitorNewCommentCount'),
    verifiedDeletedCount: document.getElementById('commentMonitorVerifiedDeletedCount'),
    changedPostCount: document.getElementById('commentMonitorChangedPostCount'),
    attackHitCount: document.getElementById('commentMonitorAttackHitCount'),
    releaseHitCount: document.getElementById('commentMonitorReleaseHitCount'),
    totalAttackDetected: document.getElementById('commentMonitorTotalAttackDetected'),
    totalAttackReleased: document.getElementById('commentMonitorTotalAttackReleased'),
    logList: document.getElementById('commentMonitorLogList'),
    pollIntervalMsInput: document.getElementById('commentMonitorPollIntervalMs'),
    pagesInput: document.getElementById('commentMonitorPages'),
    attackNewCommentThresholdInput: document.getElementById('commentMonitorAttackNewCommentThreshold'),
    attackChangedPostThresholdInput: document.getElementById('commentMonitorAttackChangedPostThreshold'),
    attackAltNewCommentThresholdInput: document.getElementById('commentMonitorAttackAltNewCommentThreshold'),
    attackAltChangedPostThresholdInput: document.getElementById('commentMonitorAttackAltChangedPostThreshold'),
    attackConsecutiveCountInput: document.getElementById('commentMonitorAttackConsecutiveCount'),
    releaseNewCommentThresholdInput: document.getElementById('commentMonitorReleaseNewCommentThreshold'),
    releaseVerifiedDeleteThresholdInput: document.getElementById('commentMonitorReleaseVerifiedDeleteThreshold'),
    releaseConsecutiveCountInput: document.getElementById('commentMonitorReleaseConsecutiveCount'),
    saveConfigBtn: document.getElementById('commentMonitorSaveConfigBtn'),
    resetBtn: document.getElementById('commentMonitorResetBtn'),
  },
  trustedCommandDefense: {
    toggleBtn: document.getElementById('trustedCommandDefenseToggleBtn'),
    toggleLabel: document.getElementById('trustedCommandDefenseToggleLabel'),
    statusText: document.getElementById('trustedCommandDefenseStatusText'),
    phaseText: document.getElementById('trustedCommandDefensePhaseText'),
    lastPollAtText: document.getElementById('trustedCommandDefenseLastPollAt'),
    seededAtText: document.getElementById('trustedCommandDefenseSeededAt'),
    lastSeenCommentNoText: document.getElementById('trustedCommandDefenseLastSeenCommentNo'),
    lastCommandTypeText: document.getElementById('trustedCommandDefenseLastCommandType'),
    lastCommandCommentNoText: document.getElementById('trustedCommandDefenseLastCommandCommentNo'),
    lastCommandUserIdText: document.getElementById('trustedCommandDefenseLastCommandUserId'),
    postDefenseUntilText: document.getElementById('trustedCommandDefensePostDefenseUntil'),
    commentDefenseUntilText: document.getElementById('trustedCommandDefenseCommentDefenseUntil'),
    trustedUserCountText: document.getElementById('trustedCommandDefenseTrustedUserCount'),
    commandPostText: document.getElementById('trustedCommandDefenseCommandPostText'),
    metaText: document.getElementById('trustedCommandDefenseMetaText'),
    logList: document.getElementById('trustedCommandDefenseLogList'),
    commandPostUrlInput: document.getElementById('trustedCommandDefenseCommandPostUrl'),
    trustedUsersTextInput: document.getElementById('trustedCommandDefenseTrustedUsersText'),
    trustedUserIdInput: document.getElementById('trustedCommandDefenseTrustedUserIdInput'),
    trustedUserLabelInput: document.getElementById('trustedCommandDefenseTrustedUserLabelInput'),
    addTrustedUserBtn: document.getElementById('trustedCommandDefenseAddTrustedUserBtn'),
    trustedUserList: document.getElementById('trustedCommandDefenseTrustedUserList'),
    commandPrefixInput: document.getElementById('trustedCommandDefenseCommandPrefix'),
    pollIntervalSecondsInput: document.getElementById('trustedCommandDefensePollIntervalSeconds'),
    holdMinutesInput: document.getElementById('trustedCommandDefenseHoldMinutes'),
    saveConfigBtn: document.getElementById('trustedCommandDefenseSaveConfigBtn'),
    resetBtn: document.getElementById('trustedCommandDefenseResetBtn'),
  },
  comment: {
    toggleBtn: document.getElementById('commentToggleBtn'),
    toggleLabel: document.getElementById('commentToggleLabel'),
    statusText: document.getElementById('commentStatusText'),
    currentPosition: document.getElementById('commentCurrentPosition'),
    totalDeleted: document.getElementById('commentTotalDeleted'),
    cycleCount: document.getElementById('commentCycleCount'),
    manualTimeLimitText: document.getElementById('commentManualTimeLimitText'),
    logList: document.getElementById('commentLogList'),
    minPageInput: document.getElementById('commentMinPage'),
    maxPageInput: document.getElementById('commentMaxPage'),
    requestDelayInput: document.getElementById('commentRequestDelay'),
    cycleDelayInput: document.getElementById('commentCycleDelay'),
    manualTimeLimitMinutesInput: document.getElementById('commentManualTimeLimitMinutes'),
    refluxSearchGalleryIdInput: document.getElementById('commentRefluxSearchGalleryId'),
    useVpnGatePrefixFilterInput: document.getElementById('commentUseVpnGatePrefixFilter'),
    vpnGatePrefixSaveBtn: document.getElementById('commentVpnGatePrefixSaveBtn'),
    postConcurrencyInput: document.getElementById('commentPostConcurrency'),
    banOnDeleteInput: document.getElementById('commentBanOnDelete'),
    excludePureHangulInput: document.getElementById('commentExcludePureHangul'),
    commentRefluxModeInput: document.getElementById('commentRefluxModeToggle'),
    avoidHourInput: document.getElementById('commentAvoidHour'),
    saveConfigBtn: document.getElementById('commentSaveConfigBtn'),
    resetBtn: document.getElementById('commentResetBtn'),
  },
  post: {
    toggleBtn: document.getElementById('postToggleBtn'),
    toggleLabel: document.getElementById('postToggleLabel'),
    statusText: document.getElementById('postStatusText'),
    currentPosition: document.getElementById('postCurrentPosition'),
    totalClassified: document.getElementById('postTotalClassified'),
    cycleCount: document.getElementById('postCycleCount'),
    manualTimeLimitText: document.getElementById('postManualTimeLimitText'),
    logList: document.getElementById('postLogList'),
    minPageInput: document.getElementById('postMinPage'),
    maxPageInput: document.getElementById('postMaxPage'),
    requestDelayInput: document.getElementById('postRequestDelay'),
    cycleDelayInput: document.getElementById('postCycleDelay'),
    manualTimeLimitMinutesInput: document.getElementById('postManualTimeLimitMinutes'),
    refluxSearchGalleryIdInput: document.getElementById('postRefluxSearchGalleryId'),
    useVpnGatePrefixFilterInput: document.getElementById('postUseVpnGatePrefixFilter'),
    vpnGatePrefixSaveBtn: document.getElementById('postVpnGatePrefixSaveBtn'),
    cjkModeToggleInput: document.getElementById('postCjkModeToggle'),
    semiconductorRefluxModeToggleInput: document.getElementById('postSemiconductorRefluxModeToggle'),
    page1NoCutoffModeToggleInput: document.getElementById('postPage1NoCutoffModeToggle'),
    saveConfigBtn: document.getElementById('postSaveConfigBtn'),
    resetBtn: document.getElementById('postResetBtn'),
  },
  semiPost: {
    toggleBtn: document.getElementById('semiPostToggleBtn'),
    toggleLabel: document.getElementById('semiPostToggleLabel'),
    statusText: document.getElementById('semiPostStatusText'),
    currentPosition: document.getElementById('semiPostCurrentPosition'),
    totalClassified: document.getElementById('semiPostTotalClassified'),
    totalSuspiciousUid: document.getElementById('semiPostTotalSuspiciousUid'),
    cycleCount: document.getElementById('semiPostCycleCount'),
    logList: document.getElementById('semiPostLogList'),
    minPageInput: document.getElementById('semiPostMinPage'),
    maxPageInput: document.getElementById('semiPostMaxPage'),
    requestDelayInput: document.getElementById('semiPostRequestDelay'),
    cycleDelayInput: document.getElementById('semiPostCycleDelay'),
    minTotalActivityCountInput: document.getElementById('semiPostMinTotalActivityCount'),
    minPostRatioPercentInput: document.getElementById('semiPostMinPostRatioPercent'),
    saveConfigBtn: document.getElementById('semiPostSaveConfigBtn'),
    resetBtn: document.getElementById('semiPostResetBtn'),
  },
  uidRatioWarning: {
    uidRatioWarningToggleBtn: document.getElementById('uidRatioWarningToggleBtn'),
    uidRatioWarningToggleLabel: document.getElementById('uidRatioWarningToggleLabel'),
    uidRatioWarningStatusText: document.getElementById('uidRatioWarningStatusText'),
    uidRatioWarningMatchedUidCount: document.getElementById('uidRatioWarningMatchedUidCount'),
    uidRatioWarningWarnedUidCount: document.getElementById('uidRatioWarningWarnedUidCount'),
    uidRatioWarningLastAppliedAt: document.getElementById('uidRatioWarningLastAppliedAt'),
    uidRatioWarningMetaText: document.getElementById('uidRatioWarningMetaText'),
  },
  uidWarningAutoBan: {
    toggleBtn: document.getElementById('uidWarningAutoBanToggleBtn'),
    toggleLabel: document.getElementById('uidWarningAutoBanToggleLabel'),
    statusText: document.getElementById('uidWarningAutoBanStatusText'),
    deleteModeText: document.getElementById('uidWarningAutoBanDeleteModeText'),
    lastPollAt: document.getElementById('uidWarningAutoBanLastPollAt'),
    nextRunAt: document.getElementById('uidWarningAutoBanNextRunAt'),
    lastPageUidCount: document.getElementById('uidWarningAutoBanLastPageUidCount'),
    lastTriggeredUid: document.getElementById('uidWarningAutoBanLastTriggeredUid'),
    lastTriggeredPostCount: document.getElementById('uidWarningAutoBanLastTriggeredPostCount'),
    lastBurstRecentCount: document.getElementById('uidWarningAutoBanLastBurstRecentCount'),
    lastSingleSightTriggeredUid: document.getElementById('uidWarningAutoBanLastSingleSightTriggeredUid'),
    lastSingleSightTriggeredPostCount: document.getElementById('uidWarningAutoBanLastSingleSightTriggeredPostCount'),
    totalTriggeredUidCount: document.getElementById('uidWarningAutoBanTotalTriggeredUidCount'),
    totalSingleSightTriggeredUidCount: document.getElementById('uidWarningAutoBanTotalSingleSightTriggeredUidCount'),
    immediateTitleRuleCount: document.getElementById('uidWarningAutoBanImmediateTitleRuleCount'),
    lastImmediateTitleBanMatchedTitle: document.getElementById('uidWarningAutoBanLastImmediateTitleBanMatchedTitle'),
    lastImmediateTitleBanCount: document.getElementById('uidWarningAutoBanLastImmediateTitleBanCount'),
    lastAttackTitleClusterCount: document.getElementById('uidWarningAutoBanLastAttackTitleClusterCount'),
    lastAttackTitleClusterPostCount: document.getElementById('uidWarningAutoBanLastAttackTitleClusterPostCount'),
    lastAttackTitleClusterRepresentative: document.getElementById('uidWarningAutoBanLastAttackTitleClusterRepresentative'),
    lastAttackCommentClusterCount: document.getElementById('uidWarningAutoBanLastAttackCommentClusterCount'),
    lastAttackCommentClusterDeleteCount: document.getElementById('uidWarningAutoBanLastAttackCommentClusterDeleteCount'),
    lastAttackCommentClusterPostCount: document.getElementById('uidWarningAutoBanLastAttackCommentClusterPostCount'),
    lastAttackCommentClusterRepresentative: document.getElementById('uidWarningAutoBanLastAttackCommentClusterRepresentative'),
    totalImmediateTitleBanPostCount: document.getElementById('uidWarningAutoBanTotalImmediateTitleBanPostCount'),
    totalAttackTitleClusterPostCount: document.getElementById('uidWarningAutoBanTotalAttackTitleClusterPostCount'),
    totalAttackCommentClusterDeleteCount: document.getElementById('uidWarningAutoBanTotalAttackCommentClusterDeleteCount'),
    totalSingleSightBannedPostCount: document.getElementById('uidWarningAutoBanTotalSingleSightBannedPostCount'),
    totalBannedPostCount: document.getElementById('uidWarningAutoBanTotalBannedPostCount'),
    totalFailedPostCount: document.getElementById('uidWarningAutoBanTotalFailedPostCount'),
    deleteLimitFallbackCount: document.getElementById('uidWarningAutoBanDeleteLimitFallbackCount'),
    banOnlyFallbackCount: document.getElementById('uidWarningAutoBanBanOnlyFallbackCount'),
    metaText: document.getElementById('uidWarningAutoBanMetaText'),
    logList: document.getElementById('uidWarningAutoBanLogList'),
    immediateTitleRuleInput: document.getElementById('uidWarningAutoBanImmediateTitleRuleInput'),
    immediateTitleRulesValueInput: document.getElementById('uidWarningAutoBanImmediateTitleRulesValue'),
    immediateTitleRuleList: document.getElementById('uidWarningAutoBanImmediateTitleRuleList'),
    addImmediateTitleRuleBtn: document.getElementById('uidWarningAutoBanAddImmediateTitleRuleBtn'),
    addImmediateTitleAndRuleBtn: document.getElementById('uidWarningAutoBanAddImmediateTitleAndRuleBtn'),
    saveConfigBtn: document.getElementById('uidWarningAutoBanSaveConfigBtn'),
    resetBtn: document.getElementById('uidWarningAutoBanResetBtn'),
  },
  ip: {
    toggleBtn: document.getElementById('ipToggleBtn'),
    toggleLabel: document.getElementById('ipToggleLabel'),
    statusText: document.getElementById('ipStatusText'),
    currentPosition: document.getElementById('ipCurrentPosition'),
    totalBanned: document.getElementById('ipTotalBanned'),
    activeBanCount: document.getElementById('ipActiveBanCount'),
    totalReleased: document.getElementById('ipTotalReleased'),
    cycleCount: document.getElementById('ipCycleCount'),
    logList: document.getElementById('ipLogList'),
    minPageInput: document.getElementById('ipMinPage'),
    maxPageInput: document.getElementById('ipMaxPage'),
    requestDelayInput: document.getElementById('ipRequestDelay'),
    cycleDelayInput: document.getElementById('ipCycleDelay'),
    releaseScanMaxPagesInput: document.getElementById('ipReleaseScanMaxPages'),
    avoidHourInput: document.getElementById('ipAvoidHour'),
    includeUidTargetsOnManualStartInput: document.getElementById('ipIncludeUidTargetsOnManualStart'),
    includeExistingTargetsOnStartInput: document.getElementById('ipIncludeExistingTargetsOnStart'),
    saveConfigBtn: document.getElementById('ipSaveConfigBtn'),
    releaseBtn: document.getElementById('ipReleaseBtn'),
    resetBtn: document.getElementById('ipResetBtn'),
  },
  monitor: {
    toggleBtn: document.getElementById('monitorToggleBtn'),
    toggleLabel: document.getElementById('monitorToggleLabel'),
    statusText: document.getElementById('monitorStatusText'),
    phaseText: document.getElementById('monitorPhaseText'),
    attackModeText: document.getElementById('monitorAttackModeText'),
    lastPollAt: document.getElementById('monitorLastPollAt'),
    newPostCount: document.getElementById('monitorNewPostCount'),
    newFluidCount: document.getElementById('monitorNewFluidCount'),
    fluidRatio: document.getElementById('monitorFluidRatio'),
    attackHitCount: document.getElementById('monitorAttackHitCount'),
    releaseHitCount: document.getElementById('monitorReleaseHitCount'),
    totalAttackDetected: document.getElementById('monitorTotalAttackDetected'),
    totalAttackReleased: document.getElementById('monitorTotalAttackReleased'),
    logList: document.getElementById('monitorLogList'),
    pollIntervalMsInput: document.getElementById('monitorPollIntervalMs'),
    pagesInput: document.getElementById('monitorPages'),
    initialSweepPagesInput: document.getElementById('monitorInitialSweepPages'),
    attackNewPostThresholdInput: document.getElementById('monitorAttackNewPostThreshold'),
    attackFluidRatioThresholdInput: document.getElementById('monitorAttackFluidRatioThreshold'),
    attackConsecutiveCountInput: document.getElementById('monitorAttackConsecutiveCount'),
    releaseNewPostThresholdInput: document.getElementById('monitorReleaseNewPostThreshold'),
    releaseFluidRatioThresholdInput: document.getElementById('monitorReleaseFluidRatioThreshold'),
    releaseConsecutiveCountInput: document.getElementById('monitorReleaseConsecutiveCount'),
    saveConfigBtn: document.getElementById('monitorSaveConfigBtn'),
    resetBtn: document.getElementById('monitorResetBtn'),
  },
};

document.addEventListener('DOMContentLoaded', async () => {
  removeHiddenFeatureTabsFromDom();
  bindTabEvents();
  bindFeatureEvents();
  bindSharedConfigEvents();
  await refreshAllStatuses();
  setInterval(refreshAllStatuses, 1000);
});

function removeHiddenFeatureTabsFromDom() {
  const hiddenFeatures = new Set(['sinmungoComment', 'selfHostedVpn']);

  document.querySelectorAll('.tab-button[data-tab]').forEach((button) => {
    const feature = String(button.dataset.tab || '').trim();
    if (hiddenFeatures.has(feature)) {
      button.remove();
    }
  });

  document.querySelectorAll('.panel[data-feature]').forEach((panel) => {
    const feature = String(panel.dataset.feature || '').trim();
    if (hiddenFeatures.has(feature)) {
      panel.remove();
    }
  });
}

function bindTabEvents() {
  featureTabs.forEach((button) => {
    button.addEventListener('click', () => {
      const nextFeature = button.dataset.tab;
      setActiveTab(nextFeature);
      if (nextFeature === 'refluxOverlayCollector') {
        void refreshRefluxOverlayCollectorOverlays();
      }
    });
  });
}

function bindFeatureEvents() {
  bindConfigDirtyTracking('conceptMonitor');
  bindConfigDirtyTracking('conceptPatrol');
  bindConfigDirtyTracking('hanRefreshIpBan');
  bindConfigDirtyTracking('bumpPost');
  bindConfigDirtyTracking('sinmungoComment');
  bindConfigDirtyTracking('selfHostedVpn');
  bindConfigDirtyTracking('refluxDatasetCollector');
  bindConfigDirtyTracking('refluxOverlayCollector');
  bindConfigDirtyTracking('commentRefluxCollector');
  bindConfigDirtyTracking('commentMonitor');
  bindConfigDirtyTracking('trustedCommandDefense');
  bindConfigDirtyTracking('comment');
  bindConfigDirtyTracking('post');
  bindConfigDirtyTracking('semiPost');
  bindConfigDirtyTracking('ip');
  bindConfigDirtyTracking('monitor');
  bindConfigDirtyTracking('uidWarningAutoBan');
  bindConceptMonitorEvents();
  bindHanRefreshIpBanEvents();
  bindBumpPostEvents();
  bindSinmungoCommentEvents();
  bindSelfHostedVpnEvents();
  bindRefluxDatasetCollectorEvents();
  bindRefluxOverlayCollectorEvents();
  bindCommentRefluxCollectorEvents();
  bindCommentMonitorEvents();
  bindTrustedCommandDefenseEvents();
  bindCommentEvents();
  bindPostEvents();
  bindSemiPostEvents();
  bindUidRatioWarningEvents();
  bindUidWarningAutoBanEvents();
  bindIpEvents();
  bindMonitorEvents();
  bindConceptPatrolEvents();
}

function bindSharedConfigEvents() {
  sharedGalleryIdInput.addEventListener('input', () => {
    sharedConfigDirty = true;
  });

  sharedHeadtextIdInput.addEventListener('input', () => {
    sharedConfigDirty = true;
  });

  sharedSaveConfigBtn.addEventListener('click', async () => {
    const galleryId = sharedGalleryIdInput.value.trim();
    const headtextIdValue = sharedHeadtextIdInput.value.trim();

    if (!galleryId) {
      alert('갤러리 ID를 입력하세요.');
      sharedGalleryIdInput.focus();
      return;
    }

    if (/\s/.test(galleryId)) {
      alert('갤러리 ID에는 공백을 넣을 수 없습니다.');
      sharedGalleryIdInput.focus();
      return;
    }

    if (!/^\d+$/.test(headtextIdValue) || Number(headtextIdValue) <= 0) {
      alert('도배기탭 번호는 1 이상의 숫자로 입력하세요.');
      sharedHeadtextIdInput.focus();
      return;
    }

    const config = {
      galleryId,
      headtextId: String(Number(headtextIdValue)),
    };

    const response = await sendMessage({ action: 'updateSharedConfig', config });
    if (!response?.success) {
      alert(response?.message || '공통 설정 저장에 실패했습니다.');
      return;
    }

    sharedConfigDirty = false;
    flashSaved(sharedSaveConfigBtn);
    if (response.statuses) {
      applyStatuses(response.statuses);
    }
  });

  [
    SESSION_FALLBACK_DOM.keepaliveToggle,
    SESSION_FALLBACK_DOM.primaryUserIdInput,
    SESSION_FALLBACK_DOM.primaryPasswordInput,
    SESSION_FALLBACK_DOM.backupUserIdInput,
    SESSION_FALLBACK_DOM.backupPasswordInput,
  ].forEach((input) => {
    input.addEventListener('input', () => {
      sessionFallbackDirty = true;
    });
  });

  SESSION_FALLBACK_DOM.keepaliveToggle.addEventListener('change', async () => {
    if (hasPendingSessionFallbackCredentialEdits()) {
      alert('계정 아이디/비밀번호 변경분이 있으면 먼저 계정 저장을 눌러주세요.');
      revertSessionFallbackKeepaliveToggle();
      return;
    }

    await persistSessionFallbackConfig({
      failureMessage: '로그인 세션 자동화 설정 저장에 실패했습니다.',
      suppressFlash: true,
      revertOnFailure: true,
    });
  });

  SESSION_FALLBACK_DOM.saveConfigBtn.addEventListener('click', async () => {
    await persistSessionFallbackConfig();
  });

  SESSION_FALLBACK_DOM.testSwitchBtn.addEventListener('click', async () => {
    if (sessionFallbackDirty) {
      alert('계정 정보를 먼저 저장하세요.');
      return;
    }

    let response = null;
    setDisabled(SESSION_FALLBACK_DOM.testSwitchBtn, true);
    try {
      response = await sendMessage({ action: 'testSessionFallbackSwitch' });
      if (!response?.success) {
        alert(response?.message || '계정 전환 테스트에 실패했습니다.');
        if (response?.sessionFallbackStatus) {
          updateSessionFallbackUI(response.sessionFallbackStatus);
        }
        if (response?.statuses) {
          applyStatuses(response.statuses);
        }
        return;
      }

      if (response?.sessionFallbackStatus) {
        updateSessionFallbackUI(response.sessionFallbackStatus);
      }
      if (response?.statuses) {
        applyStatuses(response.statuses);
      }
      flashSaved(SESSION_FALLBACK_DOM.testSwitchBtn, '✅ 전환 완료');
      alert(response?.message || '계정 전환 테스트가 완료되었습니다.');
    } finally {
      if (!response?.sessionFallbackStatus?.switchInProgress
        && !response?.sessionFallbackStatus?.sessionAutomationInProgress) {
        setDisabled(SESSION_FALLBACK_DOM.testSwitchBtn, false);
      }
    }
  });
}

function bindConceptMonitorEvents() {
  const dom = FEATURE_DOM.conceptMonitor;

  dom.autoCutEnabledInput.addEventListener('change', () => {
    updateToggle({ toggleBtn: dom.autoCutEnabledInput, toggleLabel: dom.autoCutEnabledLabel }, dom.autoCutEnabledInput.checked);
  });

  dom.toggleBtn.addEventListener('change', async () => {
    if (dom.toggleBtn.checked) {
      if (!latestConceptMonitorStatus) {
        await refreshAllStatuses();
      }

      if (!latestConceptMonitorStatus) {
        alert('개념글 방어 상태를 아직 불러오지 못했습니다. 잠시 후 다시 시도하세요.');
        updateToggle(dom, false);
        return;
      }

      if (DIRTY_FEATURES.conceptMonitor) {
        alert('개념글 방어 설정 변경사항을 먼저 저장하세요.');
        updateToggle(dom, false);
        return;
      }

      if (latestConceptMonitorStatus?.config?.testMode === false
        && !confirm('실행 모드에서는 실제로 개념글 해제를 요청합니다. 계속하시겠습니까?')) {
        updateToggle(dom, false);
        return;
      }
    }

    const action = dom.toggleBtn.checked ? 'start' : 'stop';
    const response = await sendFeatureMessage('conceptMonitor', { action });
    if (!response?.success) {
      if (response?.message) {
        alert(response.message);
      }
      await refreshAllStatuses();
      return;
    }

    DIRTY_FEATURES.conceptMonitor = false;
    if (response.statuses) {
      applyStatuses(response.statuses);
    } else {
      await refreshAllStatuses();
    }
  });

  dom.saveConfigBtn.addEventListener('click', async () => {
    const nextTestMode = dom.testModeInput.checked;
    if (latestConceptMonitorStatus?.config?.testMode === true
      && nextTestMode === false
      && !confirm('테스트 모드를 끄면 실제 개념글 해제를 실행할 수 있습니다. 저장하시겠습니까?')) {
      return;
    }

    const config = {
      pollIntervalMs: Math.max(1000, parseOptionalInt(dom.pollIntervalMsInput.value, 30000)),
      snapshotPostLimit: Math.max(1, parseOptionalInt(dom.snapshotPostLimitInput.value, 5)),
      fluidRatioThresholdPercent: clampPercent(dom.fluidRatioThresholdInput.value, 88, 0),
      testMode: nextTestMode,
      autoCutEnabled: dom.autoCutEnabledInput.checked,
      autoCutPollIntervalMs: Math.max(1000, parseOptionalInt(dom.autoCutPollIntervalMsInput.value, 30000)),
      autoCutAttackRecommendThreshold: Math.max(0, parseOptionalInt(dom.autoCutAttackThresholdInput.value, 25)),
      autoCutAttackConsecutiveCount: Math.max(1, parseOptionalInt(dom.autoCutAttackConsecutiveCountInput.value, 1)),
      autoCutReleaseRecommendThreshold: Math.max(0, parseOptionalInt(dom.autoCutReleaseThresholdInput.value, 15)),
      autoCutReleaseConsecutiveCount: Math.max(1, parseOptionalInt(dom.autoCutReleaseConsecutiveCountInput.value, 5)),
    };

    const response = await sendFeatureMessage('conceptMonitor', { action: 'updateConfig', config });
    if (!response?.success) {
      if (response?.message) {
        alert(response.message);
      }
      await refreshAllStatuses();
      return;
    }

    DIRTY_FEATURES.conceptMonitor = false;
    flashSaved(dom.saveConfigBtn);
    if (response.statuses) {
      applyStatuses(response.statuses);
    } else {
      await refreshAllStatuses();
    }
  });

  dom.resetBtn.addEventListener('click', async () => {
    if (!confirm('개념글 방어 통계와 로그를 초기화하시겠습니까?')) {
      return;
    }

    const response = await sendFeatureMessage('conceptMonitor', { action: 'resetStats' });
    if (!response?.success) {
      if (response?.message) {
        alert(response.message);
      }
      await refreshAllStatuses();
      return;
    }

    if (response.statuses) {
      applyStatuses(response.statuses);
    } else {
      await refreshAllStatuses();
    }
  });
}

function bindConceptPatrolEvents() {
  const dom = FEATURE_DOM.conceptPatrol;

  dom.toggleBtn.addEventListener('change', async () => {
    if (dom.toggleBtn.checked) {
      if (!latestConceptPatrolStatus) {
        await refreshAllStatuses();
      }

      if (!latestConceptPatrolStatus) {
        alert('개념글순회 상태를 아직 불러오지 못했습니다. 잠시 후 다시 시도하세요.');
        updateToggle(dom, false);
        return;
      }

      if (DIRTY_FEATURES.conceptPatrol) {
        alert('개념글순회 설정 변경사항을 먼저 저장하세요.');
        updateToggle(dom, false);
        return;
      }

      if (latestConceptPatrolStatus?.config?.testMode === false
        && !confirm('실행 모드에서는 실제로 개념글 해제를 요청합니다. 계속하시겠습니까?')) {
        updateToggle(dom, false);
        return;
      }
    }

    const action = dom.toggleBtn.checked ? 'start' : 'stop';
    const response = await sendFeatureMessage('conceptPatrol', { action });
    if (!response?.success) {
      if (response?.message) {
        alert(response.message);
      }
      await refreshAllStatuses();
      return;
    }

    DIRTY_FEATURES.conceptPatrol = false;
    if (response.statuses) {
      applyStatuses(response.statuses);
    } else {
      await refreshAllStatuses();
    }
  });

  dom.saveConfigBtn.addEventListener('click', async () => {
    const nextTestMode = dom.testModeInput.checked;
    if (latestConceptPatrolStatus?.config?.testMode === true
      && nextTestMode === false
      && !confirm('테스트 모드를 끄면 실제 개념글 해제를 실행할 수 있습니다. 저장하시겠습니까?')) {
      return;
    }

    const config = {
      pollIntervalMs: Math.max(1000, parseOptionalInt(dom.pollIntervalMsInput.value, 30000)),
      patrolPages: Math.max(1, parseOptionalInt(dom.patrolPagesInput.value, 5)),
      pageRequestDelayMs: Math.max(0, parseOptionalInt(dom.pageRequestDelayInput.value, 500)),
      fluidRatioThresholdPercent: clampPercent(dom.fluidRatioThresholdInput.value, 90, 0),
      patrolDefendingCandidateThreshold: Math.max(1, parseOptionalInt(dom.candidateThresholdInput.value, 2)),
      patrolDefendingHoldMs: Math.max(1000, parseOptionalInt(dom.holdMsInput.value, 300000)),
      testMode: nextTestMode,
    };

    const response = await sendFeatureMessage('conceptPatrol', { action: 'updateConfig', config });
    if (!response?.success) {
      if (response?.message) {
        alert(response.message);
      }
      await refreshAllStatuses();
      return;
    }

    DIRTY_FEATURES.conceptPatrol = false;
    flashSaved(dom.saveConfigBtn);
    if (response.statuses) {
      applyStatuses(response.statuses);
    } else {
      await refreshAllStatuses();
    }
  });

  dom.resetBtn.addEventListener('click', async () => {
    if (!confirm('개념글순회 통계와 baseline, 로그를 초기화하시겠습니까?')) {
      return;
    }

    const response = await sendFeatureMessage('conceptPatrol', { action: 'resetStats' });
    if (!response?.success) {
      if (response?.message) {
        alert(response.message);
      }
      await refreshAllStatuses();
      return;
    }

    if (response.statuses) {
      applyStatuses(response.statuses);
    } else {
      await refreshAllStatuses();
    }
  });
}

function bindHanRefreshIpBanEvents() {
  const dom = FEATURE_DOM.hanRefreshIpBan;

  dom.toggleBtn.addEventListener('change', async () => {
    const action = dom.toggleBtn.checked ? 'start' : 'stop';
    const response = await sendFeatureMessage('hanRefreshIpBan', { action });
    if (!response?.success) {
      if (response?.message) {
        alert(response.message);
      }
      await refreshAllStatuses();
      return;
    }

    DIRTY_FEATURES.hanRefreshIpBan = false;
    if (response.statuses) {
      applyStatuses(response.statuses);
    } else {
      await refreshAllStatuses();
    }
  });

  dom.saveConfigBtn.addEventListener('click', async () => {
    const config = {
      requestDelay: Math.max(0, parseOptionalInt(dom.requestDelayInput.value, 500)),
      fallbackMaxPage: Math.max(1, parseOptionalInt(dom.fallbackMaxPageInput.value, 400)),
    };

    const response = await sendFeatureMessage('hanRefreshIpBan', { action: 'updateConfig', config });
    if (!response?.success) {
      if (response?.message) {
        alert(response.message);
      }
      await refreshAllStatuses();
      return;
    }

    DIRTY_FEATURES.hanRefreshIpBan = false;
    flashSaved(dom.saveConfigBtn);
    if (response.statuses) {
      applyStatuses(response.statuses);
    } else {
      await refreshAllStatuses();
    }
  });

  dom.resetBtn.addEventListener('click', async () => {
    if (!confirm('도배기 갱신 차단 자동 통계와 로그를 초기화하시겠습니까?')) {
      return;
    }

    const response = await sendFeatureMessage('hanRefreshIpBan', { action: 'resetStats' });
    if (!response?.success) {
      if (response?.message) {
        alert(response.message);
      }
      await refreshAllStatuses();
      return;
    }

    if (response.statuses) {
      applyStatuses(response.statuses);
    } else {
      await refreshAllStatuses();
    }
  });
}

function bindBumpPostEvents() {
  const dom = FEATURE_DOM.bumpPost;

  dom.toggleBtn.addEventListener('change', async () => {
    const action = dom.toggleBtn.checked ? 'start' : 'stop';

    if (action === 'start' && DIRTY_FEATURES.bumpPost) {
      alert('끌올 자동 설정을 먼저 저장하세요.');
      await refreshAllStatuses();
      return;
    }

    if (action === 'start') {
      const postNo = normalizeBumpPostPostNoInputValue(dom.postNoInput.value);
      if (!postNo) {
        alert('게시물 번호를 입력하세요.');
        dom.postNoInput.focus();
        await refreshAllStatuses();
        return;
      }

      if (!isValidBumpPostPostNo(postNo)) {
        alert('게시물 번호는 숫자만 입력하세요.');
        dom.postNoInput.focus();
        dom.postNoInput.select();
        await refreshAllStatuses();
        return;
      }
    }

    const response = await sendFeatureMessage('bumpPost', { action });
    if (!response?.success) {
      if (response?.message) {
        alert(response.message);
      }
      await refreshAllStatuses();
      return;
    }

    if (response.statuses) {
      applyStatuses(response.statuses);
    } else {
      await refreshAllStatuses();
    }
  });

  dom.saveConfigBtn.addEventListener('click', async () => {
    const postNo = normalizeBumpPostPostNoInputValue(dom.postNoInput.value);
    if (postNo && !isValidBumpPostPostNo(postNo)) {
      alert('게시물 번호는 숫자만 입력하세요.');
      dom.postNoInput.focus();
      dom.postNoInput.select();
      return;
    }

    const config = {
      postNo,
      durationMinutes: Math.max(1, parseOptionalInt(dom.durationMinutesInput.value, 60)),
      intervalMinutes: Math.max(1, parseOptionalInt(dom.intervalMinutesInput.value, 1)),
    };

    const response = await sendFeatureMessage('bumpPost', { action: 'updateConfig', config });
    if (!response?.success) {
      if (response?.message) {
        alert(response.message);
      }
      await refreshAllStatuses();
      return;
    }

    DIRTY_FEATURES.bumpPost = false;
    flashSaved(dom.saveConfigBtn);
    if (response.statuses) {
      applyStatuses(response.statuses);
    } else {
      await refreshAllStatuses();
    }
  });

  dom.resetBtn.addEventListener('click', async () => {
    if (!confirm('끌올 자동 통계와 로그를 초기화하시겠습니까?')) {
      return;
    }

    const response = await sendFeatureMessage('bumpPost', { action: 'resetStats' });
    if (!response?.success) {
      if (response?.message) {
        alert(response.message);
      }
      await refreshAllStatuses();
      return;
    }

    if (response.statuses) {
      applyStatuses(response.statuses);
    } else {
      await refreshAllStatuses();
    }
  });
}

function bindSinmungoCommentEvents() {
  const dom = FEATURE_DOM.sinmungoComment;
  const isAnonymousModeSelected = () => String(dom.submitModeInput.value || 'member').trim().toLowerCase() === 'anonymous';

  dom.submitModeInput.addEventListener('change', () => {
    syncSinmungoCommentModeInputs();
  });

  dom.toggleBtn.addEventListener('change', async () => {
    const action = dom.toggleBtn.checked ? 'start' : 'stop';

    if (action === 'start' && DIRTY_FEATURES.sinmungoComment) {
      alert('신문고 댓글 설정을 먼저 저장하세요.');
      await refreshAllStatuses();
      return;
    }

    if (action === 'start') {
      const postNo = normalizeSinmungoCommentPostNoInputValue(dom.postNoInput.value);
      if (!postNo) {
        alert('게시물 번호를 입력하세요.');
        dom.postNoInput.focus();
        await refreshAllStatuses();
        return;
      }

      if (!isValidSinmungoCommentPostNo(postNo)) {
        alert('게시물 번호는 숫자만 입력하세요.');
        dom.postNoInput.focus();
        dom.postNoInput.select();
        await refreshAllStatuses();
        return;
      }

      if (!normalizeSinmungoCommentMemoInputValue(dom.memoInput.value)) {
        alert('댓글 문구를 입력하세요.');
        dom.memoInput.focus();
        await refreshAllStatuses();
        return;
      }

      if (isAnonymousModeSelected()) {
        const password = normalizeSinmungoCommentPasswordInputValue(dom.passwordInput.value);
        if (password.length < 2) {
          alert('유동/비회원 테스트 비밀번호는 2자 이상 입력하세요.');
          dom.passwordInput.focus();
          dom.passwordInput.select();
          await refreshAllStatuses();
          return;
        }
      }
    }

    const response = await sendFeatureMessage('sinmungoComment', { action });
    if (!response?.success) {
      if (response?.message) {
        alert(response.message);
      }
      await refreshAllStatuses();
      return;
    }

    if (response.statuses) {
      applyStatuses(response.statuses);
    } else {
      await refreshAllStatuses();
    }
  });

  dom.saveConfigBtn.addEventListener('click', async () => {
    const postNo = normalizeSinmungoCommentPostNoInputValue(dom.postNoInput.value);
    const memo = normalizeSinmungoCommentMemoInputValue(dom.memoInput.value);
    const submitMode = String(dom.submitModeInput.value || 'member').trim().toLowerCase();
    const password = normalizeSinmungoCommentPasswordInputValue(dom.passwordInput.value);
    const anonymousName = normalizeSinmungoCommentDisplayNameInputValue(dom.anonymousNameInput.value);

    if (postNo && !isValidSinmungoCommentPostNo(postNo)) {
      alert('게시물 번호는 숫자만 입력하세요.');
      dom.postNoInput.focus();
      dom.postNoInput.select();
      return;
    }

    if (!memo) {
      alert('댓글 문구를 입력하세요.');
      dom.memoInput.focus();
      return;
    }

    if (submitMode === 'anonymous' && password.length < 2) {
      alert('유동/비회원 테스트 비밀번호는 2자 이상 입력하세요.');
      dom.passwordInput.focus();
      dom.passwordInput.select();
      return;
    }

    const config = {
      postNo,
      submitMode,
      memo,
      name: submitMode === 'anonymous'
        ? anonymousName
        : '',
      password: submitMode === 'anonymous'
        ? password
        : '',
    };

    const response = await sendFeatureMessage('sinmungoComment', { action: 'updateConfig', config });
    if (!response?.success) {
      if (response?.message) {
        alert(response.message);
      }
      await refreshAllStatuses();
      return;
    }

    DIRTY_FEATURES.sinmungoComment = false;
    flashSaved(dom.saveConfigBtn);
    if (response.statuses) {
      applyStatuses(response.statuses);
    } else {
      await refreshAllStatuses();
    }
  });

  dom.refreshCaptchaBtn.addEventListener('click', async () => {
    const response = await sendFeatureMessage('sinmungoComment', { action: 'refreshManualChallenge' });
    if (!response?.success) {
      if (response?.message) {
        alert(response.message);
      }
      await refreshAllStatuses();
      return;
    }

    if (response.statuses) {
      applyStatuses(response.statuses);
    } else {
      await refreshAllStatuses();
    }
  });

  dom.submitCaptchaBtn.addEventListener('click', async () => {
    const pendingChallenge = latestSinmungoCommentStatus?.pendingChallenge || null;
    const code = normalizeSinmungoCommentChallengeCodeInputValue(dom.codeInput.value);
    const challengeName = normalizeSinmungoCommentDisplayNameInputValue(dom.challengeNameInput.value);

    if (pendingChallenge?.requiresCode && !code) {
      alert('인증코드를 입력하세요.');
      dom.codeInput.focus();
      return;
    }

    if (pendingChallenge?.nameEditable && !challengeName) {
      alert('유동 닉네임을 입력하세요.');
      dom.challengeNameInput.focus();
      return;
    }

    const response = await sendFeatureMessage('sinmungoComment', {
      action: 'submitManualChallenge',
      code,
      name: challengeName,
    });
    if (!response?.success) {
      if (response?.message) {
        alert(response.message);
      }
      await refreshAllStatuses();
      return;
    }

    if (response.statuses) {
      applyStatuses(response.statuses);
    } else {
      await refreshAllStatuses();
    }
  });

  dom.cancelCaptchaBtn.addEventListener('click', async () => {
    const response = await sendFeatureMessage('sinmungoComment', { action: 'cancelManualChallenge' });
    if (!response?.success) {
      if (response?.message) {
        alert(response.message);
      }
      await refreshAllStatuses();
      return;
    }

    if (response.statuses) {
      applyStatuses(response.statuses);
    } else {
      await refreshAllStatuses();
    }
  });

  dom.resetBtn.addEventListener('click', async () => {
    if (!confirm('신문고 댓글 등록 통계와 로그를 초기화하시겠습니까?')) {
      return;
    }

    const response = await sendFeatureMessage('sinmungoComment', { action: 'resetStats' });
    if (!response?.success) {
      if (response?.message) {
        alert(response.message);
      }
      await refreshAllStatuses();
      return;
    }

    DIRTY_FEATURES.sinmungoComment = false;
    if (response.statuses) {
      applyStatuses(response.statuses);
    } else {
      await refreshAllStatuses();
    }
  });
}

function bindSelfHostedVpnEvents() {
  const dom = FEATURE_DOM.selfHostedVpn;
  updateSelfHostedVpnConfigModeFields();
  const alertSelfHostedVpnFailure = (message = '') => {
    const normalizedMessage = String(message || '').trim();
    if (!normalizedMessage) {
      return;
    }

    if (/예전 버전|지원하지 않는 경로|HTTP 404/i.test(normalizedMessage)) {
      alert('실행 중인 local agent가 예전 버전이거나 포트가 꼬였을 수 있습니다. 바로 아래 실행 안내 카드의 기본 실행 명령으로 다시 켜고, 안 되면 대체 포트 명령을 쓰세요.');
      return;
    }

    if (/local agent 요청 시간 초과/i.test(normalizedMessage)) {
      alert('local agent는 살아 있지만 이번 작업 응답이 너무 오래 걸렸습니다.\n\n예를 들어 VPN1~200 준비는 NIC를 많이 만들고 확인하느라 수십 초 이상 걸릴 수 있습니다.\n잠시 후 상태 새로고침으로 확인하거나, 최신 패치 반영 후 다시 시도하세요.\n\n원본 오류:\n' + normalizedMessage);
      return;
    }

    if (/(local agent 요청 실패|local agent health 확인 실패|Failed to fetch|fetch failed|ECONNREFUSED|ERR_CONNECTION_REFUSED|ERR_CONNECTION_TIMED_OUT|local agent에 연결할 수 없습니다)/i.test(normalizedMessage)) {
      alert('local agent가 아직 준비되지 않았습니다. 바로 아래 "local agent 실행 안내" 카드에서 실행 명령을 복사해 PowerShell에서 켠 뒤 다시 시도하세요.');
      return;
    }

    alert(normalizedMessage);
  };

  dom.copyAgentStartBtn?.addEventListener('click', async () => {
    const guideState = buildSelfHostedVpnAgentGuideState(latestSelfHostedVpnStatus || buildDefaultSelfHostedVpnStatus());
    updateSelfHostedVpnAgentGuidePreview('primary', guideState);
    const copied = await copyTextToClipboard(guideState.primaryCommand);
    if (!copied) {
      alert('실행 명령 복사에 실패했습니다. 미리보기 박스 내용을 직접 복사하세요.');
      return;
    }
    flashSaved(dom.copyAgentStartBtn, '✅ 복사됨');
  });

  dom.copyAgentFallbackBtn?.addEventListener('click', async () => {
    const guideState = buildSelfHostedVpnAgentGuideState(latestSelfHostedVpnStatus || buildDefaultSelfHostedVpnStatus());
    updateSelfHostedVpnAgentGuidePreview('fallback', guideState);
    const copied = await copyTextToClipboard(guideState.fallbackCommand);
    if (!copied) {
      alert('대체 포트 명령 복사에 실패했습니다. 미리보기 박스 내용을 직접 복사하세요.');
      return;
    }
    flashSaved(dom.copyAgentFallbackBtn, '✅ 복사됨');
  });

  dom.copyAgentStopBtn?.addEventListener('click', async () => {
    const guideState = buildSelfHostedVpnAgentGuideState(latestSelfHostedVpnStatus || buildDefaultSelfHostedVpnStatus());
    updateSelfHostedVpnAgentGuidePreview('stop', guideState);
    const copied = await copyTextToClipboard(guideState.stopCommand);
    if (!copied) {
      alert('종료 명령 복사에 실패했습니다. 미리보기 박스 내용을 직접 복사하세요.');
      return;
    }
    flashSaved(dom.copyAgentStopBtn, '✅ 복사됨');
  });

  dom.useFallbackAgentUrlBtn?.addEventListener('click', () => {
    const guideState = buildSelfHostedVpnAgentGuideState(latestSelfHostedVpnStatus || buildDefaultSelfHostedVpnStatus());
    updateSelfHostedVpnAgentGuidePreview('fallback', guideState);
    if (dom.settingsDetails) {
      dom.settingsDetails.open = true;
    }
    dom.agentBaseUrlInput.value = guideState.fallbackUrl;
    DIRTY_FEATURES.selfHostedVpn = true;
    flashSaved(dom.useFallbackAgentUrlBtn, `${guideState.fallbackPort} 입력됨`);
    dom.agentBaseUrlInput.focus();
    dom.agentBaseUrlInput.select();
  });

  dom.toggleBtn.addEventListener('change', async () => {
    const action = dom.toggleBtn.checked ? 'start' : 'stop';

    if (action === 'start' && DIRTY_FEATURES.selfHostedVpn) {
      alert('자체 VPN 테스트 설정을 먼저 저장하세요.');
      await refreshAllStatuses();
      return;
    }

    const response = await sendFeatureMessage('selfHostedVpn', { action });
    if (!response?.success) {
      alertSelfHostedVpnFailure(response?.message);
      await refreshAllStatuses();
      return;
    }

    if (response.statuses) {
      applyStatuses(response.statuses);
    } else {
      await refreshAllStatuses();
    }
  });

  dom.saveConfigBtn.addEventListener('click', async () => {
    const relayHostUniqueKey = normalizeSelfHostedVpnHostUniqueKey(dom.relayHostUniqueKeyInput.value);
    if (relayHostUniqueKey && !/^[0-9A-F]{40}$/.test(relayHostUniqueKey)) {
      alert('HostUniqueKey는 40자리 hex 문자열만 입력하세요.');
      dom.relayHostUniqueKeyInput.focus();
      dom.relayHostUniqueKeyInput.select();
      return;
    }

    const config = {
      agentBaseUrl: dom.agentBaseUrlInput.value.trim(),
      authToken: dom.authTokenInput.value,
      connectionMode: 'softether_vpngate_raw',
      profileId: '',
      selectedRelayId: dom.relayIdInput.value.trim(),
      selectedSslPort: parseOptionalInt(dom.selectedSslPortInput.value, 0),
      relaySnapshot: {
        id: dom.relayIdInput.value.trim(),
        fqdn: dom.relayFqdnInput.value.trim(),
        ip: dom.relayIpInput.value.trim(),
        udpPort: parseOptionalInt(dom.relayUdpPortInput.value, 0),
        hostUniqueKey: relayHostUniqueKey,
      },
      requestTimeoutMs: Math.max(3000, parseOptionalInt(dom.requestTimeoutMsInput.value, 3000)),
      actionTimeoutMs: Math.max(15000, parseOptionalInt(dom.actionTimeoutMsInput.value, 15000)),
    };

    const response = await sendFeatureMessage('selfHostedVpn', { action: 'updateConfig', config });
    if (!response?.success) {
      alertSelfHostedVpnFailure(response?.message);
      await refreshAllStatuses();
      return;
    }

    DIRTY_FEATURES.selfHostedVpn = false;
    flashSaved(dom.saveConfigBtn);
    if (response.statuses) {
      applyStatuses(response.statuses);
    } else {
      await refreshAllStatuses();
    }
  });

  dom.refreshBtn.addEventListener('click', async () => {
    const response = await sendFeatureMessage('selfHostedVpn', { action: 'refreshStatus' });
    if (!response?.success) {
      alertSelfHostedVpnFailure(response?.message);
      await refreshAllStatuses();
      return;
    }

    if (response.statuses) {
      applyStatuses(response.statuses);
    } else {
      await refreshAllStatuses();
    }
  });

  dom.primeNicsBtn.addEventListener('click', async () => {
    if (DIRTY_FEATURES.selfHostedVpn) {
      alert('자체 VPN 테스트 설정을 먼저 저장하세요.');
      await refreshAllStatuses();
      return;
    }

    const response = await sendFeatureMessage('selfHostedVpn', { action: 'primeCatalogNics' });
    if (!response?.success) {
      alertSelfHostedVpnFailure(response?.message);
      await refreshAllStatuses();
      return;
    }

    const nextStatus = response.statuses?.selfHostedVpn || response.status;
    const logs = Array.isArray(nextStatus?.logs) ? nextStatus.logs : [];
    const latestLog = logs[0] || '';
    if (latestLog) {
      alert(`VPN1~200 준비 결과\n${latestLog}`);
    }

    if (response.statuses) {
      applyStatuses(response.statuses);
    } else {
      await refreshAllStatuses();
    }
  });

  dom.catalogList?.addEventListener('click', async (event) => {
    const connectButton = event.target.closest('[data-self-hosted-vpn-catalog-connect]');
    if (!connectButton) {
      return;
    }

    const slotId = String(connectButton.dataset.slotId || '').trim();
    const lookupKey = String(connectButton.dataset.lookupKey || '').trim();
    if (!slotId && !lookupKey) {
      return;
    }

    if (DIRTY_FEATURES.selfHostedVpn) {
      alert('자체 VPN 테스트 설정을 먼저 저장하세요.');
      await refreshAllStatuses();
      return;
    }

    const catalog = normalizeSelfHostedVpnRawRelayCatalogStatus(latestSelfHostedVpnStatus?.rawRelayCatalog || {});
    const relay = catalog.items.find((item) => (
      (slotId && item.slotId === slotId)
      || (lookupKey && item.lookupKey === lookupKey)
    ));
    if (!relay) {
      alert('선택한 live pool 슬롯을 현재 목록에서 찾지 못했습니다. 먼저 상태를 새로고침하세요.');
      await refreshAllStatuses();
      return;
    }

    const response = await sendFeatureMessage('selfHostedVpn', {
      action: 'activateCatalogRelay',
      relay,
    });
    if (!response?.success) {
      alertSelfHostedVpnFailure(response?.message);
      await refreshAllStatuses();
      return;
    }

    if (response.statuses) {
      applyStatuses(response.statuses);
    } else {
      await refreshAllStatuses();
    }
  });

  dom.parallelStartBtn.addEventListener('click', async () => {
    if (DIRTY_FEATURES.selfHostedVpn) {
      alert('자체 VPN 테스트 설정을 먼저 저장하세요.');
      await refreshAllStatuses();
      return;
    }

    const response = await sendFeatureMessage('selfHostedVpn', { action: 'startParallelProbe' });
    if (!response?.success) {
      alertSelfHostedVpnFailure(response?.message);
      await refreshAllStatuses();
      return;
    }

    if (response.statuses) {
      applyStatuses(response.statuses);
    } else {
      await refreshAllStatuses();
    }
  });

  dom.parallelRefreshBtn.addEventListener('click', async () => {
    const response = await sendFeatureMessage('selfHostedVpn', { action: 'refreshParallelProbeStatus' });
    if (!response?.success) {
      alertSelfHostedVpnFailure(response?.message);
      await refreshAllStatuses();
      return;
    }

    if (response.statuses) {
      applyStatuses(response.statuses);
    } else {
      await refreshAllStatuses();
    }
  });

  dom.parallelStopBtn.addEventListener('click', async () => {
    const response = await sendFeatureMessage('selfHostedVpn', { action: 'stopParallelProbe' });
    if (!response?.success) {
      alertSelfHostedVpnFailure(response?.message);
      await refreshAllStatuses();
      return;
    }

    if (response.statuses) {
      applyStatuses(response.statuses);
    } else {
      await refreshAllStatuses();
    }
  });

  dom.resetBtn.addEventListener('click', async () => {
    if (!confirm('자체 VPN 테스트 상태 기록과 로그를 초기화하시겠습니까?')) {
      return;
    }

    const response = await sendFeatureMessage('selfHostedVpn', { action: 'resetStats' });
    if (!response?.success) {
      alertSelfHostedVpnFailure(response?.message);
      await refreshAllStatuses();
      return;
    }

    if (response.statuses) {
      applyStatuses(response.statuses);
    } else {
      await refreshAllStatuses();
    }
  });
}

function bindRefluxDatasetCollectorEvents() {
  const dom = FEATURE_DOM.refluxDatasetCollector;

  dom.toggleBtn.addEventListener('change', async () => {
    const action = dom.toggleBtn.checked ? 'start' : 'stop';

    if (action === 'start' && DIRTY_FEATURES.refluxDatasetCollector) {
      alert('Local 수집 설정을 먼저 저장하세요.');
      await refreshAllStatuses();
      return;
    }

    if (action === 'start') {
      const galleryId = normalizeRefluxDatasetCollectorGalleryId(dom.galleryIdInput.value);
      if (!galleryId) {
        alert('갤 ID를 입력하세요.');
        dom.galleryIdInput.focus();
        await refreshAllStatuses();
        return;
      }

      if (!isValidRefluxDatasetCollectorGalleryId(galleryId)) {
        alert('갤 ID는 영문/숫자/밑줄만 입력하세요.');
        dom.galleryIdInput.focus();
        dom.galleryIdInput.select();
        await refreshAllStatuses();
        return;
      }
    }

    const response = await sendFeatureMessage('refluxDatasetCollector', { action });
    if (!response?.success) {
      if (response?.message) {
        alert(response.message);
      }
      await refreshAllStatuses();
      return;
    }

    if (response.statuses) {
      applyStatuses(response.statuses);
    } else {
      await refreshAllStatuses();
    }
  });

  dom.saveConfigBtn.addEventListener('click', async () => {
    const galleryId = normalizeRefluxDatasetCollectorGalleryId(dom.galleryIdInput.value);
    if (galleryId && !isValidRefluxDatasetCollectorGalleryId(galleryId)) {
      alert('갤 ID는 영문/숫자/밑줄만 입력하세요.');
      dom.galleryIdInput.focus();
      dom.galleryIdInput.select();
      return;
    }

    const startPage = Math.max(1, parseOptionalInt(dom.startPageInput.value, 1));
    const endPage = Math.max(startPage, parseOptionalInt(dom.endPageInput.value, startPage));
    const requestDelayMs = Math.max(500, parseOptionalInt(dom.requestDelayMsInput.value, 1200));
    const jitterMs = Math.max(0, parseOptionalInt(dom.jitterMsInput.value, 400));

    const config = {
      galleryId,
      startPage,
      endPage,
      requestDelayMs,
      jitterMs,
    };

    const response = await sendFeatureMessage('refluxDatasetCollector', { action: 'updateConfig', config });
    if (!response?.success) {
      if (response?.message) {
        alert(response.message);
      }
      await refreshAllStatuses();
      return;
    }

    DIRTY_FEATURES.refluxDatasetCollector = false;
    flashSaved(dom.saveConfigBtn);
    if (response.statuses) {
      applyStatuses(response.statuses);
    } else {
      await refreshAllStatuses();
    }
  });

  dom.downloadBtn.addEventListener('click', async () => {
    const response = await sendFeatureMessage('refluxDatasetCollector', { action: 'downloadExportJson' });
    if (!response?.success) {
      if (response?.message) {
        alert(response.message);
      }
      await refreshAllStatuses();
      return;
    }

    let titles;
    try {
      titles = await loadRefluxCollectorTitlesForRunInPopup(response.runId);
    } catch (error) {
      alert(`IndexedDB 제목 로드 실패 - ${error.message}`);
      await refreshAllStatuses();
      return;
    }

    if (!Array.isArray(titles) || titles.length <= 0) {
      alert('IndexedDB에 저장된 제목이 비어 있습니다.');
      await refreshAllStatuses();
      return;
    }

    const payload = buildRefluxCollectorExportPayload({
      version: response.version,
      updatedAt: response.updatedAt,
      collectedGalleryId: response.collectedGalleryId,
      titles,
    });
    const blob = new Blob(
      [JSON.stringify(payload, null, 2)],
      { type: 'application/json;charset=utf-8' },
    );
    const objectUrl = URL.createObjectURL(blob);
    const downloadAnchor = document.createElement('a');
    downloadAnchor.href = objectUrl;
    downloadAnchor.download = String(response.fileName || 'reflux-title-set.json');
    downloadAnchor.click();
    URL.revokeObjectURL(objectUrl);

    flashSaved(dom.downloadBtn, '✅ 다운로드');
    if (response.statuses) {
      applyStatuses(response.statuses);
    } else {
      await refreshAllStatuses();
    }
  });

  dom.resetBtn.addEventListener('click', async () => {
    if (!confirm('Local 수집 통계와 로그, 다운로드 대기 데이터를 초기화하시겠습니까?')) {
      return;
    }

    const response = await sendFeatureMessage('refluxDatasetCollector', { action: 'resetStats' });
    if (!response?.success) {
      if (response?.message) {
        alert(response.message);
      }
      await refreshAllStatuses();
      return;
    }

    if (response.statuses) {
      applyStatuses(response.statuses);
    } else {
      await refreshAllStatuses();
    }
  });
}

function bindRefluxOverlayCollectorEvents() {
  const dom = FEATURE_DOM.refluxOverlayCollector;

  dom.toggleBtn.addEventListener('change', async () => {
    const action = dom.toggleBtn.checked ? 'start' : 'stop';

    if (action === 'start' && DIRTY_FEATURES.refluxOverlayCollector) {
      alert('임시 overlay 설정을 먼저 저장하세요.');
      await refreshAllStatuses();
      return;
    }

    if (action === 'start') {
      const viewUrl = normalizeRefluxOverlayCollectorViewUrl(dom.viewUrlInput.value);
      if (!viewUrl) {
        alert('URL 입력을 해주세요.');
        dom.viewUrlInput.focus();
        await refreshAllStatuses();
        return;
      }
    }

    const response = await sendFeatureMessage('refluxOverlayCollector', { action });
    if (!response?.success) {
      if (response?.message) {
        alert(response.message);
      }
      await refreshAllStatuses();
      return;
    }

    if (action === 'start') {
      latestRefluxOverlayCollectorOverlaysLoaded = false;
    }

    if (response.statuses) {
      applyStatuses(response.statuses);
    } else {
      await refreshAllStatuses();
    }
  });

  dom.saveConfigBtn.addEventListener('click', async () => {
    const config = {
      viewUrl: normalizeRefluxOverlayCollectorViewUrl(dom.viewUrlInput.value),
      beforePages: Math.max(0, parseOptionalInt(dom.beforePagesInput.value, 30)),
      afterPages: Math.max(0, parseOptionalInt(dom.afterPagesInput.value, 30)),
      requestDelayMs: Math.max(500, parseOptionalInt(dom.requestDelayMsInput.value, 500)),
      jitterMs: Math.max(0, parseOptionalInt(dom.jitterMsInput.value, 100)),
      transportMode: normalizeRefluxOverlayCollectorTransportMode(dom.transportModeInput.value),
      proxyWorkerCount: Math.min(10, Math.max(1, parseOptionalInt(dom.proxyWorkerCountInput.value, 10))),
    };

    const response = await sendFeatureMessage('refluxOverlayCollector', { action: 'updateConfig', config });
    if (!response?.success) {
      if (response?.message) {
        alert(response.message);
      }
      await refreshAllStatuses();
      return;
    }

    DIRTY_FEATURES.refluxOverlayCollector = false;
    flashSaved(dom.saveConfigBtn);
    if (response.statuses) {
      applyStatuses(response.statuses);
    } else {
      await refreshAllStatuses();
    }
  });

  dom.resetBtn.addEventListener('click', async () => {
    if (!confirm('임시 overlay 수집 로그와 상태 카운트를 초기화하시겠습니까? 저장된 overlay 데이터는 유지됩니다.')) {
      return;
    }

    const response = await sendFeatureMessage('refluxOverlayCollector', { action: 'resetStats' });
    if (!response?.success) {
      if (response?.message) {
        alert(response.message);
      }
      await refreshAllStatuses();
      return;
    }

    if (response.statuses) {
      applyStatuses(response.statuses);
    } else {
      await refreshAllStatuses();
    }
  });

  dom.clearOverlaysBtn.addEventListener('click', async () => {
    if (!confirm('저장된 overlay를 전부 삭제하시겠습니까? base dataset은 유지되고 local overlay만 지워집니다.')) {
      return;
    }

    const response = await sendFeatureMessage('refluxOverlayCollector', { action: 'clearAllOverlays' });
    if (!response?.success) {
      if (response?.message) {
        alert(response.message);
      }
      await refreshAllStatuses();
      return;
    }

    if (response.statuses) {
      applyStatuses(response.statuses);
    } else {
      await refreshAllStatuses();
    }

    if (Array.isArray(response.overlays)) {
      latestRefluxOverlayCollectorOverlays = response.overlays;
      latestRefluxOverlayCollectorOverlaysLoaded = true;
      renderRefluxOverlayCollectorOverlayList(response.overlays);
    } else {
      await refreshRefluxOverlayCollectorOverlays();
    }
  });

  dom.overlayList.addEventListener('click', async (event) => {
    const deleteButton = event.target.closest('[data-overlay-id]');
    if (!deleteButton) {
      return;
    }

    const overlayId = String(deleteButton.dataset.overlayId || '').trim();
    if (!overlayId) {
      return;
    }

    if (!confirm(`overlay ${overlayId}를 삭제하시겠습니까?`)) {
      return;
    }

    const response = await sendFeatureMessage('refluxOverlayCollector', {
      action: 'deleteOverlay',
      overlayId,
    });
    if (!response?.success) {
      if (response?.message) {
        alert(response.message);
      }
      await refreshAllStatuses();
      return;
    }

    if (response.statuses) {
      applyStatuses(response.statuses);
    } else {
      await refreshAllStatuses();
    }

    if (Array.isArray(response.overlays)) {
      latestRefluxOverlayCollectorOverlays = response.overlays;
      latestRefluxOverlayCollectorOverlaysLoaded = true;
      renderRefluxOverlayCollectorOverlayList(response.overlays);
    } else {
      await refreshRefluxOverlayCollectorOverlays();
    }
  });
}

function bindCommentRefluxCollectorEvents() {
  const dom = FEATURE_DOM.commentRefluxCollector;

  dom.toggleBtn.addEventListener('change', async () => {
    const action = dom.toggleBtn.checked ? 'start' : 'stop';

    if (action === 'start' && DIRTY_FEATURES.commentRefluxCollector) {
      alert('역류댓글 수집 설정을 먼저 저장하세요.');
      await refreshAllStatuses();
      return;
    }

    if (action === 'start') {
      const galleryId = normalizeCommentRefluxCollectorGalleryId(dom.galleryIdInput.value);
      if (!galleryId) {
        alert('갤 ID를 입력하세요.');
        dom.galleryIdInput.focus();
        await refreshAllStatuses();
        return;
      }

      if (!isValidCommentRefluxCollectorGalleryId(galleryId)) {
        alert('갤 ID는 영문/숫자/밑줄만 입력하세요.');
        dom.galleryIdInput.focus();
        dom.galleryIdInput.select();
        await refreshAllStatuses();
        return;
      }
    }

    const response = await sendFeatureMessage('commentRefluxCollector', { action });
    if (!response?.success) {
      if (response?.message) {
        alert(response.message);
      }
      await refreshAllStatuses();
      return;
    }

    if (response.statuses) {
      applyStatuses(response.statuses);
    } else {
      await refreshAllStatuses();
    }
  });

  dom.saveConfigBtn.addEventListener('click', async () => {
    const galleryId = normalizeCommentRefluxCollectorGalleryId(dom.galleryIdInput.value);
    if (galleryId && !isValidCommentRefluxCollectorGalleryId(galleryId)) {
      alert('갤 ID는 영문/숫자/밑줄만 입력하세요.');
      dom.galleryIdInput.focus();
      dom.galleryIdInput.select();
      return;
    }

    const startPage = Math.max(1, parseOptionalInt(dom.startPageInput.value, 1));
    const endPage = Math.max(startPage, parseOptionalInt(dom.endPageInput.value, startPage));
    const requestDelayMs = Math.max(0, parseOptionalInt(dom.requestDelayMsInput.value, 100));
    const cycleDelayMs = Math.max(0, parseOptionalInt(dom.cycleDelayMsInput.value, 5000));
    const postConcurrency = Math.max(1, parseOptionalInt(dom.postConcurrencyInput.value, 8));

    const config = {
      galleryId,
      startPage,
      endPage,
      requestDelayMs,
      cycleDelayMs,
      postConcurrency,
    };

    const response = await sendFeatureMessage('commentRefluxCollector', { action: 'updateConfig', config });
    if (!response?.success) {
      if (response?.message) {
        alert(response.message);
      }
      await refreshAllStatuses();
      return;
    }

    DIRTY_FEATURES.commentRefluxCollector = false;
    flashSaved(dom.saveConfigBtn);
    if (response.statuses) {
      applyStatuses(response.statuses);
    } else {
      await refreshAllStatuses();
    }
  });

  dom.downloadBtn.addEventListener('click', async () => {
    const response = await sendFeatureMessage('commentRefluxCollector', { action: 'downloadExportJson' });
    if (!response?.success) {
      if (response?.message) {
        alert(response.message);
      }
      await refreshAllStatuses();
      return;
    }

    try {
      await downloadCommentRefluxCollectorSourceExportInPopup(response);
    } catch (error) {
      alert(`source 다운로드 실패 - ${error.message}`);
      await refreshAllStatuses();
      return;
    }

    flashSaved(dom.downloadBtn, '✅ 다운로드');
    if (response.statuses) {
      applyStatuses(response.statuses);
    } else {
      await refreshAllStatuses();
    }
  });

  dom.resetBtn.addEventListener('click', async () => {
    if (!confirm('역류댓글 수집 통계와 로그, 다운로드 대기 데이터를 초기화하시겠습니까?')) {
      return;
    }

    const response = await sendFeatureMessage('commentRefluxCollector', { action: 'resetStats' });
    if (!response?.success) {
      if (response?.message) {
        alert(response.message);
      }
      await refreshAllStatuses();
      return;
    }

    if (response.statuses) {
      applyStatuses(response.statuses);
    } else {
      await refreshAllStatuses();
    }
  });
}

function bindCommentMonitorEvents() {
  const dom = FEATURE_DOM.commentMonitor;

  dom.toggleBtn.addEventListener('change', async () => {
    const action = dom.toggleBtn.checked ? 'start' : 'stop';
    const response = await sendFeatureMessage('commentMonitor', { action });
    if (!response?.success) {
      if (response?.message) {
        alert(response.message);
      }
      await refreshAllStatuses();
      return;
    }

    DIRTY_FEATURES.commentMonitor = false;
    if (response.statuses) {
      applyStatuses(response.statuses);
    } else {
      await refreshAllStatuses();
    }
  });

  dom.saveConfigBtn.addEventListener('click', async () => {
    const config = {
      pollIntervalMs: Math.max(1000, parseOptionalInt(dom.pollIntervalMsInput.value, 20000)),
      monitorPages: Math.max(1, parseOptionalInt(dom.pagesInput.value, 2)),
      attackNewCommentThreshold: Math.max(1, parseOptionalInt(dom.attackNewCommentThresholdInput.value, 30)),
      attackChangedPostThreshold: Math.max(1, parseOptionalInt(dom.attackChangedPostThresholdInput.value, 20)),
      attackAltNewCommentThreshold: Math.max(1, parseOptionalInt(dom.attackAltNewCommentThresholdInput.value, 50)),
      attackAltChangedPostThreshold: Math.max(1, parseOptionalInt(dom.attackAltChangedPostThresholdInput.value, 9)),
      attackConsecutiveCount: Math.max(1, parseOptionalInt(dom.attackConsecutiveCountInput.value, 2)),
      releaseNewCommentThreshold: Math.max(0, parseOptionalInt(dom.releaseNewCommentThresholdInput.value, 30)),
      releaseVerifiedDeleteThreshold: Math.max(0, parseOptionalInt(dom.releaseVerifiedDeleteThresholdInput.value, 10)),
      releaseConsecutiveCount: Math.max(1, parseOptionalInt(dom.releaseConsecutiveCountInput.value, 3)),
    };

    const response = await sendFeatureMessage('commentMonitor', { action: 'updateConfig', config });
    if (!response?.success) {
      if (response?.message) {
        alert(response.message);
      }
      await refreshAllStatuses();
      return;
    }

    DIRTY_FEATURES.commentMonitor = false;
    flashSaved(dom.saveConfigBtn);
    if (response.statuses) {
      applyStatuses(response.statuses);
    } else {
      await refreshAllStatuses();
    }
  });

  dom.resetBtn.addEventListener('click', async () => {
    if (!confirm('댓글 감시 자동화 통계와 로그를 초기화하시겠습니까?')) {
      return;
    }

    const response = await sendFeatureMessage('commentMonitor', { action: 'resetStats' });
    if (!response?.success) {
      if (response?.message) {
        alert(response.message);
      }
      await refreshAllStatuses();
      return;
    }

    if (response.statuses) {
      applyStatuses(response.statuses);
    } else {
      await refreshAllStatuses();
    }
  });
}

function normalizeTrustedCommandDefenseTrustedUsers(users = []) {
  const deduped = [];
  const seen = new Set();

  for (const user of Array.isArray(users) ? users : []) {
    const userId = String(user?.userId || '').trim();
    const label = String(user?.label || '').trim();
    if (!userId || seen.has(userId)) {
      continue;
    }

    seen.add(userId);
    deduped.push({
      userId,
      label: (label || userId).slice(0, 20),
    });
  }

  return deduped;
}

function parseTrustedCommandDefenseTrustedUsersText(value) {
  const rawText = String(value || '').trim();
  if (!rawText) {
    return [];
  }

  const rows = rawText
    .split(/[\n,]+/g)
    .map((row) => String(row || '').trim())
    .filter(Boolean);

  return normalizeTrustedCommandDefenseTrustedUsers(rows.map((row) => {
    const [userIdPart, ...labelParts] = row.split(/\s+/);
    return {
      userId: String(userIdPart || '').trim(),
      label: String(labelParts.join(' ') || '').trim(),
    };
  }));
}

function serializeTrustedCommandDefenseTrustedUsers(users = []) {
  return normalizeTrustedCommandDefenseTrustedUsers(users)
    .map((user) => {
      if (!user.label || user.label === user.userId) {
        return user.userId;
      }
      return `${user.userId} ${user.label}`;
    })
    .join('\n');
}

function syncTrustedCommandDefenseTrustedUsersText() {
  const dom = FEATURE_DOM.trustedCommandDefense;
  dom.trustedUsersTextInput.value = serializeTrustedCommandDefenseTrustedUsers(draftTrustedCommandDefenseTrustedUsers);
}

function markTrustedCommandDefenseDirty() {
  DIRTY_FEATURES.trustedCommandDefense = true;
}

function renderTrustedCommandDefenseTrustedUsers(users = []) {
  const dom = FEATURE_DOM.trustedCommandDefense;
  const normalizedUsers = normalizeTrustedCommandDefenseTrustedUsers(users);
  const isLocked = Boolean(latestTrustedCommandDefenseStatus?.isRunning);

  if (normalizedUsers.length <= 0) {
    dom.trustedUserList.innerHTML = '<div class="log-empty">등록된 신뢰 사용자가 없습니다.</div>';
    return;
  }

  dom.trustedUserList.innerHTML = '';
  for (const user of normalizedUsers) {
    const item = document.createElement('div');
    item.className = 'trusted-command-user-item';

    const meta = document.createElement('div');
    meta.className = 'trusted-command-user-meta';

    const label = document.createElement('div');
    label.className = 'trusted-command-user-label';
    label.textContent = user.label;

    const userId = document.createElement('div');
    userId.className = 'trusted-command-user-id';
    userId.textContent = user.userId;

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'manual-rule-remove-btn';
    removeBtn.textContent = '삭제';
    setDisabled(removeBtn, isLocked);
    removeBtn.addEventListener('click', () => {
      draftTrustedCommandDefenseTrustedUsers = normalizeTrustedCommandDefenseTrustedUsers(
        draftTrustedCommandDefenseTrustedUsers.filter((entry) => entry.userId !== user.userId),
      );
      syncTrustedCommandDefenseTrustedUsersText();
      renderTrustedCommandDefenseTrustedUsers(draftTrustedCommandDefenseTrustedUsers);
      markTrustedCommandDefenseDirty();
    });

    meta.appendChild(label);
    meta.appendChild(userId);
    item.appendChild(meta);
    item.appendChild(removeBtn);
    dom.trustedUserList.appendChild(item);
  }
}

function bindTrustedCommandDefenseEvents() {
  const dom = FEATURE_DOM.trustedCommandDefense;

  dom.addTrustedUserBtn.addEventListener('click', () => {
    const userId = dom.trustedUserIdInput.value.trim();
    const label = dom.trustedUserLabelInput.value.trim();

    if (!userId) {
      alert('user_id를 입력하세요.');
      dom.trustedUserIdInput.focus();
      return;
    }

    if (!label) {
      alert('label을 입력하세요.');
      dom.trustedUserLabelInput.focus();
      return;
    }

    if (label.length > 20) {
      alert('label은 20자 이하로 입력하세요.');
      dom.trustedUserLabelInput.focus();
      return;
    }

    if (draftTrustedCommandDefenseTrustedUsers.some((entry) => entry.userId === userId)) {
      alert('이미 등록된 user_id입니다.');
      dom.trustedUserIdInput.focus();
      return;
    }

    draftTrustedCommandDefenseTrustedUsers = normalizeTrustedCommandDefenseTrustedUsers([
      ...draftTrustedCommandDefenseTrustedUsers,
      { userId, label },
    ]);
    syncTrustedCommandDefenseTrustedUsersText();
    renderTrustedCommandDefenseTrustedUsers(draftTrustedCommandDefenseTrustedUsers);
    dom.trustedUserIdInput.value = '';
    dom.trustedUserLabelInput.value = '';
    markTrustedCommandDefenseDirty();
  });

  dom.toggleBtn.addEventListener('change', async () => {
    if (dom.toggleBtn.checked && DIRTY_FEATURES.trustedCommandDefense) {
      alert('명령 방어 설정을 먼저 저장하세요.');
      await refreshAllStatuses();
      return;
    }

    const action = dom.toggleBtn.checked ? 'start' : 'stop';
    const response = await sendFeatureMessage('trustedCommandDefense', { action });
    if (!response?.success) {
      alert(response?.message || '명령 방어 토글 처리에 실패했습니다.');
      await refreshAllStatuses();
      return;
    }

    if (action === 'stop') {
      DIRTY_FEATURES.trustedCommandDefense = false;
    }

    if (response?.statuses) {
      applyStatuses(response.statuses);
    }
  });

  dom.saveConfigBtn.addEventListener('click', async () => {
    const config = {
      commandPostUrl: dom.commandPostUrlInput.value.trim(),
      trustedUsersText: serializeTrustedCommandDefenseTrustedUsers(draftTrustedCommandDefenseTrustedUsers),
      commandPrefix: dom.commandPrefixInput.value.trim(),
      pollIntervalMs: parseOptionalInt(dom.pollIntervalSecondsInput.value, 20) * 1000,
      holdMs: parseOptionalInt(dom.holdMinutesInput.value, 10) * 60 * 1000,
    };

    const response = await sendFeatureMessage('trustedCommandDefense', { action: 'updateConfig', config });
    if (!response?.success) {
      alert(response?.message || '명령 방어 설정 저장에 실패했습니다.');
      if (response?.statuses) {
        applyStatuses(response.statuses);
      }
      return;
    }

    DIRTY_FEATURES.trustedCommandDefense = false;
    flashSaved(dom.saveConfigBtn);
    if (response?.statuses) {
      applyStatuses(response.statuses);
    }
  });

  dom.resetBtn.addEventListener('click', async () => {
    const response = await sendFeatureMessage('trustedCommandDefense', { action: 'resetStats' });
    if (!response?.success) {
      alert(response?.message || '명령 방어 통계 초기화에 실패했습니다.');
      if (response?.statuses) {
        applyStatuses(response.statuses);
      }
      return;
    }

    DIRTY_FEATURES.trustedCommandDefense = false;
    if (response?.statuses) {
      applyStatuses(response.statuses);
    }
  });
}

function bindCommentEvents() {
  const dom = FEATURE_DOM.comment;

  dom.toggleBtn.addEventListener('change', async () => {
    const action = dom.toggleBtn.checked ? 'start' : 'stop';
    if (action === 'start' && shouldBlockManualStartForDirtyConfig('comment', '댓글 방어')) {
      dom.toggleBtn.checked = false;
      await refreshAllStatuses();
      return;
    }
    const message = action === 'start'
      ? { action, source: 'manual', commentAttackMode: 'default', manualTimeLimit: true }
      : { action };
    const response = await sendFeatureMessage('comment', message);
    if (!response?.success) {
      if (response?.message) {
        alert(response.message);
      }
      await refreshAllStatuses();
      return;
    }

    if (response.statuses) {
      applyStatuses(response.statuses);
      return;
    }

    updateCommentUI(response.status);
  });

  bindCommentQuickAttackModeToggle(dom.excludePureHangulInput, 'exclude_pure_hangul', '한글제외 유동닉댓글 삭제');
  bindCommentQuickAttackModeToggle(dom.commentRefluxModeInput, 'comment_reflux', '역류기 공용 matcher 공격');

  dom.useVpnGatePrefixFilterInput.addEventListener('change', () => {
    INLINE_SETTING_DIRTY.commentVpnGate = dom.useVpnGatePrefixFilterInput.checked !== Boolean(
      latestCommentStatus?.config?.useVpnGatePrefixFilter ?? false,
    );
  });

  dom.vpnGatePrefixSaveBtn.addEventListener('click', async () => {
    const response = await sendFeatureMessage('comment', {
      action: 'updateConfig',
      config: {
        useVpnGatePrefixFilter: dom.useVpnGatePrefixFilterInput.checked,
      },
    });
    if (!response?.success) {
      if (response?.message) {
        alert(response.message);
      }
      await refreshAllStatuses();
      return;
    }

    INLINE_SETTING_DIRTY.commentVpnGate = false;
    flashSaved(dom.vpnGatePrefixSaveBtn, '✅ 저장');
    if (response.statuses) {
      applyStatuses(response.statuses);
      return;
    }

    updateCommentUI(response.status);
  });

  dom.saveConfigBtn.addEventListener('click', async () => {
    const refluxSearchGalleryId = normalizeRefluxSearchGalleryIdInputValue(dom.refluxSearchGalleryIdInput.value);
    if (refluxSearchGalleryId && !isValidRefluxSearchGalleryId(refluxSearchGalleryId)) {
      alert('역류 검색 갤 ID는 영문/숫자/밑줄만 입력하세요.');
      return;
    }

    const config = {
      minPage: parseOptionalInt(dom.minPageInput.value, 1),
      maxPage: parseOptionalInt(dom.maxPageInput.value, 5),
      requestDelay: parseOptionalInt(dom.requestDelayInput.value, 100),
      cycleDelay: parseOptionalInt(dom.cycleDelayInput.value, 1000),
      manualTimeLimitMinutes: clampManualTimeLimitMinutes(dom.manualTimeLimitMinutesInput.value),
      refluxSearchGalleryId,
      postConcurrency: parseOptionalInt(dom.postConcurrencyInput.value, 50),
      banOnDelete: dom.banOnDeleteInput.checked,
      avoidHour: String(Math.max(1, parseOptionalInt(dom.avoidHourInput.value, 6))),
    };

    const response = await sendFeatureMessage('comment', { action: 'updateConfig', config });
    if (!response?.success) {
      if (response?.message) {
        alert(response.message);
      }
      await refreshAllStatuses();
      return;
    }

    DIRTY_FEATURES.comment = false;
    flashSaved(dom.saveConfigBtn);
    if (response.statuses) {
      applyStatuses(response.statuses);
      return;
    }

    updateCommentUI(response.status);
  });

  dom.resetBtn.addEventListener('click', async () => {
    if (!confirm('댓글 방어 통계와 로그를 초기화하시겠습니까?')) {
      return;
    }

    const response = await sendFeatureMessage('comment', { action: 'resetStats' });
    if (!response?.success) {
      if (response?.message) {
        alert(response.message);
      }
      await refreshAllStatuses();
      return;
    }

    if (response.statuses) {
      applyStatuses(response.statuses);
      return;
    }

    updateCommentUI(response.status);
  });

  function bindCommentQuickAttackModeToggle(toggleInput, attackMode, modeLabel) {
    if (!toggleInput) {
      return;
    }

    toggleInput.addEventListener('change', async () => {
      const targetEnabled = toggleInput.checked;
      const statusResponse = await sendFeatureMessage('comment', { action: 'getStatus' });
      if (!statusResponse?.success || !statusResponse.status) {
        await refreshAllStatuses();
        return;
      }

      const currentStatus = statusResponse.status;
      let response = null;

      if (targetEnabled) {
        if (currentStatus.isRunning) {
          if (currentStatus.currentSource === 'manual' && currentStatus.currentAttackMode === attackMode) {
            updateCommentUI(currentStatus);
            return;
          }

          alert(`댓글 방어가 이미 실행 중입니다. 먼저 정지한 뒤 ${modeLabel}을 켜세요.`);
          await refreshAllStatuses();
          return;
        }

        if (shouldBlockManualStartForDirtyConfig('comment', '댓글 방어')) {
          toggleInput.checked = false;
          await refreshAllStatuses();
          return;
        }

        response = await sendFeatureMessage('comment', {
          action: 'start',
          source: 'manual',
          commentAttackMode: attackMode,
          manualTimeLimit: true,
        });
      } else {
        if (!currentStatus.isRunning || currentStatus.currentSource !== 'manual' || currentStatus.currentAttackMode !== attackMode) {
          await refreshAllStatuses();
          return;
        }

        response = await sendFeatureMessage('comment', { action: 'stop' });
      }

      if (!response?.success) {
        if (response?.message) {
          alert(response.message);
        }
        await refreshAllStatuses();
        return;
      }

      if (response.statuses) {
        applyStatuses(response.statuses);
        return;
      }

      updateCommentUI(response.status);
    });
  }
}

function bindPostEvents() {
  const dom = FEATURE_DOM.post;

  dom.toggleBtn.addEventListener('change', async () => {
    const action = dom.toggleBtn.checked ? 'start' : 'stop';
    if (action === 'start' && shouldBlockManualStartForDirtyConfig('post', '게시글 분류')) {
      dom.toggleBtn.checked = false;
      await refreshAllStatuses();
      return;
    }
    const response = await sendFeatureMessage('post', action === 'start'
      ? {
        action,
        source: 'manual',
        attackMode: 'default',
        manualTimeLimit: true,
      }
      : { action });
    if (!response?.success) {
      if (response?.message) {
        alert(response.message);
      }
      await refreshAllStatuses();
      return;
    }

    if (response.statuses) {
      applyStatuses(response.statuses);
      return;
    }

    updatePostUI(response.status);
  });

  bindPostQuickAttackModeToggle(dom.cjkModeToggleInput, 'cjk_narrow', '중국어/한자 공격');
  bindPostQuickAttackModeToggle(dom.semiconductorRefluxModeToggleInput, 'semiconductor_reflux', '역류기 공격');
  bindPostQuickAttackModeToggle(dom.page1NoCutoffModeToggleInput, 'page1_no_cutoff', '1페이지 전체 검사');

  dom.useVpnGatePrefixFilterInput.addEventListener('change', () => {
    INLINE_SETTING_DIRTY.postVpnGate = dom.useVpnGatePrefixFilterInput.checked !== Boolean(
      latestPostStatus?.config?.useVpnGatePrefixFilter ?? false,
    );
  });

  dom.vpnGatePrefixSaveBtn.addEventListener('click', async () => {
    const response = await sendFeatureMessage('post', {
      action: 'updateConfig',
      config: {
        useVpnGatePrefixFilter: dom.useVpnGatePrefixFilterInput.checked,
      },
    });
    if (!response?.success) {
      if (response?.message) {
        alert(response.message);
      }
      await refreshAllStatuses();
      return;
    }

    INLINE_SETTING_DIRTY.postVpnGate = false;
    flashSaved(dom.vpnGatePrefixSaveBtn, '✅ 저장');
    if (response.statuses) {
      applyStatuses(response.statuses);
    } else {
      updatePostUI(response.status);
    }
  });

  dom.saveConfigBtn.addEventListener('click', async () => {
    const refluxSearchGalleryId = normalizeRefluxSearchGalleryIdInputValue(dom.refluxSearchGalleryIdInput.value);
    if (refluxSearchGalleryId && !isValidRefluxSearchGalleryId(refluxSearchGalleryId)) {
      alert('역류 검색 갤 ID는 영문/숫자/밑줄만 입력하세요.');
      return;
    }

    const config = {
      minPage: parseOptionalInt(dom.minPageInput.value, 1),
      maxPage: parseOptionalInt(dom.maxPageInput.value, 1),
      requestDelay: parseOptionalInt(dom.requestDelayInput.value, 500),
      cycleDelay: parseOptionalInt(dom.cycleDelayInput.value, 1000),
      manualTimeLimitMinutes: clampManualTimeLimitMinutes(dom.manualTimeLimitMinutesInput.value),
      refluxSearchGalleryId,
    };

    const response = await sendFeatureMessage('post', { action: 'updateConfig', config });
    if (!response?.success) {
      if (response?.message) {
        alert(response.message);
      }
      await refreshAllStatuses();
      return;
    }

    DIRTY_FEATURES.post = false;
    flashSaved(dom.saveConfigBtn);
    if (response.statuses) {
      applyStatuses(response.statuses);
    } else {
      updatePostUI(response.status);
    }
  });

  dom.resetBtn.addEventListener('click', async () => {
    if (!confirm('게시글 분류 통계와 로그를 초기화하시겠습니까?')) {
      return;
    }

    const response = await sendFeatureMessage('post', { action: 'resetStats' });
    if (response?.success) {
      updatePostUI(response.status);
    }
  });

  function bindPostQuickAttackModeToggle(toggleInput, attackMode, modeLabel) {
    if (!toggleInput) {
      return;
    }

    toggleInput.addEventListener('change', async () => {
      const targetEnabled = toggleInput.checked;
      const statusResponse = await sendFeatureMessage('post', { action: 'getStatus' });
      if (!statusResponse?.success || !statusResponse.status) {
        await refreshAllStatuses();
        return;
      }

      const currentStatus = statusResponse.status;
      let response = null;

      if (targetEnabled) {
        if (currentStatus.isRunning) {
          if (currentStatus.currentSource === 'manual' && currentStatus.currentAttackMode === attackMode) {
            updatePostUI(currentStatus);
            return;
          }

          alert(`일반 게시글 분류가 이미 실행 중입니다. 먼저 정지한 뒤 ${modeLabel}을 켜세요.`);
          await refreshAllStatuses();
          return;
        }

        if (shouldBlockManualStartForDirtyConfig('post', '게시글 분류')) {
          toggleInput.checked = false;
          await refreshAllStatuses();
          return;
        }

        response = await sendFeatureMessage('post', {
          action: 'start',
          source: 'manual',
          attackMode,
          manualTimeLimit: true,
        });
      } else {
        if (!currentStatus.isRunning || currentStatus.currentSource !== 'manual' || currentStatus.currentAttackMode !== attackMode) {
          await refreshAllStatuses();
          return;
        }

        response = await sendFeatureMessage('post', { action: 'stop' });
      }

      if (!response?.success) {
        if (response?.message) {
          alert(response.message);
        }
        await refreshAllStatuses();
        return;
      }

      if (response.statuses) {
        applyStatuses(response.statuses);
        return;
      }

      updatePostUI(response.status);
    });
  }
}

function bindIpEvents() {
  const dom = FEATURE_DOM.ip;

  dom.toggleBtn.addEventListener('change', async () => {
    const action = dom.toggleBtn.checked ? 'start' : 'stop';
    const response = await sendFeatureMessage('ip', action === 'start'
      ? {
        action,
        source: 'manual',
        includeExistingTargetsOnStart: false,
      }
      : { action });
    if (!response?.success) {
      if (response?.message) {
        alert(response.message);
      }
      await refreshAllStatuses();
      return;
    }

    updateIpUI(response.status);
  });

  dom.includeExistingTargetsOnStartInput.addEventListener('change', async () => {
    const targetEnabled = dom.includeExistingTargetsOnStartInput.checked;
    const statusResponse = await sendFeatureMessage('ip', { action: 'getStatus' });
    if (!statusResponse?.success || !statusResponse.status) {
      await refreshAllStatuses();
      return;
    }

    const currentStatus = statusResponse.status;
    let response = null;

    if (targetEnabled) {
      if (currentStatus.isRunning) {
        if (currentStatus.includeExistingTargetsMode) {
          updateIpUI(currentStatus);
          return;
        }

        alert('일반 IP 차단이 이미 실행 중입니다. 먼저 정지한 뒤 도배기탭 삭제기를 켜세요.');
        await refreshAllStatuses();
        return;
      }

      response = await sendFeatureMessage('ip', {
        action: 'start',
        source: 'manual',
        includeExistingTargetsOnStart: true,
      });
    } else {
      if (!currentStatus.isRunning || !currentStatus.includeExistingTargetsMode) {
        await refreshAllStatuses();
        return;
      }

      response = await sendFeatureMessage('ip', { action: 'stop' });
    }

    if (!response?.success) {
      if (response?.message) {
        alert(response.message);
      }
      await refreshAllStatuses();
      return;
    }

    if (response.statuses) {
      applyStatuses(response.statuses);
      return;
    }

    updateIpUI(response.status);
  });

  dom.saveConfigBtn.addEventListener('click', async () => {
    const config = {
      minPage: parseOptionalInt(dom.minPageInput.value, 1),
      maxPage: parseOptionalInt(dom.maxPageInput.value, 5),
      requestDelay: parseOptionalInt(dom.requestDelayInput.value, 500),
      cycleDelay: parseOptionalInt(dom.cycleDelayInput.value, 1000),
      releaseScanMaxPages: parseOptionalInt(dom.releaseScanMaxPagesInput.value, 40),
      avoidHour: String(Math.max(1, parseOptionalInt(dom.avoidHourInput.value, 6))),
      includeUidTargetsOnManualStart: dom.includeUidTargetsOnManualStartInput.checked,
    };

    const response = await sendFeatureMessage('ip', { action: 'updateConfig', config });
    if (!response?.success) {
      if (response?.message) {
        alert(response.message);
      }
      await refreshAllStatuses();
      return;
    }

    DIRTY_FEATURES.ip = false;
    flashSaved(dom.saveConfigBtn);
    if (response.statuses) {
      applyStatuses(response.statuses);
      return;
    }

    updateIpUI(response.status);
  });

  dom.releaseBtn.addEventListener('click', async () => {
    const statusResponse = await sendFeatureMessage('ip', { action: 'getStatus' });
    if (!statusResponse?.success) {
      return;
    }

    if (statusResponse.status.isRunning) {
      alert('IP 차단을 먼저 정지한 뒤 해제를 실행하세요.');
      dom.toggleBtn.checked = true;
      return;
    }

    if (statusResponse.status.activeBanCount <= 0) {
      alert('해제할 활성 차단 내역이 없습니다.');
      return;
    }

    if (!confirm(`활성 차단 ${statusResponse.status.activeBanCount}건을 해제하시겠습니까?`)) {
      return;
    }

    dom.releaseBtn.disabled = true;
    dom.releaseBtn.textContent = '해제 중...';

    const releaseResponse = await sendFeatureMessage('ip', { action: 'releaseTrackedBans' });
    if (releaseResponse?.status) {
      updateIpUI(releaseResponse.status);
    }

    if (releaseResponse?.message) {
      alert(releaseResponse.message);
    }

    dom.releaseBtn.disabled = false;
    dom.releaseBtn.textContent = '내가 차단한 대상 해제';
  });

  dom.resetBtn.addEventListener('click', async () => {
    if (!confirm('IP 차단 통계와 로그를 초기화하시겠습니까?')) {
      return;
    }

    const response = await sendFeatureMessage('ip', { action: 'resetStats' });
    if (response?.success) {
      updateIpUI(response.status);
    }
  });
}

function bindSemiPostEvents() {
  const dom = FEATURE_DOM.semiPost;

  dom.toggleBtn.addEventListener('change', async () => {
    const action = dom.toggleBtn.checked ? 'start' : 'stop';
    const response = await sendFeatureMessage('semiPost', { action });
    if (!response?.success) {
      if (response?.message) {
        alert(response.message);
      }
      await refreshAllStatuses();
      return;
    }

    DIRTY_FEATURES.semiPost = false;
    if (response.statuses) {
      applyStatuses(response.statuses);
    } else {
      await refreshAllStatuses();
    }
  });

  dom.saveConfigBtn.addEventListener('click', async () => {
    const config = {
      minPage: parseOptionalInt(dom.minPageInput.value, 1),
      maxPage: parseOptionalInt(dom.maxPageInput.value, 5),
      requestDelay: parseOptionalInt(dom.requestDelayInput.value, 500),
      cycleDelay: parseOptionalInt(dom.cycleDelayInput.value, 1000),
      minTotalActivityCount: Math.max(1, parseOptionalInt(dom.minTotalActivityCountInput.value, 20)),
      minPostRatioPercent: clampPercent(dom.minPostRatioPercentInput.value, 90, 1),
    };

    const response = await sendFeatureMessage('semiPost', { action: 'updateConfig', config });
    if (!response?.success) {
      if (response?.message) {
        alert(response.message);
      }
      await refreshAllStatuses();
      return;
    }

    DIRTY_FEATURES.semiPost = false;
    flashSaved(dom.saveConfigBtn);
    if (response.statuses) {
      applyStatuses(response.statuses);
    } else {
      await refreshAllStatuses();
    }
  });

  dom.resetBtn.addEventListener('click', async () => {
    if (!confirm('반고닉 분류 통계와 로그를 초기화하시겠습니까?')) {
      return;
    }

    const response = await sendFeatureMessage('semiPost', { action: 'resetStats' });
    if (!response?.success) {
      if (response?.message) {
        alert(response.message);
      }
      await refreshAllStatuses();
      return;
    }

    if (response.statuses) {
      applyStatuses(response.statuses);
    } else {
      await refreshAllStatuses();
    }
  });
}

function bindUidRatioWarningEvents() {
  const dom = FEATURE_DOM.uidRatioWarning;

  dom.uidRatioWarningToggleBtn.addEventListener('change', async () => {
    const response = await sendMessage({
      action: 'toggleUidRatioWarning',
      enabled: dom.uidRatioWarningToggleBtn.checked,
    });

    if (!response?.success) {
      if (response?.message) {
        alert(response.message);
      }
      await refreshAllStatuses();
      return;
    }

    if (response.uidRatioWarningStatus) {
      updateUidRatioWarningUI(response.uidRatioWarningStatus);
    }
    if (response.statuses) {
      applyStatuses(response.statuses);
    } else {
      await refreshAllStatuses();
    }
  });
}

function bindUidWarningAutoBanEvents() {
  const dom = FEATURE_DOM.uidWarningAutoBan;

  dom.toggleBtn.addEventListener('change', async () => {
    const action = dom.toggleBtn.checked ? 'start' : 'stop';
    const response = await sendFeatureMessage('uidWarningAutoBan', { action });
    if (!response?.success) {
      if (response?.message) {
        alert(response.message);
      }
      await refreshAllStatuses();
      return;
    }

    if (response.statuses) {
      applyStatuses(response.statuses);
    } else {
      await refreshAllStatuses();
    }
  });

  dom.resetBtn.addEventListener('click', async () => {
    if (!confirm('분탕자동차단 통계와 로그를 초기화하시겠습니까?')) {
      return;
    }

    const response = await sendFeatureMessage('uidWarningAutoBan', { action: 'resetStats' });
    if (!response?.success) {
      if (response?.message) {
        alert(response.message);
      }
      await refreshAllStatuses();
      return;
    }

    if (response.statuses) {
      applyStatuses(response.statuses);
    } else {
      await refreshAllStatuses();
    }
  });

  dom.addImmediateTitleRuleBtn.addEventListener('click', () => {
    addUidWarningAutoBanImmediateTitleRule('contains');
  });

  dom.addImmediateTitleAndRuleBtn.addEventListener('click', () => {
    addUidWarningAutoBanImmediateTitleRule('and');
  });

  dom.saveConfigBtn.addEventListener('click', async () => {
    const rules = parseUidWarningAutoBanImmediateTitleRulesValue(dom.immediateTitleRulesValueInput.value);
    const response = await sendFeatureMessage('uidWarningAutoBan', {
      action: 'updateConfig',
      config: {
        immediateTitleBanRules: rules,
      },
    });
    if (!response?.success) {
      if (response?.message) {
        alert(response.message);
      }
      await refreshAllStatuses();
      return;
    }

    DIRTY_FEATURES.uidWarningAutoBan = false;
    flashSaved(dom.saveConfigBtn);
    if (response.statuses) {
      applyStatuses(response.statuses);
    } else {
      await refreshAllStatuses();
    }
  });
}

function bindMonitorEvents() {
  const dom = FEATURE_DOM.monitor;

  dom.toggleBtn.addEventListener('change', async () => {
    const action = dom.toggleBtn.checked ? 'start' : 'stop';
    const response = await sendFeatureMessage('monitor', { action });
    if (!response?.success) {
      if (response?.message) {
        alert(response.message);
      }
      await refreshAllStatuses();
      return;
    }

    DIRTY_FEATURES.monitor = false;
    if (response.statuses) {
      applyStatuses(response.statuses);
    } else {
      await refreshAllStatuses();
    }
  });

  dom.saveConfigBtn.addEventListener('click', async () => {
    const config = {
      pollIntervalMs: Math.max(1000, parseOptionalInt(dom.pollIntervalMsInput.value, 30000)),
      monitorPages: Math.max(1, parseOptionalInt(dom.pagesInput.value, 1)),
      initialSweepPages: Math.max(1, parseOptionalInt(dom.initialSweepPagesInput.value, parseOptionalInt(dom.pagesInput.value, 1))),
      attackNewPostThreshold: Math.max(1, parseOptionalInt(dom.attackNewPostThresholdInput.value, 50)),
      attackFluidRatioThreshold: clampPercent(dom.attackFluidRatioThresholdInput.value, 85, 1),
      attackConsecutiveCount: Math.max(1, parseOptionalInt(dom.attackConsecutiveCountInput.value, 2)),
      releaseNewPostThreshold: Math.max(0, parseOptionalInt(dom.releaseNewPostThresholdInput.value, 10)),
      releaseFluidRatioThreshold: clampPercent(dom.releaseFluidRatioThresholdInput.value, 40, 0),
      releaseConsecutiveCount: Math.max(1, parseOptionalInt(dom.releaseConsecutiveCountInput.value, 3)),
    };

    const response = await sendFeatureMessage('monitor', { action: 'updateConfig', config });
    if (!response?.success) {
      if (response?.message) {
        alert(response.message);
      }
      await refreshAllStatuses();
      return;
    }

    DIRTY_FEATURES.monitor = false;
    flashSaved(dom.saveConfigBtn);
    if (response.statuses) {
      applyStatuses(response.statuses);
    } else {
      await refreshAllStatuses();
    }
  });

  dom.resetBtn.addEventListener('click', async () => {
    if (!confirm('감시 자동화 통계와 로그를 초기화하시겠습니까?')) {
      return;
    }

    const response = await sendFeatureMessage('monitor', { action: 'resetStats' });
    if (!response?.success) {
      if (response?.message) {
        alert(response.message);
      }
      await refreshAllStatuses();
      return;
    }

    if (response.statuses) {
      applyStatuses(response.statuses);
    } else {
      await refreshAllStatuses();
    }
  });
}

async function refreshAllStatuses() {
  const response = await sendMessage({ action: 'getAllStatus' });
  if (!response?.success || !response.statuses) {
    return;
  }

  applyStatuses(response.statuses);
  updateSessionFallbackUI(response.sessionFallbackStatus);
  updateUidRatioWarningUI(response.uidRatioWarningStatus);
}

function applyStatuses(statuses) {
  latestMonitorStatus = statuses.monitor || latestMonitorStatus;
  latestTrustedCommandDefenseStatus = statuses.trustedCommandDefense || latestTrustedCommandDefenseStatus;
  syncSharedConfigInputs(statuses);
  updateConceptMonitorUI(statuses.conceptMonitor);
  updateConceptPatrolUI(statuses.conceptPatrol);
  updateHanRefreshIpBanUI(statuses.hanRefreshIpBan);
  updateBumpPostUI(statuses.bumpPost);
  updateSinmungoCommentUI(statuses.sinmungoComment);
  updateSelfHostedVpnUI(statuses.selfHostedVpn);
  updateRefluxDatasetCollectorUI(statuses.refluxDatasetCollector);
  updateRefluxOverlayCollectorUI(statuses.refluxOverlayCollector);
  updateCommentRefluxCollectorUI(statuses.commentRefluxCollector);
  updateCommentMonitorUI(statuses.commentMonitor);
  updateTrustedCommandDefenseUI(statuses.trustedCommandDefense);
  updateMonitorUI(statuses.monitor);
  updateCommentUI(statuses.comment);
  updatePostUI(statuses.post);
  updateSemiPostUI(statuses.semiPost);
  updateUidWarningAutoBanUI(statuses.uidWarningAutoBan);
  updateIpUI(statuses.ip);
  applyAutomationLocks(statuses);
}

function updateSessionFallbackUI(status) {
  if (!status) {
    return;
  }

  latestSessionFallbackStatus = status;

  const currentKeepaliveEnabled = sessionFallbackDirty
    ? SESSION_FALLBACK_DOM.keepaliveToggle.checked
    : status.config?.keepaliveEnabled === true;

  if (!sessionFallbackDirty) {
    syncConfigInput(SESSION_FALLBACK_DOM.keepaliveToggle, currentKeepaliveEnabled);
    syncConfigInput(SESSION_FALLBACK_DOM.primaryUserIdInput, status.config?.primaryUserId ?? '');
    syncConfigInput(SESSION_FALLBACK_DOM.primaryPasswordInput, status.config?.primaryPassword ?? '');
    syncConfigInput(SESSION_FALLBACK_DOM.backupUserIdInput, status.config?.backupUserId ?? '');
    syncConfigInput(SESSION_FALLBACK_DOM.backupPasswordInput, status.config?.backupPassword ?? '');
  }

  updateToggle(
    { toggleBtn: SESSION_FALLBACK_DOM.keepaliveToggle, toggleLabel: SESSION_FALLBACK_DOM.keepaliveLabel },
    currentKeepaliveEnabled,
  );
  SESSION_FALLBACK_DOM.activeAccountText.textContent = status.activeAccountLabel || '계정1';
  updateStatusText(
    SESSION_FALLBACK_DOM.automationStateText,
    buildSessionAutomationStateLabel(status),
    status.sessionAutomationInProgress ? 'status-warn' : 'status-on',
  );
  if (status.switchInProgress) {
    updateStatusText(
      SESSION_FALLBACK_DOM.switchStateText,
      status.switchTargetAccountLabel
        ? `🟠 ${status.switchTargetAccountLabel} 전환 중`
        : '🟠 전환 중',
      'status-warn',
    );
  } else {
    updateStatusText(SESSION_FALLBACK_DOM.switchStateText, '🟢 대기', 'status-on');
  }

  updateStatusText(
    SESSION_FALLBACK_DOM.loginHealthText,
    buildSessionFallbackLoginHealthLabel(status),
    getSessionFallbackLoginHealthClassName(status),
  );
  SESSION_FALLBACK_DOM.lastDeleteLimitAccountText.textContent = status.lastDeleteLimitAccountLabel || '-';
  SESSION_FALLBACK_DOM.metaText.textContent = buildSessionFallbackMetaText(status);
  const isAutomationBusy = Boolean(status.switchInProgress || status.sessionAutomationInProgress);
  setDisabled(SESSION_FALLBACK_DOM.primaryUserIdInput, isAutomationBusy);
  setDisabled(SESSION_FALLBACK_DOM.primaryPasswordInput, isAutomationBusy);
  setDisabled(SESSION_FALLBACK_DOM.backupUserIdInput, isAutomationBusy);
  setDisabled(SESSION_FALLBACK_DOM.backupPasswordInput, isAutomationBusy);
  setDisabled(SESSION_FALLBACK_DOM.keepaliveToggle, isAutomationBusy);
  setDisabled(SESSION_FALLBACK_DOM.saveConfigBtn, isAutomationBusy);
  setDisabled(SESSION_FALLBACK_DOM.testSwitchBtn, isAutomationBusy);
}

function hasPendingSessionFallbackCredentialEdits() {
  const statusConfig = latestSessionFallbackStatus?.config || {};
  return String(SESSION_FALLBACK_DOM.primaryUserIdInput.value.trim()) !== String(statusConfig.primaryUserId ?? '').trim()
    || String(SESSION_FALLBACK_DOM.primaryPasswordInput.value) !== String(statusConfig.primaryPassword ?? '')
    || String(SESSION_FALLBACK_DOM.backupUserIdInput.value.trim()) !== String(statusConfig.backupUserId ?? '').trim()
    || String(SESSION_FALLBACK_DOM.backupPasswordInput.value) !== String(statusConfig.backupPassword ?? '');
}

function revertSessionFallbackKeepaliveToggle() {
  const storedKeepaliveEnabled = latestSessionFallbackStatus?.config?.keepaliveEnabled === true;
  SESSION_FALLBACK_DOM.keepaliveToggle.checked = storedKeepaliveEnabled;
  updateToggle(
    { toggleBtn: SESSION_FALLBACK_DOM.keepaliveToggle, toggleLabel: SESSION_FALLBACK_DOM.keepaliveLabel },
    storedKeepaliveEnabled,
  );
  sessionFallbackDirty = hasPendingSessionFallbackCredentialEdits();
}

async function persistSessionFallbackConfig(options = {}) {
  const {
    failureMessage = '계정 전환 설정 저장에 실패했습니다.',
    suppressFlash = false,
    revertOnFailure = false,
  } = options;

  const config = {
    keepaliveEnabled: SESSION_FALLBACK_DOM.keepaliveToggle.checked,
    primaryUserId: SESSION_FALLBACK_DOM.primaryUserIdInput.value.trim(),
    primaryPassword: SESSION_FALLBACK_DOM.primaryPasswordInput.value,
    backupUserId: SESSION_FALLBACK_DOM.backupUserIdInput.value.trim(),
    backupPassword: SESSION_FALLBACK_DOM.backupPasswordInput.value,
  };

  const response = await sendMessage({ action: 'updateSessionFallbackConfig', config });
  if (!response?.success) {
    alert(response?.message || failureMessage);
    if (revertOnFailure && response?.sessionFallbackStatus) {
      sessionFallbackDirty = false;
      updateSessionFallbackUI(response.sessionFallbackStatus);
    } else if (revertOnFailure) {
      revertSessionFallbackKeepaliveToggle();
    }
    if (response?.statuses) {
      applyStatuses(response.statuses);
    }
    return false;
  }

  sessionFallbackDirty = false;
  if (!suppressFlash) {
    flashSaved(SESSION_FALLBACK_DOM.saveConfigBtn);
  }
  if (response?.sessionFallbackStatus) {
    updateSessionFallbackUI(response.sessionFallbackStatus);
  }
  if (response?.statuses) {
    applyStatuses(response.statuses);
  }
  return true;
}

function updateConceptMonitorUI(status) {
  if (!status) {
    return;
  }

  latestConceptMonitorStatus = status;
  const dom = FEATURE_DOM.conceptMonitor;
  updateToggle(dom, status.isRunning);
  updateStatusText(dom.statusText, getConceptMonitorStatusLabel(status), getConceptMonitorStatusClassName(status));
  dom.modeText.textContent = status.config?.testMode === false ? '실행' : '테스트';
  updateConceptAutoCutStateText(dom.autoCutStateText, status.autoCutState || 'NORMAL');
  dom.lastPollAt.textContent = formatTimestamp(status.lastPollAt);
  dom.currentPostNo.textContent = status.isRunning && status.currentPostNo > 0
    ? `#${status.currentPostNo}`
    : '-';
  dom.lastScanCount.textContent = `${status.lastScanCount ?? 0}개`;
  dom.lastCandidateCount.textContent = `${status.lastCandidateCount ?? 0}건`;
  dom.totalDetectedCount.textContent = `${status.totalDetectedCount ?? 0}건`;
  dom.totalReleasedCount.textContent = `${status.totalReleasedCount ?? 0}건`;
  dom.totalFailedCount.textContent = `${status.totalFailedCount ?? 0}건`;
  dom.totalUnclearCount.textContent = `${status.totalUnclearCount ?? 0}건`;
  dom.lastRecommendDelta.textContent = `${status.lastRecommendDelta ?? 0}개`;
  dom.lastComparedPostCount.textContent = `${status.lastComparedPostCount ?? 0}개`;
  dom.lastCutChangedAt.textContent = formatTimestamp(status.lastCutChangedAt);

  syncFeatureConfigInputs('conceptMonitor', [
    [dom.pollIntervalMsInput, status.config?.pollIntervalMs ?? 30000],
    [dom.snapshotPostLimitInput, status.config?.snapshotPostLimit ?? 5],
    [dom.fluidRatioThresholdInput, status.config?.fluidRatioThresholdPercent ?? 88],
    [dom.testModeInput, status.config?.testMode === true],
    [dom.autoCutEnabledInput, status.config?.autoCutEnabled === true],
    [dom.autoCutPollIntervalMsInput, status.config?.autoCutPollIntervalMs ?? 30000],
    [dom.autoCutAttackThresholdInput, status.config?.autoCutAttackRecommendThreshold ?? 25],
    [dom.autoCutAttackConsecutiveCountInput, status.config?.autoCutAttackConsecutiveCount ?? 1],
    [dom.autoCutReleaseThresholdInput, status.config?.autoCutReleaseRecommendThreshold ?? 15],
    [dom.autoCutReleaseConsecutiveCountInput, status.config?.autoCutReleaseConsecutiveCount ?? 5],
  ]);
  updateToggle({ toggleBtn: dom.autoCutEnabledInput, toggleLabel: dom.autoCutEnabledLabel }, dom.autoCutEnabledInput.checked);
  updateLogList(dom.logList, status.logs);
}

function updateConceptPatrolUI(status) {
  if (!status) {
    return;
  }

  latestConceptPatrolStatus = status;
  const dom = FEATURE_DOM.conceptPatrol;
  updateToggle(dom, status.isRunning);
  updateStatusText(dom.statusText, getConceptPatrolStatusLabel(status), getConceptPatrolStatusClassName(status));
  dom.modeText.textContent = status.config?.testMode === false ? '실행' : '테스트';
  updateConceptPatrolHoldStateText(dom.holdStateText, status.patrolHoldActive);
  dom.effectiveRecommendCutText.textContent = String(status.effectiveRecommendCut ?? 14);
  dom.lastPollAt.textContent = formatTimestamp(status.lastPollAt);
  dom.currentPosition.textContent = status.isRunning && status.currentPage > 0
    ? `${status.currentPage}P${status.currentPostNo > 0 ? ` / #${status.currentPostNo}` : ''}`
    : '-';
  dom.lastDetectedMaxPage.textContent = status.lastDetectedMaxPage > 0
    ? `${status.lastDetectedMaxPage}페이지`
    : '-';
  dom.lastWindowSize.textContent = `${status.lastWindowSize ?? 0}개`;
  dom.lastNewPostCount.textContent = `${status.lastNewPostCount ?? 0}건`;
  dom.lastCandidateCount.textContent = `${status.lastCandidateCount ?? 0}건`;
  dom.totalDetectedCount.textContent = `${status.totalDetectedCount ?? 0}건`;
  dom.totalReleasedCount.textContent = `${status.totalReleasedCount ?? 0}건`;
  dom.totalFailedCount.textContent = `${status.totalFailedCount ?? 0}건`;
  dom.totalUnclearCount.textContent = `${status.totalUnclearCount ?? 0}건`;
  dom.holdUntilText.textContent = formatTimestamp(status.patrolHoldUntilTs);
  dom.lastCutChangedAt.textContent = formatTimestamp(status.lastCutChangedAt);

  syncFeatureConfigInputs('conceptPatrol', [
    [dom.pollIntervalMsInput, status.config?.pollIntervalMs ?? 30000],
    [dom.patrolPagesInput, status.config?.patrolPages ?? 5],
    [dom.pageRequestDelayInput, status.config?.pageRequestDelayMs ?? 500],
    [dom.fluidRatioThresholdInput, status.config?.fluidRatioThresholdPercent ?? 90],
    [dom.candidateThresholdInput, status.config?.patrolDefendingCandidateThreshold ?? 2],
    [dom.holdMsInput, status.config?.patrolDefendingHoldMs ?? 300000],
    [dom.testModeInput, status.config?.testMode === true],
  ]);
  updateLogList(dom.logList, status.logs);
}

function updateHanRefreshIpBanUI(status) {
  if (!status) {
    return;
  }

  const dom = FEATURE_DOM.hanRefreshIpBan;
  updateToggle(dom, status.isRunning);
  updateStatusText(
    dom.statusText,
    getHanRefreshIpBanStatusLabel(status),
    getHanRefreshIpBanStatusClassName(status),
  );
  dom.phaseText.textContent = status.phase || 'IDLE';
  dom.currentPage.textContent = status.isRunning && status.currentPage > 0
    ? `${status.currentPage}페이지`
    : '-';
  dom.detectedMaxPage.textContent = status.detectedMaxPage > 0
    ? `${status.detectedMaxPage}페이지`
    : '-';
  dom.currentCycleScannedRows.textContent = `${status.currentCycleScannedRows ?? 0}줄`;
  dom.currentCycleMatchedRows.textContent = `${status.currentCycleMatchedRows ?? 0}줄`;
  dom.currentCycleBanSuccessCount.textContent = `${status.currentCycleBanSuccessCount ?? 0}건`;
  dom.currentCycleBanFailureCount.textContent = `${status.currentCycleBanFailureCount ?? 0}건`;
  dom.lastRunAt.textContent = formatTimestamp(status.lastRunAt);
  dom.nextRunAt.textContent = formatTimestamp(status.nextRunAt);

  syncFeatureConfigInputs('hanRefreshIpBan', [
    [dom.requestDelayInput, status.config?.requestDelay ?? 500],
    [dom.fallbackMaxPageInput, status.config?.fallbackMaxPage ?? 400],
  ]);
  updateLogList(dom.logList, status.logs);
}

function updateBumpPostUI(status) {
  const dom = FEATURE_DOM.bumpPost;
  if (!dom?.toggleBtn) {
    return;
  }

  const nextStatus = status || buildDefaultBumpPostStatus();
  latestBumpPostStatus = nextStatus;

  updateToggle(dom, nextStatus.isRunning);
  updateStatusText(
    dom.statusText,
    getBumpPostStatusLabel(nextStatus),
    getBumpPostStatusClassName(nextStatus),
  );
  dom.phaseText.textContent = nextStatus.phase || 'IDLE';
  dom.targetPostNoText.textContent = nextStatus.config?.postNo ? `#${nextStatus.config.postNo}` : '-';
  dom.startedAtText.textContent = formatTimestamp(nextStatus.startedAt);
  dom.endsAtText.textContent = formatTimestamp(nextStatus.endsAt);
  dom.nextRunAtText.textContent = formatTimestamp(nextStatus.nextRunAt);
  dom.lastBumpedAtText.textContent = formatTimestamp(nextStatus.lastBumpedAt);
  dom.lastBumpedPostNoText.textContent = nextStatus.lastBumpedPostNo ? `#${nextStatus.lastBumpedPostNo}` : '-';
  dom.totalBumpedCountText.textContent = `${nextStatus.totalBumpedCount ?? 0}회`;
  dom.totalFailedCountText.textContent = `${nextStatus.totalFailedCount ?? 0}회`;
  dom.cycleCountText.textContent = `${nextStatus.cycleCount ?? 0}회`;
  dom.lastErrorAtText.textContent = formatTimestamp(nextStatus.lastErrorAt);
  dom.metaText.textContent = buildBumpPostMetaText(nextStatus);
  syncFeatureConfigInputs('bumpPost', [
    [dom.postNoInput, nextStatus.config?.postNo ?? ''],
    [dom.durationMinutesInput, nextStatus.config?.durationMinutes ?? 60],
    [dom.intervalMinutesInput, nextStatus.config?.intervalMinutes ?? 1],
  ]);
  updateLogList(dom.logList, nextStatus.logs);

  const isLocked = Boolean(nextStatus.isRunning);
  getFeatureConfigInputs('bumpPost').forEach((input) => setDisabled(input, isLocked));
  setDisabled(dom.saveConfigBtn, isLocked);
  setDisabled(dom.resetBtn, false);
  setDisabled(dom.toggleBtn, false);
}

function updateSinmungoCommentUI(status) {
  const dom = FEATURE_DOM.sinmungoComment;
  if (!dom?.toggleBtn) {
    return;
  }

  const nextStatus = status || buildDefaultSinmungoCommentStatus();
  latestSinmungoCommentStatus = nextStatus;
  const pendingChallenge = normalizeSinmungoCommentPendingChallenge(nextStatus.pendingChallenge);
  const phase = String(nextStatus.phase || '').trim().toUpperCase();
  const isRunning = Boolean(nextStatus.isRunning);
  const isWaitingCode = isRunning && phase === 'WAITING_CODE';

  updateToggle(dom, nextStatus.isRunning);
  updateStatusText(
    dom.statusText,
    getSinmungoCommentStatusLabel(nextStatus),
    getSinmungoCommentStatusClassName(nextStatus),
  );
  dom.phaseText.textContent = nextStatus.phase || 'IDLE';
  dom.targetPostNoText.textContent = nextStatus.lastTargetPostNo
    ? `#${nextStatus.lastTargetPostNo}`
    : (nextStatus.config?.postNo ? `#${nextStatus.config.postNo}` : '-');
  dom.lastSubmittedAtText.textContent = formatTimestamp(nextStatus.lastSubmittedAt);
  dom.lastVerifiedAtText.textContent = formatTimestamp(nextStatus.lastVerifiedAt);
  dom.lastCommentNoText.textContent = nextStatus.lastCommentNo ? `#${nextStatus.lastCommentNo}` : '-';
  dom.totalSubmittedCountText.textContent = `${nextStatus.totalSubmittedCount ?? 0}회`;
  dom.totalFailedCountText.textContent = `${nextStatus.totalFailedCount ?? 0}회`;
  dom.lastErrorAtText.textContent = formatTimestamp(nextStatus.lastErrorAt);
  dom.metaText.textContent = buildSinmungoCommentMetaText(nextStatus);

  syncFeatureConfigInputs('sinmungoComment', [
    [dom.postNoInput, nextStatus.config?.postNo ?? ''],
    [dom.submitModeInput, nextStatus.config?.submitMode ?? 'member'],
    [dom.memoInput, nextStatus.config?.memo ?? '처리완료'],
    [dom.anonymousNameInput, nextStatus.config?.name ?? 'ㅇㅇ'],
    [dom.passwordInput, nextStatus.config?.password ?? ''],
  ]);
  syncSinmungoCommentModeInputs(nextStatus);
  updateSinmungoCommentChallengeUI(nextStatus, pendingChallenge);
  updateLogList(dom.logList, nextStatus.logs);

  getFeatureConfigInputs('sinmungoComment').forEach((input) => setDisabled(input, isRunning));
  syncSinmungoCommentModeInputs(nextStatus);
  setDisabled(dom.saveConfigBtn, isRunning);
  setDisabled(dom.resetBtn, false);
  setDisabled(dom.toggleBtn, false);
  setDisabled(dom.refreshCaptchaBtn, !isWaitingCode);
  setDisabled(dom.submitCaptchaBtn, !isWaitingCode);
  setDisabled(dom.cancelCaptchaBtn, !isRunning);
  setDisabled(dom.codeInput, !isWaitingCode || !pendingChallenge?.requiresCode);
  setDisabled(dom.challengeNameInput, !isWaitingCode || !pendingChallenge?.nameEditable);
}

function updateSinmungoCommentChallengeUI(status, pendingChallenge) {
  const dom = FEATURE_DOM.sinmungoComment;
  const phase = String(status?.phase || '').trim().toUpperCase();
  const isPreparing = Boolean(status?.isRunning) && phase === 'PREPARING_CHALLENGE';
  const isWaitingCode = Boolean(status?.isRunning) && phase === 'WAITING_CODE';
  const shouldShow = isPreparing || isWaitingCode || Boolean(pendingChallenge?.challengeId);
  const nextChallengeId = String(pendingChallenge?.challengeId || '').trim();

  dom.challengeSection.hidden = !shouldShow;
  if (!shouldShow) {
    latestRenderedSinmungoCommentChallengeId = '';
    dom.challengePreparedAtText.textContent = '-';
    dom.challengeIdentityText.textContent = '-';
    dom.challengeMetaText.textContent = '인증코드가 필요한 글이면 여기에 이미지와 입력칸이 나타납니다.';
    dom.challengeNameItem.hidden = true;
    dom.codeInput.value = '';
    dom.challengeNameInput.value = '';
    dom.captchaImage.removeAttribute('src');
    return;
  }

  dom.challengePreparedAtText.textContent = formatTimestamp(pendingChallenge?.preparedAt);
  dom.challengeIdentityText.textContent = pendingChallenge?.useGallNick === 'Y'
    ? `갤닉 고정 (${pendingChallenge.gallNickName || '-'})`
    : '직접 입력';
  dom.challengeMetaText.textContent = buildSinmungoCommentChallengeMetaText(status, pendingChallenge);
  dom.challengeNameItem.hidden = !pendingChallenge?.nameEditable;

  if (!nextChallengeId) {
    latestRenderedSinmungoCommentChallengeId = '';
    dom.codeInput.value = '';
    if (document.activeElement !== dom.challengeNameInput) {
      dom.challengeNameInput.value = '';
    }
  } else if (nextChallengeId !== latestRenderedSinmungoCommentChallengeId) {
    dom.codeInput.value = '';
    dom.challengeNameInput.value = pendingChallenge?.anonymousName
      || status?.config?.name
      || 'ㅇㅇ';
    latestRenderedSinmungoCommentChallengeId = nextChallengeId;
  } else if (
    pendingChallenge?.nameEditable
    && document.activeElement !== dom.challengeNameInput
    && !normalizeSinmungoCommentDisplayNameInputValue(dom.challengeNameInput.value)
  ) {
    dom.challengeNameInput.value = pendingChallenge?.anonymousName
      || status?.config?.name
      || 'ㅇㅇ';
  }

  const nextCaptchaImageUrl = String(pendingChallenge?.captchaImageUrl || '').trim();
  if (nextCaptchaImageUrl) {
    if (dom.captchaImage.getAttribute('src') !== nextCaptchaImageUrl) {
      dom.captchaImage.setAttribute('src', nextCaptchaImageUrl);
    }
  } else {
    dom.captchaImage.removeAttribute('src');
  }
}

function updateSelfHostedVpnUI(status) {
  const dom = FEATURE_DOM.selfHostedVpn;
  if (!dom?.toggleBtn) {
    return;
  }

  const nextStatus = status || buildDefaultSelfHostedVpnStatus();
  latestSelfHostedVpnStatus = nextStatus;
  const rawRelayCatalog = normalizeSelfHostedVpnRawRelayCatalogStatus(nextStatus.rawRelayCatalog);
  const parallelProbe = normalizeSelfHostedVpnParallelProbeStatus(nextStatus.parallelProbe);
  const agentGuideState = buildSelfHostedVpnAgentGuideState(nextStatus);

  const ipv4RouteDisplay = getSelfHostedVpnIpv4RouteDisplay(nextStatus);
  const ipv6RouteDisplay = getSelfHostedVpnIpv6RouteDisplay(nextStatus);
  const dnsDisplay = getSelfHostedVpnDnsDisplay(nextStatus);

  updateToggle(dom, nextStatus.isRunning);
  updateStatusText(
    dom.statusText,
    getSelfHostedVpnStatusLabel(nextStatus),
    getSelfHostedVpnStatusClassName(nextStatus),
  );
  updateStatusText(
    dom.agentHealthText,
    getSelfHostedVpnAgentHealthLabel(nextStatus),
    getSelfHostedVpnAgentHealthClassName(nextStatus),
  );
  dom.agentVersionText.textContent = nextStatus.agentVersion || '-';
  dom.profileIdText.textContent = getSelfHostedVpnEffectiveProfileId(nextStatus) || '-';
  dom.connectionModeText.textContent = getSelfHostedVpnConnectionModeLabel(nextStatus);
  dom.relayText.textContent = buildSelfHostedVpnRelayText(nextStatus);
  dom.sslPortText.textContent = buildSelfHostedVpnSelectedSslPortText(nextStatus);
  dom.currentPublicIpText.textContent = buildSelfHostedVpnPublicIpText(
    nextStatus.currentPublicIp,
    nextStatus.publicIpProvider,
  );
  dom.publicIpBeforeText.textContent = nextStatus.publicIpBefore || '-';
  dom.publicIpAfterText.textContent = nextStatus.publicIpAfter || '-';
  dom.activeAdapterText.textContent = nextStatus.activeAdapterName || '-';
  updateStatusText(dom.ipv4RouteText, ipv4RouteDisplay.text, ipv4RouteDisplay.className);
  updateStatusText(dom.ipv6RouteText, ipv6RouteDisplay.text, ipv6RouteDisplay.className);
  updateStatusText(dom.dnsChangedText, dnsDisplay.text, dnsDisplay.className);
  dom.lastSyncAtText.textContent = formatTimestamp(nextStatus.lastSyncAt);
  dom.lastHealthAtText.textContent = formatTimestamp(nextStatus.lastHealthAt);
  dom.connectedAtText.textContent = formatTimestamp(nextStatus.connectedAt);
  dom.lastErrorCodeText.textContent = nextStatus.lastErrorCode || '-';
  dom.metaText.textContent = buildSelfHostedVpnMetaText(nextStatus);
  if (dom.agentGuideCard) {
    dom.agentGuideCard.className = `manual-utility-card self-hosted-vpn-agent-guide-card${agentGuideState.isWarning ? ' manual-warning-card' : ''}`;
  }
  updateStatusText(
    dom.agentGuideStatusText,
    agentGuideState.statusText,
    agentGuideState.statusClassName,
  );
  dom.agentGuideMetaText.textContent = agentGuideState.metaText;
  dom.agentGuideAddressText.textContent = agentGuideState.baseUrl;
  dom.agentGuideFallbackAddressText.textContent = agentGuideState.fallbackUrl;
  dom.agentGuideRepoPathText.textContent = agentGuideState.repoPath;
  dom.copyAgentStartBtn.textContent = `기본 실행 명령 복사`;
  dom.copyAgentFallbackBtn.textContent = `${agentGuideState.fallbackPort} 대체 명령 복사`;
  dom.useFallbackAgentUrlBtn.textContent = `${agentGuideState.fallbackPort} 주소 채우기`;
  dom.copyAgentStopBtn.textContent = `종료 명령 복사`;
  dom.copyAgentStartBtn.__flashSavedOriginalText = dom.copyAgentStartBtn.textContent;
  dom.copyAgentFallbackBtn.__flashSavedOriginalText = dom.copyAgentFallbackBtn.textContent;
  dom.useFallbackAgentUrlBtn.__flashSavedOriginalText = dom.useFallbackAgentUrlBtn.textContent;
  dom.copyAgentStopBtn.__flashSavedOriginalText = dom.copyAgentStopBtn.textContent;
  updateSelfHostedVpnAgentGuidePreview('primary', agentGuideState);
  dom.parallelStatusText.textContent = buildSelfHostedVpnParallelStatusText(parallelProbe);
  dom.parallelRouteOwnerText.textContent = parallelProbe.routeOwnerSlotId || '-';
  dom.parallelVerifiedIpText.textContent = buildSelfHostedVpnPublicIpText(
    parallelProbe.lastVerifiedPublicIp,
    parallelProbe.lastVerifiedPublicIpProvider,
  );
  dom.parallelSlotsText.textContent = buildSelfHostedVpnParallelSlotsText(parallelProbe);
  dom.parallelMetaText.textContent = buildSelfHostedVpnParallelMetaText(parallelProbe);
  updateStatusText(
    dom.catalogStatusText,
    buildSelfHostedVpnCatalogStatusText(rawRelayCatalog),
    getSelfHostedVpnCatalogStatusClassName(rawRelayCatalog),
  );
  dom.catalogCountText.textContent = buildSelfHostedVpnCatalogCountText(rawRelayCatalog);
  dom.catalogMetaText.textContent = buildSelfHostedVpnCatalogMetaText(nextStatus, rawRelayCatalog);
  renderSelfHostedVpnCatalogList(dom.catalogList, nextStatus, rawRelayCatalog, parallelProbe);

  syncFeatureConfigInputs('selfHostedVpn', [
    [dom.agentBaseUrlInput, nextStatus.config?.agentBaseUrl ?? 'http://127.0.0.1:8765'],
    [dom.authTokenInput, nextStatus.config?.authToken ?? ''],
    [dom.connectionModeInput, nextStatus.config?.connectionMode ?? 'profile'],
    [dom.profileIdInput, nextStatus.config?.profileId ?? ''],
    [dom.relayIdInput, nextStatus.config?.selectedRelayId ?? nextStatus.config?.relaySnapshot?.id ?? ''],
    [dom.relayFqdnInput, nextStatus.config?.relaySnapshot?.fqdn ?? ''],
    [dom.relayIpInput, nextStatus.config?.relaySnapshot?.ip ?? ''],
    [dom.selectedSslPortInput, nextStatus.config?.selectedSslPort || ''],
    [dom.relayUdpPortInput, nextStatus.config?.relaySnapshot?.udpPort || ''],
    [dom.relayHostUniqueKeyInput, nextStatus.config?.relaySnapshot?.hostUniqueKey ?? ''],
    [dom.requestTimeoutMsInput, nextStatus.config?.requestTimeoutMs ?? 3000],
    [dom.actionTimeoutMsInput, nextStatus.config?.actionTimeoutMs ?? 15000],
  ]);
  updateLogList(dom.logList, buildSelfHostedVpnLogEntries(nextStatus.logs, rawRelayCatalog.logs, parallelProbe.logs));

  const isLocked = Boolean(nextStatus.isRunning || parallelProbe.isRunning);
  const singleToggleLocked = Boolean(parallelProbe.isRunning && !nextStatus.isRunning);
  getFeatureConfigInputs('selfHostedVpn').forEach((input) => setDisabled(input, isLocked));
  updateSelfHostedVpnConfigModeFields({
    connectionMode: nextStatus.config?.connectionMode ?? 'profile',
    isLocked,
  });
  setDisabled(dom.saveConfigBtn, isLocked);
  setDisabled(dom.refreshBtn, false);
  setDisabled(dom.primeNicsBtn, isLocked);
  setDisabled(dom.parallelRefreshBtn, false);
  setDisabled(dom.parallelStartBtn, isLocked);
  setDisabled(dom.parallelStopBtn, !parallelProbe.isRunning);
  setDisabled(dom.resetBtn, isLocked);
  setDisabled(dom.toggleBtn, singleToggleLocked);
}

function updateRefluxDatasetCollectorUI(status) {
  const dom = FEATURE_DOM.refluxDatasetCollector;
  if (!dom?.toggleBtn) {
    return;
  }

  const nextStatus = status || buildDefaultRefluxDatasetCollectorStatus();
  latestRefluxDatasetCollectorStatus = nextStatus;
  const displayGalleryId = String(nextStatus.collectedGalleryId || nextStatus.config?.galleryId || '');

  updateToggle(dom, nextStatus.isRunning);
  updateStatusText(
    dom.statusText,
    getRefluxDatasetCollectorStatusLabel(nextStatus),
    getRefluxDatasetCollectorStatusClassName(nextStatus),
  );
  dom.phaseText.textContent = nextStatus.phase || 'IDLE';
  dom.galleryIdText.textContent = displayGalleryId || '-';
  dom.progressText.textContent = buildRefluxDatasetCollectorProgressText(nextStatus);
  dom.fetchedPageCountText.textContent = `${nextStatus.fetchedPageCount ?? 0}페이지`;
  dom.rawTitleCountText.textContent = `${nextStatus.rawTitleCount ?? 0}개`;
  dom.normalizedTitleCountText.textContent = `${nextStatus.normalizedTitleCount ?? 0}개`;
  dom.startedAtText.textContent = formatTimestamp(nextStatus.startedAt);
  dom.finishedAtText.textContent = formatTimestamp(nextStatus.finishedAt);
  dom.exportVersionText.textContent = nextStatus.exportVersion || '-';
  dom.lastErrorText.textContent = nextStatus.lastError || '-';
  dom.metaText.textContent = buildRefluxDatasetCollectorMetaText(nextStatus);
  syncFeatureConfigInputs('refluxDatasetCollector', [
    [dom.galleryIdInput, nextStatus.config?.galleryId ?? ''],
    [dom.startPageInput, nextStatus.config?.startPage ?? 1],
    [dom.endPageInput, nextStatus.config?.endPage ?? 397],
    [dom.requestDelayMsInput, nextStatus.config?.requestDelayMs ?? 1200],
    [dom.jitterMsInput, nextStatus.config?.jitterMs ?? 400],
  ]);
  updateLogList(dom.logList, nextStatus.logs);

  const isLocked = Boolean(nextStatus.isRunning);
  getFeatureConfigInputs('refluxDatasetCollector').forEach((input) => setDisabled(input, isLocked));
  setDisabled(dom.saveConfigBtn, isLocked);
  setDisabled(dom.downloadBtn, isLocked || !nextStatus.downloadReady);
  setDisabled(dom.resetBtn, isLocked);
  setDisabled(dom.toggleBtn, false);
}

function updateRefluxOverlayCollectorUI(status) {
  const dom = FEATURE_DOM.refluxOverlayCollector;
  if (!dom?.toggleBtn) {
    return;
  }

  const nextStatus = status || buildDefaultRefluxOverlayCollectorStatus();
  latestRefluxOverlayCollectorStatus = nextStatus;

  updateToggle(dom, nextStatus.isRunning);
  updateStatusText(
    dom.statusText,
    getRefluxOverlayCollectorStatusLabel(nextStatus),
    getRefluxOverlayCollectorStatusClassName(nextStatus),
  );
  dom.phaseText.textContent = nextStatus.phase || 'IDLE';
  dom.galleryIdText.textContent = nextStatus.galleryId || '-';
  dom.targetPostNoText.textContent = nextStatus.targetPostNo > 0
    ? `#${nextStatus.targetPostNo}`
    : '-';
  dom.foundPageText.textContent = nextStatus.foundPage > 0
    ? `${nextStatus.foundPage} / ${nextStatus.totalPageCount || nextStatus.foundPage}`
    : '-';
  dom.progressText.textContent = buildRefluxOverlayCollectorProgressText(nextStatus);
  dom.normalizedTitleCountText.textContent = `${nextStatus.normalizedTitleCount ?? 0}개`;
  dom.appliedOverlayIdText.textContent = nextStatus.appliedOverlayId || '-';
  dom.startedAtText.textContent = formatTimestamp(nextStatus.startedAt);
  dom.finishedAtText.textContent = formatTimestamp(nextStatus.finishedAt);
  dom.lastErrorText.textContent = nextStatus.lastError || '-';
  dom.metaText.textContent = buildRefluxOverlayCollectorMetaText(nextStatus);
  syncFeatureConfigInputs('refluxOverlayCollector', [
    [dom.viewUrlInput, nextStatus.config?.viewUrl ?? ''],
    [dom.beforePagesInput, nextStatus.config?.beforePages ?? 30],
    [dom.afterPagesInput, nextStatus.config?.afterPages ?? 30],
    [dom.requestDelayMsInput, nextStatus.config?.requestDelayMs ?? 500],
    [dom.jitterMsInput, nextStatus.config?.jitterMs ?? 100],
    [dom.transportModeInput, nextStatus.config?.transportMode ?? 'direct'],
    [dom.proxyWorkerCountInput, nextStatus.config?.proxyWorkerCount ?? 10],
  ]);
  updateLogList(dom.logList, nextStatus.logs);
  renderRefluxOverlayCollectorOverlayList(latestRefluxOverlayCollectorOverlays);
  if (
    !latestRefluxOverlayCollectorOverlaysLoaded
    && !nextStatus.isRunning
    && nextStatus.appliedOverlayId
    && !latestRefluxOverlayCollectorOverlays.some((overlay) => overlay?.overlayId === nextStatus.appliedOverlayId)
  ) {
    void refreshRefluxOverlayCollectorOverlays();
  }

  const isLocked = Boolean(nextStatus.isRunning);
  getFeatureConfigInputs('refluxOverlayCollector').forEach((input) => setDisabled(input, isLocked));
  setDisabled(dom.saveConfigBtn, isLocked);
  setDisabled(dom.resetBtn, isLocked);
  setDisabled(dom.clearOverlaysBtn, isLocked || latestRefluxOverlayCollectorOverlays.length <= 0);
  setDisabled(dom.toggleBtn, false);
}

async function refreshRefluxOverlayCollectorOverlays() {
  const response = await sendFeatureMessage('refluxOverlayCollector', { action: 'listOverlays' });
  if (!response?.success) {
    return;
  }

  latestRefluxOverlayCollectorOverlays = Array.isArray(response.overlays)
    ? response.overlays
    : [];
  latestRefluxOverlayCollectorOverlaysLoaded = true;
  renderRefluxOverlayCollectorOverlayList(latestRefluxOverlayCollectorOverlays);

  if (response.statuses) {
    applyStatuses(response.statuses);
  }
}

function renderRefluxOverlayCollectorOverlayList(overlays = []) {
  const dom = FEATURE_DOM.refluxOverlayCollector;
  if (!dom?.overlayList) {
    return;
  }

  dom.overlayList.innerHTML = '';
  if (!Array.isArray(overlays) || overlays.length <= 0) {
    dom.overlayList.innerHTML = '<div class="log-empty">저장된 overlay가 없습니다.</div>';
    return;
  }

  const isLocked = Boolean(latestRefluxOverlayCollectorStatus?.isRunning);
  overlays.forEach((overlay) => {
    const row = document.createElement('div');
    row.className = 'log-item';

    const title = document.createElement('div');
    const galleryId = String(overlay?.galleryId || '').trim() || '-';
    const anchorPostNo = Number(overlay?.anchorPostNo) || 0;
    const startPage = Number(overlay?.startPage) || 0;
    const endPage = Number(overlay?.endPage) || 0;
    const titleCount = Number(overlay?.titleCount) || 0;
    const createdAt = formatTimestamp(overlay?.createdAt);
    const failedPageCount = Array.isArray(overlay?.failedPages)
      ? overlay.failedPages.length
      : 0;
    title.textContent = `${galleryId} #${anchorPostNo} / ${startPage}~${endPage} / ${titleCount}개 / ${createdAt}${failedPageCount > 0 ? ` / 실패 ${failedPageCount}p` : ''}`;

    const button = document.createElement('button');
    button.className = 'btn btn-secondary';
    button.textContent = '삭제';
    button.dataset.overlayId = String(overlay?.overlayId || '');
    button.disabled = isLocked;

    row.appendChild(title);
    row.appendChild(button);
    dom.overlayList.appendChild(row);
  });
}

function updateCommentRefluxCollectorUI(status) {
  const dom = FEATURE_DOM.commentRefluxCollector;
  if (!dom?.toggleBtn) {
    return;
  }

  const nextStatus = status || buildDefaultCommentRefluxCollectorStatus();
  latestCommentRefluxCollectorStatus = nextStatus;
  const displayGalleryId = String(nextStatus.collectedGalleryId || nextStatus.config?.galleryId || '');

  updateToggle(dom, nextStatus.isRunning);
  updateStatusText(
    dom.statusText,
    getCommentRefluxCollectorStatusLabel(nextStatus),
    getCommentRefluxCollectorStatusClassName(nextStatus),
  );
  dom.phaseText.textContent = nextStatus.phase || 'IDLE';
  dom.galleryIdText.textContent = displayGalleryId || '-';
  dom.progressText.textContent = buildCommentRefluxCollectorProgressText(nextStatus);
  dom.currentPostNoText.textContent = nextStatus.isRunning && nextStatus.currentPostNo > 0
    ? `#${nextStatus.currentPostNo}`
    : '-';
  dom.fetchedPageCountText.textContent = `${nextStatus.fetchedPageCount ?? 0}페이지`;
  dom.processedPostCountText.textContent = `${nextStatus.processedPostCount ?? 0}개`;
  dom.failedPostCountText.textContent = `${nextStatus.failedPostCount ?? 0}개`;
  dom.rawCommentCountText.textContent = `${nextStatus.rawCommentCount ?? 0}개`;
  dom.normalizedMemoCountText.textContent = `${nextStatus.normalizedMemoCount ?? 0}개`;
  dom.startedAtText.textContent = formatTimestamp(nextStatus.startedAt);
  dom.finishedAtText.textContent = formatTimestamp(nextStatus.finishedAt);
  dom.exportVersionText.textContent = nextStatus.exportVersion || '-';
  dom.lastErrorText.textContent = nextStatus.lastError || '-';
  dom.metaText.textContent = buildCommentRefluxCollectorMetaText(nextStatus);
  syncFeatureConfigInputs('commentRefluxCollector', [
    [dom.galleryIdInput, nextStatus.config?.galleryId ?? ''],
    [dom.startPageInput, nextStatus.config?.startPage ?? 1],
    [dom.endPageInput, nextStatus.config?.endPage ?? 100],
    [dom.requestDelayMsInput, nextStatus.config?.requestDelayMs ?? 100],
    [dom.cycleDelayMsInput, nextStatus.config?.cycleDelayMs ?? 5000],
    [dom.postConcurrencyInput, nextStatus.config?.postConcurrency ?? 8],
  ]);
  updateLogList(dom.logList, nextStatus.logs);

  const isLocked = Boolean(nextStatus.isRunning);
  getFeatureConfigInputs('commentRefluxCollector').forEach((input) => setDisabled(input, isLocked));
  setDisabled(dom.saveConfigBtn, isLocked);
  setDisabled(dom.downloadBtn, isLocked || !nextStatus.downloadReady);
  setDisabled(dom.resetBtn, isLocked);
  setDisabled(dom.toggleBtn, false);
}

function updateCommentMonitorUI(status) {
  if (!status) {
    return;
  }

  const dom = FEATURE_DOM.commentMonitor;
  updateToggle(dom, status.isRunning);
  updateStatusText(dom.statusText, getCommentMonitorStatusLabel(status), getCommentMonitorStatusClassName(status));
  dom.phaseText.textContent = status.phase || 'SEEDING';
  dom.lastPollAt.textContent = formatTimestamp(status.lastPollAt);
  dom.newCommentCount.textContent = `${status.lastMetrics?.newCommentCount ?? 0}개`;
  dom.verifiedDeletedCount.textContent = `${status.lastMetrics?.verifiedDeletedCount ?? 0}개`;
  dom.changedPostCount.textContent = `${status.lastMetrics?.changedPostCount ?? 0}개`;
  dom.attackHitCount.textContent = `${status.attackHitCount ?? 0}회`;
  dom.releaseHitCount.textContent = `${status.releaseHitCount ?? 0}회`;
  dom.totalAttackDetected.textContent = `${status.totalAttackDetected ?? 0}회`;
  dom.totalAttackReleased.textContent = `${status.totalAttackReleased ?? 0}회`;

  syncFeatureConfigInputs('commentMonitor', [
    [dom.pollIntervalMsInput, status.config?.pollIntervalMs ?? 20000],
    [dom.pagesInput, status.config?.monitorPages ?? 2],
    [dom.attackNewCommentThresholdInput, status.config?.attackNewCommentThreshold ?? 30],
    [dom.attackChangedPostThresholdInput, status.config?.attackChangedPostThreshold ?? 20],
    [dom.attackAltNewCommentThresholdInput, status.config?.attackAltNewCommentThreshold ?? 50],
    [dom.attackAltChangedPostThresholdInput, status.config?.attackAltChangedPostThreshold ?? 9],
    [dom.attackConsecutiveCountInput, status.config?.attackConsecutiveCount ?? 2],
    [dom.releaseNewCommentThresholdInput, status.config?.releaseNewCommentThreshold ?? 30],
    [dom.releaseVerifiedDeleteThresholdInput, status.config?.releaseVerifiedDeleteThreshold ?? 10],
    [dom.releaseConsecutiveCountInput, status.config?.releaseConsecutiveCount ?? 3],
  ]);
  updateLogList(dom.logList, status.logs);
}

function updateTrustedCommandDefenseUI(status) {
  if (!status) {
    return;
  }

  latestTrustedCommandDefenseStatus = status;
  const dom = FEATURE_DOM.trustedCommandDefense;
  updateToggle(dom, status.isRunning);
  updateStatusText(
    dom.statusText,
    getTrustedCommandDefenseStatusLabel(status),
    getTrustedCommandDefenseStatusClassName(status),
  );
  dom.phaseText.textContent = status.phase || 'IDLE';
  dom.lastPollAtText.textContent = formatTimestamp(status.lastPollAt);
  dom.seededAtText.textContent = formatTimestamp(status.seededAt);
  dom.lastSeenCommentNoText.textContent = status.lastSeenCommentNo || '-';
  dom.lastCommandTypeText.textContent = formatTrustedCommandTypeLabel(status.lastCommandType);
  dom.lastCommandCommentNoText.textContent = status.lastCommandCommentNo || '-';
  dom.lastCommandUserIdText.textContent = status.lastCommandUserId || '-';
  dom.postDefenseUntilText.textContent = formatTrustedHoldUntil(status.postDefenseUntilTs);
  dom.commentDefenseUntilText.textContent = formatTrustedHoldUntil(status.commentDefenseUntilTs);
  dom.trustedUserCountText.textContent = `${status.trustedUserCount ?? 0}명`;
  dom.commandPostText.textContent = buildTrustedCommandPostLabel(status);
  dom.metaText.textContent = buildTrustedCommandDefenseMetaText(status);

  if (!DIRTY_FEATURES.trustedCommandDefense) {
    draftTrustedCommandDefenseTrustedUsers = normalizeTrustedCommandDefenseTrustedUsers(
      Array.isArray(status.config?.trustedUsers) && status.config.trustedUsers.length > 0
        ? status.config.trustedUsers
        : parseTrustedCommandDefenseTrustedUsersText(status.config?.trustedUsersText ?? ''),
    );
    syncTrustedCommandDefenseTrustedUsersText();
  }

  syncFeatureConfigInputs('trustedCommandDefense', [
    [dom.commandPostUrlInput, status.config?.commandPostUrl || status.config?.commandPostNo || ''],
    [dom.commandPrefixInput, status.config?.commandPrefix ?? '@특갤봇'],
    [dom.pollIntervalSecondsInput, Math.max(10, Math.round((Number(status.config?.pollIntervalMs) || 20000) / 1000))],
    [dom.holdMinutesInput, Math.max(1, Math.round((Number(status.config?.holdMs) || 600000) / 60000))],
  ]);
  renderTrustedCommandDefenseTrustedUsers(draftTrustedCommandDefenseTrustedUsers);
  updateLogList(dom.logList, status.logs);
}

function updateCommentUI(status) {
  if (!status) {
    return;
  }

  latestCommentStatus = status;
  const dom = FEATURE_DOM.comment;
  updateToggle(dom, status.isRunning);
  updateStatusText(dom.statusText, status.isRunning ? '🟢 실행 중' : '🔴 정지', status.isRunning ? 'status-on' : 'status-off');
  dom.currentPosition.textContent = status.isRunning && status.currentPage > 0
    ? `${status.currentPage}P / #${status.currentPostNo}`
    : '-';
  dom.totalDeleted.textContent = `${status.totalDeleted}개`;
  dom.cycleCount.textContent = `${status.cycleCount}회`;
  dom.manualTimeLimitText.textContent = formatManualTimeLimitStatus(status.manualTimeLimit);

  syncFeatureConfigInputs('comment', [
    [dom.minPageInput, status.config?.minPage ?? 1],
    [dom.maxPageInput, status.config?.maxPage ?? 1],
    [dom.requestDelayInput, status.config?.requestDelay ?? 100],
    [dom.cycleDelayInput, status.config?.cycleDelay ?? 1000],
    [dom.manualTimeLimitMinutesInput, clampManualTimeLimitMinutes(status.config?.manualTimeLimitMinutes ?? 30)],
    [dom.refluxSearchGalleryIdInput, status.config?.refluxSearchGalleryId ?? ''],
    [dom.postConcurrencyInput, status.config?.postConcurrency ?? 50],
    [dom.banOnDeleteInput, status.config?.banOnDelete ?? true],
    [dom.avoidHourInput, status.config?.avoidHour ?? '6'],
  ]);
  if (!INLINE_SETTING_DIRTY.commentVpnGate) {
    syncConfigInput(dom.useVpnGatePrefixFilterInput, status.config?.useVpnGatePrefixFilter ?? false);
  }
  dom.excludePureHangulInput.checked = Boolean(
    status.isRunning
    && status.currentSource === 'manual'
    && status.excludePureHangulMode,
  );
  dom.commentRefluxModeInput.checked = Boolean(
    status.isRunning
    && status.currentSource === 'manual'
    && status.currentAttackMode === 'comment_reflux',
  );
  updateLogList(dom.logList, status.logs);
}

function updatePostUI(status) {
  if (!status) {
    return;
  }

  latestPostStatus = status;
  const dom = FEATURE_DOM.post;
  updateToggle(dom, status.isRunning);
  updateStatusText(dom.statusText, status.isRunning ? '🟢 실행 중' : '🔴 정지', status.isRunning ? 'status-on' : 'status-off');
  dom.currentPosition.textContent = status.isRunning && status.currentPage > 0
    ? `${status.currentPage}페이지`
    : '-';
  dom.totalClassified.textContent = `${status.totalClassified}개`;
  dom.cycleCount.textContent = `${status.cycleCount}회`;
  dom.manualTimeLimitText.textContent = formatManualTimeLimitStatus(status.manualTimeLimit);

  syncFeatureConfigInputs('post', [
    [dom.minPageInput, status.config?.minPage ?? 1],
    [dom.maxPageInput, status.config?.maxPage ?? 1],
    [dom.requestDelayInput, status.config?.requestDelay ?? 500],
    [dom.cycleDelayInput, status.config?.cycleDelay ?? 1000],
    [dom.manualTimeLimitMinutesInput, clampManualTimeLimitMinutes(status.config?.manualTimeLimitMinutes ?? 30)],
    [dom.refluxSearchGalleryIdInput, status.config?.refluxSearchGalleryId ?? ''],
  ]);
  if (!INLINE_SETTING_DIRTY.postVpnGate) {
    syncConfigInput(dom.useVpnGatePrefixFilterInput, status.config?.useVpnGatePrefixFilter ?? false);
  }
  dom.cjkModeToggleInput.checked = Boolean(
    status.isRunning
    && status.currentSource === 'manual'
    && status.currentAttackMode === 'cjk_narrow',
  );
  dom.semiconductorRefluxModeToggleInput.checked = Boolean(
    status.isRunning
    && status.currentSource === 'manual'
    && status.currentAttackMode === 'semiconductor_reflux',
  );
  dom.page1NoCutoffModeToggleInput.checked = Boolean(
    status.isRunning
    && status.currentSource === 'manual'
    && status.currentAttackMode === 'page1_no_cutoff',
  );
  updateLogList(dom.logList, status.logs);
}

function updateIpUI(status) {
  if (!status) {
    return;
  }

  const dom = FEATURE_DOM.ip;
  updateToggle(dom, status.isRunning);

  if (status.isReleaseRunning) {
    updateStatusText(dom.statusText, '🟠 해제 중', 'status-warn');
  } else if (status.isRunning && status.runtimeDeleteEnabled === false) {
    updateStatusText(dom.statusText, '🟠 차단만 유지 중', 'status-warn');
  } else if (status.isRunning) {
    updateStatusText(dom.statusText, '🟢 차단 중', 'status-on');
  } else {
    updateStatusText(dom.statusText, '🔴 정지', 'status-off');
  }

  dom.currentPosition.textContent = status.isRunning && status.currentPage > 0
    ? `${status.currentPage}페이지`
    : '-';
  dom.totalBanned.textContent = `${status.totalBanned}건`;
  dom.activeBanCount.textContent = `${status.activeBanCount}건`;
  dom.totalReleased.textContent = `${status.totalReleased}건`;
  dom.cycleCount.textContent = `${status.cycleCount}회`;
  dom.releaseBtn.disabled = status.isRunning || status.isReleaseRunning || status.activeBanCount <= 0;
  dom.releaseBtn.textContent = status.isReleaseRunning ? '해제 중...' : '내가 차단한 대상 해제';
  dom.includeExistingTargetsOnStartInput.checked = Boolean(status.isRunning && status.includeExistingTargetsMode);

  syncFeatureConfigInputs('ip', [
    [dom.minPageInput, status.config?.minPage ?? 1],
    [dom.maxPageInput, status.config?.maxPage ?? 5],
    [dom.requestDelayInput, status.config?.requestDelay ?? 500],
    [dom.cycleDelayInput, status.config?.cycleDelay ?? 1000],
    [dom.releaseScanMaxPagesInput, status.config?.releaseScanMaxPages ?? 40],
    [dom.avoidHourInput, status.config?.avoidHour ?? '6'],
    [dom.includeUidTargetsOnManualStartInput, status.config?.includeUidTargetsOnManualStart === true],
  ]);
  updateLogList(dom.logList, status.logs);
}

function updateSemiPostUI(status) {
  if (!status) {
    return;
  }

  const dom = FEATURE_DOM.semiPost;
  updateToggle(dom, status.isRunning);
  updateStatusText(dom.statusText, status.isRunning ? '🟢 실행 중' : '🔴 정지', status.isRunning ? 'status-on' : 'status-off');
  dom.currentPosition.textContent = status.isRunning && status.currentPage > 0
    ? `${status.currentPage}페이지`
    : '-';
  dom.totalClassified.textContent = `${status.totalClassified}개`;
  dom.totalSuspiciousUid.textContent = `${status.totalSuspiciousUid}명`;
  dom.cycleCount.textContent = `${status.cycleCount}회`;

  syncFeatureConfigInputs('semiPost', [
    [dom.minPageInput, status.config?.minPage ?? 1],
    [dom.maxPageInput, status.config?.maxPage ?? 5],
    [dom.requestDelayInput, status.config?.requestDelay ?? 500],
    [dom.cycleDelayInput, status.config?.cycleDelay ?? 1000],
    [dom.minTotalActivityCountInput, status.config?.minTotalActivityCount ?? 20],
    [dom.minPostRatioPercentInput, status.config?.minPostRatioPercent ?? 90],
  ]);
  updateLogList(dom.logList, status.logs);
}

function updateUidRatioWarningUI(status) {
  const dom = FEATURE_DOM.uidRatioWarning;
  const nextStatus = status || buildDefaultUidRatioWarningStatus();
  latestUidRatioWarningStatus = nextStatus;

  updateToggle(
    {
      toggleBtn: dom.uidRatioWarningToggleBtn,
      toggleLabel: dom.uidRatioWarningToggleLabel,
    },
    nextStatus.enabled,
  );

  dom.uidRatioWarningMatchedUidCount.textContent = `${nextStatus.matchedUidCount ?? 0}명`;
  dom.uidRatioWarningWarnedUidCount.textContent = `${nextStatus.warnedUidCount ?? 0}명`;
  dom.uidRatioWarningLastAppliedAt.textContent = formatTimestamp(nextStatus.lastAppliedAt);
  updateStatusText(
    dom.uidRatioWarningStatusText,
    getUidRatioWarningStatusLabel(nextStatus),
    getUidRatioWarningStatusClassName(nextStatus),
  );
  dom.uidRatioWarningMetaText.textContent = buildUidRatioWarningMetaText(nextStatus);
  setDisabled(dom.uidRatioWarningToggleBtn, false);
}

function updateUidWarningAutoBanUI(status) {
  const dom = FEATURE_DOM.uidWarningAutoBan;
  if (!dom?.toggleBtn) {
    return;
  }

  const nextStatus = status || buildDefaultUidWarningAutoBanStatus();
  latestUidWarningAutoBanStatus = nextStatus;

  updateToggle(dom, nextStatus.isRunning);
  updateStatusText(
    dom.statusText,
    getUidWarningAutoBanStatusLabel(nextStatus),
    getUidWarningAutoBanStatusClassName(nextStatus),
  );
  updateStatusText(
    dom.deleteModeText,
    nextStatus.runtimeDeleteEnabled === false ? '차단만 유지' : '차단 + 삭제',
    nextStatus.runtimeDeleteEnabled === false ? 'status-warn' : 'status-on',
  );
  dom.lastPollAt.textContent = formatTimestamp(nextStatus.lastPollAt);
  dom.nextRunAt.textContent = formatTimestamp(nextStatus.nextRunAt);
  dom.lastPageUidCount.textContent = `${nextStatus.lastPageUidCount ?? 0}명`;
  dom.lastTriggeredUid.textContent = nextStatus.lastTriggeredUid || '-';
  dom.lastTriggeredPostCount.textContent = `${nextStatus.lastTriggeredPostCount ?? 0}개`;
  dom.lastBurstRecentCount.textContent = `${nextStatus.lastBurstRecentCount ?? 0}개`;
  dom.lastSingleSightTriggeredUid.textContent = nextStatus.lastSingleSightTriggeredUid || '-';
  dom.lastSingleSightTriggeredPostCount.textContent = `${nextStatus.lastSingleSightTriggeredPostCount ?? 0}개`;
  dom.immediateTitleRuleCount.textContent = `${(nextStatus.config?.immediateTitleBanRules || []).length}개`;
  dom.lastImmediateTitleBanMatchedTitle.textContent = nextStatus.lastImmediateTitleBanMatchedTitle || '-';
  dom.lastImmediateTitleBanCount.textContent = `${nextStatus.lastImmediateTitleBanCount ?? 0}개`;
  dom.lastAttackTitleClusterCount.textContent = `${nextStatus.lastAttackTitleClusterCount ?? 0}개`;
  dom.lastAttackTitleClusterPostCount.textContent = `${nextStatus.lastAttackTitleClusterPostCount ?? 0}개`;
  dom.lastAttackTitleClusterRepresentative.textContent = nextStatus.lastAttackTitleClusterRepresentative || '-';
  dom.lastAttackCommentClusterCount.textContent = `${nextStatus.lastAttackCommentClusterCount ?? 0}개`;
  dom.lastAttackCommentClusterDeleteCount.textContent = `${nextStatus.lastAttackCommentClusterDeleteCount ?? 0}개`;
  dom.lastAttackCommentClusterPostCount.textContent = `${nextStatus.lastAttackCommentClusterPostCount ?? 0}개`;
  dom.lastAttackCommentClusterRepresentative.textContent = nextStatus.lastAttackCommentClusterRepresentative || '-';
  dom.totalTriggeredUidCount.textContent = `${nextStatus.totalTriggeredUidCount ?? 0}명`;
  dom.totalSingleSightTriggeredUidCount.textContent = `${nextStatus.totalSingleSightTriggeredUidCount ?? 0}명`;
  dom.totalImmediateTitleBanPostCount.textContent = `${nextStatus.totalImmediateTitleBanPostCount ?? 0}개`;
  dom.totalAttackTitleClusterPostCount.textContent = `${nextStatus.totalAttackTitleClusterPostCount ?? 0}개`;
  dom.totalAttackCommentClusterDeleteCount.textContent = `${nextStatus.totalAttackCommentClusterDeleteCount ?? 0}개`;
  dom.totalSingleSightBannedPostCount.textContent = `${nextStatus.totalSingleSightBannedPostCount ?? 0}개`;
  dom.totalBannedPostCount.textContent = `${nextStatus.totalBannedPostCount ?? 0}개`;
  dom.totalFailedPostCount.textContent = `${nextStatus.totalFailedPostCount ?? 0}개`;
  dom.deleteLimitFallbackCount.textContent = `${nextStatus.deleteLimitFallbackCount ?? 0}회`;
  dom.banOnlyFallbackCount.textContent = `${nextStatus.banOnlyFallbackCount ?? 0}회`;
  syncFeatureConfigInputs('uidWarningAutoBan', [
    [dom.immediateTitleRulesValueInput, buildUidWarningAutoBanImmediateTitleRulesValue(nextStatus.config?.immediateTitleBanRules || [])],
  ]);
  if (!DIRTY_FEATURES.uidWarningAutoBan) {
    renderUidWarningAutoBanImmediateTitleRuleList(nextStatus.config?.immediateTitleBanRules || []);
  }
  dom.metaText.textContent = buildUidWarningAutoBanMetaText(nextStatus);
  updateLogList(dom.logList, nextStatus.logs);
  setDisabled(dom.toggleBtn, false);
  setDisabled(dom.saveConfigBtn, false);
  setDisabled(dom.addImmediateTitleRuleBtn, false);
  setDisabled(dom.addImmediateTitleAndRuleBtn, false);
  setDisabled(dom.resetBtn, false);
}

function updateMonitorUI(status) {
  if (!status) {
    return;
  }

  latestMonitorStatus = status;
  const dom = FEATURE_DOM.monitor;
  updateToggle(dom, status.isRunning);
  updateStatusText(dom.statusText, getMonitorStatusLabel(status), getMonitorStatusClassName(status));
  dom.phaseText.textContent = status.phase || 'SEEDING';
  dom.attackModeText.textContent = formatAttackModeLabel(status.attackMode);
  dom.lastPollAt.textContent = formatTimestamp(status.lastPollAt);
  dom.newPostCount.textContent = `${status.lastMetrics?.newPostCount ?? 0}개`;
  dom.newFluidCount.textContent = `${status.lastMetrics?.newFluidCount ?? 0}개`;
  dom.fluidRatio.textContent = `${formatPercent(status.lastMetrics?.fluidRatio)}%`;
  dom.attackHitCount.textContent = `${status.attackHitCount ?? 0}회`;
  dom.releaseHitCount.textContent = `${status.releaseHitCount ?? 0}회`;
  dom.totalAttackDetected.textContent = `${status.totalAttackDetected ?? 0}회`;
  dom.totalAttackReleased.textContent = `${status.totalAttackReleased ?? 0}회`;

  syncFeatureConfigInputs('monitor', [
    [dom.pollIntervalMsInput, status.config?.pollIntervalMs ?? 20000],
    [dom.pagesInput, status.config?.monitorPages ?? 2],
    [dom.initialSweepPagesInput, getMonitorInitialSweepPagesValue(status.config)],
    [dom.attackNewPostThresholdInput, status.config?.attackNewPostThreshold ?? 15],
    [dom.attackFluidRatioThresholdInput, status.config?.attackFluidRatioThreshold ?? 88],
    [dom.attackConsecutiveCountInput, status.config?.attackConsecutiveCount ?? 2],
    [dom.releaseNewPostThresholdInput, status.config?.releaseNewPostThreshold ?? 10],
    [dom.releaseFluidRatioThresholdInput, status.config?.releaseFluidRatioThreshold ?? 30],
    [dom.releaseConsecutiveCountInput, status.config?.releaseConsecutiveCount ?? 3],
  ]);
  updateLogList(dom.logList, status.logs);
}

function applyAutomationLocks(statuses) {
  const monitorStatus = statuses.monitor;
  const commentMonitorStatus = statuses.commentMonitor;
  const trustedStatus = statuses.trustedCommandDefense;
  const commentStatus = statuses.comment;
  const postStatus = statuses.post;
  const semiPostStatus = statuses.semiPost;
  const ipStatus = statuses.ip;
  const uidWarningAutoBanStatus = statuses.uidWarningAutoBan;
  const trustedPostLocked = Boolean(trustedStatus?.isRunning && (trustedStatus?.ownedPostScheduler || trustedStatus?.ownedIpScheduler));
  const trustedCommentLocked = Boolean(trustedStatus?.isRunning && trustedStatus?.ownedCommentScheduler);
  const postIpLocked = Boolean(monitorStatus?.isRunning || trustedPostLocked);
  const monitorUidWarningAutoBanLocked = Boolean(
    monitorStatus?.isRunning && ['ATTACKING', 'RECOVERING'].includes(String(monitorStatus?.phase || '')),
  );
  const commentLocked = Boolean(commentMonitorStatus?.isRunning || trustedCommentLocked);
  const commentMonitorDom = FEATURE_DOM.commentMonitor;
  const trustedCommandDefenseDom = FEATURE_DOM.trustedCommandDefense;
  const commentDom = FEATURE_DOM.comment;
  const postDom = FEATURE_DOM.post;
  const semiPostDom = FEATURE_DOM.semiPost;
  const monitorDom = FEATURE_DOM.monitor;
  const uidWarningAutoBanDom = FEATURE_DOM.uidWarningAutoBan;
  const ipDom = FEATURE_DOM.ip;

  setDisabled(trustedCommandDefenseDom.toggleBtn, false);
  setDisabled(commentMonitorDom.toggleBtn, false);
  setDisabled(commentMonitorDom.resetBtn, Boolean(commentMonitorStatus?.isRunning));
  setDisabled(commentDom.toggleBtn, commentLocked && !commentStatus?.isRunning);
  setDisabled(commentDom.excludePureHangulInput, commentLocked);
  setDisabled(commentDom.commentRefluxModeInput, commentLocked);
  setDisabled(commentDom.useVpnGatePrefixFilterInput, commentLocked);
  setDisabled(commentDom.vpnGatePrefixSaveBtn, commentLocked);
  setDisabled(commentDom.saveConfigBtn, commentLocked);
  setDisabled(commentDom.resetBtn, commentLocked);
  setDisabled(monitorDom.toggleBtn, false);
  setDisabled(postDom.toggleBtn, postIpLocked && !postStatus?.isRunning);
  setDisabled(postDom.cjkModeToggleInput, postIpLocked);
  setDisabled(postDom.semiconductorRefluxModeToggleInput, postIpLocked);
  setDisabled(postDom.page1NoCutoffModeToggleInput, postIpLocked);
  setDisabled(postDom.useVpnGatePrefixFilterInput, postIpLocked);
  setDisabled(postDom.vpnGatePrefixSaveBtn, postIpLocked);
  setDisabled(postDom.saveConfigBtn, postIpLocked);
  setDisabled(postDom.resetBtn, postIpLocked);
  setDisabled(semiPostDom.toggleBtn, postIpLocked && !semiPostStatus?.isRunning);
  setDisabled(semiPostDom.saveConfigBtn, postIpLocked);
  setDisabled(semiPostDom.resetBtn, postIpLocked);
  setDisabled(ipDom.toggleBtn, postIpLocked && !ipStatus?.isRunning);
  setDisabled(ipDom.includeExistingTargetsOnStartInput, postIpLocked);
  setDisabled(ipDom.saveConfigBtn, postIpLocked);
  setDisabled(ipDom.resetBtn, postIpLocked);
  setDisabled(ipDom.releaseBtn, postIpLocked || ipDom.releaseBtn.disabled);
  setDisabled(uidWarningAutoBanDom.toggleBtn, monitorUidWarningAutoBanLocked);
  setDisabled(uidWarningAutoBanDom.immediateTitleRuleInput, monitorUidWarningAutoBanLocked);
  setDisabled(uidWarningAutoBanDom.addImmediateTitleRuleBtn, monitorUidWarningAutoBanLocked);
  setDisabled(uidWarningAutoBanDom.addImmediateTitleAndRuleBtn, monitorUidWarningAutoBanLocked);
  setDisabled(uidWarningAutoBanDom.saveConfigBtn, monitorUidWarningAutoBanLocked);
  setDisabled(uidWarningAutoBanDom.resetBtn, monitorUidWarningAutoBanLocked);
  uidWarningAutoBanDom.immediateTitleRuleList
    ?.querySelectorAll('.manual-rule-remove-btn')
    .forEach((button) => setDisabled(button, monitorUidWarningAutoBanLocked));

  getFeatureConfigInputs('comment').forEach((input) => setDisabled(input, commentLocked));
  getFeatureConfigInputs('post').forEach((input) => setDisabled(input, postIpLocked));
  setDisabled(commentDom.manualTimeLimitMinutesInput, commentLocked || Boolean(commentStatus?.isRunning));
  setDisabled(postDom.manualTimeLimitMinutesInput, postIpLocked || Boolean(postStatus?.isRunning));
  getFeatureConfigInputs('semiPost').forEach((input) => setDisabled(input, postIpLocked));
  getFeatureConfigInputs('ip').forEach((input) => setDisabled(input, postIpLocked));
  getFeatureConfigInputs('uidWarningAutoBan').forEach((input) => setDisabled(input, monitorUidWarningAutoBanLocked));
  getFeatureConfigInputs('trustedCommandDefense').forEach((input) => setDisabled(input, Boolean(trustedStatus?.isRunning)));
  setDisabled(trustedCommandDefenseDom.trustedUserIdInput, Boolean(trustedStatus?.isRunning));
  setDisabled(trustedCommandDefenseDom.trustedUserLabelInput, Boolean(trustedStatus?.isRunning));
  setDisabled(trustedCommandDefenseDom.addTrustedUserBtn, Boolean(trustedStatus?.isRunning));
  setDisabled(trustedCommandDefenseDom.saveConfigBtn, Boolean(trustedStatus?.isRunning));
  setDisabled(trustedCommandDefenseDom.resetBtn, Boolean(trustedStatus?.isRunning));
  trustedCommandDefenseDom.trustedUserList
    ?.querySelectorAll('.manual-rule-remove-btn')
    .forEach((button) => setDisabled(button, Boolean(trustedStatus?.isRunning)));
}

function buildDefaultSelfHostedVpnStatus() {
  return {
    isRunning: false,
    phase: 'IDLE',
    healthOk: false,
    agentReachable: false,
    agentVersion: '',
    lastSyncAt: '',
    lastHealthAt: '',
    operationId: '',
    activeConnectionMode: 'softether_vpngate_raw',
    activeProfileId: '',
    activeRelayId: '',
    activeRelayIp: '',
    activeRelayFqdn: '',
    activeSelectedSslPort: 0,
    publicIpBefore: '',
    publicIpAfter: '',
    currentPublicIp: '',
    publicIpProvider: '',
    ipv4DefaultRouteChanged: false,
    ipv6DefaultRouteChanged: false,
    dnsChanged: false,
    activeAdapterName: '',
    connectedAt: '',
    lastErrorCode: '',
    lastErrorMessage: '',
    catalogEnabled: false,
    rawRelayCatalog: {
      phase: 'IDLE',
      stage: 'IDLE',
      startedAt: '',
      completedAt: '',
      sourceHostCount: 0,
      usableRelayCount: 0,
      requestedCandidateCount: 0,
      logicalSlotCount: 0,
      requestedPhysicalNicCount: 0,
      detectedPhysicalNicCapacity: 0,
      preparedNicCount: 0,
      connectAttemptedCount: 0,
      provisionableSlotCount: 0,
      connectedSlotCount: 0,
      verifiedSlotCount: 0,
      deadSlotCount: 0,
      failedSlotCount: 0,
      capacityDeferredSlotCount: 0,
      activeSlotId: '',
      routeOwnerSlotId: '',
      lastVerifiedAt: '',
      lastVerifiedPublicIp: '',
      lastVerifiedPublicIpProvider: '',
      lastErrorCode: '',
      lastErrorMessage: '',
      availableNicNames: [],
      preparedNicNames: [],
      slotQueue: [],
      request: {
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
      },
      items: [],
      logs: [],
    },
    parallelProbe: {
      isRunning: false,
      phase: 'IDLE',
      startedAt: '',
      completedAt: '',
      lastVerifiedAt: '',
      routeOwnerSlotId: '',
      lastVerifiedPublicIp: '',
      lastVerifiedPublicIpProvider: '',
      lastErrorCode: '',
      lastErrorMessage: '',
      slots: [],
      logs: [],
    },
    logs: [],
    config: {
      agentBaseUrl: 'http://127.0.0.1:8765',
      authToken: '',
      connectionMode: 'softether_vpngate_raw',
      profileId: '',
      selectedRelayId: '',
      selectedSslPort: 0,
      relaySnapshot: {
        id: '',
        fqdn: '',
        ip: '',
        udpPort: 0,
        hostUniqueKey: '',
      },
      requestTimeoutMs: 3000,
      actionTimeoutMs: 15000,
    },
  };
}

function getSelfHostedVpnAgentBaseUrl(status = {}) {
  return String(status.config?.agentBaseUrl || '').trim() || 'http://127.0.0.1:8765';
}

function parseSelfHostedVpnAgentPort(baseUrl) {
  try {
    const parsedUrl = new URL(String(baseUrl || '').trim());
    const rawPort = parsedUrl.port || (parsedUrl.protocol === 'http:' ? '80' : '');
    const port = Number.parseInt(rawPort, 10);
    if (port >= 1 && port <= 65535) {
      return port;
    }
  } catch (error) {
    console.warn('[popup] local agent 주소 파싱 실패:', error.message);
  }

  return 8765;
}

function getSelfHostedVpnFallbackAgentPort(primaryPort) {
  const normalizedPort = Number.parseInt(String(primaryPort || 0), 10) || 8765;
  if (normalizedPort === 8765) {
    return 8766;
  }

  if (normalizedPort >= 65535) {
    return 8764;
  }

  return normalizedPort + 1;
}

function buildSelfHostedVpnAgentUrl(port) {
  return `http://127.0.0.1:${Number.parseInt(String(port || 0), 10) || 8765}`;
}

function buildSelfHostedVpnAgentStartCommand(port) {
  const normalizedPort = Number.parseInt(String(port || 0), 10) || 8765;
  return [
    `$port=${normalizedPort}`,
    '$p=(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess)',
    'if($p){taskkill /PID $p /F | Out-Null}',
    `Set-Location '${SELF_HOSTED_VPN_AGENT_WINDOWS_REPO_PATH}'`,
    '$env:PORT=[string]$port',
    'node projects\\self_hosted_vpn_agent\\server.mjs',
  ].join('\n');
}

function buildSelfHostedVpnAgentStopCommand(port) {
  const normalizedPort = Number.parseInt(String(port || 0), 10) || 8765;
  return [
    `$port=${normalizedPort}`,
    '$p=(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess)',
    `if($p){taskkill /PID $p /F}else{Write-Host "포트 ${normalizedPort} 에서 LISTEN 중인 local agent가 없습니다."}`,
  ].join('\n');
}

function hasSelfHostedVpnLegacyAgentError(status = {}) {
  return /예전 버전|지원하지 않는 경로|HTTP 404/i.test(String(status.lastErrorMessage || ''));
}

function buildSelfHostedVpnAgentGuideState(status = {}) {
  const baseUrl = getSelfHostedVpnAgentBaseUrl(status);
  const primaryPort = parseSelfHostedVpnAgentPort(baseUrl);
  const fallbackPort = getSelfHostedVpnFallbackAgentPort(primaryPort);
  const fallbackUrl = buildSelfHostedVpnAgentUrl(fallbackPort);
  const legacyAgentError = hasSelfHostedVpnLegacyAgentError(status);

  let statusText = '⚪ 아직 확인 전';
  let statusClassName = 'status-muted';
  if (legacyAgentError) {
    statusText = '🟠 예전 버전 가능';
    statusClassName = 'status-warn';
  } else if (status.agentReachable) {
    statusText = '🟢 연결됨';
    statusClassName = 'status-on';
  } else if (status.lastSyncAt) {
    statusText = '🔴 실행 안 됨';
    statusClassName = 'status-off';
  }

  let metaText = `1. PowerShell 열기 2. 아래 실행 명령 복사 3. 붙여넣고 엔터 4. 돌아와서 '지금 새로고침'을 누르세요.`;
  if (legacyAgentError) {
    metaText = `지금은 예전 local agent가 떠 있을 가능성이 큽니다. 먼저 기본 실행 명령으로 현재 포트(${primaryPort})를 정리 후 다시 켜고, 안 되면 ${fallbackPort} 대체 명령과 ${fallbackPort} 주소 채우기를 쓰면 됩니다.`;
  } else if (status.agentReachable && status.healthOk) {
    metaText = '지금 local agent는 응답 중입니다. 아래 명령은 agent를 다시 켜거나 포트를 바꿀 때만 쓰면 됩니다.';
  } else if (status.agentReachable) {
    metaText = '지금 local agent 자체는 살아 있습니다. 일부 상세 상태 조회가 늦을 수 있지만, agent를 다시 켤 필요는 없습니다.';
  } else if (status.lastSyncAt) {
    metaText = `지금 local agent 응답이 없습니다. 현재 주소(${baseUrl}) 기준 실행 명령을 먼저 쓰고, 포트 충돌이면 ${fallbackPort} 대체 명령으로 우회하세요.`;
  }

  return {
    baseUrl,
    fallbackUrl,
    primaryPort,
    fallbackPort,
    repoPath: SELF_HOSTED_VPN_AGENT_WINDOWS_REPO_PATH,
    statusText,
    statusClassName,
    metaText,
    primaryCommandLabel: `기본 실행 명령 (${primaryPort})`,
    primaryCommand: buildSelfHostedVpnAgentStartCommand(primaryPort),
    fallbackCommandLabel: `${fallbackPort} 대체 명령`,
    fallbackCommand: buildSelfHostedVpnAgentStartCommand(fallbackPort),
    stopCommandLabel: `종료 명령 (${primaryPort})`,
    stopCommand: buildSelfHostedVpnAgentStopCommand(primaryPort),
    isWarning: !status.agentReachable || legacyAgentError,
  };
}

function updateSelfHostedVpnAgentGuidePreview(mode, guideState = {}) {
  const dom = FEATURE_DOM.selfHostedVpn;
  if (!dom?.agentGuideCommandText || !dom?.agentGuideCommandLabelText) {
    return;
  }

  if (mode === 'fallback') {
    dom.agentGuideCommandLabelText.textContent = guideState.fallbackCommandLabel || '8766 대체 명령';
    dom.agentGuideCommandText.textContent = guideState.fallbackCommand || '';
    return;
  }

  if (mode === 'stop') {
    dom.agentGuideCommandLabelText.textContent = guideState.stopCommandLabel || '종료 명령';
    dom.agentGuideCommandText.textContent = guideState.stopCommand || '';
    return;
  }

  dom.agentGuideCommandLabelText.textContent = guideState.primaryCommandLabel || '기본 실행 명령';
  dom.agentGuideCommandText.textContent = guideState.primaryCommand || '';
}

function buildDefaultBumpPostStatus() {
  return {
    isRunning: false,
    phase: 'IDLE',
    cycleCount: 0,
    startedAt: '',
    endsAt: '',
    nextRunAt: '',
    lastBumpedAt: '',
    lastErrorAt: '',
    lastErrorMessage: '',
    lastBumpedPostNo: '',
    totalBumpedCount: 0,
    totalFailedCount: 0,
    logs: [],
    config: {
      postNo: '',
      durationMinutes: 60,
      intervalMinutes: 1,
    },
  };
}

function buildDefaultSinmungoCommentStatus() {
  return {
    isRunning: false,
    phase: 'IDLE',
    startedAt: '',
    finishedAt: '',
    lastSubmittedAt: '',
    lastVerifiedAt: '',
    lastSuccessAt: '',
    lastErrorAt: '',
    lastErrorMessage: '',
    lastTargetPostNo: '',
    lastSubmittedMemo: '',
    lastCommentNo: '',
    totalSubmittedCount: 0,
    totalFailedCount: 0,
    pendingChallenge: null,
    logs: [],
    config: {
      postNo: '',
      submitMode: 'member',
      memo: '처리완료',
      name: 'ㅇㅇ',
      password: '',
    },
  };
}

function buildDefaultRefluxDatasetCollectorStatus() {
  return {
    isRunning: false,
    phase: 'IDLE',
    runId: '',
    currentPage: 0,
    fetchedPageCount: 0,
    rawTitleCount: 0,
    normalizedTitleCount: 0,
    startedAt: '',
    finishedAt: '',
    lastError: '',
    logs: [],
    downloadReady: false,
    exportVersion: '',
    interrupted: false,
    collectedGalleryId: '',
    config: {
      galleryId: '',
      startPage: 1,
      endPage: 397,
      requestDelayMs: 1200,
      jitterMs: 400,
    },
  };
}

function buildDefaultRefluxOverlayCollectorStatus() {
  return {
    isRunning: false,
    phase: 'IDLE',
    currentPage: 0,
    galleryId: '',
    targetPostNo: 0,
    foundPage: 0,
    totalPageCount: 0,
    targetPageCount: 0,
    completedPageCount: 0,
    failedPageCount: 0,
    failedPages: [],
    rawTitleCount: 0,
    normalizedTitleCount: 0,
    appliedOverlayId: '',
    startedAt: '',
    finishedAt: '',
    lastError: '',
    logs: [],
    interrupted: false,
    config: {
      viewUrl: '',
      beforePages: 30,
      afterPages: 30,
      requestDelayMs: 500,
      jitterMs: 100,
      transportMode: 'direct',
      proxyWorkerCount: 10,
      maxRetriesPerPage: 5,
    },
  };
}

function buildDefaultCommentRefluxCollectorStatus() {
  return {
    isRunning: false,
    phase: 'IDLE',
    runId: '',
    currentPage: 0,
    currentPostNo: 0,
    fetchedPageCount: 0,
    processedPostCount: 0,
    failedPostCount: 0,
    rawCommentCount: 0,
    normalizedMemoCount: 0,
    startedAt: '',
    finishedAt: '',
    lastError: '',
    logs: [],
    downloadReady: false,
    exportVersion: '',
    interrupted: false,
    collectedGalleryId: '',
    config: {
      galleryId: '',
      startPage: 1,
      endPage: 100,
      requestDelayMs: 100,
      cycleDelayMs: 5000,
      postConcurrency: 8,
    },
  };
}

function getSelfHostedVpnStatusLabel(status = {}) {
  if (!status.lastSyncAt && !status.isRunning) {
    return '⚪ 확인 전';
  }

  if (status.phase === 'READY' && status.lastErrorMessage) {
    return '🟠 준비 완료 (최근 오류)';
  }

  if (status.phase === 'PREPARING') {
    return '🟡 live pool 준비 중';
  }

  if (status.phase === 'READY') {
    return '🟢 live pool 준비 완료';
  }

  if (status.phase === 'CONNECTING') {
    return '🟡 연결 시작 중';
  }

  if (status.phase === 'SWITCHING') {
    return '🟡 owner 전환 중';
  }

  if (status.phase === 'CONNECTED') {
    return '🟢 live pool 연결됨';
  }

  if (status.phase === 'DISCONNECTING') {
    return '🟠 연결 종료 중';
  }

  if (status.phase === 'AGENT_UNAVAILABLE') {
    return '🔴 agent 연결 불가';
  }

  if (status.phase === 'ERROR') {
    return status.isRunning ? '🟠 상태 확인 불완전' : '🔴 최근 오류';
  }

  if (status.lastErrorMessage) {
    return '🔴 정지 (최근 오류)';
  }

  return '🔴 정지';
}

function getSelfHostedVpnStatusClassName(status = {}) {
  if (!status.lastSyncAt && !status.isRunning) {
    return 'status-muted';
  }

  if (status.phase === 'READY' && status.lastErrorMessage) {
    return 'status-warn';
  }

  if (['READY', 'CONNECTED'].includes(String(status.phase || ''))) {
    return 'status-on';
  }

  if (['PREPARING', 'CONNECTING', 'SWITCHING', 'DISCONNECTING', 'ERROR'].includes(String(status.phase || ''))) {
    return 'status-warn';
  }

  if (status.phase === 'AGENT_UNAVAILABLE') {
    return 'status-off';
  }

  if (status.lastErrorMessage) {
    return 'status-warn';
  }

  return 'status-off';
}

function getSelfHostedVpnAgentHealthLabel(status = {}) {
  if (!status.lastSyncAt) {
    return '확인 전';
  }

  if (!status.agentReachable) {
    return '🔴 응답 없음';
  }

  if (status.healthOk) {
    return '🟢 응답 정상';
  }

  return '🟢 응답 확인';
}

function getSelfHostedVpnAgentHealthClassName(status = {}) {
  if (!status.lastSyncAt) {
    return 'status-muted';
  }

  if (!status.agentReachable) {
    return 'status-off';
  }

  return 'status-on';
}

function buildSelfHostedVpnPublicIpText(ip, provider) {
  const normalizedIp = String(ip || '').trim();
  if (!normalizedIp) {
    return '-';
  }

  const normalizedProvider = String(provider || '').trim();
  return normalizedProvider
    ? `${normalizedIp} (${normalizedProvider})`
    : normalizedIp;
}

function getSelfHostedVpnIpv4RouteDisplay(status = {}) {
  if (status.phase !== 'CONNECTED') {
    return { text: '-', className: 'status-muted' };
  }

  if (status.ipv4DefaultRouteChanged) {
    return { text: '변경 감지', className: 'status-on' };
  }

  return { text: '미감지', className: 'status-warn' };
}

function getSelfHostedVpnIpv6RouteDisplay(status = {}) {
  if (status.phase !== 'CONNECTED') {
    return { text: '-', className: 'status-muted' };
  }

  return status.ipv6DefaultRouteChanged
    ? { text: '변경 감지', className: 'status-on' }
    : { text: '미감지', className: 'status-muted' };
}

function getSelfHostedVpnDnsDisplay(status = {}) {
  if (status.phase !== 'CONNECTED') {
    return { text: '-', className: 'status-muted' };
  }

  return status.dnsChanged
    ? { text: '변경 감지', className: 'status-on' }
    : { text: '미감지', className: 'status-muted' };
}

function normalizeSelfHostedVpnConnectionMode(value) {
  return String(value || '').trim() === 'softether_vpngate_raw'
    ? 'softether_vpngate_raw'
    : 'profile';
}

function updateSelfHostedVpnConfigModeFields(options = {}) {
  const dom = FEATURE_DOM.selfHostedVpn;
  if (!dom?.profileIdInput || !dom?.connectionModeInput) {
    return;
  }

  dom.connectionModeInput.value = 'softether_vpngate_raw';
  dom.profileIdInput.value = '';
}

function normalizeSelfHostedVpnHostUniqueKey(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, '')
    .toUpperCase();
}

function getSelfHostedVpnEffectiveProfileId(status = {}) {
  const configuredProfileId = String(status.activeProfileId || status.config?.profileId || '').trim();
  if (configuredProfileId) {
    return configuredProfileId;
  }

  const connectionMode = normalizeSelfHostedVpnConnectionMode(status.activeConnectionMode || status.config?.connectionMode);
  if (connectionMode !== 'softether_vpngate_raw') {
    return '';
  }

  const relayId = String(status.activeRelayId || status.config?.selectedRelayId || status.config?.relaySnapshot?.id || '').trim();
  const relayHost = String(status.activeRelayIp || status.activeRelayFqdn || status.config?.relaySnapshot?.ip || status.config?.relaySnapshot?.fqdn || '').trim();
  const selectedSslPort = Number.parseInt(String(status.activeSelectedSslPort || status.config?.selectedSslPort || 0), 10) || 0;
  if (!selectedSslPort) {
    return '';
  }

  if (relayId) {
    return `vpngate-${sanitizeSelfHostedVpnToken(relayId)}-${selectedSslPort}`;
  }

  if (relayHost) {
    return `vpngate-${sanitizeSelfHostedVpnToken(relayHost)}-${selectedSslPort}`;
  }

  return '';
}

function getSelfHostedVpnConnectionModeLabel(status = {}) {
  const connectionMode = normalizeSelfHostedVpnConnectionMode(status.activeConnectionMode || status.config?.connectionMode);
  return connectionMode === 'softether_vpngate_raw' ? 'VPNGate raw live pool' : 'VPNGate raw live pool';
}

function buildSelfHostedVpnRelayText(status = {}) {
  if (normalizeSelfHostedVpnConnectionMode(status.activeConnectionMode || status.config?.connectionMode) !== 'softether_vpngate_raw') {
    return '-';
  }

  const relayHost = String(
    status.activeRelayIp
    || status.activeRelayFqdn
    || status.config?.relaySnapshot?.ip
    || status.config?.relaySnapshot?.fqdn
    || '',
  ).trim();
  const relayId = String(
    status.activeRelayId
    || status.config?.selectedRelayId
    || status.config?.relaySnapshot?.id
    || '',
  ).trim();

  if (!relayHost && !relayId) {
    return '-';
  }

  if (relayHost && relayId) {
    return `${relayHost} (#${relayId})`;
  }

  return relayHost || `#${relayId}`;
}

function buildSelfHostedVpnSelectedSslPortText(status = {}) {
  if (normalizeSelfHostedVpnConnectionMode(status.activeConnectionMode || status.config?.connectionMode) !== 'softether_vpngate_raw') {
    return '-';
  }

  const selectedSslPort = Number.parseInt(String(
    status.activeSelectedSslPort
    || status.config?.selectedSslPort
    || 0,
  ), 10) || 0;
  return selectedSslPort > 0 ? String(selectedSslPort) : '-';
}

function buildSelfHostedVpnMetaText(status = {}) {
  const catalog = normalizeSelfHostedVpnRawRelayCatalogStatus(status.rawRelayCatalog || {});
  const agentBaseUrl = String(status.config?.agentBaseUrl || '').trim() || 'http://127.0.0.1:8765';
  const connectionModeLabel = getSelfHostedVpnConnectionModeLabel(status);
  const relayText = buildSelfHostedVpnRelayText(status);
  const selectedSslPortText = buildSelfHostedVpnSelectedSslPortText(status);
  const catalogCountText = buildSelfHostedVpnCatalogCountText(catalog);
  const routeOwnerSlotId = String(catalog.routeOwnerSlotId || '').trim();
  const activeSlotId = String(catalog.activeSlotId || '').trim();

  if (status.lastErrorMessage) {
    return `최근 오류: ${status.lastErrorMessage}`;
  }

  if (!status.lastSyncAt) {
    return `아직 local agent에 한 번도 확인 요청을 보내지 않았습니다. 바로 아래 실행 안내 카드에서 명령을 복사해 먼저 agent를 띄우세요.`;
  }

  if (!status.agentReachable) {
    return `local agent가 꺼져 있거나 주소가 틀려서 지금은 아무 작업도 진행할 수 없습니다. 아래 실행 안내 카드의 명령으로 먼저 agent를 켠 뒤 주소(${agentBaseUrl})를 확인하세요.`;
  }

  if (status.phase === 'PREPARING') {
    return `official raw feed 후보를 실제 슬롯으로 올리고 검증 중입니다. 지금은 ${catalogCountText !== '-' ? catalogCountText : '후보를 준비 중'} 상태입니다.`;
  }

  if (status.phase === 'READY') {
    return `live pool 준비가 끝났습니다. 지금은 ${catalogCountText !== '-' ? catalogCountText : '검증 통과 슬롯 준비 완료'} 상태이고, 아래 목록에서 다른 슬롯을 누르면 owner만 전환합니다.`;
  }

  if (status.phase === 'SWITCHING') {
    return `지금은 ${routeOwnerSlotId || activeSlotId || '대상 슬롯'} 으로 owner metric을 옮긴 뒤 공인 IP를 다시 확인하는 중입니다.`;
  }

  if (status.phase === 'CONNECTING') {
    return `${relayText !== '-' ? relayText : 'raw 릴레이'}:${selectedSslPortText !== '-' ? selectedSslPortText : '미지정 포트'} 로 연결 요청을 보냈고, 터널과 기본 경로가 올라오길 기다리는 중입니다.`;
  }

  if (status.phase === 'CONNECTED') {
    const currentPublicIpText = buildSelfHostedVpnPublicIpText(status.currentPublicIp, status.publicIpProvider);
    const ipv4RouteState = status.ipv4DefaultRouteChanged ? 'IPv4 기본경로 변경 감지' : 'IPv4 기본경로 미감지';
    return `${activeSlotId || routeOwnerSlotId || '현재 슬롯'} 이 owner입니다. 현재 출구 IP는 ${currentPublicIpText} 이고, ${ipv4RouteState} 상태입니다.`;
  }

  if (status.phase === 'DISCONNECTING') {
    return '터널 종료 요청을 보냈습니다. 종료가 완료되면 현재 출구 IP와 route 상태가 다시 정지 상태로 내려옵니다.';
  }

  if (status.healthOk) {
    return `local agent 응답은 정상입니다. 현재 모드는 ${connectionModeLabel} 이고, 연결을 시작하면 출구 IP와 IPv4 기본경로 변화를 같이 확인합니다.`;
  }

  return `local agent HTTP 응답은 확인됐습니다. 현재 모드는 ${connectionModeLabel} 이고, 일부 상세 상태 조회만 잠깐 늦을 수 있습니다.`;
}

function normalizeSelfHostedVpnParallelProbeStatus(status = {}) {
  const rawStatus = status && typeof status === 'object' ? status : {};
  const slots = Array.isArray(rawStatus.slots)
    ? rawStatus.slots.map((slot, index) => ({
      slotId: String(slot?.slotId || `slot-${index + 1}`).trim() || `slot-${index + 1}`,
      nicName: String(slot?.nicName || '').trim(),
      phase: String(slot?.phase || 'IDLE').trim().toUpperCase() || 'IDLE',
      accountName: String(slot?.accountName || '').trim(),
      connectedAt: String(slot?.connectedAt || '').trim(),
      lastVerifiedAt: String(slot?.lastVerifiedAt || '').trim(),
      routeOwned: Boolean(slot?.routeOwned),
      routeReady: Boolean(slot?.routeReady),
      exitPublicIp: String(slot?.exitPublicIp || '').trim(),
      exitPublicIpProvider: String(slot?.exitPublicIpProvider || '').trim(),
      interfaceAlias: String(slot?.interfaceAlias || '').trim(),
      interfaceIndex: Number.parseInt(String(slot?.interfaceIndex || 0), 10) || 0,
      lastErrorCode: String(slot?.lastErrorCode || '').trim(),
      lastErrorMessage: String(slot?.lastErrorMessage || '').trim(),
      relay: {
        id: String(slot?.relay?.id ?? '').trim(),
        ip: String(slot?.relay?.ip || '').trim(),
        fqdn: String(slot?.relay?.fqdn || '').trim(),
        selectedSslPort: Number.parseInt(String(slot?.relay?.selectedSslPort || 0), 10) || 0,
      },
    }))
    : [];

  return {
    isRunning: Boolean(rawStatus.isRunning),
    phase: String(rawStatus.phase || 'IDLE').trim().toUpperCase() || 'IDLE',
    startedAt: String(rawStatus.startedAt || '').trim(),
    completedAt: String(rawStatus.completedAt || '').trim(),
    lastVerifiedAt: String(rawStatus.lastVerifiedAt || '').trim(),
    routeOwnerSlotId: String(rawStatus.routeOwnerSlotId || '').trim(),
    lastVerifiedPublicIp: String(rawStatus.lastVerifiedPublicIp || '').trim(),
    lastVerifiedPublicIpProvider: String(rawStatus.lastVerifiedPublicIpProvider || '').trim(),
    lastErrorCode: String(rawStatus.lastErrorCode || '').trim(),
    lastErrorMessage: String(rawStatus.lastErrorMessage || '').trim(),
    slots,
    logs: Array.isArray(rawStatus.logs)
      ? rawStatus.logs.map(entry => String(entry || '').trim()).filter(Boolean).slice(0, 20)
      : [],
  };
}

function normalizeSelfHostedVpnRawRelayCatalogItem(item = {}) {
  const rawItem = item && typeof item === 'object' ? item : {};
  return {
    slotId: String(rawItem.slotId || '').trim(),
    lookupKey: String(rawItem.lookupKey || '').trim(),
    id: String(rawItem.id ?? '').trim(),
    ip: String(rawItem.ip || '').trim(),
    fqdn: String(rawItem.fqdn || '').trim(),
    hostName: String(rawItem.hostName || '').trim(),
    countryShort: String(rawItem.countryShort || '').trim().toUpperCase(),
    countryFull: String(rawItem.countryFull || '').trim(),
    selectedSslPort: Number.parseInt(String(rawItem.selectedSslPort || 0), 10) || 0,
    sslPorts: Array.isArray(rawItem.sslPorts)
      ? rawItem.sslPorts.map(port => Number.parseInt(String(port || 0), 10) || 0).filter(Boolean)
      : [],
    udpPort: Number.parseInt(String(rawItem.udpPort || 0), 10) || 0,
    hostUniqueKey: String(rawItem.hostUniqueKey || '').trim().toUpperCase(),
    score: Number(rawItem.score || 0),
    verifyDate: Number(rawItem.verifyDate || 0),
    accountName: String(rawItem.accountName || '').trim(),
    accountStatusKind: String(rawItem.accountStatusKind || 'MISSING').trim().toUpperCase() || 'MISSING',
    accountStatusText: String(rawItem.accountStatusText || '').trim(),
    preferredNicName: String(rawItem.preferredNicName || '').trim().toUpperCase(),
    nicName: String(rawItem.nicName || '').trim().toUpperCase(),
    poolState: String(rawItem.poolState || '').trim().toUpperCase() || 'IDLE',
    connectAttempted: Boolean(rawItem.connectAttempted),
    connectAttemptedAt: String(rawItem.connectAttemptedAt || '').trim(),
    capacityDeferred: Boolean(rawItem.capacityDeferred),
    nicPreparedAt: String(rawItem.nicPreparedAt || '').trim(),
    interfaceAlias: String(rawItem.interfaceAlias || '').trim(),
    interfaceIndex: Number.parseInt(String(rawItem.interfaceIndex || 0), 10) || 0,
    defaultRouteIfIndex: Number.parseInt(String(rawItem.defaultRouteIfIndex || 0), 10) || 0,
    routeOwned: Boolean(rawItem.routeOwned),
    routeReady: Boolean(rawItem.routeReady),
    connectedAt: String(rawItem.connectedAt || '').trim(),
    lastVerifiedAt: String(rawItem.lastVerifiedAt || '').trim(),
    exitPublicIp: String(rawItem.exitPublicIp || '').trim(),
    exitPublicIpProvider: String(rawItem.exitPublicIpProvider || '').trim(),
    lastErrorCode: String(rawItem.lastErrorCode || '').trim(),
    lastErrorMessage: String(rawItem.lastErrorMessage || '').trim(),
    isActive: Boolean(rawItem.isActive),
  };
}

function normalizeSelfHostedVpnRawRelayCatalogStatus(status = {}) {
  const rawStatus = status && typeof status === 'object' ? status : {};
  return {
    phase: String(rawStatus.phase || 'IDLE').trim().toUpperCase() || 'IDLE',
    stage: String(rawStatus.stage || 'IDLE').trim().toUpperCase() || 'IDLE',
    startedAt: String(rawStatus.startedAt || '').trim(),
    completedAt: String(rawStatus.completedAt || '').trim(),
    sourceHostCount: Number.parseInt(String(rawStatus.sourceHostCount || 0), 10) || 0,
    usableRelayCount: Number.parseInt(String(
      rawStatus.usableRelayCount
      || rawStatus.verifiedSlotCount
      || 0,
    ), 10) || 0,
    requestedCandidateCount: Number.parseInt(String(rawStatus.requestedCandidateCount || 0), 10) || 0,
    logicalSlotCount: Number.parseInt(String(rawStatus.logicalSlotCount || 0), 10) || 0,
    requestedPhysicalNicCount: Number.parseInt(String(rawStatus.requestedPhysicalNicCount || 0), 10) || 0,
    detectedPhysicalNicCapacity: Number.parseInt(String(
      rawStatus.detectedPhysicalNicCapacity
      || rawStatus.provisionableSlotCount
      || 0,
    ), 10) || 0,
    preparedNicCount: Number.parseInt(String(rawStatus.preparedNicCount || 0), 10) || 0,
    connectAttemptedCount: Number.parseInt(String(rawStatus.connectAttemptedCount || 0), 10) || 0,
    provisionableSlotCount: Number.parseInt(String(rawStatus.provisionableSlotCount || 0), 10) || 0,
    connectedSlotCount: Number.parseInt(String(rawStatus.connectedSlotCount || 0), 10) || 0,
    verifiedSlotCount: Number.parseInt(String(rawStatus.verifiedSlotCount || 0), 10) || 0,
    deadSlotCount: Number.parseInt(String(rawStatus.deadSlotCount || 0), 10) || 0,
    failedSlotCount: Number.parseInt(String(rawStatus.failedSlotCount || 0), 10) || 0,
    capacityDeferredSlotCount: Number.parseInt(String(rawStatus.capacityDeferredSlotCount || 0), 10) || 0,
    activeSlotId: String(rawStatus.activeSlotId || '').trim(),
    routeOwnerSlotId: String(rawStatus.routeOwnerSlotId || '').trim(),
    lastVerifiedAt: String(rawStatus.lastVerifiedAt || '').trim(),
    lastVerifiedPublicIp: String(rawStatus.lastVerifiedPublicIp || '').trim(),
    lastVerifiedPublicIpProvider: String(rawStatus.lastVerifiedPublicIpProvider || '').trim(),
    lastErrorCode: String(rawStatus.lastErrorCode || '').trim(),
    lastErrorMessage: String(rawStatus.lastErrorMessage || '').trim(),
    availableNicNames: Array.isArray(rawStatus.availableNicNames)
      ? rawStatus.availableNicNames.map(value => String(value || '').trim().toUpperCase()).filter(Boolean)
      : [],
    preparedNicNames: Array.isArray(rawStatus.preparedNicNames)
      ? rawStatus.preparedNicNames.map(value => String(value || '').trim().toUpperCase()).filter(Boolean)
      : [],
    slotQueue: Array.isArray(rawStatus.slotQueue)
      ? rawStatus.slotQueue.map((entry) => {
        if (!entry || typeof entry !== 'object') {
          return null;
        }
        return {
          slotId: String(entry.slotId || '').trim(),
          poolState: String(entry.poolState || '').trim().toUpperCase(),
          nicName: String(entry.nicName || '').trim().toUpperCase(),
          capacityDeferred: Boolean(entry.capacityDeferred),
          connectAttempted: Boolean(entry.connectAttempted),
        };
      }).filter(Boolean)
      : [],
    request: {
      limit: Number.parseInt(String(rawStatus.request?.limit || 200), 10) || 200,
      logicalSlotCount: Number.parseInt(String(rawStatus.request?.logicalSlotCount || 200), 10) || 200,
      requestedPhysicalNicCount: Number.parseInt(String(rawStatus.request?.requestedPhysicalNicCount || 200), 10) || 200,
      connectConcurrency: Number.parseInt(String(rawStatus.request?.connectConcurrency || 24), 10) || 24,
      nicPrepareConcurrency: Number.parseInt(String(rawStatus.request?.nicPrepareConcurrency || 8), 10) || 8,
      verifyConcurrency: Number.parseInt(String(rawStatus.request?.verifyConcurrency || 1), 10) || 1,
      experimentalMaxNicIndex: Number.parseInt(String(rawStatus.request?.experimentalMaxNicIndex || 200), 10) || 200,
      statusPollIntervalMs: Number.parseInt(String(rawStatus.request?.statusPollIntervalMs || 1000), 10) || 1000,
      connectTimeoutMs: Number.parseInt(String(rawStatus.request?.connectTimeoutMs || 45000), 10) || 45000,
      preferredCountries: Array.isArray(rawStatus.request?.preferredCountries)
        ? rawStatus.request.preferredCountries.map(value => String(value || '').trim().toUpperCase()).filter(Boolean)
        : ['KR', 'JP'],
      preferredPorts: Array.isArray(rawStatus.request?.preferredPorts)
        ? rawStatus.request.preferredPorts.map(value => Number.parseInt(String(value || 0), 10) || 0).filter(Boolean)
        : [443, 995, 1698, 5555, 992, 1194],
    },
    items: Array.isArray(rawStatus.items)
      ? rawStatus.items.map((item) => normalizeSelfHostedVpnRawRelayCatalogItem(item))
      : [],
    logs: Array.isArray(rawStatus.logs)
      ? rawStatus.logs.map(entry => String(entry || '').trim()).filter(Boolean).slice(0, 20)
      : [],
  };
}

function buildSelfHostedVpnCatalogStatusText(catalog = {}) {
  if (!catalog.startedAt && (!Array.isArray(catalog.items) || catalog.items.length <= 0)) {
    return '⚪ 대기';
  }

  if (catalog.phase === 'PREPARING') {
    const stageLabelMap = {
      FETCHING_FEED: 'feed 수집 중',
      PREPARING_NICS: 'NIC 준비 중',
      CONNECTING_SLOTS: '슬롯 연결 중',
      VERIFYING_SLOTS: '검증 중',
    };
    const stageLabel = stageLabelMap[String(catalog.stage || '').toUpperCase()] || 'live pool 준비 중';
    return `🟡 ${stageLabel}`;
  }

  if (catalog.phase === 'READY') {
    return '🟢 live pool 준비 완료';
  }

  if (catalog.phase === 'SWITCHING') {
    return '🟡 owner 전환 중';
  }

  if (catalog.phase === 'CONNECTED') {
    return '🟢 owner 유지 중';
  }

  if (catalog.lastErrorMessage) {
    return '🔴 최근 오류';
  }

  return '⚪ 대기';
}

function getSelfHostedVpnCatalogStatusClassName(catalog = {}) {
  if (['READY', 'CONNECTED'].includes(String(catalog.phase || ''))) {
    return 'status-on';
  }

  if (['PREPARING', 'SWITCHING'].includes(String(catalog.phase || '')) || catalog.lastErrorMessage) {
    return 'status-warn';
  }

  return 'status-muted';
}

function buildSelfHostedVpnCatalogCountText(catalog = {}) {
  if (!catalog.startedAt && (!Array.isArray(catalog.items) || catalog.items.length <= 0)) {
    return '-';
  }

  const parts = [
    `후보 ${catalog.requestedCandidateCount || catalog.sourceHostCount || 0}`,
    `logical ${catalog.logicalSlotCount || catalog.items.length || 0}`,
    `NIC ${catalog.detectedPhysicalNicCapacity || catalog.provisionableSlotCount || 0}`,
    `준비 ${catalog.preparedNicCount || 0}`,
    `시도 ${catalog.connectAttemptedCount || 0}`,
    `연결 ${catalog.connectedSlotCount || 0}`,
    `검증 ${catalog.verifiedSlotCount || catalog.usableRelayCount || 0}`,
  ];
  if (catalog.capacityDeferredSlotCount) {
    parts.push(`보류 ${catalog.capacityDeferredSlotCount}`);
  }
  if (catalog.failedSlotCount) {
    parts.push(`실패 ${catalog.failedSlotCount}`);
  }

  if (catalog.activeSlotId) {
    parts.push(`활성 ${catalog.activeSlotId}`);
  }
  if (catalog.routeOwnerSlotId && catalog.routeOwnerSlotId !== catalog.activeSlotId) {
    parts.push(`owner ${catalog.routeOwnerSlotId}`);
  }

  return parts.join(' / ');
}

function buildSelfHostedVpnCatalogMetaText(status = {}, catalog = {}) {
  if (catalog.lastErrorMessage) {
    return `raw catalog 최근 오류: ${catalog.lastErrorMessage}`;
  }

  if (!catalog.startedAt) {
    return '토글 ON을 누르면 official raw feed 후보를 200 logical slot으로 만들고, 가능한 NIC만 먼저 준비한 뒤 연결/검증을 순서대로 진행합니다.';
  }

  if (catalog.phase === 'PREPARING') {
    const stage = String(catalog.stage || '').toUpperCase();
    if (stage === 'FETCHING_FEED') {
      return `official raw feed 후보를 읽어 logical slot으로 만드는 중입니다. 목표 후보 ${catalog.request?.limit || catalog.requestedCandidateCount || 200}개입니다.`;
    }
    if (stage === 'PREPARING_NICS') {
      return `logical slot ${catalog.logicalSlotCount || catalog.items.length || 0}개를 만든 뒤 NIC를 준비하는 중입니다. requested NIC ${catalog.requestedPhysicalNicCount || catalog.request?.requestedPhysicalNicCount || 0}, prepared ${catalog.preparedNicCount || 0}입니다.`;
    }
    if (stage === 'CONNECTING_SLOTS') {
      return `준비된 NIC ${catalog.preparedNicCount || 0}개를 기준으로 병렬 연결 중입니다. connect attempted ${catalog.connectAttemptedCount || 0}, connected ${catalog.connectedSlotCount || 0}, deferred ${catalog.capacityDeferredSlotCount || 0}입니다.`;
    }
    if (stage === 'VERIFYING_SLOTS') {
      return `연결된 slot의 route/public IP를 직렬 검증 중입니다. connected ${catalog.connectedSlotCount || 0}, verified ${catalog.verifiedSlotCount || 0}입니다.`;
    }
    return `후보 ${catalog.requestedCandidateCount || catalog.sourceHostCount || 0}개를 준비 중입니다. logical ${catalog.logicalSlotCount || 0}, NIC prepared ${catalog.preparedNicCount || 0}, verified ${catalog.verifiedSlotCount || 0}입니다.`;
  }

  if (catalog.phase === 'SWITCHING') {
    return `${catalog.routeOwnerSlotId || catalog.activeSlotId || '대상 슬롯'} 으로 owner를 옮긴 뒤 출구 IP를 다시 확인하는 중입니다.`;
  }

  if (['READY', 'CONNECTED'].includes(String(catalog.phase || ''))) {
    const activeHost = buildSelfHostedVpnRelayText(status);
    const lastVerifiedIpText = buildSelfHostedVpnPublicIpText(
      catalog.lastVerifiedPublicIp,
      catalog.lastVerifiedPublicIpProvider,
    );
    return `검증 통과 슬롯 ${catalog.verifiedSlotCount || catalog.usableRelayCount || 0}개가 준비돼 있습니다. logical=${catalog.logicalSlotCount || 0}, NIC prepared=${catalog.preparedNicCount || 0}, active=${catalog.activeSlotId || '-'}, owner=${catalog.routeOwnerSlotId || '-'}, 마지막 검증 IP=${lastVerifiedIpText}, 현재 릴레이=${activeHost}.`;
  }

  return 'live pool 상태를 새로고침해서 active slot, owner slot, 검증 IP를 확인하세요.';
}

function renderSelfHostedVpnCatalogList(container, status = {}, catalog = {}, parallelProbe = {}) {
  if (!container) {
    return;
  }

  container.replaceChildren();

  const stage = String(catalog.stage || '').toUpperCase();
  const interestingPoolStates = new Set(['VERIFIED', 'VERIFYING', 'CONNECTED', 'CONNECTING', 'NIC_READY', 'CAPACITY_DEFERRED', 'ERROR']);
  const visibleItems = Array.isArray(catalog.items)
    ? catalog.items
      .filter((item) => interestingPoolStates.has(item.poolState) || item.isActive || item.routeOwned)
      .sort((left, right) => {
        const priorityOf = (item) => {
          if (item.isActive) {
            return 0;
          }
          if (item.routeOwned) {
            return 1;
          }
          if (item.poolState === 'VERIFIED') {
            return 2;
          }
          if (item.poolState === 'VERIFYING') {
            return 3;
          }
          if (item.poolState === 'CONNECTED') {
            return 4;
          }
          if (item.poolState === 'CONNECTING') {
            return 5;
          }
          if (item.poolState === 'NIC_READY') {
            return 6;
          }
          if (item.poolState === 'CAPACITY_DEFERRED') {
            return 7;
          }
          return 8;
        };
        const leftPriority = priorityOf(left);
        const rightPriority = priorityOf(right);
        if (leftPriority !== rightPriority) {
          return leftPriority - rightPriority;
        }
        return String(left.slotId || '').localeCompare(String(right.slotId || ''));
      })
      .slice(0, 40)
    : [];

  if (visibleItems.length <= 0) {
    const empty = document.createElement('div');
    empty.className = 'log-empty';
    empty.textContent = catalog.phase === 'PREPARING'
      ? `live pool 슬롯을 준비 중입니다. stage=${stage || 'IDLE'}`
      : '검증 통과 live pool 슬롯이 없습니다.';
    container.appendChild(empty);
    return;
  }

  const connectLocked = parallelProbe.isRunning
    || ['PREPARING', 'CONNECTING', 'SWITCHING', 'DISCONNECTING'].includes(String(status.phase || '').toUpperCase())
    || normalizeSelfHostedVpnConnectionMode(status.activeConnectionMode || status.config?.connectionMode) !== 'softether_vpngate_raw'
    || Boolean(status.lastErrorCode === 'AGENT_UNAVAILABLE' && !status.agentReachable);

  for (const item of visibleItems) {
    const card = document.createElement('div');
    card.className = `self-hosted-vpn-catalog-item${item.isActive ? ' is-active' : ''}${item.accountStatusKind === 'MISSING' ? ' is-missing' : ''}${item.routeOwned ? ' is-route-owner' : ''}`;

    const head = document.createElement('div');
    head.className = 'self-hosted-vpn-catalog-head';

    const textWrap = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'self-hosted-vpn-catalog-title';
    title.textContent = `${item.ip || item.fqdn || '미지정'}:${item.selectedSslPort || '-'}`;

    const subtitle = document.createElement('div');
    subtitle.className = 'self-hosted-vpn-catalog-subtitle';
    subtitle.textContent = [
      item.slotId || '-',
      item.countryShort || '-',
      item.fqdn || item.hostName || '-',
      item.nicName || '-',
    ].join(' / ');

    textWrap.append(title, subtitle);

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-secondary self-hosted-vpn-catalog-connect-btn';
    button.dataset.selfHostedVpnCatalogConnect = 'true';
    button.dataset.slotId = item.slotId || '';
    button.dataset.lookupKey = item.lookupKey || '';

    const isCurrentActive = Boolean(item.isActive);
    if (item.poolState === 'CONNECTING') {
      button.textContent = '연결 중';
      button.disabled = true;
    } else if (item.poolState === 'CONNECTED') {
      button.textContent = '검증 대기';
      button.disabled = true;
    } else if (item.poolState === 'VERIFYING') {
      button.textContent = '검증 중';
      button.disabled = true;
    } else if (item.poolState === 'NIC_READY') {
      button.textContent = 'NIC 준비';
      button.disabled = true;
    } else if (item.poolState === 'CAPACITY_DEFERRED') {
      button.textContent = '보류';
      button.disabled = true;
    } else if (item.poolState !== 'VERIFIED' && !isCurrentActive) {
      button.textContent = '준비 안 됨';
      button.disabled = true;
    } else if (String(status.phase || '').toUpperCase() === 'SWITCHING') {
      button.textContent = item.routeOwned || isCurrentActive ? '전환 중' : '대기';
      button.disabled = true;
    } else if (isCurrentActive && String(status.phase || '').toUpperCase() === 'CONNECTED') {
      button.textContent = '활성';
      button.disabled = true;
    } else if (isCurrentActive) {
      button.textContent = '활성';
      button.disabled = true;
    } else {
      button.textContent = '전환';
      button.disabled = connectLocked;
    }

    head.append(textWrap, button);

    const meta = document.createElement('div');
    meta.className = 'self-hosted-vpn-catalog-meta';
    const exitIpText = buildSelfHostedVpnPublicIpText(item.exitPublicIp, item.exitPublicIpProvider);
    const routeStateText = item.routeOwned ? 'owner' : (item.routeReady ? 'ready' : 'idle');
    meta.textContent = `계정=${item.accountName || '-'} / pool=${item.poolState || '-'} / route=${routeStateText} / 출구IP=${exitIpText} / IF=${item.interfaceAlias || item.nicName || item.preferredNicName || '-'} / connectAttempted=${item.connectAttempted ? 'Y' : 'N'} / score=${item.score || 0}`;

    card.append(head, meta);
    container.appendChild(card);
  }
}

function buildSelfHostedVpnParallelStatusText(parallelProbe = {}) {
  if (!parallelProbe.startedAt && !parallelProbe.isRunning) {
    return '대기';
  }

  const phaseLabels = {
    PREPARING: '준비 중',
    CONNECTING: '슬롯 연결 중',
    VERIFYING: 'route/IP 검증 중',
    COMPLETE: '검증 완료',
    STOPPING: '정리 중',
    ERROR: '최근 오류',
    IDLE: '정지',
  };
  const phaseLabel = phaseLabels[parallelProbe.phase] || parallelProbe.phase || '정지';
  return parallelProbe.isRunning ? `🟡 ${phaseLabel}` : `⚪ ${phaseLabel}`;
}

function buildSelfHostedVpnParallelSlotsText(parallelProbe = {}) {
  if (!Array.isArray(parallelProbe.slots) || parallelProbe.slots.length <= 0) {
    return '-';
  }

  return parallelProbe.slots
    .map((slot) => {
      const relayHost = String(slot.relay?.ip || slot.relay?.fqdn || '').trim();
      const relayPort = Number.parseInt(String(slot.relay?.selectedSslPort || 0), 10) || 0;
      const relayText = relayHost ? `${relayHost}${relayPort ? `:${relayPort}` : ''}` : '-';
      return `${slot.slotId}/${slot.nicName || '-'}=${slot.phase}(${relayText})`;
    })
    .join(' | ');
}

function buildSelfHostedVpnParallelMetaText(parallelProbe = {}) {
  if (parallelProbe.lastErrorMessage) {
    return `병렬 probe 최근 오류: ${parallelProbe.lastErrorMessage}`;
  }

  if (!parallelProbe.startedAt) {
    return '병렬 probe를 시작하면 local agent가 최신 official raw feed 3개를 골라 Connected 후 route owner를 바꿔가며 출구 IPv4를 확인합니다.';
  }

  if (parallelProbe.isRunning) {
    return `현재 phase=${parallelProbe.phase || '-'} 입니다. 마지막 검증 IP는 ${buildSelfHostedVpnPublicIpText(parallelProbe.lastVerifiedPublicIp, parallelProbe.lastVerifiedPublicIpProvider)} 이고, route owner는 ${parallelProbe.routeOwnerSlotId || '-'} 입니다.`;
  }

  return `최근 병렬 probe는 ${parallelProbe.phase || 'IDLE'} 로 끝났습니다. 마지막 검증 IP는 ${buildSelfHostedVpnPublicIpText(parallelProbe.lastVerifiedPublicIp, parallelProbe.lastVerifiedPublicIpProvider)} 입니다.`;
}

function buildSelfHostedVpnLogEntries(singleLogs = [], catalogLogs = [], parallelLogs = []) {
  const normalizedSingleLogs = Array.isArray(singleLogs) ? singleLogs : [];
  const normalizedCatalogLogs = Array.isArray(catalogLogs) ? catalogLogs : [];
  const normalizedParallelLogs = Array.isArray(parallelLogs) ? parallelLogs : [];
  const merged = [
    ...normalizedParallelLogs,
    ...normalizedCatalogLogs,
    ...normalizedSingleLogs,
  ].filter(Boolean);
  return merged.slice(0, 20);
}

function sanitizeSelfHostedVpnToken(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'relay';
}

function getBumpPostStatusLabel(status = {}) {
  if (status.isRunning && status.phase === 'WAITING') {
    return '🟡 다음 끌올 대기 중';
  }

  if (status.isRunning) {
    return '🟢 실행 중';
  }

  if (status.lastErrorMessage) {
    return '🔴 정지 (최근 오류)';
  }

  return '🔴 정지';
}

function getBumpPostStatusClassName(status = {}) {
  if (status.isRunning && status.phase === 'WAITING') {
    return 'status-warn';
  }

  if (status.isRunning) {
    return 'status-on';
  }

  if (status.lastErrorMessage) {
    return 'status-warn';
  }

  return 'status-off';
}

function buildBumpPostMetaText(status = {}) {
  const postNo = status.config?.postNo ? `#${status.config.postNo}` : '미지정';
  const durationMinutes = Number(status.config?.durationMinutes) || 60;
  const intervalMinutes = Number(status.config?.intervalMinutes) || 1;

  if (status.lastErrorMessage) {
    return `최근 오류: ${status.lastErrorMessage}`;
  }

  if (!status.isRunning) {
    return `${postNo} 글을 ${durationMinutes}분 동안 ${intervalMinutes}분마다 끌올하도록 저장해둘 수 있습니다. ON 하면 즉시 1회 실행 후 예약을 시작합니다.`;
  }

  if (status.phase === 'WAITING' && status.nextRunAt) {
    return `${postNo} 글을 ${intervalMinutes}분 주기로 대기 중입니다. 다음 끌올은 ${formatTimestamp(status.nextRunAt)} 입니다.`;
  }

  if (status.lastBumpedAt) {
    return `${postNo} 글을 마지막으로 ${formatTimestamp(status.lastBumpedAt)} 에 끌올했고, ${formatTimestamp(status.endsAt)} 까지 자동 반복합니다.`;
  }

  return `${postNo} 글을 시작 즉시 1회 끌올한 뒤 ${intervalMinutes}분마다 반복하고, ${durationMinutes}분이 지나면 자동 정지합니다.`;
}

function getSinmungoCommentStatusLabel(status = {}) {
  const phase = String(status.phase || '').trim().toUpperCase();
  if (status.isRunning && phase === 'PREPARING_CHALLENGE') {
    return '🟡 인증코드 준비 중';
  }

  if (status.isRunning && phase === 'WAITING_CODE') {
    return '🟠 코드 입력 대기';
  }

  if (status.isRunning) {
    return '🟡 댓글 등록 중';
  }

  if (phase === 'SUCCESS') {
    return '🟢 최근 등록 성공';
  }

  if (phase === 'ERROR' || status.lastErrorMessage) {
    return '🔴 최근 등록 실패';
  }

  return '⚪ 대기';
}

function getSinmungoCommentStatusClassName(status = {}) {
  const phase = String(status.phase || '').trim().toUpperCase();
  if (status.isRunning && phase === 'WAITING_CODE') {
    return 'status-warn';
  }

  if (status.isRunning) {
    return 'status-warn';
  }

  if (phase === 'SUCCESS') {
    return 'status-on';
  }

  if (phase === 'ERROR' || status.lastErrorMessage) {
    return 'status-warn';
  }

  return 'status-muted';
}

function buildSinmungoCommentMetaText(status = {}) {
  const submitModeLabel = getSinmungoCommentSubmitModeLabel(status.config?.submitMode);
  const phase = String(status.phase || '').trim().toUpperCase();
  const targetPostNo = String(status.lastTargetPostNo || status.config?.postNo || '').trim();
  if (status.isRunning && phase === 'PREPARING_CHALLENGE') {
    return `[${submitModeLabel}] ${targetPostNo ? `#${targetPostNo}` : '대상 게시물'} 의 유동 댓글 폼과 인증코드 이미지를 준비하는 중입니다.`;
  }

  if (status.isRunning && phase === 'WAITING_CODE') {
    return `[${submitModeLabel}] ${targetPostNo ? `#${targetPostNo}` : '대상 게시물'} 에 대한 인증코드 입력 대기 상태입니다. popup 아래 수동입력 영역에서 닉네임과 코드를 넣고 댓글 등록을 누르세요.`;
  }

  if (status.isRunning) {
    return `[${submitModeLabel}] ${targetPostNo ? `#${targetPostNo}` : '대상 게시물'} 에 댓글 1개를 등록하고, 목록 재조회로 실제 생성 여부를 확인하는 중입니다.`;
  }

  if (status.lastErrorMessage) {
    return `[${submitModeLabel}] 최근 오류: ${status.lastErrorMessage}`;
  }

  if (phase === 'SUCCESS') {
    const commentNo = String(status.lastCommentNo || '').trim();
    return `[${submitModeLabel}] ${targetPostNo ? `#${targetPostNo}` : '대상 게시물'} 에 댓글 등록을 마쳤습니다.${commentNo ? ` 확인된 댓글 번호는 #${commentNo} 입니다.` : ''}`;
  }

  return `[${submitModeLabel}] 대기 상태입니다. 설정 저장 후 토글 ON을 누르면 댓글 1개를 등록하고, 인증코드가 필요한 글이면 아래 수동입력 영역으로 이어집니다.`;
}

function getSinmungoCommentSubmitModeLabel(value = '') {
  return String(value || '').trim().toLowerCase() === 'anonymous'
    ? '유동용 테스트'
    : '고닉용 테스트';
}

function syncSinmungoCommentModeInputs(status = latestSinmungoCommentStatus) {
  const dom = FEATURE_DOM.sinmungoComment;
  if (!dom?.submitModeInput || !dom?.passwordInput || !dom?.anonymousNameSetting || !dom?.passwordSetting) {
    return;
  }

  const submitMode = String(dom.submitModeInput.value || status?.config?.submitMode || 'member').trim().toLowerCase();
  const isAnonymousMode = submitMode === 'anonymous';
  dom.anonymousNameSetting.hidden = !isAnonymousMode;
  dom.passwordSetting.hidden = !isAnonymousMode;
  dom.passwordInput.placeholder = isAnonymousMode
    ? '예: 비회원 테스트용 비밀번호'
    : '고닉/로그인 테스트에서는 사용하지 않음';
  dom.anonymousNameInput.placeholder = isAnonymousMode
    ? '예: ㅇㅇ'
    : '유동 모드에서만 사용';
  if (!isAnonymousMode) {
    dom.passwordInput.value = '';
  }
  setDisabled(dom.anonymousNameInput, Boolean(status?.isRunning) || !isAnonymousMode);
  setDisabled(dom.passwordInput, Boolean(status?.isRunning) || !isAnonymousMode);
}

function buildSinmungoCommentChallengeMetaText(status = {}, pendingChallenge = null) {
  const phase = String(status.phase || '').trim().toUpperCase();
  if (phase === 'PREPARING_CHALLENGE') {
    return '유동 댓글 인증코드 이미지를 준비하는 중입니다. 잠시만 기다리세요.';
  }

  if (phase === 'WAITING_CODE' && pendingChallenge?.nameEditable) {
    return '인증코드 이미지를 보고 코드와 유동 닉네임을 입력한 뒤 댓글 등록을 누르세요.';
  }

  if (phase === 'WAITING_CODE') {
    return '인증코드 이미지를 보고 코드를 입력한 뒤 댓글 등록을 누르세요.';
  }

  if (status.lastErrorMessage) {
    return `최근 오류: ${status.lastErrorMessage}`;
  }

  return '인증코드가 필요한 글이면 여기에 이미지와 입력칸이 나타납니다.';
}

function normalizeSinmungoCommentPendingChallenge(challenge = null) {
  if (!challenge || typeof challenge !== 'object') {
    return null;
  }

  const challengeId = String(challenge.challengeId || '').trim();
  const postNo = String(challenge.postNo || '').trim();
  if (!challengeId || !postNo) {
    return null;
  }

  return {
    challengeId,
    postNo,
    preparedAt: String(challenge.preparedAt || '').trim(),
    captchaImageUrl: String(challenge.captchaImageUrl || '').trim(),
    requiresCode: Boolean(challenge.requiresCode),
    useGallNick: String(challenge.useGallNick || 'N').trim().toUpperCase() === 'Y' ? 'Y' : 'N',
    gallNickName: String(challenge.gallNickName || '').trim(),
    anonymousName: String(challenge.anonymousName || '').trim(),
    nameEditable: Boolean(challenge.nameEditable),
  };
}

function getRefluxDatasetCollectorStatusLabel(status = {}) {
  if (status.isRunning && status.phase === 'WAITING') {
    return '🟡 다음 페이지 대기 중';
  }

  if (status.isRunning) {
    return '🟢 수집 중';
  }

  if (status.interrupted) {
    return '🟠 중단됨';
  }

  if (status.downloadReady) {
    return '🟢 수집 완료';
  }

  if (status.lastError) {
    return '🔴 정지 (최근 오류)';
  }

  return '🔴 정지';
}

function getRefluxDatasetCollectorStatusClassName(status = {}) {
  if (status.isRunning) {
    return status.phase === 'WAITING' ? 'status-warn' : 'status-on';
  }

  if (status.downloadReady) {
    return 'status-on';
  }

  if (status.interrupted || status.lastError) {
    return 'status-warn';
  }

  return 'status-off';
}

function getRefluxOverlayCollectorStatusLabel(status = {}) {
  if (status.isRunning && status.phase === 'LOCATING') {
    return '🟠 anchor 탐색 중';
  }

  if (status.isRunning && status.phase === 'FETCHING') {
    return '🟢 페이지 수집 중';
  }

  if (status.isRunning && status.phase === 'SAVING') {
    return '🟠 overlay 저장 중';
  }

  if (status.isRunning) {
    return '🟢 실행 중';
  }

  if (status.interrupted || status.phase === 'INTERRUPTED') {
    return '🟠 중단됨';
  }

  if (status.lastError || status.phase === 'FAILED') {
    return '🔴 정지 (최근 오류)';
  }

  if (status.appliedOverlayId) {
    return '🟢 적용 완료';
  }

  return '🔴 정지';
}

function getRefluxOverlayCollectorStatusClassName(status = {}) {
  if (status.isRunning) {
    return status.phase === 'SAVING' || status.phase === 'LOCATING'
      ? 'status-warn'
      : 'status-on';
  }

  if (status.interrupted || status.phase === 'INTERRUPTED' || status.lastError || status.phase === 'FAILED') {
    return 'status-warn';
  }

  if (status.appliedOverlayId) {
    return 'status-on';
  }

  return 'status-off';
}

function getCommentRefluxCollectorStatusLabel(status = {}) {
  if (status.isRunning && status.phase === 'WAITING') {
    return '🟡 다음 페이지 대기 중';
  }

  if (status.isRunning) {
    return '🟢 수집 중';
  }

  if (status.interrupted) {
    return '🟠 중단됨';
  }

  if (status.downloadReady) {
    return '🟢 수집 완료';
  }

  if (status.lastError) {
    return '🔴 정지 (최근 오류)';
  }

  return '🔴 정지';
}

function getCommentRefluxCollectorStatusClassName(status = {}) {
  if (status.isRunning) {
    return status.phase === 'WAITING' ? 'status-warn' : 'status-on';
  }

  if (status.downloadReady) {
    return 'status-on';
  }

  if (status.interrupted || status.lastError) {
    return 'status-warn';
  }

  return 'status-off';
}

function buildRefluxDatasetCollectorProgressText(status = {}) {
  const currentPage = Number(status.currentPage) || 0;
  const endPage = Number(status.config?.endPage) || 0;
  if (currentPage <= 0 || endPage <= 0) {
    return '-';
  }

  return `${currentPage} / ${endPage}`;
}

function buildRefluxOverlayCollectorProgressText(status = {}) {
  const completedPageCount = Number(status.completedPageCount) || 0;
  const targetPageCount = Number(status.targetPageCount) || 0;
  const currentPage = Number(status.currentPage) || 0;
  if (targetPageCount <= 0) {
    return currentPage > 0
      ? `${currentPage}페이지`
      : '-';
  }

  if (currentPage > 0 && status.isRunning && status.phase === 'FETCHING') {
    return `${completedPageCount} / ${targetPageCount} (현재 ${currentPage})`;
  }

  return `${completedPageCount} / ${targetPageCount}`;
}

function buildCommentRefluxCollectorProgressText(status = {}) {
  const currentPage = Number(status.currentPage) || 0;
  const endPage = Number(status.config?.endPage) || 0;
  if (currentPage <= 0 || endPage <= 0) {
    return '-';
  }

  return `${currentPage} / ${endPage}`;
}

function buildRefluxDatasetCollectorMetaText(status = {}) {
  const galleryId = status.collectedGalleryId
    ? String(status.collectedGalleryId)
    : (status.config?.galleryId ? String(status.config.galleryId) : '미지정');
  if (status.lastError) {
    return `최근 오류: ${status.lastError}`;
  }

  if (status.interrupted) {
    return '이전 수집 작업이 중간에 끊겨 자동 복원을 건너뛰었습니다. 설정을 확인한 뒤 다시 시작하세요.';
  }

  if (status.downloadReady) {
    return `${galleryId} 수집이 완료되었습니다. JSON 다운로드로 배포용 dataset 파일을 내려받을 수 있습니다.`;
  }

  if (status.isRunning) {
    return `${galleryId} 목록 제목을 순차 수집 중입니다. 병렬 요청 없이 delay + jitter를 적용합니다.`;
  }

  return '정지 상태입니다. 수집 시작 후 완료되면 JSON 다운로드가 활성화됩니다.';
}

function buildRefluxOverlayCollectorMetaText(status = {}) {
  const galleryId = status.galleryId
    ? String(status.galleryId)
    : '미지정';
  if (status.lastError) {
    return `최근 오류: ${status.lastError}`;
  }

  if (status.interrupted || status.phase === 'INTERRUPTED') {
    return '이전 overlay 수집 작업이 중간에 끊겨 자동 복원을 건너뛰었습니다. 설정을 확인한 뒤 다시 시작하세요.';
  }

  if (status.appliedOverlayId) {
    const failedPageCount = Number(status.failedPageCount) || 0;
    if (failedPageCount > 0) {
      return `${galleryId} overlay가 적용되었습니다. 일부 실패 페이지 ${failedPageCount}개는 제외된 상태로 로컬 matcher에 반영됐습니다.`;
    }
    return `${galleryId} overlay가 적용되었습니다. 다음 게시물/댓글 사이클부터 local matcher가 바로 이 overlay를 같이 봅니다.`;
  }

  if (status.isRunning) {
    return `${galleryId || '대상 미지정'} anchor 주변 페이지를 수집해 local overlay dataset으로 저장하는 중입니다.`;
  }

  return '정지 상태입니다. 수집이 끝나면 overlay가 즉시 로컬 matcher에 반영됩니다.';
}

function buildCommentRefluxCollectorMetaText(status = {}) {
  const galleryId = status.collectedGalleryId
    ? String(status.collectedGalleryId)
    : (status.config?.galleryId ? String(status.config.galleryId) : '미지정');
  if (status.lastError) {
    return `최근 오류: ${status.lastError}`;
  }

  if (status.interrupted) {
    return '이전 댓글 수집 작업이 중간에 끊겨 자동 복원을 건너뛰었습니다. 설정을 확인한 뒤 다시 시작하세요.';
  }

  if (status.downloadReady) {
    return `${galleryId} 댓글 수집이 완료되었습니다. source manifest + shard 다운로드로 merge/build 입력 파일을 내려받을 수 있습니다.`;
  }

  if (status.isRunning) {
    return `${galleryId} 댓글을 목록 순차 / 글 병렬 / 댓글페이지 병렬로 수집 중입니다.`;
  }

  return '정지 상태입니다. 수집 완료 후 source manifest + shard 다운로드가 활성화됩니다.';
}

function normalizeRefluxDatasetCollectorGalleryId(value) {
  return String(value || '').trim();
}

function normalizeRefluxOverlayCollectorViewUrl(value) {
  return String(value || '').trim();
}

function normalizeRefluxOverlayCollectorTransportMode(value) {
  return value === 'proxy_bridge'
    ? 'proxy_bridge'
    : 'direct';
}

function isValidRefluxDatasetCollectorGalleryId(value) {
  return /^[a-z0-9_]+$/i.test(normalizeRefluxDatasetCollectorGalleryId(value));
}

function normalizeCommentRefluxCollectorGalleryId(value) {
  return String(value || '').trim();
}

function isValidCommentRefluxCollectorGalleryId(value) {
  return /^[a-z0-9_]+$/i.test(normalizeCommentRefluxCollectorGalleryId(value));
}

function normalizeRefluxSearchGalleryIdInputValue(value) {
  return String(value || '').trim().toLowerCase();
}

function isValidRefluxSearchGalleryId(value) {
  return /^[a-z0-9_]+$/i.test(normalizeRefluxSearchGalleryIdInputValue(value));
}

function normalizeBumpPostPostNoInputValue(value) {
  return String(value || '').trim();
}

function isValidBumpPostPostNo(value) {
  return /^\d+$/.test(normalizeBumpPostPostNoInputValue(value));
}

function buildDefaultUidRatioWarningStatus() {
  return {
    enabled: false,
    applying: false,
    supported: true,
    tabId: 0,
    pageUrl: '',
    matchedUidCount: 0,
    warnedUidCount: 0,
    lastAppliedAt: '',
    lastError: '',
  };
}

function getUidRatioWarningStatusLabel(status = {}) {
  if (status.applying) {
    return '🟠 검사 중';
  }

  if (status.lastError) {
    return '🔴 적용 실패';
  }

  if (!status.supported) {
    return '⚪ 디시 페이지 아님';
  }

  if (!status.enabled) {
    return '🔴 미적용';
  }

  if ((status.warnedUidCount ?? 0) > 0) {
    return `🟢 경고 ${status.warnedUidCount}명`;
  }

  if ((status.matchedUidCount ?? 0) > 0) {
    return '🟡 경고 없음';
  }

  return '🟡 식별코드 없음';
}

function getUidRatioWarningStatusClassName(status = {}) {
  if (status.applying) {
    return 'status-warn';
  }

  if (status.lastError) {
    return 'status-off';
  }

  if (!status.supported) {
    return 'status-muted';
  }

  if (!status.enabled) {
    return 'status-off';
  }

  return (status.warnedUidCount ?? 0) > 0 ? 'status-warn' : 'status-on';
}

function buildUidRatioWarningMetaText(status = {}) {
  if (!status.supported) {
    return '디시인사이드 게시판/본문 페이지에서만 사용할 수 있습니다.';
  }

  if (status.applying) {
    return '현재 탭 식별코드 활동 통계를 조회하는 중입니다.';
  }

  if (status.lastError) {
    return status.lastError;
  }

  if (!status.enabled) {
    return '켜두면 디시 페이지를 옮겨도 현재 보는 탭에 다시 적용됩니다.';
  }

  if ((status.matchedUidCount ?? 0) === 0) {
    return '현재 페이지에 식별코드 작성자가 없어 표시할 경고가 없습니다.';
  }

  if ((status.warnedUidCount ?? 0) === 0) {
    return '현재 페이지 식별코드를 검사했지만 글 비중 90% 이상 경고 대상은 없습니다.';
  }

  return `현재 페이지 식별코드 ${status.matchedUidCount}명 중 ${status.warnedUidCount}명에 경고를 붙였습니다.`;
}

function buildDefaultUidWarningAutoBanStatus() {
  return {
    isRunning: false,
    phase: 'IDLE',
    currentPage: 1,
    lastPollAt: '',
    nextRunAt: '',
    lastTriggeredUid: '',
    lastTriggeredPostCount: 0,
    lastBurstRecentCount: 0,
    lastSingleSightTriggeredUid: '',
    lastSingleSightTriggeredPostCount: 0,
    lastImmediateTitleBanCount: 0,
    lastImmediateTitleBanMatchedTitle: '',
    lastAttackTitleClusterCount: 0,
    lastAttackTitleClusterPostCount: 0,
    lastAttackTitleClusterRepresentative: '',
    lastAttackCommentClusterCount: 0,
    lastAttackCommentClusterDeleteCount: 0,
    lastAttackCommentClusterPostCount: 0,
    lastAttackCommentClusterRepresentative: '',
    lastPageUidCount: 0,
    totalTriggeredUidCount: 0,
    totalSingleSightTriggeredUidCount: 0,
    totalImmediateTitleBanPostCount: 0,
    totalAttackTitleClusterPostCount: 0,
    totalAttackCommentClusterDeleteCount: 0,
    totalSingleSightBannedPostCount: 0,
    totalBannedPostCount: 0,
    totalFailedPostCount: 0,
    deleteLimitFallbackCount: 0,
    banOnlyFallbackCount: 0,
    lastError: '',
    runtimeDeleteEnabled: true,
    runtimeDeleteModeReason: 'normal',
    lastDeleteLimitExceededAt: '',
    lastDeleteLimitMessage: '',
    logs: [],
    config: {
      immediateTitleBanRules: [],
    },
  };
}

function getUidWarningAutoBanStatusLabel(status = {}) {
  if (status.isRunning && status.runtimeDeleteEnabled === false) {
    return '🟠 차단만 유지 중';
  }

  if (status.isRunning) {
    return '🟢 실행 중';
  }

  if (status.lastError) {
    return '🔴 정지 (최근 오류)';
  }

  return '🔴 정지';
}

function getUidWarningAutoBanStatusClassName(status = {}) {
  if (status.isRunning && status.runtimeDeleteEnabled === false) {
    return 'status-warn';
  }

  if (status.isRunning) {
    return 'status-on';
  }

  if (status.lastError) {
    return 'status-warn';
  }

  return 'status-off';
}

function buildUidWarningAutoBanMetaText(status = {}) {
  const immediateTitleRuleCount = Array.isArray(status.config?.immediateTitleBanRules)
    ? status.config.immediateTitleBanRules.length
    : 0;

  if (!status.isRunning) {
    return `10초마다 1페이지를 확인해 제목 직차단 ${immediateTitleRuleCount}개 규칙, 실제공격 제목/댓글 군집, 글댓총합 20 미만 page1 burst 깡계, 방명록 잠금 저활동 깡계를 함께 봅니다.`;
  }

  if (status.lastError) {
    return status.lastError;
  }

  if (status.runtimeDeleteEnabled === false) {
    if (status.runtimeDeleteModeReason === 'monitor_attack') {
      return '감시 자동화 공격/복구 중이라 분탕자동차단은 차단만 유지합니다.';
    }

    if (status.runtimeDeleteModeReason !== 'delete_limit') {
      return '현재는 분탕자동차단이 차단만 유지 중입니다. 삭제는 수행하지 않습니다.';
    }

    const detail = status.lastDeleteLimitMessage ? ` (${status.lastDeleteLimitMessage})` : '';
    return `삭제 한도 보호 상태라 새 글이 와도 당분간 차단만 수행합니다${detail}`;
  }

  if ((status.lastImmediateTitleBanCount ?? 0) > 0) {
    return `최근 제목 직차단 ${status.lastImmediateTitleBanMatchedTitle || '규칙'} / page1 글 ${status.lastImmediateTitleBanCount ?? 0}개`;
  }

  if ((status.lastAttackTitleClusterPostCount ?? 0) > 0) {
    return `최근 실제공격 제목 군집 ${status.lastAttackTitleClusterRepresentative || '패턴'} / page1 유동글 ${status.lastAttackTitleClusterPostCount ?? 0}개`;
  }

  if ((status.lastAttackCommentClusterDeleteCount ?? 0) > 0) {
    return `최근 실제공격 댓글 군집 ${status.lastAttackCommentClusterRepresentative || '패턴'} / 유동댓글 ${status.lastAttackCommentClusterDeleteCount ?? 0}개 차단/삭제`;
  }

  if (status.lastSingleSightTriggeredUid) {
    return `최근 단일깡계 ${status.lastSingleSightTriggeredUid} / page1 글 ${status.lastSingleSightTriggeredPostCount ?? 0}개`;
  }

  if (status.lastTriggeredUid) {
    return `최근 제재 uid ${status.lastTriggeredUid} / page1 글 ${status.lastTriggeredPostCount ?? 0}개`;
  }

  if (immediateTitleRuleCount > 0) {
    return `현재는 제목 직차단 ${immediateTitleRuleCount}개 규칙, 실제공격 제목/댓글 군집, 글댓총합 20 미만인 page1 burst 깡계, 방명록 잠금 저활동 깡계를 함께 감시 중입니다.`;
  }

  return '현재는 제목 직차단 / 실제공격 제목·댓글 군집 / 글댓총합 20 미만 page1 burst 깡계 / 방명록 잠금 저활동 깡계를 함께 대기 중입니다.';
}

function updateToggle(dom, isRunning) {
  dom.toggleBtn.checked = Boolean(isRunning);
  dom.toggleLabel.textContent = isRunning ? 'ON' : 'OFF';
  dom.toggleLabel.className = `toggle-label ${isRunning ? 'on' : 'off'}`;
}

function updateStatusText(node, text, className) {
  node.textContent = text;
  node.className = `status-value ${className}`;
}

function updateLogList(logList, logs) {
  if (logs?.length > 0) {
    logList.innerHTML = logs
      .map((log) => `<div class="log-entry">${escapeHtml(log)}</div>`)
      .join('');
    return;
  }

  logList.innerHTML = '<div class="log-empty">로그가 없습니다.</div>';
}

function syncSharedConfigInputs(statuses) {
  if (sharedConfigDirty) {
    return;
  }

  const galleryId = statuses.comment?.config?.galleryId
    || statuses.bumpPost?.config?.galleryId
    || statuses.hanRefreshIpBan?.config?.galleryId
    || statuses.conceptMonitor?.config?.galleryId
    || statuses.conceptPatrol?.config?.galleryId
    || statuses.commentMonitor?.config?.galleryId
    || statuses.post?.config?.galleryId
    || statuses.semiPost?.config?.galleryId
    || statuses.ip?.config?.galleryId
    || statuses.trustedCommandDefense?.config?.galleryId
    || statuses.uidWarningAutoBan?.config?.galleryId
    || statuses.monitor?.config?.galleryId
    || 'thesingularity';
  const headtextId = statuses.post?.config?.headtextId
    || statuses.semiPost?.config?.headtextId
    || statuses.ip?.config?.headtextId
    || statuses.trustedCommandDefense?.config?.headtextId
    || 130;

  syncConfigInput(sharedGalleryIdInput, galleryId);
  syncConfigInput(sharedHeadtextIdInput, headtextId);
}

function bindConfigDirtyTracking(feature) {
  getFeatureConfigInputs(feature).forEach((input) => {
    const markDirty = () => {
      DIRTY_FEATURES[feature] = true;
    };
    input.addEventListener('input', markDirty);
    input.addEventListener('change', markDirty);
  });
}

function syncFeatureConfigInputs(feature, pairs) {
  if (DIRTY_FEATURES[feature]) {
    return;
  }

  pairs.forEach(([input, value]) => syncConfigInput(input, value));
}

function getFeatureConfigInputs(feature) {
  const dom = FEATURE_DOM[feature];
  if (!dom) {
    return [];
  }

  if (feature === 'bumpPost') {
    return [
      dom.postNoInput,
      dom.durationMinutesInput,
      dom.intervalMinutesInput,
    ];
  }

  if (feature === 'sinmungoComment') {
    return [
      dom.postNoInput,
      dom.submitModeInput,
      dom.memoInput,
      dom.anonymousNameInput,
      dom.passwordInput,
    ];
  }

  if (feature === 'selfHostedVpn') {
    return [
      dom.agentBaseUrlInput,
      dom.authTokenInput,
      dom.connectionModeInput,
      dom.profileIdInput,
      dom.relayIdInput,
      dom.relayFqdnInput,
      dom.relayIpInput,
      dom.selectedSslPortInput,
      dom.relayUdpPortInput,
      dom.relayHostUniqueKeyInput,
      dom.requestTimeoutMsInput,
      dom.actionTimeoutMsInput,
    ];
  }

  if (feature === 'refluxDatasetCollector') {
    return [
      dom.galleryIdInput,
      dom.startPageInput,
      dom.endPageInput,
      dom.requestDelayMsInput,
      dom.jitterMsInput,
    ];
  }

  if (feature === 'refluxOverlayCollector') {
    return [
      dom.viewUrlInput,
      dom.beforePagesInput,
      dom.afterPagesInput,
      dom.requestDelayMsInput,
      dom.jitterMsInput,
      dom.transportModeInput,
      dom.proxyWorkerCountInput,
    ];
  }

  if (feature === 'commentRefluxCollector') {
    return [
      dom.galleryIdInput,
      dom.startPageInput,
      dom.endPageInput,
      dom.requestDelayMsInput,
      dom.cycleDelayMsInput,
      dom.postConcurrencyInput,
    ];
  }

  if (feature === 'comment') {
    return [
      dom.minPageInput,
      dom.maxPageInput,
      dom.requestDelayInput,
      dom.cycleDelayInput,
      dom.manualTimeLimitMinutesInput,
      dom.refluxSearchGalleryIdInput,
      dom.postConcurrencyInput,
      dom.banOnDeleteInput,
      dom.avoidHourInput,
    ];
  }

  if (feature === 'conceptMonitor') {
    return [
      dom.pollIntervalMsInput,
      dom.snapshotPostLimitInput,
      dom.fluidRatioThresholdInput,
      dom.testModeInput,
      dom.autoCutEnabledInput,
      dom.autoCutPollIntervalMsInput,
      dom.autoCutAttackThresholdInput,
      dom.autoCutAttackConsecutiveCountInput,
      dom.autoCutReleaseThresholdInput,
      dom.autoCutReleaseConsecutiveCountInput,
    ];
  }

  if (feature === 'conceptPatrol') {
    return [
      dom.pollIntervalMsInput,
      dom.patrolPagesInput,
      dom.pageRequestDelayInput,
      dom.fluidRatioThresholdInput,
      dom.candidateThresholdInput,
      dom.holdMsInput,
      dom.testModeInput,
    ];
  }

  if (feature === 'hanRefreshIpBan') {
    return [
      dom.requestDelayInput,
      dom.fallbackMaxPageInput,
    ];
  }

  if (feature === 'commentMonitor') {
    return [
      dom.pollIntervalMsInput,
      dom.pagesInput,
      dom.attackNewCommentThresholdInput,
      dom.attackChangedPostThresholdInput,
      dom.attackAltNewCommentThresholdInput,
      dom.attackAltChangedPostThresholdInput,
      dom.attackConsecutiveCountInput,
      dom.releaseNewCommentThresholdInput,
      dom.releaseVerifiedDeleteThresholdInput,
      dom.releaseConsecutiveCountInput,
    ];
  }

  if (feature === 'trustedCommandDefense') {
    return [
      dom.commandPostUrlInput,
      dom.trustedUsersTextInput,
      dom.commandPrefixInput,
      dom.pollIntervalSecondsInput,
      dom.holdMinutesInput,
    ];
  }

  if (feature === 'post') {
    return [
      dom.minPageInput,
      dom.maxPageInput,
      dom.requestDelayInput,
      dom.cycleDelayInput,
      dom.manualTimeLimitMinutesInput,
      dom.refluxSearchGalleryIdInput,
    ];
  }

  if (feature === 'semiPost') {
    return [
      dom.minPageInput,
      dom.maxPageInput,
      dom.requestDelayInput,
      dom.cycleDelayInput,
      dom.minTotalActivityCountInput,
      dom.minPostRatioPercentInput,
    ];
  }

  if (feature === 'ip') {
    return [
      dom.minPageInput,
      dom.maxPageInput,
      dom.requestDelayInput,
      dom.cycleDelayInput,
      dom.releaseScanMaxPagesInput,
      dom.avoidHourInput,
      dom.includeUidTargetsOnManualStartInput,
    ];
  }

  if (feature === 'monitor') {
    return [
      dom.pollIntervalMsInput,
      dom.pagesInput,
      dom.initialSweepPagesInput,
      dom.attackNewPostThresholdInput,
      dom.attackFluidRatioThresholdInput,
      dom.attackConsecutiveCountInput,
      dom.releaseNewPostThresholdInput,
      dom.releaseFluidRatioThresholdInput,
      dom.releaseConsecutiveCountInput,
    ];
  }

  if (feature === 'uidWarningAutoBan') {
    return [
      dom.immediateTitleRulesValueInput,
    ];
  }

  return [];
}

function getMonitorInitialSweepPagesValue(config = {}) {
  const explicitInitialSweepPages = Number(config?.initialSweepPages);
  if (Number.isFinite(explicitInitialSweepPages) && explicitInitialSweepPages > 0) {
    return explicitInitialSweepPages;
  }

  const monitorPages = Number(config?.monitorPages);
  if (Number.isFinite(monitorPages) && monitorPages > 0) {
    return monitorPages;
  }

  return 2;
}

function parseUidWarningAutoBanImmediateTitleRulesValue(value) {
  let parsed;
  try {
    parsed = JSON.parse(String(value || '[]'));
  } catch (error) {
    parsed = [];
  }

  const normalizedRules = [];
  const seenRuleKeys = new Set();
  for (const rule of Array.isArray(parsed) ? parsed : []) {
    const normalizedRule = normalizeUidWarningAutoBanImmediateTitleRule(rule);
    if (!normalizedRule) {
      continue;
    }

    if (seenRuleKeys.has(normalizedRule.ruleKey)) {
      continue;
    }

    seenRuleKeys.add(normalizedRule.ruleKey);
    normalizedRules.push(normalizedRule);
  }

  return normalizedRules;
}

function buildUidWarningAutoBanImmediateTitleRulesValue(rules = []) {
  return JSON.stringify(parseUidWarningAutoBanImmediateTitleRulesValue(JSON.stringify(rules)));
}

function updateUidWarningAutoBanImmediateTitleRulesEditor(rules = []) {
  const dom = FEATURE_DOM.uidWarningAutoBan;
  const normalizedRules = parseUidWarningAutoBanImmediateTitleRulesValue(JSON.stringify(rules));
  dom.immediateTitleRulesValueInput.value = JSON.stringify(normalizedRules);
  renderUidWarningAutoBanImmediateTitleRuleList(normalizedRules);
  DIRTY_FEATURES.uidWarningAutoBan = true;
}

function renderUidWarningAutoBanImmediateTitleRuleList(rules = []) {
  const dom = FEATURE_DOM.uidWarningAutoBan;
  const normalizedRules = parseUidWarningAutoBanImmediateTitleRulesValue(JSON.stringify(rules));
  if (normalizedRules.length <= 0) {
    dom.immediateTitleRuleList.innerHTML = '<div class="log-empty">등록된 금칙 제목이 없습니다.</div>';
    return;
  }

  dom.immediateTitleRuleList.innerHTML = '';
  for (const rule of normalizedRules) {
    const item = document.createElement('div');
    item.className = 'manual-rule-item';

    const meta = document.createElement('div');
    meta.className = 'manual-rule-meta';

    const rawTitle = document.createElement('span');
    rawTitle.className = 'manual-rule-raw';
    rawTitle.textContent = `${getUidWarningAutoBanImmediateTitleRuleTypeLabel(rule)} ${rule.rawTitle}`;

    const normalizedTitle = document.createElement('span');
    normalizedTitle.className = 'manual-rule-normalized';
    normalizedTitle.textContent = String(rule?.type || '') === 'and'
      ? `정규화: ${(Array.isArray(rule?.normalizedTokens) ? rule.normalizedTokens : []).join(' | ')}`
      : `정규화: ${rule.normalizedTitle}`;

    const removeBtn = document.createElement('button');
    removeBtn.className = 'manual-rule-remove-btn';
    removeBtn.textContent = '삭제';
    removeBtn.addEventListener('click', () => {
      const currentRules = parseUidWarningAutoBanImmediateTitleRulesValue(dom.immediateTitleRulesValueInput.value);
      const nextRules = currentRules.filter((currentRule) => currentRule.ruleKey !== rule.ruleKey);
      updateUidWarningAutoBanImmediateTitleRulesEditor(nextRules);
    });

    meta.appendChild(rawTitle);
    meta.appendChild(normalizedTitle);
    item.appendChild(meta);
    item.appendChild(removeBtn);
    dom.immediateTitleRuleList.appendChild(item);
  }
}

function addUidWarningAutoBanImmediateTitleRule(ruleType = 'contains') {
  const dom = FEATURE_DOM.uidWarningAutoBan;
  const rawTitle = dom.immediateTitleRuleInput.value.trim();
  if (!rawTitle) {
    alert(ruleType === 'and' ? 'AND 키워드를 입력하세요.' : '금칙 제목을 입력하세요.');
    dom.immediateTitleRuleInput.focus();
    return;
  }

  const normalizedRule = normalizeUidWarningAutoBanImmediateTitleRule({
    type: ruleType,
    rawTitle,
  });
  if (!normalizedRule) {
    alert(
      ruleType === 'and'
        ? 'AND 규칙은 쉼표로 구분된 키워드가 정규화 후 2개 이상 남아야 합니다.'
        : '한글/영문 기준으로 남는 제목만 추가할 수 있습니다.',
    );
    dom.immediateTitleRuleInput.focus();
    return;
  }

  const rules = parseUidWarningAutoBanImmediateTitleRulesValue(dom.immediateTitleRulesValueInput.value);
  if (rules.some((rule) => rule.ruleKey === normalizedRule.ruleKey)) {
    alert(ruleType === 'and' ? '이미 등록된 AND 키워드 규칙입니다.' : '이미 등록된 금칙 제목입니다.');
    dom.immediateTitleRuleInput.focus();
    dom.immediateTitleRuleInput.select();
    return;
  }

  updateUidWarningAutoBanImmediateTitleRulesEditor([
    ...rules,
    normalizedRule,
  ]);
  dom.immediateTitleRuleInput.value = '';
  dom.immediateTitleRuleInput.focus();
}

function normalizeUidWarningAutoBanImmediateTitleRule(rule) {
  if (typeof rule === 'string') {
    return normalizeUidWarningAutoBanImmediateContainsTitleRule({ rawTitle: rule });
  }

  if (
    String(rule?.type || '').trim().toLowerCase() === 'and'
    || Array.isArray(rule?.rawTokens)
    || Array.isArray(rule?.normalizedTokens)
  ) {
    return normalizeUidWarningAutoBanImmediateAndTitleRule(rule);
  }

  return normalizeUidWarningAutoBanImmediateContainsTitleRule(rule);
}

function normalizeUidWarningAutoBanImmediateContainsTitleRule(rule = {}) {
  const rawTitle = String(rule?.rawTitle || '').trim();
  if (!rawTitle) {
    return null;
  }

  const normalizedTitle = normalizeUidWarningAutoBanImmediateTitleRuleValue(rawTitle);
  if (!normalizedTitle) {
    return null;
  }

  return {
    type: 'contains',
    rawTitle,
    normalizedTitle,
    ruleKey: buildUidWarningAutoBanImmediateTitleRuleKey({
      type: 'contains',
      normalizedTitle,
    }),
  };
}

function normalizeUidWarningAutoBanImmediateAndTitleRule(rule = {}) {
  const tokenEntries = normalizeUidWarningAutoBanImmediateAndTokenEntries(
    Array.isArray(rule?.rawTokens) && rule.rawTokens.length > 0
      ? rule.rawTokens
      : String(rule?.rawTitle || '').trim(),
  );
  if (tokenEntries.length < 2) {
    return null;
  }

  const rawTokens = tokenEntries.map((entry) => entry.rawToken);
  const normalizedTokens = tokenEntries.map((entry) => entry.normalizedToken);
  const normalizedTitle = normalizedTokens.join('|');

  return {
    type: 'and',
    rawTitle: String(rule?.rawTitle || '').trim() || rawTokens.join(', '),
    rawTokens,
    normalizedTokens,
    normalizedTitle,
    ruleKey: buildUidWarningAutoBanImmediateTitleRuleKey({
      type: 'and',
      normalizedTitle,
    }),
  };
}

function normalizeUidWarningAutoBanImmediateAndTokenEntries(value) {
  const tokenEntries = [];
  const seenNormalizedTokens = new Set();
  const rawTokens = Array.isArray(value) ? value : String(value || '').split(',');

  for (const rawTokenValue of rawTokens) {
    const rawToken = String(rawTokenValue || '').trim();
    if (!rawToken) {
      continue;
    }

    const normalizedToken = normalizeUidWarningAutoBanImmediateTitleRuleValue(rawToken);
    if (!normalizedToken || seenNormalizedTokens.has(normalizedToken)) {
      continue;
    }

    seenNormalizedTokens.add(normalizedToken);
    tokenEntries.push({
      rawToken,
      normalizedToken,
    });
  }

  // popup에서도 AND 규칙 key가 parser와 완전히 동일해야 저장/삭제가 꼬이지 않는다.
  tokenEntries.sort((left, right) => left.normalizedToken.localeCompare(right.normalizedToken, 'ko-KR'));
  return tokenEntries;
}

function buildUidWarningAutoBanImmediateTitleRuleKey(rule = {}) {
  const normalizedType = String(rule?.type || '').trim().toLowerCase() === 'and'
    ? 'and'
    : 'contains';
  const normalizedTitle = String(rule?.normalizedTitle || '').trim();
  if (!normalizedTitle) {
    return '';
  }

  return `${normalizedType}:${normalizedTitle}`;
}

function getUidWarningAutoBanImmediateTitleRuleTypeLabel(rule = {}) {
  return String(rule?.type || '').trim() === 'and' ? '[AND]' : '[포함]';
}

function normalizeUidWarningAutoBanImmediateTitleRuleValue(value) {
  const confusableMap = new Map([
    ['Ꭺ', 'a'],
    ['Α', 'a'],
    ['А', 'a'],
    ['ᗅ', 'a'],
    ['ꓮ', 'a'],
    ['Ꭵ', 'v'],
    ['Ꮩ', 'v'],
    ['Ⅴ', 'v'],
    ['Ѵ', 'v'],
    ['ⴸ', 'v'],
    ['ꓦ', 'v'],
  ]);
  const invisibleCharacterRegex = /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0]/g;

  const normalizedSource = String(value || '')
    .normalize('NFKC')
    .replace(invisibleCharacterRegex, '');
  let folded = '';
  for (const char of normalizedSource) {
    folded += confusableMap.get(char) || char;
  }

  return folded
    .toLowerCase()
    .replace(/[^가-힣a-z]/g, '')
    .trim();
}

function setActiveTab(feature) {
  featureTabs.forEach((button) => {
    button.classList.toggle('is-active', button.dataset.tab === feature);
  });

  featurePanels.forEach((panel) => {
    panel.classList.toggle('is-active', panel.dataset.feature === feature);
  });
}

function normalizeSinmungoCommentPostNoInputValue(value) {
  return String(value || '').trim();
}

function isValidSinmungoCommentPostNo(value) {
  return /^\d+$/.test(String(value || '').trim());
}

function normalizeSinmungoCommentMemoInputValue(value) {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .trim();
}

function normalizeSinmungoCommentPasswordInputValue(value) {
  return String(value || '').trim();
}

function normalizeSinmungoCommentDisplayNameInputValue(value) {
  return String(value || '').trim();
}

function normalizeSinmungoCommentChallengeCodeInputValue(value) {
  return String(value || '').trim();
}

function sendFeatureMessage(feature, message) {
  return sendMessage({
    ...message,
    feature,
  });
}

function sendMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        console.error('[DefenseSuite Popup] 메시지 전송 실패:', chrome.runtime.lastError.message);
        resolve(null);
        return;
      }

      resolve(response);
    });
  });
}

function flashSaved(button, successText = '✅ 저장됨') {
  if (!button) {
    return;
  }

  if (typeof button.__flashSavedOriginalText !== 'string') {
    button.__flashSavedOriginalText = button.textContent;
  }

  if (button.__flashSavedTimer) {
    clearTimeout(button.__flashSavedTimer);
  }

  const originalText = button.__flashSavedOriginalText;
  button.textContent = successText;
  button.__flashSavedTimer = setTimeout(() => {
    button.textContent = originalText;
    button.__flashSavedTimer = null;
  }, 1500);
}

async function copyTextToClipboard(text) {
  const normalizedText = String(text || '');
  if (!normalizedText) {
    return false;
  }

  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(normalizedText);
      return true;
    } catch (error) {
      console.warn('[popup] clipboard write 실패:', error.message);
    }
  }

  const helper = document.createElement('textarea');
  helper.value = normalizedText;
  helper.setAttribute('readonly', 'readonly');
  helper.style.position = 'fixed';
  helper.style.top = '-9999px';
  helper.style.left = '-9999px';
  document.body.appendChild(helper);
  helper.focus();
  helper.select();

  try {
    return document.execCommand('copy');
  } catch (error) {
    console.warn('[popup] execCommand copy 실패:', error.message);
    return false;
  } finally {
    helper.remove();
  }
}

function syncConfigInput(input, nextValue) {
  if (input.type === 'checkbox') {
    const nextChecked = Boolean(nextValue);
    if (input.checked !== nextChecked) {
      input.checked = nextChecked;
    }
    return;
  }

  if (document.activeElement === input) {
    return;
  }

  const normalizedValue = String(nextValue ?? '');
  if (input.value !== normalizedValue) {
    input.value = normalizedValue;
  }
}

function parseOptionalInt(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function clampManualTimeLimitMinutes(value, fallback = 30) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  const rounded = Math.floor(parsed);
  if (rounded < 1 || rounded > 1440) {
    return fallback;
  }

  return rounded;
}

function formatManualTimeLimitStatus(manualTimeLimit = {}) {
  if (!manualTimeLimit?.active) {
    return '-';
  }

  let remainingMs = Number(manualTimeLimit.remainingMs);
  if (!Number.isFinite(remainingMs) && manualTimeLimit.expiresAt) {
    const expiresAtMs = Date.parse(manualTimeLimit.expiresAt);
    remainingMs = Number.isFinite(expiresAtMs) ? expiresAtMs - Date.now() : 0;
  }

  if (remainingMs <= 0) {
    return '곧 종료';
  }

  const remainingMinutes = Math.ceil(remainingMs / 60000);
  if (remainingMinutes >= 60) {
    const hours = Math.floor(remainingMinutes / 60);
    const minutes = remainingMinutes % 60;
    return minutes > 0 ? `${hours}시간 ${minutes}분 남음` : `${hours}시간 남음`;
  }

  return `${remainingMinutes}분 남음`;
}

function shouldBlockManualStartForDirtyConfig(feature, featureLabel) {
  if (!DIRTY_FEATURES[feature]) {
    return false;
  }

  alert(`${featureLabel} 설정을 저장한 뒤 시작하세요. 예: 수동 실행 시간 제한을 30분으로 바꿨다면 먼저 설정 저장을 눌러야 그 값으로 시작됩니다.`);
  return true;
}

const REFLEX_DATASET_COLLECTOR_DB_NAME = 'refluxDatasetCollectorDb';
const REFLEX_DATASET_COLLECTOR_DB_VERSION = 1;
const REFLEX_DATASET_COLLECTOR_TITLES_STORE_NAME = 'titles';
const REFLEX_DATASET_COLLECTOR_RUN_ID_INDEX = 'runId';
const COMMENT_REFLUX_COLLECTOR_DB_NAME = 'commentRefluxCollectorDb';
const COMMENT_REFLUX_COLLECTOR_DB_VERSION = 1;
const COMMENT_REFLUX_COLLECTOR_MEMOS_STORE_NAME = 'memos';
const COMMENT_REFLUX_COLLECTOR_RUN_ID_INDEX = 'runId';
const COMMENT_REFLUX_COLLECTOR_MAX_SHARD_BYTES = 45 * 1024 * 1024;

function openRefluxCollectorDatabaseInPopup() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(REFLEX_DATASET_COLLECTOR_DB_NAME, REFLEX_DATASET_COLLECTOR_DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(REFLEX_DATASET_COLLECTOR_TITLES_STORE_NAME)) {
        const store = db.createObjectStore(REFLEX_DATASET_COLLECTOR_TITLES_STORE_NAME, {
          keyPath: 'key',
        });
        store.createIndex(REFLEX_DATASET_COLLECTOR_RUN_ID_INDEX, 'runId', { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB 열기 실패'));
  });
}

async function loadRefluxCollectorTitlesForRunInPopup(runId) {
  const normalizedRunId = String(runId || '').trim();
  if (!normalizedRunId) {
    return [];
  }

  const db = await openRefluxCollectorDatabaseInPopup();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(REFLEX_DATASET_COLLECTOR_TITLES_STORE_NAME, 'readonly');
      const store = transaction.objectStore(REFLEX_DATASET_COLLECTOR_TITLES_STORE_NAME);
      const index = store.index(REFLEX_DATASET_COLLECTOR_RUN_ID_INDEX);
      const request = index.getAll(normalizedRunId);
      request.onsuccess = () => {
        const titles = (Array.isArray(request.result) ? request.result : [])
          .map((entry) => String(entry?.title || '').trim())
          .filter(Boolean)
          .sort((left, right) => left.localeCompare(right, 'ko-KR'));
        resolve(titles);
      };
      request.onerror = () => reject(request.error || new Error('IndexedDB load 실패'));
    });
  } finally {
    db.close();
  }
}

function buildRefluxCollectorExportPayload({ version, updatedAt, collectedGalleryId, titles }) {
  return {
    _comment: 'JSON은 일반 주석을 지원하지 않아서 안내를 _comment 필드로 남긴다.',
    _comment_update_rule: 'titles를 수정했다면 version도 반드시 같이 올려야 한다. version이 그대로면 기존 관리자 local cache가 유지될 수 있다.',
    _comment_example: '예: 제목을 추가/삭제했다면 version을 2026-04-05-v1 -> 2026-04-06-v2 같이 올린다.',
    _comment_scope: '이 파일은 반도체산업갤, 특이점이온다갤 등 여러 출처를 합친 통합 역류기 dataset으로 써도 된다.',
    version: String(version || '').trim(),
    updatedAt: String(updatedAt || '').trim(),
    sourceGalleryIds: collectedGalleryId ? [String(collectedGalleryId).trim()] : [],
    titles: Array.isArray(titles) ? titles : [],
  };
}

function openCommentRefluxCollectorDatabaseInPopup() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(COMMENT_REFLUX_COLLECTOR_DB_NAME, COMMENT_REFLUX_COLLECTOR_DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(COMMENT_REFLUX_COLLECTOR_MEMOS_STORE_NAME)) {
        const store = db.createObjectStore(COMMENT_REFLUX_COLLECTOR_MEMOS_STORE_NAME, {
          keyPath: 'key',
        });
        store.createIndex(COMMENT_REFLUX_COLLECTOR_RUN_ID_INDEX, 'runId', { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB 열기 실패'));
  });
}

async function iterateCommentCollectorMemosForRunInPopup(runId, visitor) {
  const normalizedRunId = String(runId || '').trim();
  if (!normalizedRunId || typeof visitor !== 'function') {
    return 0;
  }

  const db = await openCommentRefluxCollectorDatabaseInPopup();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(COMMENT_REFLUX_COLLECTOR_MEMOS_STORE_NAME, 'readonly');
      const store = transaction.objectStore(COMMENT_REFLUX_COLLECTOR_MEMOS_STORE_NAME);
      const index = store.index(COMMENT_REFLUX_COLLECTOR_RUN_ID_INDEX);
      const request = index.openCursor(IDBKeyRange.only(normalizedRunId));
      let visitedCount = 0;

      request.onerror = () => reject(request.error || new Error('IndexedDB iterate 실패'));
      request.onsuccess = async () => {
        const cursor = request.result;
        if (!cursor) {
          resolve(visitedCount);
          return;
        }

        try {
          const memo = String(cursor.value?.memo || '').trim();
          if (memo) {
            visitedCount += 1;
            await visitor(memo, visitedCount);
          }
          cursor.continue();
        } catch (error) {
          reject(error);
        }
      };

      transaction.onabort = () => reject(transaction.error || new Error('IndexedDB iterate abort'));
    });
  } finally {
    db.close();
  }
}

async function downloadCommentRefluxCollectorSourceExportInPopup(descriptor = {}) {
  const runId = String(descriptor.runId || '').trim();
  const baseFileStem = String(descriptor.baseFileStem || '').trim();
  const version = String(descriptor.version || '').trim();
  const updatedAt = String(descriptor.updatedAt || '').trim();
  const collectedGalleryId = String(descriptor.collectedGalleryId || '').trim();
  if (!runId || !baseFileStem || !version || !updatedAt || !collectedGalleryId) {
    throw new Error('다운로드 descriptor가 비정상입니다.');
  }

  const shardDefinitions = [];
  let currentShardMemos = [];
  let currentShardBytes = 16;
  let shardCount = 0;
  let totalMemoCount = 0;

  const flushCurrentShard = async () => {
    if (currentShardMemos.length <= 0) {
      return;
    }

    shardCount += 1;
    const fileName = `${baseFileStem}.part${String(shardCount).padStart(2, '0')}.json`;
    const payload = { memos: currentShardMemos };
    await downloadJsonFileInPopup(fileName, payload);
    shardDefinitions.push({
      path: fileName,
      memoCount: currentShardMemos.length,
    });
    currentShardMemos = [];
    currentShardBytes = 16;
    await delayInPopup(50);
  };

  await iterateCommentCollectorMemosForRunInPopup(runId, async (memo) => {
    totalMemoCount += 1;
    const memoBytes = getUtf8ByteLength(JSON.stringify(String(memo || ''))) + 2;
    if (currentShardMemos.length > 0
      && (currentShardBytes + memoBytes) > COMMENT_REFLUX_COLLECTOR_MAX_SHARD_BYTES) {
      await flushCurrentShard();
    }

    currentShardMemos.push(String(memo || ''));
    currentShardBytes += memoBytes;
  });

  await flushCurrentShard();

  if (totalMemoCount <= 0) {
    throw new Error('IndexedDB에 저장된 댓글이 비어 있습니다.');
  }

  const manifest = {
    _comment: '이 파일은 gallery source export manifest다. 최종 runtime dataset이 아니라 merge/build 입력이다.',
    _comment_update_rule: 'source export를 다시 수집했다면 version을 새로 찍는다.',
    version,
    updatedAt,
    sourceGalleryIds: [collectedGalleryId],
    memoCount: totalMemoCount,
    shards: shardDefinitions,
  };
  await downloadJsonFileInPopup(`${baseFileStem}.json`, manifest);
}

async function downloadJsonFileInPopup(fileName, payload) {
  const blob = new Blob(
    [JSON.stringify(payload, null, 2)],
    { type: 'application/json;charset=utf-8' },
  );
  const objectUrl = URL.createObjectURL(blob);

  try {
    if (chrome.downloads?.download) {
      await new Promise((resolve, reject) => {
        chrome.downloads.download(
          {
            url: objectUrl,
            filename: String(fileName || 'dataset.json'),
            saveAs: false,
            conflictAction: 'overwrite',
          },
          (downloadId) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
              return;
            }

            if (!downloadId) {
              reject(new Error('다운로드 시작 실패'));
              return;
            }

            resolve(downloadId);
          },
        );
      });
      return;
    }

    const downloadAnchor = document.createElement('a');
    downloadAnchor.href = objectUrl;
    downloadAnchor.download = String(fileName || 'dataset.json');
    downloadAnchor.click();
  } finally {
    setTimeout(() => URL.revokeObjectURL(objectUrl), 10000);
  }
}

function getUtf8ByteLength(value) {
  return new TextEncoder().encode(String(value || '')).length;
}

function delayInPopup(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function formatAttackModeLabel(value) {
  if (value === 'cjk_narrow') {
    return 'CJK_NARROW';
  }

  if (value === 'semiconductor_reflux') {
    return 'SEMICONDUCTOR_REFLUX';
  }

  if (value === 'page1_no_cutoff') {
    return 'PAGE1_NO_CUTOFF';
  }

  return 'DEFAULT';
}

function clampPercent(value, fallback, min) {
  const parsed = parseOptionalInt(value, fallback);
  return Math.min(100, Math.max(min, parsed));
}

function buildSessionFallbackMetaText(status) {
  if (!status) {
    return '계정 설정을 저장하면 다음 삭제 한도 fallback부터 반영됩니다.';
  }

  const parts = [];

  if (status.lastSwitchAt) {
    parts.push(`마지막 전환: ${formatTimestamp(status.lastSwitchAt)}`);
  }

  if (status.loginHealth?.detail) {
    parts.push(`세션 상태: ${status.loginHealth.detail}`);
  }

  if (status.lastSwitchError) {
    parts.push(`최근 전환 상태: ${status.lastSwitchError}`);
  } else if (status.switchInProgress) {
    parts.push('현재 세션 전환이 진행 중입니다.');
  } else if (status.sessionAutomationInProgress) {
    parts.push('현재 로그인 세션 자동화가 진행 중입니다.');
  } else {
    parts.push('계정 설정을 저장하면 다음 삭제 한도 fallback부터 반영됩니다.');
  }

  return parts.join(' / ');
}

function buildSessionAutomationStateLabel(status) {
  if (status?.sessionAutomationInProgress) {
    const kind = String(status.sessionAutomationKind || '').trim();
    switch (kind) {
      case 'login_health':
        return '🟠 로그인 확인 중';
      case 'manual_switch':
        return '🟠 수동 전환 중';
      case 'delete_limit_switch':
        return '🟠 삭제 한도 전환 중';
      default:
        return '🟠 세션 자동화 진행 중';
    }
  }

  return status?.config?.keepaliveEnabled === true
    ? '🟢 대기'
    : '⚪ 비활성화';
}

function buildSessionFallbackLoginHealthLabel(status) {
  const loginHealth = status?.loginHealth || {};
  switch (loginHealth.status) {
    case 'healthy':
      return '🟢 login 연결 정상';
    case 'checking':
      return '🟡 확인 중';
    case 'retrying':
      return '🟡 자동 재로그인 중';
    case 'manual_attention_required':
    case 'wrong_account_or_no_manager':
    case 'credentials_missing':
      return '🔴 점검 필요';
    case 'disabled':
      return '⚪ 비활성화';
    default:
      return '🟡 확인 전';
  }
}

function getSessionFallbackLoginHealthClassName(status) {
  const loginHealth = status?.loginHealth || {};
  switch (loginHealth.status) {
    case 'healthy':
      return 'status-on';
    case 'disabled':
      return '';
    case 'checking':
    case 'retrying':
      return 'status-warn';
    default:
      return 'status-off';
  }
}

function setDisabled(node, disabled) {
  if (!node) {
    return;
  }

  node.disabled = Boolean(disabled);
}

function getMonitorStatusLabel(status) {
  if (!status?.isRunning) {
    return '🔴 정지';
  }

  if (status.phase === 'ATTACKING') {
    return '🟢 공격 대응 중';
  }

  if (status.phase === 'RECOVERING') {
    return '🟠 자동 정리 중';
  }

  if (status.phase === 'SEEDING') {
    return '🟡 기준 수집 중';
  }

  return '🔵 감시 중';
}

function getMonitorStatusClassName(status) {
  if (!status?.isRunning) {
    return 'status-off';
  }

  if (status.phase === 'ATTACKING') {
    return 'status-on';
  }

  if (status.phase === 'RECOVERING' || status.phase === 'SEEDING') {
    return 'status-warn';
  }

  return 'status-on';
}

function getConceptMonitorStatusLabel(status) {
  if (!status?.isRunning) {
    return '🔴 정지';
  }

  return status.config?.testMode === false ? '🟠 실행 중' : '🟡 테스트 중';
}

function getConceptMonitorStatusClassName(status) {
  if (!status?.isRunning) {
    return 'status-off';
  }

  return status.config?.testMode === false ? 'status-warn' : 'status-on';
}

function getConceptPatrolStatusLabel(status) {
  if (!status?.isRunning) {
    return '🔴 정지';
  }

  if (Number(status.blockedUntilTs) > Date.now()) {
    return '🧊 쿨다운 중';
  }

  return status.config?.testMode === false ? '🟠 실행 중' : '🟡 테스트 중';
}

function getConceptPatrolStatusClassName(status) {
  if (!status?.isRunning) {
    return 'status-off';
  }

  if (Number(status.blockedUntilTs) > Date.now()) {
    return 'status-warn';
  }

  return status.config?.testMode === false ? 'status-warn' : 'status-on';
}

function updateConceptPatrolHoldStateText(node, isActive) {
  const active = Boolean(isActive);
  node.textContent = active ? 'HOLD' : 'NORMAL';
  node.className = `status-value ${active ? 'status-warn' : 'status-on'}`;
}

function getHanRefreshIpBanStatusLabel(status) {
  if (!status?.isRunning) {
    return '🔴 정지';
  }

  if (status.phase === 'WAITING') {
    return '🟡 대기 중';
  }

  return '🟢 실행 중';
}

function getHanRefreshIpBanStatusClassName(status) {
  if (!status?.isRunning) {
    return 'status-off';
  }

  if (status.phase === 'WAITING') {
    return 'status-warn';
  }

  return 'status-on';
}

function updateConceptAutoCutStateText(node, state) {
  const normalizedState = state === 'DEFENDING' ? 'DEFENDING' : 'NORMAL';
  node.textContent = normalizedState;
  node.className = `status-value ${normalizedState === 'DEFENDING' ? 'status-warn' : 'status-on'}`;
}

function getCommentMonitorStatusLabel(status) {
  if (!status?.isRunning) {
    return '🔴 정지';
  }

  if (status.phase === 'ATTACKING') {
    return '🟢 댓글 대응 중';
  }

  if (status.phase === 'RECOVERING') {
    return '🟠 자동 정리 중';
  }

  if (status.phase === 'SEEDING') {
    return '🟡 기준 수집 중';
  }

  return '🔵 감시 중';
}

function getCommentMonitorStatusClassName(status) {
  if (!status?.isRunning) {
    return 'status-off';
  }

  if (status.phase === 'ATTACKING') {
    return 'status-on';
  }

  if (status.phase === 'RECOVERING' || status.phase === 'SEEDING') {
    return 'status-warn';
  }

  return 'status-on';
}

function getTrustedCommandDefenseStatusLabel(status) {
  if (!status?.isRunning) {
    return '🔴 정지';
  }

  if (status.phase === 'SEEDING') {
    return '🟡 seed 중';
  }

  if (status.phase === 'EXECUTING_POST_DEFENSE') {
    return '🟠 게시물방어 실행 중';
  }

  if (status.phase === 'EXECUTING_COMMENT_DEFENSE') {
    return '🟠 댓글방어 실행 중';
  }

  return '🟢 감시 중';
}

function getTrustedCommandDefenseStatusClassName(status) {
  if (!status?.isRunning) {
    return 'status-off';
  }

  if (['SEEDING', 'EXECUTING_POST_DEFENSE', 'EXECUTING_COMMENT_DEFENSE'].includes(String(status?.phase || ''))) {
    return 'status-warn';
  }

  return 'status-on';
}

function formatTrustedCommandTypeLabel(value) {
  if (value === 'post_defense') {
    return '게시물방어';
  }

  if (value === 'comment_defense') {
    return '댓글방어';
  }

  return '-';
}

function formatTrustedHoldUntil(untilTs) {
  const numericUntilTs = Number(untilTs) || 0;
  if (numericUntilTs <= Date.now()) {
    return '-';
  }

  return formatTimestamp(new Date(numericUntilTs).toISOString());
}

function buildTrustedCommandPostLabel(status = {}) {
  const galleryId = String(status?.config?.commandGalleryId || status?.config?.galleryId || '').trim();
  const postNo = String(status?.config?.commandPostNo || '').trim();
  if (!galleryId || !postNo) {
    return '-';
  }

  return `${galleryId} #${postNo}`;
}

function buildTrustedCommandDefenseMetaText(status = {}) {
  const parts = [];
  const postActive = Number(status?.postDefenseUntilTs) > Date.now();
  const commentActive = Number(status?.commentDefenseUntilTs) > Date.now();

  if (postActive) {
    parts.push(`게시물방어 유지: ${formatTrustedHoldUntil(status.postDefenseUntilTs)}`);
  }

  if (commentActive) {
    parts.push(`댓글방어 유지: ${formatTrustedHoldUntil(status.commentDefenseUntilTs)}`);
  }

  if (status?.lastCommandAt) {
    parts.push(`최근 명령: ${formatTimestamp(status.lastCommandAt)} / ${formatTrustedCommandTypeLabel(status.lastCommandType)}`);
  }

  if (parts.length <= 0) {
    return '관리용 글 댓글을 20초마다 확인합니다. `@특갤봇 게시물방어` 또는 `@특갤봇 댓글방어`를 쓰면 되고, 신뢰 user_id가 쓴 댓글만 처리합니다.';
  }

  return parts.join(' / ');
}

function formatPercent(value) {
  return Number(value || 0).toFixed(1);
}

function formatTimestamp(value) {
  if (!value) {
    return '-';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '-';
  }

  return date.toLocaleTimeString('ko-KR', { hour12: false });
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
