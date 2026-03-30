---
description: 별도 worktree에서 독립 브랜치 작업 후 main에 병합하는 워크플로우
---

# Isolated Worktree Task (IWT)

main 브랜치를 건드리지 않고 별도 폴더에서 독립 작업한다.

## 워크플로우

// turbo-all

1. 현재 브랜치 확인
```bash
git -C /home/eorb915/projects/dc_defense_suite branch --show-current
```

2. worktree 생성 (task-slug는 작업 내용에 맞게 변경)
```bash
bash /home/eorb915/.codex/skills/isolated-worktree-task/scripts/create_isolated_worktree.sh /home/eorb915/projects/dc_defense_suite <task-slug>
```

3. 생성된 worktree 경로에서 작업 수행
- 모든 파일 수정은 worktree 경로에서만
- main 폴더(`/home/eorb915/projects/dc_defense_suite`)는 절대 건드리지 않음

4. 작업 완료 후 커밋
```bash
git -C <worktree-path> add -A
git -C <worktree-path> commit -m "<커밋 메시지>"
```

5. 사용자에게 보고
- worktree 경로
- 브랜치 이름
- 커밋 해시
- cherry-pick 가능 여부

6. 사용자 승인 후 main에 병합
```bash
git -C /home/eorb915/projects/dc_defense_suite cherry-pick <commit-hash>
git -C /home/eorb915/projects/dc_defense_suite push
```

7. 정리
```bash
bash /home/eorb915/.codex/skills/isolated-worktree-task/scripts/remove_isolated_worktree.sh /home/eorb915/projects/dc_defense_suite <worktree-path> <branch-name>
```

## 규칙

- main 폴더에서 브랜치 변경 금지
- 작업은 반드시 worktree 경로에서만
- merge/push는 사용자 승인 후에만
- 한 태스크당 하나의 worktree
