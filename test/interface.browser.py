"""Browser gates for Overlay QR Shares. Uses local demo data only."""
import argparse
import json
import re
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / '.work' / 'browser'


def measure(page, label):
    result = page.evaluate("""() => {
      const doc = document.documentElement;
      const visible = el => el.getClientRects().length > 0;
      const small = [...document.querySelectorAll('button, select, textarea, summary')]
        .filter(visible).map(el => ({id:el.id, w:el.getBoundingClientRect().width,
          h:el.getBoundingClientRect().height})).filter(r => r.w < 43.99 || r.h < 43.99);
      return {overflow:doc.scrollWidth-doc.clientWidth, small};
    }""")
    assert result['overflow'] == 0, (label, result)
    assert not result['small'], (label, result)
    return result


def read_instructions(page, language):
    """The reader tab must contain the whole preparation flow and translated diagrams."""
    panel = page.locator('#panel-read')
    dictionary = page.evaluate("""language => Object.fromEntries(Object.entries(OQS.messages[language])
      .filter(([, value]) => typeof value === 'string'))""", language)
    step_keys = ['overlayPlace', 'overlayFlip', 'overlayContact', 'overlayAlign', 'overlayMarks']
    required = ['overlayStepsTitle', 'overlayPair', 'overlaySeparateMarks', 'overlayLight']
    required += [key + suffix for key in step_keys for suffix in ('Title', '')]
    for key in required:
        text = panel.locator('[data-i18n="' + key + '"]')
        assert text.count() == 1 and text.is_visible(), (language, key, 'instruction visible inside reader tab')
        assert text.inner_text() == dictionary[key], (language, key, 'current translation')
    steps = panel.locator('.overlay-steps > li').evaluate_all("""items => items.map(item => ({
      title:item.querySelector('strong')?.dataset.i18n, body:item.querySelector('p')?.dataset.i18n
    }))""")
    assert steps == [{'title': key + 'Title', 'body': key} for key in step_keys], (language, steps)
    diagrams = ['diagramFlip', 'diagramLight', 'diagramAlign', 'diagramWrongFour', 'diagramWrongFace']
    figures = panel.locator('#setup-diagrams figure')
    assert figures.count() == len(diagrams), (language, 'all preparation diagrams are in reader tab')
    svg_text = []
    for key in diagrams:
        svg = panel.get_by_role('img', name=dictionary[key], exact=True)
        assert svg.count() == 1 and svg.is_visible(), (language, key, 'translated accessible diagram')
        figure = svg.locator('..')
        assert figure.locator('figcaption strong').inner_text() == dictionary[key], (language, key, 'matching title')
        assert figure.locator('figcaption p').first.inner_text() == dictionary[key + 'Body'], (language, key, 'matching explanation')
        svg_text += [text.strip() for text in svg.locator('text').all_text_contents() if text.strip()]
        if key == 'diagramAlign':
            legend_keys = ['diagramAlignFinder', 'diagramAlignCorner', 'diagramAlignRectangle']
            assert figure.locator('figcaption li').all_text_contents() == [dictionary[name] for name in legend_keys]
    for key in ('diagramFaceUp', 'diagramFaceDown'):
        assert dictionary[key] in svg_text, (language, key, 'printed-face direction shown in diagram')
    for text in svg_text:
        assert text in dictionary.values() or re.fullmatch(r'[A-E0-9\s+×=().,:-]+', text), (language, text, 'localized SVG text')
    return {'steps': len(steps), 'diagrams': len(diagrams), 'legendItems': len(legend_keys), 'svgTextChecked': len(svg_text)}


def interface(browser, name, width, results, stage, base_url=None):
    context = browser.new_context(viewport={'width': width, 'height': 960}, locale='ja-JP',
                                  color_scheme='light', reduced_motion='reduce',
                                  has_touch=width < 500, **({'is_mobile': width < 500} if name == 'chromium' else {}))
    page = context.new_page()
    page.set_default_timeout(15000)
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.on('console', lambda msg: errors.append(msg.text) if msg.type == 'error' else None)
    page.goto((base_url or (ROOT / 'index.html').as_uri()) + '?lang=ja')
    assert page.locator('html').get_attribute('data-theme') == 'light'
    assert page.locator('html').get_attribute('lang') == 'ja'
    tab_ids = page.locator('[role=tab]').evaluate_all('(els) => els.map(e => e.id)')
    assert len(tab_ids) == 3
    for language in ('ja', 'en'):
        if page.locator('html').get_attribute('lang') != language:
            page.click('#language')
        labels = page.locator('[data-label]').evaluate_all(
            '(els) => els.map(e => ({key:e.dataset.label, label:e.getAttribute("aria-label")}))')
        assert labels and all(item['label'] for item in labels), labels
        if language == 'en':
            assert page.locator('[data-i18n], [data-label]').evaluate_all(
                '(els) => els.every(e => !/[\\u3040-\\u30ff\\u4e00-\\u9fff]/.test('
                '(e.dataset.i18n ? e.textContent : "") + (e.getAttribute("aria-label") || "")))')
        for theme in ('light', 'dark'):
            if page.locator('html').get_attribute('data-theme') != theme:
                page.click('#theme')
            for tab in tab_ids:
                page.click('#' + tab)
                active_panel = page.locator('#' + tab).get_attribute('aria-controls')
                assert page.locator('#' + active_panel).is_visible()
                for other in tab_ids:
                    if other != tab:
                        panel_id = page.locator('#' + other).get_attribute('aria-controls')
                        assert not page.locator('#' + panel_id).is_visible()
                data = measure(page, (name, width, language, theme, tab))
                if tab == 'tab-read':
                    data['readInstructions'] = read_instructions(page, language)
                results.append({'browser':name, 'width':width, 'language':language,
                                'theme':theme, 'tab':tab, **data})
            page.click('#help')
            assert page.locator('#help-dialog').is_visible()
            assert page.locator('#help-title').evaluate('(e) => document.activeElement === e')
            measure(page, (name, width, language, theme, 'help'))
            for _ in range(5):
                page.keyboard.press('Tab')
                assert page.locator('#help-dialog').evaluate('(e) => e.contains(document.activeElement)')
            page.keyboard.press('Escape')
            assert not page.locator('#help-dialog').is_visible()
            assert page.locator('#help').evaluate('(e) => document.activeElement === e')
    page.click('#' + tab_ids[0])
    page.locator('#' + tab_ids[0]).focus()
    page.keyboard.press('ArrowRight')
    assert page.locator('#' + tab_ids[1]).get_attribute('aria-selected') == 'true'
    page.keyboard.press('Home')
    assert page.locator('#' + tab_ids[0]).get_attribute('aria-selected') == 'true'
    page.keyboard.press('End')
    assert page.locator('#' + tab_ids[-1]).get_attribute('aria-selected') == 'true'
    assert not errors, (name, errors)
    if name == 'chromium':
        if page.locator('html').get_attribute('lang') != 'ja':
            page.click('#language')
        if page.locator('html').get_attribute('data-theme') != 'light':
            page.click('#theme')
        page.click('#' + tab_ids[0])
        page.screenshot(path=str(OUT / f'stage{stage}-{width}.png'))
    context.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--stage', default='1a')
    parser.add_argument('--url', help='Optional local HTTP or published HTTPS entry URL')
    args = parser.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    results = []
    with sync_playwright() as p:
        for name in ('chromium', 'firefox', 'webkit'):
            browser = getattr(p, name).launch()
            for width in (320, 390, 1280):
                interface(browser, name, width, results, args.stage, args.url)
                print(name, width, 'OK', flush=True)
            browser.close()
    (OUT / f'{args.stage}-results.json').write_text(json.dumps(results, indent=2), encoding='utf-8')
    print(json.dumps({'stage':args.stage, 'states':len(results), 'overflow':0, 'consoleErrors':0}))


if __name__ == '__main__':
    main()
