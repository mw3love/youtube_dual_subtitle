// vite build 후 dist/manifest.json을 한 곳만 손본다: ask-anywhere(A65, 섹션 40)의
// web_accessible_resources 그룹. crxjs가 그 그룹을 자동 생성하긴 하지만, 우리가 manifest.ts에
// 등록한 content_scripts.matches(절대 안 매치되는 https://ydt-ask-anywhere.invalid/* placeholder —
// 자동 실행 방지용)를 그대로 복사해버려 실제로는 무용하다. ask-anywhere는 background가
// chrome.scripting.executeScript로 "임의 페이지"에 온디맨드 주입하므로, 그 loader가 동적
// import()하는 실제 청크는 그 페이지의 origin에서 fetch된다 — matches가 유튜브/placeholder로
// 좁으면 CORS로 막힌다. 그래서 이 그룹만 <all_urls>로 넓힌다(web_accessible_resources.matches는
// host_permissions와 별개 채널이라 "모든 사이트 데이터 접근" 권한 경고를 유발하지 않음 — 그
// 사이트의 스크립트가 이 파일들을 "볼" 수 있게 하는 것뿐).
import { readFileSync, writeFileSync } from 'node:fs';

const MANIFEST_PATH = 'dist/manifest.json';

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
const group = (manifest.web_accessible_resources ?? []).find((w) =>
  w.resources?.some((r) => r.includes('ask-anywhere')),
);

if (!group) {
  // 조용히 넘기면 매치 안 되는 좁은 matches가 그대로 남아 "빌드는 성공, 기능은 조용히 깨짐"이
  // 된다(다른 사이트에서 ask-anywhere의 동적 import가 CORS로 막힘, 콘솔 외엔 사용자에게 티가 안 남) —
  // 그래서 exit 1로 빌드 자체를 실패시켜 회귀를 바로 드러낸다.
  console.error('[patch-manifest] ask-anywhere web_accessible_resources 그룹을 못 찾음 — 빌드 중단');
  process.exit(1);
}
group.matches = ['<all_urls>'];
writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
console.log('[patch-manifest] ask-anywhere 리소스 그룹 matches → <all_urls>');
