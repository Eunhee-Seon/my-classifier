// mask.js — 분류하기 전에 문장에서 개인 식별 정보를 가린다.
// 가린 문장만 분류에 쓴다. (이후 Gemini를 연결할 때도 이 문장만 보낸다.)
//
// 한계: 이름은 "성 + 이름 + 호칭(님·팀장·그룹장 등)" 형태일 때만 찾는다.
//       호칭 없이 이름만 쓴 경우나, 이름과 흔한 낱말이 겹치는 경우는 놓치거나 잘못 가릴 수 있다.
//       사번은 '사번' 이라는 말 뒤에 오는 글자·숫자와, 사번 형식(입사 연월일 6자리 + 그날 입사 순번 2자리,
//       예: 26110701)의 8자리 숫자를 가린다. 같은 모양의 다른 숫자도 사번으로 가릴 수 있다.

(function () {
  const SURNAMES = "김이박최정강조윤장임한오서신권황안송류전홍고문양손배백허유남심노하곽성차주우구민진나지엄채원천방공현함변염여추도소석선설마길연위표명기반왕금옥육인맹제모탁국어은편용";
  // 성 + 이름처럼 보이지만 이름이 아닌 흔한 말
  const NOT_NAMES = new Set(["우리", "이번", "저희", "다음", "그냥", "이분", "전체", "정말", "같은", "이런", "그런", "저런",
    "모든", "다른", "제가", "이제", "주말", "오늘", "어제", "내일", "신규", "기존", "전사", "해당"]);
  const TITLES = "님|씨|팀장|그룹장|매니저|리더|대표";

  const RULES = [
    { label: "이메일", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, to: () => "[이메일]" },
    { label: "전화번호", re: /(?<!\d)0\d{1,2}[-.\s]?\d{3,4}[-.\s]?\d{4}(?!\d)/g, to: () => "[전화번호]" },
    { label: "전화번호", re: /내선\s*\d{3,4}/g, to: () => "[전화번호]" },
    { label: "사번", re: /사번\s*[:：]?\s*[A-Za-z0-9-]+/g, to: () => "사번 [사번]" },
    // 사번 형식: YY MM DD NN (월 01~12, 일 01~31) — 앞뒤에 다른 숫자·영문이 붙지 않은 8자리
    { label: "사번", re: /(?<![0-9A-Za-z])\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{2}(?![0-9A-Za-z])/g, to: () => "[사번]" },
    {
      label: "이름",
      re: new RegExp("(?<![가-힣])([" + SURNAMES + "])([가-힣]{1,2})(\\s?)(" + TITLES + ")", "g"),
      to: (m, s, rest, space, title) => (NOT_NAMES.has(s + rest) ? null : "[이름]" + space + title),
    },
  ];

  function maskText(text) {
    let out = String(text || "");
    const counts = {};
    for (const rule of RULES) {
      out = out.replace(rule.re, (...args) => {
        const replaced = rule.to(...args);
        if (replaced === null) return args[0];
        counts[rule.label] = (counts[rule.label] || 0) + 1;
        return replaced;
      });
    }
    return { masked: out, counts };
  }

  window.Mask = { maskText };
})();
