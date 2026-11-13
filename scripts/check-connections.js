#!/usr/bin/env node
// Runs the Connections tab and the Related works box exactly as a live record
// page serves them, against the live DataCite API, and prints what each shows.
// Flags anything in Related works that is missing from the Connections tab.
// Usage: node scripts/check-connections.js <record page or DOI url> [...]
const ORIGIN = 'https://iplacesalliance.org'
const urls = process.argv.slice(2)
if (!urls.length) urls.push(
  'https://doi.org/10.60950/e5a791ab-46b1-4109-bb41-1cbafbc0add5',
  'https://iplacesalliance.org/baileystation/articles/5/'
)
const realFetch = global.__testFetch || fetch
const strip = h => String(h || '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim()
const unattr = s => String(s || '').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

function el () {
  return {
    style: {}, html: '', children: [], textContent: '', _ih: '', parentNode: { removeChild () {} },
    insertAdjacentHTML (p, h) { this.html += h },
    appendChild (c) { this.children.push(c) },
    set innerHTML (v) { this._ih = v; this.children = [] },
    get innerHTML () { return this._ih }
  }
}

async function check (url) {
  console.log(`\n=== ${url}`)
  const page = await realFetch(url, { redirect: 'follow' })
  const html = await page.text()
  console.log(`page ${page.status} ${page.url || ''} (${html.length} bytes)`)
  const sec = html.match(/<section id="datacite-connections"[^>]*>/)
  const intro = (html.match(/class="dc-connections-intro">([^<]*)/) || [])[1] || ''
  console.log(`tab version: ${/from its own metadata/.test(intro) ? 'NEW' : 'OLD'} ("${strip(intro)}")`)
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g)].filter(m => !/application\/json/.test(m[1])).map(m => m[2])
  const tabJs = scripts.find(s => s.includes("getElementById('datacite-connections')"))
  const sideJs = scripts.find(s => s.includes('getElementById("related-works")'))
  if (!sec || !tabJs) console.log('! no Connections tab script on this page')
  if (!sideJs) console.log('! no Related works script on this page')
  const attr = n => unattr(((sec && sec[0]) || '').match(new RegExp(`${n}="([^"]*)"`))?.[1] || '')
  const local = (html.match(/<script type="application\/json" class="dc-local">([\s\S]*?)<\/script>/) || [])[1] || '{}'
  console.log(`data-doi: "${attr('data-doi')}"`)

  const calls = []
  const wrapped = (u, opts = {}) => {
    const o = { ...opts, headers: { ...(opts.headers || {}), Origin: ORIGIN } }
    return realFetch(u, o).then(r => {
      calls.push(`${r.status} cors=${r.headers.get('access-control-allow-origin') || 'NONE'} ${opts.method || 'GET'} ${decodeURIComponent(u).slice(0, 150)}`)
      return r
    }, e => { calls.push(`ERR ${e.message} ${u}`); throw e })
  }
  const section = { _els: {}, getAttribute: n => attr(n), querySelector (s) { if (s === '.dc-local') return { textContent: local }; return (this._els[s] = this._els[s] || el()) } }
  const rw = el()
  const errors = []
  const document = {
    getElementById: id => id === 'datacite-connections' ? section : id === 'related-works' ? rw : id === 'about-this-heading' ? el() : null,
    createElement: () => el()
  }
  const window = { open () {} }
  const cons = { ...console, error: (...a) => errors.push(a.map(String).join(' ')), log () {}, warn () {} }
  for (const [name, js] of [['tab', tabJs], ['sidebar', sideJs]]) {
    if (!js) continue
    try { new Function('document', 'window', 'fetch', 'console', js)(document, window, wrapped, cons) } catch (e) { errors.push(`${name} script threw: ${e.stack}`) }
  }
  const body = () => section._els['.dc-connections-body']
  const empty = () => section._els['.dc-connections-empty']
  const tabDone = () => !tabJs || (body() && body().html) || (empty() && empty().style.display === '')
  const sideDone = () => !sideJs || rw.children.length || rw.innerHTML
  for (let t = 0; t < 300 && !(tabDone() && sideDone()); t++) await new Promise(r => setTimeout(r, 100))
  await new Promise(r => setTimeout(r, 300))

  console.log('-- DataCite calls')
  calls.forEach(c => console.log('   ' + c))
  errors.forEach(e => console.log('! ' + e))
  const tabLines = []
  if (tabJs) {
    console.log('-- Connections tab')
    if (body() && body().html) {
      for (const g of body().html.split('<div class="dc-group">').slice(1)) {
        const head = g.match(/dc-group-head">(.*?)<span class="dc-count">(\d+)/)
        console.log(`   ${strip(head[1])} (${head[2]})`)
        for (const li of g.split('<li>').slice(1)) { const s = strip(li); tabLines.push(s.toLowerCase()); console.log(`     - ${s}`) }
      }
    } else if (empty() && empty().style.display === '') console.log('   EMPTY: "No connections registered for this record yet."')
    else console.log('   STILL LOADING after 30 s (script never finished)')
  }
  if (sideJs) {
    console.log('-- Related works (sidebar)')
    const titles = rw.children.map(li => (li.children[0] || {}).textContent || '')
    if (!titles.length) console.log(`   ${strip(rw.innerHTML) || 'STILL LOADING'}`)
    titles.forEach(t => console.log(`     - ${t}`))
    const missing = titles.filter(t => !tabLines.some(l => l.includes(t.toLowerCase().slice(0, 60))))
    console.log(missing.length ? `! in Related works but NOT on the tab: ${missing.join(' | ')}` : '   OK: everything in Related works is on the tab')
  }
}

;(async () => { for (const u of urls) { try { await check(u) } catch (e) { console.log(`! ${u}: ${e.message}`) } } })()
