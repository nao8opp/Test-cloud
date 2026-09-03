const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const axios = require('axios');
const nodemailer = require('nodemailer');

const { performLogin } = require('./login.js');
const { RenewManager } = require('./renew.js');

chromium.use(stealth);

const STATE_FILE = './state.json';
const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const DEBUG_PORT = 9222;


// ============================================================
// 邮箱脱敏
// ============================================================

function maskEmail(email) {
    if (!email || !email.includes('@')) return '***';

    const [name, domain] = email.split('@');

    const maskedName =
        name.length > 3
            ? name.substring(0, 3) + '***'
            : name + '***';

    const tld =
        domain.includes('.')
            ? domain.split('.').pop()
            : 'com';

    return `${maskedName}@***.${tld}`;
}


// ============================================================
// IP 脱敏
// ============================================================

function maskIP(ip) {
    if (!ip) return '***.***.***.***';

    const parts = ip.trim().split('.');

    return parts.length === 4
        ? `${parts[0]}.${parts[1]}.***.***`
        : '***';
}


// ============================================================
// 日期格式
// ============================================================

function formatDate(timestamp) {
    if (!timestamp) return '未知';

    try {
        return new Date(timestamp)
            .toISOString()
            .split('T')[0];
    } catch (e) {
        return '未知';
    }
}


// ============================================================
// 获取账号
// ============================================================

function getAccounts() {
    const accounts = [];

    for (const key in process.env) {

        const match = key.match(/^HIDEN_ACCOUNT_(\d+)$/);

        if (!match) continue;

        const id = match[1];

        const [username, password] =
            (process.env[key] || '')
                .trim()
                .split(/\s+/);

        if (username && password) {

            accounts.push({
                id,
                username,
                password,

                proxyUrl:
                    process.env[`PROXY_URL_${id}`] || null,

                proxyLock:
                    process.env[`PROXY_LOCK_${id}`] !== 'false',

                cookies:
                    process.env[`HIDEN_COOKIES_${id}`] || null
            });
        }
    }

    // 按账号 ID 排序
    accounts.sort((a, b) => {
        return Number(a.id) - Number(b.id);
    });

    return accounts;
}


// ============================================================
// SMTP 配置
// ============================================================

function getSmtpConfig() {

    const str = process.env.SMTP_CONFIG;

    if (!str) return null;

    // JSON
    try {
        return JSON.parse(str.trim());
    } catch (e) {}

    // JS Object
    try {
        const obj = eval(`(${str.trim()})`);

        if (obj && obj.host) {
            return obj;
        }
    } catch (e) {}

    // 普通字符串解析
    try {

        const hostMatch =
            str.match(/host['"]?\s*:\s*['"]([^'"]+)['"]/i) ||
            str.match(/host\s*:\s*([^,\s}]+)/i);

        const portMatch =
            str.match(/port['"]?\s*:\s*(\d+)/i);

        const userMatch =
            str.match(/user['"]?\s*:\s*['"]([^'"]+)['"]/i) ||
            str.match(/user\s*:\s*([^,\s}]+)/i);

        const passMatch =
            str.match(/pass['"]?\s*:\s*['"]([^'"]+)['"]/i) ||
            str.match(/pass\s*:\s*([^,\s}]+)/i);

        if (hostMatch && userMatch && passMatch) {

            return {
                host: hostMatch[1],
                port: portMatch
                    ? parseInt(portMatch[1])
                    : 587,
                user: userMatch[1],
                pass: passMatch[1]
            };
        }

    } catch (e) {}

    return null;
}


// ============================================================
// 保存 Cookie 到 GitHub Actions Variables
// ============================================================

async function saveCookieToGitHub(id, cookiesArr) {

    if (!process.env.GH_PAT ||
        !process.env.GITHUB_REPO) {
        return;
    }

    try {

        const varName =
            `HIDEN_COOKIES_${id}`;

        const headers = {
            'Accept':
                'application/vnd.github+json',

            'Authorization':
                `Bearer ${process.env.GH_PAT}`,

            'X-GitHub-Api-Version':
                '2022-11-28'
        };

        const apiUrl =
            `https://api.github.com/repos/${process.env.GITHUB_REPO}/actions/variables`;

        let exists = false;

        try {

            await axios.get(
                `${apiUrl}/${varName}`,
                { headers }
            );

            exists = true;

        } catch (e) {}

        if (exists) {

            await axios.patch(
                `${apiUrl}/${varName}`,
                {
                    name: varName,
                    value: JSON.stringify(cookiesArr)
                },
                { headers }
            );

        } else {

            await axios.post(
                apiUrl,
                {
                    name: varName,
                    value: JSON.stringify(cookiesArr)
                },
                { headers }
            );
        }

        console.log(
            `✅ 已自动保存 Cookie 至变量: ${varName}`
        );

    } catch (e) {

        console.error(
            `❌ 保存 Cookie 失败:`,
            e.message
        );
    }
}


// ============================================================
// Telegram / Email 通知
// ============================================================

async function sendNotifications(summaryArr) {

    let mdText =
        `☁️ *HidenCloud 自动续期报告*\n` +
        `━━━━━━━━━━━━━━━━━━\n`;

    let htmlText =
        `<div style="font-family: Arial, sans-serif; max-width: 650px; margin: auto; border: 1px solid #e0e0e0; border-radius: 10px; overflow: hidden; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">
        <div style="background-color: #2c3e50; padding: 20px; text-align: center;">
            <h2 style="color: #ffffff; margin: 0; font-size: 24px;">☁️ HidenCloud 自动续期</h2>
        </div>
        <div style="padding: 20px; background: #fcfcfc;">`;

    summaryArr.forEach(s => {

        mdText +=
            `👤 **账号**: \`${s.user}\`\n`;

        mdText +=
            `🔑 **登录**: ${s.loginMethod}\n`;

        if (s.status.includes('Failed')) {

            mdText +=
                `❌ **异常**: ${s.status}\n`;

        } else {

            mdText +=
                `⚡ **续期**: ` +
                `${s.stats.success} 成功 / ` +
                `${s.stats.skipped} 未到期 / ` +
                `${s.stats.failed} 失败\n`;

            mdText +=
                `📅 **到期**: ${formatDate(s.latestDate)}\n`;
        }

        mdText +=
            `━━━━━━━━━━━━━━━━━━\n`;


        htmlText +=
            `<div style="background: #ffffff; padding: 15px; border-radius: 8px; margin-bottom: 15px; border-left: 5px solid ${s.status.includes('Failed') ? '#e74c3c' : '#2ecc71'}; box-shadow: 0 2px 4px rgba(0,0,0,0.05);">

            <p style="margin: 5px 0; font-size: 16px;">
                👤 <b>账号:</b> ${s.user}
            </p>

            <p style="margin: 5px 0; font-size: 15px; color: #7f8c8d;">
                🔑 <b>登录:</b> ${s.loginMethod}
            </p>`;

        if (s.status.includes('Failed')) {

            htmlText +=
                `<p style="margin: 5px 0; font-size: 15px; color: #e74c3c;">
                    ❌ <b>异常:</b> ${s.status}
                </p>`;

        } else {

            htmlText +=
                `<p style="margin: 5px 0; font-size: 15px;">
                    ⚡ <b>续期:</b>

                    <span style="color: #27ae60; font-weight: bold;">
                        ${s.stats.success} 成功
                    </span> /

                    <span style="color: #f39c12;">
                        ${s.stats.skipped} 未到期
                    </span> /

                    <span style="color: #c0392b;">
                        ${s.stats.failed} 失败
                    </span>
                </p>

                <p style="margin: 5px 0; font-size: 15px;">
                    📅 <b>最新到期:</b>

                    <span style="color: #2980b9; font-weight: bold;">
                        ${formatDate(s.latestDate)}
                    </span>
                </p>`;
        }

        htmlText += `</div>`;
    });

    htmlText +=
        `</div></div>`;


    // ========================================================
    // Telegram
    // ========================================================

    if (
        process.env.TG_TOKEN &&
        process.env.TG_CHAT
    ) {

        try {

            await axios.post(
                `https://api.telegram.org/bot${process.env.TG_TOKEN}/sendMessage`,
                {
                    chat_id: process.env.TG_CHAT,
                    text: mdText,
                    parse_mode: 'Markdown'
                }
            );

            console.log('✅ Telegram 通知已发送');

        } catch (e) {

            console.error(
                '⚠️ Telegram 通知发送失败:',
                e.message
            );
        }
    }


    // ========================================================
    // Email
    // ========================================================

    const smtp = getSmtpConfig();

    if (
        smtp &&
        process.env.EMAIL_CHAT
    ) {

        try {

            const isSecure =
                smtp.port === 465;

            const transporter =
                nodemailer.createTransport({
                    host: smtp.host,
                    port: smtp.port,
                    secure: isSecure,
                    requireTLS: !isSecure,

                    auth: {
                        user: smtp.user,
                        pass: smtp.pass
                    },

                    tls: {
                        rejectUnauthorized: false
                    }
                });

            await transporter.sendMail({

                from:
                    `"HidenCloud" <${smtp.user}>`,

                to:
                    process.env.EMAIL_CHAT,

                subject:
                    "☁️ HidenCloud 自动续期报告",

                html:
                    htmlText
            });

            console.log('✅ 邮件通知已发送');

        } catch (e) {

            console.error(
                '❌ 邮件发送异常:',
                e.message
            );
        }
    }
}


// ============================================================
// Chrome 检测
// ============================================================

function checkChromeExecutable() {

    console.log('===========================================');
    console.log('🔍 检查 Chrome');
    console.log('===========================================');

    console.log(`Chrome 路径: ${CHROME_PATH}`);

    if (!fs.existsSync(CHROME_PATH)) {

        throw new Error(
            `Chrome 不存在: ${CHROME_PATH}`
        );
    }

    try {

        const version =
            execSync(
                `"${CHROME_PATH}" --version`,
                {
                    encoding: 'utf8',
                    timeout: 10000
                }
            ).trim();

        console.log(`✅ ${version}`);

    } catch (e) {

        throw new Error(
            `Chrome 无法执行: ${e.message}`
        );
    }
}


// ============================================================
// 启动 Chrome
// ============================================================

async function startChrome(useProxy, userDataDir) {

    checkChromeExecutable();

    // 清理旧 Chrome
    try {

        execSync(
            `pkill -f "remote-debugging-port=${DEBUG_PORT}" || true`
        );

    } catch (e) {}

    // 删除旧用户目录
    try {

        if (fs.existsSync(userDataDir)) {
            fs.rmSync(
                userDataDir,
                {
                    recursive: true,
                    force: true
                }
            );
        }

    } catch (e) {

        console.log(
            `⚠️ 清理 Chrome 用户目录失败: ${e.message}`
        );
    }

    fs.mkdirSync(
        userDataDir,
        {
            recursive: true
        }
    );


    // Chrome 启动参数
    const args = [

        '--headless=new',

        '--no-sandbox',

        '--disable-setuid-sandbox',

        '--disable-dev-shm-usage',

        '--disable-gpu',

        '--disable-software-rasterizer',

        '--disable-extensions',

        '--disable-background-networking',

        '--disable-background-timer-throttling',

        '--disable-renderer-backgrounding',

        '--disable-backgrounding-occluded-windows',

        '--disable-breakpad',

        '--disable-component-update',

        '--disable-features=Translate,BackForwardCache',

        '--disable-popup-blocking',

        '--disable-notifications',

        '--no-first-run',

        '--no-default-browser-check',

        '--password-store=basic',

        '--use-mock-keychain',

        '--window-size=1920,1080',

        `--remote-debugging-port=${DEBUG_PORT}`,

        '--remote-debugging-address=127.0.0.1',

        `--user-data-dir=${userDataDir}`,

        'about:blank'
    ];


    // 代理
    if (useProxy) {

        args.push(
            '--proxy-server=http://127.0.0.1:8080'
        );

        console.log(
            '🌐 Chrome 使用代理: 127.0.0.1:8080'
        );

    } else {

        console.log(
            '🌐 Chrome 使用直连模式'
        );
    }


    console.log('');
    console.log('===========================================');
    console.log('🚀 启动 Chrome');
    console.log('===========================================');

    console.log(
        `Chrome: ${CHROME_PATH}`
    );

    console.log(
        `CDP: http://127.0.0.1:${DEBUG_PORT}`
    );


    // Chrome 日志
    const chromeLog =
        path.join(
            os.tmpdir(),
            'hidencloud-chrome.log'
        );

    try {

        if (fs.existsSync(chromeLog)) {
            fs.unlinkSync(chromeLog);
        }

    } catch (e) {}


    const logFd =
        fs.openSync(
            chromeLog,
            'a'
        );


    let chromeProcess;

    try {

        chromeProcess =
            spawn(
                CHROME_PATH,
                args,
                {
                    detached: false,

                    stdio: [
                        'ignore',
                        logFd,
                        logFd
                    ]
                }
            );

    } catch (e) {

        throw new Error(
            `Chrome spawn 失败: ${e.message}`
        );
    }


    chromeProcess.on(
        'error',
        err => {
            console.error(
                `❌ Chrome 进程错误: ${err.message}`
            );
        }
    );


    // ========================================================
    // 等待 Chrome CDP
    // 最长 60 秒
    // ========================================================

    console.log(
        '⏳ 等待 Chrome CDP 服务启动...'
    );

    let ready = false;

    for (
        let k = 0;
        k < 60;
        k++
    ) {

        // Chrome 是否已经退出
        if (chromeProcess.exitCode !== null) {

            console.error(
                `❌ Chrome 已退出，exitCode=${chromeProcess.exitCode}`
            );

            break;
        }

        try {

            const response =
                await axios.get(
                    `http://127.0.0.1:${DEBUG_PORT}/json/version`,
                    {
                        timeout: 2000
                    }
                );

            if (
                response.status === 200 &&
                response.data
            ) {

                ready = true;

                console.log(
                    `✅ Chrome CDP 已启动 (${k + 1}s)`
                );

                break;
            }

        } catch (e) {

            if (
                k === 0 ||
                k === 4 ||
                k === 9 ||
                k === 19 ||
                k === 29 ||
                k === 44
            ) {

                console.log(
                    `⏳ Chrome 尚未就绪... ${k + 1}/60 秒`
                );
            }
        }

        await new Promise(
            resolve =>
                setTimeout(resolve, 1000)
        );
    }


    if (!ready) {

        console.error('');
        console.error(
            '==========================================='
        );

        console.error(
            '❌ Chrome 启动超时'
        );

        console.error(
            '==========================================='
        );


        // 输出 Chrome 日志
        try {

            if (fs.existsSync(chromeLog)) {

                console.error('');
                console.error(
                    '========== Chrome 日志 =========='
                );

                const log =
                    fs.readFileSync(
                        chromeLog,
                        'utf8'
                    );

                console.error(
                    log.slice(-10000)
                );
            }

        } catch (e) {

            console.error(
                `读取 Chrome 日志失败: ${e.message}`
            );
        }


        try {

            chromeProcess.kill(
                'SIGKILL'
            );

        } catch (e) {}


        throw new Error(
            'Chrome 启动超时'
        );
    }


    return chromeProcess;
}


// ============================================================
// 主程序
// ============================================================

(async () => {

    const accounts =
        getAccounts();


    // ========================================================
    // 检查账号
    // ========================================================

    if (accounts.length === 0) {

        console.log(
            '❌ 未检测到任何 HIDEN_ACCOUNT_X 环境变量'
        );

        return;
    }


    console.log('');
    console.log(
        `✅ 检测到 ${accounts.length} 个 HidenCloud 账号`
    );


    // ========================================================
    // 读取状态
    // ========================================================

    let globalState = {};

    if (
        fs.existsSync(STATE_FILE)
    ) {

        try {

            globalState =
                JSON.parse(
                    fs.readFileSync(
                        STATE_FILE,
                        'utf8'
                    )
                );

        } catch (e) {

            console.log(
                `⚠️ state.json 读取失败，重新创建: ${e.message}`
            );

            globalState = {};
        }
    }


    const summary = [];


    // ========================================================
    // 逐个处理账号
    // ========================================================

    for (const acc of accounts) {

        const maskedUsername =
            maskEmail(acc.username);

        const accKey =
            `ACCOUNT_${acc.id}`;


        console.log('');
        console.log(
            '==========================================='
        );

        console.log(
            `▶ 开始处理账号: ${maskedUsername} (ID: ${acc.id})`
        );

        console.log(
            '==========================================='
        );


        let singBoxProcess = null;

        let useProxy = false;

        let currentLoginMethod = '未知';

        let browser = null;

        let chromeProcess = null;

        let page = null;


        // ====================================================
        // 启动代理
        // ====================================================

        if (acc.proxyUrl) {

            console.log(
                `🌐 解析代理 PROXY_URL_${acc.id}...`
            );

            try {

                process.env.PROXY_URL =
                    acc.proxyUrl;


                // proxyurl.js 根据 PROXY_URL
                // 生成 config.json
                execSync(
                    'node proxyurl.js',
                    {
                        stdio: 'pipe'
                    }
                );


                if (
                    !fs.existsSync('config.json')
                ) {

                    throw new Error(
                        'proxyurl.js 未生成 config.json'
                    );
                }


                if (
                    !fs.existsSync('./sing-box')
                ) {

                    throw new Error(
                        './sing-box 不存在'
                    );
                }


                // 确保可执行
                try {

                    fs.chmodSync(
                        './sing-box',
                        0o755
                    );

                } catch (e) {}


                console.log(
                    '⚙️ 启动 sing-box...'
                );


                const logStream =
                    fs.openSync(
                        `./singbox_${acc.id}.log`,
                        'a'
                    );


                singBoxProcess =
                    spawn(
                        './sing-box',
                        [
                            'run',
                            '-c',
                            'config.json'
                        ],
                        {
                            detached: true,

                            stdio: [
                                'ignore',
                                logStream,
                                logStream
                            ]
                        }
                    );


                singBoxProcess.unref();


                await new Promise(
                    resolve =>
                        setTimeout(
                            resolve,
                            3000
                        )
                );


                // 检查进程是否退出
                if (
                    singBoxProcess.exitCode !== null
                ) {

                    throw new Error(
                        `sing-box 启动失败，exitCode=${singBoxProcess.exitCode}`
                    );
                }


                useProxy = true;


                console.log(
                    '✅ 代理本地映射成功 (127.0.0.1:8080)'
                );


            } catch (e) {

                console.error(
                    `❌ 代理启动失败: ${e.message}`
                );


                if (acc.proxyLock) {

                    console.log(
                        '🚫 PROXY_LOCK 开启，放弃执行当前账号！'
                    );


                    summary.push({

                        user:
                            maskedUsername,

                        loginMethod:
                            '未登录',

                        status:
                            'Failed (代理失效)',

                        stats: {},

                        latestDate:
                            null
                    });


                    continue;

                } else {

                    console.log(
                        '⚠️ PROXY_LOCK 未开启，继续使用直连模式'
                    );

                    useProxy = false;
                }
            }
        }


        // ====================================================
        // 初始化状态
        // ====================================================

        if (!globalState[accKey]) {

            globalState[accKey] = {};
        }


        // ====================================================
        // Chrome 用户目录
        // ====================================================

        const userDataDir =
            path.join(
                os.tmpdir(),
                `chrome_data_${acc.id}_${Date.now()}`
            );


        // ====================================================
        // 启动 Chrome
        // ====================================================

        try {

            chromeProcess =
                await startChrome(
                    useProxy,
                    userDataDir
                );


            // =================================================
            // CDP 连接
            // =================================================

            console.log(
                '🔗 正在连接 Chrome CDP...'
            );


            browser =
                await chromium.connectOverCDP(
                    `http://127.0.0.1:${DEBUG_PORT}`
                );


            const contexts =
                browser.contexts();


            if (
                !contexts ||
                contexts.length === 0
            ) {

                throw new Error(
                    'Chrome 没有可用 BrowserContext'
                );
            }


            page =
                await contexts[0].newPage();


            page.setDefaultTimeout(
                60000
            );


            console.log(
                '✅ Chrome CDP 连接成功'
            );


            // =================================================
            // 验证网络
            // =================================================

            console.log(
                '🔍 验证连通性...'
            );


            try {

                await page.goto(
                    'https://api.ipify.org',
                    {
                        waitUntil:
                            'domcontentloaded',

                        timeout:
                            30000
                    }
                );


                const ip =
                    await page.innerText(
                        'body'
                    );


                console.log(
                    `✅ 网络就绪，出口 IP: ${maskIP(ip)}`
                );


            } catch (e) {

                throw new Error(
                    `网络不可达或代理断流: ${e.message}`
                );
            }


            // =================================================
            // Cookie 登录
            // =================================================

            let loginSuccess = false;


            if (acc.cookies) {

                console.log(
                    '🍪 发现历史 Cookie，尝试免密登录...'
                );


                try {

                    const cookies =
                        JSON.parse(
                            acc.cookies
                        );


                    await page.context()
                        .addCookies(
                            cookies
                        );


                    await page.goto(
                        'https://dash.hidencloud.com/dashboard',
                        {
                            waitUntil:
                                'domcontentloaded',

                            timeout:
                                30000
                        }
                    );


                    if (
                        !page.url().includes('/login')
                    ) {

                        console.log(
                            '✅ Cookie 依然有效，免密登录成功！'
                        );


                        loginSuccess = true;

                        currentLoginMethod =
                            '免密 (Cookie)';

                    } else {

                        console.log(
                            '⚠️ Cookie 已失效，进入常规密码登录...'
                        );
                    }


                } catch (e) {

                    console.log(
                        `⚠️ Cookie 解析失败，进入常规登录: ${e.message}`
                    );
                }
            }


            // =================================================
            // 密码登录
            // =================================================

            if (!loginSuccess) {

                await performLogin(
                    page,
                    acc
                );


                console.log(
                    '✅ 账号密码登录成功！获取最新 Cookie...'
                );


                currentLoginMethod =
                    '密码验证 + CF盾';


                await saveCookieToGitHub(
                    acc.id,
                    await page.context().cookies()
                );
            }


            // =================================================
            // 自动续期
            // =================================================

            console.log(
                '🔄 开始检查 HidenCloud 服务...'
            );


            const manager =
                new RenewManager(
                    page,
                    globalState[accKey],
                    maskedUsername
                );


            const res =
                await manager.execute();


            globalState[accKey] =
                res.newState;


            summary.push({

                user:
                    maskedUsername,

                loginMethod:
                    currentLoginMethod,

                status:
                    'Success',

                stats:
                    res.stats,

                latestDate:
                    res.latestDueDate
            });


            console.log(
                `✅ 账号 ${maskedUsername} 处理完成`
            );


        } catch (e) {

            console.error(
                `❌ 异常: ${e.message}`
            );


            // =================================================
            // 保存错误截图
            // =================================================

            if (page) {

                try {

                    await page.screenshot({
                        path:
                            `error_acc_${acc.id}_FINAL.png`,

                        fullPage:
                            true
                    });

                    console.log(
                        `📸 已保存错误截图: error_acc_${acc.id}_FINAL.png`
                    );

                } catch (screenshotError) {

                    console.log(
                        `⚠️ 错误截图失败: ${screenshotError.message}`
                    );
                }
            }


            summary.push({

                user:
                    maskedUsername,

                loginMethod:
                    currentLoginMethod,

                status:
                    `Failed: ${e.message}`,

                stats: {},

                latestDate:
                    null
            });


        } finally {

            // =================================================
            // 清理 Chrome
            // =================================================

            console.log(
                '🧹 清理环境...'
            );


            try {

                if (browser) {

                    await browser.close();
                }

            } catch (e) {}


            // Chrome 进程
            try {

                if (
                    chromeProcess &&
                    chromeProcess.pid
                ) {

                    try {

                        process.kill(
                            chromeProcess.pid,
                            'SIGKILL'
                        );

                    } catch (e) {}
                }

            } catch (e) {}


            // 再次清理 CDP Chrome
            try {

                execSync(
                    `pkill -f "remote-debugging-port=${DEBUG_PORT}" || true`
                );

            } catch (e) {}


            // =================================================
            // 清理 sing-box
            // =================================================

            if (
                singBoxProcess &&
                singBoxProcess.pid
            ) {

                try {

                    process.kill(
                        -singBoxProcess.pid
                    );

                } catch (e) {

                    try {

                        execSync(
                            'pkill -f "sing-box run" || true'
                        );

                    } catch (err) {}
                }
            }


            // =================================================
            // 删除 config.json
            // =================================================

            try {

                if (
                    fs.existsSync('config.json')
                ) {

                    fs.unlinkSync(
                        'config.json'
                    );
                }

            } catch (e) {}


            // =================================================
            // 删除 Chrome 临时目录
            // =================================================

            try {

                if (
                    fs.existsSync(userDataDir)
                ) {

                    fs.rmSync(
                        userDataDir,
                        {
                            recursive: true,
                            force: true
                        }
                    );
                }

            } catch (e) {}
        }
    }


    // ========================================================
    // 保存状态
    // ========================================================

    try {

        fs.writeFileSync(
            STATE_FILE,
            JSON.stringify(
                globalState,
                null,
                2
            )
        );

        console.log(
            '💾 state.json 已更新'
        );

    } catch (e) {

        console.error(
            `❌ 保存 state.json 失败: ${e.message}`
        );
    }


    // ========================================================
    // 通知
    // ========================================================

    try {

        await sendNotifications(
            summary
        );

    } catch (e) {

        console.error(
            `❌ 发送通知失败: ${e.message}`
        );
    }


    // ========================================================
    // 最终结果
    // ========================================================

    console.log('');
    console.log(
        '==========================================='
    );

    console.log(
        '🎉 HidenCloud 自动续期任务结束'
    );

    console.log(
        '==========================================='
    );

    summary.forEach(s => {

        console.log(
            `${s.user} -> ${s.status}`
        );
    });

})();
