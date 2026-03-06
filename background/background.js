/**
 * DC Comment Protect - Background Service Worker
 * 
 * Chrome Extension의 메인 진입점입니다.
 * 스케줄러를 관리하고, popup과의 메시지 통신을 담당합니다.
 */

import { Scheduler } from './scheduler.js';

// ============================================================
// 스케줄러 인스턴스
// ============================================================
const scheduler = new Scheduler();

void initializeScheduler();

// ============================================================
// Service Worker 생명주기
// ============================================================

// 확장 프로그램 설치/업데이트 시
chrome.runtime.onInstalled.addListener(async () => {
    console.log('[Background] DC Comment Protect 설치됨');
    await scheduler.loadState();
    scheduler.ensureRunLoop();
});

// Service Worker 활성화 시 (재시작 후)
self.addEventListener('activate', async () => {
    console.log('[Background] Service Worker 활성화');
    await scheduler.resumeIfNeeded();
});

chrome.runtime.onStartup.addListener(async () => {
    console.log('[Background] 브라우저 시작');
    await scheduler.resumeIfNeeded();
});

// ============================================================
// Service Worker 활성 유지 (Manifest V3)
// ============================================================

// 30초마다 알람으로 Service Worker가 죽지 않도록 유지
chrome.alarms.create('keepAlive', { periodInMinutes: 0.5 });

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== 'keepAlive') return;

    scheduler.resumeIfNeeded().catch((error) => {
        console.error('[Background] keepAlive 복원 실패:', error);
    });
});

// ============================================================
// 메시지 핸들러 (popup ↔ background 통신)
// ============================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    handleMessage(message)
        .then(sendResponse)
        .catch((error) => {
            console.error('[Background] 메시지 처리 실패:', error);
            sendResponse({ success: false, message: error.message });
        });
    return true; // 비동기 응답을 위해 true 반환
});

async function initializeScheduler() {
    await scheduler.resumeIfNeeded();
}

async function handleMessage(message) {
    switch (message.action) {
        // 토글 시작
        case 'start':
            await scheduler.start();
            return { success: true, status: scheduler.getStatus() };

        // 토글 중지
        case 'stop':
            await scheduler.stop();
            return { success: true, status: scheduler.getStatus() };

        // 현재 상태 조회
        case 'getStatus':
            return { success: true, status: scheduler.getStatus() };

        // 설정 업데이트
        case 'updateConfig':
            if (message.config) {
                scheduler.config = { ...scheduler.config, ...message.config };
                await scheduler.saveState();
            }
            return { success: true, config: scheduler.config };

        // 통계 초기화
        case 'resetStats':
            scheduler.totalDeleted = 0;
            scheduler.cycleCount = 0;
            scheduler.logs = [];
            await scheduler.saveState();
            return { success: true, status: scheduler.getStatus() };

        default:
            return { success: false, message: `알 수 없는 action: ${message.action}` };
    }
}
