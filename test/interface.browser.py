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


def help_intro(page, language):
    """Keep the original sentence and prevent a line break inside the short protected word."""
    expected = {
        'ja': 'Overlay QR Sharesは、QRコードを視覚暗号で複数のシートに分け、重ねて読むためのツールです。',
        'en': 'Overlay QR Shares divides a QR code into visual cryptography sheets for recovery by overlay.'
    }
    term = page.locator('#help-content .help-intro-term')
    assert term.count() == 1 and term.is_visible(), (language, 'protected help term is visible')
    paragraph = term.locator('..')
    assert paragraph.text_content() == expected[language], (language, 'complete help sentence preserved')
    assert term.inner_text() == ('ツール' if language == 'ja' else 'overlay'), (language, 'only the short term is protected')
    layout = term.evaluate("""el => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const fragments = [...range.getClientRects()].filter(r => r.width > 0 && r.height > 0)
        .map(r => ({x:r.x, y:r.y, width:r.width, height:r.height}));
      const content = document.getElementById('help-content');
      return {fragments, overflow:content.scrollWidth-content.clientWidth};
    }""")
    assert len(layout['fragments']) == 1, (language, 'protected word stays on one rendered line', layout)
    assert layout['overflow'] == 0, (language, 'help remains within dialog width', layout)
    return {'sentencePreserved': True, 'wordLines': len(layout['fragments']), 'overflow': layout['overflow']}


def footer_copy(page, language):
    """The privacy note and tool description remain two readable, vertically ordered paragraphs."""
    paragraphs = page.locator('.page-footer .footer-copy > p')
    assert paragraphs.count() == 2, (language, 'footer contains privacy and description paragraphs')
    dictionary = page.evaluate("""language => Object.fromEntries(Object.entries(OQS.messages[language])
      .filter(([, value]) => typeof value === 'string'))""", language)
    keys = ('footerPrivacy', 'footerDescription')
    boxes = []
    for index, key in enumerate(keys):
        paragraph = paragraphs.nth(index)
        assert paragraph.is_visible() and paragraph.text_content() == dictionary[key], (language, key)
        box = paragraph.bounding_box()
        assert box and box['width'] > 0 and box['height'] > 0, (language, key, box)
        boxes.append(box)
    assert boxes[0]['y'] + boxes[0]['height'] <= boxes[1]['y'] + .1, (language, 'footer paragraphs stack without overlap', boxes)
    return {'paragraphs': 2, 'privacyBeforeDescription': True}


def comparison_content(page, language):
    """The disclosure row and related-tool link are available from the visible guide tab."""
    dictionary = page.evaluate("""language => Object.fromEntries(Object.entries(OQS.messages[language])
      .filter(([, value]) => typeof value === 'string'))""", language)
    rows = page.locator('#comparison-rows tr').evaluate_all(
        '(rows) => rows.map(row => [...row.querySelectorAll("th, td")].map(cell => cell.textContent))')
    expected = [dictionary['compareLeak' + suffix] for suffix in ('', 'O', 'S')]
    assert rows.count(expected) == 1, (language, 'one translated information-disclosure row', rows)
    link = page.locator('#panel-guide a.related-tool-link')
    assert link.count() == 1 and link.is_visible(), (language, 'related tool is linked inside guide tab')
    assert link.get_attribute('href') == 'https://ipusiron.github.io/scatter-seeds/'
    assert link.get_attribute('target') == '_blank'
    assert {'noopener', 'noreferrer'} <= set((link.get_attribute('rel') or '').split())
    assert 'Scatter Seeds' in link.inner_text(), (language, 'link names its destination')
    return {'disclosureRows': 1, 'relatedToolHref': link.get_attribute('href'), 'safeNewTab': True}


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


def read_accordions(page, label):
    """Native sections toggle independently and keep their state across UI rendering."""
    setup = page.locator('details#overlay-setup')
    camera = page.locator('details#reader-camera')
    assert setup.count() == camera.count() == 1, (label, 'two native reader sections')
    assert setup.locator(':scope > summary').count() == camera.locator(':scope > summary').count() == 1
    assert setup.locator('.overlay-steps').count() == setup.locator('#setup-diagrams').count() == 1
    for selector in ('#camera-button', '#camera-status', '#manual-view', '#read-result', '#diagnostic'):
        assert camera.locator(selector).count() == 1, (label, selector, 'inside camera section')

    def state(expected, detail):
        actual = page.locator('#overlay-setup, #reader-camera').evaluate_all(
            '(els) => Object.fromEntries(els.map(el => [el.id, el.open]))')
        assert actual == expected, (label, detail, actual)
        assert setup.locator('.overlay-steps').is_visible() == expected['overlay-setup']
        assert setup.locator('#setup-diagrams').is_visible() == expected['overlay-setup']
        assert camera.locator('#camera-button').is_visible() == expected['reader-camera']
        assert setup.locator(':scope > summary').is_visible() and camera.locator(':scope > summary').is_visible()
        measure(page, (label, detail))

    def preserve(expected):
        for control, attribute in (('language', 'lang'), ('theme', 'data-theme')):
            before = page.locator('html').get_attribute(attribute)
            page.click('#' + control)
            assert page.locator('html').get_attribute(attribute) != before
            state(expected, control + ' changed with independent section state')
            page.click('#' + control)
            assert page.locator('html').get_attribute(attribute) == before
            state(expected, control + ' restored with independent section state')

    page.click('#tab-read')
    state({'overlay-setup': True, 'reader-camera': True}, 'both sections initially open')
    setup.locator(':scope > summary').focus()
    page.keyboard.press('Enter')
    expected = {'overlay-setup': False, 'reader-camera': True}
    state(expected, 'Enter closes only setup')
    preserve(expected)
    camera.locator(':scope > summary').focus()
    page.keyboard.press('Space')
    state({'overlay-setup': False, 'reader-camera': False}, 'Space closes camera while setup stays closed')
    setup.locator(':scope > summary').focus()
    page.keyboard.press('Space')
    expected = {'overlay-setup': True, 'reader-camera': False}
    state(expected, 'Space opens only setup')
    preserve(expected)
    camera.locator(':scope > summary').focus()
    page.keyboard.press('Enter')
    state({'overlay-setup': True, 'reader-camera': True}, 'Enter restores both sections for instruction checks')
    return {'initialOpen': True, 'keyboardToggles': 4, 'preservedLanguageThemeChanges': 8, 'independent': True}


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
    accordions = read_accordions(page, (name, width))
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
                data['footerCopy'] = footer_copy(page, language)
                if tab == 'tab-read':
                    data['readInstructions'] = read_instructions(page, language)
                    data['readAccordions'] = accordions
                elif tab == 'tab-guide':
                    data['comparisonContent'] = comparison_content(page, language)
                results.append({'browser':name, 'width':width, 'language':language,
                                'theme':theme, 'tab':tab, **data})
            page.click('#help')
            assert page.locator('#help-dialog').is_visible()
            assert page.locator('#help-title').evaluate('(e) => document.activeElement === e')
            measure(page, (name, width, language, theme, 'help'))
            results[-1]['helpIntro'] = help_intro(page, language)
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
    parser.add_argument('--widths', type=int, nargs='+', default=[320, 390, 1280],
                        help='Viewport widths; defaults preserve the usual 108-state matrix')
    args = parser.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    results = []
    with sync_playwright() as p:
        for name in ('chromium', 'firefox', 'webkit'):
            browser = getattr(p, name).launch()
            for width in args.widths:
                interface(browser, name, width, results, args.stage, args.url)
                print(name, width, 'OK', flush=True)
            browser.close()
    (OUT / f'{args.stage}-results.json').write_text(json.dumps(results, indent=2), encoding='utf-8')
    print(json.dumps({'stage':args.stage, 'states':len(results), 'overflow':0, 'consoleErrors':0}))


if __name__ == '__main__':
    main()
