/**
 * 用 Chrome DevTools Protocol 对登录页做无头验证。
 *
 * 覆盖两类之前靠截图肉眼判断容易出错、或截图根本看不出来的点：
 *   1) 元素是否真的存在、href/target/rel 是否正确；
 *   2) 是否真的"可点击"——对链接中心点做 elementFromPoint 命中测试。
 *      页脚容器是 pointer-events:none（避免在窄视口挡住下方元素），
 *      只有链接本身放开；命中测试失败时肉眼完全看不出来，必须程序化验证。
 *   3) 悬停态（:hover）的真实计算样式——用 Input.dispatchMouseEvent 真发鼠标事件。
 *   4) 与登录卡片的几何间隙，确认页脚没有压住表单。
 *
 * 之所以走 CDP 而不是"iframe 探针页 + 截图"：探针页与目标页跨源无法读取
 * DOM，而 CDP 直接在目标页上下文执行 Runtime.evaluate，没有同源限制。
 *
 * 用法：
 *   node verify_login_page.mjs <url> [输出目录]
 *   例：node verify_login_page.mjs http://192.168.0.38/ .tmp/verify
 *
 * 环境变量：CHROME_PATH 可覆盖 Chrome 可执行文件路径。
 */

import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHROME =
  process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const url = process.argv[2]
const outDir = process.argv[3] || '.tmp/verify'
if (!url) {
  console.error('用法: node verify_login_page.mjs <url> [输出目录]')
  process.exit(2)
}

const PORT = 19222 + Math.floor(Math.random() * 200)
const userDataDir = mkdtempSync(join(tmpdir(), 'cdp-verify-'))
mkdirSync(outDir, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    'about:blank',
  ],
  { stdio: 'ignore', windowsHide: true },
)

let ws
let msgId = 0
const pending = new Map()
const events = []

function send(method, params = {}, sessionId) {
  const id = ++msgId
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params, sessionId }))
  })
}

async function main() {
  // 1. 等 DevTools HTTP 端点就绪
  let version = null
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`)
      if (res.ok) {
        version = await res.json()
        break
      }
    } catch {
      /* 还没起来 */
    }
    await sleep(250)
  }
  if (!version) throw new Error('Chrome DevTools 端点未就绪')

  // 2. 取一个 page target 并连上
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const page = list.find((t) => t.type === 'page')
  if (!page) throw new Error('未找到 page target')

  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(JSON.stringify(msg.error)))
      else resolve(msg.result)
    } else if (msg.method) {
      events.push(msg)
    }
  })

  await send('Page.enable')
  await send('Runtime.enable')

  // 3. 每个新文档注入：关掉"新用户引导"全屏遮罩，避免干扰命中测试
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try {
      localStorage.setItem('weknora:new-user-guide-done:v1', '1');
    } catch (e) {}`,
  })

  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: false,
    })
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails))
    return r.result.value
  }

  const probe = `(() => {
    const a = document.querySelector('.login-footer a.icp-link');
    const f = document.querySelector('.login-footer');
    const span = document.querySelector('.login-footer > span');
    const card = document.querySelector('.form-card');
    const fr = f ? f.getBoundingClientRect() : null;
    const cr = card ? card.getBoundingClientRect() : null;
    let ar = null, cs = null, hit = null, hitIsLink = null, hitPointer = null;
    if (a) {
      ar = a.getBoundingClientRect();
      cs = getComputedStyle(a);
      const el = document.elementFromPoint(ar.left + ar.width / 2, ar.top + ar.height / 2);
      hit = el ? el.tagName + (typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\\s+/).join('.') : '') : null;
      hitIsLink = !!(el && (el === a || a.contains(el)));
      hitPointer = el ? getComputedStyle(el).pointerEvents : null;
    }
    const rect = (r) => r ? { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) } : null;
    return {
      href: a && a.getAttribute('href'),
      target: a && a.getAttribute('target'),
      rel: a && a.getAttribute('rel'),
      linkText: a && a.textContent.trim(),
      copyrightText: span && span.textContent.trim(),
      linkRect: rect(ar),
      linkColor: cs && cs.color,
      linkDecoration: cs && cs.textDecorationLine,
      linkPointerEvents: cs && cs.pointerEvents,
      linkCursor: cs && cs.cursor,
      linkMarginLeft: cs && cs.marginLeft,
      footerPointerEvents: f && getComputedStyle(f).pointerEvents,
      footerRect: rect(fr),
      cardRect: rect(cr),
      gapCardBottomToFooterTop: (cr && fr) ? +(fr.top - cr.bottom).toFixed(1) : null,
      hitTestElement: hit,
      hitTestIsLink: hitIsLink,
      hitTestPointerEvents: hitPointer,
      viewport: { w: innerWidth, h: innerHeight },
      docScrollHeight: document.documentElement.scrollHeight,
    };
  })()`

  const sizes = [
    { name: 'desktop-1440x900', width: 1440, height: 900 },
    { name: 'narrow-768x900', width: 768, height: 900 },
    { name: 'mobile-390x844', width: 390, height: 844 },
  ]

  const report = {}
  for (const s of sizes) {
    await send('Emulation.setDeviceMetricsOverride', {
      width: s.width,
      height: s.height,
      deviceScaleFactor: 1,
      mobile: false,
    })
    await send('Page.navigate', { url })
    await sleep(3200)

    // 未滚动时取的矩形 = 文档坐标，用于几何/重叠校验
    const layout = await evaluate(probe)

    // 页脚绝对定位在文档最底部，首屏之下。elementFromPoint 只对视口内坐标
    // 有效，视口外一律返回 null——所以必须先滚动到底再命中测试，
    // 否则会把"没点着"误判成 pointer-events 失效。
    await evaluate('window.scrollTo(0, document.documentElement.scrollHeight)')
    await sleep(450)
    const view = await evaluate(probe)

    // 真发一次鼠标移动到链接中心 → 读 :hover 计算样式
    let hover = null
    if (view.linkRect) {
      const cx = view.linkRect.x + view.linkRect.w / 2
      const cy = view.linkRect.y + view.linkRect.h / 2
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy })
      await sleep(350)
      hover = await evaluate(
        `(() => { const a = document.querySelector('.login-footer a.icp-link'); if (!a) return null;
          const c = getComputedStyle(a); return { color: c.color, decoration: c.textDecorationLine }; })()`,
      )
    }

    const shot = await send('Page.captureScreenshot', { format: 'png' })
    const file = join(outDir, `login-${s.name}.png`)
    writeFileSync(file, Buffer.from(shot.data, 'base64'))

    // 深色主题下 logo 不应被任何滤镜改动（反色会毁掉品牌配色）。
    // 桌面尺寸跑一次即可，三种视口下这条 CSS 规则完全相同。
    let darkLogo = null
    if (s.name === 'desktop-1440x900') {
      // 上一步已滚到底部，logo 在页面顶部，需先滚回去
      await evaluate('window.scrollTo(0, 0)')
      await evaluate(`document.documentElement.setAttribute('theme-mode', 'dark')`)
      await sleep(500)
      darkLogo = await evaluate(`(() => {
        const img = document.querySelector('.header-logo .logo-image');
        const plate = document.querySelector('.header-logo');
        if (!img) return null;
        return {
          filter: getComputedStyle(img).filter,
          plateBackground: plate ? getComputedStyle(plate).backgroundColor : null,
          src: img.getAttribute('src'),
          naturalSize: img.naturalWidth + 'x' + img.naturalHeight,
          loaded: img.complete && img.naturalWidth > 0,
        };
      })()`)
      const shot2 = await send('Page.captureScreenshot', { format: 'png' })
      const file2 = join(outDir, 'login-desktop-dark.png')
      writeFileSync(file2, Buffer.from(shot2.data, 'base64'))
      if (darkLogo) darkLogo.screenshot = file2
    }

    report[s.name] = {
      ...layout,
      hitTestElement: view.hitTestElement,
      hitTestIsLink: view.hitTestIsLink,
      hitTestPointerEvents: view.hitTestPointerEvents,
      linkRectAfterScroll: view.linkRect,
      hover,
      darkLogo,
      screenshot: file,
    }
  }

  const out = join(outDir, 'verify-report.json')
  writeFileSync(out, JSON.stringify(report, null, 2), 'utf8')
  console.log(JSON.stringify(report, null, 2))
  console.log(`\n报告: ${out}`)
}

main()
  .catch((e) => {
    console.error('验证失败:', e.message)
    process.exitCode = 1
  })
  .finally(async () => {
    try {
      ws && ws.close()
    } catch {
      /* ignore */
    }
    chrome.kill()
    await sleep(400)
    try {
      rmSync(userDataDir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })
