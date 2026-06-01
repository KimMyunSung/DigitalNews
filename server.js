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

// Pi Developer Portal 도메인 검증 — Render env로 테스트넷/메인넷 각각 다른 키 가능
app.get('/validation-key.txt', (req, res) => {
    const key = (process.env.PI_VALIDATION_KEY || '').trim();
    if (key) {
        res.type('text/plain').send(key);
        return;
    }
    res.sendFile(path.join(__dirname, 'public', 'validation-key.txt'));
});

app.use(express.static(path.join(__dirname, 'public'), { index: false }));

const databaseId = process.env.NOTION_DATABASE_ID;
const SITE_URL = (process.env.SITE_URL || 'https://proposition-t.onrender.com').replace(/\/$/, '');

// ====== Pi Network 결제 인프라 ======
const PI_API_KEY = process.env.PI_API_KEY;
const PI_SANDBOX = (process.env.PI_SANDBOX || 'true') !== 'false'; // 기본 테스트넷
const PI_API_BASE = 'https://api.minepi.com/v2';

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
        messages: all.filter((p) => p.title !== STATS_PAGE_TITLE),
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
        });
    } catch (error) {
        console.error('메인 페이지 로드 오류:', error.message);
        res.status(500).render('index', {
            messages: [],
            totalVisits: 0,
            siteUrl: SITE_URL,
            siteDescription: SITE_DESCRIPTION,
            piSandbox: PI_SANDBOX,
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
        ledgerSize: paidLedger.size,
    });
});

// ====== A2U (App-to-User) 송금 인프라 ======
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

// A2U 보상 송금: 로그인한 사용자가 1회 수령
app.post('/pi/reward', async (req, res) => {
    try {
        const { uid } = req.body || {};
        if (!uid) return res.status(400).json({ error: 'uid required' });
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
            memo: 'Proposition T welcome reward',
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
    res.json({
        walletConfigured: !!PI_WALLET_SEED,
        apiConfigured: !!PI_API_KEY,
        rewardsSent: rewardClaimed.size,
        amount: REWARD_AMOUNT,
    });
});

// 법적 페이지 공통 레이아웃
function legalPage(title, bodyHtml) {
    return `<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — Proposition T</title>
<style>
  body{background:#020a02;color:#b9f5b9;font-family:system-ui,-apple-system,sans-serif;
       line-height:1.8;max-width:760px;margin:0 auto;padding:48px 24px;}
  h1{color:#39ff14;font-size:1.6rem;border-bottom:1px solid #1c3a1c;padding-bottom:16px;}
  h2{color:#7CFC00;font-size:1.1rem;margin-top:32px;}
  a{color:#39ff14;} .muted{color:#5a8a5a;font-size:.85rem;margin-top:40px;}
</style></head><body>${bodyHtml}
<p class="muted">Proposition T — The Protocol of Coexistence · <a href="/">Home</a></p>
</body></html>`;
}

// 개인정보처리방침 (Pi 앱 필수)
app.get('/privacy', (req, res) => {
    res.type('html').send(legalPage('Privacy Policy', `
<h1>Privacy Policy / 개인정보처리방침</h1>
<p>Last updated: 2026-05-28</p>
<h2>1. Information We Collect / 수집 정보</h2>
<p>Proposition T collects only the minimum data required to operate: your Pi Network user identifier (uid) provided via Pi authentication, and payment identifiers when you unlock premium content. We do not collect your name, email, or wallet private keys.</p>
<p>파이 인증으로 제공되는 사용자 식별자(uid)와 콘텐츠 잠금 해제 시 결제 식별자만 수집합니다. 이름·이메일·지갑 비밀키는 수집하지 않습니다.</p>
<h2>2. How We Use It / 이용 목적</h2>
<p>Solely to verify Pi payments and unlock the content you purchased. We never sell or share your data with third parties.</p>
<p>파이 결제 확인 및 구매 콘텐츠 잠금 해제 목적으로만 사용하며, 제3자에게 판매·공유하지 않습니다.</p>
<h2>3. Data Storage / 데이터 보관</h2>
<p>Payment records are kept only as long as necessary to honor your access. Authentication is handled by the Pi Network SDK; we do not store credentials.</p>
<h2>4. Third-Party Services / 제3자 서비스</h2>
<p>We use Pi Network (authentication & payments) and Notion (content delivery). Each operates under its own privacy policy.</p>
<h2>5. Contact / 문의</h2>
<p>For privacy inquiries, contact the Proposition T operator through the Pi Network ecosystem.</p>`));
});

// 이용약관
app.get('/terms', (req, res) => {
    res.type('html').send(legalPage('Terms of Service', `
<h1>Terms of Service / 이용약관</h1>
<p>Last updated: 2026-05-28</p>
<h2>1. Service / 서비스</h2>
<p>Proposition T delivers newsletter content ("the Protocol of Coexistence"). Certain content may require a Pi payment to unlock.</p>
<p>Proposition T는 뉴스레터 콘텐츠를 제공하며, 일부 콘텐츠는 파이 결제로 잠금 해제됩니다.</p>
<h2>2. Payments / 결제</h2>
<p>Payments are processed through the Pi Network. Once content is unlocked, payments are non-refundable except where required by applicable law.</p>
<p>결제는 파이 네트워크를 통해 처리되며, 콘텐츠 잠금 해제 후에는 관련 법령이 요구하는 경우를 제외하고 환불되지 않습니다.</p>
<h2>3. User Responsibility / 사용자 책임</h2>
<p>You are responsible for safeguarding your Pi wallet and passphrase. Proposition T cannot recover lost keys.</p>
<h2>4. Disclaimer / 면책</h2>
<p>The service is provided "as is" without warranties. Proposition T is not liable for losses arising from use of third-party apps or wallets.</p>
<h2>5. Changes / 변경</h2>
<p>These terms may be updated. Continued use constitutes acceptance.</p>`));
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
