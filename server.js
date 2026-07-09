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

// 법적 페이지 (Pi Mainnet Listing — Privacy / Terms 필수)
app.get('/privacy', (req, res) => {
    res.render('privacy', {
        siteUrl: resolveSiteUrl(req),
        updated: '2026-05-30',
    });
});

app.get('/terms', (req, res) => {
    res.render('terms', {
        siteUrl: resolveSiteUrl(req),
        updated: '2026-05-30',
    });
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
