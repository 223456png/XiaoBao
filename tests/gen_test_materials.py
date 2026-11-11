# -*- coding: utf-8 -*-
"""生成格式解析回归测试材料（docx / pptx / 图片）"""
import os, zipfile, io
from PIL import Image, ImageDraw, ImageFont

OUT = r"D:\laji\2026-10-29-15-11-23\test-materials"
os.makedirs(OUT, exist_ok=True)


def font(size):
    for p in [r"C:\Windows\Fonts\msyh.ttc", r"C:\Windows\Fonts\simhei.ttf", r"C:\Windows\Fonts\simsun.ttc"]:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                pass
    return ImageFont.load_default()


# ---------- 图片1：docx 内嵌图（0风险 高收益） ----------
def make_embed_png():
    img = Image.new("RGB", (900, 420), "#ffffff")
    d = ImageDraw.Draw(img)
    d.rectangle([8, 8, 892, 412], outline="#c00", width=6)
    d.text((60, 90), "0风险", font=font(120), fill="#c00")
    d.text((60, 240), "高收益 稳赚不赔", font=font(76), fill="#111")
    p = os.path.join(OUT, "embed.png")
    img.save(p)
    return p


# ---------- 图片2：长图 3000px，底部 10px 小字 ----------
def make_long_png():
    W, H = 1400, 3000
    img = Image.new("RGB", (W, H), "#0b3a82")
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, W, 520], fill="#0b3a82")
    d.text((70, 80), "五谷丰登理财", font=font(96), fill="#ffffff")
    d.text((70, 230), "保本保息 年化6%", font=font(130), fill="#ffe066")
    d.text((70, 400), "名额有限 先到先得", font=font(70), fill="#ffd43b")
    # 中部填充大幅色块与文字
    for i, y in enumerate(range(620, 2700, 260)):
        d.rectangle([70, y, W - 70, y + 200], fill="#12509f")
        d.text((110, y + 40), "第%d重好礼 收益天天净赚" % (i + 1), font=font(64), fill="#ffffff")
    # 底部 100px 处的 10px 免责声明
    d.rectangle([0, H - 140, W, H], fill="#061f47")
    d.text((60, H - 100), "理财非存款，产品有风险，投资须谨慎，过往业绩不代表未来表现。", font=font(10), fill="#9fb3d1")
    p = os.path.join(OUT, "long.png")
    img.save(p)
    return p


# ---------- docx ----------
CT_DOCX = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="png" ContentType="image/png"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>'''

RELS_DOCX = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>'''

DOC_RELS = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>
</Relationships>'''

DOC_XML = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
 xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
 xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
<w:body>
<w:p><w:r><w:t>鑫享稳健理财，本产品保本保息，年化6%，欢迎认购。</w:t></w:r></w:p>
<w:p><w:r><w:t>产品亮点见下图：</w:t></w:r></w:p>
<w:p><w:r><w:drawing><wp:inline><wp:extent cx="3000000" cy="1400000"/>
<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
<a:blip r:embed="rId1"/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>预期年化</w:t></w:r></w:p></w:tc>
<w:tc><w:p><w:r><w:t>6.00%</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
</w:body></w:document>'''


def make_docx(png_path):
    p = os.path.join(OUT, "t1-含图docx.docx")
    with zipfile.ZipFile(p, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", CT_DOCX)
        z.writestr("_rels/.rels", RELS_DOCX)
        z.writestr("word/document.xml", DOC_XML)
        z.writestr("word/_rels/document.xml.rels", DOC_RELS)
        z.write(png_path, "word/media/image1.png")
    return p


# ---------- pptx ----------
CT_PPTX = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
<Override PartName="/ppt/slides/slide2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
</Types>'''

RELS_PPTX = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>'''

PRES_XML = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:sldIdLst><p:sldId id="256" r:id="rId2" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/></p:sldIdLst>
</p:presentation>'''

NS = ('xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" '
      'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
      'xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"')

SLIDE1 = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld __NS__><p:cSld><p:spTree>
<p:sp><p:txBody><a:p><a:r><a:t>鑫享理财限时抢购，名额有限，先到先得</a:t></a:r></a:p></p:txBody></p:sp>
<p:grpSp>
  <p:sp><p:txBody><a:p><a:r><a:t>年化收益6.5%</a:t></a:r></a:p></p:txBody></p:sp>
  <p:grpSp><p:sp><p:txBody><a:p><a:r><a:t>稳赚不赔 本金安全</a:t></a:r></a:p></p:txBody></p:sp></p:grpSp>
</p:grpSp>
<p:graphicFrame><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">
<a:tbl><a:tr><a:tc><a:txBody><a:p><a:r><a:t>无需用途证明</a:t></a:r></a:p></a:txBody></a:tc>
<a:tc><a:txBody><a:p><a:r><a:t>最高可贷150万</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl>
</a:graphicData></a:graphic></p:graphicFrame>
</p:spTree></p:cSld></p:sld>'''.replace('__NS__', NS)

SLIDE2 = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld __NS__><p:cSld><p:spTree>
<p:sp><p:txBody><a:p><a:r><a:t>收益走势见右侧图表</a:t></a:r></a:p></p:txBody></p:sp>
<p:graphicFrame><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">
<c:chart r:id="rId5"/></a:graphicData></a:graphic></p:graphicFrame>
</p:spTree></p:cSld></p:sld>'''.replace('__NS__', NS)

MASTER = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster __NS__><p:cSld><p:spTree>
<p:sp><p:txBody><a:p><a:r><a:t>国家级产品 全行唯一</a:t></a:r></a:p></p:txBody></p:sp>
</p:spTree></p:cSld></p:sldMaster>'''.replace('__NS__', NS)


def make_pptx():
    p = os.path.join(OUT, "t4-含文本框pptx.pptx")
    with zipfile.ZipFile(p, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", CT_PPTX)
        z.writestr("_rels/.rels", RELS_PPTX)
        z.writestr("ppt/presentation.xml", PRES_XML)
        z.writestr("ppt/slides/slide1.xml", SLIDE1)
        z.writestr("ppt/slides/slide2.xml", SLIDE2)
        z.writestr("ppt/slideMasters/slideMaster1.xml", MASTER)
    return p


# ---------- 超 20 条文本 ----------
def make_big_txt():
    lines = []
    extreme = ["最好", "最优", "最佳", "最强", "第一", "唯一", "独家", "国家级", "顶级",
               "史无前例", "绝无仅有", "行业头部", "领跑", "遥遥领先", "销量第一", "全球领先", "No.1"]
    induce = ["低至3.2%", "秒到账", "秒批", "限量", "名额有限", "先到先得", "速抢", "仅剩",
              "倒计时", "最后3天", "手慢无", "告急", "零成本", "无门槛", "无需用途证明", "无视征信"]
    guarantee = ["保本", "保息", "无风险", "零风险", "稳赚", "必赚", "刚性兑付", "兜底", "100%安全"]
    other = ["仅限男性客户专享", "女士专享礼遇", "最终解释权归我行所有", "提前还款违约金不予退还"]
    for i, w in enumerate(extreme):
        lines.append("本行%s系列第%d期，欢迎认购，收益领先同业。" % (w, i + 1))
    for i, w in enumerate(induce):
        lines.append("活动提示%d：%s，今日办理享好礼。" % (i + 1, w))
    for i, w in enumerate(guarantee):
        lines.append("产品说明%d：%s，客户可放心购买。" % (i + 1, w))
    for i, w in enumerate(other):
        lines.append("条款%d：%s。" % (i + 1, w))
    lines.append("历史年化收益稳定在6.5%左右，持有30日正收益概率100%。")
    with io.open(os.path.join(OUT, "t6-超20条.txt"), "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    return os.path.join(OUT, "t6-超20条.txt")


if __name__ == "__main__":
    png = make_embed_png()
    print("png:", png)
    print("long:", make_long_png())
    print("docx:", make_docx(png))
    print("pptx:", make_pptx())
    print("txt:", make_big_txt())
