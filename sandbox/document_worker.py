#!/usr/bin/env python3
import html
import json
import os
import pathlib
import re
import subprocess
import sys
from html.parser import HTMLParser


class TextExtractor(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts = []

    def handle_data(self, data):
        if data.strip():
            self.parts.append(data.strip())


def read_request():
    if len(sys.argv) != 2:
        raise ValueError("usage: document_worker.py <request.json>")
    return json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))


def ensure_parent(target):
    pathlib.Path(target).parent.mkdir(parents=True, exist_ok=True)


def create_docx(target, title, content):
    from docx import Document
    from docx.shared import Pt

    document = Document()
    styles = document.styles
    styles["Normal"].font.name = "Noto Sans CJK SC"
    styles["Normal"].font.size = Pt(11)
    if title:
        document.add_heading(title, level=0)
    for raw_line in str(content).splitlines():
        line = raw_line.rstrip()
        if not line:
            document.add_paragraph("")
        elif line.startswith("### "):
            document.add_heading(line[4:], level=3)
        elif line.startswith("## "):
            document.add_heading(line[3:], level=2)
        elif line.startswith("# "):
            document.add_heading(line[2:], level=1)
        elif re.match(r"^[-*]\s+", line):
            document.add_paragraph(re.sub(r"^[-*]\s+", "", line), style="List Bullet")
        elif re.match(r"^\d+[.]\s+", line):
            document.add_paragraph(re.sub(r"^\d+[.]\s+", "", line), style="List Number")
        else:
            document.add_paragraph(line)
    ensure_parent(target)
    document.save(target)


def convert_docx_to_pdf(docx_path, pdf_path):
    output_dir = str(pathlib.Path(pdf_path).parent)
    pathlib.Path(output_dir).mkdir(parents=True, exist_ok=True)
    result = subprocess.run(
        ["libreoffice", "--headless", "--convert-to", "pdf", "--outdir", output_dir, docx_path],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=90,
        check=False,
    )
    generated = pathlib.Path(output_dir) / (pathlib.Path(docx_path).stem + ".pdf")
    if result.returncode != 0 or not generated.exists():
        raise RuntimeError((result.stderr or result.stdout or "LibreOffice PDF conversion failed").strip())
    if generated.resolve() != pathlib.Path(pdf_path).resolve():
        generated.replace(pdf_path)


def create_document(request):
    target = request["path"]
    format_name = request.get("format") or pathlib.Path(target).suffix.lstrip(".").lower()
    title = str(request.get("title") or "")
    content = str(request.get("content") or "")
    ensure_parent(target)
    if format_name in {"txt", "md", "markdown"}:
        pathlib.Path(target).write_text(content, encoding="utf-8")
    elif format_name in {"html", "htm"}:
        body = "\n".join(f"<p>{html.escape(line)}</p>" for line in content.splitlines())
        page_title = html.escape(title or pathlib.Path(target).stem)
        pathlib.Path(target).write_text(
            f"<!doctype html><html lang=\"zh-CN\"><meta charset=\"utf-8\"><title>{page_title}</title>"
            f"<body><h1>{page_title}</h1>{body}</body></html>",
            encoding="utf-8",
        )
    elif format_name == "docx":
        create_docx(target, title, content)
    elif format_name == "pdf":
        intermediate = str(pathlib.Path(target).with_suffix(".docx"))
        create_docx(intermediate, title, content)
        convert_docx_to_pdf(intermediate, target)
        pathlib.Path(intermediate).unlink(missing_ok=True)
    else:
        raise ValueError(f"unsupported document format: {format_name}")
    return {"files": [target], "format": format_name}


def read_document(request):
    source = request["path"]
    suffix = pathlib.Path(source).suffix.lower()
    max_characters = min(100000, max(1000, int(request.get("max_characters") or 24000)))
    if suffix in {".txt", ".md", ".json", ".csv"}:
        content = pathlib.Path(source).read_text(encoding="utf-8", errors="replace")
    elif suffix in {".html", ".htm"}:
        parser = TextExtractor()
        parser.feed(pathlib.Path(source).read_text(encoding="utf-8", errors="replace"))
        content = "\n".join(parser.parts)
    elif suffix == ".docx":
        from docx import Document

        document = Document(source)
        parts = [paragraph.text for paragraph in document.paragraphs if paragraph.text]
        for table in document.tables:
            parts.extend("\t".join(cell.text for cell in row.cells) for row in table.rows)
        content = "\n".join(parts)
    elif suffix == ".pdf":
        from pypdf import PdfReader

        content = "\n".join((page.extract_text() or "") for page in PdfReader(source).pages)
    else:
        raise ValueError(f"unsupported document format: {suffix}")
    return {"content": content[:max_characters], "characters": len(content), "truncated": len(content) > max_characters}


def render_document(request):
    source = request["path"]
    output_dir = pathlib.Path(request.get("output_dir") or pathlib.Path(source).parent)
    output_dir.mkdir(parents=True, exist_ok=True)
    suffix = pathlib.Path(source).suffix.lower()
    files = []
    if suffix == ".docx":
        pdf_path = str(output_dir / (pathlib.Path(source).stem + ".pdf"))
        convert_docx_to_pdf(source, pdf_path)
        files.append(pdf_path)
        source = pdf_path
        suffix = ".pdf"
    if suffix == ".pdf":
        prefix = str(output_dir / (pathlib.Path(source).stem + "-page"))
        result = subprocess.run(
            ["pdftoppm", "-png", "-r", "120", source, prefix],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=90,
            check=False,
        )
        if result.returncode != 0:
            raise RuntimeError((result.stderr or "PDF render failed").strip())
        files.extend(str(item) for item in sorted(output_dir.glob(pathlib.Path(prefix).name + "-*.png")))
    if not files:
        raise ValueError("render supports docx or pdf")
    return {"files": files}


def main():
    request = read_request()
    action = request.get("action")
    if action == "create":
        result = create_document(request)
    elif action == "read":
        result = read_document(request)
    elif action == "render":
        result = render_document(request)
    else:
        raise ValueError(f"unsupported action: {action}")
    print(json.dumps({"ok": True, **result}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False))
        sys.exit(1)
