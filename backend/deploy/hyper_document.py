"""Offline, deterministic printable Markdown/text delivery with embedded CJK fonts."""
import re
from html import escape
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_LEFT
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer
from reportlab.lib.pagesizes import A4

def markdown_pdf(text, output):
    pdfmetrics.registerFont(TTFont('HyperCN', '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc'))
    styles = getSampleStyleSheet()
    base = ParagraphStyle('HyperBody', fontName='HyperCN', fontSize=10, leading=17,
                          wordWrap='CJK', spaceAfter=6, alignment=TA_LEFT)
    heading = ParagraphStyle('HyperHeading', parent=base, fontSize=15, leading=22, spaceBefore=10)
    story = []
    # WQY lacks U+2212. Preserve arithmetic with universally available ASCII glyphs.
    text = text.replace('\u2212', '-').replace('\u2013', '-').replace('\u2014', '-')
    for line in text.splitlines():
        if not line.strip():
            story.append(Spacer(1, 5))
            continue
        is_heading = bool(re.match(r'^#{1,6}\s', line))
        line = re.sub(r'^#{1,6}\s+', '', line)
        line = line.replace('**', '').replace('`', '').replace('$', '')
        story.append(Paragraph(escape(line), heading if is_heading else base))
    SimpleDocTemplate(output, pagesize=A4, rightMargin=45, leftMargin=45,
                      topMargin=45, bottomMargin=45).build(story)
