// api/generate.js
// Bible Quiz Question Generator with retry + model fallback + error classification

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MODEL_PRIMARY = 'gemini-2.5-flash';
const MODEL_FALLBACK = 'gemini-2.5-flash-lite';

const KO_BIBLE_URL = 'https://raw.githubusercontent.com/thiagobodruk/bible/master/json/ko_ko.json';
const EN_BIBLE_URL = 'https://raw.githubusercontent.com/thiagobodruk/bible/master/json/en_kjv.json';

let bibleCache = null;
async function loadBible() {
  if (bibleCache) return bibleCache;
  const [koRes, enRes] = await Promise.all([fetch(KO_BIBLE_URL), fetch(EN_BIBLE_URL)]);
  if (!koRes.ok || !enRes.ok) throw new Error('성경 데이터 로드 실패');
  const ko = JSON.parse((await koRes.text()).replace(/^\uFEFF/, ''));
  const en = JSON.parse((await enRes.text()).replace(/^\uFEFF/, ''));
  bibleCache = { ko, en };
  return bibleCache;
}

const rateLimits = new Map();
function checkRateLimit(ip) {
  const now = Date.now();
  const entry = rateLimits.get(ip) || { count: 0, windowStart: now };
  if (now - entry.windowStart > 60000) {
    entry.count = 0;
    entry.windowStart = now;
  }
  entry.count++;
  rateLimits.set(ip, entry);
  if (rateLimits.size > 1000) {
    for (const [k, v] of rateLimits) {
      if (now - v.windowStart > 300000) rateLimits.delete(k);
    }
  }
  return entry.count <= 3;
}

function getClientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim()
      || req.headers['x-real-ip']
      || req.socket?.remoteAddress
      || 'unknown';
}

function buildContext(book, lang) {
  const label = lang === 'ko' ? '장' : 'Chapter';
  const parts = [];
  book.chapters.forEach((chapter, chIdx) => {
    parts.push(`\n[${label} ${chIdx + 1}]`);
    chapter.forEach((verse, vIdx) => {
      parts.push(`${chIdx + 1}:${vIdx + 1} ${verse}`);
    });
  });
  return parts.join('\n');
}

function capContext(text, maxChars) {
  return text.length <= maxChars ? text : text.slice(0, maxChars) + '\n\n[... 생략 ...]';
}

function buildPrompt({ bookKo, bookEn, difficulty, count, mcCount, saCount, koText, enText }) {
  const dg = {
    '하': 'Easy — 인물 이름, 지명, 숫자, 기본 사건 등 본문에 직접 등장하는 사실을 묻는 문제',
    '중': 'Medium — 사건의 순서, 구체적인 세부 내용, 대화 인용, 원인과 결과를 묻는 문제',
    '상': 'Hard — 주제, 신학적 의미, 본문의 맥락과 적용, 다른 본문과의 연결을 묻는 깊이 있는 문제'
  };
  return `당신은 한국어 성경 퀴즈 출제자입니다. 정답은 반드시 한국어(개역한글) 본문을 기준으로 하며, 영어(KJV) 본문은 문맥 이해 보조용입니다.

[성경]: ${bookKo} (${bookEn})
[난이도]: ${difficulty} — ${dg[difficulty]}
[총 문제 수]: ${count}개 (객관식 ${mcCount}개, 주관식 ${saCount}개)

[한국어 본문 — 이게 정답 기준]
${koText}

[영어 본문 — 참고용]
${enText}

[출제 지침]
1. 모든 문제와 선택지, 정답은 **한국어**로 작성
2. question_en은 같은 질문의 영어 번역 (문맥 이해용 힌트)
3. 객관식 4개 선택지는 비슷한 카테고리/길이로 혼동되게 만들되 정답은 명확해야 함
4. 주관식 정답은 단어/구/문장 모두 허용
5. 난이도에 맞게 문제의 깊이를 조절
6. 반드시 위 본문에 근거한 내용만 출제 (추측 금지)
7. 각 문제에 성경 장:절 reference 포함

[응답 형식 — 순수 JSON 배열만, 마크다운 없이]
[
  {"type":"mc","question_ko":"...","question_en":"...","options":["A","B","C","D"],"answer":0,"explanation_ko":"...","reference":"삼하 2:11"},
  {"type":"sa","question_ko":"...","question_en":"...","answer":"정답","explanation_ko":"...","reference":"삼하 5:23"}
]

이제 ${count}개의 문제를 type="mc" ${mcCount}개 + type="sa" ${saCount}개 섞어서 배열로 반환하세요.`;
}

function classifyError(httpStatus, errorData) {
  const apiStatus = errorData?.error?.status || '';
  const msg = (errorData?.error?.message || '').toLowerCase();
  if (httpStatus === 429 || apiStatus === 'RESOURCE_EXHAUSTED') {
    if (msg.includes('quota') || msg.includes('daily') || msg.includes('exhausted') || msg.includes('per day')) {
      return { code: 'QUOTA_EXCEEDED', retryable: false };
    }
    return { code: 'RATE_LIMIT', retryable: true };
  }
  if (httpStatus === 503 || apiStatus === 'UNAVAILABLE') {
    return { code: 'SERVICE_UNAVAILABLE', retryable: true };
  }
  if (httpStatus >= 500 && httpStatus < 600) {
    return { code: 'SERVER_ERROR', retryable: true };
  }
  return { code: 'API_ERROR', retryable: false };
}

async function callGemini(prompt, model) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.8,
        topP: 0.95,
        maxOutputTokens: 16384,
        responseMimeType: 'application/json'
      }
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    let errData = null;
    try { errData = JSON.parse(errText); } catch {}
    const c = classifyError(res.status, errData);
    const err = new Error(errData?.error?.message || `Gemini HTTP ${res.status}`);
    err.code = c.code;
    err.retryable = c.retryable;
    throw err;
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    const err = new Error(`Gemini 응답 비어있음`);
    err.code = 'EMPTY_RESPONSE';
    err.retryable = true;
    throw err;
  }
  return text;
}

async function callGeminiWithRetry(prompt) {
  const attempts = [
    { model: MODEL_PRIMARY,  delayMs: 0 },
    { model: MODEL_FALLBACK, delayMs: 600 }
  ];
  let lastError = null;
  for (let i = 0; i < attempts.length; i++) {
    const { model, delayMs } = attempts[i];
    if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
    try {
      console.log(`[attempt ${i+1}] ${model}`);
      return await callGemini(prompt, model);
    } catch (err) {
      console.log(`[attempt ${i+1}] failed: ${err.code}`);
      lastError = err;
      if (err.code === 'QUOTA_EXCEEDED') throw err;
      if (!err.retryable) throw err;
    }
  }
  throw lastError;
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  if (!GEMINI_API_KEY) {
    return res.status(500).json({ error: '서버 설정 오류: GEMINI_API_KEY 없음', errorCode: 'NO_API_KEY' });
  }

  const ip = getClientIp(req);
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: '너무 많은 요청입니다. 1분 후 다시 시도해 주세요.', errorCode: 'CLIENT_RATE_LIMIT' });
  }

  try {
    const { bookIndex, bookKo, bookEn, difficulty, count, mcRatio } = req.body || {};
    if (typeof bookIndex !== 'number' || bookIndex < 0 || bookIndex > 65) {
      return res.status(400).json({ error: '잘못된 책 인덱스', errorCode: 'INVALID_INPUT' });
    }
    if (!['하', '중', '상'].includes(difficulty)) {
      return res.status(400).json({ error: '잘못된 난이도', errorCode: 'INVALID_INPUT' });
    }
    const n = parseInt(count);
    if (isNaN(n) || n < 3 || n > 50) {
      return res.status(400).json({ error: '문제 수는 3~50 사이여야 합니다.', errorCode: 'INVALID_INPUT' });
    }
    const ratio = parseInt(mcRatio);
    if (isNaN(ratio) || ratio < 0 || ratio > 100) {
      return res.status(400).json({ error: '잘못된 비율', errorCode: 'INVALID_INPUT' });
    }

    const mcCount = Math.round(n * ratio / 100);
    const saCount = n - mcCount;

    const { ko, en } = await loadBible();
    const koBook = ko[bookIndex];
    const enBook = en[bookIndex];
    if (!koBook || !enBook) {
      return res.status(500).json({ error: '성경 데이터를 찾을 수 없습니다.', errorCode: 'BIBLE_LOAD' });
    }

    const koText = capContext(buildContext(koBook, 'ko'), 200000);
    const enText = capContext(buildContext(enBook, 'en'), 200000);

    const prompt = buildPrompt({
      bookKo: bookKo || koBook.book,
      bookEn: bookEn || enBook.book,
      difficulty, count: n, mcCount, saCount, koText, enText
    });

    const rawText = await callGeminiWithRetry(prompt);

    let questions;
    try { questions = JSON.parse(rawText); }
    catch (e) {
      const match = rawText.match(/\[[\s\S]*\]/);
      if (match) questions = JSON.parse(match[0]);
      else throw new Error('AI 응답을 JSON으로 파싱할 수 없습니다.');
    }

    if (!Array.isArray(questions) || questions.length === 0) {
      throw new Error('AI가 유효한 문제를 생성하지 못했습니다.');
    }

    questions = questions
      .filter(q => q && q.question_ko && (q.type === 'mc' || q.type === 'sa'))
      .map(q => {
        if (q.type === 'mc') {
          if (!Array.isArray(q.options) || q.options.length !== 4) return null;
          const ans = typeof q.answer === 'number' ? q.answer : parseInt(q.answer);
          if (isNaN(ans) || ans < 0 || ans > 3) return null;
          q.answer = ans;
        } else {
          if (!q.answer || typeof q.answer !== 'string') return null;
        }
        return q;
      })
      .filter(Boolean);

    if (questions.length === 0) {
      throw new Error('생성된 문제가 유효하지 않습니다.');
    }

    return res.status(200).json({ questions });

  } catch (err) {
    console.error('Generate error:', err.code, err.message);

    if (err.code === 'QUOTA_EXCEEDED') {
      return res.status(429).json({
        error: '일일 할당량이 도달했습니다. 다른 날에 도전해주세요.',
        errorCode: 'QUOTA_EXCEEDED'
      });
    }
    if (['SERVICE_UNAVAILABLE', 'RATE_LIMIT', 'SERVER_ERROR', 'EMPTY_RESPONSE'].includes(err.code)) {
      return res.status(503).json({
        error: '서버 사용량이 붐빕니다. 조금 뒤에 사용해주세요.',
        errorCode: 'SERVICE_UNAVAILABLE'
      });
    }
    return res.status(500).json({ error: err.message || '알 수 없는 오류', errorCode: err.code || 'UNKNOWN' });
  }
}
