# 🛡️ DC Comment Protect

디시인사이드 갤러리에서 유동닉(비로그인 IP) 댓글을 자동으로 삭제하는 Chrome Extension입니다.

## 📋 요구사항

- Chrome 브라우저 (Manifest V3 지원)
- 디시인사이드 부매니저/매니저 권한
- 디시인사이드 로그인 상태

## 🚀 설치 방법

1. 이 프로젝트를 다운로드/클론
2. Chrome에서 `chrome://extensions/` 열기
3. 우측 상단 **개발자 모드** 활성화
4. **압축 해제된 확장 프로그램을 로드합니다** 클릭
5. 이 프로젝트 폴더 선택

## 📖 사용법

1. 디시인사이드에 부매니저 계정으로 **로그인**
2. Chrome 툴바에서 🛡️ 아이콘 클릭
3. **토글 ON** → 자동 삭제 시작
4. **토글 OFF** → 자동 삭제 중지

## ⚙️ 설정

| 설정 | 기본값 | 설명 |
|------|--------|------|
| 순회 페이지 | 5 | 1~N 페이지까지 순회 |
| 요청 딜레이 | 500ms | API 요청 간 대기 시간 |
| 사이클 딜레이 | 5000ms | 전체 순회 후 대기 시간 |

## ⚠️ 주의사항

- 반드시 **부매니저/매니저 권한**이 있는 계정으로 로그인해야 합니다
- 너무 짧은 딜레이는 계정 차단의 원인이 될 수 있습니다
- 이 도구는 갤러리 관리 목적으로만 사용하세요

## 📁 프로젝트 구조

```
dc_comment_protect/
├── manifest.json           # Chrome Extension 설정
├── popup/                  # 팝업 UI
│   ├── popup.html
│   ├── popup.css
│   └── popup.js
├── background/             # 핵심 로직
│   ├── background.js       # Service Worker (진입점)
│   ├── api.js              # 디시인사이드 API 호출
│   ├── parser.js           # 유동닉 필터링
│   └── scheduler.js        # 순회 스케줄러
├── icons/                  # 아이콘
└── docs/                   # 문서
    ├── SPEC.md             # API 스펙
    ├── ARCHITECTURE.md     # 아키텍처
    └── APPROACH_COMPARISON.md
```
