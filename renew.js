const cheerio = require('cheerio');
const crypto = require('crypto');

const BASE_URL = 'https://dash.hidencloud.com';
const RENEW_DAYS = 10;

const DAY_MS = 24 * 60 * 60 * 1000;

const SLEEP = (min = 2000, max = 4000) =>
    new Promise(resolve =>
        setTimeout(
            resolve,
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
     * Cloudflare 验证处理
     *
     * 注意：
     * page.goto() 即使返回 403，也不能直接认为失败。
     * Cloudflare Challenge 可能需要浏览器继续执行 JS / Turnstile。
     */
    async handleCloudflare(maxWait = 60) {
        const page = this.page;

        for (let attempt = 1; attempt <= 3; attempt++) {
            this.log(`🛡️ Cloudflare 检测，第 ${attempt}/3 次...`);

            let challengeDetected = false;

            try {
                challengeDetected =
                    await page.locator(
                        'iframe[src*="challenges.cloudflare.com"]'
                    ).count() > 0;
            } catch (e) {
                challengeDetected = false;
            }

            const title = await page.title().catch(() => '');
            const url = page.url();

            /*
             * 如果没有 Challenge，而且不是 Just a moment，
             * 说明页面基本已经正常。
             */
            if (
                !challengeDetected &&
                !title.toLowerCase().includes('just a moment')
            ) {
                this.log('✅ 未检测到 Cloudflare 验证');
                return true;
            }

            this.log('⚠️ 检测到 Cloudflare 验证，等待验证完成...');

            /*
             * 尝试处理 Turnstile checkbox
             */
            try {
                const iframe = page
                    .locator('iframe[src*="challenges.cloudflare.com"]')
                    .first();

                if (await iframe.count()) {
                    const frame = page.frameLocator(
                        'iframe[src*="challenges.cloudflare.com"]'
                    );

                    const checkbox = frame
                        .locator('input[type="checkbox"]')
                        .first();

                    const visible = await checkbox
                        .isVisible({ timeout: 3000 })
                        .catch(() => false);

                    if (visible) {
                        this.log('☑️ 找到 Cloudflare checkbox，尝试点击...');

                        await checkbox
                            .click({
                                force: true,
                                timeout: 10000
                            })
                            .then(() => {
                                this.log('✅ checkbox 点击完成');
                            })
                            .catch(err => {
                                this.log(
                                    `⚠️ checkbox 点击失败: ${err.message}`
                                );
                            });
                    } else {
                        this.log(
                            'ℹ️ 未找到可见 checkbox，等待 Cloudflare 自动验证...'
                        );
                    }
                }
            } catch (e) {
                this.log(
                    `⚠️ Cloudflare iframe 处理异常: ${e.message}`
                );
            }

            /*
             * 持续等待 Cloudflare
             */
            for (let sec = 1; sec <= maxWait; sec++) {
                await page.waitForTimeout(1000);

                const currentUrl = page.url();
                const currentTitle = await page
                    .title()
                    .catch(() => '');

                let iframeCount = 0;

                try {
                    iframeCount = await page.locator(
                        'iframe[src*="challenges.cloudflare.com"]'
                    ).count();
                } catch (e) {
                    iframeCount = 0;
                }

                /*
                 * Challenge iframe 消失，同时 Title 已经不是
                 * Just a moment
                 */
                if (
                    iframeCount === 0 &&
                    !currentTitle
                        .toLowerCase()
                        .includes('just a moment')
                ) {
                    this.log(
                        `✅ Cloudflare 验证完成，用时 ${sec} 秒`
                    );

                    return true;
                }

                /*
                 * 检查 HidenCloud 页面内容。
                 */
                try {
                    const bodyText = await page
                        .locator('body')
                        .innerText({
                            timeout: 2000
                        });

                    const lower = bodyText.toLowerCase();

                    if (
                        lower.includes('dashboard') ||
                        lower.includes('services') ||
                        lower.includes('free server') ||
                        lower.includes('due date')
                    ) {
                        this.log(
                            `✅ 检测到 HidenCloud 页面内容，验证已通过`
                        );

                        return true;
                    }
                } catch (e) {}

                if (sec % 10 === 0) {
                    this.log(
                        `⏳ Cloudflare 验证中... ` +
                        `${sec}/${maxWait}s ` +
                        `Title="${currentTitle}"`
                    );
                }
            }

            this.log(
                `⚠️ 第 ${attempt} 次 Cloudflare 验证等待超时`
            );

            /*
             * 如果第一次 / 第二次失败，重新加载页面。
             */
            if (attempt < 3) {
                this.log(
                    '🔄 Cloudflare 验证超时，重新加载页面...'
                );

                await page
                    .reload({
                        waitUntil: 'domcontentloaded',
                        timeout: 60000
                    })
                    .catch(err => {
                        this.log(
                            `⚠️ reload 异常: ${err.message}`
                        );
                    });

                await page.waitForTimeout(5000);
            }
        }

        this.log('❌ Cloudflare 验证最终未完成');

        return false;
    }

    /**
     * 打开页面并处理 Cloudflare
     */
    async gotoPage(url, options = {}) {
        const page = this.page;

        this.log(`🌐 打开页面: ${url}`);

        let response = null;

        try {
            response = await page.goto(url, {
                waitUntil: options.waitUntil || 'domcontentloaded',
                timeout: options.timeout || 60000
            });
        } catch (e) {
            this.log(`⚠️ page.goto 异常: ${e.message}`);
        }

        if (response) {
            this.log(
                `📡 HTTP: ${response.status()}`
            );
        }

        this.log(`📍 当前 URL: ${page.url()}`);

        await page.waitForTimeout(3000);

        /*
         * 不管第一次 HTTP 是 200 还是 403，
         * 都交给 Cloudflare 处理。
         */
        const cfPassed = await this.handleCloudflare();

        if (!cfPassed) {
            this.log(`📍 当前 URL: ${page.url()}`);

            const title = await page.title().catch(() => '');
            this.log(`📌 当前 Title: ${title}`);

            throw new Error('Cloudflare 验证未完成');
        }

        return response;
    }

    /**
     * 从页面 HTML 提取 CSRF
     */
    updateCsrf(html) {
        try {
            const $ = cheerio.load(html);

            const token =
                $('meta[name="csrf-token"]').attr('content') ||
                $('input[name="_token"]').first().val() ||
                '';

            if (token) {
                this.csrfToken = token;
            }

            return this.csrfToken;
        } catch (e) {
            return this.csrfToken;
        }
    }

    /**
     * 提取服务 ID
     */
    extractServiceIds(html) {
        const ids = new Set();

        /*
         * /service/123/manage
         */
        const regex1 =
            /\/service\/(\d+)\/manage/gi;

        let match;

        while ((match = regex1.exec(html)) !== null) {
            ids.add(match[1]);
        }

        /*
         * /service/123
         */
        const regex2 =
            /\/service\/(\d+)(?:["'?#\/]|$)/gi;

        while ((match = regex2.exec(html)) !== null) {
            ids.add(match[1]);
        }

        /*
         * data-service-id="123"
         */
        const regex3 =
            /data-service-id=["'](\d+)["']/gi;

        while ((match = regex3.exec(html)) !== null) {
            ids.add(match[1]);
        }

        /*
         * Free Server #123456
         */
        const regex4 =
            /Free\s+Server\s+#(\d{4,})/gi;

        while ((match = regex4.exec(html)) !== null) {
            ids.add(match[1]);
        }

        return [...ids];
    }

    /**
     * Dashboard 检查
     */
    async getDashboard() {
        const page = this.page;

        await this.gotoPage(
            `${BASE_URL}/dashboard`
        );

        await page.waitForTimeout(2000);

        const url = page.url();
        const title = await page.title().catch(() => '');

        if (
            url.includes('/auth/login') ||
            url.includes('/login')
        ) {
            throw new Error('登录态异常失效');
        }

        if (
            title.toLowerCase().includes('just a moment')
        ) {
            throw new Error('Cloudflare 验证未完成');
        }

        const html = await page.content();

        this.updateCsrf(html);

        return html;
    }

    /**
     * 获取服务 ID
     */
    async getServiceIds() {
        this.log('🔍 获取 HidenCloud 服务列表...');

        const html = await this.getDashboard();

        let serviceIds =
            this.extractServiceIds(html);

        serviceIds = [
            ...new Set(serviceIds)
        ];

        this.log(
            `✅ 发现 ${serviceIds.length} 个服务`
        );

        if (serviceIds.length > 0) {
            this.log(
                `📋 服务 ID: ${serviceIds.join(', ')}`
            );
        }

        return serviceIds;
    }

    /**
     * 从服务页面提取到期日期
     */
    extractDate(html) {
        const $ = cheerio.load(html);

        let dueDateText = '';

        /*
         * 原项目的 h6 -> 下一个 div
         */
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

        /*
         * 如果上面的结构没找到，
         * 从整个页面文本提取。
         */
        if (!dueDateText) {
            const bodyText = $('body')
                .text()
                .replace(/\s+/g, ' ')
                .trim();

            const patterns = [
                /Due\s*date\s*:?\s*(\d{1,2}\s+[A-Za-z]{3}\s+\d{4})/i,
                /Due\s*date\s+(\d{1,2}\s+[A-Za-z]{3}\s+\d{4})/i,
                /Due\s*date.*?(\d{1,2}\s+[A-Za-z]{3}\s+\d{4})/i
            ];

            for (const pattern of patterns) {
                const match = bodyText.match(pattern);

                if (match) {
                    dueDateText = match[1];
                    break;
                }
            }
        }

        if (!dueDateText) {
            return null;
        }

        /*
         * HidenCloud 页面日期格式例如：
         * 03 Sep 2026
         */
        const timestamp = Date.parse(
            `${dueDateText} 00:00:00 GMT`
        );

        if (!Number.isNaN(timestamp)) {
            return timestamp;
        }

        /*
         * 再尝试浏览器本地解析
         */
        const timestamp2 =
            Date.parse(dueDateText);

        if (!Number.isNaN(timestamp2)) {
            return timestamp2;
        }

        return null;
    }

    /**
     * 获取服务页面
     */
    async getService(serviceId) {
        const url =
            `${BASE_URL}/service/${serviceId}/manage`;

        await this.gotoPage(url);

        await this.page.waitForTimeout(2000);

        const html =
            await this.page.content();

        this.updateCsrf(html);

        return {
            html,
            date: this.extractDate(html)
        };
    }

    /**
     * 获取页面上的按钮
     */
    async findButtonByText(text) {
        const page = this.page;

        const selectors = [
            `button:has-text("${text}")`,
            `a:has-text("${text}")`,
            `[role="button"]:has-text("${text}")`
        ];

        for (const selector of selectors) {
            const locator = page.locator(selector);

            const count =
                await locator.count().catch(() => 0);

            if (count === 0) {
                continue;
            }

            for (let i = 0; i < count; i++) {
                const item = locator.nth(i);

                const visible =
                    await item.isVisible().catch(() => false);

                if (!visible) {
                    continue;
                }

                return item;
            }
        }

        return null;
    }

    /**
     * 检查当前页面是否出现指定文字
     */
    async pageContains(text) {
        try {
            const body =
                await this.page.locator('body').innerText({
                    timeout: 3000
                });

            return body
                .toLowerCase()
                .includes(text.toLowerCase());
        } catch (e) {
            return false;
        }
    }

    /**
     * 支付 Invoice
     */
    async payInvoice() {
        const page = this.page;

        this.log('💳 查找 Pay 按钮...');

        /*
         * 先等待页面稳定
         */
        await page.waitForTimeout(2000);

        const payButton =
            await this.findButtonByText('Pay');

        if (!payButton) {
            /*
             * 有些情况下账单可能已经支付。
             */
            if (
                await this.pageContains('paid')
            ) {
                this.log(
                    '✅ Invoice 已经支付'
                );
                return true;
            }

            this.log(
                '⚠️ 未找到 Pay 按钮'
            );

            return false;
        }

        this.log('💳 点击 Pay...');

        try {
            await payButton.click({
                timeout: 15000
            });
        } catch (e) {
            this.log(
                `⚠️ Pay 点击失败: ${e.message}`
            );

            /*
             * 尝试 force
             */
            try {
                await payButton.click({
                    force: true,
                    timeout: 10000
                });
            } catch (e2) {
                this.log(
                    `❌ Pay 强制点击也失败: ${e2.message}`
                );

                return false;
            }
        }

        /*
         * 等待支付请求完成
         */
        await page.waitForTimeout(5000);

        /*
         * Cloudflare 如果重新出现，处理。
         */
        const cfPassed =
            await this.handleCloudflare(45);

        if (!cfPassed) {
            return false;
        }

        /*
         * 检查常见成功文字
         */
        const successWords = [
            'payment successful',
            'paid successfully',
            'invoice paid',
            'payment completed',
            'successfully paid'
        ];

        for (const word of successWords) {
            if (await this.pageContains(word)) {
                this.log(
                    `✅ 检测到支付成功: ${word}`
                );
                return true;
            }
        }

        /*
         * 如果已经离开 invoice 页面，
         * 一般也代表支付流程完成。
         */
        const currentUrl = page.url();

        if (
            !currentUrl.includes('/payment/invoice/') &&
            !currentUrl.includes('/invoice/')
        ) {
            this.log(
                `✅ 已离开 Invoice 页面: ${currentUrl}`
            );

            return true;
        }

        /*
         * 最后再检查是否出现 Pay。
         */
        const stillPay =
            await this.findButtonByText('Pay');

        if (!stillPay) {
            this.log(
                '✅ Pay 按钮已消失，推测支付成功'
            );

            return true;
        }

        this.log(
            '⚠️ 支付结果无法确认'
        );

        return false;
    }

    /**
     * 创建 Invoice
     */
    async createInvoice() {
        const page = this.page;

        this.log(
            '🧾 等待 Create Invoice...'
        );

        /*
         * 最长等待 30 秒
         */
        for (let i = 0; i < 30; i++) {
            const button =
                await this.findButtonByText(
                    'Create Invoice'
                );

            if (button) {
                this.log(
                    '🧾 找到 Create Invoice，点击...'
                );

                try {
                    await button.click({
                        timeout: 15000
                    });
                } catch (e) {
                    this.log(
                        `⚠️ Create Invoice 点击失败: ${e.message}`
                    );

                    try {
                        await button.click({
                            force: true,
                            timeout: 10000
                        });
                    } catch (e2) {
                        this.log(
                            `❌ 强制点击也失败: ${e2.message}`
                        );
                        return false;
                    }
                }

                await page.waitForTimeout(3000);

                /*
                 * Cloudflare
                 */
                const cfPassed =
                    await this.handleCloudflare(60);

                if (!cfPassed) {
                    return false;
                }

                return true;
            }

            await page.waitForTimeout(1000);
        }

        /*
         * 如果页面已经进入 invoice，
         * 说明 Create Invoice 可能已经完成。
         */
        const currentUrl = page.url();

        if (
            currentUrl.includes('/payment/invoice/') ||
            currentUrl.includes('/invoice/')
        ) {
            this.log(
                '✅ 已进入 Invoice 页面'
            );

            return true;
        }

        this.log(
            '❌ 未找到 Create Invoice'
        );

        return false;
    }

    /**
     * 续期单个服务
     */
    async renewService(serviceId) {
        const page = this.page;

        const serviceUrl =
            `${BASE_URL}/service/${serviceId}/manage`;

        this.log(
            `🔄 开始续期服务: ${serviceId}`
        );

        /*
         * 打开服务页面
         */
        await this.gotoPage(serviceUrl);

        await page.waitForTimeout(2000);

        /*
         * 先检查是否限制续期
         */
        if (
            await this.pageContains(
                'Renewal Restricted'
            ) ||
            await this.pageContains(
                'can only renew'
            )
        ) {
            this.log(
                '⛔ 当前服务暂时不允许续期'
            );

            return false;
        }

        /*
         * 查找 Renew
         */
        let renewButton = null;

        for (let retry = 1; retry <= 3; retry++) {
            renewButton =
                await this.findButtonByText('Renew');

            if (renewButton) {
                break;
            }

            this.log(
                `⏳ 未找到 Renew，等待重试 ${retry}/3...`
            );

            await page.waitForTimeout(2000);
        }

        if (!renewButton) {
            this.log(
                '⚠️ 未找到 Renew 按钮'
            );

            return false;
        }

        /*
         * 点击 Renew
         */
        this.log(
            `📅 提交续期 (${RENEW_DAYS}天)...`
        );

        try {
            await renewButton.click({
                timeout: 15000
            });
        } catch (e) {
            this.log(
                `⚠️ Renew 点击失败: ${e.message}`
            );

            try {
                await renewButton.click({
                    force: true,
                    timeout: 10000
                });
            } catch (e2) {
                this.log(
                    `❌ Renew 强制点击失败: ${e2.message}`
                );

                return false;
            }
        }

        await page.waitForTimeout(3000);

        /*
         * 检查 Cloudflare
         */
        if (!(await this.handleCloudflare(60))) {
            return false;
        }

        /*
         * 检查是否续期受限
         */
        if (
            await this.pageContains(
                'Renewal Restricted'
            ) ||
            await this.pageContains(
                'can only renew'
            )
        ) {
            this.log(
                '⛔ HidenCloud 返回续期限制'
            );

            return false;
        }

        /*
         * 等待 Create Invoice
         */
        const invoiceCreated =
            await this.createInvoice();

        if (!invoiceCreated) {
            return false;
        }

        /*
         * 等待进入支付页面
         */
        for (let i = 0; i < 90; i++) {
            const currentUrl = page.url();

            if (
                currentUrl.includes('/payment/invoice/') ||
                currentUrl.includes('/invoice/')
            ) {
                this.log(
                    `⚡️ 已进入 Invoice: ${currentUrl}`
                );
                break;
            }

            /*
             * 有时候点击后页面还没有立即跳转，
             * 检查当前页面是否已经有 Pay。
             */
            const pay =
                await this.findButtonByText('Pay');

            if (pay) {
                this.log(
                    '💳 已检测到 Pay 按钮'
                );
                break;
            }

            await page.waitForTimeout(1000);

            if (i > 0 && i % 15 === 0) {
                this.log(
                    `⏳ 等待 Invoice 页面... ${i}/90s`
                );
            }
        }

        /*
         * Cloudflare
         */
        if (!(await this.handleCloudflare(60))) {
            return false;
        }

        /*
         * 支付
         */
        const paid =
            await this.payInvoice();

        if (!paid) {
            this.log(
                '❌ Invoice 支付失败或无法确认'
            );

            return false;
        }

        /*
         * 支付完成以后返回服务页面
         */
        this.log(
            '🔄 支付完成，重新打开服务页面检查到期日...'
        );

        await SLEEP(3000, 5000);

        await this.gotoPage(serviceUrl);

        await page.waitForTimeout(3000);

        const html =
            await page.content();

        const newDate =
            this.extractDate(html);

        if (newDate) {
            const dateString =
                new Date(newDate).toISOString();

            this.log(
                `📅 最新到期时间: ${dateString}`
            );

            const oldDate =
                this.state[
                    this.getServiceHash(serviceId)
                ];

            if (
                oldDate &&
                newDate <= oldDate
            ) {
                this.log(
                    '⚠️ 到期时间没有增加，暂不认为续期完全成功'
                );
            } else {
                this.log(
                    '✅ 到期时间已更新'
                );
            }

            this.state[
                this.getServiceHash(serviceId)
            ] = newDate;

            if (newDate > this.latestDueDate) {
                this.latestDueDate = newDate;
            }
        } else {
            this.log(
                '⚠️ 支付完成，但未能解析新的 Due Date'
            );
        }

        return true;
    }

    /**
     * 服务 ID → 状态 Hash
     */
    getServiceHash(serviceId) {
        return crypto
            .createHash('md5')
            .update(String(serviceId))
            .digest('hex')
            .substring(0, 8);
    }

    /**
     * 处理单个服务
     */
    async processService(serviceId) {
        await SLEEP(2000, 3500);

        const svcHash =
            this.getServiceHash(serviceId);

        this.log(
            `>>> 处理服务: [Hash-${svcHash}]`
        );

        /*
         * 先打开服务页面获取当前到期时间
         */
        let serviceInfo;

        try {
            serviceInfo =
                await this.getService(serviceId);
        } catch (e) {
            this.log(
                `❌ 获取服务页面失败: ${e.message}`
            );

            this.stats.failed++;

            return null;
        }

        const parsedDate =
            serviceInfo.date;

        if (parsedDate) {
            this.state[svcHash] =
                parsedDate;

            const dateString =
                new Date(parsedDate).toISOString();

            this.log(
                `📅 当前到期时间: ${dateString}`
            );
        } else {
            this.log(
                '⚠️ 当前页面未找到 Due Date'
            );
        }

        /*
         * 判断是否超过 24 小时
         */
        let needsRenew = true;

        if (this.state[svcHash]) {
            const remaining =
                this.state[svcHash] -
                Date.now();

            const remainingHours =
                remaining / (60 * 60 * 1000);

            if (remaining > DAY_MS) {
                this.log(
                    `⏭️ 剩余时间约 ${remainingHours.toFixed(1)} 小时，超过 24H，无需续期。`
                );

                this.stats.skipped++;

                needsRenew = false;
            } else {
                this.log(
                    `⚠️ 剩余时间约 ${remainingHours.toFixed(1)} 小时，需要续期。`
                );
            }
        } else {
            this.log(
                '⚠️ 无历史到期时间，继续检查续期按钮。'
            );
        }

        if (!needsRenew) {
            return this.state[svcHash];
        }

        /*
         * 执行续期
         */
        const success =
            await this.renewService(serviceId);

        if (success) {
            this.stats.success++;

            /*
             * 如果 renewService 没有拿到日期，
             * 再刷新一次。
             */
            if (!this.state[svcHash]) {
                try {
                    await SLEEP(2000, 3000);

                    const refreshed =
                        await this.getService(
                            serviceId
                        );

                    if (refreshed.date) {
                        this.state[svcHash] =
                            refreshed.date;

                        if (
                            refreshed.date >
                            this.latestDueDate
                        ) {
                            this.latestDueDate =
                                refreshed.date;
                        }
                    }
                } catch (e) {
                    this.log(
                        `⚠️ 刷新服务日期失败: ${e.message}`
                    );
                }
            }

            return this.state[svcHash] || null;
        }

        this.stats.failed++;

        return this.state[svcHash] || null;
    }

    /**
     * 主执行流程
     */
    async execute() {
        this.log(
            '🔍 初始化 HidenCloud 服务检查...'
        );

        await SLEEP(2000, 3000);

        /*
         * 获取服务列表
         */
        const serviceIds =
            await this.getServiceIds();

        this.stats.total =
            serviceIds.length;

        if (serviceIds.length === 0) {
            this.log(
                '⚠️ Dashboard 没有发现服务'
            );

            return {
                stats: this.stats,
                newState: this.state,
                latestDueDate: null
            };
        }

        /*
         * 逐个处理
         */
        for (const serviceId of serviceIds) {
            try {
                await this.processService(
                    serviceId
                );
            } catch (e) {
                this.log(
                    `❌ 服务 ${serviceId} 处理异常: ${e.message}`
                );

                this.stats.failed++;
            }

            await SLEEP(2000, 4000);
        }

        /*
         * 最新到期时间
         */
        if (this.latestDueDate === 0) {
            const dates =
                Object.values(this.state)
                    .filter(v =>
                        typeof v === 'number' &&
                        !Number.isNaN(v)
                    );

            if (dates.length > 0) {
                this.latestDueDate =
                    Math.max(...dates);
            }
        }

        this.log(
            '==========================================='
        );

        this.log(
            `📊 总服务数: ${this.stats.total}`
        );

        this.log(
            `✅ 成功续期: ${this.stats.success}`
        );

        this.log(
            `⏭️ 跳过续期: ${this.stats.skipped}`
        );

        this.log(
            `❌ 失败数量: ${this.stats.failed}`
        );

        if (this.latestDueDate) {
            this.log(
                `📅 最新到期: ${new Date(
                    this.latestDueDate
                ).toISOString()}`
            );
        }

        this.log(
            '==========================================='
        );

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

module.exports = { RenewManager };
