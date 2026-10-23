"""Printing and generation gates. PDF output only; no physical print jobs."""
import json
import time
from pathlib import Path
import fitz
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / '.work' / 'print'
DEMO = json.loads((ROOT / 'test' / 'vectors.json').read_text(encoding='utf-8'))['sets'][0]['text']


def overflow(page, label):
    excess = page.evaluate('() => document.documentElement.scrollWidth - document.documentElement.clientWidth')
    assert excess == 0, (label, excess)
    return excess


def generate(page, count=2, all_required=False, version=4, module=2.54):
    page.select_option('#sheet-count', str(count))
    if all_required:
        page.locator('#film-options').evaluate('(e) => e.open = true')
        page.check('#recover-all')
    else:
        page.check('#recover-any')
    page.select_option('#module-size', str(module))
    page.select_option('#qr-version', str(version))
    page.click('#test-button')
    page.wait_for_function('() => document.querySelectorAll("#test-cards button").length > 0')
    page.check('#test-read-confirm')
    page.fill('#secret-input', DEMO)
    start = time.perf_counter()
    page.click('#split-button')
    page.wait_for_function('n => document.querySelectorAll("#share-cards button").length === n', arg=count)
    elapsed = time.perf_counter() - start
    return elapsed


def pdf_geometry(file, subpixel):
    doc = fitz.open(file)
    assert len(doc) == 1, (file.name, len(doc))
    page = doc[0]
    mm = 25.4 / 72
    assert abs(page.rect.width * mm - 210) < 0.2
    assert abs(page.rect.height * mm - 297) < 0.2
    vertical = []
    rectangles = []
    for drawing in page.get_drawings():
        for item in drawing['items']:
            if item[0] == 'l':
                a, b = item[1:3]
                if abs(a.x - b.x) < 0.01:
                    vertical.append(abs(a.y - b.y) * mm)
            elif item[0] == 're':
                rect = item[1]
                rectangles.append((rect.width * mm, rect.height * mm))
                if rect.width * mm < 0.2:
                    vertical.append(rect.height * mm)
        items = drawing['items']
        for offset in range(0, len(items) - 3, 4):
            edges = items[offset:offset + 4]
            if all(edge[0] == 'l' for edge in edges):
                points = [edge[1] for edge in edges]
                closed = all(edges[i][2] == edges[(i + 1) % 4][1] for i in range(4))
                xs = {round(point.x, 4) for point in points}
                ys = {round(point.y, 4) for point in points}
                if closed and len(xs) == 2 and len(ys) == 2:
                    rectangles.append(((max(xs) - min(xs)) * mm, (max(ys) - min(ys)) * mm))
    ruler = min(vertical, key=lambda value: abs(value - 100))
    assert abs(ruler - 100) < 0.15, (file.name, ruler)
    small = [pair for pair in rectangles if abs(pair[1] - subpixel) < 0.02]
    assert len(small) > 100, (file.name, subpixel, rectangles[:20], len(rectangles))
    sub = sum(pair[1] for pair in small) / len(small)
    result = {'pages':len(doc), 'rulerMm':ruler, 'subpixelMm':sub, 'rectangles':len(small)}
    doc.close()
    return result


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    results = []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        context = browser.new_context(viewport={'width':1280, 'height':1000}, locale='ja-JP')
        page = context.new_page()
        page.set_default_timeout(60000)
        page.add_init_script('window.print = () => { window.__printCalls = (window.__printCalls || 0) + 1; };')
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.on('console', lambda msg: errors.append(msg.text) if msg.type == 'error' else None)
        page.goto((ROOT / 'index.html').as_uri() + '?lang=ja')
        for language, module in [('ja', 2.54), ('en', 2.032)]:
            if page.locator('html').get_attribute('lang') != language:
                page.click('#language')
            elapsed = generate(page, module=module)
            for width in (320, 390, 1280):
                page.set_viewport_size({'width':width, 'height':1000})
                overflow(page, ('cards', language, width))
                assert page.locator('#share-cards').evaluate('(e) => e.scrollWidth <= e.clientWidth')
            page.locator('#share-cards button').first.click()
            assert page.evaluate('() => window.__printCalls') >= 1
            page.emulate_media(media='print')
            overflow(page, ('print', language))
            path = OUT / f'{language}-{module}.pdf'
            page.pdf(path=str(path), prefer_css_page_size=True, print_background=False, display_header_footer=False)
            geometry = pdf_geometry(path, module / 2)
            results.append({'language':language, 'moduleMm':module, 'elapsedSeconds':elapsed, **geometry})
            page.emulate_media(media='screen')
            page.evaluate('() => dispatchEvent(new Event("afterprint"))')
        for count, required, version, module in [(5, False, 7, 2.032), (5, True, 4, 2.54)]:
            seconds = generate(page, count, required, version, module)
            results.append({'scheme':'5-5' if required else '2-5', 'version':version,
                            'moduleMm':module, 'selfCheckSeconds':seconds})
            page.set_viewport_size({'width':320, 'height':960})
            overflow(page, ('largest cards', required))
            page.screenshot(path=str(OUT / ('cards-55.png' if required else 'cards-25.png')))
        page.fill('#secret-input', DEMO + ' ')
        assert page.locator('#share-cards button').count() == 0
        page.click('#clear-all')
        assert page.locator('#secret-input').input_value() == ''
        assert page.locator('#test-cards button').count() == 0
        assert page.locator('#share-cards button').count() == 0
        assert not errors, errors
        browser.close()
    (OUT / 'results.json').write_text(json.dumps(results, indent=2), encoding='utf-8')
    print(json.dumps(results, indent=2))


if __name__ == '__main__':
    main()
