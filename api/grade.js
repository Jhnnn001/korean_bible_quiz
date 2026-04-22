// api/grade.js
// Vercel Serverless Function - Subjective Answer Grader
//
// ⭐ 최적화 (2026-04): 채점은 가벼운 판단 작업이므로 Flash-Lite를 기본으로 사용.
// 문제 생성(Flash, 일일 250회)과 채점(Flash-Lite, 일일 1000회)이
// 서로 다른 쿼터 풀을 쓰게 되어 전체 용량이 3~4배 증가합니다.

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// ⭐ primary를 flash-lite로 변경 (기존에는 flash였음)
const MODEL_MAP = {
  primary: 'gemini-2.5-flash-lite',   // 1순위 — 일일 1000회, 별도 쿼터
  lite: 'gemini-2.5-flash'             // 폴백 — lite 모델 혼잡 시 Flash로 대체
};

const rateLimits = new Map();
const RL_WINDOW_MS = 60 * 1000;
const RL_MAX = 60;

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = rateLimits.get(ip) || { count: 0, windowStart: now };
  if (now - entry.windowStart > RL_WINDOW_MS) { entry.count = 0; entry.windowStart = now; }
  entry.count++;
  rateLimits.set(ip, entry);
  if (rateLimits.size > 1000) {
    for (const [k, v] of rateLimits) {
      if (now - v.windowStart > RL_WINDOW_MS * 5) rateLimits.delete(k);
    }
  }
  return entry.count <= RL_MAX;
}

function getClientIp(req) {
  return (
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.headers['x-real-ip'] ||
    req.socket?.remoteAddress || 'unknown'
  );
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function callGemini(model, prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 512, responseMimeType: 'application/json' }
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (res.ok) {
      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) { const e = new Error('빈 응답'); e.code = 'EMPTY_RESPONSE'; throw e; }
      return text;
    }
    if (res.status === 429) { const e = new Error('할당량 초과'); e.code = 'QUOTA_EXCEEDED'; throw e; }
    if (res.status === 503) {
      if (attempt === 0) { await sleep(800); continue; }
      const e = new Error('서버 포화'); e.code = 'SERVER_BUSY'; throw e;
    }
    const errText = await res.text();
    const e = new Error(`Gemini API (${res.status}): ${errText.substring(0, 150)}`);
    e.code = 'API_ERROR';
    throw e;
  }
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ code: 'METHOD', error: 'POST only' });
  if (!GEMINI_API_KEY) return res.status(500).json({ code: 'CONFIG', error: 'GEMINI_API_KEY 없음' });

  const ip = getClientIp(req);
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ code: 'RATE_LIMIT', error: '채점 요청이 너무 많습니다.' });
  }

  try {
    const { question, correctAnswer, userAnswer, reference, modelTier } = req.body || {};
    if (!question || !correctAnswer || userAnswer === undefined) {
      return res.status(400).json({ code: 'BAD_INPUT', error: '필수 파라미터 누락' });
    }

    if (!String(userAnswer).trim()) {
      return res.status(200).json({ correct: false, feedback: '답을 입력하지 않았습니다.' });
    }

    const normalize = s => String(s).replace(/\s+/g, '').toLowerCase();
    if (normalize(userAnswer) === normalize(correctAnswer)) {
      return res.status(200).json({ correct: true, feedback: '정확히 일치합니다.' });
    }

    const prompt = `당신은 한국어 성경 퀴즈 채점자입니다. 사용자의 답이 정답과 의미상 일치하는지 관대하게 판단해 주세요.

[질문]: ${question}
[기준 정답]: ${correctAnswer}
[사용자 답]: ${userAnswer}
${reference ? `[성경 참조]: ${reference}` : ''}

[채점 기준 — 정답 인정]:
- 핵심 의미가 일치 (표현 방식 달라도 됨)
- 오타, 맞춤법 오류
- 동의어 (예: "도륙" vs "죽임", "유하다" vs "머물다")
- 정답의 핵심 키워드를 포함하는 더 긴 설명
- 사건을 다른 말로 설명했지만 본질이 같음

[오답 기준]:
- 핵심 내용이 다르거나 누락
- 완전히 다른 사건이나 인물을 언급

[응답 형식 — 순수 JSON]:
{"correct": true | false, "feedback": "간결하게 한 문장"}`;

    const model = MODEL_MAP[modelTier] || MODEL_MAP.primary;

    let rawText;
    try {
      rawText = await callGemini(model, prompt);
    } catch (err) {
      if (err.code === 'SERVER_BUSY') {
        return res.status(503).json({ code: 'SERVER_BUSY', error: '채점 서버가 일시 포화 상태' });
      }
      if (err.code === 'QUOTA_EXCEEDED') {
        return res.status(429).json({ code: 'QUOTA_EXCEEDED', error: '일일 할당량 도달' });
      }
      const u = normalize(userAnswer);
      const c = normalize(correctAnswer);
      const fallbackCorrect = !!(u && c && (u.includes(c) || c.includes(u)));
      return res.status(200).json({
        correct: fallbackCorrect,
        feedback: '(AI 채점 불가 — 단순 매칭 판정)'
      });
    }

    let result;
    try {
      result = JSON.parse(rawText);
    } catch (e) {
      const match = rawText.match(/\{[\s\S]*\}/);
      if (match) result = JSON.parse(match[0]);
      else throw new Error('채점 응답 파싱 실패');
    }

    return res.status(200).json({
      correct: !!result.correct,
      feedback: String(result.feedback || '').substring(0, 200)
    });

  } catch (err) {
    console.error('Grade error:', err);
    return res.status(500).json({ code: 'INTERNAL', error: err.message });
  }
}