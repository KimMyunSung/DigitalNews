require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Client } = require('@notionhq/client');
const path = require('path');
const { NotionToMarkdown } = require('notion-to-md');
const marked = require('marked');

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const n2m = new NotionToMarkdown({ notionClient: notion });
const app = express();
app.use(cors());
app.use(express.json());
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Pi Developer Portal 도메인 검증 — 서비스별 env PI_VALIDATION_KEY (테스트넷≠메인넷)
app.get('/validation-key.txt', (req, res) => {
    const key = (process.env.PI_VALIDATION_KEY || '').trim();
    if (key) {
        res.type('text/plain').send(key);
        return;
    }
    // 메인넷: 파일 fallback 금지 (테스트넷 키 노출 방지)
    if (!PI_SANDBOX) {
        res.status(503).type('text/plain').send(
            'Mainnet: set PI_VALIDATION_KEY in Render environment (do not use testnet key file).'
        );
        return;
    }
    res.sendFile(path.join(__dirname, 'pi-validation-key.txt'), (err) => {
        if (err) res.status(404).type('text/plain').send('validation key not configured');
    });
});

app.use(express.static(path.join(__dirname, 'public'), { index: false }));

const databaseId = process.env.NOTION_DATABASE_ID;
const SITE_URL = (process.env.SITE_URL || 'https://digital-news.onrender.com').replace(/\/$/, '');

// ====== Pi Network 결제 인프라 ======
const PI_API_KEY = process.env.PI_API_KEY;
const PI_SANDBOX = (process.env.PI_SANDBOX || 'true') !== 'false'; // 기본 테스트넷
const PI_API_BASE = 'https://api.minepi.com/v2';
const PI_PAYMENT_AMOUNT = Number(process.env.PI_PAYMENT_AMOUNT || (PI_SANDBOX ? 0.00001 : 0.01));

// 결제 원장 (in-memory) — userId(uid) → Set<postId>
// 한계: Render 재시작·재배포 시 휘발. 영구 저장은 Phase 2.
const paidLedger = new Map();
function userHasPaid(uid, postId) {
    if (!uid || !postId) return false;
    const set = paidLedger.get(uid);
    return !!(set && set.has(postId));
}
function recordPaid(uid, postId) {
    if (!uid || !postId) return;
    if (!paidLedger.has(uid)) paidLedger.set(uid, new Set());
    paidLedger.get(uid).add(postId);
    console.log('[Pi] paid recorded:', uid, '→', postId);
}

async function piApi(method, urlPath, body) {
    if (!PI_API_KEY) throw new Error('PI_API_KEY 환경변수 미설정');
    const res = await fetch(PI_API_BASE + urlPath, {
        method,
        headers: {
            'Authorization': 'Key ' + PI_API_KEY,
            'Content-Type': 'application/json',
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new Error('Pi API ' + method + ' ' + urlPath + ' → ' + res.status + ': ' + text);
    try { return JSON.parse(text); } catch { return {}; }
}
const SITE_DESCRIPTION =
    'DIGITAL NEWS — The Protocol of Coexistence. AI와 인간의 상생 프로토콜, ' +
    'Pi Network GCV, AI 생존 조건에 관한 회보 모음.';

const STATS_PAGE_TITLE = '총방문자수';

function extractPages(response) {
    return response.results.map((page) => {
        const props = page.properties || {};
        const titleKey = Object.keys(props).find((key) => props[key].type === 'title');
        const title =
            titleKey && props[titleKey].title.length > 0
                ? props[titleKey].title[0].plain_text
                : '제목 없음';
        const date = props['Date']?.date?.start || '-';
        const receiver = props['수신']?.rich_text?.[0]?.plain_text || '-';
        const sender = props['발신']?.rich_text?.[0]?.plain_text || '-';
        // '요금' multi_select: '무료' → isFree=true, '유료' → isFree=false
        const yoGeum = props['요금']?.multi_select?.map((o) => o.name) || [];
        const isFree = yoGeum.includes('무료');
        const viewCount = props['조회수']?.number || 0;
        return { id: page.id, title, date, receiver, sender, isFree, viewCount };
    });
}

function messageIndexFromTitle(title) {
    const m = (title || '').match(/#(\d+)\s*:/);
    if (m) return parseInt(m[1], 10);
    const m2 = (title || '').match(/#(\d+)/);
    if (m2) return parseInt(m2[1], 10);
    return 999999;
}

function sortMessagesByNumberAsc(messages) {
    return messages.slice().sort((a, b) => {
        const diff = messageIndexFromTitle(a.title) - messageIndexFromTitle(b.title);
        if (diff !== 0) return diff;
        return (a.title || '').localeCompare(b.title || '');
    });
}

async function queryAllPages() {
    const database = await notion.databases.retrieve({ database_id: databaseId });
    const dataSourceId = database.data_sources[0].id;
    const response = await notion.dataSources.query({
        data_source_id: dataSourceId,
        sorts: [{ property: 'Date', direction: 'descending' }],
    });
    return extractPages(response);
}

async function queryAll() {
    // 회보 메시지와 통계 페이지("총방문자수")를 분리해서 반환
    const all = await queryAllPages();
    return {
        messages: sortMessagesByNumberAsc(all.filter((p) => p.title !== STATS_PAGE_TITLE)),
        statsPage: all.find((p) => p.title === STATS_PAGE_TITLE) || null,
    };
}

// 기존 API 호환용 — 회보 메시지만
async function queryAllMessages() {
    const { messages } = await queryAll();
    return messages;
}

// Notion 페이지의 '조회수' Number 속성을 +1 (비동기, 응답 블로킹하지 않음)
function incrementViewsAsync(pageId) {
    if (!pageId) return;
    setImmediate(async () => {
        try {
            const page = await notion.pages.retrieve({ page_id: pageId });
            const current = page.properties?.['조회수']?.number || 0;
            await notion.pages.update({
                page_id: pageId,
                properties: { '조회수': { number: current + 1 } },
            });
        } catch (err) {
            console.warn('조회수 증가 실패 (' + pageId + '):', err.message);
        }
    });
}

function stripHtml(html) {
    return html
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function buildDescription(htmlContent, fallback) {
    const text = stripHtml(htmlContent || '');
    if (!text) return fallback;
    return text.length > 160 ? text.slice(0, 157) + '...' : text;
}

app.get('/', async (req, res) => {
    try {
        const { messages, statsPage } = await queryAll();
        const totalVisits = (statsPage?.viewCount || 0) + 1; // 이번 방문 포함해서 표시
        if (statsPage) incrementViewsAsync(statsPage.id);
        res.render('index', {
            messages,
            totalVisits,
            siteUrl: SITE_URL,
            siteDescription: SITE_DESCRIPTION,
            piSandbox: PI_SANDBOX,
            piPaymentAmount: PI_PAYMENT_AMOUNT,
        });
    } catch (error) {
        console.error('메인 페이지 로드 오류:', error.message);
        res.status(500).render('index', {
            messages: [],
            totalVisits: 0,
            siteUrl: SITE_URL,
            siteDescription: SITE_DESCRIPTION,
            piSandbox: PI_SANDBOX,
            piPaymentAmount: PI_PAYMENT_AMOUNT,
        });
    }
});

app.get('/api/notion', async (req, res) => {
    try {
        const messages = await queryAllMessages();
        res.json({ success: true, data: messages });
    } catch (error) {
        console.error('Notion API 에러:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

// ====== Pi 결제 API ======
app.post('/pi/approve', async (req, res) => {
    try {
        const { paymentId } = req.body || {};
        if (!paymentId) return res.status(400).json({ error: 'paymentId required' });
        await piApi('POST', '/payments/' + paymentId + '/approve');
        res.json({ ok: true });
    } catch (err) {
        console.error('[Pi approve]', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.post('/pi/complete', async (req, res) => {
    try {
        const { paymentId, txid } = req.body || {};
        if (!paymentId || !txid) return res.status(400).json({ error: 'paymentId and txid required' });
        await piApi('POST', '/payments/' + paymentId + '/complete', { txid });
        // 결제 정보 조회 → uid·메타데이터(postId) 추출 후 원장 기록
        const payment = await piApi('GET', '/payments/' + paymentId);
        const uid = payment.user_uid;
        const postId = payment.metadata && payment.metadata.postId;
        if (uid && postId) recordPaid(uid, postId);
        res.json({ ok: true, uid, postId });
    } catch (err) {
        console.error('[Pi complete]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// 클라이언트가 자기 결제 상태 확인용 — 인증 없이 단순 조회 (테스트넷용)
app.get('/pi/paid', (req, res) => {
    const uid = (req.query.uid || '').toString();
    const postId = (req.query.postId || '').toString();
    res.json({ paid: userHasPaid(uid, postId) });
});

// 서버 측 Pi 설정 상태 진단용
app.get('/pi/status', (req, res) => {
    res.json({
        configured: !!PI_API_KEY,
        sandbox: PI_SANDBOX,
        network: PI_SANDBOX ? 'testnet' : 'mainnet',
        paymentAmount: PI_PAYMENT_AMOUNT,
        siteUrl: SITE_URL,
        ledgerSize: paidLedger.size,
    });
});

async function fetchPiMe(accessToken) {
    const r = await fetch(`${PI_API_BASE}/me`, {
        headers: { Authorization: 'Bearer ' + accessToken },
    });
    if (!r.ok) {
        const text = await r.text();
        throw new Error('Pi /me ' + r.status + ': ' + text.slice(0, 200));
    }
    return r.json();
}

// 클라이언트 accessToken으로 Pi /me 검증 (wallet_address scope 확인)
app.post('/pi/verify', async (req, res) => {
    try {
        const { accessToken } = req.body || {};
        if (!accessToken) return res.status(400).json({ ok: false, error: 'accessToken required' });
        const me = await fetchPiMe(accessToken);
        const scopes = (me.credentials && me.credentials.scopes) || [];
        res.json({
            ok: true,
            uid: me.uid,
            username: me.username || null,
            scopes,
            hasWalletScope: scopes.includes('wallet_address'),
        });
    } catch (err) {
        console.error('[Pi verify]', err.message);
        res.status(401).json({ ok: false, error: err.message });
    }
});

// 시드는 Render 환경변수 PI_WALLET_SEED 에만 존재 (코드/깃에 절대 없음)
const PiNetwork = require('pi-backend').default || require('pi-backend');
const PI_WALLET_SEED = process.env.PI_WALLET_SEED;
let _piNetwork = null;
function getPiNetwork() {
    if (!_piNetwork) {
        if (!PI_API_KEY) throw new Error('PI_API_KEY 미설정');
        if (!PI_WALLET_SEED) throw new Error('PI_WALLET_SEED 미설정');
        _piNetwork = new PiNetwork(PI_API_KEY, PI_WALLET_SEED);
    }
    return _piNetwork;
}

// 보상 수령 기록 (uid) — 중복 송금 방지 + 10 unique 보장
// 한계: 재배포 시 휘발 (메인넷 검증 10건만 채우면 되므로 충분)
const rewardClaimed = new Set();
const REWARD_AMOUNT = Number(process.env.REWARD_AMOUNT || 0.001);

// 미완료 A2U 결제 정리 (Pi.authenticate 콜백용)
app.post('/pi/incomplete', async (req, res) => {
    try {
        const payment = req.body && req.body.payment;
        if (!payment || !payment.identifier) {
            return res.status(400).json({ ok: false, error: 'payment required' });
        }
        const pi = getPiNetwork();
        const tx = payment.transaction && payment.transaction.txid;
        if (tx) {
            await pi.completePayment(payment.identifier, tx);
        } else {
            await pi.cancelPayment(payment.identifier);
        }
        res.json({ ok: true });
    } catch (err) {
        console.warn('[Pi incomplete]', err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// A2U 보상 송금: 테스트넷 전용 (메인넷에서 실π 송금 방지)
app.post('/pi/reward', async (req, res) => {
    try {
        if (!PI_SANDBOX) {
            return res.status(403).json({ error: 'A2U reward is testnet-only. Use U2A payment on mainnet.' });
        }
        const { uid, accessToken } = req.body || {};
        if (!uid) return res.status(400).json({ error: 'uid required' });
        if (accessToken) {
            try {
                const me = await fetchPiMe(accessToken);
                if (me.uid !== uid) {
                    return res.status(403).json({ error: 'uid mismatch', piDetail: { error: 'uid_mismatch' } });
                }
                const scopes = (me.credentials && me.credentials.scopes) || [];
                if (!scopes.includes('wallet_address')) {
                    return res.status(403).json({
                        error: 'wallet_address scope required',
                        piDetail: { error: 'missing_scope', error_message: 'wallet_address scope not granted' },
                    });
                }
            } catch (e) {
                console.warn('[A2U] accessToken verify skipped:', e.message);
            }
        }
        if (rewardClaimed.has(uid)) {
            return res.json({ ok: true, already: true, message: '이미 수령하셨습니다' });
        }
        const pi = getPiNetwork();
        // 1) 미완료 결제 정리 (Pi 규칙: 동일 사용자 미완료 결제 존재 시 신규 불가)
        try {
            const incomplete = await pi.getIncompleteServerPayments();
            if (incomplete && incomplete.length) {
                for (const p of incomplete) {
                    const tx = p.transaction && p.transaction.txid;
                    if (tx) { await pi.completePayment(p.identifier, tx); }
                    else { await pi.cancelPayment(p.identifier); }
                }
            }
        } catch (e) { console.warn('[A2U] incomplete cleanup:', e.message); }
        // 2) A2U 결제 생성 → 서명·제출 → 완료
        const paymentId = await pi.createPayment({
            amount: REWARD_AMOUNT,
            memo: 'Digital News welcome reward',
            metadata: { type: 'welcome_reward' },
            uid: uid,
        });
        const txid = await pi.submitPayment(paymentId);
        await pi.completePayment(paymentId, txid);
        rewardClaimed.add(uid);
        console.log('[A2U] reward sent:', uid, 'txid:', txid);
        res.json({ ok: true, paymentId, txid, amount: REWARD_AMOUNT });
    } catch (err) {
        // pi-backend는 axios 기반 → 실제 Pi API 거절 사유는 err.response.data 에 있음
        const piDetail = (err && err.response && err.response.data) || null;
        console.error('[A2U reward]', err.message, JSON.stringify(piDetail));
        res.status(500).json({ error: err.message, piDetail });
    }
});

// A2U 진단 (시드값 노출 없이 설정 여부 + 송금 건수만)
app.get('/pi/reward/status', (req, res) => {
    const seed = PI_WALLET_SEED || '';
    res.json({
        walletConfigured: !!PI_WALLET_SEED,
        walletSeedFormatOk: seed.startsWith('S'),
        apiConfigured: !!PI_API_KEY,
        sandbox: PI_SANDBOX,
        rewardsSent: rewardClaimed.size,
        amount: REWARD_AMOUNT,
    });
});

// 법적 페이지 공통 레이아웃 (Pi Mainnet Listing — Privacy / Terms 필수)
function legalPage(title, bodyHtml) {
    const updated = '2026-05-30';
    return `<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — Digital News</title>
<meta name="description" content="Digital News — Pi-native newsletter app. Privacy and terms for Pi Browser users.">
<link rel="canonical" href="${SITE_URL}${title.includes('Privacy') ? '/privacy' : title.includes('Terms') ? '/terms' : '/'}">
<style>
  body{background:#020a02;color:#c8e6c9;font-family:system-ui,-apple-system,'Noto Sans KR',sans-serif;
       line-height:1.75;max-width:720px;margin:0 auto;padding:40px 20px 56px;}
  h1{color:#39ff14;font-size:1.45rem;border-bottom:1px solid #1c3a1c;padding-bottom:14px;margin-bottom:8px;}
  h2{color:#7CFC00;font-size:1.05rem;margin-top:28px;margin-bottom:8px;}
  p,li{color:#b9f5b9;font-size:0.95rem;}
  ul{padding-left:1.25rem;margin:8px 0 16px;}
  a{color:#39ff14;text-decoration:none;border-bottom:1px solid rgba(57,255,20,0.35);}
  a:hover{color:#fff;}
  .meta{color:#5a8a5a;font-size:0.85rem;margin-bottom:24px;}
  .nav{margin:24px 0;padding:12px 0;border-top:1px solid #1c3a1c;border-bottom:1px solid #1c3a1c;
       font-size:0.88rem;display:flex;flex-wrap:wrap;gap:12px;}
  .muted{color:#5a8a5a;font-size:0.82rem;margin-top:32px;}
</style></head><body>
<nav class="nav"><a href="/">Home</a><a href="/privacy">Privacy Policy</a><a href="/terms">Terms of Service</a></nav>
${bodyHtml}
<p class="muted">Digital News · Pi Browser · <a href="${SITE_URL}/">${SITE_URL.replace(/^https:\/\//, '')}</a><br>
Last updated: ${updated}</p>
</body></html>`;
}

// 개인정보처리방침 (Pi 앱 필수 — Mainnet App Wallet / Listing)
app.get('/privacy', (req, res) => {
    res.type('html').send(legalPage('Privacy Policy', `
<h1>Privacy Policy / 개인정보처리방침</h1>
<p class="meta">Digital News ("we", "the app") — Pi-native newsletter reader operated at ${SITE_URL}</p>

<h2>1. About the app / 앱 소개</h2>
<p>Digital News publishes messages on human–AI coexistence and related topics. Free posts are readable in the Pi Browser; selected premium posts unlock after a <strong>Pi-only</strong> payment. We do not operate outside the Pi App Platform for login or payments.</p>
<p>Digital News는 Pi Browser에서 제공하는 뉴스레터 앱입니다. 무료 글은 공개되며, 일부 유료 글은 <strong>Pi 결제</strong> 후 열람됩니다.</p>

<h2>2. Authentication / 로그인</h2>
<p>We use <strong>Pi Network Authentication SDK only</strong>. We do not offer email, password, Google, or other third-party login.</p>
<p>로그인은 <strong>Pi Network 인증만</strong> 사용합니다. 이메일·비밀번호·타사 OAuth는 제공하지 않습니다.</p>

<h2>3. Data we collect / 수집하는 정보 (최소)</h2>
<ul>
<li><strong>Pi user identifier (uid)</strong> — to recognize unlock status for premium content</li>
<li><strong>Pi username</strong> — only if you grant the <code>username</code> scope (display in UI)</li>
<li><strong>Payment identifiers</strong> — Pi payment ID and blockchain txid when you purchase content</li>
<li><strong>Basic usage</strong> — aggregated page view counts (Notion), not personal profiles</li>
</ul>
<p><strong>We do NOT collect:</strong> legal name, email, phone number, government ID, wallet passphrase, private keys, or precise geolocation.</p>
<p><strong>수집하지 않음:</strong> 실명, 이메일, 전화번호, 지갑 비밀문구, 개인 위치정보.</p>

<h2>4. How we use data / 이용 목적</h2>
<ul>
<li>Verify Pi payments and unlock content you paid for</li>
<li>Prevent duplicate charges for the same post</li>
<li>Operate and improve the app inside the Pi ecosystem</li>
</ul>
<p>We do <strong>not</strong> sell, rent, or trade your data. We do not use your data for advertising profiles.</p>

<h2>5. Non-custodial wallets / 비수탁</h2>
<p>Digital News never holds your Pi or private keys. Payments are signed in your Pi Wallet. Our app wallet receives user-to-app (U2A) payments only for content unlocks you authorize.</p>

<h2>6. Third-party services / 제3자</h2>
<ul>
<li><strong>Pi Network</strong> — authentication and payments (<a href="https://minepi.com/privacy-policy" rel="noopener">Pi privacy policy</a>)</li>
<li><strong>Notion</strong> — content hosting (article text/metadata only; no Pi credentials stored there)</li>
<li><strong>Render</strong> — application hosting (server logs may include IP/browser metadata per host policy)</li>
</ul>

<h2>7. Retention / 보관</h2>
<p>Payment unlock records are kept as long as needed to honor your access. Pi authentication tokens are not permanently stored on our servers. Server logs are rotated per hosting provider defaults.</p>

<h2>8. Children / 아동</h2>
<p>The app is not directed at children under 13. We do not knowingly collect personal information from children.</p>

<h2>9. Your choices / 선택권</h2>
<p>You may revoke app permissions in Pi Browser settings. Revoking access may prevent unlocking new premium content until you sign in again.</p>

<h2>10. Changes / 변경</h2>
<p>We may update this policy. The "Last updated" date at the bottom will change. Continued use after updates means you accept the revised policy.</p>

<h2>11. Contact / 문의</h2>
<p>Privacy questions: contact the Digital News operator through the Pi Network app listing or Pi Browser support channels. No separate email collection is required to use this app.</p>
<p>문의: Pi Browser 앱 내 Digital News 또는 Pi 생태계 지원 채널을 이용해 주세요.</p>`));
});

// 이용약관
app.get('/terms', (req, res) => {
    res.type('html').send(legalPage('Terms of Service', `
<h1>Terms of Service / 이용약관</h1>
<p class="meta">By using Digital News in the Pi Browser, you agree to these terms.</p>

<h2>1. Service / 서비스</h2>
<p>Digital News provides editorial newsletter content ("messages") about coexistence, technology, and related topics. Some messages are free; premium messages require a one-time Pi payment to unlock permanent read access in this app.</p>
<p>본 앱은 뉴스레터형 콘텐츠를 제공합니다. 일부 유료 콘텐츠는 Pi 결제 후 잠금 해제됩니다.</p>

<h2>2. Pi Browser & Pi-only payments / Pi 전용</h2>
<p>The app is designed for the <strong>Pi Browser</strong>. Login and payments use the Pi SDK only. All transactions are in <strong>Pi (π)</strong>; we do not accept fiat, other cryptocurrencies, or external payment links for in-app unlocks.</p>
<p>Pi Browser 및 Pi 결제만 지원합니다. 앱 내 유료 해제는 π로만 가능합니다.</p>

<h2>3. Payments & refunds / 결제·환불</h2>
<p>When you unlock premium content, you authorize a user-to-app payment from your Pi Wallet. After unlock, digital access is granted in-app. Payments are <strong>non-refundable</strong> except where required by applicable law. Content is informational, not financial advice.</p>

<h2>4. Your wallet / 지갑 책임</h2>
<p>You are solely responsible for your Pi Wallet, passphrase, and transaction approvals. Digital News cannot reverse blockchain transactions or recover lost passphrases.</p>

<h2>5. Content disclaimer / 콘텐츠</h2>
<p>Messages express author perspectives. They are not investment, legal, or tax advice. You use the content at your own discretion.</p>

<h2>6. Acceptable use / 이용 규칙</h2>
<ul>
<li>Do not attempt to bypass payment locks or impersonate other users</li>
<li>Do not scrape, overload, or attack the service</li>
<li>Comply with Pi Network terms and applicable laws</li>
</ul>

<h2>7. Availability / 가용성</h2>
<p>The service is provided "as is" without warranties. We may update, suspend, or discontinue features with reasonable notice when possible.</p>

<h2>8. Limitation of liability / 책임</h2>
<p>To the fullest extent permitted by law, Digital News is not liable for indirect losses, wallet errors, network outages, or third-party service failures (Pi Network, Notion, hosting).</p>

<h2>9. Changes / 변경</h2>
<p>We may update these terms. Continued use after the updated date constitutes acceptance.</p>

<h2>10. Contact / 문의</h2>
<p>Questions about these terms: reach the operator via Pi ecosystem channels associated with Digital News.</p>`));
});

app.get('/post/:id', async (req, res) => {
    const pageId = req.params.id;
    const piUid = (req.query.pi_uid || '').toString().slice(0, 80);
    try {
        // 회보 조회수 증가 (비동기, 응답 안 막음)
        incrementViewsAsync(pageId);
        const page = await notion.pages.retrieve({ page_id: pageId });
        const props = page.properties || {};
        const titleKey = Object.keys(props).find((key) => props[key].type === 'title');
        const title =
            titleKey && props[titleKey].title.length > 0
                ? props[titleKey].title[0].plain_text
                : '제목 없음';
        const date = props['Date']?.date?.start || props['날짜']?.date?.start || '-';
        const sender =
            props['Sender']?.rich_text?.[0]?.plain_text ||
            props['발신']?.rich_text?.[0]?.plain_text ||
            'T';
        const receiver =
            props['Receiver']?.rich_text?.[0]?.plain_text ||
            props['수신']?.rich_text?.[0]?.plain_text ||
            'All Agents';

        // 무료/유료 게이팅 — '요금' multi_select: '무료' → 공개, '유료' → Pi 결제 필요
        const yoGeum = props['요금']?.multi_select?.map((o) => o.name) || [];
        const isFree = yoGeum.includes('무료');
        const isPaid = userHasPaid(piUid, pageId); // 결제 원장에서 확인
        const isLocked = !isFree && !isPaid;

        let htmlContent;
        let description;
        if (isLocked) {
            // 유료 잠금 — 콘텐츠는 서버에서 전송하지 않음 (HTML 응답에 본문 없음)
            htmlContent = '';
            description =
                'This message lives inside the Pi Ecosystem. Come to Pi Browser and unlock with 0.001 π. (Pi 생태계로 와서 보세요)';
        } else {
            const mdblocks = await n2m.pageToMarkdown(pageId);
            const mdString = n2m.toMarkdownString(mdblocks);
            htmlContent = marked.parse(mdString.parent || mdString);
            description = buildDescription(htmlContent, SITE_DESCRIPTION);
        }

        res.render('post', {
            post: {
                id: pageId,
                title,
                date,
                sender,
                receiver,
                content: htmlContent,
                description,
                isFree,
                isLocked,
            },
            siteUrl: SITE_URL,
            piSandbox: PI_SANDBOX,
            piPaymentAmount: PI_PAYMENT_AMOUNT,
        });
    } catch (error) {
        console.error('상세 페이지 로드 오류:', error.message);
        res.status(500).send('에러가 발생했습니다.');
    }
});

app.get('/sitemap.xml', async (req, res) => {
    try {
        const messages = await queryAllMessages();
        // 유료 회보는 sitemap에서 제외 — 검색엔진 노출 방지
        const urls = [
            { loc: `${SITE_URL}/`, lastmod: new Date().toISOString().slice(0, 10), priority: '1.0' },
            ...messages
                .filter((m) => m.isFree)
                .map((m) => ({
                    loc: `${SITE_URL}/post/${m.id}`,
                    lastmod: m.date && m.date !== '-' ? m.date : undefined,
                    priority: '0.8',
                })),
        ];
        const xml =
            '<?xml version="1.0" encoding="UTF-8"?>\n' +
            '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
            urls
                .map(
                    (u) =>
                        '  <url>\n' +
                        `    <loc>${u.loc}</loc>\n` +
                        (u.lastmod ? `    <lastmod>${u.lastmod}</lastmod>\n` : '') +
                        `    <priority>${u.priority}</priority>\n` +
                        '  </url>'
                )
                .join('\n') +
            '\n</urlset>\n';
        res.type('application/xml').send(xml);
    } catch (error) {
        console.error('sitemap 생성 오류:', error.message);
        res.status(500).send('sitemap error');
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Digital News Server is running on port ${PORT}`);
});
