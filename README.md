# 🔔 바이블 골든벨

AI가 성경 본문을 읽고 즉석에서 퀴즈를 출제하는 한국어 성경 퀴즈 웹앱.

[🌐 **바로 플레이 →**](https://korean-bible-quiz.vercel.app/)

---

## 사용법

1. 링크 접속
2. 성경 선택 (66권 중 하나)
3. 난이도(하/중/상), 문제 수, 객관식 비율 설정
4. **"퀴즈 시작"** 클릭
5. 한 문제씩 풀고 즉시 정답 확인
6. 끝나면 점수와 전체 복기 화면

한국어 기준으로 출제·채점되고, 영어 본문은 이해 보조용으로 함께 표시됩니다. 주관식은 AI가 오타·동의어·의미 유사도로 판정합니다.

---

## 프로젝트 구조

```
bible-quiz/
├── index.html          # 프론트엔드 (UI + 클라이언트 로직)
├── api/
│   ├── generate.js    # 문제 생성 (Gemini 호출)
│   └── grade.js       # 주관식 채점 (Gemini 호출)
├── vercel.json         # 서버리스 함수 타임아웃 설정
└── package.json
```

---

## 직접 배포하려면

1. [Google AI Studio](https://aistudio.google.com)에서 Gemini API 키 발급 (무료)
2. 이 레포 Fork
3. [Vercel](https://vercel.com)에서 Import → 환경변수 `GEMINI_API_KEY` 추가 → Deploy

---

## 기술 스택

Vanilla HTML/CSS/JS · Vercel Serverless · Google Gemini 2.5 Flash · 개역한글(CC BY-NC) + KJV(Public Domain)

## 라이선스

코드는 MIT. 성경 데이터는 각 출처 라이선스를 따릅니다.
