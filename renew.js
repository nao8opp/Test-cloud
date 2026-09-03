const cheerio = require('cheerio');
const crypto = require('crypto');

const RENEW_DAYS = 10;

const SLEEP = (min = 3000, max = 5000) =>
    new Promise(r =>
        setTimeout(
            r,
            Math.floor(Math.random() * (max - min + 1)) + min
        )
    );

class RenewManager {
    constructor(page, userState, maskedUser) {
        this.page = page;
        this.maskedUser = maskedUser;
        this.state = userState || {};
        this.csrfToken = '';

        this.stats = {
            success: 0,
            skipped: 0,
            failed: 0,
            total: 0
        };

        this.latestDueDate = 0;
    }

    log(msg) {
        console.log(`[${this.maskedUser}] ${msg}`);
    }

    async request(method, url, data = null) {
        const targetUrl = url.startsWith('http')
            ? url
            : `https://dash.hidencloud.com${url.startsWith('/') ? '' : '/'}${url}`;

        const headers = {};

        if (method === 'POST') {
            headers['Content-Type'] =
                'application/x-www-form-urlencoded; charset=UTF-8';
        }

        if (this.csrfToken) {
            headers['X-CSRF-TOKEN'] = this.csrfToken;
        }

        return await this.page.evaluate(
            async ({ url, method, data, headers }) => {
                try {
                    const options = {
                        method,
                        headers,
                        redirect: 'follow',
                        credentials: 'include'
                    };

                    if (data) {
                        options.body = data;
                    }

                    const res = await fetch(url, options);

                    return {
                        status: res.status,
                        finalUrl: res.url,
                        data: await res.text()
                    };
                } catch (e) {
                    return {
                        status: 0,
                        finalUrl: url,
                        data: '',
                        error: e.message
                    };
                }
            },
            {
                url: targetUrl,
                method,
                data: data ? data.toString() : null,
                headers
            }
        );
    }

    extractDate(html) {
        const $ = cheerio.load(html);

        let dueDateText = '';

        // 原来的结构
        $('h6').each((i, el) => {
            const title = $(el).text().trim().toLowerCase();

            if (title === 'due date') {
                dueDateText = $(el)
                    .next('div')
                    .text()
                    .trim();
            }
        });

        // 兼容更多可能的结构
        if (!dueDateText) {
            $('body *').each((i, el) => {
                const text = $(el)
                    .clone()
                    .children()
                    .remove()
                    .end()
                    .text()
                    .trim()
                    .toLowerCase();

                if (text === 'due date') {
                    const nextText = $(el)
                        .next()
                        .text()
                        .trim();

                    if (nextText) {
                        dueDateText = nextText;
                    }
                }
            });
        }

        if (!dueDateText) {
            return null;
        }

        const timestamp = Date.parse(
            `${dueDateText} 00:00:00 GMT`
        );

        if (!isNaN(timestamp)) {
            return timestamp;
        }

        // 尝试直接解析
        const timestamp2 = Date.parse(dueDateText);

        if (!isNaN(timestamp2)) {
            return timestamp2;
        }

        return null;
    }

    /**
     * 从 Dashboard 中提取服务 ID
     *
     * 不再只依赖：
     * /service/123/manage
     *
     * 同时检查：
     * /service/123
     * /service/123/
     * /service/123/manage
     * data-service-id
     * data-id
     */
    discoverServices(html) {
        const $ = cheerio.load(html);
        const services = new Set();

        // ============================================================
        // 1. 检查所有 href
        // ============================================================

        $('a[href]').each((i, el) => {
            const href = $(el).attr('href');

            if (!href) return;

            const patterns = [
                /\/service\/(\d+)\/manage/i,
                /\/service\/(\d+)(?:\/|$|\?)/i
            ];

            for (const pattern of patterns) {
                const match = href.match(pattern);

                if (match) {
                    services.add(match[1]);
                    break;
                }
            }
        });

        // ============================================================
        // 2. 检查 data-service-id
        // ============================================================

        $('[data-service-id]').each((i, el) => {
            const id = $(el).attr('data-service-id');

            if (id && /^\d+$/.test(id)) {
                services.add(id);
            }
        });

        // ============================================================
        // 3. 检查 data-id
        // ============================================================

        $('[data-id]').each((i, el) => {
            const id = $(el).attr('data-id');

            if (
                id &&
                /^\d+$/.test(id) &&
                $(el).closest(
                    '[class*="service"], [id*="service"]'
                ).length
            ) {
                services.add(id);
            }
        });

        // ============================================================
        // 4. 检查 HTML 中直接出现的 /service/123
        // ============================================================

        const htmlMatches = html.match(
            /\/service\/(\d+)(?:\/manage|\/|["'?#])/gi
        );

        if (htmlMatches) {
            for (const item of htmlMatches) {
                const match = item.match(/\/service\/(\d+)/i);

                if (match) {
                    services.add(match[1]);
                }
            }
        }

        return [...services];
    }

    /**
     * Dashboard 服务发现失败时输出诊断信息
     */
    async diagnoseDashboard(html) {
        const $ = cheerio.load(html);

        this.log('⚠️ Dashboard 中没有发现服务 ID');

        this.log(
            `📄 Dashboard URL: ${await this.page.url()}`
        );

        this.log(
            `📊 HTML 长度: ${html.length}`
        );

        const title = $('title')
            .text()
            .trim();

        this.log(
            `📌 页面标题: ${title || '(空)'}`
        );

        // 输出所有 service 相关链接
        const serviceLinks = [];

        $('a[href]').each((i, el) => {
            const href = $(el).attr('href');
            const text = $(el).text().trim();

            if (
                href &&
                (
                    href.toLowerCase().includes('service') ||
                    text.toLowerCase().includes('service') ||
                    text.includes('服务器') ||
                    text.includes('服务')
                )
            ) {
                serviceLinks.push({
                    text: text.substring(0, 100),
                    href
                });
            }
        });

        if (serviceLinks.length > 0) {
            this.log(
                `🔎 找到 ${serviceLinks.length} 个疑似服务相关链接:`
            );

            for (const item of serviceLinks.slice(0, 30)) {
                this.log(
                    `   ${item.text || '(无文字)'} -> ${item.href}`
                );
            }
        } else {
            this.log('❌ 页面中没有发现 service 相关链接');
        }

        // 检查关键词
        const bodyText = $('body')
            .text()
            .replace(/\s+/g, ' ')
            .trim();

        const keywords = [
            'service',
            'services',
            'server',
            'servers',
            'renew',
            'dashboard',
            'invoice',
            'due date'
        ];

        for (const keyword of keywords) {
            if (
                bodyText
                    .toLowerCase()
                    .includes(keyword.toLowerCase())
            ) {
                this.log(`🔎 页面包含关键词: ${keyword}`);
            }
        }

        // 输出部分 HTML，方便定位页面结构
        const bodyHtml = $('body').html() || '';

        this.log(
            `🧩 Body HTML 前 3000 字符:\n${bodyHtml.substring(
                0,
                3000
            )}`
        );
    }

    async execute() {
        this.log('🔍 初始化 API 状态...');

        await SLEEP(2000, 3000);

        const dashRes = await this.request(
            'GET',
            '/dashboard'
        );

        if (dashRes.status !== 200) {
            throw new Error(
                `Dashboard 请求失败: HTTP ${dashRes.status}`
            );
        }

        if (
            dashRes.finalUrl &&
            dashRes.finalUrl.includes('/login')
        ) {
            throw new Error('登录态异常失效');
        }

        const $ = cheerio.load(dashRes.data);

        const title = $('title')
            .text()
            .trim()
            .toLowerCase();

        if (title.includes('just a moment')) {
            throw new Error('遇到 Cloudflare 拦截页面');
        }

        // ============================================================
        // CSRF
        // ============================================================

        this.csrfToken =
            $('meta[name="csrf-token"]').attr('content') ||
            $('meta[name="csrf_token"]').attr('content') ||
            $('input[name="_token"]').first().val() ||
            '';

        if (this.csrfToken) {
            this.log('🔐 CSRF Token 已获取');
        } else {
            this.log('⚠️ 未找到 CSRF Token');
        }

        // ============================================================
        // 服务发现
        // ============================================================

        const uniqueServices =
            this.discoverServices(dashRes.data);

        this.stats.total = uniqueServices.length;

        this.log(
            `✅ 发现 ${uniqueServices.length} 个服务`
        );

        // ============================================================
        // 发现 0 个服务时，不直接安静退出
        // ============================================================

        if (uniqueServices.length === 0) {
            await this.diagnoseDashboard(
                dashRes.data
            );

            return {
                stats: this.stats,
                newState: this.state,
                latestDueDate: null
            };
        }

        // 输出服务 ID 的 hash，避免日志暴露真实 ID
        for (const serviceId of uniqueServices) {
            const hash = crypto
                .createHash('md5')
                .update(String(serviceId))
                .digest('hex')
                .substring(0, 8);

            this.log(
                `🔎 服务 ID: [Hash-${hash}]`
            );
        }

        // ============================================================
        // 逐个处理
        // ============================================================

        for (const serviceId of uniqueServices) {
            try {
                const finalSvcDate =
                    await this.processService(serviceId);

                if (
                    finalSvcDate &&
                    finalSvcDate > this.latestDueDate
                ) {
                    this.latestDueDate = finalSvcDate;
                }
            } catch (error) {
                this.stats.failed++;

                this.log(
                    `❌ 服务处理失败: ${error.message}`
                );
            }
        }

        return {
            stats: this.stats,
            newState: this.state,
            latestDueDate:
                this.latestDueDate === 0
                    ? null
                    : this.latestDueDate
        };
    }

    async processService(serviceId) {
        await SLEEP(2000, 3000);

        const svcHash = crypto
            .createHash('md5')
            .update(String(serviceId))
            .digest('hex')
            .substring(0, 8);

        this.log(
            `>>> 处理服务: [Hash-${svcHash}]`
        );

        const res = await this.request(
            'GET',
            `/service/${serviceId}/manage`
        );

        if (res.status !== 200) {
            throw new Error(
                `服务页面 HTTP ${res.status}`
            );
        }

        if (
            res.finalUrl &&
            res.finalUrl.includes('/login')
        ) {
            throw new Error('服务页面登录态失效');
        }

        const $ = cheerio.load(res.data);

        const formToken =
            $('input[name="_token"]').first().val() ||
            this.csrfToken;

        const parsedDate =
            this.extractDate(res.data);

        if (parsedDate) {
            this.state[svcHash] = parsedDate;

            this.log(
                `📅 当前到期时间: ${new Date(
                    parsedDate
                ).toISOString()}`
            );
        } else {
            this.log(
                '⚠️ 未能从服务页面解析 Due Date'
            );
        }

        // ============================================================
        // 判断是否需要续期
        // ============================================================

        let needsRenew = true;

        if (this.state[svcHash]) {
            const remaining =
                this.state[svcHash] - Date.now();

            const remainingHours =
                remaining / 3600000;

            this.log(
                `⏱️ 剩余约 ${remainingHours.toFixed(
                    2
                )} 小时`
            );

            if (remaining > 86400000) {
                this.log(
                    '⏭️ 剩余时间 > 24H，无需续期'
                );

                this.stats.skipped++;
                needsRenew = false;
            }
        }

        if (!needsRenew) {
            return this.state[svcHash];
        }

        // ============================================================
        // 续期
        // ============================================================

        this.log(
            `📅 提交续期 (${RENEW_DAYS}天)...`
        );

        if (!formToken) {
            throw new Error(
                '没有找到续期所需的 CSRF Token'
            );
        }

        const params = new URLSearchParams({
            _token: formToken,
            days: String(RENEW_DAYS)
        });

        const renewRes = await this.request(
            'POST',
            `/service/${serviceId}/renew`,
            params.toString()
        );

        this.log(
            `📡 续期响应: HTTP ${renewRes.status}`
        );

        if (renewRes.finalUrl) {
            this.log(
                `➡️ 最终 URL: ${renewRes.finalUrl}`
            );
        }

        if (renewRes.status >= 400) {
            this.log(
                `⚠️ 续期请求失败:\n${renewRes.data.substring(
                    0,
                    1500
                )}`
            );

            this.stats.failed++;
            return this.state[svcHash];
        }

        let isPaid = false;

        if (
            renewRes.finalUrl &&
            renewRes.finalUrl.includes('/invoice/')
        ) {
            this.log(
                '⚡️ 续期成功，前往支付'
            );

            isPaid = await this.payFromHtml(
                renewRes.data,
                renewRes.finalUrl
            );
        } else {
            this.log(
                '⚠️ 续期未直接跳转，检查未支付账单...'
            );

            isPaid =
                await this.checkUnpaidInvoices(
                    serviceId
                );
        }

        if (isPaid) {
            this.stats.success++;

            this.log(
                '🔄 支付成功，重新刷新页面获取最新到期日...'
            );

            await SLEEP(2000, 3000);

            const refreshRes =
                await this.request(
                    'GET',
                    `/service/${serviceId}/manage`
                );

            const newDate =
                this.extractDate(
                    refreshRes.data
                );

            if (newDate) {
                this.state[svcHash] = newDate;

                this.log(
                    `✅ 新到期时间: ${new Date(
                        newDate
                    ).toISOString()}`
                );
            }
        } else {
            this.stats.failed++;

            this.log(
                '❌ 续期/支付没有完成'
            );
        }

        return this.state[svcHash];
    }

    async checkUnpaidInvoices(serviceId) {
        await SLEEP(1500, 2500);

        const res = await this.request(
            'GET',
            `/service/${serviceId}/invoices?where=unpaid`
        );

        if (res.status !== 200) {
            this.log(
                `⚠️ 查询账单失败: HTTP ${res.status}`
            );

            return false;
        }

        const $ = cheerio.load(res.data);

        const urls = new Set();

        $('a[href*="/invoice/"]').each(
            (i, el) => {
                const href =
                    $(el).attr('href');

                if (
                    href &&
                    !href.includes('download')
                ) {
                    urls.add(href);
                }
            }
        );

        if (urls.size === 0) {
            this.log(
                '⚪ 无未支付账单'
            );

            return false;
        }

        let paidAny = false;

        for (const url of urls) {
            this.log(
                '📄 打开并支付系统生成的账单...'
            );

            const invRes =
                await this.request(
                    'GET',
                    url
                );

            const success =
                await this.payFromHtml(
                    invRes.data,
                    invRes.finalUrl || url
                );

            if (success) {
                paidAny = true;
            }

            await SLEEP(2000, 3000);
        }

        return paidAny;
    }

    async payFromHtml(html, url) {
        const $ = cheerio.load(html);

        let targetForm = null;
        let action = '';

        // ============================================================
        // 找支付表单
        // ============================================================

        $('form').each((i, form) => {
            const btnText = $(form)
                .find('button, input[type="submit"]')
                .text()
                .trim()
                .toLowerCase();

            const act =
                $(form).attr('action') || '';

            const formText =
                $(form)
                    .text()
                    .trim()
                    .toLowerCase();

            if (
                (
                    btnText.includes('pay') ||
                    btnText.includes('pagar') ||
                    btnText.includes('支付') ||
                    formText.includes('pay invoice')
                ) &&
                act &&
                !act.includes('balance/add')
            ) {
                targetForm = $(form);
                action = act;

                return false;
            }
        });

        if (!targetForm) {
            this.log(
                '⚪ 页面未找到支付表单（可能已支付）'
            );

            return true;
        }

        const params =
            new URLSearchParams();

        targetForm.find('input').each(
            (i, el) => {
                const name =
                    $(el).attr('name');

                if (!name) return;

                const type =
                    ($(el).attr('type') || '')
                        .toLowerCase();

                if (
                    type === 'checkbox' &&
                    !$(el).is(':checked')
                ) {
                    return;
                }

                params.append(
                    name,
                    $(el).val() || ''
                );
            }
        );

        this.log('💳 提交支付...');

        const res =
            await this.request(
                'POST',
                action,
                params.toString()
            );

        if (
            res.status >= 200 &&
            res.status < 400
        ) {
            this.log(
                '✅ 支付请求提交成功'
            );

            return true;
        }

        this.log(
            `⚠️ 支付响应异常: ${res.status}`
        );

        return false;
    }
}

module.exports = {
    RenewManager
};
