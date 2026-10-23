"""Capture the five documented light-mode states in each language; demo values and PDF only."""
import hashlib
import json
from pathlib import Path
import fitz
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / '.work' / 'screenshots'
DEMO = json.loads((ROOT / 'test' / 'vectors.json').read_text(encoding='utf-8'))['sets'][0]['text']


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    records = []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for language in ('ja', 'en'):
            assets = ROOT / 'assets' if language == 'ja' else ROOT / 'assets' / 'en'
            assets.mkdir(parents=True, exist_ok=True)
            page = browser.new_page(viewport={'width':1000, 'height':1000}, color_scheme='light', locale=language)
            page.add_init_script('window.print = () => {};')
            page.goto((ROOT / 'index.html').as_uri() + '?lang=' + language)
            assert page.locator('html').get_attribute('data-theme') == 'light'
            page.screenshot(path=str(assets / 'screenshot.png'))
            page.click('#test-button')
            page.wait_for_function('() => document.querySelectorAll("#test-cards button").length === 4')
            page.check('#test-read-confirm')
            page.fill('#secret-input', DEMO)
            page.click('#split-button')
            page.wait_for_function('() => document.querySelectorAll("#share-cards button").length === 2')
            page.locator('#share-cards').screenshot(path=str(assets / 'sheets.png'))
            page.locator('#share-cards button').first.click()
            page.emulate_media(media='print')
            pdf = OUT / f'print-{language}.pdf'
            page.pdf(path=str(pdf), prefer_css_page_size=True, print_background=False, display_header_footer=False)
            doc = fitz.open(pdf)
            assert len(doc) == 1
            scale = 808 / doc[0].rect.width
            doc[0].get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False).save(str(assets / 'print-sheet.png'))
            doc.close()
            page.emulate_media(media='screen')
            page.evaluate('() => dispatchEvent(new Event("afterprint"))')
            page.click('#tab-read')
            page.locator('#panel-read').screenshot(path=str(assets / 'overlay-read.png'))
            page.click('#tab-guide')
            page.evaluate('() => scrollTo(0, 0)')
            page.screenshot(path=str(assets / 'limits.png'))
            page.close()
            for filename in ['screenshot.png', 'sheets.png', 'print-sheet.png', 'overlay-read.png', 'limits.png']:
                file = assets / filename
                data = file.read_bytes()
                width, height = int.from_bytes(data[16:20], 'big'), int.from_bytes(data[20:24], 'big')
                assert len(data) < 300000, (str(file), len(data))
                records.append({'file':file.relative_to(ROOT).as_posix(), 'bytes':len(data), 'width':width,
                                'height':height, 'theme':'light', 'sha256':hashlib.sha256(data).hexdigest()})
        browser.close()
    (OUT / 'manifest.json').write_text(json.dumps(records, indent=2), encoding='utf-8')
    print(json.dumps(records, indent=2))


if __name__ == '__main__':
    main()
