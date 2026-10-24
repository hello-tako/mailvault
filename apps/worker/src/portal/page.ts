/**
 * The customer's page: one number, nothing else.
 *
 * It is served as one HTML document with no build step, no service worker and no session —
 * the token in the URL is the whole credential. Everything readable comes from
 * `GET /c/:token/code`, and the page writes it with `textContent` only, because the string it
 * is about to display came out of somebody's email.
 */

/**
 * Every string is data, never code: the labels go out as one JSON object and the page formats
 * the age of a code by substituting into `{s}` / `{m}` rather than by shipping a function.
 */
const STRINGS = {
  vi: {
    title: "Mã xác nhận",
    codeLabel: "Mã của bạn",
    waiting: "Đang chờ mã… trang sẽ tự cập nhật",
    copy: "Sao chép",
    copied: "Đã sao chép",
    ageSeconds: "{s} giây trước",
    ageMinutes: "{m} phút trước",
    alias: "Email nhận mã",
    expires: "Link hết hạn lúc",
    expired: "Link này đã hết hạn. Hãy liên hệ nơi bạn mua để lấy link mới.",
    spent: "Link này đã được xem đủ số lần. Hãy liên hệ nơi bạn mua để lấy link mới.",
    invalid: "Link không hợp lệ. Hãy kiểm tra lại đường dẫn bạn được đưa.",
    note: "Trang chỉ hiện mã mới nhất trong 30 phút, và chỉ từ thư đã được xác thực.",
  },
  en: {
    title: "Verification code",
    codeLabel: "Your code",
    waiting: "Waiting for the code… this page refreshes itself",
    copy: "Copy",
    copied: "Copied",
    ageSeconds: "{s}s ago",
    ageMinutes: "{m}m ago",
    alias: "Code goes to",
    expires: "Link expires at",
    expired: "This link has expired. Ask the seller for a new one.",
    spent: "This link has been viewed enough times. Ask the seller for a new one.",
    invalid: "This link is not valid. Check the address you were given.",
    note: "Only the newest code from the last 30 minutes is shown, and only from verified mail.",
  },
} as const;

const CSS = `
:root { color-scheme: light dark; --bg:#f7f8fa; --fg:#12151b; --muted:#5b6472; --line:#e3e7ee; --card:#fff; --accent:#0f7a4a; }
@media (prefers-color-scheme: dark) { :root { --bg:#0f1216; --fg:#eef1f5; --muted:#98a2b1; --line:#242a33; --card:#171b21; --accent:#3ddc97; } }
* { box-sizing: border-box }
body { margin:0; min-height:100svh; display:grid; place-items:center; background:var(--bg); color:var(--fg);
  font:16px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial; padding:24px }
main { width:100%; max-width:420px; background:var(--card); border:1px solid var(--line); border-radius:18px; padding:28px 24px; text-align:center }
h1 { margin:0 0 4px; font-size:15px; font-weight:650; letter-spacing:.01em; color:var(--muted); text-transform:uppercase }
#code { font:700 clamp(44px,15vw,64px)/1 ui-monospace,SFMono-Regular,Menlo,monospace; letter-spacing:.06em; margin:18px 0 6px; word-break:break-all }
#code.empty { color:var(--line); font-weight:400 }
#age { color:var(--muted); font-size:14px; min-height:20px }
#status { color:var(--muted); font-size:15px; margin:14px 0 0 }
button { margin-top:18px; min-height:44px; padding:0 20px; font:650 15px/1 inherit; color:var(--fg); background:transparent;
  border:1px solid var(--line); border-radius:12px; cursor:pointer }
button:hover { border-color:var(--accent); color:var(--accent) }
dl { margin:22px 0 0; padding-top:16px; border-top:1px solid var(--line); display:grid; gap:6px; font-size:13px; color:var(--muted) }
dd { margin:0; font-family:ui-monospace,Menlo,monospace; color:var(--fg); word-break:break-all }
footer { margin-top:18px; font-size:12px; color:var(--muted) }
`;

const APP = `
const T = STRINGS[LANG];
const codeEl = document.getElementById('code');
const ageEl = document.getElementById('age');
const statusEl = document.getElementById('status');
const copyEl = document.getElementById('copy');
let timer = 0;

function ageText(s) {
  return (s < 60 ? T.ageSeconds : T.ageMinutes).replace(s < 60 ? '{s}' : '{m}', s < 60 ? s : Math.round(s / 60));
}

function render(o) {
  if (o.state === 'code') {
    statusEl.textContent = '';
    codeEl.classList.remove('empty');
    codeEl.textContent = o.code;
    ageEl.textContent = ageText(o.ageSeconds);
    copyEl.hidden = false;
    document.getElementById('alias').textContent = o.alias;
  } else if (o.state === 'waiting') {
    codeEl.classList.add('empty');
    codeEl.textContent = '······';
    ageEl.textContent = '';
    copyEl.hidden = true;
    statusEl.textContent = T.waiting;
    document.getElementById('alias').textContent = o.alias;
  } else {
    clearInterval(timer);
    codeEl.classList.add('empty');
    codeEl.textContent = '';
    ageEl.textContent = '';
    copyEl.hidden = true;
    statusEl.textContent = o.state === 'expired' ? T.expired : o.state === 'spent' ? T.spent : T.invalid;
  }
}

async function poll() {
  try {
    const r = await fetch('/c/' + TOKEN + '/code', { cache: 'no-store' });
    render(await r.json());
  } catch (e) {
    statusEl.textContent = T.waiting;
  }
}

copyEl.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(codeEl.textContent || '');
    copyEl.textContent = T.copied;
  } catch (e) { /* no clipboard permission: the number is on screen and selectable */ }
  setTimeout(() => { copyEl.textContent = T.copy; }, 1400);
});

poll();
timer = setInterval(poll, 5000);

if (EXPIRES) {
  const at = Date.parse(EXPIRES);
  document.getElementById('expires').textContent =
    Number.isNaN(at) ? EXPIRES : new Date(at).toLocaleString(LANG === 'vi' ? 'vi-VN' : 'en-GB');
}
`;

export function portalPage(input: { token: string; lang: string; expiresAt: string | null }): string {
  const key: keyof typeof STRINGS = input.lang === "en" ? "en" : "vi";
  const t = STRINGS[key];
  const bootstrap = `const TOKEN = ${JSON.stringify(input.token)}; const LANG = ${JSON.stringify(key)}; const EXPIRES = ${JSON.stringify(
    input.expiresAt,
  )}; const STRINGS = ${JSON.stringify({ vi: STRINGS.vi, en: STRINGS.en })};`;
  return `<!doctype html><html lang="${key}"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow,noarchive">
<meta name="referrer" content="no-referrer">
<title>${t.title}</title>
<style>${CSS}</style>
</head><body>
<main>
  <h1>${t.codeLabel}</h1>
  <div id="code" class="empty">······</div>
  <div id="age"></div>
  <p id="status">${t.waiting}</p>
  <button id="copy" type="button" hidden>${t.copy}</button>
  <dl>
    <dt>${t.alias}</dt><dd id="alias"></dd>
    ${input.expiresAt ? `<dt>${t.expires}</dt><dd id="expires"></dd>` : ""}
  </dl>
  <footer>${t.note}</footer>
</main>
<script>${bootstrap}${APP}</script>
</body></html>`;
}
