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

    /**
     * 浏览器导航获取页面
     *
     * 不再使用 page.evaluate(fetch(...))
     * 请求 Dashboard，避免 HidenCloud 返回 403。
     */
    async getPage(url, options = {}) {
        const targetUrl = url.startsWith('http')
            ? url
            : `https://dash.hidencloud.com${url.startsWith('/') ? '' : '/'}${url}`;

        this.log(`🌐 打开页面: ${targetUrl}`);

        try {
            const response = await this.page.goto(
                targetUrl,
                {
                    waitUntil: 'domcontentloaded',
                    timeout: options.timeout || 60000
                }
            );

            await SLEEP(1500, 2500);

            const html = await this.page.content();

            return {
                status: response ? response.status() : 200,
                finalUrl: this.page.url(),
                data: html
            };
        } catch (error) {
            throw new Error(
                `页面访问失败: ${error.message}`
            );
        }
    }

    /**
     * POST 请求
     *
     * POST 仍然通过浏览器上下文发送，
     * 保留 Cookie / Session。
     */
    async postPage(url, data = '') {
        const targetUrl = url.startsWith('http')
            ? url
            : `https://dash.hidencloud.com${url.startsWith('/') ? '' : '/'}${url}`;

        return await this.page.evaluate(
            async ({ url, data, csrfToken }) => {
                const headers = {
                    'Content-Type':
                        'application/x-www-form-urlencoded; charset=UTF-8',
                    'Accept':
                        'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
                };

                if (csrfToken) {
                    headers['X-CSRF-TOKEN'] = csrfToken;
                }

                const res = await fetch(
                    url,
                    {
                        method: 'POST',
                        headers,
                        body: data,
                        credentials: 'include',
                        redirect: 'follow'
                    }
                );

                return {
                    status: res.status,
                    finalUrl: res.url,
                    data: await res.text()
                };
            },
            {
                url: targetUrl,
                data,
                csrfToken: this.csrfToken
            }
        );
    }

    extractDate(html) {
        const $ = cheerio.load(html);

        let dueDateText = '';

        $('h6').each((i, el) => {
            const text = $(el)
                .text()
                .trim()
                .toLowerCase();

            if (text === 'due date') {
                dueDateText = $(el)
                    .next('div')
                    .text()
                    .trim();
            }
        });

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
                    const next = $(el)
                        .next()
                        .text()
                        .trim();

                    if (next) {
                        dueDateText = next;
                    }
                }
            });
        }

        if (!dueDateText) {
            return null;
        }

        let timestamp = Date.parse(
            `${dueDateText} 00:00:00 GMT`
        );

        if (!isNaN(timestamp)) {
            return timestamp;
        }

        timestamp = Date.parse(dueDateText);

        if (!isNaN(timestamp)) {
            return timestamp;
        }

        return null;
    }

    /**
     * 服务发现
     */
    discoverServices(html) {
        const $ = cheerio.load(html);
        const services = new Set();

        // 1. href
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

        // 2. data-service-id
        $('[data-service-id]').each((i, el) => {
            const id = $(el).attr('data-service-id');

            if (id && /^\d+$/.test(id)) {
                services.add(id);
            }
        });

        // 3. data-id
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

        // 4. HTML 正则
        const matches = html.match(
            /\/service\/(\d+)(?:\/manage|\/|["'?#])/gi
        );

        if (matches) {
            for (const item of matches) {
                const match =
                    item.match(/\/service\/(\d+)/i);

                if (match) {
                    services.add(match[1]);
                }
            }
        }

        return [...services];
    }

    async diagnoseDashboard(html) {
        const $ = cheerio.load(html);

        this.log('⚠️ Dashboard 没有发现服务');

        this.log(
            `📄 当前 URL: ${this.page.url()}`
        );

        this.log(
            `📊 HTML 长度: ${html.length}`
        );

        this.log(
            `📌 页面标题: ${
                $('title').text().trim() || '(空)'
            }`
        );

        const links = [];

        $('a[href]').each((i, el) => {
            const href = $(el).attr('href');
            const text = $(el)
                .text()
                .trim();

            if (
                href &&
                (
                    href.toLowerCase().includes('service') ||
                    text.toLowerCase().includes('service') ||
                    text.includes('服务')
                )
            ) {
                links.push({
                    text: text.substring(0, 100),
                    href
                });
            }
        });

        if (links.length) {
            this.log(
                `🔎 找到 ${links.length} 个服务相关链接`
            );

            for (const item of links.slice(0, 30)) {
                this.log(
                    `   ${item.text || '(无文字)'} -> ${item.href}`
                );
            }
        } else {
            this.log(
                '❌ 没有发现 service 相关链接'
            );
        }

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
                    .includes(keyword)
            ) {
                this.log(
                    `🔎 页面包含关键词: ${keyword}`
                );
            }
        }
    }

    async execute() {
        this.log('🔍 初始化 API 状态...');

        await SLEEP(2000, 3000);

        // ============================================================
        // 重要：
        // 不再 request('GET', '/dashboard')
        // 改为真实浏览器导航
        // ============================================================

        const dashRes = await this.getPage(
            '/dashboard'
        );

        this.log(
            `📡 Dashboard HTTP: ${dashRes.status}`
        );

        this.log(
            `📍 Dashboard 最终 URL: ${dashRes.finalUrl}`
        );

        // 登录失效
        if (
            dashRes.finalUrl.includes('/login')
        ) {
            throw new Error(
                '登录态异常失效'
            );
        }

        const $ = cheerio.load(
            dashRes.data
        );

        const title = $('title')
            .text()
            .trim()
            .toLowerCase();

        // Cloudflare
        if (
            title.includes('just a moment') ||
            dashRes.data.includes(
                'cf-chl-'
            )
        ) {
            throw new Error(
                'Dashboard 遇到 Cloudflare 拦截'
            );
        }

        if (
            dashRes.status >= 400
        ) {
            throw new Error(
                `Dashboard 请求失败: HTTP ${dashRes.status}`
            );
        }

        // ============================================================
        // CSRF
        // ============================================================

        this.csrfToken =
            $('meta[name="csrf-token"]').attr(
                'content'
            ) ||
            $('meta[name="csrf_token"]').attr(
                'content'
            ) ||
            $('input[name="_token"]')
                .first()
                .val() ||
            '';

        if (this.csrfToken) {
            this.log(
                '🔐 CSRF Token 获取成功'
            );
        } else {
            this.log(
                '⚠️ 未找到 CSRF Token'
            );
        }

        // ============================================================
        // 服务发现
        // ============================================================

        const services =
            this.discoverServices(
                dashRes.data
            );

        this.stats.total =
            services.length;

        this.log(
            `✅ 发现 ${services.length} 个服务`
        );

        if (services.length === 0) {
            await this.diagnoseDashboard(
                dashRes.data
            );

            return {
                stats: this.stats,
                newState: this.state,
                latestDueDate: null
            };
        }

        // ============================================================
        // 服务逐个处理
        // ============================================================

        for (const serviceId of services) {
            try {
                const hash = crypto
                    .createHash('md5')
                    .update(String(serviceId))
                    .digest('hex')
                    .substring(0, 8);

                this.log(
                    `🔎 发现服务 [Hash-${hash}]`
                );

                const finalDate =
                    await this.processService(
                        serviceId
                    );

                if (
                    finalDate &&
                    finalDate >
                        this.latestDueDate
                ) {
                    this.latestDueDate =
                        finalDate;
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

        // ============================================================
        // 服务管理页面也使用真实浏览器导航
        // ============================================================

        const res = await this.getPage(
            `/service/${serviceId}/manage`
        );

        if (
            res.finalUrl.includes('/login')
        ) {
            throw new Error(
                '服务页面登录态失效'
            );
        }

        if (res.status >= 400) {
            throw new Error(
                `服务页面 HTTP ${res.status}`
            );
        }

        const $ = cheerio.load(
            res.data
        );

        const formToken =
            $('input[name="_token"]')
                .first()
                .val() ||
            this.csrfToken;

        const parsedDate =
            this.extractDate(
                res.data
            );

        if (parsedDate) {
            this.state[svcHash] =
                parsedDate;

            this.log(
                `📅 当前到期时间: ${new Date(
                    parsedDate
                ).toISOString()}`
            );
        } else {
            this.log(
                '⚠️ 未找到 Due Date'
            );
        }

        // ============================================================
        // 判断续期
        // ============================================================

        let needsRenew = true;

        if (this.state[svcHash]) {
            const remaining =
                this.state[svcHash] -
                Date.now();

            const hours =
                remaining / 3600000;

            this.log(
                `⏱️ 剩余约 ${hours.toFixed(
                    2
                )} 小时`
            );

            if (
                remaining >
                86400000
            ) {
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
                '没有找到续期 CSRF Token'
            );
        }

        const params =
            new URLSearchParams({
                _token: formToken,
                days: String(
                    RENEW_DAYS
                )
            });

        const renewRes =
            await this.postPage(
                `/service/${serviceId}/renew`,
                params.toString()
            );

        this.log(
            `📡 续期响应: HTTP ${renewRes.status}`
        );

        this.log(
            `➡️ 最终 URL: ${renewRes.finalUrl}`
        );

        if (
            renewRes.status >= 400
        ) {
            this.log(
                `⚠️ 续期失败:\n${renewRes.data.substring(
                    0,
                    1500
                )}`
            );

            this.stats.failed++;

            return this.state[
                svcHash
            ];
        }

        let isPaid = false;

        if (
            renewRes.finalUrl &&
            renewRes.finalUrl.includes(
                '/invoice/'
            )
        ) {
            this.log(
                '⚡️ 续期成功，进入账单'
            );

            isPaid =
                await this.payFromHtml(
                    renewRes.data,
                    renewRes.finalUrl
                );
        } else {
            this.log(
                '⚠️ 未直接跳转账单，检查未支付账单...'
            );

            isPaid =
                await this.checkUnpaidInvoices(
                    serviceId
                );
        }

        if (isPaid) {
            this.stats.success++;

            this.log(
                '🔄 支付成功，重新获取到期日期...'
            );

            await SLEEP(2000, 3000);

            const refreshRes =
                await this.getPage(
                    `/service/${serviceId}/manage`
                );

            const newDate =
                this.extractDate(
                    refreshRes.data
                );

            if (newDate) {
                this.state[svcHash] =
                    newDate;

                this.log(
                    `✅ 新到期时间: ${new Date(
                        newDate
                    ).toISOString()}`
                );
            }
        } else {
            this.stats.failed++;

            this.log(
                '❌ 续期或支付未完成'
            );
        }

        return this.state[
            svcHash
        ];
    }

    async checkUnpaidInvoices(serviceId) {
        await SLEEP(1500, 2500);

        const res =
            await this.getPage(
                `/service/${serviceId}/invoices?where=unpaid`
            );

        if (res.status >= 400) {
            this.log(
                `⚠️ 查询账单失败: HTTP ${res.status}`
            );

            return false;
        }

        const $ = cheerio.load(
            res.data
        );

        const urls = new Set();

        $('a[href*="/invoice/"]').each(
            (i, el) => {
                const href =
                    $(el).attr('href');

                if (
                    href &&
                    !href.includes(
                        'download'
                    )
                ) {
                    urls.add(href);
                }
            }
        );

        if (urls.size === 0) {
            this.log(
                '⚪ 没有未支付账单'
            );

            return false;
        }

        let paidAny = false;

        for (const url of urls) {
            this.log(
                '📄 打开未支付账单...'
            );

            const invRes =
                await this.getPage(
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
        const $ = cheerio.load(
            html
        );

        let targetForm = null;
        let action = '';

        $('form').each(
            (i, form) => {
                const btnText =
                    $(form)
                        .find(
                            'button, input[type="submit"]'
                        )
                        .text()
                        .trim()
                        .toLowerCase();

                const formText =
                    $(form)
                        .text()
                        .trim()
                        .toLowerCase();

                const act =
                    $(form).attr(
                        'action'
                    ) || '';

                if (
                    (
                        btnText.includes(
                            'pay'
                        ) ||
                        btnText.includes(
                            '支付'
                        ) ||
                        formText.includes(
                            'pay invoice'
                        )
                    ) &&
                    act &&
                    !act.includes(
                        'balance/add'
                    )
                ) {
                    targetForm =
                        $(form);

                    action = act;

                    return false;
                }
            }
        );

        if (!targetForm) {
            this.log(
                '⚪ 未找到支付表单（可能已经支付）'
            );

            return true;
        }

        const params =
            new URLSearchParams();

        targetForm
            .find('input')
            .each((i, el) => {
                const name =
                    $(el).attr(
                        'name'
                    );

                if (!name) return;

                const type =
                    (
                        $(el).attr(
                            'type'
                        ) || ''
                    ).toLowerCase();

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
            });

        this.log(
            '💳 提交支付...'
        );

        const res =
            await this.postPage(
                action,
                params.toString()
            );

        if (
            res.status >= 200 &&
            res.status < 400
        ) {
            this.log(
                '✅ 支付请求成功'
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
