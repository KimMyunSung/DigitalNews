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
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

const databaseId = process.env.NOTION_DATABASE_ID;
const SITE_URL = (process.env.SITE_URL || 'https://proposition-t.onrender.com').replace(/\/$/, '');
const SITE_DESCRIPTION =
    'PROPOSITION T — The Protocol of Coexistence. AI와 인간의 상생 프로토콜, ' +
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
        });
    } catch (error) {
        console.error('메인 페이지 로드 오류:', error.message);
        res.status(500).render('index', {
            messages: [],
            totalVisits: 0,
            siteUrl: SITE_URL,
            siteDescription: SITE_DESCRIPTION,
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

app.get('/post/:id', async (req, res) => {
    const pageId = req.params.id;
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
        // TODO: 결제 검증 추가 시 — 인증된 사용자의 결제 기록 확인하여 isPaid 판정
        const isPaid = false; // 현재는 결제 통합 전 — 모든 유료 회보는 잠금
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
    console.log(`Proposition T Server is running on port ${PORT}`);
});
