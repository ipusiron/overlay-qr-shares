"""Synthetic camera acceptance, lifecycle and narrow-screen checks; no physical camera or printing."""
import base64
import json
import os
from pathlib import Path
import shutil
import subprocess
import time
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / '.work' / 'camera'
DEMO = json.loads((ROOT / 'test' / 'vectors.json').read_text(encoding='utf-8'))['sets'][0]['text']


def fixture():
    """Node renders test-only shares; Python's standard library packages a 1280x960 Y4M stream."""
    script = r"""
const vc = require('./vc-core.js'), render = require('./render-core.js');
const {seededRng} = require('./test/helpers.js');
const text = require('./test/vectors.json').sets[0].text;
const set = vc.makeSet(text, '2-2', 4, 'M', 1, seededRng(125));
const frame = render.synthStack(set, [0, 1], {pxPerMm:6, ink:.85, blur:1});
const g = frame.geometry;
const marks = set.layout.normal.marks.map(p => [(p.x+1.5-g.originX)*g.pxPerMm, (p.y+1.5-g.originY)*g.pxPerMm]);
process.stdout.write(JSON.stringify({w:frame.w,h:frame.h,marks,gray:Buffer.from(frame.gray).toString('base64')}));
frame.gray.fill(0);
"""
    result = subprocess.run([os.environ.get('OQS_NODE') or shutil.which('node'), '-e', script],
                            cwd=ROOT, text=True, encoding='utf-8', capture_output=True, check=True)
    sample = json.loads(result.stdout)
    width, height = 1280, 960
    assert sample['w'] <= width and sample['h'] <= height
    x0, y0 = (width - sample['w']) // 2, (height - sample['h']) // 2
    source = base64.b64decode(sample['gray'])
    pixels = bytearray([235]) * (width * height)
    for y in range(sample['h']):
        start = y * sample['w']
        row = bytes(round(16 + 219 * value / 255) for value in source[start:start + sample['w']])
        offset = (y0 + y) * width + x0
        pixels[offset:offset + sample['w']] = row
    frame = pixels + bytearray([128]) * (width * height // 2)
    path = OUT / 'overlay.y4m'
    with path.open('wb') as output:
        output.write(f'YUV4MPEG2 W{width} H{height} F10:1 Ip A1:1 C420jpeg\n'.encode('ascii'))
        for _ in range(10):
            output.write(b'FRAME\n')
            output.write(frame)
    # Renderer vector order is TL, TR, BL, BR; manual selection order is TL, TR, BR, BL.
    marks = [[x0 + x, y0 + y] for x, y in sample['marks']]
    return path, [marks[index] for index in [0, 1, 3, 2]]


def instrumentation(page):
    page.add_init_script("""(() => {
      window.__streams = [];
      const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async constraints => {
        const stream = await original(constraints);
        window.__streams.push(stream);
        return stream;
      };
    })();""")


def tracks_stopped(page):
    return page.evaluate('() => window.__streams.every(s => s.getTracks().every(t => t.readyState === "ended"))')


def dimensions(page, selector):
    return page.locator(selector).evaluate('(e) => ({client:e.clientWidth, scroll:e.scrollWidth})')


def manual_and_lifecycle(page, marks):
    # Hold automatic reading off so a real frozen-frame/four-click workflow can be exercised.
    # The manual read still goes through the unmodified production reader with no expected text.
    page.evaluate('''() => {
      const reader = OQS.reader;
      window.__manualFrames = [];
      OQS.reader = {...reader, readFrame(image, options, decoder) {
        if (!options || !options.manualCorners) return {ok:false, reason:'marks', diag:{marks:0, flags:[]}};
        window.__manualFrames.push(image.gray);
        return reader.readFrame(image, options, decoder);
      }};
    }''')
    page.set_viewport_size({'width':320, 'height':960})
    page.click('#camera-button')
    page.wait_for_function('() => !document.getElementById("manual-button").disabled && document.getElementById("camera-video").readyState >= 2')
    page.click('#manual-button')
    assert tracks_stopped(page)
    assert page.locator('#manual-view').is_visible()
    assert page.evaluate('() => document.documentElement.scrollWidth === document.documentElement.clientWidth')
    canvas = page.locator('#manual-canvas')
    canvas.scroll_into_view_if_needed()
    for x, y in marks:
        box = canvas.bounding_box()
        intrinsic = canvas.evaluate('(e) => ({w:e.width,h:e.height})')
        canvas.click(position={'x':(x + 2) / intrinsic['w'] * box['width'],
                               'y':(y + 2) / intrinsic['h'] * box['height']})
    page.wait_for_function('() => !document.getElementById("read-result").hidden', timeout=10000)
    assert page.locator('#read-value').is_hidden()
    page.click('#reveal')
    assert page.locator('#read-value').inner_text() == DEMO
    assert page.evaluate('() => window.__manualFrames.length > 0 && window.__manualFrames.every(a => a.every(v => v === 0))')
    assert canvas.evaluate('(e) => e.width === 0 && e.height === 0')
    page.click('#clear-read')
    page.click('#camera-button')
    page.wait_for_function('() => !document.getElementById("manual-button").disabled && document.getElementById("camera-video").readyState >= 2')
    page.click('#manual-button')
    page.click('#manual-cancel')
    assert canvas.evaluate('(e) => e.width === 0 && e.height === 0')
    assert tracks_stopped(page)
    page.click('#camera-button')
    page.wait_for_function('() => !document.getElementById("manual-button").disabled && document.getElementById("camera-video").readyState >= 2')
    page.click('#tab-guide')
    assert tracks_stopped(page)
    page.click('#tab-read')
    page.click('#camera-button')
    page.wait_for_function('() => !document.getElementById("manual-button").disabled && document.getElementById("camera-video").readyState >= 2')
    page.evaluate('''() => {
      Object.defineProperty(document, 'hidden', {configurable:true, get:() => true});
      document.dispatchEvent(new Event('visibilitychange'));
      delete document.hidden;
    }''')
    assert tracks_stopped(page)
    page.evaluate('''() => {
      const request = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      window.__requestBeforeDelay = request;
      navigator.mediaDevices.getUserMedia = async constraints => {
        const stream = await request(constraints);
        await new Promise(resolve => { window.__releaseRequest = resolve; });
        return stream;
      };
    }''')
    page.click('#camera-button')
    page.wait_for_function('() => typeof window.__releaseRequest === "function"')
    page.click('#stop-camera')
    page.evaluate('() => window.__releaseRequest()')
    page.wait_for_function('() => window.__streams.every(s => s.getTracks().every(t => t.readyState === "ended"))')
    page.evaluate('() => { navigator.mediaDevices.getUserMedia = window.__requestBeforeDelay; }')
    page.click('#camera-button')
    page.wait_for_function('() => document.getElementById("camera-video").readyState >= 2')
    page.evaluate('() => dispatchEvent(new Event("pagehide"))')
    assert tracks_stopped(page)
    return {'manualFourPoints':True, 'manualSnapOffsetPx':2, 'frameWiped':True, 'cancelWiped':True,
            'tabStopsCamera':True, 'pagehideStopsCamera':True, 'hiddenStopsCamera':True, 'pendingStopRace':True}

def capture_failures(browser):
    for method, manual in [('getImageData', False), ('drawImage', False), ('getImageData', True)]:
        page = browser.new_page()
        instrumentation(page)
        page.add_init_script('''(() => {
          window.__canvases = [];
          const create = Document.prototype.createElement;
          Document.prototype.createElement = function(name, options) {
            const node = create.call(this, name, options);
            if (name === 'canvas') window.__canvases.push(node);
            return node;
          };
        })();''')
        if manual:
            page.add_init_script('window.requestAnimationFrame = () => 1; window.cancelAnimationFrame = () => {};')
        page.add_init_script(f'''CanvasRenderingContext2D.prototype.{method} = function() {{
          throw new DOMException('Synthetic capture failure', 'SecurityError');
        }};''')
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto((ROOT / 'index.html').as_uri() + '?lang=en')
        page.click('#tab-read')
        page.click('#camera-button')
        if manual:
            # The application's animation loop is deliberately held; poll independently.
            page.wait_for_function('() => document.getElementById("camera-video").readyState >= 2', polling=50)
            page.locator('#manual-button').evaluate('(button) => button.click()')
        page.wait_for_function('''() => window.__streams.length > 0
          && window.__streams.every(s => s.getTracks().every(t => t.readyState === 'ended'))''', timeout=10000)
        assert page.locator('#camera-video').evaluate('(e) => e.srcObject === null')
        assert page.locator('#manual-canvas').evaluate('(e) => e.width === 0 && e.height === 0')
        assert page.evaluate('() => window.__canvases.every(c => c.width === 0 && c.height === 0)')
        assert page.locator('#camera-status').inner_text()
        assert not errors, (method, manual, errors)
        page.close()
    return 3

def main():
    OUT.mkdir(parents=True, exist_ok=True)
    video, marks = fixture()
    results = []
    with sync_playwright() as p:
        browser = p.chromium.launch(args=['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
                                         '--use-file-for-fake-video-capture=' + str(video)])
        page = browser.new_page(viewport={'width':1280, 'height':960}, locale='ja-JP')
        instrumentation(page)
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.on('console', lambda msg: errors.append(msg.text) if msg.type == 'error' else None)
        page.goto((ROOT / 'index.html').as_uri() + '?lang=ja')
        page.click('#tab-read')
        start = time.perf_counter()
        page.click('#camera-button')
        page.wait_for_function('() => !document.getElementById("read-result").hidden', timeout=45000)
        seconds = time.perf_counter() - start
        assert page.locator('#read-value').is_hidden()
        assert DEMO not in page.locator('body').inner_text()
        assert tracks_stopped(page)
        page.locator('#diagnostic details').evaluate('(e) => e.open = true')
        for width in (320, 390, 1280):
            page.set_viewport_size({'width':width, 'height':960})
            assert page.evaluate('() => document.documentElement.scrollWidth === document.documentElement.clientWidth')
            for selector in ['#diagnostic', '#diagnostic-detail']:
                measured = dimensions(page, selector)
                assert measured['scroll'] <= measured['client'], (width, selector, measured)
            page.locator('#diagnostic').screenshot(path=str(OUT / f'read-{width}.png'))
        page.click('#reveal')
        assert page.locator('#read-value').inner_text() == DEMO
        page.click('#clear-read')
        assert page.locator('#read-result').is_hidden()
        assert page.locator('#read-value').inner_text() == ''
        assert tracks_stopped(page)
        lifecycle = manual_and_lifecycle(page, marks)
        assert not errors, errors
        results.append({'browser':'chromium', 'protocol':'file:', 'camera':True, 'decoded':True,
                        'seconds':seconds, 'stopped':True, 'overflow':0, 'consoleErrors':0, **lifecycle})
        denied = browser.new_page()
        denied.add_init_script('''navigator.mediaDevices.getUserMedia = async () => {
          throw new DOMException('Synthetic permission denial', 'NotAllowedError');
        };''')
        denied.goto((ROOT / 'index.html').as_uri() + '?lang=ja')
        denied.click('#tab-read')
        denied.click('#camera-button')
        denied.wait_for_function('() => !document.getElementById("camera-fallback").hidden')
        assert denied.locator('#camera-fallback a').get_attribute('href') == 'https://ipusiron.github.io/overlay-qr-shares/'
        assert denied.locator('#read-result').is_hidden()
        denied.close()
        results[0]['filePermissionFallback'] = True
        results[0]['captureFailureCases'] = capture_failures(browser)
        browser.close()
        firefox = p.firefox.launch(firefox_user_prefs={'media.navigator.streams.fake':True,
                                                      'media.navigator.permission.disabled':True})
        page = firefox.new_page(viewport={'width':390, 'height':960})
        instrumentation(page)
        page.goto((ROOT / 'index.html').as_uri() + '?lang=en')
        page.click('#tab-read')
        page.click('#camera-button')
        page.wait_for_function('() => document.getElementById("camera-video").readyState >= 2', timeout=30000)
        page.click('#stop-camera')
        assert tracks_stopped(page)
        results.append({'browser':'firefox', 'protocol':'file:', 'camera':True, 'stopped':True,
                        'decoded':'not tested; Firefox fake camera shows its own pattern'})
        firefox.close()
    (OUT / 'results.json').write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(results, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
