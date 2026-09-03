async handleCloudflare(maxWait = 60) {
    const page = this.page;

    for (let attempt = 1; attempt <= 3; attempt++) {
        this.log(`🛡️ Cloudflare 检测，第 ${attempt}/3 次...`);

        let challengeDetected = false;

        try {
            challengeDetected = await page.locator(
                'iframe[src*="challenges.cloudflare.com"]'
            ).count() > 0;
        } catch (e) {
            challengeDetected = false;
        }

        const title = await page.title().catch(() => '');
        const url = page.url();

        if (!challengeDetected &&
            !title.includes('Just a moment')) {
            this.log('✅ 未检测到 Cloudflare 验证');
            return true;
        }

        this.log('⚠️ 检测到 Cloudflare 验证，尝试处理...');

        // 尝试点击 Cloudflare Turnstile checkbox
        try {
            const iframe = page.locator(
                'iframe[src*="challenges.cloudflare.com"]'
            ).first();

            if (await iframe.count()) {
                const frame = page.frameLocator(
                    'iframe[src*="challenges.cloudflare.com"]'
                );

                const checkbox = frame.locator(
                    'input[type="checkbox"]'
                ).first();

                if (await checkbox.isVisible({ timeout: 3000 }).catch(() => false)) {
                    this.log('☑️ 找到 Cloudflare checkbox，尝试点击...');

                    await checkbox.click({
                        force: true,
                        timeout: 10000
                    }).catch(err => {
                        this.log(`⚠️ checkbox 点击失败: ${err.message}`);
                    });
                } else {
                    this.log('ℹ️ 未找到可见 checkbox，继续等待 Cloudflare 自动验证...');
                }
            }
        } catch (e) {
            this.log(`⚠️ Cloudflare iframe 处理异常: ${e.message}`);
        }

        // 等待验证
        for (let sec = 1; sec <= maxWait; sec++) {
            await page.waitForTimeout(1000);

            const currentUrl = page.url();
            const currentTitle = await page.title().catch(() => '');

            let iframeCount = 0;

            try {
                iframeCount = await page.locator(
                    'iframe[src*="challenges.cloudflare.com"]'
                ).count();
            } catch (e) {}

            // Challenge 已消失
            if (
                iframeCount === 0 &&
                !currentTitle.includes('Just a moment')
            ) {
                this.log(`✅ Cloudflare 验证完成，用时 ${sec} 秒`);
                return true;
            }

            // 有时候 Cloudflare 已经放行，但 title 更新比较慢
            try {
                const bodyText = await page.locator('body').innerText({
                    timeout: 2000
                });

                if (
                    bodyText.includes('Dashboard') ||
                    bodyText.includes('Services') ||
                    bodyText.includes('Free Server')
                ) {
                    this.log(`✅ 检测到 HidenCloud 页面内容，验证已通过`);
                    return true;
                }
            } catch (e) {}

            if (sec % 10 === 0) {
                this.log(
                    `⏳ Cloudflare 验证中... ${sec}/${maxWait}s ` +
                    `Title="${currentTitle}"`
                );
            }
        }

        this.log(`⚠️ 第 ${attempt} 次 Cloudflare 验证超时`);

        // 最后一次不再刷新
        if (attempt < 3) {
            this.log('🔄 Cloudflare 验证超时，重新加载页面...');

            await page.reload({
                waitUntil: 'domcontentloaded',
                timeout: 60000
            }).catch(err => {
                this.log(`⚠️ reload 异常: ${err.message}`);
            });

            await page.waitForTimeout(5000);
        }
    }

    this.log('❌ Cloudflare 验证最终未完成');

    return false;
}
