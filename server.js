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

// Pi Browser 등에서 HTML 캐시로 구버전 UI가 남는 것 방지
app.use((req, res, next) => {
    if (req.method !== 'GET') return next();
    const p = req.path;
    if (p === '/' || p.startsWith('/post/') || p === '/privacy' || p === '/terms') {
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.set('Pragma', 'no-cache');
        res.set('Expires', '0');
    }
    next();
});

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
const PI_PAYMENT_AMOUNT = Number(process.env.PI_PAYMENT_AMOUNT || 0.1);

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
            memo: '디지털뉴스 welcome reward',
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

function resolveSiteUrl(req) {
    const fromEnv = (process.env.SITE_URL || '').trim().replace(/\/$/, '');
    if (fromEnv) return fromEnv;
    const host = (req.get('x-forwarded-host') || req.get('host') || '').split(',')[0].trim();
    const proto = (req.get('x-forwarded-proto') || 'https').split(',')[0].trim();
    return host ? `${proto}://${host}` : SITE_URL;
}

// 법적 페이지 공통 레이아웃 (Pi Mainnet Listing — Privacy / Terms 필수)
function legalPage(title, bodyHtml, siteUrl) {
    const home = (siteUrl || SITE_URL).replace(/\/$/, '');
    const updated = '2026-05-30';
    const canonicalPath = title.includes('Privacy') ? '/privacy' : title.includes('Terms') ? '/terms' : '/';
    return `<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — Digital News</title>
<meta name="description" content="Digital News — Pi-native newsletter app. Privacy and terms for Pi Browser users.">
<link rel="canonical" href="${home}${canonicalPath}">
<style>
  body{background:#020a02;color:#c8e6c9;font-family:system-ui,-apple-system,'Noto Sans KR',sans-serif;
       line-height:1.75;max-width:720px;margin:0 auto;padding:40px 20px 56px;}
  h1{color:#39ff14;font-size:1.45rem;border-bottom:1px solid #1c3a1c;padding-bottom:14px;margin-bottom:8px;}
  h2{color:#7CFC00;font-size:1.05rem;margin-top:28px;margin-bottom:8px;}
  p,li{color:#b9f5b9;font-size:0.95rem;}
  p.ko{color:#d4f5d4;margin-top:6px;}
  ul{padding-left:1.25rem;margin:8px 0 16px;}
  a{color:#39ff14;text-decoration:none;border-bottom:1px solid rgba(57,255,20,0.35);}
  a:hover{color:#fff;}
  .meta{color:#5a8a5a;font-size:0.85rem;margin-bottom:24px;}
  .nav{margin:24px 0;padding:12px 0;border-top:1px solid #1c3a1c;border-bottom:1px solid #1c3a1c;
       font-size:0.88rem;display:flex;flex-wrap:wrap;gap:12px;}
  .muted{color:#5a8a5a;font-size:0.82rem;margin-top:32px;line-height:1.6;}
</style></head><body>
<nav class="nav"><a href="${home}/">홈 Home</a><a href="${home}/privacy">개인정보처리방침</a><a href="${home}/terms">이용약관</a></nav>
${bodyHtml}
<p class="muted">Digital News · Pi Browser<br>
<a href="${home}/">${home}</a><br>
최종 수정 · Last updated: ${updated}</p>
</body></html>`;
}

// 개인정보처리방침 (Pi 앱 필수 — Mainnet App Wallet / Listing)
app.get('/privacy', (req, res) => {
    const siteUrl = resolveSiteUrl(req);
    res.type('html').send(legalPage('Privacy Policy', `
<h1>Privacy Policy / 개인정보처리방침</h1>
<p class="meta">Digital News — Pi-native newsletter · ${siteUrl}</p>

<h2>1. About the app / 앱 소개</h2>
<p>Digital News publishes messages on human–AI coexistence and related topics. Free posts are readable in the Pi Browser; selected premium posts unlock after a <strong>Pi-only</strong> payment.</p>
<p class="ko">Digital News는 Pi Browser에서 제공하는 뉴스레터 앱입니다. 무료 글은 공개되며, 일부 유료 글은 <strong>Pi(π) 결제</strong> 후 열람됩니다. 로그인·결제는 Pi 앱 플랫폼 밖에서 운영하지 않습니다.</p>

<h2>2. Authentication / 로그인</h2>
<p>We use <strong>Pi Network Authentication SDK only</strong>. We do not offer email, password, Google, or other third-party login.</p>
<p class="ko">로그인은 <strong>Pi Network 인증만</strong> 사용합니다. 이메일·비밀번호·구글 등 타사 로그인은 제공하지 않습니다.</p>

<h2>3. Data we collect / 수집하는 정보</h2>
<ul>
<li><strong>Pi user identifier (uid)</strong> — unlock status for premium content</li>
<li><strong>Pi username</strong> — if you grant the <code>username</code> scope</li>
<li><strong>Payment identifiers</strong> — Pi payment ID and blockchain txid</li>
<li><strong>Basic usage</strong> — aggregated page view counts (Notion)</li>
</ul>
<p class="ko"><strong>수집 항목:</strong> Pi uid(유료 잠금 해제 확인), Pi username(허용 시), 결제 ID·블록체인 txid, 집계 조회수.<br>
<strong>수집하지 않음:</strong> 실명, 이메일, 전화번호, 신분증, 지갑 비밀문구, 개인키, 정밀 위치정보.</p>

<h2>4. How we use data / 이용 목적</h2>
<p>We use data only to verify Pi payments, unlock paid content, prevent duplicate charges, and operate the app in the Pi ecosystem. We do <strong>not</strong> sell or share your data for advertising.</p>
<p class="ko">수집 정보는 Pi 결제 확인, 유료 콘텐츠 잠금 해제, 중복 결제 방지, 앱 운영 목적으로만 사용합니다. 데이터를 판매·광고 프로필용으로 제공하지 않습니다.</p>

<h2>5. Non-custodial wallets / 비수탁</h2>
<p>Digital News never holds your Pi or private keys. Payments are signed in your Pi Wallet.</p>
<p class="ko">Digital News는 Pi나 개인키를 보관하지 않습니다. 결제는 사용자 Pi Wallet에서 서명하며, 앱 지갑은 사용자가 승인한 U2A(유료 해제) 결제만 수령합니다.</p>

<h2>6. Third-party services / 제3자</h2>
<ul>
<li><strong>Pi Network</strong> — authentication &amp; payments (<a href="https://minepi.com/privacy-policy" rel="noopener">Pi privacy policy</a>)</li>
<li><strong>Notion</strong> — content hosting (no Pi credentials stored)</li>
<li><strong>Render</strong> — hosting (server logs per host policy)</li>
</ul>
<p class="ko"><strong>제3자:</strong> Pi Network(인증·결제), Notion(콘텐츠), Render(호스팅). 각 서비스는 자체 정책을 따릅니다.</p>

<h2>7. Retention / 보관</h2>
<p>Unlock records are kept as needed for access. Pi auth tokens are not permanently stored on our servers.</p>
<p class="ko">잠금 해제 기록은 접근 권한 유지에 필요한 기간 보관합니다. Pi 인증 토큰은 서버에 영구 저장하지 않습니다.</p>

<h2>8. Children / 아동</h2>
<p>The app is not directed at children under 13.</p>
<p class="ko">만 13세 미만 아동을 대상으로 하지 않으며, 아동의 개인정보를 고의로 수집하지 않습니다.</p>

<h2>9. Your choices / 선택권</h2>
<p>You may revoke app permissions in Pi Browser settings.</p>
<p class="ko">Pi Browser 설정에서 앱 권한을 철회할 수 있습니다. 철회 시 새 유료 콘텐츠 잠금 해제가 제한될 수 있습니다.</p>

<h2>10. Changes / 변경</h2>
<p>We may update this policy. Continued use after updates means acceptance.</p>
<p class="ko">정책이 변경될 수 있으며, 하단 날짜가 갱신됩니다. 변경 후 계속 이용 시 동의한 것으로 봅니다.</p>

<h2>11. Contact / 문의</h2>
<p>Contact via Pi Network app listing or Pi Browser support channels.</p>
<p class="ko">문의: Pi Browser 앱 내 Digital News 또는 Pi 생태계 지원 채널을 이용해 주세요. 별도 이메일 수집은 하지 않습니다.</p>`, siteUrl));
});

// 이용약관
app.get('/terms', (req, res) => {
    const siteUrl = resolveSiteUrl(req);
    res.type('html').send(legalPage('Terms of Service', `
<h1>Terms of Service / 이용약관</h1>
<p class="meta">Pi Browser에서 Digital News를 이용하면 아래 약관에 동의한 것으로 봅니다.<br>
By using Digital News in the Pi Browser, you agree to these terms.</p>

<h2>1. Service / 서비스</h2>
<p>Digital News provides newsletter content about coexistence and technology. Some content is free; premium content requires a one-time Pi payment to unlock.</p>
<p class="ko">Digital News는 인간·AI 상생 등 주제의 뉴스레터(회보)를 제공합니다. 일부는 무료, 유료 회보는 Pi 1회 결제 후 앱에서 열람할 수 있습니다.</p>

<h2>2. Pi Browser &amp; Pi-only payments / Pi 전용</h2>
<p>Designed for the <strong>Pi Browser</strong>. Login and payments use the Pi SDK only. All in-app unlocks use <strong>Pi (π)</strong> only.</p>
<p class="ko">본 앱은 <strong>Pi Browser</strong>용입니다. 로그인·결제는 Pi SDK만 사용하며, 앱 내 유료 해제는 <strong>π</strong>로만 가능합니다. 법정화폐·타 가상자산·외부 결제 링크는 받지 않습니다.</p>

<h2>3. Payments &amp; refunds / 결제·환불</h2>
<p>Unlocking premium content authorizes a user-to-app payment from your Pi Wallet. Payments are <strong>non-refundable</strong> except where required by law. Content is not financial advice.</p>
<p class="ko">유료 회보 잠금 해제 시 Pi Wallet에서 U2A 결제를 승인합니다. 디지털 열람 권한 제공 후 원칙적으로 <strong>환불되지 않습니다</strong>(법령상 의무 제외). 콘텐츠는 투자·법률·세무 자문이 아닙니다.</p>

<h2>4. Your wallet / 지갑 책임</h2>
<p>You are responsible for your Pi Wallet, passphrase, and transaction approvals.</p>
<p class="ko">Pi Wallet, 패스프레이즈, 결제 승인은 사용자 책임입니다. 블록체인 거래 취소나 패스프레이즈 복구는 불가능합니다.</p>

<h2>5. Content disclaimer / 콘텐츠</h2>
<p>Messages express author perspectives, not investment, legal, or tax advice.</p>
<p class="ko">회보는 필자 관점의 글입니다. 투자·법률·세무 조언이 아니며, 이용은 본인 판단과 책임입니다.</p>

<h2>6. Acceptable use / 이용 규칙</h2>
<ul>
<li>Do not bypass payment locks or impersonate others</li>
<li>Do not scrape, overload, or attack the service</li>
<li>Comply with Pi Network terms and applicable laws</li>
</ul>
<p class="ko">결제 우회·타인 사칭·서비스 공격·과도한 크롤링 금지. Pi Network 약관 및 관련 법령을 준수해 주세요.</p>

<h2>7. Availability / 가용성</h2>
<p>The service is provided "as is" without warranties.</p>
<p class="ko">서비스는 「있는 그대로」 제공되며, 기능 변경·일시 중단·종료가 있을 수 있습니다.</p>

<h2>8. Limitation of liability / 책임</h2>
<p>Digital News is not liable for indirect losses, wallet errors, or third-party failures (Pi, Notion, hosting).</p>
<p class="ko">간접 손해, 지갑 오류, Pi·Notion·호스팅 등 제3자 장애로 인한 손해에 대해 법이 허용하는 범위 내에서 책임을 제한합니다.</p>

<h2>9. Changes / 변경</h2>
<p>We may update these terms. Continued use constitutes acceptance.</p>
<p class="ko">약관을 변경할 수 있으며, 변경 후 계속 이용 시 동의한 것으로 봅니다.</p>

<h2>10. Contact / 문의</h2>
<p>Reach the operator via Pi ecosystem channels for Digital News.</p>
<p class="ko">문의: Digital News 관련 Pi 생태계 채널을 이용해 주세요.</p>`, siteUrl));
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
                'This message lives inside the Pi Ecosystem. Come to Pi Browser and unlock with 0.1 π. (Pi 생태계로 와서 보세요)';
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
