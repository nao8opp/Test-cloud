const cheerio = require('cheerio');
const crypto = require('crypto');

const BASE_URL = 'https://dash.hidencloud.com';
const RENEW_DAYS = 10;

const SLEEP = (min = 2000, max = 4000) =>
    new Promise(resolve => {
        const delay =
            Math.floor(Math.random() * (max - min + 1)) + min;
        setTimeout(resolve, delay);
    });

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

    log(message) {
        console.log(`[${this.maskedUser}] ${message}`);
    }

    /**
     * ============================================================
     * Cloudflare 检测
     * ============================================================
     *
     * 参考 Python 版本 handle_cloudflare()
     */
    async handleCloudflare(timeout = 90000) {
        const startTime = Date.now();

        const iframeSelector =
            'iframe[src*="challenges.cloudflare.com"]';

        let detected = false;

        try {
            detected =
                await this.page.locator(
                    iframeSelector
                ).count() > 0;
        } catch {
            detected = false;
        }

        if (!detected) {
            // 有些情况下 Cloudflare challenge 不一定立即表现为 iframe
            const title =
                (await this.page.title()).toLowerCase();

            const bodyText =
                (
                    await this.page.locator('body').innerText()
                ).toLowerCase();

            if (
                title.includes('just a moment') ||
                bodyText.includes('verify you are human') ||
                bodyText.includes('checking your browser') ||
                bodyText.includes('performing security verification')
            ) {
                detected = true;
            }
        }

        if (!detected) {
            return true;
        }

        this.log('⚠️ 检测到 Cloudflare 验证，等待验证完成...');

        while (Date.now() - startTime < timeout) {
            try {
                const count =
                    await this.page.locator(
                        iframeSelector
                    ).count();

                if (count === 0) {
                    const title =
                        (await this.page.title()).toLowerCase();

                    if (
                        !title.includes('just a moment')
                    ) {
                        this.log(
                            '✅ Cloudflare 验证页面已消失'
                        );

                        await SLEEP(2000, 3000);
                        return true;
                    }
                }

                // 尝试检测 challenge iframe
                if (count > 0) {
                    try {
                        const frame =
                            this.page.frameLocator(
                                iframeSelector
                            );

                        const checkbox =
                            frame.locator(
                                'input[type="checkbox"]'
                            );

                        if (
                            await checkbox.isVisible({
                                timeout: 1000
                            })
                        ) {
                            this.log(
                                '🖱️ 检测到 Cloudflare 验证控件'
                            );

                            await checkbox.click({
                                timeout: 5000
                            });

                            this.log(
                                '⏳ 已尝试验证，等待 Cloudflare...'
                            );
                        }
                    } catch {
                        // Cloudflare 不一定使用可点击 checkbox
                    }
                }
            } catch {
                // 页面正在跳转时忽略
            }

            await SLEEP(1000, 2000);
        }

        this.log('❌ Cloudflare 验证等待超时');

        try {
            await this.page.screenshot({
                path: `cloudflare_timeout_${Date.now()}.png`,
                fullPage: true
            });
        } catch {}

        return false;
    }

    /**
     * ============================================================
     * 打开页面
     * ============================================================
     */
    async goto(url, timeout = 60000) {
        const targetUrl =
            url.startsWith('http')
                ? url
                : `${BASE_URL}${url}`;

        this.log(`🌐 打开页面: ${targetUrl}`);

        try {
            await this.page.goto(
                targetUrl,
                {
                    waitUntil: 'domcontentloaded',
                    timeout
                }
            );
        } catch (error) {
            /*
             * Cloudflare / 页面导航过程中可能出现 timeout，
             * 不立即退出，继续检查当前页面。
             */
            this.log(
                `⚠️ 页面导航提示: ${error.message}`
            );
        }

        // 给 Cloudflare / 页面 JS 一点启动时间
        await SLEEP(1500, 2500);

        // 重要：和 Python 版本一样
        await this.handleCloudflare();

        // 再等待页面稳定
        await SLEEP(1500, 2500);

        return {
            url: this.page.url(),
            title: await this.page.title(),
            html: await this.page.content()
        };
    }

    /**
     * ============================================================
     * Dashboard
     * ============================================================
     */
    async getDashboard() {
        const result =
            await this.goto('/dashboard');

        this.log(
            `📍 当前 URL: ${result.url}`
        );

        this.log(
            `📌 当前 Title: ${result.title}`
        );

        this.log(
            `📊 页面长度: ${result.html.length}`
        );

        if (
            result.url.includes('/auth/login') ||
            result.url.includes('/login')
        ) {
            throw new Error(
                '登录态异常失效'
            );
        }

        const title =
            result.title.toLowerCase();

        if (
            title.includes('just a moment')
        ) {
            throw new Error(
                'Cloudflare 验证未完成'
            );
        }

        if (
            result.html.includes(
                'cf-chl-'
            )
        ) {
            throw new Error(
                'Cloudflare Challenge 仍未完成'
            );
        }

        return result.html;
    }

    /**
     * ============================================================
     * 从 Dashboard 获取服务 ID
     *
     * 参考你的 Python：
     *
     * 1. /service/123/manage
     * 2. #218079
     * ============================================================
     */
    discoverServices(html) {
        const $ = cheerio.load(html);

        const services = new Set();

        // ========================================================
        // 方法 1
        // /service/123/manage
        // ========================================================

        const manageMatches =
            html.match(
                /\/service\/(\d+)\/manage/gi
            );

        if (manageMatches) {
            for (const item of manageMatches) {
                const match =
                    item.match(
                        /\/service\/(\d+)\/manage/i
                    );

                if (match) {
                    services.add(match[1]);
                }
            }
        }

        // ========================================================
        // 方法 2
        // 任意 /service/123
        // ========================================================

        const serviceMatches =
            html.match(
                /\/service\/(\d+)(?:\/|["'?#])/gi
            );

        if (serviceMatches) {
            for (const item of serviceMatches) {
                const match =
                    item.match(
                        /\/service\/(\d+)/i
                    );

                if (match) {
                    services.add(match[1]);
                }
            }
        }

        // ========================================================
        // 方法 3
        // #218079
        // ========================================================

        const numberMatches =
            html.match(
                /#(\d{4,})/g
            );

        if (numberMatches) {
            for (const item of numberMatches) {
                const match =
                    item.match(
                        /#(\d{4,})/
                    );

                if (match) {
                    services.add(match[1]);
                }
            }
        }

        // ========================================================
        // 方法 4
        // data-service-id
        // ========================================================

        $('[data-service-id]').each(
            (i, el) => {
                const id =
                    $(el).attr(
                        'data-service-id'
                    );

                if (
                    id &&
                    /^\d+$/.test(id)
                ) {
                    services.add(id);
                }
            }
        );

        return [...services];
    }

    /**
     * ============================================================
     * 服务发现失败诊断
     * ============================================================
     */
    async diagnose(html) {
        const $ = cheerio.load(html);

        this.log('❌ Dashboard 中没有找到 Server ID');

        this.log(
            `📄 当前 URL: ${this.page.url()}`
        );

        this.log(
            `📌 页面 Title: ${await this.page.title()}`
        );

        this.log(
            `📊 HTML 长度: ${html.length}`
        );

        const serviceLinks = [];

        $('a[href]').each((i, el) => {
            const href =
                $(el).attr('href');

            const text =
                $(el)
                    .text()
                    .trim();

            if (
                href &&
                href.toLowerCase().includes('service')
            ) {
                serviceLinks.push({
                    text,
                    href
                });
            }
        });

        if (serviceLinks.length > 0) {
            this.log(
                `🔎 找到 ${serviceLinks.length} 个 service 链接`
            );

            for (
                const item
                of serviceLinks.slice(0, 30)
            ) {
                this.log(
                    `   ${item.text || '(无文字)'} -> ${item.href}`
                );
            }
        } else {
            this.log(
                '❌ 没有找到 service 链接'
            );
        }

        // 输出页面中的 #数字
        const ids =
            html.match(/#\d{4,}/g);

        if (ids && ids.length) {
            this.log(
                `🔎 页面发现疑似 Server ID: ${
                    [...new Set(ids)]
                        .slice(0, 30)
                        .join(', ')
                }`
            );
        }

        try {
            await this.page.screenshot({
                path: 'dashboard_debug.png',
                fullPage: true
            });

            this.log(
                '📸 已保存 dashboard_debug.png'
            );
        } catch {}
    }

    /**
     * ============================================================
     * 提取到期时间
     * ============================================================
     */
    extractDate(html) {
        const $ = cheerio.load(html);

        let dueDateText = '';

        // 原始结构
        $('h6').each((i, el) => {
            const title =
                $(el)
                    .text()
                    .trim()
                    .toLowerCase();

            if (
                title === 'due date'
            ) {
                dueDateText =
                    $(el)
                        .next('div')
                        .text()
                        .trim();
            }
        });

        // Python 版本使用 body.inner_text()
        // 这里也使用相同思路
        if (!dueDateText) {
            const bodyText =
                $('body')
                    .text()
                    .replace(/\s+/g, ' ')
                    .trim();

            const patterns = [
                /Due date\s+(\d{1,2}\s+[A-Za-z]{3}\s+\d{4})/i,
                /Due date\s*\n?\s*(\d{1,2}\s+[A-Za-z]{3}\s+\d{4})/i,
                /Due date.*?(\d{1,2}\s+[A-Za-z]{3}\s+\d{4})/i
            ];

            for (const pattern of patterns) {
                const match =
                    bodyText.match(
                        pattern
                    );

                if (match) {
                    dueDateText =
                        match[1].trim();
                    break;
                }
            }
        }

        if (!dueDateText) {
            return null;
        }

        let timestamp =
            Date.parse(
                `${dueDateText} 00:00:00 GMT`
            );

        if (!isNaN(timestamp)) {
            return timestamp;
        }

        timestamp =
            Date.parse(
                dueDateText
            );

        if (!isNaN(timestamp)) {
            return timestamp;
        }

        return null;
    }

    /**
     * ============================================================
     * 获取服务页面
     * ============================================================
     */
    async getService(serviceId) {
        const result =
            await this.goto(
                `/service/${serviceId}/manage`
            );

        if (
            result.url.includes('/login') ||
            result.url.includes('/auth/login')
        ) {
            throw new Error(
                '服务页面登录态失效'
            );
        }

        return result;
    }

    /**
     * ============================================================
     * 处理服务
     * ============================================================
     */
    async processService(serviceId) {
        await SLEEP(2000, 3500);

        const svcHash =
            crypto
                .createHash('md5')
                .update(String(serviceId))
                .digest('hex')
                .substring(0, 8);

        this.log(
            `>>> 处理服务: [Hash-${svcHash}]`
        );

        const result =
            await this.getService(
                serviceId
            );

        const html =
            result.html;

        const $ =
            cheerio.load(html);

        const parsedDate =
            this.extractDate(html);

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
                '⚠️ 无法解析 Due Date'
            );
        }

        // ========================================================
        // 判断是否需要续期
        // ========================================================

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

                return this.state[
                    svcHash
                ];
            }
        }

        // ========================================================
        // 查找 Renew 按钮
        // ========================================================

        this.log(
            "🖱️ 准备查找 'Renew' 按钮..."
        );

        const renewButton =
            this.page.locator(
                'button:has-text("Renew"), a:has-text("Renew")'
            ).first;

        try {
            await renewButton.waitFor({
                state: 'visible',
                timeout: 15000
            });
        } catch {
            this.log(
                "❌ 未找到 'Renew' 按钮"
            );

            await this.page.screenshot({
                path: `renew_button_missing_${svcHash}.png`,
                fullPage: true
            });

            this.stats.failed++;

            return this.state[
                svcHash
            ];
        }

        await renewButton.scrollIntoViewIfNeeded();

        this.log(
            "🖱️ 点击 'Renew'..."
        );

        await renewButton.click();

        await SLEEP(1500, 2500);

        // ========================================================
        // 检查 Renewal Restricted
        // ========================================================

        const pageText =
            (
                await this.page.locator(
                    'body'
                ).innerText()
            ).toLowerCase();

        if (
            pageText.includes(
                'renewal restricted'
            ) ||
            pageText.includes(
                'can only renew'
            )
        ) {
            this.log(
                '⏳ 当前尚未到允许续期时间'
            );

            this.stats.skipped++;

            return this.state[
                svcHash
            ];
        }

        // ========================================================
        // Create Invoice
        // ========================================================

        this.log(
            "🔎 查找 'Create Invoice'..."
        );

        const createInvoice =
            this.page.locator(
                'button:has-text("Create Invoice"), a:has-text("Create Invoice")'
            ).first;

        try {
            await createInvoice.waitFor({
                state: 'visible',
                timeout: 15000
            });
        } catch {
            this.log(
                "❌ 'Create Invoice' 按钮没有出现"
            );

            await this.page.screenshot({
                path: `invoice_modal_failed_${svcHash}.png`,
                fullPage: true
            });

            this.stats.failed++;

            return this.state[
                svcHash
            ];
        }

        this.log(
            "🖱️ 点击 'Create Invoice'..."
        );

        await createInvoice.click();

        // ========================================================
        // 等待 Invoice 页面
        // ========================================================

        let invoiceReady = false;

        const start =
            Date.now();

        while (
            Date.now() - start <
            90000
        ) {
            await this.handleCloudflare(
                15000
            );

            const currentUrl =
                this.page.url();

            if (
                currentUrl.includes(
                    '/payment/invoice/'
                ) ||
                currentUrl.includes(
                    '/invoice/'
                )
            ) {
                invoiceReady = true;

                this.log(
                    `🎉 已进入账单页面: ${currentUrl}`
                );

                break;
            }

            await SLEEP(
                1000,
                2000
            );
        }

        if (!invoiceReady) {
            this.log(
                '❌ 90 秒内没有进入 Invoice 页面'
            );

            await this.page.screenshot({
                path: `invoice_timeout_${svcHash}.png`,
                fullPage: true
            });

            this.stats.failed++;

            return this.state[
                svcHash
            ];
        }

        // ========================================================
        // 查找 Pay
        // ========================================================

        await this.handleCloudflare();

        this.log(
            "🔎 查找 'Pay' 按钮..."
        );

        const payButton =
            this.page.locator(
                'a:has-text("Pay"):visible, button:has-text("Pay"):visible'
            ).first;

        try {
            await payButton.waitFor({
                state: 'visible',
                timeout: 30000
            });
        } catch {
            this.log(
                "❌ 未找到 'Pay' 按钮"
            );

            await this.page.screenshot({
                path: `pay_button_missing_${svcHash}.png`,
                fullPage: true
            });

            this.stats.failed++;

            return this.state[
                svcHash
            ];
        }

        await payButton.scrollIntoViewIfNeeded();

        this.log(
            "🖱️ 点击 'Pay'..."
        );

        await payButton.click();

        await SLEEP(4000, 6000);

        await this.handleCloudflare();

        // ========================================================
        // 回到服务页面
        // ========================================================

        this.log(
            '🔄 返回服务管理页面...'
        );

        const refresh =
            await this.getService(
                serviceId
            );

        const newDate =
            this.extractDate(
                refresh.html
            );

        if (newDate) {
            this.state[svcHash] =
                newDate;

            this.log(
                `🎉 新到期时间: ${new Date(
                    newDate
                ).toISOString()}`
            );
        }

        this.stats.success++;

        this.log(
            '✅ 服务续期流程完成'
        );

        return this.state[
            svcHash
        ];
    }

    /**
     * ============================================================
     * 主流程
     * ============================================================
     */
    async execute() {
        this.log(
            '🔍 初始化 API 状态...'
        );

        await SLEEP(
            2000,
            3000
        );

        const html =
            await this.getDashboard();

        // ========================================================
        // CSRF
        // ========================================================

        const $ =
            cheerio.load(html);

        this.csrfToken =
            $('meta[name="csrf-token"]')
                .attr('content') ||
            $('input[name="_token"]')
                .first()
                .val() ||
            '';

        if (this.csrfToken) {
            this.log(
                '🔐 CSRF Token 已获取'
            );
        }

        // ========================================================
        // 获取 Server ID
        // ========================================================

        const services =
            this.discoverServices(
                html
            );

        this.stats.total =
            services.length;

        this.log(
            `✅ 发现 ${services.length} 个服务`
        );

        if (
            services.length === 0
        ) {
            await this.diagnose(
                html
            );

            return {
                stats: this.stats,
                newState: this.state,
                latestDueDate: null
            };
        }

        // ========================================================
        // 逐个续期
        // ========================================================

        for (
            const serviceId
            of services
        ) {
            try {
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
                    `❌ 服务处理异常: ${error.message}`
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
}

module.exports = {
    RenewManager
};
