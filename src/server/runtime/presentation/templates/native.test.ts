import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import { fillNativePptx, inspectNativePptx } from './native';

const archive = () =>
  zipSync(
    Object.fromEntries(
      Object.entries({
        '[Content_Types].xml':
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="png" ContentType="image/png"/></Types>',
        'ppt/presentation.xml':
          '<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>',
        'ppt/_rels/presentation.xml.rels':
          '<Relationships><Relationship Id="rId1" Target="slides/slide1.xml"/></Relationships>',
        'ppt/slides/slide1.xml':
          '<p:sld xmlns:p="p" xmlns:a="a" xmlns:r="r"><p:spTree><p:grpSp><p:sp><p:nvSpPr><p:cNvPr id="7" name="Hero title"/></p:nvSpPr><p:txBody><a:p><a:r><a:rPr b="1"/><a:t>Old</a:t></a:r><a:r><a:rPr i="1"/><a:t> style</a:t></a:r></a:p></p:txBody></p:sp></p:grpSp><p:pic><p:nvPicPr><p:cNvPr id="8" name="Photo"/></p:nvPicPr><p:blipFill><a:blip r:embed="rIdPicture"/></p:blipFill></p:pic><p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="9" name="Chart"/></p:nvGraphicFramePr><a:graphic>KEEP CHART</a:graphic></p:graphicFrame></p:spTree></p:sld>',
        'ppt/slides/_rels/slide1.xml.rels':
          '<Relationships><Relationship Id="rIdPicture" Target="../media/original.png" Type="image"/></Relationships>',
        'ppt/media/original.png': 'original binary',
        'ppt/slideMasters/slideMaster1.xml': '<master>complex master untouched</master>',
        'ppt/charts/chart1.xml': '<chart>data untouched</chart>',
        'ppt/notesSlides/notesSlide1.xml': '<notes>untouched</notes>',
      }).map(([path, text]) => [path, strToU8(text)]),
    ),
  );
describe('native template filling', () => {
  it('finds grouped text and native chart objects and preserves every unedited part', () => {
    const source = archive();
    const inspected = inspectNativePptx(source);
    expect(inspected.pages[0].shapes.map((s) => s.id)).toEqual(['7', '8', '9']);
    expect(inspected.preservedParts.charts).toBe(1);
    const output = fillNativePptx(source, [
      { page: 1, shapeId: '7', runs: ['New & clear', ' style'] },
    ]);
    const before = unzipSync(source);
    const after = unzipSync(output.bytes);
    expect(output.changedParts).toEqual(['ppt/slides/slide1.xml']);
    for (const path of Object.keys(before).filter((p) => p !== 'ppt/slides/slide1.xml'))
      expect(after[path]).toEqual(before[path]);
    expect(strFromU8(after['ppt/slides/slide1.xml'])).toContain('New &amp; clear');
    expect(strFromU8(after['ppt/slides/slide1.xml'])).toContain('<a:rPr i="1"/>');
  });
  it('adds a private picture relationship without replacing shared media', () => {
    const output = fillNativePptx(archive(), [
      { page: 1, shapeId: '8', image: { bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/png' } },
    ]);
    const after = unzipSync(output.bytes);
    expect(strFromU8(after['ppt/media/original.png'])).toBe('original binary');
    expect(strFromU8(after['ppt/slides/_rels/slide1.xml.rels'])).toContain('rIdCordis');
    expect(strFromU8(after['ppt/slides/slide1.xml'])).toContain('KEEP CHART');
  });
  it('rejects missing shape IDs, chart text rewrites and inconsistent rich text', () => {
    for (const patch of [
      { page: 1, shapeId: 'missing', text: 'x' },
      { page: 1, shapeId: '9', text: 'x' },
      { page: 1, shapeId: '7', runs: ['wrong count'] },
    ])
      expect(() => fillNativePptx(archive(), [patch])).toThrow();
  });
});
