// 문장 재조립 — parse(cues)와 translate/render 사이에 끼는 레이어.
//
// 근본 문제: YouTube ASR이 단어/구 중간에서 cue를 토막낸다(예: "amazing social currency"가
// "...amazing social" / "currency" 두 cue로). cue 단위로 번역하면 토막만 보고 번역해 문맥 손실
// (currency 누락 등). Immersive Translate처럼 인접 cue를 한 문장으로 묶어 번역·표시하면 온전한
// 문맥을 본다. 이 함수가 그 묶음(Sentence)을 만든다.
//
// 병합 기준 — 다중 신호 + fallback (ASR이 문장부호를 주든 안 주든 동작하도록 방어적):
//   1) 문장부호: cur cue가 .?!… 등으로 끝나면 거기서 끊는다(가장 신뢰도 높은 신호).
//   2) 긴 침묵: 다음 cue와의 간격이 GAP_THRESHOLD 이상이면 절/문장 경계로 보고 끊는다.
//      (parseJson3가 겹친 cue를 clip해 contiguous하게 만들므로 gap>0은 실제 무음 구간을 의미.)
//   3) 길이 캡: 부호 없는 ASR이 영상 전체를 한 문장으로 묶지 않도록 글자/ cue 수 상한에서 끊는다.
//
// 임계값은 "튜닝 노브" — Immersive와 나란히 띄워 실제 영상으로 조정 대상.

import type { Cue, Sentence, Word } from './types';

// cur cue가 문장 끝으로 보이는지 — 종결 부호 뒤에 닫는 따옴표/괄호가 붙어도 인정.
// 마침표가 약어(U.S., Mr.)일 수 있으나 그런 오분할은 다음 문장이 짧게 시작될 뿐 치명적이지 않고,
// 번역 측 청크 문맥(인접 문장을 함께 읽음)이 보완한다. 쉼표/콜론은 경계로 보지 않음(문장 중간).
const SENTENCE_FINAL = /[.?!…。！？]["'”’)\]]*$/;

// 다음 cue 시작까지의 무음이 이 이상이면 경계로 본다(초). 작을수록 잘게 끊김.
const GAP_THRESHOLD_SEC = 0.8;
// 한 문장 최대 글자 수 — 부호 없는 ASR에서 runaway 병합 방지.
const MAX_CHARS = 200;
// 한 문장 최대 cue 수 — 글자 수와 별개 안전망(짧은 cue가 잔뜩일 때).
const MAX_CUES = 12;

function endsSentence(text: string): boolean {
  return SENTENCE_FINAL.test(text.trim());
}

function makeSentence(cues: Cue[], a: number, b: number): Sentence {
  const text = cues
    .slice(a, b + 1)
    .map((c) => c.text)
    .join(' ');

  // 구성 cue가 모두 word 타이밍을 가지면 이어붙여 문장 전체 word-reveal에 쓴다.
  // 하나라도 없으면(보간 실패 등) 전체를 undefined로 — 렌더러가 텍스트만 표시.
  let words: Word[] | undefined = [];
  for (let k = a; k <= b; k++) {
    const w = cues[k].words;
    if (!w) {
      words = undefined;
      break;
    }
    words.push(...w);
  }

  return {
    cueStart: a,
    cueEnd: b,
    start: cues[a].start,
    end: cues[b].end,
    text,
    words: words && words.length > 0 ? words : undefined,
  };
}

export function segmentCues(cues: Cue[]): Sentence[] {
  const out: Sentence[] = [];
  let i = 0;
  while (i < cues.length) {
    let j = i;
    let chars = cues[i].text.length;
    // cur=cues[j]에서 끊을지 판단하며 j를 키운다.
    while (j < cues.length - 1) {
      const cur = cues[j];
      const next = cues[j + 1];
      if (endsSentence(cur.text)) break; // 종결 부호
      if (next.start - cur.end >= GAP_THRESHOLD_SEC) break; // 긴 침묵
      if (chars + 1 + next.text.length > MAX_CHARS) break; // 글자 캡
      if (j - i + 1 >= MAX_CUES) break; // cue 수 캡
      j++;
      chars += 1 + cues[j].text.length;
    }
    out.push(makeSentence(cues, i, j));
    i = j + 1;
  }
  return out;
}
